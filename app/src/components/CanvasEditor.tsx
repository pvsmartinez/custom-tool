import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { Editor, TLEditorSnapshot, TLComponents } from 'tldraw';
import {
  Tldraw,
  DefaultColorStyle, DefaultSizeStyle, DefaultFontStyle,
  DefaultFillStyle, DefaultDashStyle,
} from 'tldraw';
import { readFile } from '../services/fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AIEditMark } from '../types';
import { generateSlidePreviews } from '../utils/slidePreviews';
import 'tldraw/tldraw.css';
import './CanvasEditor.css';

// canvas/ submodules
import { CanvasAICtx } from './canvas/CanvasAIContext';
import {
  CAMERA_OPTIONS, TLDRAW_OPTIONS,
  FONT_OPTIONS, SIZE_OPTIONS, ALIGN_OPTIONS, TLDRAW_COLORS,
} from './canvas/canvasConstants';
import type { CanvasTheme, AnyFrame } from './canvas/canvasTypes';
import {
  DEFAULT_THEME, PRESET_THEMES,
  loadThemeFromDoc, applyThemeToSlides, enforceBgAtBack,
  SLIDE_LAYOUT_OPTIONS, applySlideLayout,
} from './canvas/canvasTheme';
import { tauriAssetsStore } from './canvas/canvasAssets';
import { loadFontOverrides, applyFontOverridesToContainer } from './canvas/canvasFontOverrides';
import { CanvasOverlays } from './canvas/CanvasOverlays';

// canvas/ hooks (domain logic by responsibility)
import { useCanvasFrameOps } from './canvas/hooks/useCanvasFrameOps';
import { useCanvasDrop }      from './canvas/hooks/useCanvasDrop';
import { useCanvasPresent }   from './canvas/hooks/useCanvasPresent';
import { useCanvasLockUI }    from './canvas/hooks/useCanvasLockUI';

// canvas/ components (UI chunks by domain)
import { CanvasSlideStrip }     from './canvas/CanvasSlideStrip';
import { CanvasImageDialog }    from './canvas/CanvasImageDialog';
import { CanvasPresentOverlay } from './canvas/CanvasPresentOverlay';
import { CanvasContextMenus }   from './canvas/CanvasContextMenus';

// ── tldraw error fallback overrides ──────────────────────────────────────────
// Replaces tldraw's built-in "Something went wrong / Reset" dialog with our own
// recovery UI. The actual error is logged so developers can diagnose root causes.
function TlErrorFallback({ error }: { error: unknown }) {
  // eslint-disable-next-line no-console
  console.error('[CanvasEditor] tldraw internal error boundary caught:', error);
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12,
      background: 'var(--canvas-bg, #1a1a1a)', color: 'var(--text-muted, #999)',
      fontSize: 13, padding: 24, textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, marginBottom: 4 }}>⚠ Canvas error</div>
      <div style={{ maxWidth: 340, lineHeight: 1.5 }}>
        Something went wrong in the canvas renderer. Check the browser console for details.<br />
        Try pressing <kbd>Ctrl+Z</kbd> to undo, or close and reopen the file.
      </div>
      <pre style={{ fontSize: 10, maxWidth: 400, overflow: 'auto', textAlign: 'left', color: '#f88', marginTop: 8, opacity: 0.7 }}>
        {error instanceof Error ? `${error.name}: ${error.message}` : String(error)}
      </pre>
    </div>
  );
}

// Per-shape error fallback — renders nothing (hides the broken shape) rather
// than crashing the whole canvas. The error is logged for debugging.
function TlShapeErrorFallback({ error }: { error: unknown }) {
  // eslint-disable-next-line no-console
  console.error('[CanvasEditor] tldraw shape render error:', error);
  return null;
}

