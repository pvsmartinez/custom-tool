import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { X, Check, CaretLeft, CaretRight, CaretDown, Play, FolderSimple, Copy, Warning, FolderPlus, Minus } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { createFile, createCanvasFile, createFolder, refreshWorkspaceFiles, deleteFile, duplicateFile, duplicateFolder, renameFile, moveFile, updateFileReferences } from '../services/workspace';
import SyncModal from './SyncModal';
import ProjectSearchPanel from './ProjectSearchPanel';
import type { Workspace, FileTreeNode, AIEditMark, SidebarButton } from '../types';
import { loadWorkspaceSession, saveWorkspaceSession } from '../services/workspaceSession';
import './Sidebar.css';

// ── File-type icon helper ───────────────────────────────────────────────────
/**
 * Returns both the icon glyph/element and the CSS class for a filename in one
 * pass.  Previously `fileIcon` and `fileIconCls` traversed identical extension
 * lists separately — merging them halves the work and removes the risk of the
 * two functions drifting out of sync.
 */
function fileIconInfo(name: string): { icon: React.ReactNode; cls: string } {
  if (name.endsWith('.tldr.json')) return { icon: '◈', cls: 'sidebar-icon--canvas' };
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'mdx'].includes(ext))               return { icon: '≣',  cls: 'sidebar-icon--md' };
  if (['ts', 'tsx'].includes(ext))               return { icon: 'TS', cls: 'sidebar-icon--ts' };
  if (['js', 'jsx', 'mjs'].includes(ext))        return { icon: 'JS', cls: 'sidebar-icon--js' };
  if (['json', 'jsonc'].includes(ext))           return { icon: '{}', cls: 'sidebar-icon--json' };
  if (['css', 'scss', 'less'].includes(ext))     return { icon: '#',  cls: 'sidebar-icon--css' };
  if (['html', 'htm'].includes(ext))             return { icon: '<>', cls: 'sidebar-icon--html' };
  if (ext === 'rs')                              return { icon: 'Rs', cls: 'sidebar-icon--rs' };
  if (ext === 'py')                              return { icon: 'Py', cls: 'sidebar-icon--py' };
  if (ext === 'go')                              return { icon: 'Go', cls: 'sidebar-icon--go' };
  if (['c', 'cpp', 'h', 'hpp'].includes(ext))   return { icon: 'C',  cls: 'sidebar-icon--c' };
  if (ext === 'java')                            return { icon: 'Jv', cls: 'sidebar-icon--java' };
  if (['kt', 'kts'].includes(ext))              return { icon: 'Kt', cls: 'sidebar-icon--java' };
  if (ext === 'swift')                           return { icon: 'Sw', cls: 'sidebar-icon--swift' };
  if (ext === 'rb')                              return { icon: 'Rb', cls: 'sidebar-icon--rb' };
  if (ext === 'php')                             return { icon: 'Php', cls: 'sidebar-icon--rb' };
  if (['toml', 'yaml', 'yml'].includes(ext))    return { icon: '≡',  cls: 'sidebar-icon--cfg' };
  if (['sh', 'bash', 'zsh', 'fish'].includes(ext)) return { icon: '$', cls: 'sidebar-icon--sh' };
  if (ext === 'pdf')                             return { icon: 'PDF', cls: 'sidebar-icon--pdf' };
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi'].includes(ext))
                                                 return { icon: <Play weight="thin" size={11} />, cls: 'sidebar-icon--video' };
  if (ext === 'gif')                             return { icon: 'GIF', cls: 'sidebar-icon--media' };
  if (['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'].includes(ext))
                                                 return { icon: '♪',  cls: 'sidebar-icon--media' };
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif'].includes(ext))
                                                 return { icon: '⊡', cls: 'sidebar-icon--image' };
  return { icon: '·', cls: '' };
}

// ── File-type groups for the three-category creator ────────────────────────
type FileCategory = 'canvas' | 'text' | 'code';

const TEXT_TYPES = [
  { ext: '.md',   label: 'Markdown' },
  { ext: '.mdx',  label: 'MDX' },
  { ext: '.txt',  label: 'Plain text' },
  { ext: '.json', label: 'JSON' },
];

const CODE_TYPES = [
  { ext: '.html', label: 'HTML' },
  { ext: '.js',   label: 'JavaScript' },
  { ext: '.ts',   label: 'TypeScript' },
  { ext: '.tsx',  label: 'TSX' },
  { ext: '.css',  label: 'CSS' },
  { ext: '.py',   label: 'Python' },
  { ext: '.rs',   label: 'Rust' },
  { ext: '.yaml', label: 'YAML' },
  { ext: '.sh',   label: 'Shell' },
];

