/**
 * Sync configuration service.
 *
 * Uses a single private GitHub Gist as a zero-backend config record that lists
 * which workspaces are synced and which git account each belongs to.
 *
 * Architecture:
 *   ┌─ Sync account (any GitHub account) ─────────────────────────────────┐
 *   │  Authenticates once with `gist repo` scope via device flow.          │
 *   │  Owns a private gist → cafezin-sync.json                          │
 *   │  Lists all synced workspaces + their git account labels.             │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌─ Per-workspace git accounts (1…N) ──────────────────────────────────┐
 *   │  Each labeled "personal", "work", etc.                               │
 *   │  Authenticated separately with `repo` scope.                         │
 *   │  Tokens stored in localStorage keyed by label.                       │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * NOTE: Uses VS Code's public OAuth App client ID for device flow.
 * For production, register your own GitHub OAuth App at
 * https://github.com/settings/developers (Device flow + gist + repo scopes).
 * Then replace SYNC_CLIENT_ID below.
 */

import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';

// ── Constants ─────────────────────────────────────────────────────────────────

// TODO: Replace with a dedicated Cafezin GitHub OAuth App client ID
// (same App as copilot.ts, just needs gist + repo scopes added).
const SYNC_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // ← swap for your own App

const GIST_FILENAME    = 'cafezin-sync.json';
const GIST_DESCRIPTION = 'cafezin workspace sync config (do not delete)';

const SYNC_TOKEN_KEY   = 'cafezin-sync-account-token';
const SYNC_GIST_ID_KEY = 'cafezin-sync-gist-id';
const GIT_TOKEN_PREFIX = 'cafezin-git-token:'; // + label, e.g. "personal"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncDeviceFlowState {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface SyncedWorkspace {
  /** Human-readable display name */
  name: string;
  /** Git remote origin URL, e.g. "https://github.com/pedro/blog.git" */
  gitUrl: string;
  /** Label for the git account that owns this repo, e.g. "personal" */
  gitAccountLabel: string;
  /** ISO timestamp when this entry was first registered */
  addedAt: string;
  /** Absolute local path where this repo is cloned on this device (mobile only) */
  localPath?: string;
}

export interface SyncConfig {
  version: 1;
  workspaces: SyncedWorkspace[];
}

// ── Pending device-flow persistence (survives WKWebView reload on iOS) ─────────

const PENDING_FLOW_KEY = 'cafezin-pending-device-flow';

interface PendingFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;   // epoch ms
  intervalMs: number;
}

function savePendingFlow(f: PendingFlow): void {
  sessionStorage.setItem(PENDING_FLOW_KEY, JSON.stringify(f));
}

function clearPendingFlow(): void {
  sessionStorage.removeItem(PENDING_FLOW_KEY);
}

/** Returns the saved pending device-flow if not yet expired, or null. */
export function getPendingDeviceFlow(): (PendingFlow & SyncDeviceFlowState) | null {
  const raw = sessionStorage.getItem(PENDING_FLOW_KEY);
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as PendingFlow;
    if (Date.now() > f.expiresAt) { clearPendingFlow(); return null; }
    return {
      ...f,
      userCode: f.userCode,
      verificationUri: f.verificationUri,
      expiresIn: Math.round((f.expiresAt - Date.now()) / 1000),
    };
  } catch { return null; }
}

/**
 * Resume polling for a saved pending flow (e.g. after a page reload on iOS).
 * Calls onState immediately with the saved code so the UI can be re-shown.
 * Returns the access token when the user authorizes.
 */
export async function resumeDeviceFlow(
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const pending = getPendingDeviceFlow();
  if (!pending) throw new Error('No pending device flow to resume');

  onState({
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    expiresIn: pending.expiresIn,
  });

  try {
    return await pollLoop(pending.deviceCode, pending.expiresAt, pending.intervalMs);
  } finally {
    clearPendingFlow();
  }
}

// ── Internal device-flow helper ────────────────────────────────────────────────

// On iOS, setTimeout is suspended while the app is in background (e.g. while
// the user is in Safari entering the auth code). This resolves on either the
// timeout OR the moment the page becomes visible again.
function waitOrResume(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
  });
}

