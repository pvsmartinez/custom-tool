import { useState } from 'react';
import { pickWorkspaceFolder, loadWorkspace, getRecents, removeRecent } from '../services/workspace';
import type { Workspace, RecentWorkspace } from '../types';
import './WorkspacePicker.css';

interface WorkspacePickerProps {
  onOpen: (workspace: Workspace) => void;
}

export default function WorkspacePicker({ onOpen }: WorkspacePickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recents: RecentWorkspace[] = getRecents();

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
        <div className="wp-logo">✦</div>
        <h1 className="wp-title">custom-tool</h1>
        <p className="wp-subtitle">Open a folder to begin. Each folder is an independent workspace with its own git history.</p>

        <button className="wp-btn-open" onClick={handlePick} disabled={loading}>
          {loading ? 'Opening…' : '⊕ Open Folder'}
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
                <span className="wp-recent-name">{r.name}</span>
                <span className="wp-recent-path">{r.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
