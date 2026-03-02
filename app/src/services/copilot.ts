import type { ChatMessage, CopilotStreamChunk, CopilotModel, CopilotModelInfo, ToolActivity } from '../types';
import { FALLBACK_MODELS, DEFAULT_MODEL } from '../types';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolExecutor } from '../utils/workspaceTools';
import { appendArchiveEntry } from './copilotLog';

const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';

/**
 * Error subclass thrown when the Copilot API returns a non-2xx response.
 * The `detail` field contains a full diagnostic dump of the request
 * (model, per-message summary, tool names, raw error body) suitable for
 * copying and pasting into a bug report or the Copilot chat itself.
 */
export class CopilotDiagnosticError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'CopilotDiagnosticError';
    this.detail = detail;
  }
}

/** Full text of the most recent request sent to the Copilot API (updated before every call). */
let _lastRequestDump = '(no request made yet)';

/** Returns the full dump of the most recent Copilot API request, regardless of success/failure. */
export function getLastRequestDump(): string { return _lastRequestDump; }

/** Build a human-readable dump of a request payload for diagnostics / copy-to-clipboard. */
function buildRequestDump(
  messages: ChatMessage[],
  model: CopilotModel,
  tools: ToolDefinition[] | undefined,
  status?: number,
  errorBody?: string,
): string {
  const msgLines = messages.map((m, i) => {
    const tcIds = (m as any).tool_calls?.map((tc: any) => tc.id) ?? [];
    const tcId  = (m as any).tool_call_id ?? null;
    const header = `[${i}] ${m.role}${
      tcId  ? ` (tool_call_id: ${tcId})`          : ''}${
      tcIds.length ? ` (tool_calls: ${tcIds.join(', ')})` : ''}`;
    // Full content — strip base64 blobs so the dump stays readable
    let body: string;
    if (typeof m.content === 'string') {
      body = m.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 image stripped]');
    } else if (Array.isArray(m.content)) {
      body = (m.content as any[]).map((p: any) =>
        p.type === 'image_url'
          ? '[image]'
          : (typeof p.text === 'string' ? p.text : JSON.stringify(p))
      ).join(' ');
    } else {
      body = String(m.content ?? '');
    }
    // tool_calls detail
    const tcDetail = (m as any).tool_calls?.map((tc: any) =>
      `\n    tool_call id=${tc.id} fn=${tc.function?.name} args=${tc.function?.arguments?.slice(0, 300)}`
    ).join('') ?? '';
    return `  ${header}\n    ${body.replace(/\n/g, '\n    ')}${tcDetail}`;
  });
  const toolNames = tools ? tools.map((t) => t.function?.name ?? (t as any).name).join(', ') : 'none';
  const lines = [
    `Timestamp : ${new Date().toISOString()}`,
    `Model     : ${model}`,
    `Tools     : ${toolNames}`,
    `Messages  : ${messages.length}`,
    ...msgLines,
  ];
  if (status !== undefined) lines.push(`Status    : ${status}`);
  if (errorBody)            lines.push(`Error body: ${errorBody}`);
  return lines.join('\n');
}

// TODO: Register a dedicated Cafezin GitHub OAuth App at
// https://github.com/settings/developers (Device flow, scope: copilot)
// and replace GITHUB_CLIENT_ID below with its client_id.
// Until then the device flow re-uses VS Code's public client ID.
const EDITOR_HEADERS = {
  'User-Agent': 'Cafezin/1.0',
  'Editor-Version': 'vscode/1.95.3',       // must be a recognized IDE name for copilot_internal auth
  'Editor-Plugin-Version': 'cafezin/1.0',  // identifies this app specifically
};

// ── Rate limit / quota tracking ────────────────────────────
interface RateLimitInfo {
  remaining: number | null;
  limit: number | null;
  /** True when the last error was a quota/budget exhaustion */ 
  quotaExceeded: boolean;
}
let _lastRateLimit: RateLimitInfo = { remaining: null, limit: null, quotaExceeded: false };

export function getLastRateLimit(): RateLimitInfo { return { ..._lastRateLimit }; }

/** Returns true when an error message indicates the user has run out of paid tokens. */
export function isQuotaError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('over their token budget') ||
    lower.includes('tokens_quota_exceeded') ||
    (
      (lower.includes('429') || lower.includes('402')) &&
      (lower.includes('quota') || lower.includes('budget') || lower.includes('billing') || lower.includes('premium'))
    )
  );
}

// ── Context budget ────────────────────────────────────────────────────────────
// Trigger summarization when the estimated token count exceeds this threshold.
// Most Copilot models have a 128k context; we leave ~38k headroom for the system
// prompt, tool definitions, and the model's reply.
const CONTEXT_TOKEN_LIMIT = 90_000;

/**
 * Rough token estimate: 1 token ≈ 4 characters of JSON-serialized content.
 * Base64 images are counted at their actual size (they DO consume context tokens).
 * Vision images (PNG/JPEG) cost roughly 1 token per 4 chars of base64.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      // Count base64 images at full length (they are real tokens, not free)
      return sum + raw.length / 4;
    }, 0),
  );
}

/** Return a copy of the messages array with base64 image blobs removed (for safe log storage). */
function stripBase64ForLog(messages: ChatMessage[]): object[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { ...m, content: m.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 image stripped]') };
    }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: (m.content as any[]).map((p: any) =>
          p.type === 'image_url' ? { type: 'image_url', image_url: { url: '[stripped]' } } : p,
        ),
      };
    }
    return m;
  });
}

/**
 * Ask the model to produce a dense summary of the conversation, then rebuild
 * the context window to a compact form:
 *   1. System messages (kept verbatim)
 *   2. First user message — the original task (preserved so the agent never forgets why it's here)
 *   3. A synthetic user message with the [SESSION SUMMARY] noting N rounds were archived
 *   4. The last 8 messages verbatim (recent exchanges for recency context)
 *
 * The full conversation snapshot (minus base64) is persisted to the workspace log
 * so the user (or the agent itself, via read_file) can inspect what was pruned.
 */
