import { useState } from 'react';
import { pickWorkspaceFolder, loadWorkspace, createFile, refreshFiles } from '../services/workspace';
import type { Workspace } from '../types';
import './Sidebar.css';

interface SidebarProps {
  workspace: Workspace;
  activeFile: string | null;
  onFileSelect: (filename: string) => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onFilesChange: (files: string[]) => void;
  onUpdate: () => void;
  updating: 'idle' | 'building' | 'error';
  updateError: string | null;
}

export default function Sidebar({
  workspace,
  activeFile,
  onFileSelect,
  onWorkspaceChange,
  onFilesChange,
  onUpdate,
  updating,
  updateError,
}: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  async function handleNewFile() {
    if (!newFileName.trim()) return;
    const name = newFileName.trim().endsWith('.md')
      ? newFileName.trim()
      : `${newFileName.trim()}.md`;
    await createFile(workspace, name);
    const files = await refreshFiles(workspace);
    onFilesChange(files);
    setCreating(false);
    setNewFileName('');
    onFileSelect(name);
  }

  async function handleOpenWorkspace() {
    const path = await pickWorkspaceFolder();
    if (!path) return;
    const ws = await loadWorkspace(path);
    onWorkspaceChange(ws);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-workspace-name" title={workspace.path}>
          {workspace.name}
        </span>
        {workspace.agentContext ? (
          <span className="sidebar-agent-badge" title="AGENT.md found — loaded as AI context">
            ✦
          </span>
        ) : null}
      </div>

      <div className="sidebar-files">
        {workspace.files.map((file) => (
          <button
            key={file}
            className={`sidebar-file ${activeFile === file ? 'active' : ''}`}
            onClick={() => onFileSelect(file)}
          >
            <span className="sidebar-file-icon">◎</span>
            {file.replace(/\.md$/, '')}
          </button>
        ))}

        {workspace.files.length === 0 && (
          <div className="sidebar-empty">No .md files yet</div>
        )}
      </div>

      <div className="sidebar-footer">
        {creating ? (
          <div className="sidebar-new-file-form">
            <input
              autoFocus
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="filename.md"
              className="sidebar-new-file-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewFile();
                if (e.key === 'Escape') { setCreating(false); setNewFileName(''); }
              }}
            />
            <button className="sidebar-btn-confirm" onClick={handleNewFile}>✓</button>
          </div>
        ) : (
          <button className="sidebar-btn" onClick={() => setCreating(true)}>+ New file</button>
        )}
        <button className="sidebar-btn sidebar-btn-folder" onClick={handleOpenWorkspace}>
          ⊘ Switch workspace
        </button>
        <button
          className={`sidebar-btn sidebar-btn-update ${updating === 'building' ? 'loading' : ''}`}
          onClick={onUpdate}
          disabled={updating === 'building'}
          title={updateError ?? 'Rebuild and reinstall the app (⌘⇧U)'}
        >
          {updating === 'building' ? '⟳ Building…' : updating === 'error' ? '⚠ Update failed' : '↑ Update app'}
        </button>
      </div>
    </aside>
  );
}
