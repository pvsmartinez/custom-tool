import { useRef, useState, useEffect, useCallback } from 'react';
import type { Editor, TLEditorSnapshot, TLShape, TLComponents, TLShapeId } from 'tldraw';
import {
  Tldraw, exportAs, createShapeId,
  DefaultColorStyle, DefaultSizeStyle, DefaultFontStyle,
  DefaultTextAlignStyle, DefaultFillStyle, DefaultDashStyle,
} from 'tldraw';
import { useEditor } from '@tldraw/editor';
import { useValue } from '@tldraw/state-react';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import 'tldraw/tldraw.css';
import './CanvasEditor.css';

// ── Module-level constants — MUST NOT be re-created inside a React component ────
const SLIDE_W = 1280;
const SLIDE_H = 720;
const SLIDE_GAP = 80;

// Figma-like camera: trackpad pinch / scroll wheel = zoom (not pan)
const CAMERA_OPTIONS = {
  wheelBehavior: 'zoom' as const,
  zoomSteps: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8],
  zoomSpeed: 1,
  panSpeed: 1,
  isLocked: false,
};

// ─── Theme system ──────────────────────────────────────────────────────────────
interface TextStyle { font: string; size: string; color: string; align: string; }
export interface CanvasTheme {
  slideBg: string;    // tldraw color name for all-slides background
  heading: TextStyle;
  body: TextStyle;
}
const DEFAULT_THEME: CanvasTheme = {
  slideBg: 'white',
  heading: { font: 'sans', size: 'xl', color: 'black', align: 'start' },
  body:    { font: 'sans', size: 'm',  color: 'black', align: 'start' },
};
const PRESET_THEMES: { label: string; theme: CanvasTheme }[] = [
  { label: 'Light',  theme: { slideBg: 'white',       heading: { font: 'sans',  size: 'xl', color: 'black',  align: 'start' }, body: { font: 'sans',  size: 'm', color: 'grey',   align: 'start' } } },
  { label: 'Dark',   theme: { slideBg: 'black',       heading: { font: 'sans',  size: 'xl', color: 'white',  align: 'start' }, body: { font: 'sans',  size: 'm', color: 'grey',   align: 'start' } } },
  { label: 'Navy',   theme: { slideBg: 'blue',        heading: { font: 'sans',  size: 'xl', color: 'white',  align: 'start' }, body: { font: 'sans',  size: 'm', color: 'light-blue', align: 'start' } } },
  { label: 'Violet', theme: { slideBg: 'light-violet',heading: { font: 'serif', size: 'xl', color: 'violet', align: 'start' }, body: { font: 'serif', size: 'm', color: 'black',  align: 'start' } } },
  { label: 'Warm',   theme: { slideBg: 'light-red',   heading: { font: 'sans',  size: 'xl', color: 'red',    align: 'start' }, body: { font: 'sans',  size: 'm', color: 'black',  align: 'start' } } },
  { label: 'Forest', theme: { slideBg: 'light-green', heading: { font: 'sans',  size: 'xl', color: 'green',  align: 'start' }, body: { font: 'sans',  size: 'm', color: 'black',  align: 'start' } } },
  { label: 'Retro',  theme: { slideBg: 'yellow',      heading: { font: 'draw',  size: 'xl', color: 'orange', align: 'start' }, body: { font: 'draw',  size: 'm', color: 'black',  align: 'start' } } },
];

// ── Theme helper functions (module-level, no React hooks) ────────────────────
function loadThemeFromDoc(editor: Editor): CanvasTheme {
  const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
  const t = meta?.theme as Partial<CanvasTheme> | undefined;
  if (!t) return DEFAULT_THEME;
  return {
    slideBg: (t.slideBg as string) ?? DEFAULT_THEME.slideBg,
    heading: { ...DEFAULT_THEME.heading, ...(t.heading as TextStyle | undefined) },
    body:    { ...DEFAULT_THEME.body,    ...(t.body    as TextStyle | undefined) },
  };
}

function persistTheme(editor: Editor, theme: CanvasTheme) {
  const existing = editor.getDocumentSettings().meta as Record<string, unknown>;
  editor.updateDocumentSettings({ meta: { ...existing, theme: theme as unknown as ReturnType<typeof editor.getDocumentSettings>['meta'][string] } });
}

