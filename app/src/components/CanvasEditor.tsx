import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor, TLEditorSnapshot, TLShape, TLComponents, TLShapeId } from 'tldraw';
import {
  Tldraw, exportAs, createShapeId, toRichText,
  DefaultColorStyle, DefaultSizeStyle, DefaultFontStyle,
  DefaultFillStyle, DefaultDashStyle,
} from 'tldraw';
import { writeFile, mkdir, exists, readFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AIEditMark } from '../types';
import { generateSlidePreviews, loadSlidePreviews } from '../utils/slidePreviews';
import { getMimeType, IMAGE_EXTS } from '../utils/mime';
import { walkFilesFlat } from '../services/workspace';
import { placeImageOnCanvas } from '../utils/canvasAI';
import 'tldraw/tldraw.css';
import './CanvasEditor.css';

// canvas/ submodules
import { CanvasAICtx } from './canvas/CanvasAIContext';
import {
  SLIDE_W, SLIDE_H, SLIDE_GAP, CAMERA_OPTIONS, TLDRAW_OPTIONS,
  FONT_OPTIONS, SIZE_OPTIONS, ALIGN_OPTIONS, TLDRAW_COLORS,
} from './canvas/canvasConstants';
import type { CanvasTheme, TextStyle, AnyFrame } from './canvas/canvasTypes';
import {
  DEFAULT_THEME, PRESET_THEMES,
  loadThemeFromDoc, applyThemeToSlides, enforceBgAtBack, applyTextPreset,
  SLIDE_LAYOUT_OPTIONS, applySlideLayout,
} from './canvas/canvasTheme';
import { tauriAssetsStore } from './canvas/canvasAssets';
import { loadFontOverrides, applyFontOverridesToContainer } from './canvas/canvasFontOverrides';
import { CanvasOverlays } from './canvas/CanvasOverlays';

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
  rescanFramesRef,
  forceSaveRef,
  aiMarks = [], aiHighlight = false, aiNavIndex = 0,
  onAIPrev, onAINext, onMarkReviewed, onMarkUserEdited,
  darkMode = true,
  onFileSaved,
  canvasRelPath,
}: CanvasEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Ref so the store listener always calls the latest onChange even if the
  // prop identity changes (e.g. after a workspace config update in App.tsx).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Tracks the frame count after the last syncFrames call, so we can detect
  // newly added frames and apply the current theme to them.
  const lastFrameCountRef = useRef<number>(0);
  // Refs for AI mark callbacks (always-fresh without recreating listeners)
  const aiMarksRef = useRef(aiMarks);
  aiMarksRef.current = aiMarks;
  const onMarkUserEditedRef = useRef(onMarkUserEdited);
  onMarkUserEditedRef.current = onMarkUserEdited;

  const [isPresenting, setIsPresenting] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [frames, setFrames] = useState<TLShape[]>([]);
  // Slide PNG preview state — populated on save (background) and when entering present mode
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [previewGenState, setPreviewGenState] = useState<'idle' | 'generating'>('idle');
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  const [theme, setTheme] = useState<CanvasTheme>(DEFAULT_THEME);
  const [themeOpen, setThemeOpen] = useState(false);
  // Load workspace images whenever the theme panel opens
  useEffect(() => { if (themeOpen && wsImages.length === 0 && !wsImagesLoading) loadWsImages(); }, [themeOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editingPreset, setEditingPreset] = useState<'heading' | 'body' | null>(null);
  const [imgDialogOpen, setImgDialogOpen] = useState(false);
  const [imgUrlInput, setImgUrlInput] = useState('');
  const [imgTab, setImgTab] = useState<'url' | 'workspace'>('url');
  const [wsImages, setWsImages] = useState<string[]>([]);
  const [wsImagesLoading, setWsImagesLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Whether the frame/slide draw tool is currently active (activated from the toolbar)
  const [frameToolActive, setFrameToolActive] = useState(false);
  // Slide strip drag-to-reorder state
  const [stripDragIdx, setStripDragIdx] = useState<number | null>(null);
  const [stripDragOverIdx, setStripDragOverIdx] = useState<number | null>(null);
  // Right-click context menu state (slide strip)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; frameIdx: number } | null>(null);
  // Right-click context menu for canvas shapes (unlocked only)
  const [shapeCtxMenu, setShapeCtxMenu] = useState<{ x: number; y: number; shapeId: TLShapeId; isLocked: boolean } | null>(null);
  // Long-press unlock pill — shown after holding down on a locked shape
  const [lockPill, setLockPill] = useState<{ x: number; y: number; shapeId: TLShapeId } | null>(null);
  // Brief animated lock icon shown the moment the user first touches a locked shape
  const [lockFlash, setLockFlash] = useState<{ x: number; y: number } | null>(null);
  const lockFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainDivRef = useRef<HTMLDivElement>(null);
  // Holds latest drop handler references so native capture listeners always call the current version
  const nativeDropRef = useRef<{
    sidebar: (relPath: string, cx: number, cy: number) => void;
    external: (files: FileList, cx: number, cy: number) => void;
  }>({ sidebar: () => {}, external: () => {} });
  const stripScrollRef = useRef<HTMLDivElement>(null);
  const onSlideCountChangeRef = useRef(onSlideCountChange);
  onSlideCountChangeRef.current = onSlideCountChange;

  // Notify parent whenever slide count changes
  useEffect(() => {
    onSlideCountChangeRef.current?.(frames.length);
  }, [frames.length]);

  // Keep tldraw's dark mode in sync with the app theme setting
  useEffect(() => {
    editorRef.current?.user.updateUserPreferences({ colorScheme: darkMode ? 'dark' : 'light' });
  }, [darkMode]);

  // Scroll the active strip card into view whenever the slide position changes
  useEffect(() => {
    const container = stripScrollRef.current;
    if (!container) return;
    const card = container.querySelector<HTMLElement>(`[data-strip-index="${frameIndex}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [frameIndex]);

  // tldraw component overrides — rebuilt only when isPresenting changes.
  // In present mode: hide all editing UI (toolbars, panels, menus) so the
  // canvas shows the slide content only with no distractions.
  const tlComponents = useMemo<TLComponents>(() => ({
    SharePanel: null,
    HelpMenu: null,
    Minimap: null,
    StylePanel: null,
    ContextMenu: null, // we provide our own shape context menu (lock/unlock)
    // Override tldraw's built-in error dialogs — we log the real error and show
    // a friendlier recovery message instead of the "Reset data" trap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ErrorFallback: TlErrorFallback as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ShapeErrorFallback: TlShapeErrorFallback as any,
    ...(isPresenting ? {
      Toolbar: null,
      NavigationPanel: null,
      MenuPanel: null,
      TopPanel: null,
      ActionsMenu: null,
      HelperButtons: null,
      InFrontOfTheCanvas: null,
    } : {
      InFrontOfTheCanvas: CanvasOverlays,
    }),
  }), [isPresenting]);

  // Clear pending timers on unmount to avoid calling onChange / generating
  // previews after the component is no longer active.
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  // Parse the initial snapshot ONCE — tldraw's `snapshot` prop is an
  // "initial value" (like defaultValue on an input). Re-passing a new object
  // on every render causes tldraw to reset editor state on each save cycle.
  const snapshotRef = useRef<TLEditorSnapshot | undefined | null>(null);
  if (snapshotRef.current === null) {
    if (!content.trim()) {
      snapshotRef.current = undefined;
    } else {
      try { snapshotRef.current = JSON.parse(content) as TLEditorSnapshot; }
      catch (parseErr) {
        // IMPORTANT: do NOT fall back to `undefined` (empty canvas) here.
        // If we did, tldraw would mount a blank canvas, the debounced store
        // listener would fire within 500 ms, and onChange() would write that
        // blank snapshot to disk — permanently overwriting whatever was in the
        // (possibly truncated) file. Throwing causes CanvasErrorBoundary to
        // intercept it and offer "restore from git" / "start fresh" options
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

  // ── Frame utilities ──────────────────────────────────────────────────────────
  const zoomToFrame = useCallback((editor: Editor, frame: TLShape) => {
    const bounds = editor.getShapePageBounds(frame.id);
    if (bounds) editor.zoomToBounds(bounds, { animation: { duration: 350 }, inset: 40 });
  }, []);

  // Apply a new theme and persist it. Calls applyThemeToSlides which injects/
  // updates background rects inside every frame, then saves to document meta.
  function handleThemeChange(updated: CanvasTheme) {
    setTheme(updated);
    const editor = editorRef.current;
    if (!editor) return;
    applyThemeToSlides(editor, updated);
  }

  // When the user edits a specific preset field (e.g. heading.font = 'serif'),
  // merge and re-apply.
  function handlePresetField(variant: 'heading' | 'body', field: keyof TextStyle, value: string) {
    handleThemeChange({
      ...theme,
      [variant]: { ...theme[variant], [field]: value },
    });
  }

  async function handleAddImageFromUrl(rawUrl: string) {
    const editor = editorRef.current;
    if (!editor || !rawUrl.trim()) return;
    const url = rawUrl.trim();

    // Detect mime type from extension
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? 'png';
    const mimeType = getMimeType(ext, 'image/png');

    // Measure natural dimensions via browser Image
    let natW = 800;
    let natH = 600;
    try {
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => { natW = img.naturalWidth || 800; natH = img.naturalHeight || 600; resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      });
    } catch { /* use defaults */ }

    placeImageOnCanvas(editor, url, url.split('/').pop()?.split('?')[0] ?? 'image', mimeType, natW, natH);
  }

  function slugFile(name: string) {
    return name.replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-').toLowerCase();
  }

  // ── Drop from OS (external files) ────────────────────────────────────────────
  async function handleExternalFileDrop(files: FileList, dropClientX: number, dropClientY: number) {
    const editor = editorRef.current;
    if (!editor) return;
    // Convert drop client coords → tldraw page coords
    const rect = mainDivRef.current?.getBoundingClientRect();
    const screenX = dropClientX - (rect?.left ?? 0);
    const screenY = dropClientY - (rect?.top ?? 0);
    const pagePos = editor.screenToPage({ x: screenX, y: screenY });
    // Stagger multiple images
    let offsetX = 0;
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
      if (!IMAGE_EXTS.has(ext)) continue;
      const mimeType = getMimeType(ext, 'image/png');
      // Save to workspace/images/
      const imagesDir = `${workspacePath}/images`;
      if (!(await exists(imagesDir))) await mkdir(imagesDir, { recursive: true });
      const filename = slugFile(file.name);
      const absPath = `${imagesDir}/${filename}`;
      const buf = await file.arrayBuffer();
      await writeFile(absPath, new Uint8Array(buf));
      // Measure dimensions via object URL
      const objUrl = URL.createObjectURL(file);
      const { natW, natH } = await new Promise<{ natW: number; natH: number }>((resolve) => {
        const img = new Image();
        img.onload = () => { resolve({ natW: img.naturalWidth || 800, natH: img.naturalHeight || 600 }); URL.revokeObjectURL(objUrl); };
        img.onerror = () => { resolve({ natW: 800, natH: 600 }); URL.revokeObjectURL(objUrl); };
        img.src = objUrl;
      });
      const src = convertFileSrc(absPath);
      placeImageOnCanvas(editor, src, filename, mimeType, natW, natH, { dropX: pagePos.x + offsetX, dropY: pagePos.y });
      offsetX += Math.round(Math.min(natW, 800) + 20);
    }
    // Refresh workspace image lists after all files are saved
    loadWsImages();
    onFileSaved?.();
  }

  // ── Drop from sidebar (workspace file path via data transfer) ────────────────
  async function handleSidebarFileDrop(relPath: string, dropClientX: number, dropClientY: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXTS.has(ext)) return;
    const mimeType = getMimeType(ext, 'image/png');
    const absPath = `${workspacePath}/${relPath}`;
    const src = convertFileSrc(absPath);
    // Measure via asset URL
    const { natW, natH } = await new Promise<{ natW: number; natH: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ natW: img.naturalWidth || 800, natH: img.naturalHeight || 600 });
      img.onerror = () => resolve({ natW: 800, natH: 600 });
      img.src = src;
    });
    const rect = mainDivRef.current?.getBoundingClientRect();
    const screenX = dropClientX - (rect?.left ?? 0);
    const screenY = dropClientY - (rect?.top ?? 0);
    const pagePos = editor.screenToPage({ x: screenX, y: screenY });
    placeImageOnCanvas(editor, src, relPath.split('/').pop() ?? relPath, mimeType, natW, natH, { dropX: pagePos.x, dropY: pagePos.y });
  }

  // Keep native drop ref in sync with latest handler closures (must be after the handler functions)
  nativeDropRef.current.sidebar = handleSidebarFileDrop;
  nativeDropRef.current.external = handleExternalFileDrop;

  // ── Workspace image browser ───────────────────────────────────────────────
  async function loadWsImages() {
    setWsImagesLoading(true);
    try {
      const WS_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
      const images = await walkFilesFlat(workspacePath, '', (_, ext) => WS_IMG_EXTS.has(ext));
      setWsImages(images);
    } catch {
      setWsImages([]);
    } finally {
      setWsImagesLoading(false);
    }
  }

  // ── Native capture-phase drag listeners (intercept before tldraw) ──────────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;

    function onDragOver(e: DragEvent) {
      const hasWsFile = e.dataTransfer?.types.includes('text/x-workspace-file');
      const hasFiles  = e.dataTransfer?.types.includes('Files');
      if (!hasWsFile && !hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    }
    function onDragLeave(e: DragEvent) {
      if (!(el as HTMLDivElement).contains(e.relatedTarget as Node)) setIsDragOver(false);
    }
    function onDrop(e: DragEvent) {
      const hasWsFile = e.dataTransfer?.types.includes('text/x-workspace-file');
      const hasFiles  = e.dataTransfer?.files && e.dataTransfer.files.length > 0;
      if (!hasWsFile && !hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const wsFile = e.dataTransfer?.getData('text/x-workspace-file');
      if (wsFile) {
        nativeDropRef.current.sidebar(wsFile, e.clientX, e.clientY);
        return;
      }
      if (e.dataTransfer?.files.length) {
        nativeDropRef.current.external(e.dataTransfer.files, e.clientX, e.clientY);
      }
    }

    el.addEventListener('dragover',   onDragOver,   true);
    el.addEventListener('dragleave',  onDragLeave,  true);
    el.addEventListener('drop',       onDrop,       true);
    return () => {
      el.removeEventListener('dragover',  onDragOver,  true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop',      onDrop,      true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addSlide() {
    const editor = editorRef.current;
    if (!editor) return;
    const last = frames[frames.length - 1] as AnyFrame | undefined;
    const x = last ? last.x + (last.props.w ?? SLIDE_W) + SLIDE_GAP : 0;
    const y = last ? last.y : 0;
    editor.createShape({
      type: 'frame',
      x,
      y,
      props: { w: SLIDE_W, h: SLIDE_H, name: `Slide ${frames.length + 1}` },
    });
    // Zoom to the newly created frame and explicitly sync frames state.
    // The store listener will also fire asynchronously (with its 80 ms debounce),
    // but we call rescanFrames() immediately so the strip updates without delay.
    setTimeout(() => {
      const updated = editor.getCurrentPageShapesSorted()
        .filter((s) => s.type === 'frame')
        .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
      lastFrameCountRef.current = updated.length;
      setFrames(updated); // explicit sync
      const newFrame = updated[updated.length - 1];
      if (newFrame) {
        zoomToFrame(editor, newFrame);
        setFrameIndex(updated.length - 1);
      }
      // Apply the active theme so the new slide gets its background rect.
      const currentTheme = loadThemeFromDoc(editor);
      applyThemeToSlides(editor, currentTheme);
      // Apply the default slide layout (inserts title + body text shapes etc.)
      const layoutId = currentTheme.defaultLayout ?? 'title-body';
      if (layoutId !== 'blank' && newFrame) {
        applySlideLayout(editor, newFrame as AnyFrame, layoutId, currentTheme);
      }
    }, 60);
  }

  /** Force-rescan all frames from the live editor state and refresh the strip.
   *  Useful when frames were created programmatically or the strip looks stale.
   *  Exposed imperatively via rescanFramesRef so AIPanel can call it after
   *  canvas_op without depending solely on the debounced store listener. */
  function rescanFrames() {
    const editor = editorRef.current;
    if (!editor) return;
    const updated = editor.getCurrentPageShapesSorted()
      .filter((s) => s.type === 'frame')
      .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
    lastFrameCountRef.current = updated.length;
    setFrames(updated);
    setFrameIndex((prev) => Math.min(prev, Math.max(0, updated.length - 1)));
    if (updated.length > 0) {
      applyThemeToSlides(editor, loadThemeFromDoc(editor));
    }
  }
  // Keep the ref in sync on every render so callers always see the latest closure.
  if (rescanFramesRef) rescanFramesRef.current = rescanFrames;

  /** Immediately flush the current tldraw snapshot via onChange, cancelling any
   *  pending debounce timer. Called by the parent on Cmd/Ctrl+S so the user
   *  never loses work that sits inside the 500 ms debounce window. */
  function forceSave() {
    const editor = editorRef.current;
    if (!editor) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try { onChangeRef.current(JSON.stringify(editor.getSnapshot())); }
    catch (err) { console.warn('[CanvasEditor] forceSave serialization failed:', err); }
  }
  if (forceSaveRef) forceSaveRef.current = forceSave;

  async function exportFrame(frame: TLShape, idx: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const name = (frame as AnyFrame).props?.name || `Slide ${idx + 1}`;
    await exportAs(editor, [frame.id as TLShapeId], { format: 'png', name });
  }

  /** Swap x-positions of two slides to reorder them. */
  /** Insert a themed text shape (heading or body) into the current visible slide. */
  function insertTextPreset(variant: 'heading' | 'body') {
    const editor = editorRef.current;
    if (!editor) return;
    applyTextPreset(editor, variant, theme); // set pen styles / apply to any selection
    const targetFrame = frames[frameIndex] as AnyFrame | undefined;
    if (!targetFrame) return;
    const s = variant === 'heading' ? theme.heading : theme.body;
    const PAD = 60;
    const yOff = variant === 'heading' ? PAD : PAD + 140;
    const textId = createShapeId();
    editor.createShape({
      id: textId,
      type: 'text',
      parentId: targetFrame.id as TLShapeId,
      x: PAD,
      y: yOff,
      meta: { textRole: variant },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: {
        richText: toRichText(variant === 'heading' ? 'Heading' : 'Body text'),
        color: s.color,
        size: s.size,
        font: s.font,
        textAlign: s.align,
        autoSize: true,
      },
    } as any);
    editor.setSelectedShapes([textId]);
    editor.setEditingShape(textId as TLShapeId);
    zoomToFrame(editor, targetFrame);
  }

  function reorderFrames(fromIdx: number, toIdx: number) {
    const editor = editorRef.current;
    if (!editor || fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= frames.length || toIdx >= frames.length) return;
    // Collect all current x-positions in sorted order, then reassign
    const newOrder = [...frames];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    const xPositions = frames.map((f) => (f as AnyFrame).x).sort((a, b) => a - b);
    newOrder.forEach((frame, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id: frame.id, type: 'frame', x: xPositions[i] } as any);
    });
    setFrames(newOrder);
    setFrameIndex(toIdx);
  }

  /** Duplicate a frame/slide with all its children, placed after the original. */
  function duplicateFrame(idx: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const frame = frames[idx] as AnyFrame;
    editor.duplicateShapes([frame.id as TLShapeId], { x: frame.props.w + SLIDE_GAP, y: 0 });
  }

  /** Move a slide one position left (dir=-1) or right (dir=+1). */
  function moveFrameDir(idx: number, dir: -1 | 1) {
    reorderFrames(idx, idx + dir);
  }

  // ── Present mode ─────────────────────────────────────────────────────────────
  async function enterPresent(startIdx = 0) {
    const editor = editorRef.current;
    if (!editor) return;
    const sorted = editor.getCurrentPageShapesSorted()
      .filter((s) => s.type === 'frame')
      .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
    setFrames(sorted);
    setFrameIndex(startIdx);
    setIsPresenting(true);
    // Deselect everything and switch to the hand tool so the canvas becomes
    // view-only: users can pan (drag) and pinch/scroll to zoom, but cannot
    // select, move, or edit any shape.
    editor.setSelectedShapes([]);
    editor.setCurrentTool('hand');
    if (sorted.length > 0) zoomToFrame(editor, sorted[startIdx]);
    else editor.zoomToFit({ animation: { duration: 350 } });

    // Load existing PNG previews or generate them on first open.
    if (!canvasRelPath) return;
    const existing = await loadSlidePreviews(workspacePath, canvasRelPath);
    if (existing.length > 0) {
      setPreviewUrls(existing);
    } else {
      try {
        setPreviewGenState('generating');
        const urls = await generateSlidePreviews(editor, workspacePath, canvasRelPath);
        setPreviewUrls(urls);
      } catch (err) {
        console.warn('[CanvasEditor] Preview generation on present failed:', err);
      } finally {
        setPreviewGenState('idle');
      }
    }
  }

  function exitPresent() {
    const editor = editorRef.current;
    // Restore the default select tool so editing works again after preview ends.
    editor?.setCurrentTool('select');
    setIsPresenting(false);
    onPresentModeChange?.(false);
  }

  // Sync controlled presentMode prop → internal state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (presentModeProp === undefined) return;
    if (presentModeProp && !isPresenting) enterPresent(0);
    else if (!presentModeProp && isPresenting) exitPresent();
  // Re-run only when the prop changes, not on every isPresenting change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentModeProp]);

  function goToFrame(idx: number) {
    const editor = editorRef.current;
    if (!editor || frames.length === 0) return;
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    setFrameIndex(clamped);
    zoomToFrame(editor, frames[clamped]);
  }

  // ── Capture-phase contextmenu: only for unlocked shapes (Lock + Delete) ──────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;
    function onContextMenu(e: MouseEvent) {
      const editor = editorRef.current;
      if (!editor) return;
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-strip') || target.closest('.canvas-strip-scroll') || target.closest('.canvas-theme-body')) return;
      const rect = el!.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const pagePoint = editor.screenToPage({ x: screenX, y: screenY });
      const shapes = editor.getCurrentPageShapes();
      let hit: TLShape | null = null;
      for (const shape of shapes) {
        if (shape.type === 'frame') continue;
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) continue;
        if (
          pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
          pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h
        ) {
          hit = shape;
        }
      }
      if (!hit) return;
      // Always suppress the native browser context menu on canvas shapes
      e.preventDefault();
      e.stopPropagation();
      // Locked shapes: suppress only — the unlock UI is shown via long-press
      if (hit.isLocked) return;
      const MENU_W = 180;
      const cx = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
      const cy = Math.min(e.clientY, window.innerHeight - 140 - 6);
      setShapeCtxMenu({ x: cx, y: cy, shapeId: hit.id as TLShapeId, isLocked: false });
    }
    el.addEventListener('contextmenu', onContextMenu, true);
    return () => el.removeEventListener('contextmenu', onContextMenu, true);
  }, []); // refs are stable — no deps needed

  // ── Long-press on a locked shape → show the Unlock pill ──────────────────────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return; // left button only
      startX = e.clientX;
      startY = e.clientY;
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);

      // Immediately show a brief lock-flash if the press lands on a locked (non-bg) shape
      const editorNow = editorRef.current;
      const elNow = mainDivRef.current;
      if (editorNow && elNow) {
        const rectNow = elNow.getBoundingClientRect();
        const ppNow = editorNow.screenToPage({ x: startX - rectNow.left, y: startY - rectNow.top });
        for (const shape of editorNow.getCurrentPageShapes()) {
          if (shape.type === 'frame' || !shape.isLocked || (shape.meta as Record<string, unknown>)?.isThemeBg) continue;
          const bounds = editorNow.getShapePageBounds(shape.id);
          if (!bounds) continue;
          if (ppNow.x >= bounds.x && ppNow.x <= bounds.x + bounds.w &&
              ppNow.y >= bounds.y && ppNow.y <= bounds.y + bounds.h) {
            if (lockFlashTimerRef.current) clearTimeout(lockFlashTimerRef.current);
            setLockFlash({ x: startX, y: startY });
            lockFlashTimerRef.current = setTimeout(() => setLockFlash(null), 1000);
            break;
          }
        }
      }

      longPressTimerRef.current = setTimeout(() => {
        const editor = editorRef.current;
        if (!editor || !el) return;
        const rect = el.getBoundingClientRect();
        const pagePoint = editor.screenToPage({ x: startX - rect.left, y: startY - rect.top });
        const shapes = editor.getCurrentPageShapes();
        let hit: TLShape | null = null;
        for (const shape of shapes) {
          // Exclude frames, unlocked shapes, and theme-bg shapes from unlock pill
          if (shape.type === 'frame' || !shape.isLocked || (shape.meta as Record<string, unknown>)?.isThemeBg) continue;
          const bounds = editor.getShapePageBounds(shape.id);
          if (!bounds) continue;
          if (
            pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
            pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h
          ) {
            hit = shape;
          }
        }
        if (!hit) return;
        // Clear flash before showing the pill
        if (lockFlashTimerRef.current) clearTimeout(lockFlashTimerRef.current);
        setLockFlash(null);
        // Position the pill just above the press point, clamped to the viewport
        const PILL_W = 120;
        const PILL_H = 36;
        const px = Math.min(Math.max(startX - PILL_W / 2, 6), window.innerWidth  - PILL_W - 6);
        const py = Math.max(startY - PILL_H - 12, 6);
        setLockPill({ x: px, y: py, shapeId: hit.id as TLShapeId });
      }, 500);
    }

    function cancel() {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }

    function onPointerMove(e: PointerEvent) {
      // Cancel if pointer drifted more than 6 px (it became a drag, not a hold)
      if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancel();
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup',   cancel);
    el.addEventListener('pointercancel', cancel);
    return () => {
      cancel();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup',   cancel);
      el.removeEventListener('pointercancel', cancel);
    };
  }, []); // refs are stable

  // Keyboard navigation while presenting
  useEffect(() => {
    if (!isPresenting) return;
    function onKey(e: KeyboardEvent) {
      // Always exit on Escape (let other listeners see it too)
      if (e.key === 'Escape') { exitPresent(); return; }
      // Arrow / space = slide navigation
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        setFrameIndex((prev) => {
          const next = Math.min(prev + 1, frames.length - 1);
          const ed = editorRef.current;
          if (ed && frames[next]) zoomToFrame(ed, frames[next]);
          return next;
        });
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setFrameIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          const ed = editorRef.current;
          if (ed && frames[next]) zoomToFrame(ed, frames[next]);
          return next;
        });
        return;
      }
      // Swallow every other keypress in capture phase so tldraw tool
      // shortcuts (v, h, d, …) can't fire while we're in present mode.
      e.stopPropagation();
    }
    // capture: true — fires before tldraw's bubble-phase keydown listeners,
    // which lets stopPropagation prevent tool-switching shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isPresenting, frames, zoomToFrame]);

  // ── Canvas layer-order + common shortcuts (Cmd+[/]) ───────────────────────────
  useEffect(() => {
    if (isPresenting) return;
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd) return;
      const ed = editorRef.current;
      // Layer order: Cmd+]  bring forward, Cmd+Shift+]  bring to front
      //              Cmd+[  send backward, Cmd+Shift+[  send to back
      if (e.key === ']' || e.key === '[') {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        if (e.key === ']' && !e.shiftKey) { ed.bringForward(ids); return; }
        if (e.key === ']' &&  e.shiftKey) { ed.bringToFront(ids); return; }
        if (e.key === '[' && !e.shiftKey) { ed.sendBackward(ids); return; }
        if (e.key === '[' &&  e.shiftKey) { ed.sendToBack(ids); return; }
      }
      // Cmd+D — duplicate selected shapes
      if (e.key === 'd' && !e.shiftKey) {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        ed.duplicateShapes(ids, { x: 16, y: 16 });
        return;
      }
      // Cmd+G — group, Cmd+Shift+G — ungroup
      if (e.key === 'g') {
        if (!ed) return;
        const ids = ed.getSelectedShapeIds();
        if (ids.length === 0) return;
        e.preventDefault();
        if (e.shiftKey) {
          ed.ungroupShapes(ids, { select: true });
        } else {
          ed.groupShapes(ids, { select: true });
        }
        return;
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isPresenting]);

  // ── Mount ─────────────────────────────────────────────────────────────────────
  function handleMount(editor: Editor) {
    editorRef.current = editor;
    onEditorReady?.(editor);

    // Apply app-level dark/light theme immediately on mount.
    // isSnapMode: true → snapping is always active (no modifier key needed),
    // which also makes the alignment guide lines appear whenever a snap fires.
    try {
      editor.user.updateUserPreferences({
        colorScheme: darkMode ? 'dark' : 'light',
        isSnapMode: true,
      });
      // Enable grid (visible dot grid + snap-to-grid) by default
      editor.updateInstanceState({ isGridMode: true });

      // ── Professional flat defaults ──────────────────────────────────────────
      // Ensure new shapes look clean and polished rather than hand-drawn.
      editor.setStyleForNextShapes(DefaultDashStyle,      'solid');
      editor.setStyleForNextShapes(DefaultFillStyle,      'none');
      editor.setStyleForNextShapes(DefaultColorStyle,     'black');
      editor.setStyleForNextShapes(DefaultFontStyle,      'sans');
      editor.setStyleForNextShapes(DefaultSizeStyle,      'm');
    } catch (err) {
      console.warn('[CanvasEditor] handleMount: editor setup error (non-fatal):', err);
    }

    // Load persisted theme from document meta and apply backgrounds.
    // Wrapped separately so a corrupt theme doesn't prevent the rest of mount.
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

    // Keep frame strip in sync — listen on ALL sources (not just 'user') so that
    // AI-agent canvas commands (which run asynchronously outside user-event context)
    // also trigger the strip update. Debounced 80 ms to avoid flooding React with
    // tldraw's internal micro-transactions.
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
          // When new frames appear, apply the current theme so they get the bg rect.
          if (updated.length > prevCount) {
            try {
              const currentTheme = loadThemeFromDoc(editor);
              applyThemeToSlides(editor, currentTheme);
            } catch { /* theme apply on new frame failed — non-fatal */ }
          }
        } catch (err) {
          console.warn('[CanvasEditor] syncFrames error (non-fatal):', err);
        }
      }, 80);
    };
    syncFrames(); // populate immediately on mount
    editor.store.listen(syncFrames, { scope: 'document' });

    // Keep frameToolActive in sync with tldraw's current active tool
    editor.store.listen(
      () => { setFrameToolActive(editor.getCurrentToolId() === 'frame'); },
      { scope: 'session' },
    );

    // Enforce that isThemeBg shapes always stay at the back of their parent frame.
    // Runs on every store change (debounced to animation frame).
    // Guard: skip during active translate/resize to avoid interfering with tldraw's
    // state machine while the user is dragging shapes.
    let bgEnforceRaf: number | null = null;
    editor.store.listen(
      () => {
        if (bgEnforceRaf !== null) return;
        bgEnforceRaf = requestAnimationFrame(() => {
          bgEnforceRaf = null;
          // Do not call sendToBack() while shapes are being actively dragged or
          // resized — it can confuse tldraw's translating state and trigger
          // internal errors caught by the error boundary.
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

    // Track which frame is most centered in the viewport and update frameIndex.
    // This makes the strip highlight follow the camera even outside present mode.
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
    // No scope filter so camera/instance changes (which aren't 'document') fire too.
    editor.store.listen(() => {
      if (viewportRaf !== null) return;
      viewportRaf = requestAnimationFrame(() => { viewportRaf = null; updateViewportFrame(); });
    });

    // Debounced save — listen on ALL sources so AI-created shapes are persisted
    // immediately rather than waiting for the next manual user edit.
    editor.store.listen(
      () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          try { onChangeRef.current(JSON.stringify(editor.getSnapshot())); }
          catch (err) { console.warn('[CanvasEditor] save serialization failed:', err); }
        }, 500);

        // Regenerate slide PNG previews 900ms after the last store change
        // (slightly after the save debounce so the file is already on disk).
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

    // AI mark user-edit detection — when the user modifies a shape that belongs
    // to an AI mark, call onMarkUserEdited so the mark can be removed.
    editor.store.listen(
      (changes) => {
        const marks = aiMarksRef.current.filter((m) => !m.reviewed && m.canvasShapeIds?.length);
        if (marks.length === 0) return;
        const updatedIds = new Set([
          ...Object.keys(changes.changes.updated ?? {}),
          ...Object.keys(changes.changes.removed ?? {}),
        ]);
        for (const mark of marks) {
          const touched = mark.canvasShapeIds!.some((sid) => updatedIds.has(sid));
          if (touched) {
            onMarkUserEditedRef.current?.(mark.id);
          }
        }
      },
      { scope: 'document', source: 'user' },
    );

    // ── "Type to edit" — select a shape and start typing to enter text mode ──
    // When exactly one shape is selected and the user presses a printable key,
    // skip tldraw's tool-shortcut handling and go straight into text editing.
    // We listen in the capture phase so we run before tldraw's own key handlers.
    const TEXT_EDITABLE_TYPES = new Set(['geo', 'text', 'arrow', 'note']);
    const typeToEditHandler = (e: KeyboardEvent) => {
      if (editor.getEditingShapeId()) return;        // already in text edit
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave shortcuts alone
      if (e.key.length !== 1 || e.key === ' ') return; // non-printable / space
      const selected = editor.getSelectedShapes();
      if (selected.length !== 1) return;
      const shape = selected[0];
      if (!TEXT_EDITABLE_TYPES.has(shape.type)) return;

      // Claim the event so tldraw doesn't use it as a tool shortcut
      e.stopPropagation();
      e.preventDefault();

      editor.setEditingShape(shape.id);

      // Wait one frame for tldraw to mount the contenteditable, then insert
      requestAnimationFrame(() => {
        const el = editor.getContainer().querySelector<HTMLElement>('[contenteditable="true"]');
        if (!el) return;
        el.focus();
        // Select-all so the first typed char replaces existing text (Word-style)
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
              title={frameToolActive ? 'Drawing slide — drag to set size. Click or press Esc to cancel' : 'Draw a new slide — drag to set size (like Figma frames)'}
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

        {/* Image dialog */}
        {imgDialogOpen && (
          <div className="canvas-img-dialog" onClick={(e) => { if (e.target === e.currentTarget) setImgDialogOpen(false); }}>
            <div className="canvas-img-dialog-box">
              <div className="canvas-img-dialog-header">
                <div className="canvas-img-dialog-title">Add image</div>
                <div className="canvas-img-dialog-tabs">
                  <button
                    className={`canvas-img-tab${imgTab === 'url' ? ' canvas-img-tab--active' : ''}`}
                    onClick={() => setImgTab('url')}
                  >URL</button>
                  <button
                    className={`canvas-img-tab${imgTab === 'workspace' ? ' canvas-img-tab--active' : ''}`}
                    onClick={() => { setImgTab('workspace'); if (wsImages.length === 0) loadWsImages(); }}
                  >Workspace</button>
                </div>
              </div>

              {imgTab === 'url' ? (
                <>
                  <input
                    className="canvas-img-dialog-input"
                    type="url"
                    placeholder="https://example.com/image.png"
                    value={imgUrlInput}
                    onChange={(e) => setImgUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleAddImageFromUrl(imgUrlInput);
                        setImgDialogOpen(false);
                      } else if (e.key === 'Escape') {
                        setImgDialogOpen(false);
                      }
                    }}
                    autoFocus
                  />
                  <div className="canvas-img-dialog-actions">
                    <button className="canvas-img-dialog-cancel" onClick={() => setImgDialogOpen(false)}>Cancel</button>
                    <button
                      className="canvas-img-dialog-add"
                      disabled={!imgUrlInput.trim()}
                      onClick={() => { handleAddImageFromUrl(imgUrlInput); setImgDialogOpen(false); }}
                    >Add</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="canvas-img-ws-grid">
                    {wsImagesLoading ? (
                      <div className="canvas-img-ws-loading">Loading…</div>
                    ) : wsImages.length === 0 ? (
                      <div className="canvas-img-ws-empty">No images found in workspace</div>
                    ) : (
                      wsImages.map((relPath) => (
                        <button
                          key={relPath}
                          className="canvas-img-ws-thumb"
                          title={relPath}
                          onClick={() => {
                            const rect = mainDivRef.current?.getBoundingClientRect();
                            handleSidebarFileDrop(
                              relPath,
                              rect ? rect.left + rect.width  / 2 : 0,
                              rect ? rect.top  + rect.height / 2 : 0,
                            );
                            setImgDialogOpen(false);
                          }}
                        >
                          <img
                            src={convertFileSrc(`${workspacePath}/${relPath}`)}
                            alt={relPath.split('/').pop()}
                            className="canvas-img-ws-thumb-img"
                            loading="lazy"
                          />
                          <span className="canvas-img-ws-thumb-name">{relPath.split('/').pop()}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="canvas-img-dialog-actions">
                    <button className="canvas-img-dialog-cancel" onClick={() => setImgDialogOpen(false)}>Cancel</button>
                    <button className="canvas-img-dialog-cancel" onClick={loadWsImages} style={{ marginRight: 'auto' }}>↺ Refresh</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Fullscreen PNG slide backdrop — covers tldraw canvas in present mode */}
        {isPresenting && (
          <div className="canvas-present-stage">
            {previewUrls.length > 0 && previewUrls[frameIndex] ? (
              <img
                className="canvas-present-slide"
                src={previewUrls[frameIndex]}
                alt={`Slide ${frameIndex + 1}`}
                draggable={false}
              />
            ) : previewGenState === 'generating' ? (
              <div className="canvas-present-generating">Generating preview…</div>
            ) : null}
          </div>
        )}

        {/* Present overlay (navigation bar at bottom of canvas) */}
        {isPresenting && (
          <div className="canvas-present-overlay">
            <button className="canvas-present-exit" onClick={exitPresent} title="Exit (Esc)">
              ✕ Exit
            </button>
            {frames.length > 0 ? (
              <div className="canvas-present-nav">
                <button
                  className="canvas-present-nav-btn"
                  disabled={frameIndex === 0}
                  onClick={() => goToFrame(frameIndex - 1)}
                  title="Previous (←)"
                >←</button>
                <span className="canvas-present-counter">
                  {frameIndex + 1} <span>/</span> {frames.length}
                </span>
                <button
                  className="canvas-present-nav-btn"
                  disabled={frameIndex === frames.length - 1}
                  onClick={() => goToFrame(frameIndex + 1)}
                  title="Next (→)"
                >→</button>
              </div>
            ) : (
              <div className="canvas-present-hint">
                No frames — press <kbd>F</kbd> and draw one
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom bar: Slides + Theme ── */}
      <div className={`canvas-bottom-bar${isPresenting ? ' canvas-bottom-bar--presenting' : ''}`}>

        {/* Single header row: strip toggle | slide cards | theme toggle */}
        <div className="canvas-bottom-header">

          {/* Left: strip toggle */}
          <button
            className="canvas-strip-toggle"
            onClick={() => setStripCollapsed((v) => !v)}
            title={stripCollapsed ? 'Expand slides' : 'Collapse slides'}
          >
            {stripCollapsed ? '▶' : '◀'}&nbsp;Slides
            {frames.length > 0 && (
              <span className="canvas-strip-count">{frames.length}</span>
            )}
          </button>

          {/* Rescan: force-refresh strip from live canvas state */}
          <button
            className="canvas-strip-rescan"
            onClick={rescanFrames}
            title="Re-scan canvas for slide frames"
          >↺</button>

          {/* Undo / Redo */}
          <button
            className="canvas-strip-rescan"
            onClick={() => editorRef.current?.undo()}
            title="Undo (⌘Z)"
          >↩</button>
          <button
            className="canvas-strip-rescan"
            onClick={() => editorRef.current?.redo()}
            title="Redo (⌘⇧Z)"
          >↪</button>

          {/* Fit current slide in view */}
          {frames.length > 0 && (
            <button
              className="canvas-strip-rescan"
              onClick={() => {
                const ed = editorRef.current;
                if (ed && frames[frameIndex]) zoomToFrame(ed, frames[frameIndex]);
              }}
              title="Zoom to fit current slide"
            >⊡ Fit</button>
          )}

          {/* Center: scrollable slide cards */}
          {!stripCollapsed && (
            <div className="canvas-strip-scroll" ref={stripScrollRef}>
              {frames.length === 0 && (
                <div className="canvas-strip-empty">
                  Press <kbd>F</kbd> or click&nbsp;<strong>+ Slide</strong>
                </div>
              )}
              {frames.map((frame, i) => {
                const name = (frame as AnyFrame).props?.name;
                const isActive = i === frameIndex;
                const isDragTarget = stripDragOverIdx === i && stripDragIdx !== null && stripDragIdx !== i;
                return (
                  <button
                    key={frame.id}
                    data-strip-index={i}
                    draggable
                    className={[
                      'canvas-strip-card',
                      isActive ? 'canvas-strip-card--active' : '',
                      stripDragIdx === i ? 'canvas-strip-card--dragging' : '',
                      isDragTarget ? 'canvas-strip-card--drag-over' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => goToFrame(i)}
                    onDoubleClick={() => enterPresent(i)}
                    title={`${name || `Slide ${i + 1}`} — click to zoom, double-click to present`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Clamp so menu doesn't overflow viewport edges.
                      // Menu is min-width:150px; ~230px tall with all items.
                      const MENU_W = 190;
                      const MENU_H = 240;
                      const cx = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
                      const cy = Math.min(e.clientY, window.innerHeight - MENU_H - 6);
                      setCtxMenu({ x: cx, y: cy, frameIdx: i });
                    }}
                    onDragStart={(e) => {
                      // Stop propagation so Tauri's native drag-drop handler
                      // doesn't mistake this internal drag for a file drop.
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      setStripDragIdx(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setStripDragOverIdx(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (stripDragIdx !== null) reorderFrames(stripDragIdx, i);
                      setStripDragIdx(null);
                      setStripDragOverIdx(null);
                    }}
                    onDragEnd={() => { setStripDragIdx(null); setStripDragOverIdx(null); }}
                  >
                    <span className="canvas-strip-num">{i + 1}</span>
                    <span className="canvas-strip-name">{name || `Slide ${i + 1}`}</span>
                    <span
                      className="canvas-strip-delete"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        const ed = editorRef.current;
                        if (!ed) return;
                        ed.deleteShapes([frame.id as TLShapeId]);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Delete') {
                          e.stopPropagation();
                          const ed = editorRef.current;
                          if (!ed) return;
                          ed.deleteShapes([frame.id as TLShapeId]);
                        }
                      }}
                      title="Delete slide"
                    >✕</span>
                  </button>
                );
              })}
              <button
                className="canvas-strip-add"
                onClick={addSlide}
                title={`New 16:9 slide (${SLIDE_W}×${SLIDE_H})`}
              >
                + Slide
              </button>
            </div>
          )}

          {/* Right: theme toggle */}
          <button
            className={`canvas-theme-toggle${themeOpen ? ' canvas-theme-toggle--on' : ''}`}
            onClick={() => setThemeOpen((v) => !v)}
            title="Slide theme — backgrounds, heading & body presets"
          >
            ◈&nbsp;Theme
          </button>
        </div>

        {/* Right-click context menu for canvas shapes (lock/unlock) */}
      {/* Right-click context menu — unlocked shapes only (Lock + Delete) */}
      {shapeCtxMenu && (() => {
        const { x, y, shapeId } = shapeCtxMenu;
        const dismiss = () => setShapeCtxMenu(null);
        return createPortal(
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={dismiss} />
            <div
              className="canvas-ctx-menu"
              style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Duplicate */}
              <button className="canvas-ctx-item" onClick={() => {
                const ed = editorRef.current;
                if (ed) { ed.duplicateShapes([shapeId], { x: 16, y: 16 }); }
                dismiss();
              }}>
                <span className="canvas-ctx-icon">⧉</span> Duplicate
              </button>
              <div className="canvas-ctx-sep" />
              {/* Layer order */}
              <button className="canvas-ctx-item" onClick={() => {
                editorRef.current?.bringForward([shapeId]); dismiss();
              }}>
                <span className="canvas-ctx-icon">⬆</span> Bring Forward
              </button>
              <button className="canvas-ctx-item" onClick={() => {
                editorRef.current?.sendBackward([shapeId]); dismiss();
              }}>
                <span className="canvas-ctx-icon">⬇</span> Send Backward
              </button>
              <div className="canvas-ctx-sep" />
              {/* Wrap as Slide — creates a slide frame around this shape (or current selection) */}
              <button className="canvas-ctx-item" onClick={() => {
                const ed = editorRef.current;
                if (!ed) { dismiss(); return; }
                const allIds = ed.getSelectedShapeIds();
                const targetIds = (allIds.length > 0 ? allIds : [shapeId])
                  .filter((id) => { const s = ed.getShape(id); return s && s.type !== 'frame'; }) as TLShapeId[];
                const bounds = allIds.length > 0 ? ed.getSelectionPageBounds() : ed.getShapePageBounds(shapeId);
                if (!bounds || targetIds.length === 0) { dismiss(); return; }
                const PAD = 60;
                const fw = Math.max(SLIDE_W, bounds.w + PAD * 2);
                const fh = Math.max(SLIDE_H, bounds.h + PAD * 2);
                const fx = bounds.x - (fw - bounds.w) / 2;
                const fy = bounds.y - (fh - bounds.h) / 2;
                const frameId = createShapeId();
                ed.createShape({ id: frameId, type: 'frame', x: fx, y: fy, props: { w: fw, h: fh, name: 'Slide' } });
                ed.reparentShapes(targetIds, frameId);
                applyThemeToSlides(ed, loadThemeFromDoc(ed));
                ed.setSelectedShapes([frameId]);
                dismiss();
              }}>
                <span className="canvas-ctx-icon">⊞</span> Wrap as Slide
              </button>
              <div className="canvas-ctx-sep" />
              {/* Lock */}
              <button className="canvas-ctx-item" onClick={() => {
                const ed = editorRef.current;
                const shape = ed?.getShape(shapeId);
                if (ed && shape) {
                  ed.updateShape({ id: shapeId, type: shape.type, isLocked: true } as any);
                  ed.setSelectedShapes(ed.getSelectedShapeIds().filter((id) => id !== shapeId));
                }
                dismiss();
              }}>
                <span className="canvas-ctx-icon">🔒</span> Lock
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item canvas-ctx-item--danger" onClick={() => {
                const ed = editorRef.current;
                if (ed) ed.deleteShapes([shapeId]);
                dismiss();
              }}>
                <span className="canvas-ctx-icon">✕</span> Delete
              </button>
            </div>
          </>,
          document.body
        );
      })()}

      {/* Long-press unlock pill — appears above locked shapes after a 500 ms hold */}
      {lockPill && (() => {
        const { x, y, shapeId } = lockPill;
        const dismiss = () => setLockPill(null);
        return createPortal(
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={dismiss} />
            <button
              className="canvas-lock-pill"
              style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                const ed = editorRef.current;
                const shape = ed?.getShape(shapeId);
                if (ed && shape) ed.updateShape({ id: shapeId, type: shape.type, isLocked: false } as any);
                dismiss();
              }}
            >
              🔓 Unlock
            </button>
          </>,
          document.body
        );
      })()}

      {/* Lock-attempt flash — brief animated 🔒 when user first touches a locked shape */}
      {lockFlash && createPortal(
        <div
          className="canvas-lock-flash"
          style={{ position: 'fixed', left: lockFlash.x, top: lockFlash.y }}
          aria-hidden="true"
        >🔒</div>,
        document.body
      )}

        {/* Right-click context menu for slide cards */}
      {ctxMenu && (() => {
        const { x, y, frameIdx } = ctxMenu;
        const frame = frames[frameIdx];
        const totalFrames = frames.length;
        const dismiss = () => setCtxMenu(null);
        return createPortal(
          <>
            {/* Backdrop to catch outside clicks */}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
              onMouseDown={dismiss}
            />
            <div
              className="canvas-ctx-menu"
              style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button className="canvas-ctx-item" onClick={() => { exportFrame(frame, frameIdx); dismiss(); }}>
                <span className="canvas-ctx-icon">↓</span> Export PNG
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item" disabled={frameIdx === 0} onClick={() => { moveFrameDir(frameIdx, -1); dismiss(); }}>
                <span className="canvas-ctx-icon">←</span> Move Left
              </button>
              <button className="canvas-ctx-item" disabled={frameIdx === totalFrames - 1} onClick={() => { moveFrameDir(frameIdx, 1); dismiss(); }}>
                <span className="canvas-ctx-icon">→</span> Move Right
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item" onClick={() => { duplicateFrame(frameIdx); dismiss(); }}>
                <span className="canvas-ctx-icon">⧉</span> Duplicate
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item canvas-ctx-item--danger" onClick={() => {
                const ed = editorRef.current;
                if (ed && frame) ed.deleteShapes([frame.id as TLShapeId]);
                dismiss();
              }}>
                <span className="canvas-ctx-icon">✕</span> Delete
              </button>
            </div>
          </>,
          document.body
        );
      })()}

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
                    {theme.slideBgImage.startsWith('data:') ? 'Custom image' : (theme.slideBgImage.split('/').pop() ?? 'Image')}
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
                    {/* Apply preset to next shapes */}
                    <button
                      className="canvas-theme-apply-btn"
                      onClick={() => insertTextPreset(variant)}
                      title={`Insert a ${variant} text shape into the current slide`}
                    >
                      ＋ Insert {variant === 'heading' ? 'Heading' : 'Body'}
                    </button>
                    {/* Edit toggle */}
                    <button
                      className={`canvas-theme-edit-btn${isEditing ? ' canvas-theme-edit-btn--on' : ''}`}
                      onClick={() => setEditingPreset(isEditing ? null : variant)}
                      title="Edit preset"
                    >✎</button>
                  </div>

                  {/* Inline preview tag */}
                  {!isEditing && (
                    <div className="canvas-theme-preview-tag">
                      {ps.font} · {ps.size.toUpperCase()} · {ps.color}
                    </div>
                  )}

                  {/* Inline editors */}
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

    </div>
  );
}