interface CanvasEditorProps {
  /** Raw JSON from disk, or empty string for a brand-new canvas. */
  content: string;
  onChange: (json: string) => void;
  /** Called once, immediately after the tldraw Editor mounts. */
  onEditorReady?: (editor: Editor) => void;
  /** Absolute path to the workspace root — needed for saving dropped images. */
  workspacePath: string;
  /**
   * Controlled present/preview mode — when true the canvas zooms to the first
   * slide and hides all editing chrome, matching the Preview toggle behavior
   * used for Markdown. When undefined the component manages mode internally.
   */
  presentMode?: boolean;
  /** Fired whenever the number of slides (frames) changes. */
  onSlideCountChange?: (count: number) => void;
  /** Fired when the user exits present mode internally (e.g. Escape key). */
  onPresentModeChange?: (presenting: boolean) => void;
  /** Unreviewed AI marks for this canvas file. */
  aiMarks?: AIEditMark[];
  /** Whether the AI highlight overlay is visible. */
  aiHighlight?: boolean;
  /** Index of the currently focused AI mark. */
  aiNavIndex?: number;
  onAIPrev?: () => void;
  onAINext?: () => void;
  /** Called to mark an AI edit as reviewed. */
  onMarkReviewed?: (id: string) => void;
  /** Called when the user edits a shape that belongs to an AI mark. */
  onMarkUserEdited?: (markId: string) => void;
  /**
   * When provided, the component writes a `rescanFrames` function into this
   * ref so external callers (e.g. the AI panel) can force-sync the slide strip
   * after programmatic canvas edits without relying solely on the store listener.
   */
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * When provided, the component writes a `forceSave` function into this ref
   * so the parent can immediately flush the latest tldraw snapshot via onChange,
   * bypassing the 500 ms debounce (used by Cmd/Ctrl+S in App.tsx).
   */
  forceSaveRef?: React.MutableRefObject<(() => void) | null>;
  /** Mirror the app-level dark/light theme into tldraw's UI. Defaults to true (dark). */
  darkMode?: boolean;
  /** Called after an image is saved to disk (e.g. from an external drag-drop)
   *  so the parent (App) can refresh the sidebar file tree. */
  onFileSaved?: () => void;
  /**
   * Relative path of this canvas file within the workspace (e.g. "deck.tldr.json").
   * Used to derive the .cafezin/previews/<slug>/ directory for PNG sidecars.
   */
  canvasRelPath?: string;
}

