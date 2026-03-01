/**
 * publishVercel — deploy a local folder to Vercel via the REST API.
 *
 * Auth: Vercel token stored globally as `cafezin-vercel-token` (localStorage /
 * encrypted Supabase sync), with optional per-workspace override in
 * WorkspaceConfig.vercelConfig.token.
 *
 * Flow:
 *  1. Walk `dirPath` and read every file
 *  2. POST /v13/deployments with `files[].data` (base64) — works for static sites
 *  3. Return the deployment URL + id
 */

import { readDir, readFile } from './fs';

const VERCEL_API = 'https://api.vercel.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const SKIP = new Set(['.git', '.DS_Store', 'node_modules', '.cafezin', 'Thumbs.db']);

async function collectFiles(
  absDir: string,
  rel = '',
): Promise<{ relPath: string; bytes: Uint8Array }[]> {
  let entries;
  try { entries = await readDir(absDir); } catch { return []; }

  const files: { relPath: string; bytes: Uint8Array }[] = [];
  for (const e of entries) {
    if (!e.name || SKIP.has(e.name)) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) {
      files.push(...await collectFiles(`${absDir}/${e.name}`, relPath));
    } else {
      try {
        const bytes = await readFile(`${absDir}/${e.name}`);
        files.push({ relPath, bytes });
      } catch {
        // skip unreadable files
      }
    }
  }
  return files;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface VercelDeployOptions {
  /** Vercel API token */
  token: string;
  /** Vercel project name (shown in dashboard, used for custom domain assignment) */
  projectName: string;
  /** Optional team/org ID — leave undefined for personal accounts */
  teamId?: string;
  /** Absolute path to the folder whose contents will be deployed */
  dirPath: string;
  /** Deploy to production (true) or preview (false). Default: true */
  production?: boolean;
}

export interface VercelDeployResult {
  /** Deployment ID */
  id: string;
  /** Ready-to-visit URL (https://...) */
  url: string;
  /** ISO timestamp when the deployment became ready (may be undefined if still building) */
  readyAt?: string;
  /** Raw deployment state from Vercel API */
  state?: string;
}

export async function deployToVercel(opts: VercelDeployOptions): Promise<VercelDeployResult> {
  const { token, projectName, teamId, dirPath, production = true } = opts;

  // 1. Collect & encode files
  const rawFiles = await collectFiles(dirPath);
  if (rawFiles.length === 0) {
    throw new Error('Nenhum arquivo encontrado em ' + dirPath);
  }

  const files = rawFiles.map(({ relPath, bytes }) => ({
    file: relPath,
    data: toBase64(bytes),
    encoding: 'base64',
  }));

  // 2. Create deployment
  const teamParam = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const res = await fetch(`${VERCEL_API}/v13/deployments${teamParam}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name:    projectName,
      files,
      target:  production ? 'production' : 'preview',
      projectSettings: { framework: null },
    }),
  });

  if (!res.ok) {
    let msg = `Vercel API error: ${res.status}`;
    try {
      const body = await res.json() as { error?: { message?: string } };
      if (body?.error?.message) msg += ` — ${body.error.message}`;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const data = await res.json() as {
    id: string;
    url: string;
    readyAt?: string;
    state?: string;
  };

  return {
    id:      data.id,
    url:     data.url?.startsWith('http') ? data.url : `https://${data.url}`,
    readyAt: data.readyAt,
    state:   data.state,
  };
}

/** Read Vercel token: workspace override first, then global localStorage key. */
export function resolveVercelToken(workspaceToken?: string): string {
  return workspaceToken?.trim() || localStorage.getItem('cafezin-vercel-token') || '';
}
