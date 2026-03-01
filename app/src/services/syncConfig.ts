/**
 * Sync configuration service — v2 (Supabase Auth + DB)
 *
 * Replaces the previous GitHub Gist-based approach.
 *
 * Auth: Supabase email + password, Google OAuth, Apple OAuth
 * Storage: `synced_workspaces` table with RLS — each user only sees their own rows.
 *
 * OAuth flow for Tauri (custom URL scheme):
 *   1. signInWithGoogle() / signInWithApple() → returns an authorization URL
 *   2. Caller opens the URL in the system browser via tauri-plugin-opener
 *   3. After authentication, the browser redirects to cafezin://auth/callback#access_token=...
 *   4. Rust deep-link handler emits 'auth-callback' event with the full URL
 *   5. handleAuthCallbackUrl() parses the hash and calls supabase.auth.setSession()
 *
 * Git account tokens (for clone/push on mobile) remain in localStorage
 * because they are device-specific and must never leave the device.
 */

import { fetch } from '@tauri-apps/plugin-http'
import { invoke } from '@tauri-apps/api/core'
import { documentDir } from '@tauri-apps/api/path'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

/** Used for GitHub device-flow to authenticate git push/clone per account. */
export interface SyncDeviceFlowState {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export interface SyncedWorkspace {
  id?: string
  /** Human-readable display name */
  name: string
  /** Git remote origin URL, e.g. "https://github.com/pedro/blog.git" */
  gitUrl: string
  /** Label for the git account that owns this repo, e.g. "personal" */
  gitAccountLabel: string
  /** ISO timestamp when this entry was first registered */
  addedAt: string
  /** Absolute local path — only set on mobile after cloning. Never stored in DB. */
  localPath?: string
}

// ── Auth ───────────────────────────────────────────────────────────────────────

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession()
  return data.session
}

export async function getUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser()
  return data.user
}

export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession()
  return !!session
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
}

export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({ email, password })
  if (error) throw new Error(error.message)
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

// ── OAuth (Google / Apple) ─────────────────────────────────────────────────

const OAUTH_REDIRECT = 'cafezin://auth/callback'

/**
 * Start Google OAuth. Returns the authorization URL to open in the system browser.
 * Requires "Google" provider enabled in the Supabase dashboard.
 */
export async function signInWithGoogle(): Promise<string> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: true },
  })
  if (error) throw new Error(error.message)
  if (!data.url) throw new Error('No OAuth URL returned')
  return data.url
}

/**
 * Start Apple Sign In. Returns the authorization URL to open in the system browser.
 * Requires "Apple" provider enabled in the Supabase dashboard.
 */
export async function signInWithApple(): Promise<string> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: true },
  })
  if (error) throw new Error(error.message)
  if (!data.url) throw new Error('No OAuth URL returned')
  return data.url
}

/**
 * Called when the Tauri deep link handler emits 'auth-callback' with the full URL.
 * Parses the hash fragment (implicit flow) and sets the Supabase session.
 * Returns the user after successful sign-in.
 */
export async function handleAuthCallbackUrl(url: string): Promise<User | null> {
  // The URL looks like: cafezin://auth/callback#access_token=XXX&refresh_token=YYY&...
  const hash = url.includes('#') ? url.split('#')[1] : url.split('?')[1] ?? ''
  const params = new URLSearchParams(hash)
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) {
    throw new Error('OAuth callback URL missing tokens')
  }
  const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
  if (error) throw new Error(error.message)
  return data.user
}

// ── Workspace sync ─────────────────────────────────────────────────────────────

// ── Local clone paths (device-specific, never stored in DB) ──────────────────

const CLONED_PATH_PREFIX = 'cafezin-cloned-path:'

export function getLocalClonedPath(gitUrl: string): string | null {
  return localStorage.getItem(`${CLONED_PATH_PREFIX}${gitUrl}`)
}

export function setLocalClonedPath(gitUrl: string, path: string): void {
  localStorage.setItem(`${CLONED_PATH_PREFIX}${gitUrl}`, path)
}

export async function listSyncedWorkspaces(): Promise<SyncedWorkspace[]> {
  const { data, error } = await supabase
    .from('synced_workspaces')
    .select('*')
    .order('added_at', { ascending: true })

  if (error) throw new Error(error.message)

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    gitUrl: row.git_url as string,
    gitAccountLabel: row.git_account_label as string,
    addedAt: row.added_at as string,
    localPath: getLocalClonedPath(row.git_url as string) ?? undefined,
  }))
}

// ── Git clone / pull (mobile) ─────────────────────────────────────────────────

/** Derive a local folder name from a git URL (last segment, strip .git). */
export function repoNameFromUrl(gitUrl: string): string {
  return gitUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'repo'
}

/**
 * Clone a git repo into the device Documents folder.
 * Stores the resulting local path in localStorage so it survives app restarts.
 * @param gitUrl  Remote URL (https)
 * @param token   Optional GitHub PAT / OAuth token for private repos
 */