export default function CanvasEditor({
  content, onChange, onEditorReady, workspacePath,
  presentMode: presentModeProp, onPresentModeChange, onSlideCountChange,
  rescanFramesRef, forceSaveRef,
  aiMarks = [], aiHighlight = false, aiNavIndex = 0,
  onAIPrev, onAINext, onMarkReviewed, onMarkUserEdited,
  darkMode = true, onFileSaved, canvasRelPath,
}: CanvasEditorProps) {
  // ── Core refs ──────────────────────────────────────────────────────────────
  const editorRef    = useRef<Editor | null>(null);
  const mainDivRef   = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref so store listeners always call the latest onChange.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Always-fresh AI callbacks without recreating store listeners.
  const aiMarksRef = useRef(aiMarks);
  aiMarksRef.current = aiMarks;
  const onMarkUserEditedRef = useRef(onMarkUserEdited);
  onMarkUserEditedRef.current = onMarkUserEdited;
  const onSlideCountChangeRef = useRef(onSlideCountChange);
  onSlideCountChangeRef.current = onSlideCountChange;

  // ── Theme state (slide-level presentation settings) ────────────────────────
  const [theme, setTheme] = useState<CanvasTheme>(DEFAULT_THEME);
  const [themeOpen, setThemeOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<'heading' | 'body' | null>(null);

  // ── Image dialog state ─────────────────────────────────────────────────────
  const [imgDialogOpen, setImgDialogOpen] = useState(false);
  const [imgUrlInput, setImgUrlInput]     = useState('');
  const [imgTab, setImgTab]               = useState<'url' | 'workspace'>('url');

  // ── Domain hooks ───────────────────────────────────────────────────────────
  const {
    frames, setFrames, frameIndex, setFrameIndex,
    frameToolActive, setFrameToolActive, lastFrameCountRef,
    zoomToFrame, addSlide, rescanFrames, exportFrame,
    insertTextPreset, reorderFrames, duplicateFrame, moveFrameDir,
  } = useCanvasFrameOps({ editorRef, theme, saveTimerRef, onChangeRef, rescanFramesRef, forceSaveRef });

  const {
    isDragOver, wsImages, wsImagesLoading,
    loadWsImages, handleSidebarFileDrop, handleAddImageFromUrl,
  } = useCanvasDrop({ editorRef, mainDivRef, workspacePath, onFileSaved });

  const {
    isPresenting, previewUrls, setPreviewUrls, previewGenState, setPreviewGenState,
    enterPresent, exitPresent, goToFrame,
  } = useCanvasPresent({
    editorRef, workspacePath, canvasRelPath,
    frames, zoomToFrame, setFrameIndex, presentModeProp, onPresentModeChange,
  });

  const { shapeCtxMenu, setShapeCtxMenu, lockPill, setLockPill, lockFlash } =
    useCanvasLockUI({ editorRef, mainDivRef });

  // ── Load workspace images when theme panel opens ───────────────────────────
  useEffect(() => {
    if (themeOpen && wsImages.length === 0 && !wsImagesLoading) loadWsImages();
  }, [themeOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Notify parent whenever slide count changes
  useEffect(() => {
    onSlideCountChangeRef.current?.(frames.length);
  }, [frames.length]);

  // ── Keep tldraw dark mode in sync with the app theme setting ─────────────────
  useEffect(() => {
    editorRef.current?.user.updateUserPreferences({ colorScheme: darkMode ? 'dark' : 'light' });
  }, [darkMode]);

  // ── Clear pending timers on unmount ──────────────────────────────────────────
  useEffect(() => () => {
    if (saveTimerRef.current)    clearTimeout(saveTimerRef.current);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  // ── Canvas layer-order + common shortcuts (Cmd+[/], Cmd+D, Cmd+G) ────────────
  useEffect(() => {
    if (isPresenting) return;
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd) return;
      const ed = editorRef.current;
      if (e.key === ']' || e.key === '[') {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        if (e.key === ']' && !e.shiftKey) { ed.bringForward(ids);  return; }
        if (e.key === ']' &&  e.shiftKey) { ed.bringToFront(ids);  return; }
        if (e.key === '[' && !e.shiftKey) { ed.sendBackward(ids);  return; }
        if (e.key === '[' &&  e.shiftKey) { ed.sendToBack(ids);    return; }
      }
      if (e.key === 'd' && !e.shiftKey) {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        ed.duplicateShapes(ids, { x: 16, y: 16 });
        return;
      }
      if (e.key === 'g') {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        if (e.shiftKey) ed.ungroupShapes(ids, { select: true });
        else            ed.groupShapes(ids, { select: true });
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isPresenting]);

  // ── Theme handlers ────────────────────────────────────────────────────────────
  function handleThemeChange(updated: CanvasTheme) {
    setTheme(updated);
    const editor = editorRef.current;
    if (!editor) return;
    applyThemeToSlides(editor, updated);
  }

  function handlePresetField(variant: 'heading' | 'body', field: keyof CanvasTheme['heading'], value: string) {
    handleThemeChange({ ...theme, [variant]: { ...theme[variant], [field]: value } });
  }

  // ── tldraw component overrides ────────────────────────────────────────────────
  // In present mode: hide all editing UI so the canvas is view-only.
  const tlComponents = useMemo<TLComponents>(() => ({
    SharePanel: null, HelpMenu: null, Minimap: null, StylePanel: null,
    ContextMenu: null, // replaced by our shape context menu
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ErrorFallback: TlErrorFallback as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ShapeErrorFallback: TlShapeErrorFallback as any,
    ...(isPresenting ? {
      Toolbar: null, NavigationPanel: null, MenuPanel: null,
      TopPanel: null, ActionsMenu: null, HelperButtons: null, InFrontOfTheCanvas: null,
    } : {
      InFrontOfTheCanvas: CanvasOverlays,
    }),
  }), [isPresenting]);

  // ── Parse initial snapshot ONCE ───────────────────────────────────────────────
  // tldraw's `snapshot` prop is an "initial value" — re-passing on every render
  // causes tldraw to reset editor state on each save cycle.
  const snapshotRef = useRef<TLEditorSnapshot | undefined | null>(null);
  if (snapshotRef.current === null) {
    if (!content.trim()) {
      snapshotRef.current = undefined;
    } else {
      try { snapshotRef.current = JSON.parse(content) as TLEditorSnapshot; }
      catch (parseErr) {
        // IMPORTANT: do NOT fall back to `undefined` (empty canvas) here.
        // Throwing causes CanvasErrorBoundary to offer "restore from git" / "start fresh"
        // without touching the file at all.
        throw new Error(
          `Canvas file contains invalid JSON and cannot be opened safely. ` +
          `This usually means the file was truncated by a failed write. ` +
          `Use "Restore from last git commit" to recover your work. ` +
          `(${parseErr instanceof Error ? parseErr.message : String(parseErr)})`
        );
      }
    }
  }
  const snapshot = snapshotRef.current ?? undefined;

  // ── Mount handler — sets up all tldraw store listeners ───────────────────────
  function handleMount(editor: Editor) {
    editorRef.current = editor;
    onEditorReady?.(editor);

    try {
      editor.user.updateUserPreferences({ colorScheme: darkMode ? 'dark' : 'light', isSnapMode: true });
      editor.updateInstanceState({ isGridMode: true });
      // Professional flat defaults for new shapes.
      editor.setStyleForNextShapes(DefaultDashStyle,  'solid');
      editor.setStyleForNextShapes(DefaultFillStyle,  'none');
      editor.setStyleForNextShapes(DefaultColorStyle, 'black');
      editor.setStyleForNextShapes(DefaultFontStyle,  'sans');
      editor.setStyleForNextShapes(DefaultSizeStyle,  'm');
    } catch (err) {
      console.warn('[CanvasEditor] handleMount: editor setup error (non-fatal):', err);
    }

    try {
      const savedTheme = loadThemeFromDoc(editor);
      setTheme(savedTheme);
      applyThemeToSlides(editor, savedTheme);
    } catch (err) {
      console.warn('[CanvasEditor] handleMount: theme load error (non-fatal):', err);
    }

    try {
      const savedFontOverrides = loadFontOverrides(editor);
      applyFontOverridesToContainer(editor, savedFontOverrides);
    } catch (err) {
      console.warn('[CanvasEditor] handleMount: font overrides error (non-fatal):', err);
    }

    // ── Frame strip sync (debounced 80 ms) ──
    let syncFramesTimer: ReturnType<typeof setTimeout> | null = null;
    const syncFrames = () => {
      if (syncFramesTimer) clearTimeout(syncFramesTimer);
      syncFramesTimer = setTimeout(() => {
        try {
          const updated = editor.getCurrentPageShapesSorted()
            .filter((s) => s.type === 'frame')
            .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
          const prevCount = lastFrameCountRef.current;
          lastFrameCountRef.current = updated.length;
          setFrames(updated);
          setFrameIndex((prev) => Math.min(prev, Math.max(0, updated.length - 1)));
          if (updated.length > prevCount) {
            try { applyThemeToSlides(editor, loadThemeFromDoc(editor)); } catch { /* non-fatal */ }
          }
        } catch (err) {
          console.warn('[CanvasEditor] syncFrames error (non-fatal):', err);
        }
      }, 80);
    };
    syncFrames();
    editor.store.listen(syncFrames, { scope: 'document' });

    // Keep frameToolActive in sync with tldraw's active tool.
    editor.store.listen(
      () => { setFrameToolActive(editor.getCurrentToolId() === 'frame'); },
      { scope: 'session' },
    );

    // Enforce isThemeBg shapes stay at back. Guarded: skip during drag/resize.
    let bgEnforceRaf: number | null = null;
    editor.store.listen(
      () => {
        if (bgEnforceRaf !== null) return;
        bgEnforceRaf = requestAnimationFrame(() => {
          bgEnforceRaf = null;
          if (
            editor.isIn('select.translating') ||
            editor.isIn('select.resizing') ||
            editor.isIn('select.dragging_handle')
          ) return;
          try { enforceBgAtBack(editor); } catch { /* non-fatal */ }
        });
      },
      { scope: 'document' },
    );

    // Track the frame most centered in viewport → highlight strip card in edit mode.
    let viewportRaf: number | null = null;
    const updateViewportFrame = () => {
      const vp = editor.getViewportPageBounds();
      const vpCx = vp.x + vp.w / 2;
      const sortedF = editor.getCurrentPageShapesSorted()
        .filter((s) => s.type === 'frame')
        .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x) as AnyFrame[];
      if (sortedF.length === 0) return;
      let bestIdx = 0, bestDist = Infinity;
      sortedF.forEach((f, i) => {
        const d = Math.abs((f.x + f.props.w / 2) - vpCx);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      setFrameIndex(bestIdx);
    };
    editor.store.listen(() => {
      if (viewportRaf !== null) return;
      viewportRaf = requestAnimationFrame(() => { viewportRaf = null; updateViewportFrame(); });
    });

    // ── Debounced save + preview regeneration ──
    editor.store.listen(
      () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          try { onChangeRef.current(JSON.stringify(editor.getSnapshot())); }
          catch (err) { console.warn('[CanvasEditor] save serialization failed:', err); }
        }, 500);

        if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
        previewTimerRef.current = setTimeout(async () => {
          if (!canvasRelPath) return;
          try {
            setPreviewGenState('generating');
            const urls = await generateSlidePreviews(editor, workspacePath, canvasRelPath);
            setPreviewUrls(urls);
          } catch (err) {
            console.warn('[CanvasEditor] Preview generation failed:', err);
          } finally {
            setPreviewGenState('idle');
          }
        }, 900);
      },
      { scope: 'document' },
    );

    // ── AI mark user-edit detection ──
    editor.store.listen(
      (changes) => {
        const marks = aiMarksRef.current.filter((m) => !m.reviewed && m.canvasShapeIds?.length);
        if (marks.length === 0) return;
        const updatedIds = new Set([
          ...Object.keys(changes.changes.updated ?? {}),
          ...Object.keys(changes.changes.removed ?? {}),
        ]);
        for (const mark of marks) {
          if (mark.canvasShapeIds!.some((sid) => updatedIds.has(sid))) {
            onMarkUserEditedRef.current?.(mark.id);
          }
        }
      },
      { scope: 'document', source: 'user' },
    );

    // ── "Type to edit" — select a shape then type to enter text mode ──
    const TEXT_EDITABLE_TYPES = new Set(['geo', 'text', 'arrow', 'note']);
    const typeToEditHandler = (e: KeyboardEvent) => {
      if (editor.getEditingShapeId()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1 || e.key === ' ') return;
      const selected = editor.getSelectedShapes();
      if (selected.length !== 1) return;
      const shape = selected[0];
      if (!TEXT_EDITABLE_TYPES.has(shape.type)) return;
      e.stopPropagation();
      e.preventDefault();
      editor.setEditingShape(shape.id);
      requestAnimationFrame(() => {
        const el = editor.getContainer().querySelector<HTMLElement>('[contenteditable="true"]');
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('insertText', false, e.key);
      });
    };
    editor.getContainer().addEventListener('keydown', typeToEditHandler, true);
  }

  // ── Workspace image picker (drop to canvas center from image dialog) ──────────
  const handlePickWorkspaceImage = useCallback((relPath: string) => {
    const rect = mainDivRef.current?.getBoundingClientRect();
    handleSidebarFileDrop(
      relPath,
      rect ? rect.left + rect.width  / 2 : 0,
      rect ? rect.top  + rect.height / 2 : 0,
    );
  }, [handleSidebarFileDrop]);


  return (
    <div className={`canvas-editor${isPresenting ? ' canvas-editor--presenting' : ''}`}>

      {/* ── Main canvas ── */}
      <div
        ref={mainDivRef}
        className={`canvas-editor-main${isDragOver ? ' canvas-editor-main--dragover' : ''}`}
      >
        <CanvasAICtx.Provider value={{
          aiMarks: aiMarks.filter((m) => !m.reviewed),
          aiHighlight,
          aiNavIndex,
          onPrev: onAIPrev ?? (() => {}),
          onNext: onAINext ?? (() => {}),
          onReview: onMarkReviewed ?? (() => {}),
        }}>
          <Tldraw
            snapshot={snapshot}
            onMount={handleMount}
            components={tlComponents}
            cameraOptions={CAMERA_OPTIONS}
            options={TLDRAW_OPTIONS}
            assets={tauriAssetsStore}
          />
        </CanvasAICtx.Provider>

        {/* Drop-zone hint — visible while dragging an image over the canvas */}
        {isDragOver && (
          <div className="canvas-drop-hint">
            <div className="canvas-drop-hint-inner">
              <span className="canvas-drop-hint-icon">⬇</span>
              <span className="canvas-drop-hint-text">Drop image to add to canvas</span>
            </div>
          </div>
        )}

        {/* Floating canvas action buttons — top-right, hidden while presenting */}
        {!isPresenting && (
          <div className="canvas-action-btns">
            <button
              className={`canvas-img-btn${frameToolActive ? ' canvas-img-btn--active' : ''}`}
              onClick={() => {
                const ed = editorRef.current;
                if (!ed) return;
                if (frameToolActive) {
                  ed.setCurrentTool('select');
                } else {
                  ed.setCurrentTool('frame');
                }
              }}
              title={frameToolActive
                ? 'Drawing slide — drag to set size. Click or press Esc to cancel'
                : 'Draw a new slide — drag to set size (like Figma frames)'}
            >
              □ Slide
            </button>
            <button
              className="canvas-img-btn"
              onClick={() => { setImgDialogOpen(true); setImgUrlInput(''); setImgTab('url'); }}
              title="Add image"
            >
              ⊡ Image
            </button>
          </div>
        )}

        {/* Image dialog — extracted to CanvasImageDialog */}
        {imgDialogOpen && (
          <CanvasImageDialog
            workspacePath={workspacePath}
            imgUrlInput={imgUrlInput}
            setImgUrlInput={setImgUrlInput}
            imgTab={imgTab}
            setImgTab={setImgTab}
            wsImages={wsImages}
            wsImagesLoading={wsImagesLoading}
            onClose={() => setImgDialogOpen(false)}
            onAddFromUrl={(url) => { handleAddImageFromUrl(url); setImgDialogOpen(false); }}
            onPickWorkspaceImage={(relPath) => { handlePickWorkspaceImage(relPath); setImgDialogOpen(false); }}
            onLoadWsImages={loadWsImages}
          />
        )}

        {/* Present mode overlay — stage + navigation bar */}
        {isPresenting && (
          <CanvasPresentOverlay
            frameIndex={frameIndex}
            frames={frames}
            previewUrls={previewUrls}
            previewGenState={previewGenState}
            onExit={exitPresent}
            onGoToFrame={goToFrame}
          />
        )}
      </div>

      {/* ── Bottom bar: Slides + Theme ── */}
      <div className={`canvas-bottom-bar${isPresenting ? ' canvas-bottom-bar--presenting' : ''}`}>

        {/* Single header row: strip toggle | slide cards | theme toggle */}
        <div className="canvas-bottom-header">
          <CanvasSlideStrip
            frames={frames}
            frameIndex={frameIndex}
            editorRef={editorRef}
            onGoToFrame={goToFrame}
            onEnterPresent={enterPresent}
            onAddSlide={addSlide}
            onRescanFrames={rescanFrames}
            onExportFrame={exportFrame}
            onMoveFrameDir={moveFrameDir}
            onDuplicateFrame={duplicateFrame}
            onReorderFrames={reorderFrames}
            onFitSlide={() => {
              const ed = editorRef.current;
              if (ed && frames[frameIndex]) zoomToFrame(ed, frames[frameIndex] as AnyFrame);
            }}
          />

          {/* Right: theme toggle */}
          <button
            className={`canvas-theme-toggle${themeOpen ? ' canvas-theme-toggle--on' : ''}`}
            onClick={() => setThemeOpen((v) => !v)}
            title="Slide theme — backgrounds, heading & body presets"
          >
            ◈&nbsp;Theme
          </button>
        </div>

        {/* Theme body — expands below header when open */}
        {themeOpen && (
          <div className="canvas-theme-body">

            {/* Quick preset themes */}
            <div className="canvas-theme-section">
              <div className="canvas-theme-label">Presets</div>
              <div className="canvas-theme-presets">
                {PRESET_THEMES.map((p) => (
                  <button
                    key={p.label}
                    className="canvas-theme-preset"
                    style={{
                      '--pt-bg': TLDRAW_COLORS.find(([id]) => id === p.theme.slideBg)?.[1] ?? '#fff',
                      '--pt-txt': TLDRAW_COLORS.find(([id]) => id === p.theme.heading.color)?.[1] ?? '#000',
                    } as Record<string, string>}
                    onClick={() => handleThemeChange(p.theme)}
                    title={`Apply "${p.label}" theme to all slides`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Slide background */}
            <div className="canvas-theme-section">
              <div className="canvas-theme-label">Slide background</div>

              {/* Color swatches — dimmed while an image is active */}
              <div className={`canvas-fmt-colors${theme.slideBgImage ? ' canvas-fmt-colors--muted' : ''}`}>
                {TLDRAW_COLORS.map(([id, hex]) => (
                  <button
                    key={id}
                    className={`canvas-fmt-swatch${!theme.slideBgImage && theme.slideBg === id ? ' canvas-fmt-swatch--on' : ''}`}
                    style={{ '--swatch': hex } as Record<string, string>}
                    onClick={() => handleThemeChange({ ...theme, slideBg: id, slideBgImage: '' })}
                    title={`Slide background: ${id}`}
                  />
                ))}
              </div>

              {/* Image background — active preview or workspace picker */}
              {theme.slideBgImage ? (
                <div className="canvas-theme-bg-img-active">
                  <img
                    src={theme.slideBgImage}
                    alt="background"
                    className="canvas-theme-bg-img-preview"
                  />
                  <span className="canvas-theme-bg-img-label" title="Slide background image">
                    {theme.slideBgImage.startsWith('data:')
                      ? 'Custom image'
                      : (theme.slideBgImage.split('/').pop() ?? 'Image')}
                  </span>
                  <button
                    className="canvas-theme-bg-img-remove"
                    onClick={() => handleThemeChange({ ...theme, slideBgImage: '' })}
                    title="Remove image background"
                  >✕</button>
                </div>
              ) : (
                <div className="canvas-theme-bg-picker">
                  {wsImagesLoading ? (
                    <div className="canvas-theme-bg-picker-msg">Loading…</div>
                  ) : wsImages.length === 0 ? (
                    <div className="canvas-theme-bg-picker-msg">
                      No images in workspace
                      <button className="canvas-theme-bg-picker-refresh" onClick={loadWsImages}>↺</button>
                    </div>
                  ) : (
                    <>
                      {wsImages.map((relPath) => (
                        <button
                          key={relPath}
                          className="canvas-theme-bg-picker-thumb"
                          title={relPath}
                          onClick={async () => {
                            const absPath = `${workspacePath}/${relPath}`;
                            const ext = relPath.split('.').pop()?.toLowerCase() ?? 'jpg';
                            const MIME_MAP: Record<string, string> = {
                              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                              avif: 'image/avif', bmp: 'image/bmp',
                            };
                            const mimeType = MIME_MAP[ext] ?? 'image/jpeg';
                            try {
                              const bytes = await readFile(absPath);
                              const blob = new Blob([bytes], { type: mimeType });
                              const dataUrl = await new Promise<string>((res, rej) => {
                                const fr = new FileReader();
                                fr.onload = () => res(fr.result as string);
                                fr.onerror = rej;
                                fr.readAsDataURL(blob);
                              });
                              handleThemeChange({ ...theme, slideBgImage: dataUrl });
                            } catch (err) {
                              console.error('[slide bg] Failed to read image as data URL:', err);
                            }
                          }}
                        >
                          <img
                            src={convertFileSrc(`${workspacePath}/${relPath}`)}
                            alt={relPath.split('/').pop()}
                            className="canvas-theme-bg-picker-img"
                            loading="eager"
                          />
                        </button>
                      ))}
                      <button className="canvas-theme-bg-picker-refresh" onClick={loadWsImages} title="Refresh">↺</button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Slide Layout */}
            <div className="canvas-theme-section">
              <div className="canvas-theme-label-row">
                <div className="canvas-theme-label">Slide Layout</div>
                <button
                  className="canvas-theme-apply-btn"
                  onClick={() => {
                    const ed = editorRef.current;
                    const frame = frames[frameIndex] as AnyFrame | undefined;
                    if (!ed || !frame) return;
                    applySlideLayout(ed, frame, theme.defaultLayout ?? 'title-body', theme);
                    zoomToFrame(ed, frame);
                  }}
                  title="Apply selected layout to current slide (replaces existing title/body text)"
                >Apply to slide</button>
              </div>
              <div className="canvas-theme-layout-grid">
                {SLIDE_LAYOUT_OPTIONS.map((lo) => (
                  <button
                    key={lo.id}
                    className={`canvas-theme-layout-btn${(theme.defaultLayout ?? 'title-body') === lo.id ? ' canvas-theme-layout-btn--on' : ''}`}
                    onClick={() => handleThemeChange({ ...theme, defaultLayout: lo.id })}
                    title={lo.desc}
                  >
                    <span className="canvas-theme-layout-icon">{lo.icon}</span>
                    <span className="canvas-theme-layout-label">{lo.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Text presets: Heading & Body */}
            {(['heading', 'body'] as const).map((variant) => {
              const ps = theme[variant];
              const isEditing = editingPreset === variant;
              return (
                <div key={variant} className="canvas-theme-section">
                  <div className="canvas-theme-label-row">
                    <div className="canvas-theme-label">{variant === 'heading' ? 'Heading' : 'Body'}</div>
                    <button
                      className="canvas-theme-apply-btn"
                      onClick={() => insertTextPreset(variant)}
                      title={`Insert a ${variant} text shape into the current slide`}
                    >
                      ＋ Insert {variant === 'heading' ? 'Heading' : 'Body'}
                    </button>
                    <button
                      className={`canvas-theme-edit-btn${isEditing ? ' canvas-theme-edit-btn--on' : ''}`}
                      onClick={() => setEditingPreset(isEditing ? null : variant)}
                      title="Edit preset"
                    >✎</button>
                  </div>

                  {!isEditing && (
                    <div className="canvas-theme-preview-tag">
                      {ps.font} · {ps.size.toUpperCase()} · {ps.color}
                    </div>
                  )}

                  {isEditing && (
                    <div className="canvas-theme-preset-edit">
                      <div className="canvas-fmt-label">Font</div>
                      <div className="canvas-fmt-row">
                        {FONT_OPTIONS.map((f) => (
                          <button key={f.value}
                            className={`canvas-fmt-btn${ps.font === f.value ? ' canvas-fmt-btn--on' : ''}`}
                            onClick={() => handlePresetField(variant, 'font', f.value)}
                          >{f.label}</button>
                        ))}
                      </div>
                      <div className="canvas-fmt-label" style={{ marginTop: 4 }}>Size</div>
                      <div className="canvas-fmt-row">
                        {SIZE_OPTIONS.map((s) => (
                          <button key={s.value}
                            className={`canvas-fmt-btn${ps.size === s.value ? ' canvas-fmt-btn--on' : ''}`}
                            onClick={() => handlePresetField(variant, 'size', s.value)}
                          >{s.label}</button>
                        ))}
                      </div>
                      <div className="canvas-fmt-label" style={{ marginTop: 4 }}>Align</div>
                      <div className="canvas-fmt-row">
                        {ALIGN_OPTIONS.map((a) => (
                          <button key={a.value}
                            className={`canvas-fmt-btn${ps.align === a.value ? ' canvas-fmt-btn--on' : ''}`}
                            onClick={() => handlePresetField(variant, 'align', a.value)}
                            title={a.label}
                          >{a.icon}</button>
                        ))}
                      </div>
                      <div className="canvas-fmt-label" style={{ marginTop: 4 }}>Color</div>
                      <div className="canvas-fmt-colors">
                        {TLDRAW_COLORS.map(([id, hex]) => (
                          <button key={id}
                            className={`canvas-fmt-swatch${ps.color === id ? ' canvas-fmt-swatch--on' : ''}`}
                            style={{ '--swatch': hex } as Record<string, string>}
                            onClick={() => handlePresetField(variant, 'color', id)}
                            title={id}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Shape context menus, lock pill, and lock flash — portal-rendered */}
      <CanvasContextMenus
        editorRef={editorRef}
        shapeCtxMenu={shapeCtxMenu}
        setShapeCtxMenu={setShapeCtxMenu}
        lockPill={lockPill}
        setLockPill={setLockPill}
        lockFlash={lockFlash}
      />

    </div>
  );
}
