import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createFile, createCanvasFile, createFolder, refreshFiles, refreshFileTree, deleteFile, duplicateFile } from '../services/workspace';
import SyncModal from './SyncModal';
import type { Workspace, FileTreeNode, AIEditMark } from '../types';
import './Sidebar.css';

// ── File-type icon helper ───────────────────────────────────────────────────
function fileIcon(name: string): string {
  if (name.endsWith('.tldr.json')) return '◈';
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
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi'].includes(ext)) return '▶';
  if (ext === 'gif') return 'GIF';
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif'].includes(ext)) return '⬡';
  return '·';
}

// ── Editable file types for the create picker ──────────────────────────────
const EDITABLE_TYPES = [
  { ext: '.md',   label: 'MD' },
  { ext: '.ts',   label: 'TS' },
  { ext: '.tsx',  label: 'TSX' },
  { ext: '.js',   label: 'JS' },
  { ext: '.json', label: 'JSON' },
  { ext: '.css',  label: 'CSS' },
  { ext: '.html', label: 'HTML' },
  { ext: '.py',   label: 'PY' },
  { ext: '.sh',   label: 'SH' },
  { ext: '.txt',  label: 'TXT' },
];

// ── Recursive tree node ─────────────────────────────────────────────────────
interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  activeFile: string | null;
  dirtyFiles: Set<string>;
  unseenAiFiles: Set<string>;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileSelect: (path: string) => void;
  onStartCreate: (inPath: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onDeleteFile: (path: string) => void;
  onDuplicateFile: (path: string) => void;
}

const DRAGGABLE_IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','avif','bmp','ico','tiff','tif']);

