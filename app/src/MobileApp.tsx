import { useState, useEffect, useCallback } from 'react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { loadWorkspace } from './services/workspace';
import {
  listSyncedWorkspaces,
  getSyncAccountToken,
  startSyncAccountFlow,
  clearSyncAccountToken,
} from './services/syncConfig';
import type { SyncedWorkspace, SyncDeviceFlowState } from './services/syncConfig';
import type { Workspace } from './types';
import MobileFileBrowser from './components/mobile/MobileFileBrowser';
import MobilePreview from './components/mobile/MobilePreview';
import MobileCopilot from './components/mobile/MobileCopilot';
import './mobile.css';

type Tab = 'files' | 'preview' | 'copilot';
type AuthStep = 'idle' | 'waiting_code' | 'polling' | 'done' | 'error';

const LAST_WS_KEY = 'mobile-last-workspace-path';

export default function MobileApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadingWs, setLoadingWs] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>('files');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  // Sync workspace list (optional, shown when no workspace loaded)
  const [syncedWorkspaces, setSyncedWorkspaces] = useState<SyncedWorkspace[]>([]);
  const [loadingSynced, setLoadingSynced] = useState(false);

  // GitHub device-flow auth state
  const [authStep, setAuthStep] = useState<AuthStep>('idle');
  const [deviceFlow, setDeviceFlow] = useState<SyncDeviceFlowState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!getSyncAccountToken());

  // ── Bootstrap: load last workspace from localStorage ─────────────────────
  useEffect(() => {
    const lastPath = localStorage.getItem(LAST_WS_KEY);
    if (lastPath) {
      openWorkspacePath(lastPath);
    } else {
      setLoadingWs(false);
      if (getSyncAccountToken()) {
        setIsLoggedIn(true);
        loadSyncedList();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function loadSyncedList() {
    const token = getSyncAccountToken();
    if (!token) return;
    setLoadingSynced(true);
    try {
      const list = await listSyncedWorkspaces();
      setSyncedWorkspaces(list);
    } catch { /* not fatal */ }
    finally { setLoadingSynced(false); }
  }

  // ── GitHub device-flow login ───────────────────────────────────────────────
  async function startLogin() {
    setAuthError(null);
    setAuthStep('waiting_code');
    try {
      await startSyncAccountFlow((state: SyncDeviceFlowState) => {
        setDeviceFlow(state);
        setAuthStep('polling');
      });
      // Token is now stored by startSyncAccountFlow
      setIsLoggedIn(true);
      setAuthStep('done');
      loadSyncedList();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
      setAuthStep('error');
    }
  }

  function cancelLogin() {
    setAuthStep('idle');
    setDeviceFlow(null);
    setAuthError(null);
  }

  function signOut() {
    clearSyncAccountToken();
    setIsLoggedIn(false);
    setSyncedWorkspaces([]);
    setAuthStep('idle');
    setDeviceFlow(null);
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
    // ── Device flow in progress ──────────────────────────────────────────
    if (authStep === 'polling' && deviceFlow) {
      return (
        <div className="mb-shell">
          <div className="mb-screen">
            <div className="mb-empty" style={{ flex: 1, gap: 20 }}>
              <div className="mb-empty-icon">🔑</div>
              <div className="mb-empty-title">Authorize on GitHub</div>
              <div className="mb-empty-desc">Copy the code below, then tap Open GitHub. Enter the code on the page that opens.</div>

              {/* Code display */}
              <div style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: '14px 28px',
                fontFamily: 'monospace',
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: 6,
                color: '#fff',
              }}>
                {deviceFlow.userCode}
              </div>

              <button
                className="mb-btn mb-btn-primary"
                style={{ width: '100%', maxWidth: 300 }}
                onClick={() => openUrl(deviceFlow.verificationUri)}
              >
                Open GitHub →
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--mb-muted)', fontSize: 13 }}>
                <div className="mb-spinner" style={{ width: 16, height: 16 }} />
                Waiting for authorization…
              </div>

              <button className="mb-btn mb-btn-ghost" style={{ fontSize: 13 }} onClick={cancelLogin}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ── Auth error ────────────────────────────────────────────────────────
    if (authStep === 'error') {
      return (
        <div className="mb-shell">
          <div className="mb-screen">
            <div className="mb-empty" style={{ flex: 1 }}>
              <div className="mb-empty-icon">⚠️</div>
              <div className="mb-empty-title">Sign in failed</div>
              <div style={{
                background: 'rgba(224,108,117,0.15)',
                border: '1px solid rgba(224,108,117,0.3)',
                color: 'var(--mb-danger)',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
                maxWidth: 300,
                textAlign: 'center',
              }}>
                {authError}
              </div>
              <button className="mb-btn mb-btn-primary" style={{ width: '100%', maxWidth: 300 }} onClick={startLogin}>
                Try Again
              </button>
              <button className="mb-btn mb-btn-ghost" style={{ fontSize: 13 }} onClick={cancelLogin}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ── Not signed in ─────────────────────────────────────────────────────
    if (!isLoggedIn) {
      return (
        <div className="mb-shell">
          <div className="mb-screen">
            <div className="mb-empty" style={{ flex: 1, gap: 20 }}>
              <div className="mb-empty-icon">☕</div>
              <div className="mb-empty-title">Welcome to Cafezin</div>
              <div className="mb-empty-desc">Sign in with your GitHub account to access workspaces you've registered on your desktop.</div>
              <button
                className="mb-btn mb-btn-primary"
                style={{ width: '100%', maxWidth: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={startLogin}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                Sign in with GitHub
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ── Signed in — show workspace list ───────────────────────────────────
    return (
      <div className="mb-shell">
        <div className="mb-screen">
          <div className="mb-empty" style={{ flex: 1 }}>
            <div className="mb-empty-icon">🗂</div>
            <div className="mb-empty-title">No workspace open</div>
            {wsError && (
              <div style={{ background: 'rgba(224,108,117,0.15)', border: '1px solid rgba(224,108,117,0.3)', color: 'var(--mb-danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, maxWidth: 300 }}>
                {wsError}
              </div>
            )}

            {loadingSynced && <div className="mb-spinner" />}

            {syncedWorkspaces.length > 0 ? (
              <>
                <div className="mb-empty-desc">Open a synced workspace:</div>
                {syncedWorkspaces.map(ws => (
                  <button
                    key={ws.gitUrl}
                    className="mb-btn mb-btn-ghost"
                    style={{ width: '100%', maxWidth: 320, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
                    onClick={() => openWorkspacePath(ws.localPath ?? ws.name)}
                  >
                    <span style={{ fontWeight: 600 }}>{ws.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--mb-muted)' }}>{ws.gitUrl}</span>
                  </button>
                ))}
              </>
            ) : !loadingSynced ? (
              <>
                <div className="mb-empty-desc">No workspaces found. Open the Settings → Sync tab on your desktop to register your workspace.</div>
                <button className="mb-btn mb-btn-ghost" onClick={loadSyncedList}>
                  Check again
                </button>
              </>
            ) : null}

            <button
              className="mb-btn mb-btn-ghost"
              style={{ fontSize: 12, color: 'var(--mb-muted)', marginTop: 8 }}
              onClick={signOut}
            >
              Sign out
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
    }
  }

  return (
    <div className="mb-shell">
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
      </nav>
    </div>
  );
}
