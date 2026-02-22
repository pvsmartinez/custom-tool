import { useState, useCallback } from 'react';
import { pickWorkspaceFolder, loadWorkspace, createFile, refreshFiles, refreshFileTree } from '../services/workspace';
import type { Workspace, FileTreeNode } from '../types';
import './Sidebar.css';

// ── File-type icon helper ───────────────────────────────────────────────────
function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'mdx'].includes(ext)) return '◎';
  if (['ts', 'tsx'].includes(ext)) return 'TS';
  if (['js', 'jsx', 'mjs'].includes(ext)) return 'JS';
  if (['json', 'jsonc'].includes(ext)) return '{}';
  if (['css', 'scss', 'less'].includes(ext)) return '#';
  if (['html', 'htm'].includes(ext)) return '<>';
  if (['rs'].includes(ext)) return '⛭';
  if (['toml', 'yaml', 'yml'].includes(ext)) return '≡';
  if (['sh', 'bash', 'zsh'].includes(ext)) return '$_';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '⬡';
  return '·';
}

// ── Recursive tree node ─────────────────────────────────────────────────────
interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  activeFile: string | null;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileSelect: (path: string) => void;
}

function TreeNodeItem({ node, depth, activeFile, expandedDirs, onToggleDir, onFileSelect }: TreeNodeProps) {
  const indent = 8 + depth * 14;

  if (node.isDirectory) {
    const isExpanded = expandedDirs.has(node.path);
    return (
      <>
        <button
          className="sidebar-tree-row sidebar-tree-dir"
          style={{ paddingLeft: indent }}
          onClick={() => onToggleDir(node.path)}
          title={node.path}
        >
          <span className="sidebar-tree-arrow">{isExpanded ? '▾' : '▸'}</span>
          <span className="sidebar-tree-icon sidebar-tree-icon--dir">⊟</span>
          <span className="sidebar-tree-name">{node.name}</span>
        </button>
        {isExpanded && node.children?.map((child) => (
          <TreeNodeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onFileSelect={onFileSelect}
          />
        ))}
      </>
    );
  }

  return (
    <button
      className={`sidebar-tree-row sidebar-tree-file ${activeFile === node.path ? 'active' : ''}`}
      style={{ paddingLeft: indent + 16 }}
      onClick={() => onFileSelect(node.path)}
      title={node.path}
    >
      <span className="sidebar-tree-icon">{fileIcon(node.name)}</span>
      <span className="sidebar-tree-name">{node.name}</span>
    </button>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
interface SidebarProps {
  workspace: Workspace;
  activeFile: string | null;
  onFileSelect: (filename: string) => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onFilesChange: (files: string[]) => void;
  onUpdate: () => void;
}

export default function Sidebar({
  workspace,
  activeFile,
  onFileSelect,
  onWorkspaceChange,
  onFilesChange: _onFilesChange,
  onUpdate,
}: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  // Start with root-level directories expanded
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    workspace.fileTree.forEach((n) => { if (n.isDirectory) initial.add(n.path); });
    return initial;
  });

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  async function handleNewFile() {
    if (!newFileName.trim()) return;
    const name = newFileName.trim().endsWith('.md')
      ? newFileName.trim()
      : `${newFileName.trim()}.md`;
    await createFile(workspace, name);
    const [files, fileTree] = await Promise.all([
      refreshFiles(workspace),
      refreshFileTree(workspace),
    ]);
    onWorkspaceChange({ ...workspace, files, fileTree });
    setCreating(false);
    setNewFileName('');
    onFileSelect(name);
  }

  async function handleOpenWorkspace() {
    const path = await pickWorkspaceFolder();
    if (!path) return;
    const ws = await loadWorkspace(path);
    setExpandedDirs(() => {
      const s = new Set<string>();
      ws.fileTree.forEach((n) => { if (n.isDirectory) s.add(n.path); });
      return s;
    });
    onWorkspaceChange(ws);
  }

  return (
    <aside className="sidebar">
      {/* Header */}
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

      {/* Explorer label */}
      <div className="sidebar-explorer-label">EXPLORER</div>

      {/* File tree */}
      <div className="sidebar-files">
        {workspace.fileTree.length === 0 && (
          <div className="sidebar-empty">No files yet</div>
        )}
        {workspace.fileTree.map((node) => (
          <TreeNodeItem
            key={node.path}
            node={node}
            depth={0}
            activeFile={activeFile}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            onFileSelect={onFileSelect}
          />
        ))}
      </div>

      {/* Footer actions */}
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
          className="sidebar-btn sidebar-btn-update"
          onClick={onUpdate}
          title="Rebuild and reinstall the app (⌘⇧U)"
        >
          ↑ Update app
        </button>
      </div>
    </aside>
  );
}

