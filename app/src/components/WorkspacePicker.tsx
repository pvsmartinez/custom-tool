import { useState, useEffect } from 'react';
import { FolderOpen, Plus, SignIn, SignOut, Cloud, CloudSlash, CloudArrowUp, GitBranch, ArrowSquareOut } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { mkdir } from '../services/fs';
import { pickWorkspaceFolder, loadWorkspace, getRecents, removeRecent } from '../services/workspace';
import {
  getSession, getUser, signIn, signUp, signOut, signInWithGoogle, signInWithApple,
  listSyncedWorkspaces, registerWorkspace, registerWorkspaceByUrl,
  type SyncedWorkspace,
} from '../services/syncConfig';
import type { Workspace, RecentWorkspace } from '../types';
import './WorkspacePicker.css';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Normalize a git URL for comparison: strip protocol/host, trailing .git, lowercase */
function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@[^:]+:/, '')      // git@github.com:user/repo → user/repo
    .replace(/^https?:\/\/[^/]+\//, '') // https://github.com/user/repo → user/repo
    .toLowerCase();
}

type MergedEntry =
  | { type: 'synced';       cloud: SyncedWorkspace; local: RecentWorkspace }
  | { type: 'cloud-only';   cloud: SyncedWorkspace }
  | { type: 'local-git';    local: RecentWorkspace }
  | { type: 'local-nogit';  local: RecentWorkspace };

function buildMergedList(
  cloudWorkspaces: SyncedWorkspace[],
  recents: RecentWorkspace[],
): MergedEntry[] {
  const matchedLocalPaths = new Set<string>();
  const entries: MergedEntry[] = [];

  for (const cw of cloudWorkspaces) {
    const normalized = normalizeGitUrl(cw.gitUrl);
    const matched = recents.find(
      (r) => r.gitRemote && normalizeGitUrl(r.gitRemote) === normalized,
    );
    if (matched) {
      entries.push({ type: 'synced', cloud: cw, local: matched });
      matchedLocalPaths.add(matched.path);
    } else {
      entries.push({ type: 'cloud-only', cloud: cw });
    }
  }

  for (const r of recents) {
    if (matchedLocalPaths.has(r.path)) continue;
    entries.push(r.hasGit
      ? { type: 'local-git',   local: r }
      : { type: 'local-nogit', local: r },
    );
  }

  return entries;
}

interface WorkspacePickerProps {
  onOpen: (workspace: Workspace) => void;
}