async function summarizeAndCompress(
  loop: ChatMessage[],
  headers: Record<string, string>,
  model: CopilotModel,
  workspacePath: string | undefined,
  sessionId: string,
  round: number,
): Promise<ChatMessage[]> {
  const strippedForLog = stripBase64ForLog(loop);

  // ── Ask the model to summarize ───────────────────────────────────────────
  let summaryText = '[Summary unavailable — model did not respond]';
  try {
    const summaryRes = await fetch(COPILOT_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a technical session summarizer. The agent context window is full and needs to be compressed. ' +
              'Summarize the conversation below into a dense technical briefing covering:\n' +
              '1. The user\'s original goal\n' +
              '2. Everything accomplished so far — each tool call, file created/modified, canvas change made\n' +
              '3. Current state of the workspace / canvas\n' +
              '4. What still needs to be done to complete the user\'s goal\n' +
              '5. Any important findings, constraints, or decisions\n\n' +
              'Be precise and technical. Use bullet points. Aim for 400–700 words.',
          },
          {
            role: 'user',
            content:
              `Conversation to summarize (${strippedForLog.length} messages, after round ${round}):\n\n` +
              JSON.stringify(strippedForLog, null, 2),
          },
        ],
        stream: false,
        ...modelApiParams(model, 0.2, 1800),
      }),
    });
    if (summaryRes.ok) {
      const data = await summaryRes.json() as any;
      summaryText = data?.choices?.[0]?.message?.content ?? summaryText;
    } else {
      const errText = await summaryRes.text();
      console.warn('[summarizeAndCompress] model returned', summaryRes.status, errText.slice(0, 200));
    }
  } catch (e) {
    console.warn('[summarizeAndCompress] fetch failed:', e);
  }

  // ── Write archive to the workspace log ──────────────────────────────────
  if (workspacePath) {
    await appendArchiveEntry(workspacePath, {
      entryType: 'archive',
      sessionId,
      archivedAt: new Date().toISOString(),
      round,
      estimatedTokens: estimateTokens(loop),
      summary: summaryText,
      messages: strippedForLog,
    });
  }

  // ── Rebuild compact context ─────────────────────────────────────────────
  // Rules that must hold for the API not to 400:
  //   1. No consecutive user messages
  //   2. tool messages must be preceded by the assistant turn that emitted their tool_call_id
  //   3. The sequence must end before a new user message (vision injection handles that)
  //
  // Structure we build:
  //   [system msgs]
  //   [one user msg: original task + session summary]    ← no consecutive issue
  //   [one assistant bridge: "Resuming…"]               ← satisfies user→assistant ordering
  //   [recent tail: last 8 msgs, vision stripped,
  //    trimmed so it starts from the last USER turn]   ← bridgeMsg is assistant, tail must start with user
  const systemMsgs = loop.filter((m) => m.role === 'system');
  const firstUserMsg = loop.find(
    (m) => m.role === 'user' && !Array.isArray(m.content),
  );
  const originalTask = firstUserMsg
    ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content : JSON.stringify(firstUserMsg.content))
    : '(original task not recoverable)';

  // Last 8 messages, vision stripped
  const rawTail = loop
    .slice(Math.max(0, loop.length - 8))
    .filter(
      (m) =>
        !(Array.isArray(m.content) &&
          (m.content as any[]).some((p: any) => p.type === 'image_url')),
    );

  // The rebuilt context ends with bridgeMsg (role: 'assistant').
  // The tail MUST therefore start with a USER message so we don't get
  // consecutive assistant messages → 400 Bad Request.
  // Find the last user message in rawTail and start from there.
  // If rawTail has no user message (pure agentic stretch), use an empty
  // tail — the model will resume cleanly from just the bridge.
  let lastUserInTail = -1;
  for (let i = rawTail.length - 1; i >= 0; i--) {
    if (rawTail[i].role === 'user') { lastUserInTail = i; break; }
  }
  // Additionally, ensure there are no orphan tool messages before the first
  // assistant in the chosen tail slice (they'd reference unknown tool_call_ids).
  let tail = lastUserInTail >= 0 ? rawTail.slice(lastUserInTail) : [];

  const summaryMsg: ChatMessage = {
    role: 'user',
    content:
      `[SESSION SUMMARY — ${round} rounds archived to workspace log (cafezin/copilot-log.jsonl)]\n\n` +
      `Original task: ${originalTask}\n\n` +
      `Progress summary:\n${summaryText}\n\n` +
      `---\nThe full turn-by-turn transcript is in the workspace log (read_file on ` +
      `cafezin/copilot-log.jsonl). Continuing from here:`,
  };

  const bridgeMsg: ChatMessage = {
    role: 'assistant',
    content: `Understood — resuming from the session summary above. I'll continue towards the original goal.`,
  };

  return sanitizeLoop([
    ...systemMsgs,
    summaryMsg,
    bridgeMsg,
    ...tail,
  ]);
}

/**
 * Sanitize a message array before sending to the Copilot API.
 * Removes structural problems that cause 400 Bad Request:
 *   - Consecutive assistant messages  (keep last; merges content)
 *   - Consecutive user messages       (keep last — avoids duplicate injection)
 *   - Orphan tool messages            (no matching tool_call_id in any preceding
 *                                      assistant turn — they'd cause a 400)
 *   - Dangling tool_calls             (assistant with tool_calls whose responses
 *                                      were sliced off — the API expects all
 *                                      tool_call_ids to be resolved before the
 *                                      next turn; unresolved ones → 400)
 *   - Empty-role or undefined messages
 */
export function sanitizeLoop(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length === 0) return msgs;

  // ── Pre-pass: strip UI-only fields that the Copilot API doesn't accept ──
  // `items` (MessageItem[]) is local display metadata stored in React state.
  // `activeFile`, `attachedImage`, and `attachedFile` are also UI-only fields.
  // None of these must be sent to the API — some backends return 400 Bad Request
  // when they encounter unknown fields in message objects.
  // `attachedImage` in particular can be a large base64 data URL; stripping it
  // prevents megabytes of data being re-sent on every subsequent API call.
  const stripped: ChatMessage[] = msgs.map((m) => {
    if (!m) return m;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { items: _items, activeFile: _af, attachedImage: _ai, attachedFile: _afile, ...clean } = m as any;
    return clean as ChatMessage;
  });
  // Pass 1: resolve orphan tool messages by tracking active tool_call_ids
  const activeTcIds = new Set<string>();
  const pass1: ChatMessage[] = [];
  for (const m of stripped) {
    if (!m || !m.role) continue;
    if (m.role === 'assistant') {
      activeTcIds.clear();
      if (m.tool_calls) m.tool_calls.forEach((tc) => activeTcIds.add(tc.id));
      pass1.push(m);
    } else if (m.role === 'tool') {
      // Drop if the tool_call_id isn't registered from a preceding assistant
      if (m.tool_call_id && activeTcIds.has(m.tool_call_id)) {
        pass1.push(m);
      }
      // else: silently drop the orphan
    } else {
      // user / system — reset active tc tracking
      if (m.role === 'user' || m.role === 'system') activeTcIds.clear();
      pass1.push(m);
    }
  }

  // Pass 2: collapse consecutive same-role messages
  // (assistant→assistant and user→user are both invalid in the Copilot API)
  const out: ChatMessage[] = [];
  for (const m of pass1) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && prev.role === m.role && m.role === 'assistant') {
      // Merge: keep the later assistant's tool_calls; concatenate text content
      const mergedContent = [prev.content, m.content].filter(Boolean).join('\n').trim();
      out[out.length - 1] = {
        ...m,
        content: mergedContent || '',
        tool_calls: m.tool_calls ?? prev.tool_calls,
      };
      continue;
    }
    if (prev && prev.role === m.role && m.role === 'user') {
      // For consecutive user messages merge into one (avoids double-send artifacts)
      const prevContent = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
      const curContent  = typeof m.content  === 'string' ? m.content  : JSON.stringify(m.content);
      out[out.length - 1] = { ...m, content: `${prevContent}\n\n${curContent}` };
      continue;
    }
    out.push(m);
  }

  // Pass 3: drop trailing assistant messages with unresolved tool_calls.
  // This happens when context compression slices off some (or all) of the
  // tool-response messages but leaves the assistant that issued those calls.
  // The Copilot API (and every provider it proxies) returns 400 when an
  // assistant turn has tool_calls that were never answered.
  //
  // Scan from the end of `out`.  For every assistant-with-tool-calls, verify
  // that ALL of its call IDs have a corresponding tool message immediately
  // following it (before the next user/system/assistant).  If any are missing,
  // splice from that assistant to the end and repeat (the removal may expose
  // another incomplete exchange earlier in the array).
  {
    let i = out.length - 1;
    while (i >= 0) {
      const m = out[i];
      if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) {
        i--;
        continue;
      }
      // Collect tool_call_ids resolved by immediately following tool messages
      const resolvedIds = new Set<string>();
      let j = i + 1;
      while (j < out.length && out[j].role === 'tool') {
        if (out[j].tool_call_id) resolvedIds.add(out[j].tool_call_id!);
        j++;
      }
      if (!m.tool_calls.every((tc) => resolvedIds.has(tc.id))) {
        // Incomplete exchange — remove from this assistant to the end
        out.splice(i);
      }
      i--;
    }
  }

  return out;
}