function TreeNodeItem({ node, depth, activeFile, dirtyFiles, unseenAiFiles, expandedDirs, onToggleDir, onFileSelect, onStartCreate, onContextMenu, onDeleteFile, onDuplicateFile }: TreeNodeProps) {
  const indent = 8 + depth * 14;

  if (node.isDirectory) {
    const isExpanded = expandedDirs.has(node.path);
    return (
      <>
        <button
          className="sidebar-tree-row sidebar-tree-dir"
          style={{ paddingLeft: indent }}
          onClick={() => onToggleDir(node.path)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
          title={node.path}
        >
          <span className="sidebar-tree-arrow">{isExpanded ? '▾' : '▸'}</span>
          <span className="sidebar-tree-icon sidebar-tree-icon--dir">⊟</span>
          <span className="sidebar-tree-name">{node.name}</span>
          <span
            className="sidebar-tree-action"
            role="button"
            title={`New file in ${node.name}`}
            onClick={(e) => { e.stopPropagation(); onStartCreate(node.path); }}
          >+</span>
        </button>
        {isExpanded && node.children?.map((child) => (
          <TreeNodeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            dirtyFiles={dirtyFiles}
            unseenAiFiles={unseenAiFiles}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onFileSelect={onFileSelect}
            onStartCreate={onStartCreate}
            onContextMenu={onContextMenu}
            onDeleteFile={onDeleteFile}
            onDuplicateFile={onDuplicateFile}
          />
        ))}
      </>
    );
  }

  const isDirty = dirtyFiles.has(node.path);
  const hasUnseenAi = unseenAiFiles.has(node.path);
  const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = DRAGGABLE_IMAGE_EXTS.has(ext);

  return (
    <button
      className={`sidebar-tree-row sidebar-tree-file ${activeFile === node.path ? 'active' : ''}${hasUnseenAi ? ' unseen-ai' : ''}${isImage ? ' draggable-image' : ''}`}
      style={{ paddingLeft: indent + 16 }}
      draggable={isImage}
      onDragStart={isImage ? (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/x-workspace-file', node.path);
        // Ghost label
        const ghost = document.createElement('div');
        ghost.textContent = node.name;
        ghost.style.cssText = 'position:fixed;top:-200px;background:#282c34;color:#abb2bf;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid #3e4451;pointer-events:none';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        requestAnimationFrame(() => document.body.removeChild(ghost));
      } : undefined}
      onClick={() => onFileSelect(node.path)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, false); }}
      title={isImage ? `${node.path}\nDrag to canvas to add as image` : node.path}
    >
      <span className="sidebar-tree-icon">{fileIcon(node.name)}</span>
      <span className="sidebar-tree-name">{node.name}</span>
      {hasUnseenAi && <span className="sidebar-ai-dot" title="Unseen AI edits" />}
      {isDirty && <span className="sidebar-dirty-dot" title="Unsaved changes" />}
      <span className="sidebar-file-actions" onClick={(e) => e.stopPropagation()}>
        <span
          role="button"
          className="sidebar-file-action"
          title="Duplicate"
          onClick={() => onDuplicateFile(node.path)}
          onKeyDown={(e) => e.key === 'Enter' && onDuplicateFile(node.path)}
          tabIndex={0}
        >⧉</span>
        <span
          role="button"
          className="sidebar-file-action sidebar-file-action--delete"
          title="Delete"
          onClick={() => onDeleteFile(node.path)}
          onKeyDown={(e) => e.key === 'Enter' && onDeleteFile(node.path)}
          tabIndex={0}
        >✕</span>
      </span>
    </button>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
interface SidebarProps {
  workspace: Workspace;
  activeFile: string | null;
  dirtyFiles: Set<string>;
  aiMarks: AIEditMark[];
  /** Number of unreviewed AI marks in the active file */
  aiNavCount: number;
  /** Currently focused AI mark index (0-based) */
  aiNavIndex: number;
  style?: React.CSSProperties;
  onFileSelect: (filename: string) => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onUpdate: () => void;
  onSyncComplete: () => void;
  onGoogleOpen: () => void;
  onOpenAIReview: () => void;
  onAIPrev: () => void;
  onAINext: () => void;
  /** Called when user clicks Switch Workspace — parent handles confirmation + navigation */
  onSwitchWorkspace: () => void;
  onImageSearch: () => void;
  /** Called after a file is deleted — parent should clear it from active state */
  onFileDeleted: (relPath: string) => void;
}

export default function Sidebar({
  workspace,
  activeFile,
  dirtyFiles,
  aiMarks,
  aiNavCount,
  aiNavIndex,
  style,
  onFileSelect,
  onWorkspaceChange,
  onUpdate: _onUpdate,
  onSyncComplete,
  onGoogleOpen: _onGoogleOpen,
  onOpenAIReview,
  onAIPrev,
  onAINext,
  onSwitchWorkspace,
  onImageSearch,
  onFileDeleted,
}: SidebarProps) {
  // ── Creator state ──────────────────────────────────────────────────────────
  /** null = hidden; '' = root; 'path/to/dir' = inside that dir */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingKind, setCreatingKind] = useState<'file' | 'folder'>('file');
  const [newName, setNewName] = useState('');
  const [selectedExt, setSelectedExt] = useState('.md');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [gitChangedCount, setGitChangedCount] = useState(0);

  async function handleDeleteFile(relPath: string) {
    const name = relPath.split('/').pop() ?? relPath;
    if (!window.confirm(`Delete "${name}"?\n\nThis will be tracked in git and can be reverted via Sync.`)) return;
    await deleteFile(workspace, relPath);
    const [files, fileTree] = await Promise.all([refreshFiles(workspace), refreshFileTree(workspace)]);
    onWorkspaceChange({ ...workspace, files, fileTree });
    onFileDeleted(relPath);
    setContextMenu(null);
  }

  async function handleDuplicateFile(relPath: string) {
    const dupPath = await duplicateFile(workspace, relPath);
    const [files, fileTree] = await Promise.all([refreshFiles(workspace), refreshFileTree(workspace)]);
    onWorkspaceChange({ ...workspace, files, fileTree });
    onFileSelect(dupPath);
    setContextMenu(null);
  }

  // Poll git status every 30s so the sync button reflects uncommitted changes
  const fetchGitCount = useCallback(async () => {
    try {
      const result = await invoke<{ files: string[] }>('git_diff', { path: workspace.path });
      setGitChangedCount(result.files.length);
    } catch { /* not a git repo — ignore */ }
  }, [workspace.path]);

  useEffect(() => {
    fetchGitCount();
    const id = setInterval(fetchGitCount, 30_000);
    return () => clearInterval(id);
  }, [fetchGitCount]);

  // Derive set of files with unreviewed AI edits for tree highlighting
  const unseenAiFiles = new Set(aiMarks.filter((m) => !m.reviewed).map((m) => m.fileRelPath));

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

  function startCreating(inPath: string, kind: 'file' | 'folder' = 'file') {
    setCreatingIn(inPath);
    setCreatingKind(kind);
    setNewName('');
    setSelectedExt('.md');
    setContextMenu(null);
    // Focus input after state update
    setTimeout(() => createInputRef.current?.focus(), 30);
  }

  function cancelCreating() {
    setCreatingIn(null);
    setNewName('');
  }

  function handleContextMenu(e: React.MouseEvent, path: string, isDir: boolean) {
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }

  useEffect(() => {
    if (!contextMenu) return;
    function close() { setContextMenu(null); }
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  async function handleCreate() {
    if (!newName.trim() || creatingIn === null) return;
    const prefix = creatingIn ? `${creatingIn}/` : '';
    const baseName = newName.trim();

    if (creatingKind === 'folder') {
      await createFolder(workspace, `${prefix}${baseName}`);
      const [files, fileTree] = await Promise.all([refreshFiles(workspace), refreshFileTree(workspace)]);
      onWorkspaceChange({ ...workspace, files, fileTree });
      // Auto-expand the new folder
      const newPath = `${prefix}${baseName}`;
      setExpandedDirs((prev) => { const s = new Set(prev); s.add(newPath); return s; });
      cancelCreating();
      return;
    }

    // File creation
    let relPath: string;
    if (selectedExt === '.tldr.json') {
      const base = baseName.replace(/\.tldr\.json$/, '');
      relPath = `${prefix}${base}.tldr.json`;
      await createCanvasFile(workspace, `${prefix}${base}`);
    } else {
      const hasExt = baseName.endsWith(selectedExt);
      relPath = `${prefix}${hasExt ? baseName : baseName + selectedExt}`;
      await createFile(workspace, relPath);
    }

    const [files, fileTree] = await Promise.all([refreshFiles(workspace), refreshFileTree(workspace)]);
    onWorkspaceChange({ ...workspace, files, fileTree });
    if (creatingIn) setExpandedDirs((prev) => { const s = new Set(prev); s.add(creatingIn!); return s; });
    cancelCreating();
    onFileSelect(relPath);
  }

  async function handleSyncConfirm(message: string) {
    setSyncStatus('syncing');
    try {
      await invoke('git_sync', { path: workspace.path, message });
      onSyncComplete();
      setSyncStatus('done');
    } catch (e) {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 2500);
      throw e; // let SyncModal display the error
    }
    setTimeout(() => setSyncStatus('idle'), 2500);
  }


  function handleOpenWorkspace() {
    onSwitchWorkspace();
  }

  return (
    <>
    <aside className="sidebar" style={style}>
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

      {/* Explorer label with hover create actions */}
      <div className="sidebar-explorer-label">
        <span>EXPLORER</span>
        <div className="sidebar-explorer-actions">
          <button className="sidebar-explorer-action" title="New file" onClick={() => startCreating('')}>+</button>
          <button className="sidebar-explorer-action" title="New folder" onClick={() => startCreating('', 'folder')}>⊞</button>
        </div>
      </div>

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
            dirtyFiles={dirtyFiles}
            unseenAiFiles={unseenAiFiles}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            onFileSelect={onFileSelect}
            onStartCreate={startCreating}
            onContextMenu={handleContextMenu}
            onDeleteFile={handleDeleteFile}
            onDuplicateFile={handleDuplicateFile}
          />
        ))}
      </div>

      {/* AI Edits section */}
      {(() => {
        // Group unreviewed marks by file
        const unreviewed = aiMarks.filter((m) => !m.reviewed);
        if (unreviewed.length === 0) return null;
        const byFile = new Map<string, number>();
        for (const m of unreviewed) {
          byFile.set(m.fileRelPath, (byFile.get(m.fileRelPath) ?? 0) + 1);
        }
        return (
          <div className="sidebar-ai-section">
            <div className="sidebar-ai-section-label">
              <span>AI EDITS</span>
              <span className="sidebar-ai-total">{unreviewed.length}</span>
            </div>
            {Array.from(byFile.entries()).map(([file, count]) => (
              <button
                key={file}
                className={`sidebar-ai-file-row ${activeFile === file ? 'active' : ''}`}
                onClick={() => {
                  onFileSelect(file);
                  // Slight delay so file loads before review opens
                  setTimeout(onOpenAIReview, 120);
                }}
                title={file}
              >
                <span className="sidebar-ai-file-name">{file.split('/').pop()}</span>
                <span className="sidebar-ai-count">{count}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Footer actions */}
      <div className="sidebar-footer">
        {/* ── Inline creator ── */}
        {creatingIn !== null && (
          <div className="sidebar-creator">
            <div className="sidebar-creator-context">
              <span className="sidebar-creator-kind">{creatingKind === 'folder' ? '⊞ folder' : '+ file'}</span>
              {creatingIn ? <span className="sidebar-creator-path">in {creatingIn}</span> : <span className="sidebar-creator-path">at root</span>}
              <button className="sidebar-creator-cancel" onClick={cancelCreating} title="Cancel (Esc)">✕</button>
            </div>
            {creatingKind === 'file' && (
              <>
                <div className="sidebar-creator-types">
                  {EDITABLE_TYPES.map((t) => (
                    <button
                      key={t.ext}
                      className={`sidebar-type-pill${selectedExt === t.ext ? ' active' : ''}`}
                      onClick={() => setSelectedExt(t.ext)}
                    >{t.label}</button>
                  ))}
                </div>
                <button
                  className={`sidebar-canvas-btn${selectedExt === '.tldr.json' ? ' active' : ''}`}
                  onClick={() => setSelectedExt(selectedExt === '.tldr.json' ? '.md' : '.tldr.json')}
                >
                  ◈ Canvas
                </button>
              </>
            )}
            <div className="sidebar-new-file-form">
              <input
                ref={createInputRef}
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={creatingKind === 'folder' ? 'folder-name' : 'filename'}
                className="sidebar-new-file-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') cancelCreating();
                }}
              />
              <button className="sidebar-btn-confirm" onClick={handleCreate}>✓</button>
            </div>
          </div>
        )}
        <button
          className={`sidebar-btn sidebar-btn-sync${syncStatus !== 'idle' ? ` ${syncStatus}` : ''}${syncStatus === 'idle' && gitChangedCount > 0 ? ' has-changes' : ''}`}
          onClick={() => { setShowSyncModal(true); fetchGitCount(); }}
          disabled={syncStatus === 'syncing'}
          title="Review git diff and commit + push"
        >
          <span className="sidebar-sync-label">
            {syncStatus === 'idle'    && '⇅ Sync'}
            {syncStatus === 'syncing' && '⇅ Syncing…'}
            {syncStatus === 'done'    && '✓ Synced'}
            {syncStatus === 'error'   && '⚠ Sync failed'}
          </span>
          {syncStatus === 'idle' && gitChangedCount > 0 && (
            <span className="sidebar-sync-badge">{gitChangedCount}</span>
          )}
        </button>
        {/* AI edit navigation — only shown when the active file has unreviewed marks */}
        {aiNavCount > 0 && (
          <div className="sidebar-ai-nav-bar">
            <button
              className="sidebar-ai-nav-preview"
              onClick={onOpenAIReview}
              title="Preview AI edits"
            >
              ✦ AI edits
              <span className="sidebar-ai-nav-total">{aiNavCount}</span>
            </button>
            <div className="sidebar-ai-nav-arrows">
              <button
                className="sidebar-ai-nav-arrow"
                onClick={onAIPrev}
                disabled={aiNavCount < 2}
                title="Previous AI edit"
              >‹</button>
              <span
                className="sidebar-ai-nav-pos"
                onClick={onOpenAIReview}
                title="Review all AI edits"
              >{aiNavIndex + 1}/{aiNavCount}</span>
              <button
                className="sidebar-ai-nav-arrow"
                onClick={onAINext}
                disabled={aiNavCount < 2}
                title="Next AI edit"
              >›</button>
            </div>
          </div>
        )}
        {/* ⊡ Google — deprecated; button hidden but panel code kept for future re-enable
        <button
          className="sidebar-btn sidebar-btn-google"
          onClick={onGoogleOpen}
          title="Google Drive backup & Slides"
        >
          ⊡ Google
        </button>
        */}
        <button className="sidebar-btn sidebar-btn-images" onClick={onImageSearch}>
          🖼 Images
        </button>
        <button className="sidebar-btn sidebar-btn-folder" onClick={handleOpenWorkspace}>
          ⊘ Switch workspace
        </button>
      </div>
    </aside>

    <SyncModal
      open={showSyncModal}
      workspacePath={workspace.path}
      onConfirm={handleSyncConfirm}
      onClose={() => { setShowSyncModal(false); fetchGitCount(); }}
    />

    {/* ── Context menu ── */}
    {contextMenu && (
      <div
        className="sidebar-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={() => {
          const inPath = contextMenu.isDir
            ? contextMenu.path
            : (contextMenu.path.includes('/') ? contextMenu.path.substring(0, contextMenu.path.lastIndexOf('/')) : '');
          startCreating(inPath, 'file');
        }}>+ New file here</button>
        <button onClick={() => {
          const inPath = contextMenu.isDir
            ? contextMenu.path
            : (contextMenu.path.includes('/') ? contextMenu.path.substring(0, contextMenu.path.lastIndexOf('/')) : '');
          startCreating(inPath, 'folder');
        }}>⊞ New folder here</button>
        {!contextMenu.isDir && (
          <>
            <div className="sidebar-context-separator" />
            <button onClick={() => handleDuplicateFile(contextMenu.path)}>⧉ Duplicate</button>
            <button className="sidebar-context-delete" onClick={() => handleDeleteFile(contextMenu.path)}>✕ Delete</button>
          </>
        )}
      </div>
    )}
    </>
  );
}