export async function gitClone(gitUrl: string, token?: string): Promise<string> {
  const docs = await documentDir()
  const name = repoNameFromUrl(gitUrl)
  const dest = `${docs}${name}`
  await invoke<string>('git_clone', { url: gitUrl, path: dest, token: token ?? null })
  setLocalClonedPath(gitUrl, dest)
  return dest
}

/**
 * Pull latest changes on the already-cloned repo at `localPath`.
 * @param localPath Absolute path previously returned by gitClone
 * @param token     Optional GitHub PAT / OAuth token
 */
export async function gitPull(localPath: string, token?: string): Promise<string> {
  return invoke<string>('git_pull', { path: localPath, token: token ?? null })
}

/**
 * Register (or update) the current workspace in the DB.
 * Reads git remote from the Rust side — only works on desktop.
 * Returns null if the user is not authenticated OR if the workspace has no git remote.
 */
export async function registerWorkspace(
  workspacePath: string,
  workspaceName: string,
  gitAccountLabel: string,
): Promise<SyncedWorkspace | null> {
  const session = await getSession()
  if (!session) return null

  // Workspaces without a git remote are local-only — nothing to save in the cloud.
  let gitUrl: string
  try {
    gitUrl = await detectGitRemote(workspacePath)
  } catch {
    return null
  }

  const { data, error } = await supabase
    .from('synced_workspaces')
    .upsert(
      {
        user_id: session.user.id,
        name: workspaceName,
        git_url: gitUrl,
        git_account_label: gitAccountLabel,
      },
      { onConflict: 'user_id,git_url' },
    )
    .select()
    .single()

  if (error) throw new Error(error.message)

  return {
    id: data.id as string,
    name: data.name as string,
    gitUrl: data.git_url as string,
    gitAccountLabel: data.git_account_label as string,
    addedAt: data.added_at as string,
  }
}

/** Remove a workspace from the DB by its git URL. */
export async function unregisterWorkspace(gitUrl: string): Promise<void> {
  const { error } = await supabase
    .from('synced_workspaces')
    .delete()
    .eq('git_url', gitUrl)

  if (error) throw new Error(error.message)
}

// ── Git remote detection ───────────────────────────────────────────────────────

async function detectGitRemote(workspacePath: string): Promise<string> {
  const url = await invoke<string>('git_get_remote', { path: workspacePath })
  const trimmed = url?.trim()
  if (!trimmed) throw new Error('git remote get-url origin returned an empty URL')
  return trimmed
}

// ── Per-workspace git account tokens (localStorage — device-specific) ──────────

const GIT_TOKEN_PREFIX = 'cafezin-git-token:'

export function getGitAccountToken(label: string): string | null {
  return localStorage.getItem(`${GIT_TOKEN_PREFIX}${label}`)
}

export function storeGitAccountToken(label: string, token: string): void {
  localStorage.setItem(`${GIT_TOKEN_PREFIX}${label}`, token)
}

export function clearGitAccountToken(label: string): void {
  localStorage.removeItem(`${GIT_TOKEN_PREFIX}${label}`)
}

/** Return all git account labels that have stored tokens on this device. */
export function listGitAccountLabels(): string[] {
  const labels: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(GIT_TOKEN_PREFIX)) {
      labels.push(key.slice(GIT_TOKEN_PREFIX.length))
    }
  }
  return labels
}

/**
 * Start device-flow OAuth for a specific named git account (e.g. "personal").
 * Requests `repo` scope for clone/pull/push access.
 * Separate from Cafezin account auth — these tokens are for git operations only.
 */
export async function startGitAccountFlow(
  label: string,
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const token = await runDeviceFlow('repo', onState)
  storeGitAccountToken(label, token)
  return token
}

// ── GitHub device flow (git accounts only) ─────────────────────────────────────

const GIT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'


function waitOrResume(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisible)
        resolve()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
  })
}

async function pollLoop(deviceCode: string, deadline: number, intervalMs: number): Promise<string> {
  while (Date.now() < deadline) {
    await waitOrResume(intervalMs)
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GIT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const poll = await res.json() as {
      access_token?: string
      error?: string
      error_description?: string
    }
    if (poll.access_token) return poll.access_token
    if (poll.error === 'slow_down') { await waitOrResume(3000); continue }
    if (poll.error === 'authorization_pending') continue
    throw new Error(poll.error_description ?? poll.error ?? 'Authorization failed')
  }
  throw new Error('Device flow timed out — please try again')
}

async function runDeviceFlow(
  scope: string,
  onState: (state: SyncDeviceFlowState) => void,
): Promise<string> {
  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: GIT_CLIENT_ID, scope }),
  })
  if (!deviceRes.ok) throw new Error(`Device flow init failed: ${deviceRes.status}`)

  const d = await deviceRes.json() as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }

  const intervalMs = (d.interval + 1) * 1000
  const expiresAt = Date.now() + d.expires_in * 1000

  onState({ userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in })
  return await pollLoop(d.device_code, expiresAt, intervalMs)
}