export default function WorkspacePicker({ onOpen }: WorkspacePickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentWorkspace[]>(getRecents);
  const [uncommitted, setUncommitted] = useState<Record<string, number | null>>({});

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<'google' | 'apple' | null>(null);

  // ── Cloud workspaces ──────────────────────────────────────────────────────
  const [cloudWorkspaces, setCloudWorkspaces] = useState<SyncedWorkspace[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);

  // ── New workspace state ───────────────────────────────────────────────────
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [publishPath, setPublishPath] = useState<string | null>(null);
  const [publishName, setPublishName] = useState('');
  const [publishUrl, setPublishUrl] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // ── Publish-to-cloud state (local-nogit flow) ─────────────────────────────
  const [cloneBusy, setCloneBusy] = useState<string | null>(null); // gitUrl being cloned

  // ── Clone state (cloud-only flow) ─────────────────────────────────────────
  const [registerBusy, setRegisterBusy] = useState<string | null>(null); // local path being registered

  /** Create a new empty workspace folder and open it. */
  async function handleCreate() {
    const name = createName.trim();
    if (!name) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const parent = await pickWorkspaceFolder();
      if (!parent) { setCreateBusy(false); return; }
      const dest = `${parent}/${name}`;
      await mkdir(dest, { recursive: true });
      const workspace = await loadWorkspace(dest);
      onOpen(workspace);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreateBusy(false);
    }
  }

  // ── Initialise session + recents ─────────────────────────────────────────
  useEffect(() => {
    getSession().then(async (session) => {
      if (session) {
        const user = await getUser();
        setUserEmail(user?.email ?? null);
        await loadCloud();
      }
    }).catch(() => {});

    const onAuthUpdated = async () => {
      const user = await getUser().catch(() => null);
      if (user) {
        setUserEmail(user.email ?? null);
        setOauthBusy(null);
        await loadCloud();
      }
    };
    window.addEventListener('cafezin:auth-updated', onAuthUpdated as EventListener);

    if (recents.length > 0) {
      setUncommitted(Object.fromEntries(recents.map((r) => [r.path, null])));
      recents.forEach((r) => {
        invoke<{ files: string[] }>('git_diff', { path: r.path })
          .then((res) => setUncommitted((prev) => ({ ...prev, [r.path]: res.files.length })))
          .catch(() => setUncommitted((prev) => ({ ...prev, [r.path]: 0 })));
      });

      // Backfill gitRemote for old entries that were saved before remote detection existed
      const needsRemote = recents.filter((r) => r.gitRemote === undefined);
      if (needsRemote.length > 0) {
        Promise.allSettled(
          needsRemote.map((r) =>
            invoke<string>('git_get_remote', { path: r.path })
              .then((remote) => ({ path: r.path, remote: remote?.trim() || undefined }))
              .catch(() => ({ path: r.path, remote: undefined as string | undefined }))
          )
        ).then((results) => {
          const updates: Record<string, string | undefined> = {};
          results.forEach((res) => {
            if (res.status === 'fulfilled') updates[res.value.path] = res.value.remote;
          });
          setRecents((prev) => {
            const next = prev.map((r) =>
              r.path in updates
                ? { ...r, gitRemote: updates[r.path], hasGit: !!updates[r.path] }
                : r
            );
            // Persist backfilled data to localStorage — slice to cap size
            localStorage.setItem('cafezin-recent-workspaces', JSON.stringify(next.slice(0, 20)));
            return next;
          });
        });
      }
    }

    return () => window.removeEventListener('cafezin:auth-updated', onAuthUpdated as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCloud() {
    setCloudLoading(true);
    try {
      const list = await listSyncedWorkspaces();
      setCloudWorkspaces(list);
    } catch { /* not fatal */ }
    finally { setCloudLoading(false); }
  }

  async function handleAuth() {
    const em = email.trim();
    const pw = password.trim();
    if (!em || !pw) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authMode === 'login') await signIn(em, pw);
      else await signUp(em, pw);
      const user = await getUser();
      setUserEmail(user?.email ?? em);
      setAuthOpen(false);
      setEmail('');
      setPassword('');
      await loadCloud();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setUserEmail(null);
    setCloudWorkspaces([]);
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    setAuthError(null);
    setOauthBusy(provider);
    try {
      const url = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      await openUrl(url);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
      setOauthBusy(null);
    }
  }

  async function handlePick() {
    setError(null);
    setLoading(true);
    try {
      const path = await pickWorkspaceFolder();
      if (!path) { setLoading(false); return; }
      const workspace = await loadWorkspace(path);
      onOpen(workspace);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function handleOpenLocal(recent: RecentWorkspace) {
    setError(null);
    setLoading(true);
    try {
      const workspace = await loadWorkspace(recent.path);
      onOpen(workspace);
    } catch (err) {
      setError(`Could not open "${recent.name}": ${err}`);
      removeRecent(recent.path);
      setRecents(getRecents());
      setLoading(false);
    }
  }

  /** Clone a cloud-only workspace: pick parent folder, then clone + open. */
  async function handleClone(cw: SyncedWorkspace) {
    setCloneBusy(cw.gitUrl);
    setError(null);
    try {
      const parent = await pickWorkspaceFolder();
      if (!parent) { setCloneBusy(null); return; }
      // Use workspace name as the folder name inside the picked parent
      const dest = `${parent}/${cw.name}`;
      await invoke('git_clone', { url: cw.gitUrl, path: dest, token: null, branch: cw.branch ?? null });
      const workspace = await loadWorkspace(dest);
      onOpen(workspace);
    } catch (err) {
      setError(`Erro ao clonar: ${err}`);
      setCloneBusy(null);
    }
  }

  /** Register an existing local-git workspace to the cloud (one-click). */
  async function handleRegisterLocalGit(r: RecentWorkspace) {
    if (!r.gitRemote) return;
    setRegisterBusy(r.path);
    setError(null);
    try {
      await registerWorkspace(r.path, r.name, 'personal');
      await loadCloud();
    } catch (err) {
      setError(`Erro ao sincronizar: ${err}`);
    } finally {
      setRegisterBusy(null);
    }
  }

  /** Open publish-to-cloud form for a local-nogit workspace. */
  function openPublishForm(r: RecentWorkspace) {
    setPublishPath(r.path);
    setPublishName(r.name);
    setPublishUrl('');
    setPublishError(null);
  }

  /** Set remote + register in Supabase for a local workspace with no git remote. */
  async function handlePublish() {
    if (!publishPath || !publishUrl.trim()) return;
    setPublishBusy(true);
    setPublishError(null);
    try {
      await invoke('git_set_remote', { path: publishPath, url: publishUrl.trim() });
      await registerWorkspaceByUrl(publishName, publishUrl.trim());
      await loadCloud();
      setPublishPath(null);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishBusy(false);
    }
  }

  const merged = buildMergedList(cloudWorkspaces, recents);
  const hasAnyWorkspaces = merged.length > 0 || cloudLoading;

  return (
    <div className="wp-overlay">
      <div className="wp-card">

        {/* ── Header ── */}
        <div className="wp-header">
          <div className="wp-logo">✦</div>
          <h1 className="wp-title">Cafezin</h1>
          <p className="wp-tagline">Just Chilling</p>
        </div>

        {/* ── Primary actions ── */}
        <div className="wp-actions">
          <button className="wp-btn-action" onClick={handlePick} disabled={loading || createBusy}>
            <FolderOpen weight="thin" size={16} />
            <span>Abrir pasta</span>
          </button>
          <button
            className={`wp-btn-action wp-btn-action--create${createMode ? ' wp-btn-action--active' : ''}`}
            onClick={() => { setCreateMode((m) => !m); setCreateName(''); setCreateError(null); }}
            disabled={loading || createBusy}
          >
            <Plus weight="thin" size={16} />
            <span>Novo workspace</span>
          </button>
        </div>

        {/* ── New workspace inline form ── */}
        {createMode && (
          <div className="wp-create-form">
            <input
              className="wp-auth-input"
              placeholder="Nome do workspace"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') { setCreateMode(false); setCreateName(''); }
              }}
              autoFocus
            />
            <p className="wp-create-hint">Escolha onde salvar na próxima etapa.</p>
            {createError && <div className="wp-auth-error">{createError}</div>}
            <button
              className="wp-btn-action wp-btn-action--primary"
              onClick={handleCreate}
              disabled={createBusy || !createName.trim()}
            >
              {createBusy ? 'Criando…' : 'Escolher local e criar'}
            </button>
          </div>
        )}

        {error && <div className="wp-error">{error}</div>}

        {/* ── Publish-to-cloud form (inline) ── */}
        {publishPath && (
          <div className="wp-publish-form">
            <p className="wp-publish-label">Cole a URL do repositório remoto:</p>
            <input
              className="wp-auth-input"
              placeholder="https://github.com/usuario/repo.git"
              value={publishUrl}
              onChange={(e) => setPublishUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handlePublish(); if (e.key === 'Escape') setPublishPath(null); }}
              autoFocus
            />
            {publishError && <div className="wp-auth-error">{publishError}</div>}
            <div className="wp-publish-actions">
              <button className="wp-publish-cancel" onClick={() => setPublishPath(null)}>Cancelar</button>
              <button className="wp-btn-action wp-btn-action--primary wp-btn-action--sm" onClick={handlePublish} disabled={publishBusy || !publishUrl.trim()}>
                {publishBusy ? 'Salvando…' : <><CloudArrowUp weight="thin" size={13} /> Publicar</>}
              </button>
            </div>
          </div>
        )}

        {/* ── Workspaces (merged) ── */}
        {hasAnyWorkspaces && (
          <div className="wp-recents">
            <div className="wp-recents-label">
              {userEmail
                ? <><Cloud weight="thin" size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Workspaces</>
                : 'Recent workspaces'}
            </div>

            {cloudLoading && <div className="wp-cloud-empty">Loading…</div>}

            {merged.map((entry) => {
              if (entry.type === 'synced') {
                const { cloud: cw, local: r } = entry;
                const uncom = uncommitted[r.path];
                return (
                  <button
                    key={r.path}
                    className="wp-recent-item wp-recent-item--synced"
                    onClick={() => handleOpenLocal(r)}
                    disabled={loading}
                  >
                    <div className="wp-recent-top">
                      <span className="wp-recent-name">{r.name}</span>
                      <div className="wp-badges">
                        {uncom != null && uncom > 0 && (
                          <span className="wp-recent-badge" title={`${uncom} uncommitted`}>{uncom}</span>
                        )}
                        <span className="wp-synced-badge" title={cw.gitUrl}>
                          <ArrowSquareOut weight="thin" size={9} /> synced
                        </span>
                      </div>
                    </div>
                    <div className="wp-recent-bottom">
                      <span className="wp-recent-path">{r.path}</span>
                      {r.lastEditedAt && <span className="wp-recent-time">{relativeTime(r.lastEditedAt)}</span>}
                    </div>
                  </button>
                );
              }

              if (entry.type === 'cloud-only') {
                const { cloud: cw } = entry;
                return (
                  <div key={cw.id ?? cw.gitUrl} className="wp-recent-item wp-recent-item--cloud-only">
                    <div className="wp-recent-top">
                      <span className="wp-recent-name">{cw.name}</span>
                      <span className="wp-git-badge" title={cw.gitUrl}><GitBranch weight="thin" size={9} /> git</span>
                    </div>
                    <div className="wp-recent-bottom">
                      <span className="wp-recent-path">{cw.gitUrl}</span>
                      <span className="wp-recent-time">{relativeTime(cw.addedAt)}</span>
                    </div>
                    <button
                      className="wp-action-btn"
                      onClick={() => handleClone(cw)}
                      disabled={cloneBusy === cw.gitUrl}
                    >
                      {cloneBusy === cw.gitUrl ? 'Clonando…' : 'Clonar'}
                    </button>
                  </div>
                );
              }

              if (entry.type === 'local-git') {
                const { local: r } = entry;
                const uncom = uncommitted[r.path];
                return (
                  <div key={r.path} className="wp-recent-item wp-recent-item--row">
                    <button
                      className="wp-recent-item-inner"
                      onClick={() => handleOpenLocal(r)}
                      disabled={loading}
                    >
                      <div className="wp-recent-top">
                        <span className="wp-recent-name">{r.name}</span>
                        <div className="wp-badges">
                          {uncom != null && uncom > 0 && (
                            <span className="wp-recent-badge" title={`${uncom} uncommitted`}>{uncom}</span>
                          )}
                          <span className="wp-git-badge" title={r.gitRemote}><GitBranch weight="thin" size={9} /> git</span>
                        </div>
                      </div>
                      <div className="wp-recent-bottom">
                        <span className="wp-recent-path">{r.path}</span>
                        {r.lastEditedAt && <span className="wp-recent-time">{relativeTime(r.lastEditedAt)}</span>}
                      </div>
                    </button>
                    {userEmail && (
                      <button
                        className="wp-action-btn"
                        onClick={() => handleRegisterLocalGit(r)}
                        disabled={registerBusy === r.path}
                        title="Registrar na nuvem"
                      >
                        {registerBusy === r.path
                          ? '…'
                          : <><CloudArrowUp weight="thin" size={11} /> Nuvem</>}
                      </button>
                    )}
                  </div>
                );
              }

              // local-nogit
              const { local: r } = entry;
              const uncom = uncommitted[r.path];
              return (
                <div key={r.path} className="wp-recent-item wp-recent-item--row">
                  <button
                    className="wp-recent-item-inner"
                    onClick={() => handleOpenLocal(r)}
                    disabled={loading}
                  >
                    <div className="wp-recent-top">
                      <span className="wp-recent-name">{r.name}</span>
                      <div className="wp-badges">
                        {uncom != null && uncom > 0 && (
                          <span className="wp-recent-badge" title={`${uncom} uncommitted`}>{uncom}</span>
                        )}
                        <span className="wp-local-badge"><CloudSlash weight="thin" size={10} style={{ verticalAlign: 'middle' }} /> local</span>
                      </div>
                    </div>
                    <div className="wp-recent-bottom">
                      <span className="wp-recent-path">{r.path}</span>
                      {r.lastEditedAt && <span className="wp-recent-time">{relativeTime(r.lastEditedAt)}</span>}
                    </div>
                  </button>
                  {userEmail && (
                    <button
                      className="wp-action-btn"
                      onClick={() => openPublishForm(r)}
                      title="Publicar na nuvem"
                    >
                      <CloudArrowUp weight="thin" size={11} /> Nuvem
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Account section ── */}
        <div className="wp-account-section">
          {userEmail ? (
            <div className="wp-account-signed-in">
              <span className="wp-account-email">{userEmail}</span>
              <button className="wp-account-signout" onClick={handleSignOut} title="Sign out">
                <SignOut weight="thin" size={13} /> Sair
              </button>
            </div>
          ) : (
            <>
              <button
                className="wp-account-signin-btn"
                onClick={() => { setAuthOpen((o) => !o); setAuthError(null); }}
              >
                <SignIn weight="thin" size={13} />
                {authOpen ? 'Cancelar' : 'Entrar na conta'}
              </button>

              {authOpen && (
                <div className="wp-auth-form">
                  <div className="wp-oauth-row">
                    <button className="wp-oauth-btn" onClick={() => handleOAuth('google')} disabled={oauthBusy !== null}>
                      {oauthBusy === 'google' ? 'Aguarde…' : (
                        <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Google</>
                      )}
                    </button>
                    <button className="wp-oauth-btn" onClick={() => handleOAuth('apple')} disabled={oauthBusy !== null}>
                      {oauthBusy === 'apple' ? 'Aguarde…' : (
                        <><svg width="14" height="14" viewBox="0 0 814 1000" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-122.1C203 599.3 168.7 471.5 168.7 347.9c0-208.3 135.7-318.2 269.8-318.2 71 0 130.3 46.8 174.8 46.8 42.8 0 109.7-50.5 193-50.5 30.9 0 110.6 2.6 170.3 65.4zm-237-olean 8.4-24.6 0 0-70.5 71.6c-37.2 0-67.1-24.3-67.1-66.3 0-40.6 29.9-66.5 67.1-66.5 37.5 0 70.5 25.9 70.5 67.5z"/></svg> Apple</>
                      )}
                    </button>
                  </div>

                  <div className="wp-auth-divider"><span>ou</span></div>

                  <div className="wp-auth-tabs">
                    <button className={`wp-auth-tab${authMode === 'login' ? ' wp-auth-tab--active' : ''}`} onClick={() => { setAuthMode('login'); setAuthError(null); }}>Entrar</button>
                    <button className={`wp-auth-tab${authMode === 'signup' ? ' wp-auth-tab--active' : ''}`} onClick={() => { setAuthMode('signup'); setAuthError(null); }}>Criar conta</button>
                  </div>
                  <input type="email" className="wp-auth-input" placeholder="seu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <input type="password" className="wp-auth-input" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleAuth(); }} />
                  {authError && <div className="wp-auth-error">{authError}</div>}
                  <button className="wp-btn-open" style={{ marginTop: 0 }} onClick={handleAuth} disabled={authBusy}>
                    {authBusy ? 'Aguarde…' : authMode === 'login' ? 'Entrar com e-mail' : 'Criar conta'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