async function pollLoop(deviceCode: string, deadline: number, intervalMs: number): Promise<string> {
  while (Date.now() < deadline) {
    await waitOrResume(intervalMs);

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: SYNC_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const poll = await pollRes.json() as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (poll.access_token) return poll.access_token;
    if (poll.error === 'slow_down') { await waitOrResume(3000); continue; }
    if (poll.error === 'authorization_pending') continue;
    throw new Error(poll.error_description ?? poll.error ?? 'Authorization failed');
  }
  throw new Error('Device flow timed out — please try again');
}

async function runDeviceFlow(
  scope: string,
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: SYNC_CLIENT_ID, scope }),
  });
  if (!deviceRes.ok) throw new Error(`Device flow init failed: ${deviceRes.status}`);

  const d = await deviceRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  const intervalMs = (d.interval + 1) * 1000;
  const expiresAt = Date.now() + d.expires_in * 1000;

  // Persist to sessionStorage so polling can resume if the WKWebView reloads
  // (common in Tauri iOS dev mode when returning from Safari).
  savePendingFlow({
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    expiresAt,
    intervalMs,
  });

  onState({
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    expiresIn: d.expires_in,
  });

  try {
    return await pollLoop(d.device_code, expiresAt, intervalMs);
  } finally {
    clearPendingFlow();
  }
}

// ── Sync account ────────────────────────────────────────────────────────────────

export function getSyncAccountToken(): string | null {
  return localStorage.getItem(SYNC_TOKEN_KEY);
}

export function clearSyncAccountToken(): void {
  localStorage.removeItem(SYNC_TOKEN_KEY);
  localStorage.removeItem(SYNC_GIST_ID_KEY);
}

/**
 * Store a user-supplied Personal Access Token as the sync account token.
 * The token must have at least `gist` scope.
 */
export function storeSyncAccountToken(token: string): void {
  localStorage.setItem(SYNC_TOKEN_KEY, token.trim());
}

/**
 * @deprecated Use `storeSyncAccountToken` with a PAT instead.
 * Kept for git-account device flows (repo scope).
 */
export async function startSyncAccountFlow(
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const token = await runDeviceFlow('gist repo', onState);
  localStorage.setItem(SYNC_TOKEN_KEY, token);
  return token;
}

// ── Per-workspace git account tokens ──────────────────────────────────────────

export function getGitAccountToken(label: string): string | null {
  return localStorage.getItem(`${GIT_TOKEN_PREFIX}${label}`);
}

export function storeGitAccountToken(label: string, token: string): void {
  localStorage.setItem(`${GIT_TOKEN_PREFIX}${label}`, token);
}

export function clearGitAccountToken(label: string): void {
  localStorage.removeItem(`${GIT_TOKEN_PREFIX}${label}`);
}

/** Return all git account labels that have stored tokens on this device. */
export function listGitAccountLabels(): string[] {
  const labels: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(GIT_TOKEN_PREFIX)) {
      labels.push(key.slice(GIT_TOKEN_PREFIX.length));
    }
  }
  return labels;
}

/**
 * Start device-flow OAuth for a specific named git account (e.g. "personal").
 * Requests `repo` scope for clone/pull/push access.
 */
export async function startGitAccountFlow(
  label: string,
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const token = await runDeviceFlow('repo', onState);
  storeGitAccountToken(label, token);
  return token;
}

// ── Gist CRUD ─────────────────────────────────────────────────────────────────

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

/**
 * Find or create the private sync gist.
 * Caches the gist ID in localStorage so subsequent calls are O(1).
 */
export async function getOrCreateSyncGist(token: string): Promise<string> {
  const cached = localStorage.getItem(SYNC_GIST_ID_KEY);
  if (cached) return cached;

  // Helper: extract a human-readable GitHub error message from a response body.
  async function ghErrMsg(res: Response): Promise<string> {
    try {
      const body = await res.json() as { message?: string };
      return body.message ? `${res.status} – ${body.message}` : `${res.status}`;
    } catch {
      return `${res.status}`;
    }
  }

  // Search the first 100 gists for ours
  const listRes = await fetch('https://api.github.com/gists?per_page=100', {
    headers: githubHeaders(token),
  });
  if (!listRes.ok) {
    const detail = await ghErrMsg(listRes);
    throw new Error(`Gist list failed: ${detail}`);
  }

  const gists = await listRes.json() as Array<{
    id: string;
    description: string;
    files: Record<string, unknown>;
  }>;

  const existing = gists.find(
    (g) => g.description === GIST_DESCRIPTION && g.files[GIST_FILENAME],
  );

  if (existing) {
    localStorage.setItem(SYNC_GIST_ID_KEY, existing.id);
    return existing.id;
  }

  // Create a new private gist
  const empty: SyncConfig = { version: 1, workspaces: [] };
  const createRes = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(empty, null, 2) } },
    }),
  });
  if (!createRes.ok) {
    const detail = await ghErrMsg(createRes);
    throw new Error(`Gist create failed: ${detail}. Re-open Settings → Sync to reconnect your account.`);
  }

  const created = await createRes.json() as { id: string };
  localStorage.setItem(SYNC_GIST_ID_KEY, created.id);
  return created.id;
}

