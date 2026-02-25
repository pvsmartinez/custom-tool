/**
 * CanvasFormatPanel
 *
 * Context-sensitive property panel rendered inside the tldraw tree via
 * InFrontOfTheCanvas. Uses useEditor() / useValue() to reactively read the
 * current selection and rerender only when relevant state changes.
 *
 * Must NOT be placed inside CanvasEditor.tsx's component body — it needs to be
 * a stable module-level component reference so tldraw doesn't unmount it on
 * every render.
 */
import { useState } from 'react';
import { Lock, DownloadSimple } from '@phosphor-icons/react';
import type { TLShapeId } from 'tldraw';
import {
  exportAs,
  DefaultColorStyle, DefaultSizeStyle, DefaultFontStyle,
  DefaultTextAlignStyle, DefaultFillStyle, DefaultDashStyle,
} from 'tldraw';
import { useEditor } from '@tldraw/editor';
import { useValue } from '@tldraw/state-react';
import type { AnyFrame, ShadowMeta, FontOverrides } from './canvasTypes';
import {
  TLDRAW_COLORS, SIZE_OPTIONS, ALIGN_OPTIONS,
  FILL_OPTIONS, DASH_OPTIONS, GEO_TYPES_COMMON, GEO_TYPES_EXTRA,
  ARROW_KIND_OPTIONS, ARROWHEAD_OPTIONS, SHADOW_PRESETS,
} from './canvasConstants';
import {
  applyTextPreset,
} from './canvasTheme';
import type { CanvasTheme } from './canvasTheme';
import {
  SYSTEM_FONT_LIST, detectAvailableFonts,
  saveFontOverrides, applyFontOverridesToContainer,
} from './canvasFontOverrides';
import { enforceBgAtBack } from './canvasTheme';