// ── OAuth / Device Flow ──────────────────────────────────────────────────────────
// The Copilot session-token endpoint only accepts OAuth App tokens, not PATs.
// Credentials (client_id + client_secret) live exclusively in the Rust backend.
// The frontend calls invoke('github_device_flow_init') and invoke('github_device_flow_poll').
const OAUTH_TOKEN_KEY = 'copilot-github-oauth-token';

export interface DeviceFlowState {
  userCode: string;
  verificationUri: string;
  expiresIn: number; // seconds
}

export function getStoredOAuthToken(): string | null {
  return localStorage.getItem(OAUTH_TOKEN_KEY);
}

export function clearOAuthToken(): void {
  localStorage.removeItem(OAUTH_TOKEN_KEY);
  _sessionToken = null;
  _sessionTokenExpiry = 0;
}

/**
 * Start GitHub Device Flow. Calls onState with the user_code and
 * verification_uri to display, then polls until the user authorizes.
 * Resolves when the token is stored; throws on error or timeout.
 */
export async function startDeviceFlow(
  onState: (state: DeviceFlowState) => void
): Promise<void> {
  const d = await invoke<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>('github_device_flow_init', { scope: 'copilot' });

  onState({ userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in });

  const intervalMs = (d.interval + 1) * 1000;
  const deadline = Date.now() + d.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const poll = await invoke<{
      access_token?: string;
      error?: string;
      error_description?: string;
    }>('github_device_flow_poll', { deviceCode: d.device_code });

    if (poll.access_token) {
      localStorage.setItem(OAUTH_TOKEN_KEY, poll.access_token);
      _sessionToken = null;
      _sessionTokenExpiry = 0;
      return;
    }
    if (poll.error === 'slow_down') { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (poll.error === 'authorization_pending') continue;
    throw new Error(poll.error_description ?? poll.error ?? 'Authorization failed');
  }
  throw new Error('Device flow timed out — please try again');
}

// ── Copilot session token ──────────────────────────────────────────────────────────
let _sessionToken: string | null = null;
let _sessionTokenExpiry = 0;
/**
 * In-flight token-refresh promise. When multiple concurrent callers arrive while
 * a refresh is already in progress they all await the same promise instead of
 * issuing duplicate exchange requests (which would hit the rate-limit and also
 * create a race where the last writer clobbers earlier results).
 */
let _tokenRefreshPending: Promise<string> | null = null;

async function getCopilotSessionToken(): Promise<string> {
  const now = Date.now();
  // Fast path: cached token is still valid
  if (_sessionToken && now < _sessionTokenExpiry - 60_000) return _sessionToken;

  // Coalesce concurrent refresh requests into one in-flight request
  if (_tokenRefreshPending) return _tokenRefreshPending;

  _tokenRefreshPending = (async () => {
    try {
      const oauthToken = getStoredOAuthToken();
      if (!oauthToken) throw new Error('NOT_AUTHENTICATED');

      const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
          Authorization: `token ${oauthToken}`,
          'Content-Type': 'application/json',
          ...EDITOR_HEADERS,
        },
      });

      if (!res.ok) {
        const body = await res.text();
        // Token revoked or expired — clear it so the UI shows sign-in again
        if (res.status === 401 || res.status === 403) {
          clearOAuthToken();
          throw new Error('NOT_AUTHENTICATED');
        }
        throw new Error(`Copilot token exchange failed (${res.status}): ${body}`);
      }

      const data = await res.json() as { token: string; expires_at: string };
      _sessionToken = data.token;
      _sessionTokenExpiry = new Date(data.expires_at).getTime();
      return _sessionToken;
    } finally {
      // Always clear the pending slot so the next call can refresh again
      _tokenRefreshPending = null;
    }
  })();

  return _tokenRefreshPending;
}

/**
 * Stream a Copilot chat completion.
 * Calls the GitHub Copilot API with the provided messages and
 * invokes `onChunk` with each streamed text fragment.
 */