function applyThemeToSlides(editor: Editor, theme: CanvasTheme) {
  const frames = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame');
  if (frames.length === 0) return;
  frames.forEach((frame) => {
      const af = frame as AnyFrame;
      const childIds = editor.getSortedChildIdsForParent(frame);
      const existingBg = childIds
        .map((id) => editor.getShape(id))
        .find((s) => s?.meta?.isThemeBg === true);
      if (existingBg) {
        // Update existing background rectangle's color
        editor.updateShape({
          id: existingBg.id,
          type: 'geo',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { color: theme.slideBg as any },
        });
      } else {
        // Create a new full-frame background rectangle
        const bgId = createShapeId();
        editor.createShape({
          id: bgId,
          type: 'geo',
          parentId: frame.id,
          x: 0,
          y: 0,
          meta: { isThemeBg: true },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { geo: 'rectangle', w: af.props.w, h: af.props.h, fill: 'solid', color: theme.slideBg as any, dash: 'solid', size: 's' } as any,
        });
        editor.sendToBack([bgId]);
      }
  });
  persistTheme(editor, theme);
}

function applyTextPreset(editor: Editor, variant: 'heading' | 'body', theme: CanvasTheme) {
  const s = variant === 'heading' ? theme.heading : theme.body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (prop: any, val: any) => { editor.setStyleForNextShapes(prop, val); };
  set(DefaultFontStyle,      s.font);
  set(DefaultSizeStyle,      s.size);
  set(DefaultColorStyle,     s.color);
  set(DefaultTextAlignStyle, s.align);
  // Also apply to current selection if any
  if (editor.getSelectedShapeIds().length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sset = (prop: any, val: any) => editor.setStyleForSelectedShapes(prop, val);
    sset(DefaultFontStyle,      s.font);
    sset(DefaultSizeStyle,      s.size);
    sset(DefaultColorStyle,     s.color);
    sset(DefaultTextAlignStyle, s.align);
  }
}

// ─── Format panel data ─────────────────────────────────────────────────────────
// Representative hex values for tldraw's 13 named colors (light-mode)
const TLDRAW_COLORS: [string, string][] = [
  ['black', '#1d1d1d'], ['grey', '#aaaaaa'], ['red', '#f73c49'],
  ['light-red', '#ffb3c1'], ['orange', '#ff9133'], ['yellow', '#f5cf61'],
  ['green', '#41b356'], ['light-green', '#a8db7a'], ['blue', '#4465e9'],
  ['light-blue', '#4ba1f1'], ['violet', '#9d50ff'], ['light-violet', '#e4ccff'],
  ['white', '#f8f8f8'],
];

const FONT_OPTIONS = [
  { value: 'draw', label: 'Hand' },
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
] as const;

const SIZE_OPTIONS = [
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
  { value: 'xl', label: 'XL' },
] as const;

const ALIGN_OPTIONS = [
  { value: 'start', icon: '\u2190', label: 'Align left' },
  { value: 'middle', icon: '\u2261', label: 'Align center' },
  { value: 'end', icon: '\u2192', label: 'Align right' },
  { value: 'justify', icon: '\u2630', label: 'Justify' },
] as const;

const FILL_OPTIONS = [
  { value: 'none', icon: '\u25a1', label: 'No fill' },
  { value: 'semi', icon: '\u25d1', label: 'Semi fill' },
  { value: 'solid', icon: '\u25a0', label: 'Solid fill' },
  { value: 'pattern', icon: '\u25a6', label: 'Pattern fill' },
] as const;

const DASH_OPTIONS = [
  { value: 'draw', icon: '\u223c', label: 'Hand drawn' },
  { value: 'solid', icon: '\u2014', label: 'Solid' },
  { value: 'dashed', icon: '\u254c', label: 'Dashed' },
  { value: 'dotted', icon: '\u22ef', label: 'Dotted' },
] as const;

