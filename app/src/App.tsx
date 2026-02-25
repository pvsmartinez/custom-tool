import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { copyFile } from '@tauri-apps/plugin-fs';
import Editor from './components/Editor';
import type { EditorHandle } from './components/Editor';
import AIPanel from './components/AIPanel';
import WorkspacePicker from './components/WorkspacePicker';
import SplashScreen from './components/SplashScreen';
import WorkspaceHome from './components/WorkspaceHome';
import Sidebar from './components/Sidebar';
import MarkdownPreview from './components/MarkdownPreview';
import WebPreview from './components/WebPreview';
import PDFViewer from './components/PDFViewer';
import MediaViewer from './components/MediaViewer';
import UpdateModal from './components/UpdateModal';
import SettingsModal from './components/SettingsModal';
import ExportModal from './components/ExportModal';
import ImageSearchPanel from './components/ImageSearchPanel';
import FindReplaceBar from './components/FindReplaceBar';
import AIMarkOverlay from './components/AIMarkOverlay';

import TabBar from './components/TabBar';
import BottomPanel from './components/BottomPanel';
import { useDragResize } from './hooks/useDragResize';
import { useTabManager } from './hooks/useTabManager';
import { useAutosave } from './hooks/useAutosave';
import { useFileWatcher } from './hooks/useFileWatcher';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { Editor as TldrawEditor, TLShapeId } from 'tldraw';
const CanvasEditor = lazy(() => import('./components/CanvasEditor'));
import { canvasAIContext, executeCanvasCommands } from './utils/canvasAI';
import { exportMarkdownToPDF } from './utils/exportPDF';
import { writeFile as writeBinaryFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import {
  readFile,
  writeFile,
  saveWorkspaceConfig,
  trackFileOpen,
  flatMdFiles,
  refreshFileTree,
} from './services/workspace';
import { loadMarks, addMark, addMarksBulk, saveMarks, markReviewed } from './services/aiMarks';
import { onLockedFilesChange, getLockedFiles } from './services/copilotLock';
import { loadWorkspaceSession, saveWorkspaceSession } from './services/workspaceSession';
import { getFileTypeInfo } from './utils/fileType';
import { generateId } from './utils/generateId';
import type { Workspace, AIEditMark, AppSettings, WorkspaceExportConfig } from './types';
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_KEY } from './types';
import './App.css';

function loadAppSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(APP_SETTINGS_KEY);
    if (saved) return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return DEFAULT_APP_SETTINGS;
}

const FALLBACK_CONTENT = `# Untitled Document\n\nStart writing here…\n`;