export async function streamCopilotChat(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  model: CopilotModel = DEFAULT_MODEL,
  tools?: ToolDefinition[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    const sessionToken = await getCopilotSessionToken();

    // Sanitize messages before sending: strip UI-only fields (items, activeFile,
    // attachedImage, attachedFile) and resolve structural problems (consecutive
    // roles, orphan/dangling tool messages) — identical to what runCopilotAgent does.
    const cleanMessages = sanitizeLoop([...messages]);

    // Capture the full request dump BEFORE sending (available even if request succeeds)
    _lastRequestDump = buildRequestDump(cleanMessages, model, tools);

    // Retry up to 3 times for transient 5xx errors with exponential backoff
    const MAX_RETRIES = 3;
    let response: Awaited<ReturnType<typeof fetch>> | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) return;
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      // Hard payload size guard: if the serialised body exceeds ~6 MB, strip base64
      // images from the context (except they've been moved to user messages already).
      // This prevents 400 / 413 errors when a large screenshot is included.
      const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024; // 6 MB
      let messagesForRequest = cleanMessages;
      const bodyCandidate = JSON.stringify({
        model,
        messages: cleanMessages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
        ...modelApiParams(model, 0.7, 16384),
      });
      if (bodyCandidate.length > MAX_PAYLOAD_BYTES) {
        console.warn(
          `[Copilot] payload ${(bodyCandidate.length / 1024).toFixed(0)} KB exceeds ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB limit — stripping vision messages`,
        );
        // Remove vision user messages (multipart with image_url) starting from oldest
        const stripped = cleanMessages.filter(
          (m) =>
            !(m.role === 'user' &&
              Array.isArray(m.content) &&
              (m.content as any[]).some((p: any) => p.type === 'image_url')),
        );
        messagesForRequest = stripped;
      }
      response = await fetch(COPILOT_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
          ...EDITOR_HEADERS,
        },
        signal,
        body: JSON.stringify({
          model,
          messages: messagesForRequest,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          stream: true,
          ...modelApiParams(model, 0.7, 16384),
        }),
      });
      if (response.ok || response.status < 500) break;
      // 5xx — retry
      const errorText = await response.text();
      const cleanError = errorText.trim().startsWith('<')
        ? `GitHub returned a ${response.status} (server error) — please retry in a moment`
        : `Copilot API error ${response.status}: ${errorText}`;
      lastError = new Error(cleanError);
      response = null;
    }

    if (!response) throw lastError!;

    if (!response.ok) {
      const errorText = await response.text();

      // Update the dump with the error status+body and log to console
      _lastRequestDump = buildRequestDump(cleanMessages, model, tools, response.status, errorText);
      console.error('[Copilot] API error diagnostic:\n' + _lastRequestDump);

      let cleanError: string;
      if (errorText.trim().startsWith('<')) {
        cleanError = `GitHub returned a ${response.status} (server error) — please retry in a moment`;
      } else {
        try {
          const parsed = JSON.parse(errorText);
          const msg = parsed?.error?.message ?? parsed?.message ?? errorText;
          cleanError = `Copilot API error ${response.status}: ${msg}`;
        } catch {
          cleanError = `Copilot API error ${response.status}: ${errorText}`;
        }
      }
      // Track quota exhaustion so the UI can show the billing button
      if (response.status === 429 || response.status === 402 || isQuotaError(cleanError)) {
        _lastRateLimit = { ..._lastRateLimit, quotaExceeded: true, remaining: 0 };
      }
      throw new CopilotDiagnosticError(cleanError, _lastRequestDump);
    }

    // Capture rate limit headers from the first ok response
    {
      const remaining = response.headers.get('x-ratelimit-remaining') ?? response.headers.get('x-copilot-quota-remaining');
      const limit = response.headers.get('x-ratelimit-limit') ?? response.headers.get('x-copilot-quota-limit');
      _lastRateLimit = {
        remaining: remaining !== null ? parseInt(remaining, 10) : _lastRateLimit.remaining,
        limit: limit !== null ? parseInt(limit, 10) : _lastRateLimit.limit,
        quotaExceeded: false,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk: CopilotStreamChunk = JSON.parse(trimmed.slice(6));
          const text = chunk.choices[0]?.delta?.content;
          if (text) onChunk(text);
        } catch {
          // skip malformed lines
        }
      }
    }

    onDone();
  } catch (err) {
    // AbortError = intentional interrupt by the user sending a new message — swallow silently
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Helper: get a one-shot (non-streamed) completion for internal use.
 */
export async function copilotComplete(
  messages: ChatMessage[],
  model: CopilotModel = DEFAULT_MODEL
): Promise<string> {
  return new Promise((resolve, reject) => {
    let result = '';
    streamCopilotChat(
      messages,
      (chunk) => { result += chunk; },
      () => resolve(result),
      reject,
      model
    );
  });
}

// ── Vision capability detection ────────────────────────────────────────────
// OpenAI o-series reasoning models (o1, o3, o3-mini, o4-mini, …) do not
// accept image_url content — the API returns 400.  Everything else (GPT-4o,
// GPT-4.1, all Claude, all Gemini) supports vision.
export function modelSupportsVision(modelId: string): boolean {
  return !/^o\d/.test(modelId);
}

/**
 * Returns the model-specific API body parameters for completions.
 *
 * o-series reasoning models (o3, o4-mini, …) have two hard constraints:
 *   1. `temperature` must equal 1 (the default) or be **omitted** — any other
 *      value causes a 400 "Unsupported value" error.
 *   2. They use `max_completion_tokens` instead of the legacy `max_tokens`.
 *
 * Standard models (GPT-4o, Claude, Gemini, …) accept `temperature` freely
 * and use `max_tokens`.
 */
export function modelApiParams(
  model: CopilotModel,
  temperature: number,
  maxTokens: number,
): { temperature?: number; max_tokens?: number; max_completion_tokens?: number } {
  if (/^o\d/.test(model)) {
    return { max_completion_tokens: maxTokens };
  }
  return { temperature, max_tokens: maxTokens };
}

// ── Model discovery ──────────────────────────────────────────────────────────

interface RawModel {
  id: string;
  name?: string;
  // GitHub Copilot API field for cost relative to a standard request
  billing_multiplier?: number;
  // Some API versions use this instead
  multiplier?: number;
  vendor?: string;
  capabilities?: { family?: string };
}

/**
 * Legacy / superseded model ID prefixes to hide from the picker.
 * Entries are matched as exact IDs or as prefix + '-' (so 'gpt-4' blocks
 * 'gpt-4' exactly but NOT 'gpt-4o', 'gpt-4.1', etc.).
 */
const BLOCKED_PREFIXES = [
  'gpt-3.5',
  'gpt-4-32k',
  'gpt-4-turbo',
  'gpt-4-0',           // gpt-4-0314, gpt-4-0613
  'gpt-4-1106',
  'gpt-4-vision',
  'o1-mini',
  'o1-preview',
  'text-davinci',
  'text-embedding',
  'code-search',
  'claude-3-',         // entire claude 3.x generation (3-haiku, 3-sonnet, 3-5-*, 3-7-*)
];
const BLOCKED_EXACT = new Set(['gpt-4', 'o1-mini']);

export function isBlockedModel(id: string): boolean {
  if (BLOCKED_EXACT.has(id)) return true;
  return BLOCKED_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * Derive a "family key" used for deduplication.
 * Strips trailing minor-version segments so multiple patch/minor releases of
 * the same model family collapse into one entry (keeping the latest).
 *
 * Examples:
 *   claude-sonnet-4-5  → claude-sonnet-4   (strip trailing -5)
 *   claude-sonnet-4-6  → claude-sonnet-4   (strip trailing -6)
 *   claude-opus-4-5    → claude-opus-4
 *   gpt-4o             → gpt-4o            (no trailing digit group)
 *   gpt-4.1-mini       → gpt-4.1-mini      (no trailing digit group after strip)
 *   claude-3-5-sonnet-20241022 → blocked above by claude-3- prefix
 */
export function familyKey(id: string): string {
  // Strip trailing -YYYYMMDD date stamp
  let key = id.replace(/-\d{8}$/, '');
  // Strip trailing single-segment minor version like -5 or -6
  // (but NOT full model suffixes like -mini, -nano, -lite)
  key = key.replace(/-(\d+)$/, '');
  return key;
}

/** Fetches available models from the GitHub Copilot /models endpoint. */
export async function fetchCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const sessionToken = await getCopilotSessionToken();
    const res = await fetch('https://api.githubcopilot.com/models', {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
        ...EDITOR_HEADERS,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: RawModel[] };
    const raw: RawModel[] = json.data ?? [];

    // Filter to chat-compatible, non-legacy models only
    const mapped: CopilotModelInfo[] = raw
      .filter((m) =>
        m.id &&
        !m.id.includes('embedding') &&
        !m.id.includes('whisper') &&
        !isBlockedModel(m.id),
      )
      .map((m) => {
        const mult = m.billing_multiplier ?? m.multiplier ?? 1;
        return {
          id: m.id,
          name: m.name ?? m.id,
          multiplier: mult,
          isPremium: mult > 1,
          vendor: m.vendor,
          supportsVision: modelSupportsVision(m.id),
        };
      });

    // Deduplicate by family: when two IDs share the same familyKey (e.g.
    // claude-sonnet-4-5 and claude-sonnet-4-6 both → "claude-sonnet-4"),
    // keep the one with the highest numeric version. We compare by splitting
    // on non-numeric runs and comparing each numeric segment as a number so
    // "4-10" correctly beats "4-9" (lexicographic comparison gets this wrong).
    function versionScore(id: string): number[] {
      return id.split(/[^\d]+/).filter(Boolean).map(Number);
    }
    function newerVersion(a: string, b: string): boolean {
      const va = versionScore(a);
      const vb = versionScore(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const diff = (va[i] ?? 0) - (vb[i] ?? 0);
        if (diff !== 0) return diff > 0;
      }
      return false;
    }
    const byFamily = new Map<string, CopilotModelInfo>();
    for (const m of mapped) {
      const key = familyKey(m.id);
      const existing = byFamily.get(key);
      if (!existing || newerVersion(m.id, existing.id)) {
        byFamily.set(key, m);
      }
    }

    const models = [...byFamily.values()]
      .sort((a, b) => a.multiplier - b.multiplier || a.name.localeCompare(b.name));

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

// ── Agent (tool-calling) loop ───────────────────────────────────────────────

/**
 * Some models emit tool calls as XML text instead of the native tool_calls field.
 * This parser detects  <tool_call>{"name":…,"arguments":{…}}</tool_call>  blocks.
 * It also handles the common failure case where a large write call is TRUNCATED
 * mid-content (no closing </tool_call> tag) — we extract it from the tail of the text.
 */
function safeParseToolCallJson(raw: string): { name?: string; arguments?: unknown } | null {
  let text = raw.trim();
  if (!text) return null;
  
  // Strip markdown backticks if present
  text = text.replace(/^```(?:json)?\n([\s\S]*?)\n```$/g, '$1').trim();

  // Strategy 1: standard parse
  try { 
    const parsed = JSON.parse(text) as any; 
    const name = parsed.name || parsed.tool || parsed.tool_name || parsed.function || parsed.action;
    if (name) return { name, arguments: parsed.arguments || parsed.parameters || parsed.args || parsed };
  } catch { /* try next */ }

  // Strategy 2: replace literal newlines with \n
  try {
    const sanitised = text
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/([^\\])\n/g, '$1\\n')
      .replace(/^\n/g, '\\n');
    const parsed = JSON.parse(sanitised) as any;
    const name = parsed.name || parsed.tool || parsed.tool_name || parsed.function || parsed.action;
    if (name) return { name, arguments: parsed.arguments || parsed.parameters || parsed.args || parsed };
  } catch { /* try next */ }

  // Strategy 3: XML-like tags
  const nameMatchXml = /<name>([\s\S]*?)<\/name>/.exec(text) || /<tool_name>([\s\S]*?)<\/tool_name>/.exec(text) || /<tool>([\s\S]*?)<\/tool>/.exec(text);
  if (nameMatchXml) {
    const argsMatchXml = /<arguments>([\s\S]*?)<\/arguments>/.exec(text) || /<parameters>([\s\S]*?)<\/parameters>/.exec(text);
    let args = {};
    if (argsMatchXml) {
      try { args = JSON.parse(argsMatchXml[1].trim()); } catch { /* ignore */ }
    }
    return { name: nameMatchXml[1].trim(), arguments: args };
  }

  // Strategy 4: extract only the name + the path from a write_workspace_file call
  const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(text) || /"tool"\s*:\s*"([^"]+)"/.exec(text);
  const pathMatch = /"path"\s*:\s*"([^"]+)"/.exec(text);
  if (nameMatch?.[1] === 'write_workspace_file' && pathMatch) {
    const contentKey = text.indexOf('"content"');
    if (contentKey !== -1) {
      const quoteStart = text.indexOf('"', contentKey + 9);
      if (quoteStart !== -1) {
        const tail = text.lastIndexOf('"}}');
        const content = tail > quoteStart
          ? text.slice(quoteStart + 1, tail)
          : text.slice(quoteStart + 1);
        const unescaped = content.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return {
          name: nameMatch[1],
          arguments: { path: pathMatch[1], content: unescaped },
        };
      }
    }
  }

  // Strategy 5: Just the tool name as plain text
  if (/^[a-zA-Z0-9_]+$/.test(text)) {
    return { name: text, arguments: {} };
  }

  return null;
}

