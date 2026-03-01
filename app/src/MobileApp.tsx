import { useState, useEffect, useCallback } from 'react';
import { Coffee, Folders, Eye, Robot, Microphone, ArrowDown, ArrowClockwise, SignOut, ArrowRight } from '@phosphor-icons/react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { loadWorkspace } from './services/workspace';
import { useAuthSession } from './hooks/useAuthSession';
import { gitClone, gitPull, gitSync, getGitAccountToken } from './services/syncConfig';
import { CONFIG_DIR } from './services/config';
import type { Workspace } from './types';
import MobileFileBrowser from './components/mobile/MobileFileBrowser';
import MobilePreview from './components/mobile/MobilePreview';
import MobileCopilot from './components/mobile/MobileCopilot';
import MobileVoiceMemo from './components/mobile/MobileVoiceMemo';
import ToastList from './components/mobile/ToastList';
import { useToast } from './hooks/useToast';
import './mobile.css';

type Tab = 'files' | 'preview' | 'copilot' | 'voice'

const LAST_WS_KEY = 'mobile-last-workspace-path';

/**
 * Strip the config dir suffix if it was accidentally stored.
 * e.g. ".../book/cafezin" → ".../book"
 */
function sanitizeWsPath(p: string): string {
  const suffix = `/${CONFIG_DIR}`;
  return p.endsWith(suffix) ? p.slice(0, -suffix.length) : p;
}

/** Transforma erros técnicos do libgit2 em mensagens legíveis em português. */

function friendlyGitError(err: unknown): string {
  const raw = String(err);
  if (/Certificate|host key|hostkey|ssh.*23|code=-17/i.test(raw))
    return 'Não foi possível verificar o servidor SSH. Verifique sua conexão.';
  if (/Authentication|credential|auth/i.test(raw))
    return 'Falha de autenticação. Verifique o token ou chave SSH.';
  if (/not found|repository not found|does not exist/i.test(raw))
    return 'Repositório não encontrado. Confira a URL.';
  if (/timed? ?out|Operation.*timed/i.test(raw))
    return 'Tempo limite esgotado. Verifique sua conexão.';
  if (/network|could not resolve|name or service not known/i.test(raw))
    return 'Sem conexão com o servidor git. Verifique o Wi-Fi.';
  // fallback: mostra só a primeira linha para não poluir o toast
  return raw.split('\n')[0].replace(/^Error: /i, '').slice(0, 120);
}

