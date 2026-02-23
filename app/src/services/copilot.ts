import type { ChatMessage, CopilotStreamChunk, CopilotModel, CopilotModelInfo, ToolActivity } from '../types';
import { FALLBACK_MODELS, DEFAULT_MODEL } from '../types';
import { fetch } from '@tauri-apps/plugin-http';
import type { ToolDefinition, ToolExecutor } from '../utils/workspaceTools';

const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';

const EDITOR_HEADERS = {
  'Editor-Version': 'vscode/1.99.0',
  'Editor-Plugin-Version': 'copilot-chat/0.26.0',
  'User-Agent': 'GitHubCopilotChat/0.26.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

// ── OAuth / Device Flow ──────────────────────────────────────────────────────────
// The Copilot session-token endpoint only accepts OAuth App tokens, not PATs.
// We use GitHub Device Flow with VS Code's public OAuth client ID.
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
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
  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'copilot' }),
  });
  if (!deviceRes.ok) throw new Error(`Device flow init failed: ${deviceRes.status}`);

  const d = await deviceRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  onState({ userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in });

  const intervalMs = (d.interval + 1) * 1000;
  const deadline = Date.now() + d.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const poll = await pollRes.json() as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

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

async function getCopilotSessionToken(): Promise<string> {
  const now = Date.now();
  if (_sessionToken && now < _sessionTokenExpiry - 60_000) return _sessionToken;

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
  tools?: ToolDefinition[]
): Promise<void> {
  try {
    const sessionToken = await getCopilotSessionToken();

    // Retry up to 3 times for transient 5xx errors with exponential backoff
    const MAX_RETRIES = 3;
    let response: Awaited<ReturnType<typeof fetch>> | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      response = await fetch(COPILOT_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
          ...EDITOR_HEADERS,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          stream: true,
          max_tokens: 4096,
          temperature: 0.7,
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
      // Sanitize HTML error pages (e.g. GitHub's 502 "Unicorn" page) into a clean message
      const cleanError = errorText.trim().startsWith('<')
        ? `GitHub returned a ${response.status} (server error) — please retry in a moment`
        : `Copilot API error ${response.status}: ${errorText}`;
      throw new Error(cleanError);
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

    // Filter to chat-compatible models only
    const models: CopilotModelInfo[] = raw
      .filter((m) => m.id && !m.id.includes('embedding') && !m.id.includes('whisper'))
      .map((m) => {
        const mult = m.billing_multiplier ?? m.multiplier ?? 1;
        return {
          id: m.id,
          name: m.name ?? m.id,
          multiplier: mult,
          isPremium: mult > 1,
          vendor: m.vendor,
        };
      })
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
): Promise<void> {
  try {
    const sessionToken = await getCopilotSessionToken();
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
      ...EDITOR_HEADERS,
    };

    const loop = [...messages];
    const MAX_ROUNDS = 6;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Streaming call to detect tool_calls and stream text
      // Retry up to 3 times for transient 5xx errors with exponential backoff
      let res: Awaited<ReturnType<typeof fetch>> | null = null;
      let lastFetchError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        const r = await fetch(COPILOT_API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: loop,
            tools,
            tool_choice: 'auto',
            stream: true,
            max_tokens: 16000,
            temperature: 0.3,
          }),
        });
        if (r.ok || r.status < 500) { res = r; break; }
        const errText = await r.text();
        const cleanMsg = errText.trim().startsWith('<')
          ? `GitHub returned a ${r.status} (server error) — please retry in a moment`
          : `Copilot API error ${r.status}: ${errText}`;
        lastFetchError = new Error(cleanMsg);
      }
      if (!res) throw lastFetchError!;

      if (!res.ok) {
        const errText = await res.text();
        const cleanMsg = errText.trim().startsWith('<')
          ? `GitHub returned a ${res.status} (server error) — please retry in a moment`
          : `Copilot API error ${res.status}: ${errText}`;
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
      // Use null (not '') for content when only tool_calls are present — matches
      // OpenAI API spec and avoids rejection from strict backends.
      const cleanAssistantContent = fullContent
        .replace(/<(?:tool_call|invoke)[^>]*>[\s\S]*?<\/(?:tool_call|invoke)>/g, '')
        .replace(/<(?:tool_response|function_results)[^>]*>[\s\S]*?<\/(?:tool_response|function_results)>/g, '')
        .replace(/<\/?function_calls>/g, '')
        .trim() || null;
      loop.push({
        role: 'assistant',
        content: cleanAssistantContent as any,
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

        loop.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        });
      }

      // ── Inject canvas screenshots as vision messages ─────────────────────
      // The canvas_screenshot tool returns a sentinel prefix so we can convert
      // the tool result into a proper OpenAI vision message (content array).
      // This avoids sending large base64 blobs as plain text tool results.
      const SCREENSHOT_SENTINEL = '__CANVAS_PNG__:';
      const visionUrls: string[] = [];
      for (const msg of loop) {
        if (msg.role === 'tool' && typeof msg.content === 'string' &&
            (msg.content as string).startsWith(SCREENSHOT_SENTINEL)) {
          visionUrls.push((msg.content as string).slice(SCREENSHOT_SENTINEL.length));
          // Replace sentinel so subsequent rounds don't re-inject
          (msg as any).content = 'Canvas screenshot rendered — the image is in the message above.';
        }
      }
      if (visionUrls.length > 0) {
        const parts: unknown[] = [
          { type: 'text', text: `Canvas screenshot${visionUrls.length > 1 ? 's' : ''} after your modifications — verify the layout, colors, and content look correct:` },
          ...visionUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ];
        loop.push({ role: 'user', content: parts as any });
      }
    }

    // Exhausted rounds: fall back to a plain final response
    // We must pass `tools` here so the model knows it can't just output raw XML
    await streamCopilotChat(loop, onChunk, onDone, onError, model, tools);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