function parseTextToolCalls(text: string): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  const results: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  let idx = 0;

  // ── 1. Match complete <tool_call>…</tool_call> or <invoke>…</invoke> blocks ──
  const re = /<(?:tool_call|invoke)([^>]*)>([\s\S]*?)<\/(?:tool_call|invoke)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const content = m[2].trim();
    
    let nameFromAttr = '';
    const nameMatch = /name="([^"]+)"/.exec(attrs) || /name='([^']+)'/.exec(attrs);
    if (nameMatch) nameFromAttr = nameMatch[1];

    const raw = safeParseToolCallJson(content);
    const finalName = nameFromAttr || raw?.name;
    
    if (!finalName) { console.debug('[parseTextToolCalls] skipping unparseable block:', content.slice(0, 80)); continue; }
    const argsStr = typeof raw?.arguments === 'string' ? raw.arguments : JSON.stringify(raw?.arguments ?? {});
    console.debug('[parseTextToolCalls] found (complete):', finalName, 'args length:', argsStr.length);
    results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name: finalName, arguments: argsStr } });
  }

  // ── 2. Detect a truncated (unclosed) block at the end of the text ──
  const lastOpen = Math.max(text.lastIndexOf('<tool_call'), text.lastIndexOf('<invoke'));
  const lastClose = Math.max(text.lastIndexOf('</tool_call>'), text.lastIndexOf('</invoke>'));
  if (lastOpen !== -1 && lastOpen > lastClose) {
    const fragment = text.slice(lastOpen);
    const closeBracket = fragment.indexOf('>');
    if (closeBracket !== -1) {
      const attrs = fragment.slice(0, closeBracket);
      const content = fragment.slice(closeBracket + 1).trim();
      
      let nameFromAttr = '';
      const nameMatch = /name="([^"]+)"/.exec(attrs) || /name='([^']+)'/.exec(attrs);
      if (nameMatch) nameFromAttr = nameMatch[1];

      const raw = safeParseToolCallJson(content);
      const finalName = nameFromAttr || raw?.name;
      
      if (finalName) {
        const argsStr = typeof raw?.arguments === 'string' ? raw.arguments : JSON.stringify(raw?.arguments ?? {});
        console.debug('[parseTextToolCalls] found (truncated):', finalName, 'args length:', argsStr.length);
        results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name: finalName, arguments: argsStr } });
      }
    }
  }

  // ── 3. Detect markdown JSON blocks that look like tool calls ──
  if (results.length === 0) {
    const jsonRe = /```(?:json)?\n([\s\S]*?)\n```/g;
    let jsonMatch;
    while ((jsonMatch = jsonRe.exec(text)) !== null) {
      const content = jsonMatch[1].trim();
      const raw = safeParseToolCallJson(content);
      if (raw?.name) {
        const argsStr = typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments ?? {});
        console.debug('[parseTextToolCalls] found (markdown json):', raw.name, 'args length:', argsStr.length);
        results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name: raw.name, arguments: argsStr } });
      } else {
        // Maybe it's an array of tool calls
        try {
          const parsedArr = JSON.parse(content);
          if (Array.isArray(parsedArr)) {
            for (const item of parsedArr) {
              const name = item.name || item.tool || item.tool_name || item.function || item.action;
              if (name) {
                const args = item.arguments || item.parameters || item.args || item;
                const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
                console.debug('[parseTextToolCalls] found (markdown json array):', name, 'args length:', argsStr.length);
                results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name, arguments: argsStr } });
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ── 4. Detect raw JSON objects or arrays if nothing else matched ──
  if (results.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const name = item.name || item.tool || item.tool_name || item.function || item.action;
            if (name) {
              const args = item.arguments || item.parameters || item.args || item;
              const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
              console.debug('[parseTextToolCalls] found (raw json array):', name, 'args length:', argsStr.length);
              results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name, arguments: argsStr } });
            }
          }
        } else {
          const name = parsed.name || parsed.tool || parsed.tool_name || parsed.function || parsed.action;
          if (name) {
            const args = parsed.arguments || parsed.parameters || parsed.args || parsed;
            const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
            console.debug('[parseTextToolCalls] found (raw json object):', name, 'args length:', argsStr.length);
            results.push({ id: `text-tc-${idx++}`, type: 'function', function: { name, arguments: argsStr } });
          }
        }
      } catch { /* ignore */ }
    }
  }

  console.debug('[parseTextToolCalls] total found:', results.length);
  return results;
}

