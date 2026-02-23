import { useState, useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import Editor from './components/Editor';
import type { EditorHandle } from './components/Editor';
import AIPanel from './components/AIPanel';
import AIReviewPanel from './components/AIReviewPanel';
import WorkspacePicker from './components/WorkspacePicker';
import WorkspaceHome from './components/WorkspaceHome';
import Sidebar from './components/Sidebar';
import MarkdownPreview from './components/MarkdownPreview';
import PDFViewer from './components/PDFViewer';
import MediaViewer from './components/MediaViewer';
import UpdateModal from './components/UpdateModal';
import GooglePanel from './components/GooglePanel';
import ImageSearchPanel from './components/ImageSearchPanel';
import type { Editor as TldrawEditor } from 'tldraw';
import CanvasEditor from './components/CanvasEditor';
import { canvasAIContext, executeCanvasCommands } from './utils/canvasAI';
import {
  readFile,
  writeFile,
  saveWorkspaceConfig,
  trackFileOpen,
  trackFileEdit,
  refreshFiles,
  refreshFileTree,
} from './services/workspace';
import { loadMarks, addMark, markReviewed } from './services/aiMarks';
import { getFileTypeInfo } from './utils/fileType';
import type { Workspace, AIEditMark } from './types';
import './App.css';

const FALLBACK_CONTENT = `# Untitled Document\n\nStart writing here…\n`;

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [isAIStreaming, setIsAIStreaming] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>(FALLBACK_CONTENT);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
  const [googleOpen, setGoogleOpen] = useState(false);
  const [imgSearchOpen, setImgSearchOpen] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [aiMarks, setAiMarks] = useState<AIEditMark[]>([]);
  const [showAIReview, setShowAIReview] = useState(false);
  // AI highlight toggle and nav
  const [aiHighlight, setAiHighlight] = useState(true);
  const [aiNavIndex, setAiNavIndex] = useState(0);
  // Sidebar / panel visibility and widths
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [aiPanelWidth, setAiPanelWidth] = useState(340);
  const draggingRef = useRef<null | 'sidebar' | 'ai'>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  // Holds the live tldraw Editor instance when a canvas file is open
  const canvasEditorRef = useRef<TldrawEditor | null>(null);
  // Tracks the last-persisted content per file to drive dirty state accurately
  const savedContentRef = useRef<Map<string, string>>(new Map());

  // ── Drag-to-resize ─────────────────────────────────────────
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const delta = e.clientX - dragStartX.current;
      if (draggingRef.current === 'sidebar') {
        setSidebarWidth(Math.max(150, Math.min(480, dragStartWidth.current + delta)));
      } else {
        // AI panel resizes from its left edge — dragging left increases width
        setAiPanelWidth(Math.max(260, Math.min(620, dragStartWidth.current - delta)));
      }
    }
    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startSidebarDrag(e: React.MouseEvent) {
    draggingRef.current = 'sidebar';
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function startAiDrag(e: React.MouseEvent) {
    draggingRef.current = 'ai';
    dragStartX.current = e.clientX;
    dragStartWidth.current = aiPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // Derived from active file
  const fileTypeInfo = activeFile ? getFileTypeInfo(activeFile) : null;

  // ── In-app update ───────────────────────────────────────────
  function handleUpdate() {
    setShowUpdateModal(true);
  }

  // Listen for the native menu "Update custom-tool…" event
  useEffect(() => {
    const unlisten = listen('menu-update-app', () => handleUpdate());
    return () => { unlisten.then((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Word count ───────────────────────────────────────────────
  useEffect(() => {
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(words);
  }, [content]);

  // ── Keyboard shortcuts ───────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setAiInitialPrompt('');
        setAiOpen(true);
      }
      if (e.key === 'Escape' && aiOpen) setAiOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aiOpen]);

  // ── File open ────────────────────────────────────────────────
  async function handleOpenFile(filename: string) {
    if (!workspace) return;
    const info = getFileTypeInfo(filename);
    setViewMode(info.defaultMode);
    if (info.kind === 'pdf') {
      setActiveFile(filename);
      setContent('');
      // Track open (fire and forget, update workspace state)
      trackFileOpen(workspace, filename).then(setWorkspace).catch(() => {});
      return;
    }
    try {
      const text = await readFile(workspace, filename);
      setContent(text);
      setActiveFile(filename);
      // Record as saved baseline so dirty tracking starts clean
      savedContentRef.current.set(filename, text);
      // Track open — update recentFiles + lastOpenedFile in config
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
    // On workspace switch, always go to home view — don't auto-open a file
    if (!isSameWorkspace) {
      setActiveFile(null);
      setContent('');
    }
  }

  // ── Auto-save (debounced 1s) ─────────────────────────────────
  const handleContentChange = useCallback(
    (newContent: string) => {
      // Canvas files are self-managed by tldraw — never feed changed JSON back
      // into React state or tldraw will see the `snapshot` prop change and reset.
      if (!activeFile?.endsWith('.tldr.json')) setContent(newContent);
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
        import('./services/aiMarks').then(({ saveMarks }) =>
          saveMarks(workspace, updated).catch(() => {}),
        );
        return updated;
      });

      // Mark dirty only if content differs from last saved version;
      // clear it if the user has typed back to the saved state.
      const lastSaved = savedContentRef.current.get(activeFile);
      const isDirty = newContent !== lastSaved;
      setDirtyFiles((prev) => {
        const wasDirty = prev.has(activeFile);
        if (isDirty === wasDirty) return prev;
        const next = new Set(prev);
        if (isDirty) next.add(activeFile); else next.delete(activeFile);
        return next;
      });
      if (!isDirty) {
        // Content is back to saved state — no need to write
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        return;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await writeFile(workspace, activeFile, newContent);
          // Update saved baseline and clear dirty flag
          savedContentRef.current.set(activeFile, newContent);
          setDirtyFiles((prev) => {
            if (!prev.has(activeFile)) return prev;
            const next = new Set(prev);
            next.delete(activeFile);
            return next;
          });
          // Update lastEditedAt in config (debounced together with save)
          trackFileEdit(workspace).then(setWorkspace).catch(() => {});
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }, 1000);
    },
    [workspace, activeFile]
  );

  // ── Clear dirty state after a successful sync ─────────────────
  const handleSyncComplete = useCallback(() => {
    setDirtyFiles(new Set());
  }, []);

  // ── AI request from editor (⌘K selection) ───────────────────
  const handleAIRequest = useCallback((selectedText: string) => {
    setAiInitialPrompt(
      selectedText ? `Help me improve this:\n\n${selectedText}` : ''
    );
    setAiOpen(true);
  }, []);

  // ── Restore from Drive ───────────────────────────────────────
  const handleRestoreContent = useCallback((restoredContent: string, filename: string) => {
    setContent(restoredContent);
    setActiveFile(filename);
    setViewMode('edit');
    if (workspace) {
      writeFile(workspace, filename, restoredContent).catch(console.error);
    }
  }, [workspace]);

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
      const [files, fileTree] = await Promise.all([
        refreshFiles(workspace),
        refreshFileTree(workspace),
      ]);
      setWorkspace((prev) => prev ? { ...prev, files, fileTree } : prev);
    } catch (err) {
      console.error('Failed to refresh workspace after file write:', err);
    }
  }, [workspace]);

  // ── AI mark recording (agent write_workspace_file path) ──────────────────
  const handleMarkRecorded = useCallback((relPath: string, written: string, aiModel: string) => {
    if (!workspace) return;
    const mark: AIEditMark = {
      id: Math.random().toString(36).slice(2, 10),
      fileRelPath: relPath,
      text: written,
      model: aiModel,
      insertedAt: new Date().toISOString(),
      reviewed: false,
    };
    addMark(workspace, mark).then(setAiMarks).catch(() => {});
    // If the agent wrote the file currently open, reload it into the editor
    if (relPath === activeFile) {
      setContent(written);
      savedContentRef.current.set(relPath, written);
      setDirtyFiles((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
    }
  }, [workspace, activeFile]);

  // ── Insert from AI ───────────────────────────────────────────
  // Canvas: parse the ```canvas``` block from the AI response and execute
  // commands against the live editor.  Text files: append to the document.
  const handleInsert = useCallback((text: string, model: string) => {
    const kind = activeFile ? getFileTypeInfo(activeFile).kind : null;
    if (kind === 'canvas') {
      if (canvasEditorRef.current) {
        executeCanvasCommands(canvasEditorRef.current, text);
      }
      return;
    }
    setContent((prev) => {
      const sep = prev.endsWith('\n') ? '\n' : '\n\n';
      return prev + sep + text;
    });
    // Record AI edit provenance
    if (workspace && activeFile) {
      const mark: AIEditMark = {
        id: Math.random().toString(36).slice(2, 10),
        fileRelPath: activeFile,
        text,
        model,
        insertedAt: new Date().toISOString(),
        reviewed: false,
      };
      addMark(workspace, mark).then(setAiMarks).catch(() => {});
    }
  }, [workspace, activeFile]);

  // ── AI mark review ───────────────────────────────────────────
  const handleMarkReviewed = useCallback((id: string) => {
    if (!workspace) return;
    markReviewed(workspace, id).then(setAiMarks).catch(() => {});
  }, [workspace]);

  // ── AI nav (prev/next within active file) ────────────────────
  const activeFileMarks = aiMarks.filter(
    (m) => m.fileRelPath === activeFile && !m.reviewed,
  );

  const handleAINavNext = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex + 1) % activeFileMarks.length;
    setAiNavIndex(idx);
    editorRef.current?.jumpToText(activeFileMarks[idx].text);
  }, [activeFileMarks, aiNavIndex]);

  const handleAINavPrev = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex - 1 + activeFileMarks.length) % activeFileMarks.length;
    setAiNavIndex(idx);
    editorRef.current?.jumpToText(activeFileMarks[idx].text);
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
    if (activeFile === relPath) {
      setActiveFile(null);
      setContent(FALLBACK_CONTENT);
      setDirtyFiles((prev) => { const next = new Set(prev); next.delete(relPath); return next; });
      savedContentRef.current.delete(relPath);
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
    // Cancel any pending auto-save
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setWorkspace(null);
    setActiveFile(null);
    setContent(FALLBACK_CONTENT);
    setDirtyFiles(new Set());
    setAiMarks([]);
    setIsAIStreaming(false);
  }
  // ── Workspace loaded ─────────────────────────────────────────
  async function handleWorkspaceLoaded(ws: Workspace) {
    setWorkspace(ws);
    // Always start at the home view — let the user choose what to open
    setActiveFile(null);
    setContent('');
    // Load AI edit marks for this workspace
    loadMarks(ws).then(setAiMarks).catch(() => setAiMarks([]));
  }

  const title = activeFile
    ? (content.match(/^#\s+(.+)$/m)?.[1] ?? activeFile)
    : workspace?.name ?? 'Untitled';

  // ── No workspace yet — show picker ──────────────────────────
  if (!workspace) {
    return (
      <>
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
          {/* Home button */}
          {activeFile && (
            <button
              className="app-home-btn"
              onClick={() => setActiveFile(null)}
              title="Go to workspace home"
            >
              ⌂
            </button>
          )}
          <span className="app-title">{title}</span>
          {workspace.config.name && (
            <span className="app-workspace-name">{workspace.config.name}</span>
          )}
        </div>
        <div className="app-header-right">
          {fileTypeInfo?.kind === 'markdown' && (
            <div className="app-view-toggle">
              <button
                className={`app-view-btn ${viewMode === 'edit' ? 'active' : ''}`}
                onClick={() => setViewMode('edit')}
                title="Edit mode"
              >
                Edit
              </button>
              <button
                className={`app-view-btn ${viewMode === 'preview' ? 'active' : ''}`}
                onClick={() => setViewMode('preview')}
                title="Preview rendered markdown"
              >
                Preview
              </button>
            </div>
          )}
          {fileTypeInfo?.kind !== 'pdf' && fileTypeInfo?.kind !== 'canvas' && (
            <span className="app-wordcount">{wordCount.toLocaleString()} words</span>
          )}
          {activeFileMarks.length > 0 && (
            <div className="app-ai-nav">
              {/* Toggle highlight on/off */}
              <button
                className={`app-ai-nav-btn app-ai-nav-toggle ${aiHighlight ? 'active' : ''}`}
                onClick={() => setAiHighlight((v) => !v)}
                title={aiHighlight ? 'Hide AI highlights' : 'Show AI highlights'}
              >
                ✦ AI
              </button>
              {/* Prev */}
              <button
                className="app-ai-nav-btn"
                onClick={handleAINavPrev}
                title="Previous AI edit"
                disabled={activeFileMarks.length < 2}
              >
                ‹
              </button>
              {/* Current / total */}
              <span
                className="app-ai-nav-count"
                onClick={() => setShowAIReview(true)}
                title="Review all AI edits"
              >
                {aiNavIndex + 1}/{activeFileMarks.length}
              </span>
              {/* Next */}
              <button
                className="app-ai-nav-btn"
                onClick={handleAINavNext}
                title="Next AI edit"
                disabled={activeFileMarks.length < 2}
              >
                ›
              </button>
            </div>
          )}
          <button
            className={`app-ai-toggle ${aiOpen ? 'active' : ''}`}
            onClick={() => setAiOpen((v) => !v)}
            title="Toggle Copilot panel (⌘K)"
          >
            ✦ Copilot
          </button>
        </div>
      </header>

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
              onGoogleOpen={() => setGoogleOpen(true)}
              onImageSearch={() => setImgSearchOpen(true)}
              onOpenAIReview={() => setShowAIReview(true)}
              onAIPrev={handleAINavPrev}
              onAINext={handleAINavNext}
              onSwitchWorkspace={handleSwitchWorkspace}
              onFileDeleted={handleFileDeleted}
            />
            {/* Sidebar resize handle */}
            <div className="resize-divider" onMouseDown={startSidebarDrag} />
          </>
        )}

        {fileTypeInfo?.kind === 'pdf' && activeFile ? (
          <PDFViewer
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
          />
        ) : (fileTypeInfo?.kind === 'video' || fileTypeInfo?.kind === 'image') && activeFile ? (
          <MediaViewer
            absPath={`${workspace.path}/${activeFile}`}
            filename={activeFile}
            kind={fileTypeInfo.kind}
          />
        ) : fileTypeInfo?.kind === 'canvas' && activeFile ? (
          <CanvasEditor
            key={activeFile}
            content={content}
            onChange={handleContentChange}
            workspacePath={workspace.path}
            onEditorReady={(tldrawEd) => { canvasEditorRef.current = tldrawEd; }}
          />
        ) : !activeFile ? (
          <WorkspaceHome
            workspace={workspace}
            onOpenFile={handleOpenFile}
            aiMarks={aiMarks}
            onOpenAIReview={() => setShowAIReview(true)}
          />
        ) : viewMode === 'preview' && fileTypeInfo?.kind === 'markdown' ? (
          <MarkdownPreview content={content} />
        ) : (
          <Editor
            ref={editorRef}
            content={content}
            onChange={handleContentChange}
            onAIRequest={handleAIRequest}
            aiMarkedTexts={aiHighlight ? activeFileMarks.map(m => m.text) : []}
          />
        )}

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
          onStreamingChange={setIsAIStreaming}
          style={aiOpen ? { width: aiPanelWidth } : undefined}
        />

      </div>

      <UpdateModal
        open={showUpdateModal}
        projectRoot={__PROJECT_ROOT__}
        onClose={() => setShowUpdateModal(false)}
      />

      <GooglePanel
        open={googleOpen}
        onClose={() => setGoogleOpen(false)}
        activeFile={activeFile}
        content={content}
        onRestoreContent={handleRestoreContent}
      />

      <AIReviewPanel
        open={showAIReview}
        marks={aiMarks}
        activeFile={activeFile}
        onMarkReviewed={handleMarkReviewed}
        onJumpToText={(text) => {
          editorRef.current?.jumpToText(text);
          setShowAIReview(false);
        }}
        onClose={() => setShowAIReview(false)}
      />

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