// ── Recursive tree node ─────────────────────────────────────────────────────
interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  activeFile: string | null;
  dirtyFiles: Set<string>;
  unseenAiFiles: Set<string>;
  lockedFiles?: Set<string>;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileSelect: (path: string) => void;
  onStartCreate: (inPath: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onDeleteFile: (path: string) => void;
  onDuplicateFile: (path: string) => void;
  // rename
  renamingPath: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameStart: (path: string, currentName: string) => void;
  onRenameChange: (val: string) => void;
  onRenameConfirm: (oldPath: string) => void;
  onRenameCancel: () => void;
  // drag-to-folder
  dragOverDir: string | null;
  onDirDragEnter: (e: React.DragEvent, dirPath: string) => void;
  onDirDragLeave: (e: React.DragEvent, dirPath: string) => void;
  onDirDrop: (e: React.DragEvent, dirPath: string) => void;
  // multi-select
  multiSelected: Set<string>;
  onMultiToggle: (path: string) => void;
}

const DRAGGABLE_IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','avif','bmp','ico','tiff','tif']);

function TreeNodeItem({
  node, depth, activeFile, dirtyFiles, unseenAiFiles, lockedFiles, expandedDirs,
  onToggleDir, onFileSelect, onStartCreate, onContextMenu, onDeleteFile, onDuplicateFile,
  renamingPath, renameValue, renameInputRef, onRenameStart, onRenameChange, onRenameConfirm, onRenameCancel,
  dragOverDir, onDirDragEnter, onDirDragLeave, onDirDrop,
  multiSelected, onMultiToggle,
}: TreeNodeProps) {
  const indent = 8 + depth * 14;

  if (node.isDirectory) {
    const isExpanded = expandedDirs.has(node.path);
    const isDragTarget = dragOverDir === node.path;
    const isRenaming = renamingPath === node.path;
    return (
      <>
        <button
          className={`sidebar-tree-row sidebar-tree-dir${isDragTarget ? ' drag-over' : ''}`}
          style={{ paddingLeft: indent }}
          draggable={!isRenaming}
          onClick={() => !isRenaming && onToggleDir(node.path)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
          onDoubleClick={(e) => { e.stopPropagation(); onRenameStart(node.path, node.name); }}
          onDragStart={!isRenaming ? (e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-workspace-file', node.path);
            const ghost = document.createElement('div');
            ghost.textContent = `⊟ ${node.name}`;
            ghost.style.cssText = 'position:fixed;top:-200px;background:#261f16;color:#c4b49a;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid #3b3026;pointer-events:none';
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, 0, 0);
            requestAnimationFrame(() => document.body.removeChild(ghost));
          } : undefined}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDragEnter={(e) => onDirDragEnter(e, node.path)}
          onDragLeave={(e) => onDirDragLeave(e, node.path)}
          onDrop={(e) => onDirDrop(e, node.path)}
          title={node.path}
        >
          <span className="sidebar-tree-arrow">{isExpanded ? <CaretDown weight="thin" size={11} /> : <CaretRight weight="thin" size={11} />}</span>
          <span className="sidebar-tree-icon sidebar-tree-icon--dir"><FolderSimple weight="thin" size={13} /></span>
          {isRenaming ? (
            <input
              ref={renameInputRef as React.RefObject<HTMLInputElement>}
              className="sidebar-rename-input"
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') onRenameConfirm(node.path);
                if (e.key === 'Escape') onRenameCancel();
              }}
              onBlur={() => onRenameCancel()}
            />
          ) : (
            <span className="sidebar-tree-name">{node.name}</span>
          )}
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
            lockedFiles={lockedFiles}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onFileSelect={onFileSelect}
            onStartCreate={onStartCreate}
            onContextMenu={onContextMenu}
            onDeleteFile={onDeleteFile}
            onDuplicateFile={onDuplicateFile}
            renamingPath={renamingPath}
            renameValue={renameValue}
            renameInputRef={renameInputRef}
            onRenameStart={onRenameStart}
            onRenameChange={onRenameChange}
            onRenameConfirm={onRenameConfirm}
            onRenameCancel={onRenameCancel}
            dragOverDir={dragOverDir}
            onDirDragEnter={onDirDragEnter}
            onDirDragLeave={onDirDragLeave}
            onDirDrop={onDirDrop}
            multiSelected={multiSelected}
            onMultiToggle={onMultiToggle}
          />
        ))}
      </>
    );
  }

  const isDirty = dirtyFiles.has(node.path);
  const hasUnseenAi = unseenAiFiles.has(node.path);
  const isLocked = !!lockedFiles?.has(node.path);
  const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = DRAGGABLE_IMAGE_EXTS.has(ext);
  const isRenaming = renamingPath === node.path;
  // Parent directory of this file ('' = root)
  const parentDir = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : '';

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-workspace-file', node.path);
    const ghost = document.createElement('div');
    ghost.textContent = node.name;
    ghost.style.cssText = 'position:fixed;top:-200px;background:#261f16;color:#c4b49a;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid #3b3026;pointer-events:none';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    requestAnimationFrame(() => document.body.removeChild(ghost));
  }

  const { icon: fileIconNode, cls: fileIconCls } = fileIconInfo(node.name);

  return (
    <button
      className={`sidebar-tree-row sidebar-tree-file ${activeFile === node.path ? 'active' : ''}${hasUnseenAi ? ' unseen-ai' : ''}${isImage ? ' draggable-image' : ''}${isLocked ? ' copilot-locked' : ''}${multiSelected.has(node.path) ? ' multi-selected' : ''}`}
      style={{ paddingLeft: indent + 16 }}
      draggable={!isRenaming}
      onDragStart={!isRenaming ? handleDragStart : undefined}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDragEnter={(e) => onDirDragEnter(e, parentDir)}
      onDragLeave={(e) => onDirDragLeave(e, parentDir)}
      onDrop={(e) => onDirDrop(e, parentDir)}
      onClick={(e) => {
        if (!isRenaming) {
          if (e.metaKey || e.ctrlKey) {
            e.stopPropagation();
            onMultiToggle(node.path);
            return;
          }
          onFileSelect(node.path);
        }
      }}
      onDoubleClick={(e) => { e.stopPropagation(); onRenameStart(node.path, node.name); }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, false); }}
      title={isImage ? `${node.path}\nDrag to canvas or folder` : node.path}
    >
      <span className={`sidebar-tree-icon ${fileIconCls}`}>{fileIconNode}</span>
      {isRenaming ? (
        <input
          ref={renameInputRef as React.RefObject<HTMLInputElement>}
          className="sidebar-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onRenameConfirm(node.path);
            if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={() => onRenameCancel()}
        />
      ) : (
        <span className="sidebar-tree-name">{node.name}</span>
      )}
      {hasUnseenAi && <span className="sidebar-ai-dot" title="Unseen AI edits" />}
      {isDirty && <span className="sidebar-dirty-dot" title="Unsaved changes" />}
      {!isRenaming && (
        <span className="sidebar-file-actions" onClick={(e) => e.stopPropagation()}>
          <span
            role="button"
            className="sidebar-file-action"
            title="Rename (double-click)"
            onClick={() => onRenameStart(node.path, node.name)}
            tabIndex={0}
          >✎</span>
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
          ><X weight="thin" size={12} /></span>
        </span>
      )}
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
  onOpenAIReview: () => void;
  // (kept in props so parent can still trigger highlight+jump without popup)
  onReviewAllMarks: () => void;
  onAIPrev: () => void;
  onAINext: () => void;
  /** Called when user clicks Switch Workspace — parent handles confirmation + navigation */
  onSwitchWorkspace: () => void;
  onImageSearch: () => void;
  /** Called after a file is deleted — parent should clear it from active state */
  onFileDeleted: (relPath: string) => void;
  /** Called when a search result line is clicked */
  onSearchFileOpen: (relPath: string, lineNo?: number, matchText?: string) => void;
  /** Files currently being written by the Copilot agent */
  lockedFiles?: Set<string>;
  /** Current sidebar panel mode */
  sidebarMode: 'explorer' | 'search';
  onSidebarModeChange: (mode: 'explorer' | 'search') => void;
  /** Open terminal panel and cd to this relative directory ('' = workspace root) */
  onOpenTerminalAt?: (relDir: string) => void;
  /** Called when user clicks a custom workspace button */
  onRunButtonCommand?: (command: string, label: string) => void;
  /** If provided, assigned to startCreating('','file') so parent can trigger new-file via ⌘T/⌘N */
  newFileRef?: { current: (() => void) | null };
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
  onOpenAIReview: _onOpenAIReview,
  onReviewAllMarks,
  onAIPrev,
  onAINext,
  onSwitchWorkspace,
  onImageSearch,
  onFileDeleted,
  onSearchFileOpen,
  lockedFiles,
  sidebarMode,
  onSidebarModeChange,
  onOpenTerminalAt,
  onRunButtonCommand,
  newFileRef,
}: SidebarProps) {
  // ── Creator state ──────────────────────────────────────────────────────────
  /** null = hidden; '' = root; 'path/to/dir' = inside that dir */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingKind, setCreatingKind] = useState<'file' | 'folder'>('file');
  const [newName, setNewName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<FileCategory>('text');
  const [selectedExt, setSelectedExt] = useState('.md');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [movePicker, setMovePicker] = useState<{ path: string; x: number; y: number } | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [gitChangedCount, setGitChangedCount] = useState(0);

  // Wire the external new-file trigger ref so ⌘T/⌘N in App can open the creator
  useEffect(() => {
    if (!newFileRef) return;
    newFileRef.current = () => startCreating('', 'file');
    return () => { if (newFileRef) newFileRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFileRef]);

  // Memoised set of all directory rel-paths — O(n) once per fileTree change
  // rather than O(n) on every rename/delete/drop event.
  const dirSet = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    function walk(nodes: FileTreeNode[]) {
      for (const n of nodes) {
        if (n.isDirectory) {
          set.add(n.path);
          if (n.children) walk(n.children);
        }
      }
    }
    walk(workspace.fileTree);
    return set;
  }, [workspace.fileTree]);

  // ── Rename state ───────────────────────────────────────────────────────────
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  function startRename(path: string, currentName: string) {
    setRenamingPath(path);
    setRenameValue(currentName);
    setContextMenu(null);
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 30);
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameValue('');
  }

  async function confirmRename(oldPath: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) { cancelRename(); return; }
    // Compute new path: same directory, new name
    const slashIdx = oldPath.lastIndexOf('/');
    const dir = slashIdx >= 0 ? oldPath.substring(0, slashIdx) : '';
    const newPath = dir ? `${dir}/${trimmed}` : trimmed;
    if (newPath === oldPath) { cancelRename(); return; }
    const dir_ = dirSet.has(oldPath);
    await updateFileReferences(workspace, workspace.fileTree, oldPath, newPath, dir_);
    await renameFile(workspace, oldPath, newPath);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    // If the renamed file was the active one, notify parent
    if (activeFile === oldPath) onFileSelect(newPath);
    cancelRename();
  }

  // ── Drag-to-folder state ───────────────────────────────────────────────────
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  // Per-dir enter counter so child-element enter/leave events don't false-fire.
  const dragCounters = useRef(new Map<string, number>());

  // ── Multi-select state ─────────────────────────────────────────────────────
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());

  function handleMultiToggle(path: string) {
    setMultiSelected((prev) => {
      const s = new Set(prev);
      if (s.has(path)) s.delete(path); else s.add(path);
      return s;
    });
  }

  async function handleBulkDelete() {
    const paths = [...multiSelected];
    if (!window.confirm(`Delete ${paths.length} file(s)?`)) return;
    for (const p of paths) {
      await deleteFile(workspace, p);
      onFileDeleted(p);
    }
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    setMultiSelected(new Set());
  }

  function handleDirDragEnter(e: React.DragEvent, dirPath: string) {
    e.preventDefault();
    e.stopPropagation(); // prevent parent folders from also receiving dragEnter
    const n = (dragCounters.current.get(dirPath) ?? 0) + 1;
    dragCounters.current.set(dirPath, n);
    setDragOverDir(dirPath);
  }

  function handleDirDragLeave(_e: React.DragEvent, dirPath: string) {
    const n = (dragCounters.current.get(dirPath) ?? 1) - 1;
    if (n <= 0) {
      dragCounters.current.delete(dirPath);
      setDragOverDir((prev) => (prev === dirPath ? null : prev));
    } else {
      dragCounters.current.set(dirPath, n);
    }
  }

  async function handleDirDrop(e: React.DragEvent, destDir: string) {
    e.preventDefault();
    e.stopPropagation();
    // Reset this dir's counter and clear highlight
    dragCounters.current.delete(destDir);
    setDragOverDir(null);
    const srcRel = e.dataTransfer.getData('text/x-workspace-file');
    if (!srcRel) return;
    // Prevent dropping a folder into itself or any descendant
    if (destDir === srcRel || destDir.startsWith(srcRel + '/')) return;
    // Don't move into own parent (no-op)
    const srcDir = srcRel.includes('/') ? srcRel.substring(0, srcRel.lastIndexOf('/')) : '';
    if (srcDir === destDir) return;
    const isDir_ = dirSet.has(srcRel);
    const newRel = destDir ? `${destDir}/${srcRel.split('/').pop()!}` : srcRel.split('/').pop()!;
    await updateFileReferences(workspace, workspace.fileTree, srcRel, newRel, isDir_);
    await moveFile(workspace, srcRel, destDir);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    if (activeFile === srcRel || activeFile?.startsWith(srcRel + '/')) onFileSelect(newRel);
  }

  async function handleDeleteFile(relPath: string) {
    const name = relPath.split('/').pop() ?? relPath;
    const isDir = dirSet.has(relPath);
    const msg = isDir
      ? `Delete folder "${name}" and all its contents?\n\nThis will be tracked in git and can be reverted via Sync.`
      : `Delete "${name}"?\n\nThis will be tracked in git and can be reverted via Sync.`;
    if (!window.confirm(msg)) return;
    await deleteFile(workspace, relPath, isDir);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    onFileDeleted(relPath);
    setContextMenu(null);
  }

  async function handleDuplicateFile(relPath: string) {
    const dupPath = await duplicateFile(workspace, relPath);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    onFileSelect(dupPath);
    setContextMenu(null);
  }

  async function handleDuplicateFolder(relPath: string) {
    await duplicateFolder(workspace, relPath);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    setContextMenu(null);
  }

  async function handleMoveToFolder(srcPath: string, destDir: string) {
    setMovePicker(null);
    const srcDir = srcPath.includes('/') ? srcPath.substring(0, srcPath.lastIndexOf('/')) : '';
    if (destDir === srcDir) return; // already there
    if (destDir === srcPath || destDir.startsWith(srcPath + '/')) return; // can't move into self
    const isDir_ = dirSet.has(srcPath);
    const newRel = destDir ? `${destDir}/${srcPath.split('/').pop()!}` : srcPath.split('/').pop()!;
    await updateFileReferences(workspace, workspace.fileTree, srcPath, newRel, isDir_);
    await moveFile(workspace, srcPath, destDir);
    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
    onWorkspaceChange({ ...workspace, files, fileTree });
    if (activeFile === srcPath || activeFile?.startsWith(srcPath + '/')) onFileSelect(newRel);
  }

  // Flatten fileTree into all folder paths, excluding src and its descendants
  function getAllFolders(nodes: FileTreeNode[], exclude?: string): string[] {
    const result: string[] = [];
    function walk(arr: FileTreeNode[]) {
      for (const n of arr) {
        if (!n.isDirectory) continue;
        if (exclude && (n.path === exclude || n.path.startsWith(exclude + '/'))) continue;
        result.push(n.path);
        if (n.children) walk(n.children);
      }
    }
    walk(nodes);
    return result;
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

  // Start with root-level directories expanded; restore from last session if available
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const session = loadWorkspaceSession(workspace.path);
    if (session.expandedDirs.length > 0) {
      return new Set(session.expandedDirs);
    }
    // Default: expand root-level directories
    const initial = new Set<string>();
    workspace.fileTree.forEach((n) => { if (n.isDirectory) initial.add(n.path); });
    return initial;
  });

  // Persist expanded dirs (debounced, 800 ms)
  useEffect(() => {
    const id = setTimeout(() => {
      saveWorkspaceSession(workspace.path, { expandedDirs: Array.from(expandedDirs) });
    }, 800);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedDirs]);

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
    setSelectedCategory('text');
    setSelectedExt('.md');
    setContextMenu(null);
    // Focus input after state update
    setTimeout(() => createInputRef.current?.focus(), 30);
  }

  function selectCategory(cat: FileCategory) {
    setSelectedCategory(cat);
    if (cat === 'canvas') setSelectedExt('.tldr.json');
    else if (cat === 'text')  setSelectedExt('.md');
    else                      setSelectedExt('.ts');
    setTimeout(() => createInputRef.current?.focus(), 0);
  }

  function cancelCreating() {
    setCreatingIn(null);
    setNewName('');
  }

  function handleContextMenu(e: React.MouseEvent, path: string, isDir: boolean) {
    // Clamp to viewport so menu never overflows the screen edge
    const MENU_W = 192;
    const MENU_H = isDir ? 275 : 345;
    const cx = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
    const cy = Math.min(e.clientY, window.innerHeight - MENU_H - 6);
    setContextMenu({ x: cx, y: cy, path, isDir });
  }

  useEffect(() => {
    if (!contextMenu) return;
    function close() { setContextMenu(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setContextMenu(null); } }
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!movePicker) return;
    function close() { setMovePicker(null); }
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [movePicker]);

  async function handleCreate() {
    if (!newName.trim() || creatingIn === null) return;
    const prefix = creatingIn ? `${creatingIn}/` : '';
    const baseName = newName.trim();

    if (creatingKind === 'folder') {
      await createFolder(workspace, `${prefix}${baseName}`);
      const { files, fileTree } = await refreshWorkspaceFiles(workspace);
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

    const { files, fileTree } = await refreshWorkspaceFiles(workspace);
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

      {/* Mode tabs */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab${sidebarMode === 'explorer' ? ' active' : ''}`}
          onClick={() => onSidebarModeChange('explorer')}
          title="Explorer"
        >⋟ Files</button>
        <button
          className={`sidebar-tab${sidebarMode === 'search' ? ' active' : ''}`}
          onClick={() => onSidebarModeChange('search')}
          title="Search workspace (⌘⇧F)"
        >⌕ Search</button>
      </div>

      {/* ── SEARCH MODE ─────────────────────────────────────────── */}
      {sidebarMode === 'search' && (
        <ProjectSearchPanel
          workspace={workspace}
          onOpenFile={(relPath, lineNo, matchText) => {
            onSearchFileOpen(relPath, lineNo, matchText);
          }}
        />
      )}

      {/* ── EXPLORER MODE ────────────────────────────────────────── */}
      {sidebarMode === 'explorer' && (
        <>

      {/* Explorer label with hover create actions */}
      <div className="sidebar-explorer-label">
        <span>EXPLORER</span>
        <div className="sidebar-explorer-actions">
          <button className="sidebar-explorer-action" title="New file" onClick={() => startCreating('')}>+</button>
          <button className="sidebar-explorer-action" title="New folder" onClick={() => startCreating('', 'folder')}><FolderPlus weight="thin" size={13} /></button>
          <button className="sidebar-explorer-action" title="Collapse all folders" onClick={() => setExpandedDirs(new Set())}><Minus weight="thin" size={13} /></button>
        </div>
      </div>

      {/* Multi-select bulk action bar */}
      {multiSelected.size > 0 && (
        <div className="sidebar-multiselect-bar">
          <span className="sidebar-multiselect-count">{multiSelected.size} selected</span>
          <button
            className="sidebar-multiselect-delete"
            onClick={handleBulkDelete}
            title="Delete selected files"
          >Delete</button>
          <button
            className="sidebar-multiselect-clear"
            onClick={() => setMultiSelected(new Set())}
            title="Clear selection"
          ><X weight="thin" size={12} /></button>
        </div>
      )}

      {/* File tree */}
      <div
        className={`sidebar-files${dragOverDir === '__root__' ? ' drag-over-root' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDragEnter={(e) => { if (e.currentTarget === e.target) { dragCounters.current.set('__root__', (dragCounters.current.get('__root__') ?? 0) + 1); setDragOverDir('__root__'); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { dragCounters.current.delete('__root__'); setDragOverDir(null); } }}
        onDrop={async (e) => {
          // Only handle drops directly on the container (not on a folder child)
          setDragOverDir(null);
          dragCounters.current.delete('__root__');
          const srcRel = e.dataTransfer.getData('text/x-workspace-file');
          if (!srcRel) return;
          const srcDir = srcRel.includes('/') ? srcRel.substring(0, srcRel.lastIndexOf('/')) : '';
          if (!srcDir) return; // already at root
          const newRel = await moveFile(workspace, srcRel, '');
          const { files, fileTree } = await refreshWorkspaceFiles(workspace);
          onWorkspaceChange({ ...workspace, files, fileTree });
          if (activeFile === srcRel) onFileSelect(newRel);
        }}
      >
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
            lockedFiles={lockedFiles}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            onFileSelect={onFileSelect}
            onStartCreate={startCreating}
            onContextMenu={handleContextMenu}
            onDeleteFile={handleDeleteFile}
            onDuplicateFile={handleDuplicateFile}
            renamingPath={renamingPath}
            renameValue={renameValue}
            renameInputRef={renameInputRef}
            onRenameStart={startRename}
            onRenameChange={setRenameValue}
            onRenameConfirm={confirmRename}
            onRenameCancel={cancelRename}
            dragOverDir={dragOverDir}
            onDirDragEnter={handleDirDragEnter}
            onDirDragLeave={handleDirDragLeave}
            onDirDrop={handleDirDrop}
            multiSelected={multiSelected}
            onMultiToggle={handleMultiToggle}
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
              <div className="sidebar-ai-label-right">
                <span className="sidebar-ai-total">{unreviewed.length}</span>
                <button
                  className="sidebar-ai-review-all"
                  onClick={(e) => { e.stopPropagation(); onReviewAllMarks(); }}
                  title="Mark all AI edits as reviewed"
                ><Check weight="thin" size={13} /></button>
              </div>
            </div>
            {Array.from(byFile.entries()).map(([file, count]) => (
              <button
                key={file}
                className={`sidebar-ai-file-row ${activeFile === file ? 'active' : ''}`}
                onClick={() => {
                  onFileSelect(file);
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

      </>
      )} {/* end explorer mode */}

      {/* Footer actions — always visible */}
      <div className="sidebar-footer">
        {/* ── Inline creator ── */}
        {creatingIn !== null && (
          <div className="sidebar-creator">
            <div className="sidebar-creator-context">
              <span className="sidebar-creator-kind">{creatingKind === 'folder' ? <><FolderPlus weight="thin" size={13} /> folder</> : '+ file'}</span>
              {creatingIn ? <span className="sidebar-creator-path">in {creatingIn}</span> : <span className="sidebar-creator-path">at root</span>}
              <button type="button" className="sidebar-creator-cancel" onClick={cancelCreating} title="Cancel (Esc)"><X weight="thin" size={13} /></button>
            </div>
            {creatingKind === 'file' && (
              <>
                {/* ── Category tabs ── */}
                <div className="sidebar-creator-categories">
                  <button
                    type="button"
                    className={`sidebar-creator-cat${selectedCategory === 'canvas' ? ' active canvas' : ''}`}
                    onClick={() => selectCategory('canvas')}
                    title="Canvas (tldraw slide deck)"
                  >
                    <span className="scc-icon">◈</span>
                    <span className="scc-label">Canvas</span>
                  </button>
                  <button
                    type="button"
                    className={`sidebar-creator-cat${selectedCategory === 'text' ? ' active text' : ''}`}
                    onClick={() => selectCategory('text')}
                    title="Text / document file"
                  >
                    <span className="scc-icon">◎</span>
                    <span className="scc-label">Text</span>
                  </button>
                  <button
                    type="button"
                    className={`sidebar-creator-cat${selectedCategory === 'code' ? ' active code' : ''}`}
                    onClick={() => selectCategory('code')}
                    title="Code / source file"
                  >
                    <span className="scc-icon">&lt;/&gt;</span>
                    <span className="scc-label">Code</span>
                  </button>
                </div>

                {/* ── Sub-options for Text ── */}
                {selectedCategory === 'text' && (
                  <div className="sidebar-creator-subtypes">
                    {TEXT_TYPES.map((t) => (
                      <button
                        key={t.ext}
                        type="button"
                        className={`sidebar-type-pill${selectedExt === t.ext ? ' active' : ''}`}
                        onClick={() => { setSelectedExt(t.ext); setTimeout(() => createInputRef.current?.focus(), 0); }}
                      >{t.label}</button>
                    ))}
                  </div>
                )}

                {/* ── Sub-options for Code ── */}
                {selectedCategory === 'code' && (
                  <div className="sidebar-creator-subtypes">
                    {CODE_TYPES.map((t) => (
                      <button
                        key={t.ext}
                        type="button"
                        className={`sidebar-type-pill${selectedExt === t.ext ? ' active' : ''}`}
                        onClick={() => { setSelectedExt(t.ext); setTimeout(() => createInputRef.current?.focus(), 0); }}
                      >{t.label}</button>
                    ))}
                  </div>
                )}
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
              <button type="button" className="sidebar-btn-confirm" onClick={handleCreate}><Check weight="thin" size={13} /></button>
            </div>
          </div>
        )}
        <button
          className={`sidebar-btn sidebar-btn-sync${syncStatus !== 'idle' ? ` ${syncStatus}` : ''}${syncStatus === 'idle' && gitChangedCount > 0 ? ' has-changes' : ''}${!workspace.hasGit ? ' disabled-no-git' : ''}`}
          onClick={() => { if (workspace.hasGit) { setShowSyncModal(true); fetchGitCount(); } }}
          disabled={syncStatus === 'syncing' || !workspace.hasGit}
          title={workspace.hasGit ? 'Review git diff and commit + push' : 'Workspace local — sem git remoto'}
        >
          <span className="sidebar-sync-label">
            {!workspace.hasGit     && '⊘ Local'}
            {workspace.hasGit && syncStatus === 'idle'    && '⇅ Sync'}
            {workspace.hasGit && syncStatus === 'syncing' && '⇅ Syncing…'}
            {workspace.hasGit && syncStatus === 'done'    && <><Check weight="thin" size={13} />{' Synced'}</>}
            {workspace.hasGit && syncStatus === 'error'   && <><Warning weight="thin" size={13} />{' Sync failed'}</>}
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
              title="AI edits pending in this file"
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
              ><CaretLeft weight="thin" size={14} /></button>
              <span
                className="sidebar-ai-nav-pos"
                title="AI edit position"
              >{aiNavIndex + 1}/{aiNavCount}</span>
              <button
                className="sidebar-ai-nav-arrow"
                onClick={onAINext}
                disabled={aiNavCount < 2}
                title="Next AI edit"
              ><CaretRight weight="thin" size={14} /></button>
            </div>
          </div>
        )}
        {/* Custom workspace buttons */}
        {(workspace.config.sidebarButtons ?? []).map((btn: SidebarButton) => (
          <button
            key={btn.id}
            className="sidebar-btn sidebar-btn-custom"
            title={btn.description ?? btn.command}
            onClick={() => onRunButtonCommand?.(btn.command, btn.label)}
          >
            {btn.label}
          </button>
        ))}
        <button className="sidebar-btn sidebar-btn-images" onClick={onImageSearch}>
          ⊡ Images
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
        }}><span className="sidebar-ctx-icon">+</span> New file here</button>
        <button onClick={() => {
          const inPath = contextMenu.isDir
            ? contextMenu.path
            : (contextMenu.path.includes('/') ? contextMenu.path.substring(0, contextMenu.path.lastIndexOf('/')) : '');
          startCreating(inPath, 'folder');
        }}><span className="sidebar-ctx-icon"><FolderPlus weight="thin" size={13} /></span> New folder here</button>
        <div className="sidebar-context-separator" />
        <button onClick={() => {
          const name = contextMenu.path.split('/').pop() ?? contextMenu.path;
          startRename(contextMenu.path, name);
        }}><span className="sidebar-ctx-icon">✎</span> Rename</button>
        <button onClick={() => {
          revealItemInDir(`${workspace.path}/${contextMenu.path}`);
          setContextMenu(null);
        }}><span className="sidebar-ctx-icon">⊙</span> Show in Finder</button>
        <button onClick={() => {
          const dir = contextMenu.isDir
            ? contextMenu.path
            : (contextMenu.path.includes('/') ? contextMenu.path.substring(0, contextMenu.path.lastIndexOf('/')) : '');
          onOpenTerminalAt?.(dir);
          setContextMenu(null);
        }}><span className="sidebar-ctx-icon">$</span> Open in Terminal</button>
        {!contextMenu.isDir && (
          <button onClick={() => {
            navigator.clipboard.writeText(contextMenu.path).catch(() => {});
            setContextMenu(null);
          }}><span className="sidebar-ctx-icon"><Copy weight="thin" size={13} /></span> Copy path</button>
        )}
        <button onClick={() => {
          const folders = getAllFolders(workspace.fileTree, contextMenu.path);
          const pickerH = Math.min(folders.length * 32 + 88, 320);
          setMovePicker({ path: contextMenu.path, x: contextMenu.x, y: Math.min(contextMenu.y, window.innerHeight - pickerH - 6) });
          setContextMenu(null);
        }}><span className="sidebar-ctx-icon">→</span> Move to…</button>
        <div className="sidebar-context-separator" />
        {contextMenu.isDir
          ? <button onClick={() => handleDuplicateFolder(contextMenu.path)}><span className="sidebar-ctx-icon">⧉</span> Duplicate folder</button>
          : <button onClick={() => handleDuplicateFile(contextMenu.path)}><span className="sidebar-ctx-icon">⧉</span> Duplicate</button>
        }
        <div className="sidebar-context-separator" />
        <button className="sidebar-context-delete" onClick={() => handleDeleteFile(contextMenu.path)}><span className="sidebar-ctx-icon"><X weight="thin" size={13} /></span> Delete</button>
      </div>
    )}
    {/* ── Move-to folder picker ── */}
    {movePicker && (() => {
      const folders = getAllFolders(workspace.fileTree, movePicker.path);
      const name = movePicker.path.split('/').pop() ?? movePicker.path;
      return (
        <div
          className="sidebar-move-picker"
          style={{ left: movePicker.x, top: movePicker.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sidebar-move-picker-title">Move "{name}" to…</div>
          <div className="sidebar-move-picker-list">
            <button onClick={() => handleMoveToFolder(movePicker.path, '')}>
              <span className="sidebar-move-picker-icon"><FolderSimple weight="thin" size={13} /></span> / root
            </button>
            {folders.map((f) => (
              <button key={f} onClick={() => handleMoveToFolder(movePicker.path, f)}>
                <span className="sidebar-move-picker-icon"><FolderSimple weight="thin" size={13} /></span> {f}
              </button>
            ))}
            {folders.length === 0 && <div className="sidebar-move-picker-empty">No other folders</div>}
          </div>
          <button className="sidebar-move-picker-cancel" onClick={() => setMovePicker(null)}>Cancel</button>
        </div>
      );
    })()}
    </>
  );
}