/**
 * Agentic Copilot call with tool calling.
 *
 * Flow:
 *   1. POST messages + tools (streaming) in a loop.
 *   2. For each tool_calls response: execute tools, append results, loop.
 *   3. When finish_reason === 'stop': we are done.
 *
 * Tool activity is reported via onToolActivity so the UI can show what's happening.
 */
export async function runCopilotAgent(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  onChunk: (text: string) => void,
  onToolActivity: (activity: ToolActivity) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  model: CopilotModel = DEFAULT_MODEL,
  workspacePath?: string,
  sessionId?: string,
  signal?: AbortSignal,
  onExhausted?: () => void,
): Promise<void> {
  try {
    const sessionToken = await getCopilotSessionToken();
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
      ...EDITOR_HEADERS,
    };

    // Sanitize once: strip UI-only fields and resolve structural issues
    // (consecutive roles, orphan tool messages) before the first round.
    // Messages appended within the loop are synthetic and already clean.
    const loop = sanitizeLoop([...messages]);
    const MAX_ROUNDS = 100;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Early-exit if the caller aborted (user sent a new message mid-run)
      if (signal?.aborted) return;

      // Re-sanitize at the start of every round as a safety net.
      // Mid-loop pruning (lightweight blind splice) and vision injection can
      // create structural issues (orphan tool messages, unresolved tool_calls,
      // consecutive roles) that must be resolved before the next API call.
      {
        const clean = sanitizeLoop(loop);
        loop.splice(0, loop.length, ...clean);
      }

      // Streaming call to detect tool_calls and stream text
      // Retry up to 3 times for transient 5xx errors with exponential backoff
      let res: Awaited<ReturnType<typeof fetch>> | null = null;
      let lastFetchError: Error | null = null;
      // loopForRequest may be stripped of its trailing vision user message on
      // a 400 retry — we never mutate `loop` itself here so the vision message
      // stays in context for the next round's screenshot injection to re-evaluate.
      let loopForRequest = loop as typeof loop;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) return;
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        // Update the diagnostic dump before every attempt so it reflects the live request.
        _lastRequestDump = buildRequestDump(loopForRequest, model, tools);
        const r = await fetch(COPILOT_API_URL, {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            model,
            messages: loopForRequest,
            tools,
            tool_choice: 'auto',
            stream: true,
            ...modelApiParams(model, 0.3, 16000),
          }),
        });
        if (r.ok) { res = r; break; }
        if (r.status === 400) {
          // 400 can mean the vision user message (base64 image) is too large or
          // unsupported by the API for this model. Strip the image and retry once.
          const lastMsg = loopForRequest[loopForRequest.length - 1];
          const hasTrailingVision =
            lastMsg?.role === 'user' &&
            Array.isArray(lastMsg.content) &&
            (lastMsg.content as any[]).some((p: any) => p.type === 'image_url');
          if (hasTrailingVision && attempt === 0) {
            // Replace the vision message with a plain-text fallback so the model
            // knows a screenshot was taken but can't be shown.
            const label = (lastMsg.content as any[]).find((p: any) => p.type === 'text')?.text ?? 'Canvas screenshot taken';
            loopForRequest = [
              ...loopForRequest.slice(0, -1),
              { role: 'user' as const, content: `${label} (image omitted — too large for API)` },
            ];
            console.warn('[agent] 400 with vision message — retrying without image');
            continue; // retry immediately, no backoff
          }
          // Non-vision 400 or second attempt — don't retry, surface the error.
          res = r; break;
        }
        if (r.status < 500) { res = r; break; }
        const errText = await r.text();
        const cleanMsg = errText.trim().startsWith('<')
          ? `GitHub returned a ${r.status} (server error) — please retry in a moment`
          : `Copilot API error ${r.status}: ${errText}`;
        lastFetchError = new Error(cleanMsg);
      }
      if (!res) throw lastFetchError!;

      if (!res.ok) {
        const errText = await res.text();
        // Update the dump with the error response so the user gets actionable diagnostics.
        _lastRequestDump = buildRequestDump(loopForRequest, model, tools, res.status, errText);
        console.error('[agent] API error diagnostic:\n' + _lastRequestDump);
        let cleanMsg: string;
        if (errText.trim().startsWith('<')) {
          cleanMsg = `GitHub returned a ${res.status} (server error) — please retry in a moment`;
        } else {
          try {
            const parsed = JSON.parse(errText);
            const msg = parsed?.error?.message ?? parsed?.message ?? errText;
            cleanMsg = `Copilot API error ${res.status}: ${msg}`;
          } catch {
            cleanMsg = `Copilot API error ${res.status}: ${errText}`;
          }
        }
        throw new Error(cleanMsg);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      
      let fullContent = '';
      const toolCallsMap = new Map<number, any>();
      let finishReason: string | null = null;
      let functionCallFallback: any = null;

      // Stream buffering to hide text-based tool calls from the UI
      let streamBuffer = '';
      let isInsideToolCall = false;
      let toolCallBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const choice = chunk.choices[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;
            if (!delta) continue;

            if (delta.content) {
              fullContent += delta.content;
              
              // Stream buffering logic
              streamBuffer += delta.content;
              while (true) {
                if (!isInsideToolCall) {
                  const invokeIdx = streamBuffer.indexOf('<invoke');
                  const toolCallIdx = streamBuffer.indexOf('<tool_call');
                  const jsonIdx = streamBuffer.indexOf('```json\n');
                  
                  let startIdx = -1;
                  if (invokeIdx !== -1) startIdx = startIdx === -1 ? invokeIdx : Math.min(startIdx, invokeIdx);
                  if (toolCallIdx !== -1) startIdx = startIdx === -1 ? toolCallIdx : Math.min(startIdx, toolCallIdx);
                  if (jsonIdx !== -1) startIdx = startIdx === -1 ? jsonIdx : Math.min(startIdx, jsonIdx);
                  
                  if (startIdx !== -1) {
                    const textBefore = streamBuffer.slice(0, startIdx);
                    if (textBefore) onChunk(textBefore);
                    
                    isInsideToolCall = true;
                    toolCallBuffer = streamBuffer.slice(startIdx);
                    streamBuffer = '';
                  } else {
                    const lastLess = streamBuffer.lastIndexOf('<');
                    const lastTick = streamBuffer.lastIndexOf('`');
                    const holdIdx = Math.max(lastLess, lastTick);
                    
                    if (holdIdx !== -1) {
                      const textToFlush = streamBuffer.slice(0, holdIdx);
                      if (textToFlush) onChunk(textToFlush);
                      streamBuffer = streamBuffer.slice(holdIdx);
                    } else {
                      if (streamBuffer) onChunk(streamBuffer);
                      streamBuffer = '';
                    }
                    break;
                  }
                } else {
                  toolCallBuffer += streamBuffer;
                  streamBuffer = '';
                  
                  const invokeEnd = toolCallBuffer.indexOf('</invoke>');
                  const toolCallEnd = toolCallBuffer.indexOf('</tool_call>');
                  const jsonEnd = toolCallBuffer.indexOf('\n```', 8);
                  
                  let endIdx = -1;
                  if (invokeEnd !== -1) endIdx = invokeEnd + 9;
                  else if (toolCallEnd !== -1) endIdx = toolCallEnd + 12;
                  else if (jsonEnd !== -1) endIdx = jsonEnd + 4;
                  
                  if (endIdx !== -1) {
                    isInsideToolCall = false;
                    streamBuffer = toolCallBuffer.slice(endIdx);
                    toolCallBuffer = '';
                  } else {
                    break;
                  }
                }
              }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCallsMap.has(tc.index)) {
                  toolCallsMap.set(tc.index, {
                    id: tc.id || `call_${Date.now()}_${tc.index}`,
                    type: 'function',
                    function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' }
                  });
                } else {
                  const existing = toolCallsMap.get(tc.index);
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }
            }

            if ((delta as any).function_call) {
              const fc = (delta as any).function_call;
              if (!functionCallFallback) {
                functionCallFallback = { name: fc.name || '', arguments: fc.arguments || '' };
              } else {
                if (fc.name) functionCallFallback.name += fc.name;
                if (fc.arguments) functionCallFallback.arguments += fc.arguments;
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Flush remaining stream buffer
      if (!isInsideToolCall && streamBuffer) {
        onChunk(streamBuffer);
      }

      console.debug('[agent] round', round, 'finish_reason:', finishReason,
        'native tool_calls:', toolCallsMap.size,
        'content length:', fullContent.length);

      // ── Detect text-based tool calls (model may output <tool_call> XML) ─
      const nativeToolCalls = Array.from(toolCallsMap.values());
      if (nativeToolCalls.length === 0 && functionCallFallback) {
        nativeToolCalls.push({
          id: `call_${Date.now()}`,
          type: 'function',
          function: functionCallFallback
        });
      }
      const textToolCalls = nativeToolCalls.length === 0
        ? parseTextToolCalls(fullContent)
        : [];
      const allToolCalls = [...nativeToolCalls, ...textToolCalls];
      console.debug('[agent] allToolCalls:', allToolCalls.map(tc => tc.function.name));

      // ── No tool calls: deliver the final answer ─────────────────────────
      if (allToolCalls.length === 0) {
        // We already streamed the content to the user!
        onDone();
        return;
      }

      // ── Tool calls: execute each one ──────────────────────────────────
      // Strip <tool_call>/<tool_response> noise from assistant text before storing.
      // Use '' (not null) for content when only tool_calls are present — null causes
      // 400 Bad Request on some Copilot backends.
      const cleanAssistantContent = fullContent
        .replace(/<(?:tool_call|invoke)[^>]*>[\s\S]*?<\/(?:tool_call|invoke)>/g, '')
        .replace(/<(?:tool_response|function_results)[^>]*>[\s\S]*?<\/(?:tool_response|function_results)>/g, '')
        .replace(/<\/?function_calls>/g, '')
        .trim();
      loop.push({
        role: 'assistant',
        content: cleanAssistantContent,
        tool_calls: allToolCalls,
      });

      // ── Emit thinking text if the model reasoned before calling tools ─
      // We no longer emit a 'thinking' activity because we stream the text directly to the user.
      // The user will see the reasoning text live in the chat message.
      if (cleanAssistantContent) {
        onChunk('\n\n');
      }

      for (const tc of allToolCalls) {
        const args = (() => {
          try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
          catch { return {} as Record<string, unknown>; }
        })();

        const activity: ToolActivity = { callId: tc.id, name: tc.function.name, args };
        onToolActivity(activity);

        let result: string;
        try {
          result = await executeTool(tc.function.name, args);
          activity.result = result;
        } catch (e) {
          result = `Error: ${e}`;
          activity.error = result;
        }
        onToolActivity({ ...activity, result, error: activity.error });

        // Truncate very large results to avoid oversized requests (e.g. large files,
        // base64 blobs accidentally not caught by sentinel). Cap at 32 KB — large enough
        // for a full 40 KB paged file read without cutting responses short, but still
        // much smaller than the 90 K token context budget.
        const MAX_TOOL_RESULT = 32_000;
        const safeResult = result.length > MAX_TOOL_RESULT
          ? result.slice(0, MAX_TOOL_RESULT) + `\n[...truncated ${result.length - MAX_TOOL_RESULT} chars]`
          : result;
        loop.push({
          role: 'tool',
          tool_call_id: tc.id,
          // Note: 'name' is NOT included — it's invalid in the tool message spec
          // and causes 400 Bad Request on some backends.
          // Empty string content causes 400 on several backends — use a placeholder.
          content: safeResult || '(empty result)',
        });
      }

      // ── Context management ────────────────────────────────────────────
      // Check estimated token count. If we're approaching the model's limit,
      // ask the model to summarize what happened, persist the full transcript to
      // the workspace log, then rebuild a compact context window.
      // If still within budget, perform lightweight deduplication only.
      const estimatedTok = estimateTokens(loop);
      console.debug('[agent] estimated tokens after round', round, ':', estimatedTok);

      if (estimatedTok > CONTEXT_TOKEN_LIMIT) {
        // Notify the user (shown inline in the chat stream)
        onChunk('\n\n_[Context approaching limit — summarizing prior session and continuing...]_\n\n');
        const compressed = await summarizeAndCompress(
          loop,
          headers,
          model,
          workspacePath,
          sessionId ?? 's_unknown',
          round,
        );
        loop.splice(0, loop.length, ...compressed);
        console.debug('[agent] context compressed to', loop.length, 'messages (~', estimateTokens(loop), 'tokens)');
      } else {
        // Lightweight blind pruning: belt-and-suspenders fallback.
        // Keeps the last MAX_KEEP_ROUNDS assistant+tool exchange groups
        // in case token estimation is off or tool results are unusually large.
        const MAX_KEEP_ROUNDS = 14;
        const firstAssistantIdx = loop.findIndex((m) => m.role === 'assistant');
        if (firstAssistantIdx !== -1) {
          const assistantIdxs: number[] = [];
          for (let i = firstAssistantIdx; i < loop.length; i++) {
            if (loop[i].role === 'assistant') assistantIdxs.push(i);
          }
          if (assistantIdxs.length > MAX_KEEP_ROUNDS) {
            const keepFrom = assistantIdxs[assistantIdxs.length - MAX_KEEP_ROUNDS];
            loop.splice(firstAssistantIdx, keepFrom - firstAssistantIdx);
          }
        }
        // Prune stale injected vision user messages: keep only the most recent one.
        // Only look AFTER the first assistant turn — the original task message
        // (which may be multipart with a canvas screenshot) must not be removed.
        const firstAssistantIdxPrune = loop.findIndex((m) => m.role === 'assistant');
        const visionIdxs = loop.reduce<number[]>((acc, m, i) => {
          if (i > firstAssistantIdxPrune &&
              m.role === 'user' && Array.isArray(m.content) &&
              (m.content as any[]).some((p: any) => p.type === 'image_url')) acc.push(i);
          return acc;
        }, []);
        if (visionIdxs.length > 1) {
          for (let i = visionIdxs.length - 2; i >= 0; i--) {
            loop.splice(visionIdxs[i], 1);
          }
        }
      }

      // ── Inject canvas / HTML preview screenshots as vision messages ──────
      // Strategy: collect all screenshot sentinels from tool result messages,
      // replace them with plain-text placeholders, then append a single `user`
      // message containing the most-recent screenshot image.
      //
      // We deliberately do NOT embed images inside `tool` role messages because
      // the GitHub Copilot API (and every provider it proxies to, including Claude
      // and GPT-4o) rejects multipart content in tool-result messages with 400.
      // A `user` message after tool results is the universally valid pattern:
      //   assistant (tool_calls) → tool, tool, … → user (image)   ✅
      // The previous concern about "tool → user" was a mistake — what's invalid
      // is two consecutive `user` messages, not tool → user.
      const SENTINEL_CANVAS  = '__CANVAS_PNG__:';
      const SENTINEL_PREVIEW = '__PREVIEW_PNG__:';
      if (modelSupportsVision(model)) {
        let latestScreenshotUrl = '';
        let latestScreenshotLabel = '';

        // Walk all tool messages, neutralise sentinels, remember the last one
        for (const msg of loop) {
          if (msg.role === 'tool' && typeof msg.content === 'string') {
            const c = msg.content as string;
            if (c.startsWith(SENTINEL_CANVAS)) {
              latestScreenshotUrl   = c.slice(SENTINEL_CANVAS.length);
              latestScreenshotLabel = 'Canvas screenshot after your modifications — verify layout, colors, and content:';
              (msg as any).content  = 'Canvas screenshot taken — see image below.';
            } else if (c.startsWith(SENTINEL_PREVIEW)) {
              latestScreenshotUrl   = c.slice(SENTINEL_PREVIEW.length);
              latestScreenshotLabel = 'HTML preview screenshot — verify the rendered layout, spacing, and visual design:';
              (msg as any).content  = 'HTML preview screenshot taken — see image below.';
            }
          }
        }

        // Prune any stale vision user messages injected by PREVIOUS agent rounds.
        // IMPORTANT: only remove messages that appear AFTER the first assistant turn —
        // the original task message (which may also be multipart with a canvas screenshot)
        // must NOT be removed, or the next round will start with [system]→[assistant]
        // which has no preceding user message and causes a 400 Bad Request.
        const firstAssistantIdxForVision = loop.findIndex((m) => m.role === 'assistant');
        const visionIdxs = loop.reduce<number[]>((acc, m, i) => {
          if (i > firstAssistantIdxForVision &&
              m.role === 'user' && Array.isArray(m.content) &&
              (m.content as any[]).some((p: any) => p.type === 'image_url')) acc.push(i);
          return acc;
        }, []);
        if (visionIdxs.length > 0) {
          // Remove ALL injected vision user messages — we'll append a fresh one below
          for (let i = visionIdxs.length - 1; i >= 0; i--) {
            loop.splice(visionIdxs[i], 1);
          }
        }

        // Append the most recent screenshot as a user message
        if (latestScreenshotUrl) {
          const isValidDataUrl =
            latestScreenshotUrl.startsWith('data:image/') &&
            latestScreenshotUrl.includes(';base64,') &&
            latestScreenshotUrl.length > 300;
          if (isValidDataUrl) {
            loop.push({
              role: 'user',
              content: [
                { type: 'text', text: latestScreenshotLabel },
                { type: 'image_url', image_url: { url: latestScreenshotUrl } },
              ],
            } as any);
          }
        }
      } else {
        // Non-vision model: strip sentinels so base64 blobs aren't sent as plain text
        for (const msg of loop) {
          if (msg.role === 'tool' && typeof msg.content === 'string') {
            const c = msg.content as string;
            if (c.startsWith(SENTINEL_CANVAS)) {
              (msg as any).content = 'Canvas screenshot skipped (model does not support vision).';
            } else if (c.startsWith(SENTINEL_PREVIEW)) {
              (msg as any).content = 'HTML preview screenshot skipped (model does not support vision).';
            }
          }
        }
      }
    }

    // Exhausted all rounds — let the user know and allow them to continue.
    onChunk(
      `\n\n⚠️ O agente atingiu o limite de ${MAX_ROUNDS} rodadas e pode não ter terminado. ` +
      `Clique em **Continuar** para retomar aonde parou.`,
    );
    onExhausted?.();
    onDone();
  } catch (err) {
    // AbortError = intentional interrupt by the user sending a new message — swallow silently
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