// ── CanvasFormatPanel ─────────────────────────────────────────────────────────
export function CanvasFormatPanel() {
  const editor = useEditor();
  const [showFontPicker, setShowFontPicker] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  const [fontSearch, setFontSearch] = useState('');
  const [showAllGeo, setShowAllGeo] = useState(false);

  const styles = useValue('fmtStyles', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    return editor.getSharedStyles();
  }, [editor]);

  const selectedFrame = useValue('selectedFrame', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length !== 1) return null;
    const shape = editor.getShape(ids[0]);
    return shape?.type === 'frame' ? shape as AnyFrame : null;
  }, [editor]);

  const arrowInfo = useValue('arrowInfo', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id));
    if (!shapes.every((s) => s?.type === 'arrow')) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = shapes[0]?.props as any;
    const kind = first?.kind === 'elbow' ? 'elbow'
      : (first?.bend === 0 ? 'straight' : 'curve');
    return {
      ids: ids as TLShapeId[],
      kind: kind as 'straight' | 'curve' | 'elbow',
      arrowheadStart: (first?.arrowheadStart ?? 'none') as string,
      arrowheadEnd:   (first?.arrowheadEnd   ?? 'arrow') as string,
    };
  }, [editor]);

  const fontOverrides = useValue('fontOverrides', () => {
    const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
    return (meta?.fontOverrides as FontOverrides) ?? {};
  }, [editor]);

  const canAlign = useValue('canAlign', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length < 2) return false;
    return ids.every((id) => { const s = editor.getShape(id); return s && s.type !== 'frame'; });
  }, [editor]);

  const rotationDegs = useValue('rotationDegs', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id)).filter(Boolean);
    if (shapes.length === 0) return null;
    const rads = shapes.map((s) => s!.rotation);
    const first = rads[0];
    if (rads.every((r) => Math.abs(r - first) < 0.0001)) {
      let deg = (first * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      return Math.round(deg);
    }
    return null;
  }, [editor]);

  const opacityPct = useValue('opacityPct', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id)).filter(Boolean);
    if (shapes.length === 0) return null;
    const opacities = shapes.map((s) => s!.opacity ?? 1);
    const first = opacities[0];
    if (opacities.every((o) => Math.abs(o - first) < 0.01)) return Math.round(first * 100);
    return null;
  }, [editor]);

  const lockInfo = useValue('lockInfo', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id)).filter(Boolean);
    if (shapes.length === 0 || shapes.some((s) => s!.type === 'frame')) return null;
    return { ids: ids as TLShapeId[], allLocked: shapes.every((s) => !!s!.isLocked) };
  }, [editor]);

  const selectionTypes = useValue('selectionTypes', () => {
    const types = new Set<string>();
    editor.getSelectedShapeIds().forEach((id) => {
      const t = editor.getShape(id)?.type;
      if (t) types.add(t);
    });
    return types;
  }, [editor]);

  const effectsInfo = useValue('effectsInfo', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id)).filter(Boolean);
    if (shapes.length === 0) return null;
    if (!shapes.every((s) => s?.type === 'geo' || s?.type === 'image')) return null;
    const meta = (shapes[0]?.meta ?? {}) as Record<string, unknown>;
    const cornerRadius = (meta.cornerRadius as number | undefined) ?? 0;
    const shadow = (meta.shadow as ShadowMeta | null | undefined) ?? null;
    return { ids: ids as TLShapeId[], cornerRadius, shadow };
  }, [editor]);

  const geoInfo = useValue('geoInfo', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return null;
    const shapes = ids.map((id) => editor.getShape(id)).filter(Boolean);
    if (!shapes.every((s) => s?.type === 'geo')) return null;
    if (shapes.some((s) => (s?.meta as Record<string, unknown>)?.isThemeBg)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstGeo = (shapes[0]?.props as any)?.geo as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allSame = shapes.every((s) => (s?.props as any)?.geo === firstGeo);
    return { ids: ids as TLShapeId[], geo: allSame ? (firstGeo ?? null) : null };
  }, [editor]);

  const sizeInfo = useValue('sizeInfo', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length !== 1) return null;
    const shape = editor.getShape(ids[0]);
    if (!shape || shape.type === 'frame' || shape.type === 'group') return null;
    if ((shape.meta as Record<string, unknown>)?.isThemeBg) return null;
    const props = shape.props as unknown as Record<string, unknown>;
    if (typeof props.w !== 'number' || typeof props.h !== 'number') return null;
    return { id: ids[0] as TLShapeId, w: Math.round(props.w as number), h: Math.round(props.h as number), type: shape.type };
  }, [editor]);

  const canGroup = useValue('canGroup', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length < 2) return false;
    return ids.every((id) => { const s = editor.getShape(id); return s && s.type !== 'frame'; });
  }, [editor]);

  const isGroup = useValue('isGroup', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length !== 1) return false;
    return editor.getShape(ids[0])?.type === 'group';
  }, [editor]);

  const canFlip = useValue('canFlip', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return false;
    return ids.every((id) => { const s = editor.getShape(id); return s && (s.type === 'geo' || s.type === 'image'); });
  }, [editor]);

  const canReorder = useValue('canReorder', () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) return false;
    return ids.some((id) => { const s = editor.getShape(id); return s && s.type !== 'frame'; });
  }, [editor]);

  const selCount = useValue('selCount', () => editor.getSelectedShapeIds().length, [editor]);

  if (!styles && !selectedFrame && !arrowInfo && !effectsInfo && !isGroup && !canReorder) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function updateArrows(patch: Record<string, any>) {
    if (!arrowInfo) return;
    for (const id of arrowInfo.ids) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: 'arrow', props: patch as any });
    }
  }

  function setArrowKind(kind: 'straight' | 'curve' | 'elbow') {
    if (kind === 'elbow')    updateArrows({ kind: 'elbow' });
    if (kind === 'straight') updateArrows({ kind: 'arc', bend: 0 });
    if (kind === 'curve') {
      const wasStraight = arrowInfo?.kind === 'straight' || arrowInfo?.kind === 'elbow';
      updateArrows(wasStraight ? { kind: 'arc', bend: 50 } : { kind: 'arc' });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sv(prop: any): string | null {
    if (styles) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = styles.get(prop) as { type: string; value?: string } | undefined;
      if (s?.type === 'shared') return s.value ?? null;
    }
    const key = prop === DefaultDashStyle ? 'dash' : prop === DefaultFillStyle ? 'fill' : null;
    if (!key) return null;
    const ids = editor.getSelectedShapeIds();
    let val: string | null = null;
    for (const id of ids) {
      const s = editor.getShape(id);
      if (!s || !(key in (s.props as Record<string, unknown>))) continue;
      const v = (s.props as Record<string, unknown>)[key] as string;
      if (val === null) { val = v; }
      else if (val !== v) return null;
    }
    return val;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ss(prop: any, value: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.setStyleForSelectedShapes(prop as any, value as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.setStyleForNextShapes(prop as any, value as any);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applicable(prop: any): boolean {
    if (styles?.get(prop) !== undefined) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = prop === DefaultDashStyle ? 'dash' : prop === DefaultFillStyle ? 'fill' : null;
    if (!key) return false;
    return editor.getSelectedShapeIds().some((id) => {
      const s = editor.getShape(id);
      return s && key in (s.props as Record<string, unknown>);
    });
  }

  // ── Align / Distribute ───────────────────────────────────────────────────────
  function alignAll(type: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom') {
    const ids = editor.getSelectedShapeIds().filter((id) => {
      const s = editor.getShape(id); return s && s.type !== 'frame';
    }) as TLShapeId[];
    if (ids.length < 2) return;
    const items = ids.map((id) => {
      const shape = editor.getShape(id)!;
      const bounds = editor.getShapePageBounds(id)!;
      return { id, shape, bounds };
    }).filter((x) => x.bounds);
    if (items.length < 2) return;
    const minX = Math.min(...items.map((i) => i.bounds.x));
    const maxX = Math.max(...items.map((i) => i.bounds.x + i.bounds.w));
    const minY = Math.min(...items.map((i) => i.bounds.y));
    const maxY = Math.max(...items.map((i) => i.bounds.y + i.bounds.h));
    const cX = (minX + maxX) / 2;
    const cY = (minY + maxY) / 2;
    for (const { id, shape, bounds } of items) {
      let dx = 0, dy = 0;
      if (type === 'left')     dx = minX - bounds.x;
      if (type === 'center-h') dx = cX   - (bounds.x + bounds.w / 2);
      if (type === 'right')    dx = maxX - (bounds.x + bounds.w);
      if (type === 'top')      dy = minY - bounds.y;
      if (type === 'center-v') dy = cY   - (bounds.y + bounds.h / 2);
      if (type === 'bottom')   dy = maxY - (bounds.y + bounds.h);
      if (dx !== 0 || dy !== 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({ id, type: shape.type, x: shape.x + dx, y: shape.y + dy } as any);
    }
  }

  function distributeAll(dir: 'horizontal' | 'vertical') {
    const ids = editor.getSelectedShapeIds().filter((id) => {
      const s = editor.getShape(id); return s && s.type !== 'frame';
    }) as TLShapeId[];
    if (ids.length < 3) return;
    const items = ids.map((id) => {
      const shape = editor.getShape(id)!;
      const bounds = editor.getShapePageBounds(id)!;
      return { id, shape, bounds };
    }).filter((x) => x.bounds);
    if (items.length < 3) return;
    if (dir === 'horizontal') {
      const sorted = [...items].sort((a, b) => a.bounds.x - b.bounds.x);
      const startCx = sorted[0].bounds.x + sorted[0].bounds.w / 2;
      const endCx   = sorted[sorted.length - 1].bounds.x + sorted[sorted.length - 1].bounds.w / 2;
      const step = (endCx - startCx) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const { id, shape, bounds } = sorted[i];
        const dx = (startCx + i * step) - (bounds.x + bounds.w / 2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({ id, type: shape.type, x: shape.x + dx, y: shape.y } as any);
      }
    } else {
      const sorted = [...items].sort((a, b) => a.bounds.y - b.bounds.y);
      const startCy = sorted[0].bounds.y + sorted[0].bounds.h / 2;
      const endCy   = sorted[sorted.length - 1].bounds.y + sorted[sorted.length - 1].bounds.h / 2;
      const step = (endCy - startCy) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const { id, shape, bounds } = sorted[i];
        const dy = (startCy + i * step) - (bounds.y + bounds.h / 2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({ id, type: shape.type, x: shape.x, y: shape.y + dy } as any);
      }
    }
  }

  function setRotDeg(deg: number) {
    const rad = ((deg % 360) + 360) % 360 * Math.PI / 180;
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    for (const id of ids) {
      const shape = editor.getShape(id);
      if (!shape) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: shape.type, rotation: rad } as any);
    }
  }

  function setOpacity(pct: number) {
    const opacity = Math.max(0, Math.min(1, pct / 100));
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    for (const id of ids) {
      const shape = editor.getShape(id);
      if (!shape) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: shape.type, opacity } as any);
    }
  }

  function toggleLock() {
    if (!lockInfo) return;
    const newLocked = !lockInfo.allLocked;
    for (const id of lockInfo.ids) {
      const shape = editor.getShape(id);
      if (!shape) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: shape.type, isLocked: newLocked } as any);
    }
    if (newLocked)
      editor.setSelectedShapes(editor.getSelectedShapeIds().filter((id) => !lockInfo.ids.includes(id as TLShapeId)));
  }

  function setGeoType(geo: string) {
    if (!geoInfo) return;
    for (const id of geoInfo.ids) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: 'geo', props: { geo } } as any);
    }
  }

  function setShapeSize(dim: 'w' | 'h', value: number) {
    if (!sizeInfo) return;
    const v = Math.max(1, Math.round(value));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShape({ id: sizeInfo.id, type: sizeInfo.type, props: { [dim]: v } } as any);
  }

  function flipShapes(dir: 'horizontal' | 'vertical') {
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    if (ids.length === 0) return;
    editor.flipShapes(ids, dir);
  }

  function layerOrder(op: 'front' | 'forward' | 'backward' | 'back') {
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    const nonFrames = ids.filter((id) => {
      const s = editor.getShape(id);
      return s && s.type !== 'frame' && !(s.meta as Record<string, unknown>)?.isThemeBg;
    });
    if (nonFrames.length === 0) return;
    if (op === 'front')    editor.bringToFront(nonFrames);
    if (op === 'forward')  editor.bringForward(nonFrames);
    if (op === 'backward') editor.sendBackward(nonFrames);
    if (op === 'back')     editor.sendToBack(nonFrames);
    enforceBgAtBack(editor);
  }

  function groupSelected() {
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    const nonFrames = ids.filter((id) => editor.getShape(id)?.type !== 'frame');
    if (nonFrames.length < 2) return;
    editor.groupShapes(nonFrames, { select: true });
  }

  function ungroupSelected() {
    const ids = editor.getSelectedShapeIds() as TLShapeId[];
    const groups = ids.filter((id) => editor.getShape(id)?.type === 'group');
    if (groups.length === 0) return;
    editor.ungroupShapes(groups, { select: true });
  }

  function setEffectsMeta(ids: TLShapeId[], patch: { cornerRadius?: number; shadow?: ShadowMeta | null }) {
    for (const id of ids) {
      const shape = editor.getShape(id);
      if (!shape) continue;
      const existingMeta = (shape.meta ?? {}) as Record<string, unknown>;
      const newMeta: Record<string, unknown> = { ...existingMeta };
      if ('cornerRadius' in patch) newMeta.cornerRadius = patch.cornerRadius;
      if ('shadow' in patch) newMeta.shadow = patch.shadow ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id, type: shape.type, meta: newMeta } as any);
    }
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
  const colorLabel = selectionTypes.size > 0 && [...selectionTypes].every((t) => t === 'text' || t === 'note')
    ? 'Text Color' : 'Color';

  function activeCustomLabel(): string | null {
    if (curFont === 'sans'  && fontOverrides.sans)  return fontOverrides.sans;
    if (curFont === 'serif' && fontOverrides.serif) return fontOverrides.serif;
    if (curFont === 'mono'  && fontOverrides.mono)  return fontOverrides.mono;
    return null;
  }

  function openFontPicker() {
    setShowFontPicker((v) => !v);
    if (systemFonts === null) {
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

  // Read the current canvas theme (needed for "Insert Heading/Body" buttons)
  const canvasTheme = useValue('canvasTheme', () => {
    const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
    // Inline a simplified loadThemeFromDoc since we can't call it inside useValue
    // without a React closure (it's fine here since we only need it for the button label)
    return (meta?.theme as Partial<CanvasTheme>) ?? null;
  }, [editor]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const theme = canvasTheme as any as CanvasTheme;

  return (
    <div className="canvas-fmt-panel" onPointerDown={(e) => e.stopPropagation()}>

      {selCount >= 2 && !selectedFrame && (
        <div className="canvas-fmt-sel-badge">{selCount} selected</div>
      )}

      {selectedFrame && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Slide</div>
          <div className="canvas-fmt-row">
            <button
              className="canvas-fmt-btn"
              onClick={() => exportAs(editor, [selectedFrame.id as TLShapeId], {
                format: 'png',
                name: (selectedFrame as AnyFrame).props?.name || 'slide',
              })}
              title="Export this slide as PNG"
            >
              <DownloadSimple weight="thin" size={14} /> Export PNG
            </button>
          </div>
        </div>
      )}

      {arrowInfo && (
        <>
          <div className="canvas-fmt-section">
            <div className="canvas-fmt-label">Style</div>
            <div className="canvas-fmt-row">
              {ARROW_KIND_OPTIONS.map((k) => (
                <button
                  key={k.value}
                  className={`canvas-fmt-btn${arrowInfo.kind === k.value ? ' canvas-fmt-btn--on' : ''}`}
                  onClick={() => setArrowKind(k.value)}
                  title={k.title}
                  style={{ fontSize: 16 }}
                >{k.label}</button>
              ))}
            </div>
          </div>
          <div className="canvas-fmt-section">
            <div className="canvas-fmt-label">Start</div>
            <div className="canvas-fmt-row">
              {ARROWHEAD_OPTIONS.map((a) => (
                <button
                  key={a.value}
                  className={`canvas-fmt-btn${arrowInfo.arrowheadStart === a.value ? ' canvas-fmt-btn--on' : ''}`}
                  onClick={() => updateArrows({ arrowheadStart: a.value })}
                  title={a.title}
                  style={{ fontSize: 13 }}
                >{a.icon}</button>
              ))}
            </div>
          </div>
          <div className="canvas-fmt-section">
            <div className="canvas-fmt-label">End</div>
            <div className="canvas-fmt-row">
              {ARROWHEAD_OPTIONS.map((a) => (
                <button
                  key={a.value}
                  className={`canvas-fmt-btn${arrowInfo.arrowheadEnd === a.value ? ' canvas-fmt-btn--on' : ''}`}
                  onClick={() => updateArrows({ arrowheadEnd: a.value })}
                  title={a.title}
                  style={{ fontSize: 13 }}
                >{a.icon}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {hasFont && !arrowInfo && (
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
            <button
              className={`canvas-fmt-btn canvas-fmt-btn-more${showFontPicker ? ' canvas-fmt-btn--on' : ''}`}
              onClick={openFontPicker}
              title="More fonts…"
            >···</button>
          </div>

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

      {geoInfo && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Shape</div>
          <div className="canvas-fmt-geo-grid">
            {GEO_TYPES_COMMON.map((g) => (
              <button
                key={g.value}
                className={`canvas-fmt-geo-btn${geoInfo.geo === g.value ? ' canvas-fmt-btn--on' : ''}`}
                onClick={() => setGeoType(g.value)}
                title={g.label}
              >{g.icon}</button>
            ))}
            {showAllGeo && GEO_TYPES_EXTRA.map((g) => (
              <button
                key={g.value}
                className={`canvas-fmt-geo-btn${geoInfo.geo === g.value ? ' canvas-fmt-btn--on' : ''}`}
                onClick={() => setGeoType(g.value)}
                title={g.label}
              >{g.icon}</button>
            ))}
            <button
              className="canvas-fmt-geo-btn canvas-fmt-geo-more"
              onClick={() => setShowAllGeo((v) => !v)}
              title={showAllGeo ? 'Show less' : 'More shapes'}
            >{showAllGeo ? '▲' : '···'}</button>
          </div>
        </div>
      )}

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

      <div className="canvas-fmt-section">
        <div className="canvas-fmt-label">{colorLabel}</div>
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

      {hasFill && !arrowInfo && (
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

      {sizeInfo && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Dimensions</div>
          <div className="canvas-fmt-wh-row">
            <label className="canvas-fmt-wh-label">W</label>
            <input
              type="number"
              className="canvas-fmt-wh-input"
              min={1} step={1}
              value={sizeInfo.w}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (v > 0) setShapeSize('w', v); }}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <label className="canvas-fmt-wh-label">H</label>
            <input
              type="number"
              className="canvas-fmt-wh-input"
              min={1} step={1}
              value={sizeInfo.h}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (v > 0) setShapeSize('h', v); }}
              onPointerDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {rotationDegs !== null && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Rotation</div>
          <div className="canvas-fmt-rotation-row">
            <button
              className="canvas-fmt-btn canvas-fmt-rot-btn"
              onClick={() => setRotDeg(Math.round(((rotationDegs ?? 0) - 90 + 360) % 360))}
              title="Rotate −90°"
            >−90</button>
            <input
              type="number"
              className="canvas-fmt-rotation-input"
              value={rotationDegs ?? ''}
              min={0} max={359} step={1}
              onChange={(e) => setRotDeg(Number(e.target.value))}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <span className="canvas-fmt-rotation-deg">°</span>
            <button
              className="canvas-fmt-btn canvas-fmt-rot-btn"
              onClick={() => setRotDeg(Math.round(((rotationDegs ?? 0) + 90) % 360))}
              title="Rotate +90°"
            >+90</button>
          </div>
        </div>
      )}

      {opacityPct !== null && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label-row-space">
            <span className="canvas-fmt-label">Opacity</span>
            <span className="canvas-fmt-dim-value">{opacityPct}%</span>
          </div>
          <input
            type="range"
            className="canvas-fmt-opacity-slider"
            style={{ '--v': `${opacityPct}%` } as React.CSSProperties}
            min={10} max={100} step={5}
            value={opacityPct}
            onChange={(e) => setOpacity(Number(e.target.value))}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {canAlign && !arrowInfo && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Align</div>
          <div className="canvas-fmt-row">
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('left')}      title="Align left edges">⇤</button>
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('center-h')} title="Center horizontally">↔</button>
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('right')}     title="Align right edges">⇥</button>
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('top')}       title="Align top edges">⇡</button>
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('center-v')} title="Center vertically">↕</button>
            <button className="canvas-fmt-btn canvas-fmt-align-btn" onClick={() => alignAll('bottom')}    title="Align bottom edges">⇣</button>
          </div>
          {editor.getSelectedShapeIds().length >= 3 && (
            <div className="canvas-fmt-row" style={{ marginTop: 2 }}>
              <button className="canvas-fmt-btn" onClick={() => distributeAll('horizontal')} title="Distribute horizontally">↔</button>
              <button className="canvas-fmt-btn" onClick={() => distributeAll('vertical')}   title="Distribute vertically">↕</button>
            </div>
          )}
        </div>
      )}

      {(canReorder || (lockInfo && !lockInfo.allLocked)) && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Layer</div>
          <div className="canvas-fmt-row">
            {canReorder && (
              <>
                <button className="canvas-fmt-btn canvas-fmt-layer-btn" onClick={() => layerOrder('front')}    title="Bring to front">⤒</button>
                <button className="canvas-fmt-btn canvas-fmt-layer-btn" onClick={() => layerOrder('forward')}  title="Bring forward">↑</button>
                <button className="canvas-fmt-btn canvas-fmt-layer-btn" onClick={() => layerOrder('backward')} title="Send backward">↓</button>
                <button className="canvas-fmt-btn canvas-fmt-layer-btn" onClick={() => layerOrder('back')}     title="Send to back">⤓</button>
              </>
            )}
            {lockInfo && !lockInfo.allLocked && (
              <button
                className="canvas-fmt-btn canvas-fmt-lock-icon-btn"
                onClick={toggleLock}
                title="Lock — holds in place; long-press on canvas to unlock"
              ><Lock weight="thin" size={13} /></button>
            )}
          </div>
        </div>
      )}

      {(canGroup || isGroup) && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-row">
            {canGroup && (
              <button className="canvas-fmt-btn" onClick={groupSelected} title="Group selected shapes (Cmd+G)">⊞ Group</button>
            )}
            {isGroup && (
              <button className="canvas-fmt-btn" onClick={ungroupSelected} title="Ungroup (Cmd+Shift+G)">⊡ Ungroup</button>
            )}
          </div>
        </div>
      )}

      {canFlip && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Flip</div>
          <div className="canvas-fmt-row">
            <button className="canvas-fmt-btn" onClick={() => flipShapes('horizontal')} title="Flip horizontal">↔ H</button>
            <button className="canvas-fmt-btn" onClick={() => flipShapes('vertical')}   title="Flip vertical">↕ V</button>
          </div>
        </div>
      )}

      {effectsInfo && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label-row-space">
            <span className="canvas-fmt-label">Radius</span>
            <span className="canvas-fmt-dim-value">{effectsInfo.cornerRadius}px</span>
          </div>
          <input
            type="range"
            className="canvas-fmt-opacity-slider"
            style={{ '--v': `${(effectsInfo.cornerRadius / 80) * 100}%` } as React.CSSProperties}
            min={0} max={80} step={2}
            value={effectsInfo.cornerRadius}
            onChange={(e) => setEffectsMeta(effectsInfo.ids, { cornerRadius: Number(e.target.value) })}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {effectsInfo && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Shadow</div>
          <div className="canvas-fmt-row">
            <button
              className={`canvas-fmt-btn${!effectsInfo.shadow ? ' canvas-fmt-btn--on' : ''}`}
              onClick={() => setEffectsMeta(effectsInfo.ids, { shadow: null })}
              title="No shadow"
            >None</button>
            {SHADOW_PRESETS.map((p) => (
              <button
                key={p.label}
                className={`canvas-fmt-btn${
                  effectsInfo.shadow &&
                  effectsInfo.shadow.blur === p.value.blur &&
                  effectsInfo.shadow.opacity === p.value.opacity
                    ? ' canvas-fmt-btn--on' : ''
                }`}
                onClick={() => setEffectsMeta(effectsInfo.ids, { shadow: p.value })}
                title={`${p.label} shadow`}
              >{p.label}</button>
            ))}
          </div>
          {effectsInfo.shadow && (
            <div className="canvas-fmt-shadow-sliders">
              <div className="canvas-fmt-shadow-row">
                <span className="canvas-fmt-shadow-label">Blur</span>
                <input
                  type="range"
                  className="canvas-fmt-opacity-slider canvas-fmt-shadow-slider"
                  style={{ '--v': `${(effectsInfo.shadow.blur / 60) * 100}%` } as React.CSSProperties}
                  min={0} max={60} step={2}
                  value={effectsInfo.shadow.blur}
                  onChange={(e) => setEffectsMeta(effectsInfo.ids, { shadow: { ...effectsInfo.shadow!, blur: Number(e.target.value) } })}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                <span className="canvas-fmt-dim-value">{effectsInfo.shadow.blur}</span>
              </div>
              <div className="canvas-fmt-shadow-row">
                <span className="canvas-fmt-shadow-label">Y</span>
                <input
                  type="range"
                  className="canvas-fmt-opacity-slider canvas-fmt-shadow-slider"
                  style={{ '--v': `${((effectsInfo.shadow.y + 30) / 60) * 100}%` } as React.CSSProperties}
                  min={-30} max={30} step={1}
                  value={effectsInfo.shadow.y}
                  onChange={(e) => setEffectsMeta(effectsInfo.ids, { shadow: { ...effectsInfo.shadow!, y: Number(e.target.value) } })}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                <span className="canvas-fmt-dim-value">{effectsInfo.shadow.y}</span>
              </div>
              <div className="canvas-fmt-shadow-row">
                <span className="canvas-fmt-shadow-label">X</span>
                <input
                  type="range"
                  className="canvas-fmt-opacity-slider canvas-fmt-shadow-slider"
                  style={{ '--v': `${((effectsInfo.shadow.x + 30) / 60) * 100}%` } as React.CSSProperties}
                  min={-30} max={30} step={1}
                  value={effectsInfo.shadow.x}
                  onChange={(e) => setEffectsMeta(effectsInfo.ids, { shadow: { ...effectsInfo.shadow!, x: Number(e.target.value) } })}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                <span className="canvas-fmt-dim-value">{effectsInfo.shadow.x}</span>
              </div>
              <div className="canvas-fmt-shadow-row">
                <span className="canvas-fmt-shadow-label">Dark</span>
                <input
                  type="range"
                  className="canvas-fmt-opacity-slider canvas-fmt-shadow-slider"
                  style={{ '--v': `${effectsInfo.shadow.opacity * 100}%` } as React.CSSProperties}
                  min={0.05} max={1} step={0.05}
                  value={effectsInfo.shadow.opacity}
                  onChange={(e) => setEffectsMeta(effectsInfo.ids, { shadow: { ...effectsInfo.shadow!, opacity: Number(e.target.value) } })}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                <span className="canvas-fmt-dim-value">{Math.round(effectsInfo.shadow.opacity * 100)}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Heading / Body insert buttons — shown when theme is available */}
      {theme && !arrowInfo && !selectedFrame && (
        <div className="canvas-fmt-section">
          <div className="canvas-fmt-label">Insert</div>
          <div className="canvas-fmt-row">
            <button
              className="canvas-fmt-btn"
              onClick={() => applyTextPreset(editor, 'heading', theme)}
              title="Set pen to heading style"
            >Heading style</button>
            <button
              className="canvas-fmt-btn"
              onClick={() => applyTextPreset(editor, 'body', theme)}
              title="Set pen to body style"
            >Body style</button>
          </div>
        </div>
      )}

    </div>
  );
}