export default function MobileApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadingWs, setLoadingWs] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);

  // gitUrl → 'clone' | 'pull'
  const [gitBusy, setGitBusy] = useState<Record<string, 'clone' | 'pull'>>({});
  const [isSyncing, setIsSyncing] = useState(false);

  const [activeTab, setActiveTab] = useState<Tab>('files');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  // Form state — local only, not part of auth business logic
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  const { toasts, toast, dismiss } = useToast();

  const {
    isLoggedIn,
    oauthBusy,
    authBusy,
    authMode,
    setAuthMode,
    syncedWorkspaces,
    loadingSynced,
    syncError,
    loadSyncedList,
    handleAuth: _handleAuth,
    handleSignOut,
    handleOAuth: _handleOAuth,
  } = useAuthSession({
    onAuthSuccess: () => {
      toast({ message: 'Login realizado com sucesso!', type: 'success' });
    },
  });

  // Reload synced workspace list whenever auth state becomes active
  useEffect(() => {
    if (isLoggedIn) void loadSyncedList();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  // ── Bootstrap: load last workspace from localStorage ─────────────────────
  useEffect(() => {
    const raw = localStorage.getItem(LAST_WS_KEY);
    if (raw) {
      const lastPath = sanitizeWsPath(raw);
      // Self-heal: overwrite if we stripped a bad suffix
      if (lastPath !== raw) localStorage.setItem(LAST_WS_KEY, lastPath);
      void openWorkspacePath(lastPath);
      return;
    }
    setLoadingWs(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Wraps hook handleAuth with toast feedback for the mobile UI. */
  async function handleAuth() {
    const err = await _handleAuth(emailInput.trim(), passwordInput.trim());
    if (err) {
      toast({ message: err, type: 'error', duration: 6000 });
    } else {
      setEmailInput('');
      setPasswordInput('');
      void loadSyncedList();
    }
  }

  /** Wraps hook handleOAuth with toast feedback for the mobile UI. */
  async function handleOAuth(provider: 'google' | 'apple') {
    const err = await _handleOAuth(provider);
    if (err) toast({ message: err, type: 'error', duration: 6000 });
  }

  async function openWorkspacePath(rawPath: string) {
    const path = sanitizeWsPath(rawPath);
    setLoadingWs(true);
    setWsError(null);
    try {
      const ws = await loadWorkspace(path);
      setWorkspace(ws);
      localStorage.setItem(LAST_WS_KEY, path);
    } catch (err) {
      setWsError(`Could not open workspace: ${err}`);
    } finally {
      setLoadingWs(false);
    }
  }

  async function handleClone(gitUrl: string, accountLabel: string, branch?: string) {
    setGitBusy(b => ({ ...b, [gitUrl]: 'clone' }));
    try {
      const token = getGitAccountToken(accountLabel) ?? undefined;
      const localPath = await gitClone(gitUrl, token, branch || undefined);
      // Auto-pull after clone to ensure we're on the latest commit of the branch
      try {
        await gitPull(localPath, token);
      } catch { /* ignore pull errors on fresh clone */ }
      toast({ message: 'Repositório clonado e sincronizado!', type: 'success' });
      // Reload list so localPath shows up, then open
      await loadSyncedList();
      void openWorkspacePath(localPath);
    } catch (err) {
      toast({ message: `Erro ao clonar: ${friendlyGitError(err)}`, type: 'error', duration: null });
    } finally {
      setGitBusy(b => { const n = { ...b }; delete n[gitUrl]; return n; });
    }
  }

  async function handlePull(gitUrl: string, localPath: string, accountLabel: string) {
    setGitBusy(b => ({ ...b, [gitUrl]: 'pull' }));
    try {
      const token = getGitAccountToken(accountLabel) ?? undefined;
      const result = await gitPull(localPath, token);
      const msg = result === 'up_to_date' ? 'Já está atualizado.' : 'Pull realizado com sucesso!';
      toast({ message: msg, type: 'success' });
      void refreshWorkspace();
    } catch (err) {
      toast({ message: `Erro no pull: ${friendlyGitError(err)}`, type: 'error', duration: null });
    } finally {
      setGitBusy(b => { const n = { ...b }; delete n[gitUrl]; return n; });
    }
  }

  /**
   * Mobile sync: pull latest + commit & push local changes.
   * "Sync" para os leigos = pull + push.
   */
  async function handleSync() {
    if (!workspace) return;
    setIsSyncing(true);
    try {
      // Find the git account label for this workspace (match by localPath)
      const ws = syncedWorkspaces.find(w => w.localPath === workspace.path);
      const token = ws ? (getGitAccountToken(ws.gitAccountLabel) ?? undefined) : undefined;
      const result = await gitSync(workspace.path, token);
      const msg = result === 'synced' ? 'Sincronizado com sucesso!' : 'Já estava atualizado.';
      toast({ message: msg, type: 'success' });
      void refreshWorkspace();
    } catch (err) {
      toast({ message: `Erro ao sincronizar: ${friendlyGitError(err)}`, type: 'error', duration: null });
    } finally {
      setIsSyncing(false);
    }
  }



  // ── Refresh workspace file tree ──────────────────────────────────────────
  const refreshWorkspace = useCallback(async () => {
    if (!workspace) return;
    try {
      const ws = await loadWorkspace(workspace.path);
      setWorkspace(ws);
    } catch { /* not fatal */ }
  }, [workspace]);

  // ── File select ───────────────────────────────────────────────────────────
  async function handleFileSelect(relPath: string) {
    setOpenFile(relPath);
    setActiveTab('preview');
    // Pre-load content for Copilot context (text files only, max 8KB)
    if (workspace) {
      try {
        const absPath = `${workspace.path}/${relPath}`;
        const content = await readTextFile(absPath);
        setFileContent(content.slice(0, 20_000));
      } catch {
        setFileContent(null);
      }
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loadingWs) {
    return (
      <div className="mb-shell">
        <div className="mb-screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="mb-spinner" />
          <div style={{ marginTop: 16, color: 'var(--mb-muted)', fontSize: 14 }}>Loading workspace…</div>
        </div>
      </div>
    );
  }

  // ── No workspace: show connect screen ────────────────────────────────────
  if (!workspace) {
    // ── Not signed in — email + password form ────────────────────────────
    if (!isLoggedIn) {
      return (
        <div className="mb-shell">
          <ToastList toasts={toasts} onDismiss={dismiss} />
          <div className="mb-screen">
            <div className="mb-empty" style={{ flex: 1, gap: 20 }}>
              <div className="mb-empty-icon"><Coffee weight="thin" size={48} /></div>
              <div className="mb-empty-title">Bem-vindo ao Cafezin</div>
              <div className="mb-empty-desc">Entre com sua conta para acessar seus workspaces.</div>

              {/* ── OAuth providers ── */}
              <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 300 }}>
                <button
                  className="mb-btn mb-btn-secondary"
                  style={{ flex: 1, gap: 8, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => void handleOAuth('google')}
                  disabled={oauthBusy !== null}
                >
                  {oauthBusy === 'google'
                    ? <><div className="mb-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Aguarde</>  
                    : 'Google'
                  }
                </button>
                <button
                  className="mb-btn mb-btn-secondary"
                  style={{ flex: 1, gap: 8, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => void handleOAuth('apple')}
                  disabled={oauthBusy !== null}
                >
                  {oauthBusy === 'apple'
                    ? <><div className="mb-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Aguarde</>
                    : '\u{F8FF} Apple'
                  }
                </button>
              </div>

              {oauthBusy !== null && (
                <div style={{ fontSize: 12, color: 'var(--mb-muted)', textAlign: 'center', maxWidth: 300 }}>
                  Aguardando autorização no navegador…
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'rgba(255,255,255,0.3)', fontSize: 12, width: '100%', maxWidth: 300 }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
                ou
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
              </div>

              <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)', width: '100%', maxWidth: 300 }}>
                <button
                  className={`mb-btn ${authMode === 'login' ? 'mb-btn-primary' : 'mb-btn-ghost'}`}
                  style={{ flex: 1, borderRadius: 0, fontSize: 14 }}
                  onClick={() => { setAuthMode('login') }}
                >Entrar</button>
                <button
                  className={`mb-btn ${authMode === 'signup' ? 'mb-btn-primary' : 'mb-btn-ghost'}`}
                  style={{ flex: 1, borderRadius: 0, fontSize: 14 }}
                  onClick={() => { setAuthMode('signup') }}
                >Criar conta</button>
              </div>

              <input
                type="email"
                placeholder="seu@email.com"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                style={{
                  width: '100%', maxWidth: 300, padding: '10px 14px',
                  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 8, color: '#fff', fontSize: 15, outline: 'none',
                }}
              />
              <input
                type="password"
                placeholder="Senha"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAuth() }}
                style={{
                  width: '100%', maxWidth: 300, padding: '10px 14px',
                  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 8, color: '#fff', fontSize: 15, outline: 'none',
                }}
              />

              {authBusy && (
                <div style={{ fontSize: 12, color: 'var(--mb-muted)', textAlign: 'center', maxWidth: 300 }}>
                  Conectando…
                </div>
              )}

              <button
                className="mb-btn mb-btn-primary"
                style={{ width: '100%', maxWidth: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={() => void handleAuth()}
                disabled={authBusy || !emailInput.trim() || !passwordInput.trim()}
              >
                {authBusy
                  ? <><div className="mb-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Aguarde…</>
                  : authMode === 'login' ? 'Entrar com e-mail' : 'Criar conta'
                }
              </button>
            </div>
          </div>
        </div>
      )
    }

    // ── Signed in — show workspace list ───────────────────────────────────
    return (
      <div className="mb-shell">
        <ToastList toasts={toasts} onDismiss={dismiss} />
        <div className="mb-screen">
          <div className="mb-empty" style={{ flex: 1 }}>
            <div className="mb-empty-icon"><Folders weight="thin" size={48} /></div>
            <div className="mb-empty-title">Workspaces</div>

            {wsError && (
              <div style={{ background: 'rgba(224,108,117,0.15)', border: '1px solid rgba(224,108,117,0.3)', color: 'var(--mb-danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, maxWidth: 300 }}>
                {wsError}
              </div>
            )}

            {syncError && (
              <div style={{ background: 'rgba(224,108,117,0.15)', border: '1px solid rgba(224,108,117,0.3)', color: 'var(--mb-danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, maxWidth: 300 }}>
                Could not load workspaces: {syncError}
              </div>
            )}

            {loadingSynced && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--mb-muted)', fontSize: 13 }}>
                <div className="mb-spinner" style={{ width: 16, height: 16 }} />
                Loading workspaces…
              </div>
            )}

            {!loadingSynced && syncedWorkspaces.length > 0 && (
              <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {syncedWorkspaces.map(ws => {
                  const canOpen = !!ws.localPath;
                  const busy = gitBusy[ws.gitUrl];
                  return (
                    <div
                      key={ws.gitUrl}
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 12,
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{ws.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--mb-muted)', wordBreak: 'break-all' }}>{ws.gitUrl}</div>
                      {canOpen ? (
                        <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                          <button
                            className="mb-btn mb-btn-primary"
                            style={{ flex: 1, fontSize: 13, padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            onClick={() => openWorkspacePath(ws.localPath!)}
                            disabled={!!busy}
                          >
                            <ArrowRight size={14} /> Abrir
                          </button>
                          <button
                            className="mb-btn mb-btn-secondary"
                            style={{ fontSize: 13, padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            onClick={() => void handlePull(ws.gitUrl, ws.localPath!, ws.gitAccountLabel)}
                            disabled={!!busy}
                          >
                            {busy === 'pull'
                              ? <><div className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Pull…</>
                              : <><ArrowDown size={14} /> Pull</>
                            }
                          </button>
                        </div>
                      ) : (
                        <button
                          className="mb-btn mb-btn-secondary"
                          style={{ marginTop: 6, fontSize: 13, padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onClick={() => void handleClone(ws.gitUrl, ws.gitAccountLabel, ws.branch)}
                          disabled={!!busy}
                        >
                          {busy === 'clone'
                            ? <><div className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Clonando…</>
                            : <><ArrowDown size={14} /> Clonar</>
                          }
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!loadingSynced && syncedWorkspaces.length === 0 && !syncError && (
              <div className="mb-empty-desc">No workspaces registered yet. Open Settings → Sync on your desktop to register one.</div>
            )}

            <button
              className="mb-btn mb-btn-ghost"
              style={{ marginTop: 4, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={loadSyncedList}
            >
              <ArrowClockwise size={15} /> Atualizar
            </button>

            <button
              className="mb-btn mb-btn-ghost"
              style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => void handleSignOut()}
            >
              <SignOut size={14} /> Sair da conta
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main app ──────────────────────────────────────────────────────────────
  function renderTab() {
    switch (activeTab) {
      case 'files':
        return (
          <MobileFileBrowser
            workspaceName={workspace!.name}
            fileTree={workspace!.fileTree}
            selectedPath={openFile ?? undefined}
            onFileSelect={handleFileSelect}
            onRefresh={refreshWorkspace}
            hasGit={workspace!.hasGit}
            onSync={handleSync}
            isSyncing={isSyncing}
          />
        );

      case 'preview':
        if (!openFile) {
          return (
            <div className="mb-preview-empty">
              <div className="mb-preview-no-file"><Eye weight="thin" size={40} /></div>
              <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                Select a file from Files to preview it here.
              </div>
            </div>
          );
        }
        return (
          <MobilePreview
            workspacePath={workspace!.path}
            filePath={openFile}
            onClear={() => setOpenFile(null)}
          />
        );

      case 'copilot':
        return (
          <MobileCopilot
            workspace={workspace}
            contextFilePath={openFile ?? undefined}
            contextFileContent={fileContent ?? undefined}
            onFileWritten={refreshWorkspace}
          />
        );

      case 'voice':
        return <MobileVoiceMemo workspacePath={workspace!.path} />;
    }
  }

  return (
    <div className="mb-shell">
      <ToastList toasts={toasts} onDismiss={dismiss} />
      <div className="mb-screen">
        {renderTab()}
      </div>

      <nav className="mb-tabbar">
        <button
          className={`mb-tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          <span className="mb-tab-icon"><Folders weight="thin" size={22} /></span>
          <span className="mb-tab-label">Arquivos</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'preview' ? 'active' : ''}`}
          onClick={() => setActiveTab('preview')}
        >
          <span className="mb-tab-icon"><Eye weight="thin" size={22} /></span>
          <span className="mb-tab-label">Preview</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'copilot' ? 'active' : ''}`}
          onClick={() => setActiveTab('copilot')}
        >
          <span className="mb-tab-icon"><Robot weight="thin" size={22} /></span>
          <span className="mb-tab-label">Copilot</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'voice' ? 'active' : ''}`}
          onClick={() => setActiveTab('voice')}
        >
          <span className="mb-tab-icon"><Microphone weight="thin" size={22} /></span>
          <span className="mb-tab-label">Voz</span>
        </button>
      </nav>
    </div>
  );
}
