import { useState, useEffect, useCallback } from 'react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { loadWorkspace } from './services/workspace';
import { listSyncedWorkspaces, getSyncAccountToken } from './services/syncConfig';
import type { SyncedWorkspace } from './services/syncConfig';
import type { Workspace } from './types';
import MobileFileBrowser from './components/mobile/MobileFileBrowser';
import MobilePreview from './components/mobile/MobilePreview';
import MobileCopilot from './components/mobile/MobileCopilot';
import './mobile.css';

type Tab = 'files' | 'preview' | 'copilot';

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

  // ── Bootstrap: load last workspace from localStorage ─────────────────────
  useEffect(() => {
    const lastPath = localStorage.getItem(LAST_WS_KEY);
    if (lastPath) {
      openWorkspacePath(lastPath);
    } else {
      setLoadingWs(false);
      loadSyncedList();
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
        setFileContent(content.slice(0, 8000));
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
            <div className="mb-empty-desc">
              {syncedWorkspaces.length > 0
                ? 'Open a synced workspace below, or connect a new one through the desktop app.'
                : 'Open the Settings → Sync tab on your desktop to register your workspace, then come back here.'}
            </div>

            {/* Synced workspace list */}
            {loadingSynced && <div className="mb-spinner" />}
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

            {syncedWorkspaces.length === 0 && !loadingSynced && (
              <button className="mb-btn mb-btn-ghost" onClick={loadSyncedList}>
                Check for synced workspaces
              </button>
            )}
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
