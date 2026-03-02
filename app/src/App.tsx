import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { copyFile, writeFile as writeBinaryFile, mkdir, exists } from './services/fs';
import Editor from './components/Editor';
import type { EditorHandle } from './components/Editor';
import AIPanel from './components/AIPanel';
import type { AIPanelHandle } from './components/AIPanel';
import { CanvasErrorBoundary } from './components/CanvasErrorBoundary';
import { EditorErrorBoundary } from './components/EditorErrorBoundary';
import WorkspacePicker from './components/WorkspacePicker';
import SplashScreen from './components/SplashScreen';
import WorkspaceHome from './components/WorkspaceHome';
import Sidebar from './components/Sidebar';
import MarkdownPreview from './components/MarkdownPreview';
import WebPreview, { type WebPreviewHandle } from './components/WebPreview';
import PDFViewer from './components/PDFViewer';
import MediaViewer from './components/MediaViewer';
import UpdateModal from './components/UpdateModal';
import MobilePendingModal from './components/MobilePendingModal';
import { loadPendingTasks } from './services/mobilePendingTasks';
import type { MobilePendingTask } from './services/mobilePendingTasks';
import SettingsModal from './components/SettingsModal';
import ExportModal from './components/ExportModal';
import ImageSearchPanel from './components/ImageSearchPanel';
import FindReplaceBar from './components/FindReplaceBar';
import AIMarkOverlay from './components/AIMarkOverlay';

import TabBar from './components/TabBar';
import BottomPanel, { type FileMeta } from './components/BottomPanel';
import { useDragResize } from './hooks/useDragResize';
import { syncSecretsFromCloud } from './services/apiSecrets';
import { deployDemoHub, resolveVercelToken } from './services/publishVercel';
import { useTabManager } from './hooks/useTabManager';
import { useAutosave } from './hooks/useAutosave';
import { useFileWatcher } from './hooks/useFileWatcher';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { TLShapeId } from 'tldraw';
const CanvasEditor = lazy(() => import('./components/CanvasEditor'));
import { canvasAIContext, executeCanvasCommands } from './utils/canvasAI';
import { exportMarkdownToPDF } from './utils/exportPDF';
import {
  readFile,
  writeFile,
  saveWorkspaceConfig,
  trackFileOpen,
  flatMdFiles,
  refreshFileTree,
} from './services/workspace';
import { registerWorkspace } from './services/syncConfig';
import { useAuthSession } from './hooks/useAuthSession';
import { onLockedFilesChange, getLockedFiles } from './services/copilotLock';
import { loadWorkspaceSession, saveWorkspaceSession } from './services/workspaceSession';
import { getFileTypeInfo } from './utils/fileType';
import { generateId } from './utils/generateId';
import type { Workspace, AIEditMark, AppSettings, WorkspaceExportConfig, WorkspaceConfig } from './types';
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_KEY } from './types';
import { useBacklinks } from './hooks/useBacklinks';
import { useModals } from './hooks/useModals';
import { useCanvasState } from './hooks/useCanvasState';
import { useAIMarks, makeCanvasMark } from './hooks/useAIMarks';
import BacklinksPanel from './components/BacklinksPanel';
import './App.css';

function loadAppSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(APP_SETTINGS_KEY);
    if (saved) return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return DEFAULT_APP_SETTINGS;
}

