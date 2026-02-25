import { useState, useEffect } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { pickWorkspaceFolder, loadWorkspace, getRecents, removeRecent } from '../services/workspace';
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

interface WorkspacePickerProps {
  onOpen: (workspace: Workspace) => void;
}

export default function WorkspacePicker({ onOpen }: WorkspacePickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recents: RecentWorkspace[] = getRecents();
  // uncommittedCount per workspace path, null = still loading
  const [uncommitted, setUncommitted] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (recents.length === 0) return;
    // Seed all as null (loading)
    setUncommitted(Object.fromEntries(recents.map((r) => [r.path, null])));
    recents.forEach((r) => {
      invoke<{ files: string[] }>('git_diff', { path: r.path })
        .then((res) => setUncommitted((prev) => ({ ...prev, [r.path]: res.files.length })))
        .catch(() => setUncommitted((prev) => ({ ...prev, [r.path]: 0 })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function handleRecent(recent: RecentWorkspace) {
    setError(null);
    setLoading(true);
    try {
      const workspace = await loadWorkspace(recent.path);
      onOpen(workspace);
    } catch (err) {
      setError(`Could not open "${recent.name}": ${err}`);
      removeRecent(recent.path);
      setLoading(false);
    }
  }

  return (
    <div className="wp-overlay">
      <div className="wp-card">
        <h1 className="wp-welcome">Welcome!</h1>
        <div className="wp-logo">✦</div>
        <h1 className="wp-title">Cafezin</h1>
        <p className="wp-tagline">Just Chilling</p>
        <p className="wp-subtitle">Open a folder to begin. Each folder is an independent workspace with its own git history.</p>

        <button className="wp-btn-open" onClick={handlePick} disabled={loading}>
          {loading ? 'Opening…' : <><FolderOpen weight="thin" size={15} /> Open Folder</>}
        </button>

        {error && <div className="wp-error">{error}</div>}

        {recents.length > 0 && (
          <div className="wp-recents">
            <div className="wp-recents-label">Recent workspaces</div>
            {recents.map((r) => (
              <button
                key={r.path}
                className="wp-recent-item"
                onClick={() => handleRecent(r)}
                disabled={loading}
              >
                <div className="wp-recent-top">
                  <span className="wp-recent-name">{r.name}</span>
                  {uncommitted[r.path] != null && uncommitted[r.path]! > 0 && (
                    <span className="wp-recent-badge" title={`${uncommitted[r.path]} uncommitted file${uncommitted[r.path] !== 1 ? 's' : ''}`}>
                      {uncommitted[r.path]}
                    </span>
                  )}
                </div>
                <div className="wp-recent-bottom">
                  <span className="wp-recent-path">{r.path}</span>
                  {r.lastEditedAt && (
                    <span className="wp-recent-time">{relativeTime(r.lastEditedAt)}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