/** Build an AIEditMark for a canvas AI edit. */
function makeCanvasMark(relPath: string, shapeIds: string[], model: string): AIEditMark {
  return {
    id: generateId(),
    fileRelPath: relPath,
    text: `AI canvas edit — ${shapeIds.length} shape${shapeIds.length !== 1 ? 's' : ''}`,
    model,
    insertedAt: new Date().toISOString(),
    reviewed: false,
    canvasShapeIds: shapeIds,
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  // Read localStorage exactly once at mount — all useState/useRef initializers share this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initSettings = useMemo(loadAppSettings, []);

  // Splash screen — visible for ~700ms on first load, then fades out
  const [splash, setSplash] = useState(true);
  const [splashVisible, setSplashVisible] = useState(true);
  useEffect(() => {
    const t1 = setTimeout(() => setSplashVisible(false), 700);
    const t2 = setTimeout(() => setSplash(false), 1060);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // Keep window title = workspace name (tabs already show the active file)
  useEffect(() => {
    document.title = workspace ? workspace.name : 'Cafezin';
  }, [workspace?.name]);

  const [isAIStreaming, setIsAIStreaming] = useState(false);

  // ── Tab management (open files, switching, close, reorder) ───────────────
  const {
    tabs, setTabs, activeTabId, setActiveTabId, activeFile,
    previewTabId, setPreviewTabId,
    content, setContent, viewMode, setViewMode,
    tabContentsRef, tabViewModeRef, savedContentRef,
    activeTabIdRef, tabsRef,
    switchToTab, addTab, closeTab, closeAllTabs, closeOthers, closeToRight, reorderTabs,
    promoteTab, clearAll,
  } = useTabManager({ fallbackContent: FALLBACK_CONTENT });
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');
  const [canvasSlideCount, setCanvasSlideCount] = useState(0);
  const wordCount = useMemo(() => content.trim().split(/\s+/).filter(Boolean).length, [content]);
  const [fileStat, setFileStat] = useState<string | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'workspace' | 'sync'>('general');
  const [appSettings, setAppSettings] = useState<AppSettings>(() => initSettings);
  const [imgSearchOpen, setImgSearchOpen] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [aiMarks, setAiMarks] = useState<AIEditMark[]>([]);
  // Find + Replace bar (Ctrl/Cmd+F)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  // Pending jump: set by project search results; cleared after content loads
  const [pendingJumpText, setPendingJumpText] = useState<string | null>(null);
  const [pendingJumpLine, setPendingJumpLine] = useState<number | null>(null);
  // AI highlight toggle and nav
  const [aiHighlight, setAiHighlight] = useState(initSettings.aiHighlightDefault);
  const [aiNavIndex, setAiNavIndex] = useState(0);
  // Sidebar / panel visibility, mode and widths
  const [sidebarMode, setSidebarMode] = useState<'explorer' | 'search'>('explorer');
  const [sidebarOpen, setSidebarOpen] = useState(initSettings.sidebarOpenDefault);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(240);
  /** Changing this value tells BottomPanel to cd to the given absolute path. */
  const [terminalRequestCd, setTerminalRequestCd] = useState<string | undefined>();
  const [lockedFiles, setLockedFiles] = useState<Set<string>>(() => getLockedFiles());

  // Subscribe to Copilot file-lock changes
  useEffect(() => {
    const unsub = onLockedFilesChange((locked) => setLockedFiles(locked));
    return unsub;
  }, []);
  // ── Panel resize (sidebar ↔ editor ↔ AI panel) ───────────────────────────
  const { sidebarWidth, aiPanelWidth, startSidebarDrag, startAiDrag } = useDragResize();
  const { saveTimerRef, autosaveDelayRef, scheduleAutosave } = useAutosave({
    savedContentRef,
    setDirtyFiles,
    setSaveError: (err) => setSaveError(err as string | null),
    setWorkspace,
    initialDelay: initSettings.autosaveDelay,
  });
  // Visual "Saved ✓" toast
  const [savedToast, setSavedToast] = useState(false);
  const savedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Save error — set on any failed write, cleared on next successful write
  const [saveError, setSaveError] = useState<string | null>(null);
  // Pandoc PDF export
  const [pandocBusy, setPandocBusy] = useState(false);
  const [pandocError, setPandocError] = useState<string | null>(null);
  // Export / Build Settings modal
  const [exportModalOpen, setExportModalOpen] = useState(false);
  // Export lock — shown while auto-opening a canvas for export (blur + coffee animation)
  const [exportLock, setExportLock] = useState(false);
  const exportRestoreTabRef = useRef<string | null>(null);
  // Lets CanvasEditor expose an imperative flush so Cmd+S always saves the
  // latest snapshot even within the canvas's 500 ms debounce window.
  const forceSaveRef = useRef<(() => void) | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  // Ref to the editor-area container div (needed for AIMarkOverlay positioning)
  const editorAreaRef = useRef<HTMLDivElement>(null);
  // Holds the live tldraw Editor instance when a canvas file is open
  const canvasEditorRef = useRef<TldrawEditor | null>(null);
  // Lets CanvasEditor expose its rescanFrames() so AIPanel can force-sync
  // the slide strip immediately after canvas_op (belt-and-suspenders alongside
  // the debounced store listener).
  const rescanFramesRef = useRef<(() => void) | null>(null);
  // Always-fresh ref for dirty state so watcher can check without stale closure
  const dirtyFilesRef = useRef<Set<string>>(dirtyFiles);
  dirtyFilesRef.current = dirtyFiles;
  // Ref passed to Sidebar so ⌘T/⌘N can trigger new-file creation
  const newFileRef = useRef<(() => void) | null>(null);
  // Drag-drop from Finder
  const [dragOver, setDragOver] = useState(false);
  const [dragFiles, setDragFiles] = useState<string[]>([]);

  // Derived from active file
  const fileTypeInfo = activeFile ? getFileTypeInfo(activeFile) : null;

  // ── In-app update ───────────────────────────────────────────
  function handleUpdate() {
    setShowUpdateModal(true);
  }

  // Listen for the native menu "Update Cafezin…" event
  useEffect(() => {
    const unlisten = listen('menu-update-app', () => handleUpdate());
    return () => { unlisten.then((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for the native menu "Settings…" event (⌘,)
  useEffect(() => {
    const unlisten = listen('menu-settings', () => {
      setSettingsInitialTab('general');
      setShowSettings(true);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // First-launch sync prompt: if sync was never configured and user hasn't
  // dismissed it, open Settings directly on the Sync tab.
  useEffect(() => {
    const SKIP_KEY = 'cafezin-sync-onboarding-skipped';
    const alreadySkipped = localStorage.getItem(SKIP_KEY);
    const alreadyConnected = localStorage.getItem('cafezin-sync-account-token');
    if (!alreadySkipped && !alreadyConnected) {
      // Mark as shown so we don't prompt again
      localStorage.setItem(SKIP_KEY, '1');
      setSettingsInitialTab('sync');
      setShowSettings(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply/remove light theme class on body
  useEffect(() => {
    document.body.classList.toggle('theme-light', appSettings.theme === 'light');
  }, [appSettings.theme]);

  // Keep autosave delay ref in sync
  useEffect(() => {
    autosaveDelayRef.current = appSettings.autosaveDelay;
  }, [appSettings.autosaveDelay]);

  // Clear media/file stat when switching files
  useEffect(() => { setFileStat(null); }, [activeFile]);

  // ── Drag-and-drop from Finder ─────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent((event) => {
      const type = event.payload.type;
      if (type === 'enter' || type === 'over') {
        const paths: string[] = (event.payload as { paths?: string[] }).paths ?? [];
        // Ignore internal DOM drags (e.g. slide strip reorder) — they have no paths
        if (paths.length === 0) return;
        setDragFiles(paths);
        setDragOver(true);
      } else if (type === 'drop') {
        setDragOver(false);
        const paths: string[] = (event.payload as { paths?: string[] }).paths ?? [];
        if (paths.length > 0 && workspace) handleDroppedFiles(paths);
      } else {
        setDragOver(false);
        setDragFiles([]);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // ── Keep a stable ref to workspace so watcher callback always sees latest ───
  const workspaceRef = useRef<typeof workspace>(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

  // Persist tab + preview state per workspace (debounced, 800 ms)
  useEffect(() => {
    if (!workspace) return;
    const id = setTimeout(() => {
      saveWorkspaceSession(workspace.path, { tabs, activeTabId, previewTabId });
    }, 800);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.path, tabs, activeTabId, previewTabId]);

  // ── Reload active file from disk ───────────────────────────────────────────
  async function reloadActiveFile() {
    if (!workspace || !activeTabId) return;
    const info = getFileTypeInfo(activeTabId);
    if (info.kind === 'pdf' || info.kind === 'video' || info.kind === 'audio' || info.kind === 'image') return;
    try {
      const text = await readFile(workspace, activeTabId);
      savedContentRef.current.set(activeTabId, text);
      tabContentsRef.current.set(activeTabId, text);
      setContent(text);
      setDirtyFiles((prev) => { const next = new Set(prev); next.delete(activeTabId); return next; });
    } catch (err) {
      console.error('[reload] Failed to reload file:', err);
    }
  }

  // ── Keyboard shortcuts ───────────────────────────────────────
  useKeyboardShortcuts({
    aiOpen,
    activeTabId,
    tabs,
    fileTypeInfo,
    onOpenAI:        () => { setAiInitialPrompt(''); setAiOpen(true); },
    onCloseAI:       () => setAiOpen(false),
    onCloseTab:      handleCloseTab,
    onOpenSettings:  () => { setSettingsInitialTab('general'); setShowSettings(true); },
    onToggleSidebar: () => setSidebarOpen((v) => !v),
    onSave: async () => {
      const kind = fileTypeInfo?.kind;
      if (activeTabId && workspace && kind !== 'pdf' && kind !== 'video' && kind !== 'image') {
        if (kind === 'canvas') forceSaveRef.current?.();
        const current = tabContentsRef.current.get(activeTabId) ?? content;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        let textToSave = current;
        if (appSettings.formatOnSave !== false && fileTypeInfo?.language && kind !== 'canvas') {
          const formatted = await formatContent(current, fileTypeInfo.language);
          if (formatted !== current) {
            textToSave = formatted;
            tabContentsRef.current.set(activeTabId, formatted);
            setContent(formatted);
          }
        }
        writeFile(workspace, activeTabId, textToSave).then(() => {
          savedContentRef.current.set(activeTabId, textToSave);
          setDirtyFiles((prev) => { const s = new Set(prev); s.delete(activeTabId); return s; });
          setSaveError(null);
          setSavedToast(true);
          if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current);
          savedToastTimerRef.current = setTimeout(() => setSavedToast(false), 1800);
        }).catch((err) => {
          console.error('Manual save failed:', err);
          setSaveError(String((err as Error)?.message ?? err));
        });
      }
    },
    onReload:        reloadActiveFile,
    onNewFile:       () => { setSidebarOpen(true); setTimeout(() => newFileRef.current?.(), 80); },
    onSwitchTab:     switchToTab,
    onToggleFind:    () => setFindReplaceOpen((v) => !v),
    onGlobalSearch:  () => { setSidebarOpen(true); setSidebarMode('search'); },
    onTogglePreview: () => {
      if (fileTypeInfo?.supportsPreview) {
        setViewMode((v) => {
          const next = v === 'edit' ? 'preview' : 'edit';
          if (activeTabId) tabViewModeRef.current.set(activeTabId, next);
          return next;
        });
      }
    },
    onToggleTerminal: () => setTerminalOpen((v) => !v),
  });

  // ── Jump to text/line after project-search navigation ───────────────────────
  useEffect(() => {
    if ((pendingJumpText == null && pendingJumpLine == null) || !activeFile) return;
    // Use a short delay so the editor has mounted with the new content
    const t = setTimeout(() => {
      if (pendingJumpLine != null) { editorRef.current?.jumpToLine(pendingJumpLine); setPendingJumpLine(null); }
      else if (pendingJumpText)    { editorRef.current?.jumpToText(pendingJumpText);  setPendingJumpText(null); }
    }, 250);
    return () => clearTimeout(t);
  }, [content, pendingJumpText, pendingJumpLine, activeFile]);

  // ── Project search result open handler ──────────────────────────────────────
  const handleSearchFileOpen = useCallback(async (relPath: string, lineNo?: number, matchText?: string) => {
    await handleOpenFile(relPath);
    if (lineNo != null) setPendingJumpLine(lineNo);
    else if (matchText) setPendingJumpText(matchText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Format-on-save via Prettier standalone ──────────────────────────────────
  async function formatContent(code: string, language: string): Promise<string> {
    try {
      const prettier = await import('prettier/standalone');
      if (language === 'javascript' || language === 'jsx') {
        const [babel, estree] = await Promise.all([
          import('prettier/plugins/babel'),
          import('prettier/plugins/estree'),
        ]);
        return await prettier.format(code, { parser: 'babel', plugins: [babel, estree] });
      }
      if (language === 'typescript' || language === 'tsx') {
        const [ts, estree] = await Promise.all([
          import('prettier/plugins/typescript'),
          import('prettier/plugins/estree'),
        ]);
        return await prettier.format(code, { parser: 'typescript', plugins: [ts, estree] });
      }
      if (language === 'json') {
        const [babel, estree] = await Promise.all([
          import('prettier/plugins/babel'),
          import('prettier/plugins/estree'),
        ]);
        return await prettier.format(code, { parser: 'json', plugins: [babel, estree] });
      }
      if (language === 'css' || language === 'scss' || language === 'less') {
        const css = await import('prettier/plugins/postcss');
        return await prettier.format(code, { parser: 'css', plugins: [css] });
      }
      if (language === 'html') {
        const html = await import('prettier/plugins/html');
        return await prettier.format(code, { parser: 'html', plugins: [html] });
      }
    } catch { /* formatting failed — return original */ }
    return code;
  }

  // ── Workspace file tree refresh ────────────────────────────────────────────
  // Rebuilds files + fileTree and merges into workspace state.
  // Used after any operation that creates, deletes, or moves a file.
  const refreshWorkspace = useCallback(async (ws: Workspace) => {
    const fileTree = await refreshFileTree(ws);
    const files = flatMdFiles(fileTree);
    setWorkspace((prev) => prev ? { ...prev, files, fileTree } : prev);
  }, []);

  // ── File system watcher ────────────────────────────────────────────────────
  // Placed after refreshWorkspace to avoid temporal-dead-zone issues.
  useFileWatcher({
    watchPath: workspace?.path,
    workspaceRef,
    tabsRef,
    dirtyFilesRef,
    activeTabIdRef,
    tabContentsRef,
    savedContentRef,
    onRefresh: refreshWorkspace,
    setContent,
  });

  // ── Handle files dropped from Finder ─────────────────────────────────────────
  async function handleDroppedFiles(paths: string[]) {
    if (!workspace) return;
    const wsRoot = workspace.path;
    const opened: string[] = [];

    // When a canvas is active, the canvas's own capture-phase DOM drop handler
    // already saves image/media files to workspace/images/ and places them on
    // the canvas. The Tauri onDragDropEvent fires independently (OS-level) and
    // would *also* copy those same files to workspace root and open MediaViewer
    // tabs, navigating away from the canvas. Detect this case and skip entirely
    // for image/media files.
    const activeKind = activeTabIdRef.current
      ? getFileTypeInfo(activeTabIdRef.current).kind
      : null;
    const canvasIsActive = activeKind === 'canvas';

    for (const absPath of paths) {
      // Skip directories (no trailing slash check needed — Tauri only sends files)
      const name = absPath.split('/').pop();
      if (!name) continue;

      // Skip image/media files when canvas is active — canvas handled them already
      const dropKind = getFileTypeInfo(name).kind;
      if (canvasIsActive && (dropKind === 'image' || dropKind === 'video' || dropKind === 'audio')) {
        continue;
      }

      let relPath: string;

      if (absPath.startsWith(wsRoot + '/')) {
        // File is already inside the workspace — derive relative path
        relPath = absPath.slice(wsRoot.length + 1);
      } else {
        // File is outside — copy it into workspace root
        relPath = name;
        const dest = `${wsRoot}/${name}`;
        try {
          await copyFile(absPath, dest);
        } catch (err) {
          console.error('Failed to copy dropped file:', err);
          continue;
        }
        // Refresh workspace file tree after copy
        await refreshWorkspace(workspace);
      }

      opened.push(relPath);
    }

    // Open each file (handleOpenFile handles tabs + switching)
    for (const relPath of opened) {
      await handleOpenFile(relPath);
    }
  }

  // ── Tab management — thin wrappers around useTabManager ──────────────────
  // Auto-promote preview → permanent once the file is edited
  useEffect(() => {
    if (previewTabId && dirtyFiles.has(previewTabId)) promoteTab(previewTabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyFiles, previewTabId]);

  function handleCloseTab(filePath: string) {
    closeTab(filePath, (p) => {
      setDirtyFiles((prev) => { const next = new Set(prev); next.delete(p); return next; });
    });
  }

  function handleCloseAllTabs() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    closeAllTabs();
  }

  function handleCloseOthers(filePath: string) {
    closeOthers(filePath, (paths) => {
      setDirtyFiles((prev) => { const s = new Set(prev); paths.forEach((p) => s.delete(p)); return s; });
    });
  }

  function handleCloseToRight(filePath: string) {
    closeToRight(filePath, (paths) => {
      setDirtyFiles((prev) => { const s = new Set(prev); paths.forEach((p) => s.delete(p)); return s; });
    });
  }

  // ── Export helpers ──────────────────────────────────────────────────────────

  async function handleOpenFileForExport(relPath: string): Promise<void> {
    // If the canvas is already the active tab with a live editor, nothing to open
    if (relPath === activeFile && canvasEditorRef.current) return;

    exportRestoreTabRef.current = activeTabId;
    setExportLock(true);
    // Null the ref so we can detect the fresh mount below
    canvasEditorRef.current = null;

    try {
      await handleOpenFile(relPath);
      // Poll until tldraw Editor is mounted (key={activeFile} on CanvasEditor remounts on switch)
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (canvasEditorRef.current) { resolve(); return; }
          if (Date.now() - start > 10_000) { reject(new Error('Canvas editor did not mount in time')); return; }
          setTimeout(check, 80);
        };
        check();
      });
    } catch (e) {
      // Ensure lock is always cleared even when open/mount fails
      handleRestoreAfterExport();
      throw e;
    }
  }

  function handleRestoreAfterExport(): void {
    const prev = exportRestoreTabRef.current;
    if (prev) switchToTab(prev);
    exportRestoreTabRef.current = null;
    setExportLock(false);
  }

  async function handleExportConfigChange(config: WorkspaceExportConfig): Promise<void> {
    if (!workspace) return;
    const updated: Workspace = { ...workspace, config: { ...workspace.config, exportConfig: config } };
    setWorkspace(updated);
    try { await saveWorkspaceConfig(updated); } catch (e) { console.error('Failed to save export config:', e); }
  }

  // ── File open ────────────────────────────────────────────────────────────────
  async function handleOpenFile(filename: string) {
    if (!workspace) return;

    // If already open in a tab, just focus it
    if (tabsRef.current.includes(filename)) {
      switchToTab(filename);
      return;
    }

    const info = getFileTypeInfo(filename);

    // Binary/non-text files: no content to read — register tab and switch
    if (info.kind === 'pdf' || info.kind === 'video' || info.kind === 'audio' || info.kind === 'image') {
      tabContentsRef.current.set(filename, '');
      tabViewModeRef.current.set(filename, info.defaultMode as 'edit' | 'preview');
      addTab(filename);
      switchToTab(filename);
      trackFileOpen(workspace, filename).then(setWorkspace).catch(() => {});
      return;
    }

    try {
      const text = await readFile(workspace, filename);
      savedContentRef.current.set(filename, text);
      tabContentsRef.current.set(filename, text);
      tabViewModeRef.current.set(filename, info.defaultMode as 'edit' | 'preview');
      addTab(filename);
      switchToTab(filename);
      trackFileOpen(workspace, filename).then(setWorkspace).catch(() => {});
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }

  // ── File create (delegated to Sidebar) ────────────────────────────────────
  // Note: Sidebar handles workspace mutations (files + fileTree) itself via onWorkspaceChange.

  function handleWorkspaceChange(ws: Workspace) {
    const isSameWorkspace = workspace?.path === ws.path;
    setWorkspace(ws);
    // On workspace switch, close all tabs and go to home
    if (!isSameWorkspace) clearAll();
  }

  // scheduleAutosave is provided by useAutosave (declared near useDragResize)

  // ── Auto-save (debounced 1s) ─────────────────────────────────
  const handleContentChange = useCallback(
    (newContent: string) => {
      // Canvas files are self-managed by tldraw — never feed changed JSON back
      // into React state or tldraw will see the `snapshot` prop change and reset.
      if (!activeFile?.endsWith('.tldr.json')) setContent(newContent);
      // Keep per-tab content ref in sync so switching away/back is lossless
      if (activeFile) tabContentsRef.current.set(activeFile, newContent);
      if (!workspace || !activeFile) return;

      // Auto-remove AI marks whose text no longer exists in the document.
      // This covers the case where a human types over an AI-inserted chunk.
      setAiMarks((prev) => {
        const fileMarks = prev.filter(
          (m) => m.fileRelPath === activeFile && !m.reviewed,
        );
        const toRemove = fileMarks
          .filter((m) => !newContent.includes(m.text))
          .map((m) => m.id);
        if (toRemove.length === 0) return prev;
        const updated = prev.map((m) =>
          toRemove.includes(m.id)
            ? { ...m, reviewed: true, reviewedAt: new Date().toISOString() }
            : m,
        );
        // Persist asynchronously
        saveMarks(workspace, updated).catch(() => {});
        return updated;
      });

      scheduleAutosave(workspace, activeFile, newContent);
    },
    [workspace, activeFile, scheduleAutosave]
  );

  // ── App settings persistence ─────────────────────────────────
  function handleAppSettingsChange(settings: AppSettings) {
    setAppSettings(settings);
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  }

  // ── Clear dirty state after a successful sync ─────────────────
  const handleSyncComplete = useCallback(() => {
    setDirtyFiles(new Set());
  }, []);

  // ── Retry a failed save — invoked by the ⚠ banner in the header ─────────────
  function handleRetrySave() {
    if (!activeTabId || !workspace) return;
    if (fileTypeInfo?.kind === 'canvas') forceSaveRef.current?.();
    const current = tabContentsRef.current.get(activeTabId) ?? content;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    writeFile(workspace, activeTabId, current)
      .then(() => {
        savedContentRef.current.set(activeTabId, current);
        setDirtyFiles((prev) => { const s = new Set(prev); s.delete(activeTabId); return s; });
        setSaveError(null);
        setSavedToast(true);
        if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current);
        savedToastTimerRef.current = setTimeout(() => setSavedToast(false), 1800);
      })
      .catch((err) => setSaveError(String((err as Error)?.message ?? err)));
  }

  // ── Export current markdown to PDF (pure-JS, no system deps) ────────────────
  async function handleExportPDF() {
    if (!workspace || !activeFile) return;
    const outRelPath = activeFile.replace(/\.[^/.]+$/, '') + '.pdf';
    const outAbsPath = `${workspace.path}/${outRelPath}`;
    setPandocBusy(true);
    setPandocError(null);
    try {
      await exportMarkdownToPDF(content, outAbsPath, workspace.path);
      // Refresh sidebar so the PDF appears in the file tree
      await refreshWorkspace(workspace);
      await handleOpenFile(outRelPath);
    } catch (err) {
      setPandocError(String((err as Error)?.message ?? err));
    } finally {
      setPandocBusy(false);
    }
  }

  // ── Clipboard image paste (from Editor) ─────────────────────────────
  const handleEditorImagePaste = useCallback(async (file: File): Promise<string | null> => {
    if (!workspace) return null;
    try {
      const imagesDir = `${workspace.path}/images`;
      if (!(await exists(imagesDir))) {
        await mkdir(imagesDir, { recursive: true });
      }
      // Derive extension (png / jpeg → jpg / gif / webp etc.)
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const filename = `paste-${Date.now()}.${ext}`;
      const absPath = `${imagesDir}/${filename}`;
      const buf = await file.arrayBuffer();
      await writeBinaryFile(absPath, new Uint8Array(buf));
      // Refresh sidebar so the new file appears in the tree
      await refreshWorkspace(workspace);
      return `images/${filename}`;
    } catch (err) {
      console.error('Image paste save failed:', err);
      return null;
    }
  }, [workspace, refreshWorkspace]);
  // ── AI request from editor (⌘K selection) ───────────────────
  const handleAIRequest = useCallback((selectedText: string) => {
    setAiInitialPrompt(
      selectedText ? `Help me improve this:\n\n${selectedText}` : ''
    );
    setAiOpen(true);
  }, []);

  // ── Preferred model persistence ──────────────────────────────
  const handleModelChange = useCallback(async (newModel: string) => {
    if (!workspace) return;
    const updated = { ...workspace, config: { ...workspace.config, preferredModel: newModel } };
    setWorkspace(updated);
    try { await saveWorkspaceConfig(updated); } catch (err) { console.error('Failed to save model pref:', err); }
  }, [workspace]);

  const handleFileWritten = useCallback(async (_path: string) => {
    if (!workspace) return;
    try {
      await refreshWorkspace(workspace);
    } catch (err) {
      console.error('Failed to refresh workspace after file write:', err);
    }
  }, [workspace, refreshWorkspace]);

  // ── AI canvas mark recording (agent canvas_op path) ─────────────────────
  const handleCanvasMarkRecorded = useCallback((relPath: string, shapeIds: string[], aiModel: string) => {
    if (!workspace || shapeIds.length === 0) return;
    const mark = makeCanvasMark(relPath, shapeIds, aiModel);
    addMark(workspace, mark).then(setAiMarks).catch(() => {});
  }, [workspace]);

  // ── AI mark recording (agent write_workspace_file path) ──────────────────
  const handleMarkRecorded = useCallback((relPath: string, written: string, aiModel: string) => {
    if (!workspace) return;
    // Canvas files are tracked via canvasShapeIds (handleCanvasMarkRecorded),
    // not by text position — skip text-based marks for .tldr.json files.
    if (relPath.endsWith('.tldr.json')) return;
    // Split the written content into meaningful chunks so the user reviews
    // paragraph-sized pieces rather than the whole file at once.
    // Each chunk must appear verbatim in the document for jumpToText to work.
    const MIN_CHUNK = 40;
    const MAX_CHUNKS = 12;
    const chunks = written
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length >= MIN_CHUNK)
      .slice(0, MAX_CHUNKS);
    if (chunks.length === 0) return; // nothing meaningful to mark
    const now = new Date().toISOString();
    const newMarks = chunks.map((text) => ({
      id: generateId(),
      fileRelPath: relPath,
      text,
      model: aiModel,
      insertedAt: now,
      reviewed: false,
    }));
    addMarksBulk(workspace, newMarks).then(setAiMarks).catch(() => {});
    // Update editor view if the file is currently open
    const currentActiveFile = activeTabIdRef.current;
    const currentTabs = tabsRef.current;
    if (relPath === currentActiveFile) {
      setContent(written);
      savedContentRef.current.set(relPath, written);
      tabContentsRef.current.set(relPath, written);
      setDirtyFiles((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
    } else if (currentTabs.includes(relPath)) {
      tabContentsRef.current.set(relPath, written);
      savedContentRef.current.set(relPath, written);
    }
  }, [workspace]);

  // ── Insert from AI ───────────────────────────────────────────
  // Canvas: parse the ```canvas``` block from the AI response and execute
  // commands against the live editor.  Text files: append to the document.
  const handleInsert = useCallback((text: string, model: string) => {
    const kind = activeFile ? getFileTypeInfo(activeFile).kind : null;
    // Read-only file types — inserting text would corrupt the file
    if (kind === 'pdf' || kind === 'video' || kind === 'audio' || kind === 'image') return;
    if (kind === 'canvas') {
      if (canvasEditorRef.current && activeFile) {
        const { shapeIds } = executeCanvasCommands(canvasEditorRef.current, text);
        // Record a canvas AI mark with the created shape IDs
        if (shapeIds.length > 0 && workspace) {
          addMark(workspace, makeCanvasMark(activeFile, shapeIds, model)).then(setAiMarks).catch(() => {});
        }
      }
      return;
    }
    let newContent = '';
    setContent((prev) => {
      newContent = prev + (prev.endsWith('\n') ? '\n' : '\n\n') + text;
      // Keep tab ref consistent immediately inside the setter
      if (activeFile) tabContentsRef.current.set(activeFile, newContent);
      return newContent;
    });
    // Schedule auto-save and record AI edit provenance
    if (workspace && activeFile) {
      scheduleAutosave(workspace, activeFile, newContent);
      const mark: AIEditMark = {
        id: generateId(),
        fileRelPath: activeFile,
        text,
        model,
        insertedAt: new Date().toISOString(),
        reviewed: false,
      };
      addMark(workspace, mark).then(setAiMarks).catch(() => {});
    }
  }, [workspace, activeFile, scheduleAutosave]);

  // ── AI mark review ───────────────────────────────────────────
  const handleMarkReviewed = useCallback((id: string) => {
    if (!workspace) return;
    markReviewed(workspace, id).then(setAiMarks).catch(() => {});
  }, [workspace]);

  // ── Mark ALL unreviewed marks as reviewed (human review done) ─────────────
  const handleReviewAllMarks = useCallback(() => {
    if (!workspace) return;
    const now = new Date().toISOString();
    setAiMarks((prev) => {
      const updated = prev.map((m) =>
        m.reviewed ? m : { ...m, reviewed: true, reviewedAt: now },
      );
      saveMarks(workspace, updated).catch(() => {});
      return updated;
    });
  }, [workspace]);

  // ── Canvas AI mark user-edit: remove the mark when user touches the shape ──
  const handleMarkUserEdited = useCallback((markId: string) => {
    if (!workspace) return;
    markReviewed(workspace, markId).then(setAiMarks).catch(() => {});
  }, [workspace]);

  // ── AI nav (prev/next within active file) ────────────────────
  const activeFileMarks = aiMarks.filter(
    (m) => m.fileRelPath === activeFile && !m.reviewed,
  );

  const handleAINavNext = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex + 1) % activeFileMarks.length;
    setAiNavIndex(idx);
    const mark = activeFileMarks[idx];
    if (mark.canvasShapeIds?.length && canvasEditorRef.current) {
      const bounds = canvasEditorRef.current.getShapePageBounds(mark.canvasShapeIds[0] as TLShapeId);
      if (bounds) canvasEditorRef.current.zoomToBounds(bounds, { animation: { duration: 300 }, inset: 60 });
    } else {
      editorRef.current?.jumpToText(mark.text);
    }
  }, [activeFileMarks, aiNavIndex]);

  const handleAINavPrev = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex - 1 + activeFileMarks.length) % activeFileMarks.length;
    setAiNavIndex(idx);
    const mark = activeFileMarks[idx];
    if (mark.canvasShapeIds?.length && canvasEditorRef.current) {
      const bounds = canvasEditorRef.current.getShapePageBounds(mark.canvasShapeIds[0] as TLShapeId);
      if (bounds) canvasEditorRef.current.zoomToBounds(bounds, { animation: { duration: 300 }, inset: 60 });
    } else {
      editorRef.current?.jumpToText(mark.text);
    }
  }, [activeFileMarks, aiNavIndex]);

  // Reset nav index when file changes
  useEffect(() => { setAiNavIndex(0); }, [activeFile]);

  // AI document context: for canvas, send live shape summary + command protocol
  const aiDocumentContext = (() => {
    if (fileTypeInfo?.kind === 'canvas') {
      return canvasEditorRef.current
        ? canvasAIContext(canvasEditorRef.current, activeFile ?? '')
        : `Canvas file: ${activeFile ?? ''} (loading…)`;
    }
    return content;
  })();
  // ── File deleted ────────────────────────────────────────
  function handleFileDeleted(relPath: string) {
    if (tabs.includes(relPath)) {
      handleCloseTab(relPath);
    }
  }
  // ── Switch workspace ────────────────────────────────────
  function handleSwitchWorkspace() {
    const hasDirty = dirtyFiles.size > 0;
    if (isAIStreaming) {
      const ok = window.confirm(
        'Copilot is currently running. Close the workspace anyway?'
      );
      if (!ok) return;
    } else if (hasDirty) {
      const unsavedList = Array.from(dirtyFiles).join(', ');
      const ok = window.confirm(
        `You have unsaved changes in: ${unsavedList}\n\nClose the workspace anyway?`
      );
      if (!ok) return;
    }
    // Cancel any pending auto-save and clear all tabs
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    clearAll();
    setWorkspace(null);
    setDirtyFiles(new Set());
    setAiMarks([]);
    setIsAIStreaming(false);
  }
  // ── Workspace loaded ─────────────────────────────────────────
  async function handleWorkspaceLoaded(ws: Workspace) {
    // Clear any previous workspace state
    clearAll();
    setWorkspace(ws);
    // Load AI edit marks for this workspace
    loadMarks(ws).then(setAiMarks).catch(() => setAiMarks([]));

    // Restore last session (open tabs + active file)
    const session = loadWorkspaceSession(ws.path);
    if (session.tabs.length > 0) {
      const restored: string[] = [];
      for (const filePath of session.tabs) {
        const info = getFileTypeInfo(filePath);
        if (info.kind === 'pdf' || info.kind === 'video' || info.kind === 'audio' || info.kind === 'image') {
          tabContentsRef.current.set(filePath, '');
          tabViewModeRef.current.set(filePath, info.defaultMode as 'edit' | 'preview');
          restored.push(filePath);
        } else {
          try {
            const text = await readFile(ws, filePath);
            savedContentRef.current.set(filePath, text);
            tabContentsRef.current.set(filePath, text);
            tabViewModeRef.current.set(filePath, info.defaultMode as 'edit' | 'preview');
            restored.push(filePath);
          } catch { /* file deleted since last session — skip */ }
        }
      }
      if (restored.length > 0) {
        setTabs(restored);
        const preview = session.previewTabId && restored.includes(session.previewTabId)
          ? session.previewTabId : null;
        setPreviewTabId(preview);
        const activeId = session.activeTabId && restored.includes(session.activeTabId)
          ? session.activeTabId : restored[restored.length - 1];
        setActiveTabId(activeId);
        setContent(tabContentsRef.current.get(activeId) ?? '');
        setViewMode(tabViewModeRef.current.get(activeId) ?? (getFileTypeInfo(activeId).defaultMode as 'edit' | 'preview'));
      }
    }
  }

  const title = activeFile
    ? (content.match(/^#\s+(.+)$/m)?.[1] ?? activeFile)
    : workspace?.name ?? 'Untitled';

  // ── No workspace yet — show picker ──────────────────────────
  if (!workspace) {
    return (
      <>
        {splash && <SplashScreen visible={splashVisible} />}
        <WorkspacePicker onOpen={handleWorkspaceLoaded} />
        <UpdateModal
          open={showUpdateModal}
          projectRoot={__PROJECT_ROOT__}
          onClose={() => setShowUpdateModal(false)}
        />
      </>
    );
  }

  return (
    <div className="app">
      {splash && <SplashScreen visible={splashVisible} />}
      {/* Header */}
      <header className="app-header">
        <div className="app-header-left">
          {/* Sidebar toggle */}
          <button
            className={`app-sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            ☰
          </button>
          <span className="app-logo">✦</span>
          {/* Home button — deselects active tab, goes to home view */}
          {activeFile && (
            <button
              className="app-home-btn"
              onClick={() => switchToTab(null)}
              title="Go to workspace home"
            >
              ⌂
            </button>
          )}
          {activeFile ? (
            <nav className="app-breadcrumb" title={activeFile}>
              {activeFile.split('/').map((seg, i, arr) => (
                <span key={i} className="app-breadcrumb-seg">
                  {i > 0 && <span className="app-breadcrumb-sep">›</span>}
                  <span className={i === arr.length - 1 ? 'app-breadcrumb-file' : 'app-breadcrumb-dir'}>
                    {seg}
                  </span>
                </span>
              ))}
            </nav>
          ) : (
            <span className="app-title">{title}</span>
          )}
          {workspace.config.name && !activeFile && (
            <span className="app-workspace-name">{workspace.config.name}</span>
          )}
        </div>
        <div className="app-header-right">
          {(fileTypeInfo?.kind === 'markdown' || fileTypeInfo?.kind === 'canvas' || (fileTypeInfo?.kind === 'code' && fileTypeInfo.supportsPreview)) && (
            <div className="app-view-toggle">
              <button
                className={`app-view-btn ${viewMode === 'edit' ? 'active' : ''}`}
                onClick={() => { setViewMode('edit'); if (activeTabId) tabViewModeRef.current.set(activeTabId, 'edit'); }}
                title="Edit mode (⌘⇧P to toggle)"
              >
                Edit
              </button>
              <button
                className={`app-view-btn ${viewMode === 'preview' ? 'active' : ''}`}
                onClick={() => { setViewMode('preview'); if (activeTabId) tabViewModeRef.current.set(activeTabId, 'preview'); }}
                title={fileTypeInfo?.kind === 'canvas' ? 'Present — keyboard: ←→ to navigate, Esc to exit' : fileTypeInfo?.kind === 'code' ? 'Preview in browser (⌘⇧P to toggle)' : 'Preview rendered markdown (⌘⇧P to toggle)'}
              >
                {fileTypeInfo?.kind === 'canvas' ? 'Present' : 'Preview'}
              </button>
            </div>
          )}
          {/* Export to PDF via pandoc — markdown files only */}
          {fileTypeInfo?.kind === 'markdown' && (
            <button
              className={`app-export-pdf-btn${pandocBusy ? ' busy' : ''}`}
              onClick={handleExportPDF}
              disabled={pandocBusy}
              title="Export to PDF via pandoc (saves alongside source file)"
            >
              {pandocBusy ? 'Exporting…' : '↓ PDF'}
            </button>
          )}
          {/* Export / Build Settings — always available when workspace open */}
          {workspace && (
            <button
              className="app-export-btn"
              onClick={() => setExportModalOpen(true)}
              title="Export / Build Settings"
            >
              ⍈ Export
            </button>
          )}
          {(() => {
            const kind = fileTypeInfo?.kind;
            if (fileStat && (kind === 'video' || kind === 'audio' || kind === 'image' || kind === 'pdf'))
              return <span className="app-wordcount">{fileStat}</span>;
            if (kind === 'markdown' && appSettings.showWordCount)
              return <span className="app-wordcount">{wordCount.toLocaleString()} words</span>;
            if (kind === 'canvas' && canvasSlideCount > 0)
              return <span className="app-wordcount">{canvasSlideCount} slide{canvasSlideCount !== 1 ? 's' : ''}</span>;
            if (kind === 'code' && content)
              return <span className="app-wordcount">{content.split('\n').length.toLocaleString()} lines</span>;
            return null;
          })()}
          {/* Save state indicators — shown only when a saveable file is active */}
          {activeTabId && fileTypeInfo && !['pdf','video','audio','image'].includes(fileTypeInfo.kind ?? '') && (
            saveError ? (
              <span
                className="app-save-error"
                title={`Save failed: ${saveError}\nPress ⌘S to retry`}
                onClick={handleRetrySave}
              >
                ⚠ Save failed — click to retry
              </span>
            ) : dirtyFiles.has(activeTabId) && !savedToast ? (
              <span className="app-unsaved" title="Unsaved changes — ⌘S to save">● Unsaved</span>
            ) : null
          )}
          {savedToast && <span className="app-saved-toast">Saved ✓</span>}
          {pandocError && (
            <span
              className="app-save-error"
              title={pandocError}
              onClick={() => setPandocError(null)}
            >
              ⚠ {pandocError.length > 45 ? pandocError.slice(0, 45) + '…' : pandocError}
            </span>
          )}
          <button
            className="app-devtools-btn"
            onClick={() => invoke('open_devtools')}
            title="Open DevTools console"
          >
            DevTools
          </button>
          <button
            className={`app-ai-toggle ${aiOpen ? 'active' : ''}`}
            onClick={() => setAiOpen((v) => !v)}
            title="Toggle Copilot panel (⌘K)"
          >
            ✦ Copilot
          </button>
        </div>
      </header>

      {/* Tab bar — visible when any files are open */}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        dirtyFiles={dirtyFiles}
        lockedFiles={lockedFiles}
        previewTabId={previewTabId}
        workspacePath={workspace.path}
        onSelect={switchToTab}
        onClose={handleCloseTab}
        onCloseOthers={handleCloseOthers}
        onCloseToRight={handleCloseToRight}
        onCloseAll={handleCloseAllTabs}
        onPromoteTab={promoteTab}
        onReorder={reorderTabs}
      />

      {/* Workspace: editor body + bottom terminal panel */}
      <div className="app-workspace">
      {/* Main 3-column body */}
      <div className="app-body">
        {sidebarOpen && (
          <>
            <Sidebar
              workspace={workspace}
              activeFile={activeFile}
              dirtyFiles={dirtyFiles}
              aiMarks={aiMarks}
              aiNavCount={activeFileMarks.length}
              aiNavIndex={aiNavIndex}
              style={{ width: sidebarWidth }}
              onFileSelect={handleOpenFile}
              onWorkspaceChange={handleWorkspaceChange}
              onUpdate={handleUpdate}
              onSyncComplete={handleSyncComplete}
              onImageSearch={() => setImgSearchOpen(true)}
              sidebarMode={sidebarMode}
              onSidebarModeChange={setSidebarMode}
              onReviewAllMarks={handleReviewAllMarks}
              onOpenAIReview={() => {
                setAiHighlight(true);
                setAiNavIndex(0);
                if (activeFileMarks.length > 0) {
                  const m = activeFileMarks[0];
                  if (m.canvasShapeIds?.length && canvasEditorRef.current) {
                    const bounds = canvasEditorRef.current.getShapePageBounds(m.canvasShapeIds[0] as TLShapeId);
                    if (bounds) canvasEditorRef.current.zoomToBounds(bounds, { animation: { duration: 300 }, inset: 60 });
                  } else {
                    setTimeout(() => editorRef.current?.jumpToText(m.text), 120);
                  }
                }
              }}
              onAIPrev={handleAINavPrev}
              onAINext={handleAINavNext}
              onSwitchWorkspace={handleSwitchWorkspace}
              onFileDeleted={handleFileDeleted}
              onSearchFileOpen={handleSearchFileOpen}
              lockedFiles={lockedFiles}
              newFileRef={newFileRef}
              onOpenTerminalAt={(relDir) => {
                const absDir = relDir ? `${workspace.path}/${relDir}` : workspace.path;
                setTerminalOpen(true);
                setTerminalRequestCd(absDir + '|' + Date.now());
              }}
            />
            {/* Sidebar resize handle */}
            <div className="resize-divider" onMouseDown={startSidebarDrag} />
          </>
        )}

        {/* ── Editor area ─ has position:relative for FindReplaceBar overlay ─ */}
        <div className="editor-area" ref={editorAreaRef}>
          {/* Copilot lock overlay — shown while agent is writing the active file */}
          {activeFile && lockedFiles.has(activeFile) && (
            <div className="copilot-lock-overlay" aria-hidden>
              <span className="copilot-lock-label">writing…</span>
            </div>
          )}
          {/* Export lock overlay — shown while auto-opening canvas for export */}
          {exportLock && (
            <div className="copilot-lock-overlay" aria-hidden>
              <span className="copilot-lock-label">exporting…</span>
            </div>
          )}
          <FindReplaceBar
            open={findReplaceOpen}
            onClose={() => setFindReplaceOpen(false)}
            editorRef={editorRef}
            canvasEditor={canvasEditorRef.current}
            fileKind={fileTypeInfo?.kind ?? null}
          />

        {/* ── Active file viewer ─ key triggers CSS fade on every file switch ── */}
        <div key={activeFile ?? ''} className="editor-file-view">
        {fileTypeInfo?.kind === 'pdf' && activeFile ? (
          <PDFViewer
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
            onStat={setFileStat}
          />
        ) : (fileTypeInfo?.kind === 'video' || fileTypeInfo?.kind === 'audio' || fileTypeInfo?.kind === 'image') && activeFile ? (
          <MediaViewer
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
            kind={fileTypeInfo.kind}
            onStat={setFileStat}
          />
        ) : fileTypeInfo?.kind === 'canvas' && activeFile ? (
          <Suspense fallback={<div className="canvas-loading">Loading canvas…</div>}>
          <CanvasEditor
            key={activeFile}
            content={content}
            onChange={handleContentChange}
            workspacePath={workspace.path}
            onEditorReady={(tldrawEd) => { canvasEditorRef.current = tldrawEd; }}
            onSlideCountChange={setCanvasSlideCount}
            presentMode={viewMode === 'preview'}
            onPresentModeChange={(presenting) => {
              const mode = presenting ? 'preview' : 'edit';
              setViewMode(mode);
              if (activeTabId) tabViewModeRef.current.set(activeTabId, mode);
            }}
            aiMarks={activeFileMarks}
            aiHighlight={aiHighlight}
            aiNavIndex={aiNavIndex}
            onAIPrev={handleAINavPrev}
            onAINext={handleAINavNext}
            onMarkReviewed={handleMarkReviewed}
            onMarkUserEdited={handleMarkUserEdited}
            rescanFramesRef={rescanFramesRef}
            forceSaveRef={forceSaveRef}
            darkMode={appSettings.theme === 'dark'}
            onFileSaved={() => handleFileWritten(activeFile ?? '')}
            canvasRelPath={activeFile ?? undefined}
          />
          </Suspense>
        ) : !activeFile ? (
          <WorkspaceHome
            workspace={workspace}
            onOpenFile={handleOpenFile}
            aiMarks={aiMarks}
            onOpenAIReview={() => { setAiHighlight(true); setAiNavIndex(0); }}
          />
        ) : viewMode === 'preview' && fileTypeInfo?.kind === 'markdown' ? (
          <MarkdownPreview content={content} />
        ) : viewMode === 'preview' && fileTypeInfo?.kind === 'code' && fileTypeInfo.supportsPreview && activeFile && workspace ? (
          <WebPreview
            content={content}
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
          />
        ) : (
          <Editor
            key={activeFile ?? 'none'}
            ref={editorRef}
            content={content}
            onChange={handleContentChange}
            onAIRequest={handleAIRequest}
            aiMarks={activeFileMarks.map(m => ({ id: m.id, text: m.text }))}
            onAIMarkEdited={handleMarkReviewed}
            fontSize={appSettings.editorFontSize}
            onImagePaste={handleEditorImagePaste}
            language={fileTypeInfo?.language}
            isDark={appSettings.theme === 'dark'}
          />
        )}
        </div> {/* end editor-file-view */}

        {/* AI mark hover overlay — text/markdown/code editors only, edit mode only */}
        {aiHighlight && viewMode === 'edit' && activeFileMarks.length > 0 &&
          !['pdf', 'video', 'image', 'canvas'].includes(fileTypeInfo?.kind ?? '') && (
          <AIMarkOverlay
            visible={aiHighlight}
            marks={activeFileMarks}
            editorRef={editorRef}
            containerRef={editorAreaRef}
            onReview={handleMarkReviewed}
          />
        )}

        </div> {/* end editor-area */}



        {/* AI panel resize handle — only visible when open */}
        {aiOpen && <div className="resize-divider" onMouseDown={startAiDrag} />}
        <AIPanel
          isOpen={aiOpen}
          onClose={() => setAiOpen(false)}
          initialPrompt={aiInitialPrompt}
          initialModel={workspace.config.preferredModel}
          onModelChange={handleModelChange}
          onInsert={handleInsert}
          documentContext={aiDocumentContext}
          agentContext={workspace.agentContext}
          workspacePath={workspace.path}
          workspace={workspace}
          canvasEditorRef={canvasEditorRef}
          onFileWritten={handleFileWritten}
          onMarkRecorded={handleMarkRecorded}
          onCanvasMarkRecorded={handleCanvasMarkRecorded}
          activeFile={activeFile ?? undefined}
          rescanFramesRef={rescanFramesRef}
          aiMarks={activeFileMarks}
          aiMarkIndex={aiNavIndex}
          onAIMarkPrev={handleAINavPrev}
          onAIMarkNext={handleAINavNext}
          onAIMarkReview={handleMarkReviewed}
          onStreamingChange={setIsAIStreaming}
          style={aiOpen ? { width: aiPanelWidth } : undefined}
          screenshotTargetRef={editorAreaRef}
          workspaceExportConfig={workspace.config.exportConfig}
          onExportConfigChange={handleExportConfigChange}
        />

        {/* Drag-and-drop overlay — shown while dragging files from Finder */}
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-overlay-inner">
              <span className="drop-overlay-icon">⇣</span>
              <span className="drop-overlay-label">
                {dragFiles.length > 0
                  ? dragFiles.map((p) => p.split('/').pop()).join(', ')
                  : 'Drop to open'}
              </span>
            </div>
          </div>
        )}
      </div> {/* end app-body */}

      <BottomPanel
        workspacePath={workspace.path}
        open={terminalOpen}
        height={terminalHeight}
        onToggle={() => setTerminalOpen((v) => !v)}
        onHeightChange={setTerminalHeight}
        requestCd={terminalRequestCd}
      />
      </div> {/* end app-workspace */}

      <UpdateModal
        open={showUpdateModal}
        projectRoot={__PROJECT_ROOT__}
        onClose={() => setShowUpdateModal(false)}
      />

      <SettingsModal
        open={showSettings}
        appSettings={appSettings}
        workspace={workspace}
        onAppSettingsChange={handleAppSettingsChange}
        onWorkspaceChange={(ws) => { setWorkspace(ws); }}
        onClose={() => setShowSettings(false)}
        initialTab={settingsInitialTab}
      />

      {exportModalOpen && workspace && (
        <ExportModal
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          canvasEditorRef={canvasEditorRef}
          activeCanvasRel={activeFile?.endsWith('.tldr.json') ? activeFile : null}
          onOpenFileForExport={handleOpenFileForExport}
          onRestoreAfterExport={handleRestoreAfterExport}
          onClose={() => setExportModalOpen(false)}
        />
      )}

      {imgSearchOpen && workspace && (
        <ImageSearchPanel
          workspace={workspace}
          canvasEditorRef={canvasEditorRef}
          onClose={() => setImgSearchOpen(false)}
        />
      )}


    </div>
  );
}