// ─── CanvasFormatPanel ───────────────────────────────────────────────────────────
// This component is rendered via InFrontOfTheCanvas, which puts it INSIDE the
// tldraw React tree — so useEditor() and useValue() work correctly here.
function CanvasFormatPanel() {
  const editor = useEditor();
  const [showFontPicker, setShowFontPicker] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  const [fontSearch, setFontSearch] = useState('');

  // Reactive: recomputes whenever selection or any selected shape's style changes.
  // Returns null when nothing is selected (panel hides automatically).
  const styles = useValue('fmtStyles', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    return editor.getSharedStyles();
  }, [editor]);

  // Reactive font overrides stored in document meta
  const fontOverrides = useValue('fontOverrides', () => {
    const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
    return (meta?.fontOverrides as FontOverrides) ?? {};
  }, [editor]);

  if (!styles) return null;

  // Get current uniform value, or null if mixed / not applicable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sv(prop: any): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = styles!.get(prop) as { type: string; value?: string } | undefined;
    if (!s || s.type !== 'shared') return null;
    return s.value ?? null;
  }

  // Apply a style to both existing selection and future shapes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ss(prop: any, value: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.setStyleForSelectedShapes(prop as any, value as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.setStyleForNextShapes(prop as any, value as any);
  }

  // Whether a style key is relevant to the current selection (not undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applicable(prop: any): boolean {
    return styles!.get(prop) !== undefined;
  }

  const curColor = sv(DefaultColorStyle);
  const curSize  = sv(DefaultSizeStyle);
  const curFont  = sv(DefaultFontStyle);
  const curAlign = sv(DefaultTextAlignStyle);
  const curFill  = sv(DefaultFillStyle);
  const curDash  = sv(DefaultDashStyle);

  const hasFont  = applicable(DefaultFontStyle);
  const hasAlign = applicable(DefaultTextAlignStyle);
  const hasFill  = applicable(DefaultFillStyle);
  const hasDash  = applicable(DefaultDashStyle);

  // Determine which custom font name is active (if any) for the current slot
  function activeCustomLabel(): string | null {
    if (curFont === 'sans'  && fontOverrides.sans)  return fontOverrides.sans;
    if (curFont === 'serif' && fontOverrides.serif) return fontOverrides.serif;
    if (curFont === 'mono'  && fontOverrides.mono)  return fontOverrides.mono;
    return null;
  }

  function openFontPicker() {
    setShowFontPicker((v) => !v);
    if (systemFonts === null) {
      // Detect available fonts lazily on first open
      setTimeout(() => setSystemFonts(detectAvailableFonts(SYSTEM_FONT_LIST)), 0);
    }
    setFontSearch('');
  }

  function pickSystemFont(fontName: string, slot: 'sans' | 'serif' | 'mono') {
    ss(DefaultFontStyle, slot);
    const newOverrides = { ...fontOverrides, [slot]: fontName };
    saveFontOverrides(editor, newOverrides);
    applyFontOverridesToContainer(editor, newOverrides);
    setShowFontPicker(false);
    setFontSearch('');
  }

  function clearFontOverride(slot: 'sans' | 'serif' | 'mono') {
    const newOverrides = { ...fontOverrides };
    delete newOverrides[slot];
    saveFontOverrides(editor, newOverrides);
    applyFontOverridesToContainer(editor, newOverrides);
  }

  // Infer tldraw slot from font name (heuristic)
  function slotForFont(name: string): 'sans' | 'serif' | 'mono' {
    const lc = name.toLowerCase();
    if (/courier|menlo|monaco|consolas|mono|andale/.test(lc)) return 'mono';
    if (/georgia|times|garamond|palatino|baskerville|didot|caslon|antiqua|cambria|cochin|hoefler|serif/.test(lc)) return 'serif';
    return 'sans';
  }

  const filteredFonts = (systemFonts ?? []).filter((f) =>
    f.toLowerCase().includes(fontSearch.toLowerCase())
  );

  const customLabel = activeCustomLabel();

  return (
    <div className="canvas-fmt-panel" onPointerDown={(e) => e.stopPropagation()}>

      {/* Font family — only for text-capable shapes */}
      {hasFont && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label-row-space">
            <span className="canvas-fmt-label">Font</span>
            {customLabel && (
              <span className="canvas-fmt-custom-name" title={`Custom: ${customLabel}`}>
                {customLabel}
                <button
                  className="canvas-fmt-custom-clear"
                  onClick={() => clearFontOverride(curFont as 'sans' | 'serif' | 'mono')}
                  title="Clear custom font"
                >✕</button>
              </span>
            )}
          </div>
          <div className="canvas-fmt-row">
            {/* Top 3 defaults */}
            <button
              className={`canvas-fmt-btn${curFont === 'draw' ? ' canvas-fmt-btn--on' : ''}`}
              onClick={() => ss(DefaultFontStyle, 'draw')}
              title="Handwritten"
              style={{ fontFamily: 'var(--tl-font-draw)' }}
            >Hand</button>
            <button
              className={`canvas-fmt-btn${curFont === 'sans' ? ' canvas-fmt-btn--on' : ''}`}
              onClick={() => ss(DefaultFontStyle, 'sans')}
              title={fontOverrides.sans ?? 'Sans-serif'}
              style={{ fontFamily: fontOverrides.sans ? `"${fontOverrides.sans}", sans-serif` : undefined }}
            >Sans</button>
            <button
              className={`canvas-fmt-btn${curFont === 'serif' ? ' canvas-fmt-btn--on' : ''}`}
              onClick={() => ss(DefaultFontStyle, 'serif')}
              title={fontOverrides.serif ?? 'Serif'}
              style={{ fontFamily: fontOverrides.serif ? `"${fontOverrides.serif}", serif` : undefined }}
            >Serif</button>
            {/* More button */}
            <button
              className={`canvas-fmt-btn canvas-fmt-btn-more${showFontPicker ? ' canvas-fmt-btn--on' : ''}`}
              onClick={openFontPicker}
              title="More fonts…"
            >···</button>
          </div>

          {/* Expanded font picker */}
          {showFontPicker && (
            <div className="canvas-fmt-font-picker">
              <input
                className="canvas-fmt-font-search"
                placeholder="Search fonts…"
                value={fontSearch}
                onChange={(e) => setFontSearch(e.target.value)}
                autoFocus
              />
              <div className="canvas-fmt-font-list">
                {/* Mono option (not in top 3) */}
                {!fontSearch && (
                  <button
                    className={`canvas-fmt-font-item${curFont === 'mono' ? ' canvas-fmt-font-item--on' : ''}`}
                    onClick={() => { ss(DefaultFontStyle, 'mono'); setShowFontPicker(false); }}
                    style={{ fontFamily: 'var(--tl-font-mono)' }}
                  >
                    <span className="canvas-fmt-font-item-name">Mono</span>
                    <span className="canvas-fmt-font-item-slot">built-in</span>
                  </button>
                )}
                {systemFonts === null ? (
                  <div className="canvas-fmt-font-loading">Scanning fonts…</div>
                ) : filteredFonts.length === 0 ? (
                  <div className="canvas-fmt-font-loading">No fonts found</div>
                ) : (
                  filteredFonts.map((font) => {
                    const slot = slotForFont(font);
                    const isActive = curFont === slot && fontOverrides[slot] === font;
                    return (
                      <button
                        key={font}
                        className={`canvas-fmt-font-item${isActive ? ' canvas-fmt-font-item--on' : ''}`}
                        onClick={() => pickSystemFont(font, slot)}
                        style={{ fontFamily: `"${font}", sans-serif` }}
                        title={`Apply "${font}" → ${slot} slot`}
                      >
                        <span className="canvas-fmt-font-item-name">{font}</span>
                        <span className="canvas-fmt-font-item-slot">{slot}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Size */}
      <div className="canvas-fmt-section">
        <div className="canvas-fmt-label">Size</div>
        <div className="canvas-fmt-row">
          {SIZE_OPTIONS.map((s) => (
            <button
              key={s.value}
              className={`canvas-fmt-btn${curSize === s.value ? ' canvas-fmt-btn--on' : ''}`}
              onClick={() => ss(DefaultSizeStyle, s.value)}
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* Text alignment — only for text-capable shapes */}
      {hasAlign && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Align</div>
          <div className="canvas-fmt-row">
            {ALIGN_OPTIONS.map((a) => (
              <button
                key={a.value}
                className={`canvas-fmt-btn${curAlign === a.value ? ' canvas-fmt-btn--on' : ''}`}
                onClick={() => ss(DefaultTextAlignStyle, a.value)}
                title={a.label}
              >{a.icon}</button>
            ))}
          </div>
        </div>
      )}

      {/* Color swatches */}
      <div className="canvas-fmt-section">
        <div className="canvas-fmt-label">Color</div>
        <div className="canvas-fmt-colors">
          {TLDRAW_COLORS.map(([id, hex]) => (
            <button
              key={id}
              className={`canvas-fmt-swatch${curColor === id ? ' canvas-fmt-swatch--on' : ''}`}
              style={{ '--swatch': hex } as Record<string, string>}
              onClick={() => ss(DefaultColorStyle, id)}
              title={id}
            />
          ))}
        </div>
      </div>

      {/* Fill style — shapes with fill support */}
      {hasFill && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Fill</div>
          <div className="canvas-fmt-row">
            {FILL_OPTIONS.map((f) => (
              <button
                key={f.value}
                className={`canvas-fmt-btn${curFill === f.value ? ' canvas-fmt-btn--on' : ''}`}
                onClick={() => ss(DefaultFillStyle, f.value)}
                title={f.label}
              >{f.icon}</button>
            ))}
          </div>
        </div>
      )}

      {/* Stroke / dash style */}
      {hasDash && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Stroke</div>
          <div className="canvas-fmt-row">
            {DASH_OPTIONS.map((d) => (
              <button
                key={d.value}
                className={`canvas-fmt-btn${curDash === d.value ? ' canvas-fmt-btn--on' : ''}`}
                onClick={() => ss(DefaultDashStyle, d.value)}
                title={d.label}
              >{d.icon}</button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Font override helpers ────────────────────────────────────────────────────
interface FontOverrides {
  sans?: string;   // custom font name mapped to the 'sans' tldraw slot
  serif?: string;  // custom font name mapped to the 'serif' tldraw slot
  mono?: string;   // custom font name mapped to the 'mono' tldraw slot
}

// Curated macOS/cross-platform system fonts for the picker
const SYSTEM_FONT_LIST = [
  // Sans-serif
  'Arial', 'Arial Narrow', 'Helvetica', 'Helvetica Neue', 'Gill Sans', 'Futura', 'Avenir',
  'Avenir Next', 'Optima', 'Trebuchet MS', 'Verdana', 'Tahoma', 'Geneva', 'Lucida Grande',
  'Impact', 'Calibri', 'Candara', 'Segoe UI', 'Myriad Pro',
  // Serif
  'Georgia', 'Times New Roman', 'Palatino', 'Garamond', 'Baskerville', 'Didot',
  'Hoefler Text', 'Book Antiqua', 'Cambria', 'Cochin', 'Big Caslon',
  // Monospace
  'Courier New', 'Menlo', 'Monaco', 'Andale Mono', 'Consolas', 'SF Mono',
  // Expressive
  'Comic Sans MS', 'Papyrus', 'Marker Felt', 'Chalkboard SE', 'American Typewriter',
];

// Canvas-based font availability detection (works in WebKit/Chromium)
function detectAvailableFonts(fontList: string[]): string[] {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) return fontList;
  const TEST = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZilIi!|';
  ctx.font = '16px monospace';
  const base = ctx.measureText(TEST).width;
  return fontList.filter((font) => {
    ctx.font = `16px "${font}", monospace`;
    return ctx.measureText(TEST).width !== base;
  });
}

function loadFontOverrides(editor: Editor): FontOverrides {
  const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
  return (meta?.fontOverrides as FontOverrides) ?? {};
}

function saveFontOverrides(editor: Editor, overrides: FontOverrides) {
  const existing = editor.getDocumentSettings().meta as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.updateDocumentSettings({ meta: { ...existing, fontOverrides: overrides as any } });
}

function applyFontOverridesToContainer(editor: Editor, overrides: FontOverrides) {
  const c = editor.getContainer();
  if (overrides.sans) c.style.setProperty('--tl-font-sans', `"${overrides.sans}", sans-serif`);
  else c.style.removeProperty('--tl-font-sans');
  if (overrides.serif) c.style.setProperty('--tl-font-serif', `"${overrides.serif}", serif`);
  else c.style.removeProperty('--tl-font-serif');
  if (overrides.mono) c.style.setProperty('--tl-font-mono', `"${overrides.mono}", monospace`);
  else c.style.removeProperty('--tl-font-mono');
}

// ─── Stable component overrides (module-level const — NEVER recreate inside component) ─
const TLDRAW_COMPONENTS: TLComponents = {
  SharePanel: null,
  HelpMenu: null,
  Minimap: null,
  StylePanel: null,   // hide tldraw's own floating style panel — we use CanvasFormatPanel
  // Renders FormatPanel inside the tldraw tree so it can use useEditor() / useValue()
  InFrontOfTheCanvas: CanvasFormatPanel,
};

// Typed helper for frame shape props
type AnyFrame = TLShape & { x: number; y: number; props: { w: number; h: number; name?: string } };

interface CanvasEditorProps {
  /** Raw JSON from disk, or empty string for a brand-new canvas. */
  content: string;
  onChange: (json: string) => void;
  /** Called once, immediately after the tldraw Editor mounts. */
  onEditorReady?: (editor: Editor) => void;
  /** Absolute path to the workspace root — needed for saving dropped images. */
  workspacePath: string;
}

export default function CanvasEditor({ content, onChange, onEditorReady, workspacePath }: CanvasEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Ref so the store listener always calls the latest onChange even if the
  // prop identity changes (e.g. after a workspace config update in App.tsx).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [presentMode, setPresentMode] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [frames, setFrames] = useState<TLShape[]>([]);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  const [theme, setTheme] = useState<CanvasTheme>(DEFAULT_THEME);
  const [themeOpen, setThemeOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<'heading' | 'body' | null>(null);
  const [imgDialogOpen, setImgDialogOpen] = useState(false);
  const [imgUrlInput, setImgUrlInput] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const mainDivRef = useRef<HTMLDivElement>(null);

  // Clear pending save timer on unmount to avoid calling onChange on a
  // component that is no longer active.
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
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
      catch { snapshotRef.current = undefined; }
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
    const MIME_MAP: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    };
    const mimeType = MIME_MAP[ext] ?? 'image/png';

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

    // Scale down if wider than 800px
    const maxW = 800;
    const dispW = Math.min(natW, maxW);
    const dispH = Math.round(natH * (dispW / natW));

    // Place at current viewport center
    const vp = editor.getViewportPageBounds();
    const placeX = Math.round(vp.x + vp.w / 2 - dispW / 2);
    const placeY = Math.round(vp.y + vp.h / 2 - dispH / 2);

    const assetId = `asset:img_${Math.random().toString(36).slice(2)}` as ReturnType<typeof editor.getAssets>[0]['id'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.createAssets([{
      id: assetId,
      typeName: 'asset',
      type: 'image',
      props: {
        name: url.split('/').pop()?.split('?')[0] ?? 'image',
        src: url,
        w: natW,
        h: natH,
        mimeType,
        isAnimated: mimeType === 'image/gif',
      },
      meta: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.createShape({ type: 'image', x: placeX, y: placeY, props: { assetId, w: dispW, h: dispH } as any });
  }

  // ── Shared helper: place an already-measured image on the canvas ────────────
  function placeImageOnCanvas(
    editor: Editor,
    src: string,
    name: string,
    mimeType: string,
    natW: number,
    natH: number,
    dropPageX?: number,
    dropPageY?: number,
  ) {
    const maxW = 800;
    const scale = Math.min(1, maxW / natW);
    const dispW = Math.round(natW * scale);
    const dispH = Math.round(natH * scale);
    let px: number, py: number;
    if (dropPageX !== undefined && dropPageY !== undefined) {
      px = Math.round(dropPageX - dispW / 2);
      py = Math.round(dropPageY - dispH / 2);
    } else {
      const vp = editor.getViewportPageBounds();
      px = Math.round(vp.x + vp.w / 2 - dispW / 2);
      py = Math.round(vp.y + vp.h / 2 - dispH / 2);
    }
    const assetId = `asset:img_${Math.random().toString(36).slice(2)}` as ReturnType<typeof editor.getAssets>[0]['id'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', props: { name, src, w: natW, h: natH, mimeType, isAnimated: mimeType === 'image/gif' }, meta: {} } as any]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.createShape({ type: 'image', x: px, y: py, props: { assetId, w: dispW, h: dispH } as any });
  }

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tiff', 'tif']);

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
      const MIME_MAP: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
        tiff: 'image/tiff', tif: 'image/tiff',
      };
      const mimeType = MIME_MAP[ext] ?? 'image/png';
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
      placeImageOnCanvas(editor, src, filename, mimeType, natW, natH, pagePos.x + offsetX, pagePos.y);
      offsetX += Math.round(Math.min(natW, 800) + 20);
    }
  }

  // ── Drop from sidebar (workspace file path via data transfer) ────────────────
  async function handleSidebarFileDrop(relPath: string, dropClientX: number, dropClientY: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXTS.has(ext)) return;
    const MIME_MAP: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
      tiff: 'image/tiff', tif: 'image/tiff',
    };
    const mimeType = MIME_MAP[ext] ?? 'image/png';
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
    placeImageOnCanvas(editor, src, relPath.split('/').pop() ?? relPath, mimeType, natW, natH, pagePos.x, pagePos.y);
  }

  function handleDragOver(e: React.DragEvent) {
    // Accept external image files and sidebar workspace-file drags
    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasWsFile = e.dataTransfer.types.includes('text/x-workspace-file');
    if (!hasFiles && !hasWsFile) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear when leaving the main container, not entering children
    if (!mainDivRef.current?.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    // Sidebar file drag takes priority
    const wsFile = e.dataTransfer.getData('text/x-workspace-file');
    if (wsFile) {
      await handleSidebarFileDrop(wsFile, e.clientX, e.clientY);
      return;
    }
    if (e.dataTransfer.files.length > 0) {
      await handleExternalFileDrop(e.dataTransfer.files, e.clientX, e.clientY);
    }
  }

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
    // Zoom to the newly created frame and sync frames state explicitly —
    // the store listener uses source:'user' so won't catch programmatic changes.
    setTimeout(() => {
      const updated = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame');
      setFrames(updated); // explicit sync
      const newFrame = updated[updated.length - 1];
      if (newFrame) {
        zoomToFrame(editor, newFrame);
        setFrameIndex(updated.length - 1);
      }
    }, 60);
  }

  async function exportFrame(frame: TLShape, idx: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const name = (frame as AnyFrame).props?.name || `Slide ${idx + 1}`;
    await exportAs(editor, [frame.id as TLShapeId], { format: 'png', name });
  }

  // ── Present mode ─────────────────────────────────────────────────────────────
  function enterPresent(startIdx = 0) {
    const editor = editorRef.current;
    if (!editor) return;
    const sorted = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame');
    setFrames(sorted);
    setFrameIndex(startIdx);
    setPresentMode(true);
    if (sorted.length > 0) zoomToFrame(editor, sorted[startIdx]);
    else editor.zoomToFit({ animation: { duration: 350 } });
  }

  function exitPresent() { setPresentMode(false); }

  function goToFrame(idx: number) {
    const editor = editorRef.current;
    if (!editor || frames.length === 0) return;
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    setFrameIndex(clamped);
    zoomToFrame(editor, frames[clamped]);
  }

  // Keyboard navigation while presenting
  useEffect(() => {
    if (!presentMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { exitPresent(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        setFrameIndex((prev) => {
          const next = Math.min(prev + 1, frames.length - 1);
          const ed = editorRef.current;
          if (ed && frames[next]) zoomToFrame(ed, frames[next]);
          return next;
        });
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFrameIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          const ed = editorRef.current;
          if (ed && frames[next]) zoomToFrame(ed, frames[next]);
          return next;
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentMode, frames, zoomToFrame]);

  // ── Mount ─────────────────────────────────────────────────────────────────────
  function handleMount(editor: Editor) {
    editorRef.current = editor;
    onEditorReady?.(editor);

    // Enable grid (visible dot grid + snap-to-grid) by default
    editor.updateInstanceState({ isGridMode: true });

    // Load persisted theme from document meta and apply backgrounds
    const savedTheme = loadThemeFromDoc(editor);
    setTheme(savedTheme);
    // Apply background to any existing frames without a bg rect
    applyThemeToSlides(editor, savedTheme);

    // Load and apply persisted font overrides
    const savedFontOverrides = loadFontOverrides(editor);
    applyFontOverridesToContainer(editor, savedFontOverrides);

    // Keep frame strip in sync — user-driven changes only to avoid flooding
    // React with setState on every internal tldraw micro-transaction.
    // Also clamp frameIndex so present mode never shows an out-of-bounds slide
    // (e.g. when the user deletes a frame while presenting).
    const syncFrames = () => {
      const updated = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame');
      setFrames(updated);
      setFrameIndex((prev) => Math.min(prev, Math.max(0, updated.length - 1)));
    };
    syncFrames(); // populate immediately on mount
    editor.store.listen(syncFrames, { scope: 'document', source: 'user' });

    // Debounced save — user-driven changes only (prevents save loops).
    // Use onChangeRef so we always call the latest prop even if identity changed.
    editor.store.listen(
      () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() =>
          onChangeRef.current(JSON.stringify(editor.getSnapshot())), 500);
      },
      { scope: 'document', source: 'user' },
    );
  }

  return (
    <div className={`canvas-editor${presentMode ? ' canvas-editor--presenting' : ''}`}>

      {/* ── Main canvas ── */}
      <div
        ref={mainDivRef}
        className={`canvas-editor-main${isDragOver ? ' canvas-editor-main--dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Tldraw
          snapshot={snapshot}
          onMount={handleMount}
          inferDarkMode
          components={TLDRAW_COMPONENTS}
          cameraOptions={CAMERA_OPTIONS}
        />

        {/* Drop-zone hint — visible while dragging an image over the canvas */}
        {isDragOver && (
          <div className="canvas-drop-hint">
            <div className="canvas-drop-hint-inner">
              <span className="canvas-drop-hint-icon">⬇</span>
              <span className="canvas-drop-hint-text">Drop image to add to canvas</span>
            </div>
          </div>
        )}

        {/* ▶ Present button — floating top-right, hidden while presenting */}
        {!presentMode && (
          <button
            className="canvas-present-btn"
            onClick={() => enterPresent(0)}
            title="Present — Frames are slides. Press F to draw a frame."
          >
            ▶ Present
          </button>
        )}

        {/* 🖼 Add image button — floating below Present, hidden while presenting */}
        {!presentMode && (
          <button
            className="canvas-img-btn"
            onClick={() => { setImgDialogOpen(true); setImgUrlInput(''); }}
            title="Add image from URL"
          >
            🖼 Image
          </button>
        )}

        {/* Image URL dialog */}
        {imgDialogOpen && (
          <div className="canvas-img-dialog" onClick={(e) => { if (e.target === e.currentTarget) setImgDialogOpen(false); }}>
            <div className="canvas-img-dialog-box">
              <div className="canvas-img-dialog-title">Add image from URL</div>
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
                <button
                  className="canvas-img-dialog-cancel"
                  onClick={() => setImgDialogOpen(false)}
                >Cancel</button>
                <button
                  className="canvas-img-dialog-add"
                  disabled={!imgUrlInput.trim()}
                  onClick={() => {
                    handleAddImageFromUrl(imgUrlInput);
                    setImgDialogOpen(false);
                  }}
                >Add</button>
              </div>
            </div>
          </div>
        )}

        {/* Present overlay (navigation bar at bottom of canvas) */}
        {presentMode && (
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
      <div className={`canvas-bottom-bar${presentMode ? ' canvas-bottom-bar--presenting' : ''}`}>

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

          {/* Center: scrollable slide cards */}
          {!stripCollapsed && (
            <div className="canvas-strip-scroll">
              {frames.length === 0 && (
                <div className="canvas-strip-empty">
                  Press <kbd>F</kbd> or click&nbsp;<strong>+ Slide</strong>
                </div>
              )}
              {frames.map((frame, i) => {
                const name = (frame as AnyFrame).props?.name;
                const isActive = presentMode && i === frameIndex;
                return (
                  <button
                    key={frame.id}
                    className={`canvas-strip-card${isActive ? ' canvas-strip-card--active' : ''}`}
                    onClick={() => goToFrame(i)}
                    onDoubleClick={() => enterPresent(i)}
                    title={`${name || `Slide ${i + 1}`} — click to zoom, double-click to present`}
                  >
                    <span className="canvas-strip-num">{i + 1}</span>
                    <span className="canvas-strip-name">{name || `Slide ${i + 1}`}</span>
                    <span
                      className="canvas-strip-export"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); exportFrame(frame, i); }}
                      onKeyDown={(e) => e.key === 'Enter' && exportFrame(frame, i)}
                      title="Export slide as PNG"
                    >↓</span>
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

            {/* Slide background color */}
            <div className="canvas-theme-section">
              <div className="canvas-theme-label">Slide background</div>
              <div className="canvas-fmt-colors">
                {TLDRAW_COLORS.map(([id, hex]) => (
                  <button
                    key={id}
                    className={`canvas-fmt-swatch${theme.slideBg === id ? ' canvas-fmt-swatch--on' : ''}`}
                    style={{ '--swatch': hex } as Record<string, string>}
                    onClick={() => handleThemeChange({ ...theme, slideBg: id })}
                    title={`Slide background: ${id}`}
                  />
                ))}
              </div>
            </div>

            {/* Text presets: Heading & Body */}
            {(['heading', 'body'] as const).map((variant) => {
              const ps = theme[variant];
              const isEditing = editingPreset === variant;
              const label = variant === 'heading' ? 'H Heading' : 'B Body';
              return (
                <div key={variant} className="canvas-theme-section">
                  <div className="canvas-theme-label-row">
                    <div className="canvas-theme-label">{variant === 'heading' ? 'Heading' : 'Body'}</div>
                    {/* Apply preset to next shapes */}
                    <button
                      className="canvas-theme-apply-btn"
                      onClick={() => { const ed = editorRef.current; if (ed) applyTextPreset(ed, variant, theme); }}
                      title={`Set ${variant} style for next shapes`}
                    >
                      Use {label}
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