/** Read the current SyncConfig from the gist. */
export async function readSyncConfig(token: string, gistId: string): Promise<SyncConfig> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const b = await res.json() as { message?: string }; if (b.message) detail = `${res.status} – ${b.message}`; } catch { /* ignore */ }
    throw new Error(`Gist read failed: ${detail}`);
  }

  const gist = await res.json() as { files: Record<string, { content: string }> };
  const raw = gist.files[GIST_FILENAME]?.content;
  if (!raw) return { version: 1, workspaces: [] };

  try { return JSON.parse(raw) as SyncConfig; }
  catch { return { version: 1, workspaces: [] }; }
}

/** Write an updated SyncConfig back to the gist. */
export async function writeSyncConfig(
  token: string,
  gistId: string,
  config: SyncConfig,
): Promise<void> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: githubHeaders(token),
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: JSON.stringify(config, null, 2) } },
    }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const b = await res.json() as { message?: string }; if (b.message) detail = `${res.status} – ${b.message}`; } catch { /* ignore */ }
    throw new Error(`Gist write failed: ${detail}`);
  }
}

// ── High-level workspace helpers ───────────────────────────────────────────────

/**
 * Use the Rust git_get_remote command to detect origin URL for a workspace.
 * Throws if the folder is not a git repo, has no origin remote, or the command fails.
 */
export async function detectGitRemote(workspacePath: string): Promise<string> {
  const url = await invoke<string>('git_get_remote', { path: workspacePath });
  const trimmed = url?.trim();
  if (!trimmed) throw new Error('git remote get-url origin returned an empty URL');
  return trimmed;
}

/**
 * Register (or update) a workspace in the sync gist.
 * Safe to call on every workspace open — no-op if already registered with
 * the same gitUrl.
 *
 * Returns the entry added, or null if:
 *   - No sync account is authenticated
 *   - The workspace has no git remote
 */
export async function registerWorkspace(
  workspacePath: string,
  workspaceName: string,
  gitAccountLabel: string,
): Promise<SyncedWorkspace | null> {
  const token = getSyncAccountToken();
  if (!token) return null;

  const gitUrl = await detectGitRemote(workspacePath);

  const gistId = await getOrCreateSyncGist(token);
  const config = await readSyncConfig(token, gistId);

  const idx = config.workspaces.findIndex((w) => w.gitUrl === gitUrl);
  const entry: SyncedWorkspace = {
    name: workspaceName,
    gitUrl,
    gitAccountLabel,
    addedAt: idx >= 0 ? config.workspaces[idx].addedAt : new Date().toISOString(),
  };

  if (idx >= 0) {
    config.workspaces[idx] = entry;
  } else {
    config.workspaces.push(entry);
  }

  await writeSyncConfig(token, gistId, config);
  return entry;
}

/**
 * Fetch the full list of synced workspaces from the gist.
 * Returns empty array if not authenticated or on any error.
 */
export async function listSyncedWorkspaces(): Promise<SyncedWorkspace[]> {
  const token = getSyncAccountToken();
  if (!token) return [];
  try {
    const gistId = await getOrCreateSyncGist(token);
    const config = await readSyncConfig(token, gistId);
    return config.workspaces;
  } catch {
    return [];
  }
}

/** Remove a workspace entry from the gist by its git URL. */
export async function unregisterWorkspace(gitUrl: string): Promise<void> {
  const token = getSyncAccountToken();
  if (!token) return;
  const gistId = await getOrCreateSyncGist(token);
  const config = await readSyncConfig(token, gistId);
  config.workspaces = config.workspaces.filter((w) => w.gitUrl !== gitUrl);
  await writeSyncConfig(token, gistId, config);
}