const FALLBACK_CONTENT = `# Untitled Document\n\nStart writing here…\n`;

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

  // Mark component as unmounted so async polls (e.g. export canvas mount check) can bail out
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
  const wordCount = useMemo(() => content.trim().split(/\s+/).filter(Boolean).length, [content]);
  const [fileStat, setFileStat] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => initSettings);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  // Find + Replace bar (Ctrl/Cmd+F)
  // Pending jump: set by project search results; cleared after content loads
  const [pendingJumpText, setPendingJumpText] = useState<string | null>(null);
  const [pendingJumpLine, setPendingJumpLine] = useState<number | null>(null);
  // Sidebar / panel visibility, mode and widths
  const [sidebarMode, setSidebarMode] = useState<'explorer' | 'search'>('explorer');
  const [sidebarOpen, setSidebarOpen] = useState(initSettings.sidebarOpenDefault);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(240);
  /** Changing this value tells BottomPanel to cd to the given absolute path. */
  const [terminalRequestCd, setTerminalRequestCd] = useState<string | undefined>();
  /** Changing this value tells BottomPanel to run the given shell command. Format: "cmd|timestamp" */
  const [terminalRequestRun, setTerminalRequestRun] = useState<string | undefined>();
  /** Distraction-free writing mode — hides header/sidebar/panels */
  const [focusMode, setFocusMode] = useState(false);
  /** Idea Dump — one-tap record → transcribe → append to inbox */
  const [isDumping, setIsDumping] = useState(false);
  const [isDumpTranscribing, setIsDumpTranscribing] = useState(false);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const dumpRecorderRef = useRef<MediaRecorder | null>(null);
  const dumpChunksRef = useRef<Blob[]>([]);
  const [lockedFiles, setLockedFiles] = useState<Set<string>>(() => getLockedFiles());

  // Subscribe to Copilot file-lock changes
  useEffect(() => {
    const unsub = onLockedFilesChange((locked) => setLockedFiles(locked));
    return unsub;
  }, []);
  // Stable refs declared early (before hooks that reference them)
  const editorRef = useRef<EditorHandle>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const aiPanelRef = useRef<AIPanelHandle | null>(null);
  const webPreviewRef = useRef<WebPreviewHandle | null>(null);
  const mountedRef = useRef(true);
  // ── Modals / overlays (──────────────────────────────────────────────────
  const {
    showUpdateModal, setShowUpdateModal,
    showSettings, setShowSettings,
    settingsInitialTab, openSettings,
    imgSearchOpen, setImgSearchOpen,
    exportModalOpen, setExportModalOpen,
    findReplaceOpen, setFindReplaceOpen,
    aiOpen, setAiOpen,
    aiInitialPrompt, setAiInitialPrompt,
  } = useModals();
  const [showMobilePending, setShowMobilePending] = useState(false);
  const [mobilePendingTasks, setMobilePendingTasks] = useState<MobilePendingTask[]>([]);
  // ── Canvas refs + transient state ───────────────────────────────────────
  const {
    canvasEditorRef,
    forceSaveRef,
    rescanFramesRef,
    canvasResetKey, setCanvasResetKey,
    canvasSlideCount, setCanvasSlideCount,
  } = useCanvasState();
  // ── Panel resize (sidebar ↔ editor ↔ AI panel) ───────────────────────────
  const { sidebarWidth, aiPanelWidth, startSidebarDrag, startAiDrag } = useDragResize();
  const { autosaveDelayRef, scheduleAutosave, cancelAutosave } = useAutosave({
    savedContentRef,
    setDirtyFiles,
    setSaveError: (err) => setSaveError(err as string | null),
    setWorkspace,
    initialDelay: initSettings.autosaveDelay,
  });
  // ── AI edit marks ────────────────────────────────────────────────────────
  const {
    aiMarks, setAiMarks,
    aiHighlight, setAiHighlight,
    aiNavIndex, setAiNavIndex,
    activeFileMarks,
    loadMarksForWorkspace,
    handleMarkRecorded,
    handleCanvasMarkRecorded,
    handleMarkReviewed,
    handleReviewAllMarks,
    handleMarkUserEdited,
    handleAINavNext,
    handleAINavPrev,
    recordMark,
    cleanupMarksForContent,
  } = useAIMarks({
    workspace,
    activeFile,
    initHighlightDefault: initSettings.aiHighlightDefault,
    activeTabIdRef,
    tabsRef,
    tabContentsRef,
    savedContentRef,
    canvasEditorRef,
    editorRef,
    setContent,
    setDirtyFiles,
  });
  // Visual "Saved ✓" toast
  const [savedToast, setSavedToast] = useState(false);
  const savedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Demo Hub publish status toast
  const [demoHubToast, setDemoHubToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const demoHubToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Save error — set on any failed write, cleared on next successful write
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Demo Hub publish ───────────────────────────────────────────────────────
  const handlePublishDemoHub = useCallback(async () => {
    if (!workspace) return;
    const demoHub = workspace.config.vercelConfig?.demoHub;
    if (!demoHub?.projectName) return;
    const token = resolveVercelToken(workspace.config.vercelConfig?.token);
    if (!token) {
      setDemoHubToast({ msg: 'Sem token Vercel. Configure em Settings → API Keys.', ok: false });
      if (demoHubToastTimerRef.current) clearTimeout(demoHubToastTimerRef.current);
      demoHubToastTimerRef.current = setTimeout(() => setDemoHubToast(null), 5000);
      return;
    }
    setDemoHubToast({ msg: 'Publicando demos…', ok: true });
    try {
      const result = await deployDemoHub({
        token,
        projectName: demoHub.projectName,
        teamId: workspace.config.vercelConfig?.teamId,
        workspacePath: workspace.path,
        sourceDir: demoHub.sourceDir,
      });
      const url = result.url.replace(/^\/\//, 'https://');
      setDemoHubToast({ msg: `Publicado ✔ ${url}`, ok: true });
      if (demoHubToastTimerRef.current) clearTimeout(demoHubToastTimerRef.current);
      demoHubToastTimerRef.current = setTimeout(() => setDemoHubToast(null), 8000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDemoHubToast({ msg: `Erro: ${msg}`, ok: false });
      if (demoHubToastTimerRef.current) clearTimeout(demoHubToastTimerRef.current);
      demoHubToastTimerRef.current = setTimeout(() => setDemoHubToast(null), 8000);
    }
  }, [workspace]);
  // Pandoc PDF export
  const [pandocBusy, setPandocBusy] = useState(false);
  const [pandocError, setPandocError] = useState<string | null>(null);
  // Export lock — shown while auto-opening a canvas for export (blur + coffee animation)
  const [exportLock, setExportLock] = useState(false);
  const exportRestoreTabRef = useRef<string | null>(null);
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
  // Backlinks — scan only markdown files; disable during focus mode for perf
  const { backlinks, outlinks, loading: backlinksLoading } = useBacklinks(
    activeFile,
    workspace,
    fileTypeInfo?.kind === 'markdown',
  );
  const fileMeta = useMemo<FileMeta>(() => ({
    kind: fileTypeInfo?.kind ?? null,
    wordCount,
    lines: content.split('\n').length,
    slides: canvasSlideCount,
    fileStat,
  }), [fileTypeInfo?.kind, wordCount, content, canvasSlideCount, fileStat]);

  // ── In-app update ───────────────────────────────────────────
  // dev  → open UpdateModal (runs build script)
  // mas  → open Mac App Store page
  // ios  → open iOS App Store page
  const APP_STORE_URL = 'https://apps.apple.com/app/id6759814955';
  async function handleUpdate() {
    let channel = 'dev';
    try { channel = await invoke<string>('build_channel'); } catch { /* older build */ }
    if (channel === 'mas') {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      openUrl(`macappstore://apps.apple.com/app/id6759814955`).catch(() =>
        openUrl(APP_STORE_URL)
      );
    } else if (channel === 'ios') {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      openUrl(APP_STORE_URL).catch(() => {});
    } else {
      setShowUpdateModal(true);
    }
  }

  // Listen for the native menu "Update Cafezin…" event
  useEffect(() => {
    const unlisten = listen('menu-update-app', () => handleUpdate());
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for the native menu "Settings…" event (⌘,)
  useEffect(() => {
    const unlisten = listen('menu-settings', () => openSettings());
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, []);

  // ── OAuth deep-link callback (cafezin://auth/callback#access_token=...) ───
  // Delegated to useAuthSession. onAuthSuccess runs syncSecretsFromCloud and
  // dispatches cafezin:auth-updated so WorkspacePicker can refresh its state.
  useAuthSession({
    onAuthSuccess: async () => {
      await syncSecretsFromCloud();
      window.dispatchEvent(new CustomEvent('cafezin:auth-updated'));
    },
  });

  // On startup, silently pull any secrets already saved to Supabase.
  // No-ops when not logged in or offline.
  useEffect(() => { syncSecretsFromCloud(); }, []);

  // First-launch sync prompt: if sync was never configured and user hasn't
  // dismissed it, open Settings directly on the Sync tab.
  useEffect(() => {
    const SKIP_KEY = 'cafezin-sync-onboarding-skipped';
    const alreadySkipped = localStorage.getItem(SKIP_KEY);
    const alreadyConnected = localStorage.getItem('cafezin-sync-account-token');
    if (!alreadySkipped && !alreadyConnected) {
      // Mark as shown so we don't prompt again
      localStorage.setItem(SKIP_KEY, '1');
      openSettings('sync');
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
        // Don't show full-screen overlay when hovering over the AI panel
        const pos = (event.payload as { position?: { x: number; y: number } }).position;
        const hitEl = pos ? document.elementFromPoint(pos.x, pos.y) : null;
        setDragOver(!hitEl?.closest('[data-panel="ai"]'));
      } else if (type === 'drop') {
        setDragOver(false);
        const paths: string[] = (event.payload as { paths?: string[] }).paths ?? [];
        if (paths.length > 0 && workspace) {
          // Route to AI panel if the drop landed over it, otherwise open as file
          const pos = (event.payload as { position?: { x: number; y: number } }).position;
          const hitEl = pos ? document.elementFromPoint(pos.x, pos.y) : null;
          if (aiPanelRef.current && hitEl?.closest('[data-panel="ai"]')) {
            setAiOpen(true);
            aiPanelRef.current.receiveFinderFiles(paths);
          } else {
            handleDroppedFiles(paths);
          }
        }
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
    onOpenSettings:  () => openSettings(),
    onToggleSidebar: () => setSidebarOpen((v) => !v),
    onSave: async () => {
      const kind = fileTypeInfo?.kind;
      if (activeTabId && workspace && kind !== 'pdf' && kind !== 'video' && kind !== 'image') {
        if (kind === 'canvas') forceSaveRef.current?.();
        const current = tabContentsRef.current.get(activeTabId) ?? content;
        cancelAutosave();
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
    onToggleFind:    () => setFindReplaceOpen((v: boolean) => !v),
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
    focusMode,
    onToggleFocusMode: () => {
      setFocusMode((v) => {
        if (!v) { setSidebarOpen(false); setAiOpen(false); }
        return !v;
      });
    },
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

  // ── Format via Prettier standalone ─────────────────────────────────────────
  async function handleFormat() {
    if (!activeFile || !workspace || fileTypeInfo?.kind !== 'code') return;
    const current = tabContentsRef.current.get(activeFile) ?? content;
    const formatted = await formatContent(current, fileTypeInfo.language ?? '');
    if (formatted !== current) {
      tabContentsRef.current.set(activeFile, formatted);
      setContent(formatted);
      scheduleAutosave(workspace, activeFile, formatted);
    }
  }

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
    cancelAutosave();
    closeAllTabs((paths) => {
      setDirtyFiles((prev) => { const s = new Set(prev); paths.forEach((p) => s.delete(p)); return s; });
    });
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
      // Poll until tldraw Editor is mounted (key={activeFile} on CanvasEditor remounts on switch).
      // The `mountedRef` guard ensures the poll stops immediately if the component unmounts
      // (e.g. user switches workspace mid-export), preventing ghost state updates.
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        let timerId: ReturnType<typeof setTimeout> | null = null;
        const check = () => {
          if (!mountedRef.current) { reject(new Error('Component unmounted during export')); return; }
          if (canvasEditorRef.current) { resolve(); return; }
          if (Date.now() - start > 10_000) { reject(new Error('Canvas editor did not mount in time')); return; }
          timerId = setTimeout(check, 80);
        };
        // Store cleanup so the poll can be cancelled if the promise is abandoned
        check();
        // If the promise is gc'd (workspace switch) timerId will just fire once more
        // then bail via !mountedRef.current — no additional cleanup needed.
        void timerId;
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

  async function handleWorkspaceConfigChange(patch: Partial<WorkspaceConfig>): Promise<void> {
    if (!workspace) return;
    const updated: Workspace = { ...workspace, config: { ...workspace.config, ...patch } };
    setWorkspace(updated);
    try { await saveWorkspaceConfig(updated); } catch (e) { console.error('Failed to save workspace config:', e); }
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
      setSaveError(`Could not open "${filename}": ${(err as Error)?.message ?? String(err)}`);
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

      // Auto-remove AI marks whose text no longer exists in the document
      // (delegated to useAIMarks).
      cleanupMarksForContent(activeFile, newContent);

      // Canvas files: the tldraw store listener already debounces to 500ms before
      // calling onChange — a second autosave debounce (1s) is redundant and pushes
      // disk writes to ~1500ms. Write immediately here so the total latency is just
      // the 500ms from the tldraw store listener.
      if (activeFile.endsWith('.tldr.json')) {
        writeFile(workspace, activeFile, newContent)
          .then(() => {
            savedContentRef.current.set(activeFile, newContent);
            setDirtyFiles((prev) => { const s = new Set(prev); s.delete(activeFile); return s; });
            setSaveError(null);
          })
          .catch((err) => setSaveError(String((err as Error)?.message ?? err)));
        return;
      }

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
    cancelAutosave();
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

  // ── Idea Dump — voice record → transcribe → append to inbox file ──────────
  async function handleToggleDump() {
    if (isDumpTranscribing) return; // ignore while processing
    setDumpError(null);

    if (isDumping) {
      // Stop recording — onstop handler will transcribe + save
      dumpRecorderRef.current?.stop();
      dumpRecorderRef.current = null;
      return;
    }

    const groqKey = localStorage.getItem('cafezin-groq-key') ?? '';
    if (!groqKey) {
      setDumpError('Groq API key not set — configure it in the AI panel.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg'
        : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      dumpChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) dumpChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsDumping(false);
        setIsDumpTranscribing(true);
        try {
          const blob = new Blob(dumpChunksRef.current, { type: mimeType });
          const arrayBuf = await blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuf);
          let binary = '';
          uint8.forEach((b) => (binary += String.fromCharCode(b)));
          const b64 = btoa(binary);
          const transcript = await invoke<string>('transcribe_audio', {
            audioBase64: b64,
            mimeType,
            apiKey: groqKey,
          });
          if (transcript.trim() && workspace) {
            const inboxRel = workspace.config?.inboxFile ?? '00_Inbox/raw_transcripts.md';
            const now = new Date();
            const header = `\n\n## Voice dump: ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}\n\n`;
            let existing = '';
            try { existing = await readFile(workspace, inboxRel); } catch { /* file may not exist yet */ }
            await writeFile(workspace, inboxRel, existing + header + transcript.trim() + '\n');
          }
        } catch (err) {
          setDumpError(`Dump failed: ${String((err as Error)?.message ?? err)}`);
        } finally {
          setIsDumpTranscribing(false);
        }
      };
      dumpRecorderRef.current = recorder;
      recorder.start();
      setIsDumping(true);
    } catch (err) {
      setDumpError(`Mic access denied: ${String((err as Error)?.message ?? err)}`);
    }
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
          recordMark(makeCanvasMark(activeFile, shapeIds, model));
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
    // Schedule auto-save and record AI edit provenance.
    // NOTE: newContent is assigned synchronously inside the setContent updater
    // above (React calls functional updaters synchronously during reconciliation
    // when not inside a concurrent transition). To be safe, we read from
    // tabContentsRef which is always written first inside the updater.
    const contentToSave = activeFile ? (tabContentsRef.current.get(activeFile) ?? newContent) : newContent;
    if (workspace && activeFile) {
      scheduleAutosave(workspace, activeFile, contentToSave);
      const mark: AIEditMark = {
        id: generateId(),
        fileRelPath: activeFile,
        text,
        model,
        insertedAt: new Date().toISOString(),
        reviewed: false,
      };
      recordMark(mark);
    }
  }, [workspace, activeFile, scheduleAutosave]);

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
    cancelAutosave();
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
    loadMarksForWorkspace(ws);
    // Check for pending tasks queued from mobile
    const pending = await loadPendingTasks(ws.path);
    if (pending.length > 0) {
      setMobilePendingTasks(pending);
      setShowMobilePending(true);
    }

    // Silently register in Supabase if user is logged in and workspace has a git remote.
    // No-ops if not authenticated or no git remote — never blocks the UI.
    if (ws.hasGit) {
      registerWorkspace(ws.path, ws.name, 'personal').catch(() => { /* not fatal */ });
    }

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

  function handleExecutePendingTask(task: MobilePendingTask) {
    setAiInitialPrompt(task.description);
    setAiOpen(true);
  }

  return (
    <div className={`app${focusMode ? ' focus-mode' : ''}${exportLock ? ' app--exporting' : ''}`}>
      {splash && <SplashScreen visible={splashVisible} />}
      {/* Export lock overlay — full-window fixed overlay while canvas export runs */}
      {exportLock && (
        <div className="export-lock-overlay" aria-hidden>
          <span className="copilot-lock-label">exporting…</span>
        </div>
      )}
      {focusMode && (
        <button
          className="app-focus-exit"
          onClick={() => setFocusMode(false)}
          title="Exit Zen Mode (Esc or ⌘⇧.)"
        >✕ zen</button>
      )}
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
          {/* Format — code files in edit mode only */}
          {fileTypeInfo?.kind === 'code' && viewMode === 'edit' && (
            <button
              className="app-format-btn"
              onClick={handleFormat}
              title="Format file with Prettier (⌥F)"
            >
              ⌥ Format
            </button>
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
          {/* Idea Dump — voice record → transcribe → append to inbox */}
          {workspace && (
            <button
              className={`app-dump-btn${isDumping ? ' recording' : ''}${isDumpTranscribing ? ' transcribing' : ''}`}
              onClick={handleToggleDump}
              disabled={isDumpTranscribing}
              title={isDumping ? 'Stop recording and save to inbox' : isDumpTranscribing ? 'Transcribing…' : 'Record voice note → append to inbox file'}
            >
              {isDumping ? '⏹ Stop' : isDumpTranscribing ? '…' : '🎙 Dump'}
            </button>
          )}
          {dumpError && (
            <span className="app-save-error" title={dumpError} onClick={() => setDumpError(null)}>
              ⚠ {dumpError.length > 40 ? dumpError.slice(0, 40) + '…' : dumpError}
            </span>
          )}

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
          {demoHubToast && (
            <span
              className={demoHubToast.ok ? 'app-saved-toast' : 'app-save-error'}
              style={{ maxWidth: 360, cursor: 'pointer' }}
              title={demoHubToast.msg}
              onClick={() => setDemoHubToast(null)}
            >
              {demoHubToast.msg.length > 55 ? demoHubToast.msg.slice(0, 55) + '…' : demoHubToast.msg}
            </span>
          )}
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
              onRunButtonCommand={(command) => {
                setTerminalOpen(true);
                setTerminalRequestRun(command + '|' + Date.now());
              }}
              onPublishDemoHub={handlePublishDemoHub}
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
          <FindReplaceBar
            open={findReplaceOpen}
            onClose={() => setFindReplaceOpen(false)}
            editorRef={editorRef}
            canvasEditor={canvasEditorRef.current}
            fileKind={fileTypeInfo?.kind ?? null}
          />

        {/* ── Active file viewer ─ key triggers CSS fade on every file switch ── */}
        <div key={activeFile ?? ''} className="editor-file-view">
        <EditorErrorBoundary
          activeFile={activeFile}
          onReload={handleOpenFile}
          onClose={handleCloseTab}
        >
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
          <CanvasErrorBoundary
            key={`${activeFile}-${canvasResetKey}`}
            workspacePath={workspace.path}
            canvasRelPath={activeFile}
            onRecovered={async () => {
              // Re-read file from disk (bypasses tab cache so new content loads)
              try {
                const fresh = await readFile(workspace, activeFile);
                savedContentRef.current.set(activeFile, fresh);
                tabContentsRef.current.set(activeFile, fresh);
                setContent(fresh);
              } catch { /* keep whatever is on disk */ }
              setCanvasResetKey((k) => k + 1);
            }}
          >
          <Suspense fallback={<div className="canvas-loading">Loading canvas…</div>}>
          <CanvasEditor
            key={`${activeFile}-${canvasResetKey}`}
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
          </CanvasErrorBoundary>
        ) : !activeFile ? (
          <WorkspaceHome
            workspace={workspace}
            onOpenFile={handleOpenFile}
            aiMarks={aiMarks}
            onOpenAIReview={() => { setAiHighlight(true); setAiNavIndex(0); }}
          />
        ) : viewMode === 'preview' && fileTypeInfo?.kind === 'markdown' ? (
          <MarkdownPreview
            content={content}
            onNavigate={handleOpenFile}
            currentFilePath={activeFile ?? undefined}
          />
        ) : viewMode === 'preview' && fileTypeInfo?.kind === 'code' && fileTypeInfo.supportsPreview && activeFile && workspace ? (
          <WebPreview
            ref={webPreviewRef}
            content={content}
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
            isLocked={lockedFiles.has(activeFile)}
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
            isLocked={activeFile ? lockedFiles.has(activeFile) : false}
            onFormat={fileTypeInfo?.kind === 'code' ? handleFormat : undefined}
          />
        )}
        </EditorErrorBoundary>
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

        {/* Backlinks strip — markdown files only */}
        {fileTypeInfo?.kind === 'markdown' && (
          <BacklinksPanel
            backlinks={backlinks}
            outlinks={outlinks}
            loading={backlinksLoading}
            onOpen={handleOpenFile}
          />
        )}

        </div> {/* end editor-area */}



        {/* AI panel resize handle — only visible when open */}
        {aiOpen && <div className="resize-divider" onMouseDown={startAiDrag} />}
        <AIPanel
          ref={aiPanelRef}
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
          webPreviewRef={webPreviewRef}
          getActiveHtml={
            fileTypeInfo?.kind === 'code' && fileTypeInfo.supportsPreview && activeFile
              ? () => ({ html: content, absPath: `${workspace.path}/${activeFile}` })
              : undefined
          }
          workspaceExportConfig={workspace.config.exportConfig}
          onExportConfigChange={handleExportConfigChange}
          workspaceConfig={workspace.config}
          onWorkspaceConfigChange={handleWorkspaceConfigChange}
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
        requestRun={terminalRequestRun}
        fileMeta={fileMeta}
      />
      </div> {/* end app-workspace */}

      <UpdateModal
        open={showUpdateModal}
        projectRoot={__PROJECT_ROOT__}
        onClose={() => setShowUpdateModal(false)}
      />

      <MobilePendingModal
        open={showMobilePending}
        workspacePath={workspace.path}
        tasks={mobilePendingTasks}
        onExecute={handleExecutePendingTask}
        onClose={() => setShowMobilePending(false)}
        onTaskDeleted={(id) => setMobilePendingTasks(prev => prev.filter(t => t.id !== id))}
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

