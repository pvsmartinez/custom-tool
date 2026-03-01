import { useState, useEffect, useCallback } from 'react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { loadWorkspace } from './services/workspace';
import { useAuthSession } from './hooks/useAuthSession';
import { gitClone, gitPull, getGitAccountToken } from './services/syncConfig';
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

export default function MobileApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadingWs, setLoadingWs] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);

  // gitUrl → 'clone' | 'pull'
  const [gitBusy, setGitBusy] = useState<Record<string, 'clone' | 'pull'>>({});

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
    const lastPath = localStorage.getItem(LAST_WS_KEY);
    if (lastPath) {
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

  async function openWorkspacePath(path: string) {
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

  async function handleClone(gitUrl: string, accountLabel: string) {
    setGitBusy(b => ({ ...b, [gitUrl]: 'clone' }));
    try {
      const token = getGitAccountToken(accountLabel) ?? undefined;
      const localPath = await gitClone(gitUrl, token);
      toast({ message: 'Repositório clonado!', type: 'success' });
      // Reload list so localPath shows up, then open
      await loadSyncedList();
      void openWorkspacePath(localPath);
    } catch (err) {
      toast({ message: `Erro ao clonar: ${err}`, type: 'error', duration: 8000 });
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
      toast({ message: `Erro no pull: ${err}`, type: 'error', duration: 8000 });
    } finally {
      setGitBusy(b => { const n = { ...b }; delete n[gitUrl]; return n; });
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
              <div className="mb-empty-icon">☕</div>
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
      <div className="mb-shell">        <ToastList toasts={toasts} onDismiss={dismiss} />        <div className="mb-screen">
          <div className="mb-empty" style={{ flex: 1 }}>
            <div className="mb-empty-icon">🗂</div>
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
                            Abrir →
                          </button>
                          <button
                            className="mb-btn mb-btn-secondary"
                            style={{ fontSize: 13, padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            onClick={() => void handlePull(ws.gitUrl, ws.localPath!, ws.gitAccountLabel)}
                            disabled={!!busy}
                          >
                            {busy === 'pull'
                              ? <><div className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Pull…</>
                              : '↓ Pull'
                            }
                          </button>
                        </div>
                      ) : (
                        <button
                          className="mb-btn mb-btn-secondary"
                          style={{ marginTop: 6, fontSize: 13, padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onClick={() => void handleClone(ws.gitUrl, ws.gitAccountLabel)}
                          disabled={!!busy}
                        >
                          {busy === 'clone'
                            ? <><div className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Clonando…</>
                            : '↓ Clonar'
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
              style={{ marginTop: 4, fontSize: 14 }}
              onClick={loadSyncedList}
            >
              ↻ Refresh
            </button>

            <button
              className="mb-btn mb-btn-ghost"
              style={{ fontSize: 12, color: 'var(--mb-muted)' }}
              onClick={() => void handleSignOut()}
            >
              Sair da conta
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
          />
        );

      case 'preview':
        if (!openFile) {
          return (
            <div className="mb-preview-empty">
              <div className="mb-preview-no-file">👁</div>
              <div style={{ color: 'var(--mb-muted)', fontSize: 14 }}>
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
          <span className="mb-tab-icon">🗂</span>
          <span className="mb-tab-label">Files</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'preview' ? 'active' : ''}`}
          onClick={() => setActiveTab('preview')}
        >
          <span className="mb-tab-icon">👁</span>
          <span className="mb-tab-label">Preview</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'copilot' ? 'active' : ''}`}
          onClick={() => setActiveTab('copilot')}
        >
          <span className="mb-tab-icon">🤖</span>
          <span className="mb-tab-label">Copilot</span>
        </button>
        <button
          className={`mb-tab ${activeTab === 'voice' ? 'active' : ''}`}
          onClick={() => setActiveTab('voice')}
        >
          <span className="mb-tab-icon">🎙</span>
          <span className="mb-tab-label">Voice</span>
        </button>
      </nav>
    </div>
  );
}
