/**
 * CanvasOverlays
 *
 * In-canvas overlay components rendered via tldraw's InFrontOfTheCanvas slot:
 *   - ArrowAutoConnectHandler  — auto-creates connected boxes when arrows land on empty space
 *   - CanvasAIMarkOverlay      — golden highlight chips for AI-edited shapes
 *   - ArrowHandles             — blue drag dots for one-click arrow creation
 *   - LockedShapesOverlay      — intentionally empty (no permanent lock badge)
 *   - CornerRadiusHandle       — drag dot to set corner radius on geo/image shapes
 *   - CanvasShortcutHints      — modifier-key hint bar shown when shapes are selected
 *   - ZoomIndicator            — zoom +/−/% widget
 *   - ShapeEffectsStyle        — injects CSS for shadow + border-radius per shape
 *   - CanvasOverlays           — root wrapper that mounts all of the above
 *
 * All components must remain module-level (not nested inside CanvasEditor) so
 * tldraw doesn't remount them on every render.
 */
import { Component, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TLShapeId } from 'tldraw';
import { createShapeId } from 'tldraw';
import { useEditor } from '@tldraw/editor';
import { useValue } from '@tldraw/state-react';
import { CanvasAICtx } from './CanvasAIContext';
import type { ShadowMeta } from './canvasTypes';
import { hexToRgba } from './canvasConstants';
import { CanvasFormatPanel } from './CanvasFormatPanel';

// ── Arrow auto-connect ─────────────────────────────────────────────────────────
// Rendered inside the tldraw tree so it can access useEditor().
// Mimics FigJam behaviour: if you draw an arrow starting FROM a shape and release on
// empty canvas, a new rectangle is created and the arrow is immediately bound to it.
function ArrowAutoConnectHandler() {
  const editor = useEditor();

  useEffect(() => {
    let isPointerDown = false;
    let arrowMutatedDuringGesture = false;

    function onPointerDown() {
      isPointerDown = true;
      arrowMutatedDuringGesture = false;
    }

    function onPointerUp() {
      isPointerDown = false;
      if (!arrowMutatedDuringGesture) return;
      arrowMutatedDuringGesture = false;

      // Defer one frame so tldraw can finalise the arrow before we inspect it
      requestAnimationFrame(() => {
        const selected = editor.getSelectedShapes();
        if (selected.length !== 1) return;
        const shape = selected[0];
        if (shape.type !== 'arrow') return;

        // tldraw 4.x: bindings are separate store records, NOT embedded in props.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arrowBindings = editor.getBindingsFromShape(shape.id, 'arrow') as any[];
        const hasStartBinding = arrowBindings.some((b) => b.props?.terminal === 'start');
        const hasEndBinding   = arrowBindings.some((b) => b.props?.terminal === 'end');

        if (!hasStartBinding || hasEndBinding) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arrowProps = shape.props as any;
        const endPageX = shape.x + (arrowProps.end?.x ?? 0);
        const endPageY = shape.y + (arrowProps.end?.y ?? 0);

        const BOX_W = 180;
        const BOX_H = 90;
        const newId = createShapeId();

        editor.createShape({
          id: newId,
          type: 'geo',
          x: endPageX - BOX_W / 2,
          y: endPageY - BOX_H / 2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { geo: 'rectangle', w: BOX_W, h: BOX_H, fill: 'none', dash: 'solid', color: 'black', size: 'm' } as any,
        });
        editor.createBinding({
          type: 'arrow',
          fromId: shape.id,
          toId: newId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } as any,
        });

        editor.setSelectedShapes([newId]);
        editor.setEditingShape(newId);
      });
    }

    const unsub = editor.store.listen(
      (changes) => {
        if (!isPointerDown) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isArrow = (r: any) => r?.typeName === 'shape' && r?.type === 'arrow';
        const added   = Object.values(changes.changes.added   ?? {});
        const updated = Object.values(changes.changes.updated ?? {});
        if (added.some(isArrow) || updated.some(([, next]) => isArrow(next))) {
          arrowMutatedDuringGesture = true;
        }
      },
      { scope: 'document', source: 'user' },
    );

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup',   onPointerUp);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup',   onPointerUp);
      unsub();
    };
  }, [editor]);

  return null;
}

// ── Canvas AI mark overlay ─────────────────────────────────────────────────────
function CanvasAIMarkOverlay() {
  const editor = useEditor();
  const { aiMarks, aiHighlight, aiNavIndex, onPrev, onNext, onReview } = useContext(CanvasAICtx);

  const chipPositions = useValue(
    'canvasAIChipPositions',
    () => {
      if (!aiHighlight) return [];
      const positions: Array<{
        markId: string;
        shapeId: string;
        top: number;
        left: number;
        width: number;
        height: number;
      }> = [];

      for (const mark of aiMarks) {
        if (mark.reviewed || !mark.canvasShapeIds?.length) continue;
        for (const shapeId of mark.canvasShapeIds) {
          const bounds = editor.getShapePageBounds(shapeId as TLShapeId);
          if (!bounds) continue;
          const tl = editor.pageToViewport({ x: bounds.x, y: bounds.y });
          const br = editor.pageToViewport({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
          positions.push({
            markId: mark.id,
            shapeId,
            top: tl.y,
            left: tl.x,
            width: br.x - tl.x,
            height: br.y - tl.y,
          });
        }
      }
      return positions;
    },
    [editor, aiMarks, aiHighlight],
  );

  if (!aiHighlight || chipPositions.length === 0) return null;

  const currentMark = aiMarks[aiNavIndex] ?? aiMarks[0];

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 500 }}>
      {chipPositions.map(({ markId, shapeId, top, left, width, height }) => {
        const isCurrent = currentMark?.id === markId;
        const markIndex = aiMarks.findIndex((m) => m.id === markId);
        return (
          <div key={`${markId}-${shapeId}`}>
            <div
              style={{
                position: 'absolute',
                top,
                left,
                width,
                height,
                border: isCurrent
                  ? '2px solid rgba(212, 169, 106, 0.9)'
                  : '1.5px solid rgba(212, 169, 106, 0.55)',
                borderRadius: 4,
                backgroundColor: isCurrent
                  ? 'rgba(212, 169, 106, 0.08)'
                  : 'rgba(212, 169, 106, 0.04)',
                boxShadow: isCurrent ? '0 0 0 3px rgba(212,169,106,0.15)' : 'none',
                pointerEvents: 'none',
              }}
            />
            {isCurrent && (
              <div
                style={{
                  position: 'absolute',
                  top: top - 32,
                  left: left + width / 2,
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  background: '#201b14',
                  border: '1px solid rgba(212, 169, 106, 0.55)',
                  borderRadius: 8,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
                  overflow: 'hidden',
                  pointerEvents: 'auto',
                  userSelect: 'none',
                  zIndex: 501,
                }}
              >
                <button
                  onClick={onPrev}
                  disabled={aiMarks.length < 2}
                  style={{ background: 'none', border: 'none', color: '#c4b49a', cursor: 'pointer', fontSize: 16, padding: '3px 8px', lineHeight: 1 }}
                  title="Previous AI edit"
                >‹</button>
                <span
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 6px',
                    borderLeft: '1px solid rgba(212,169,106,0.2)',
                    borderRight: '1px solid rgba(212,169,106,0.2)',
                    fontSize: 11, color: 'rgba(212,169,106,0.85)', fontFamily: 'monospace',
                  }}
                >
                  <span style={{ color: 'rgba(212,169,106,0.9)', fontSize: 10 }}>✦</span>
                  {markIndex + 1}/{aiMarks.length}
                </span>
                <button
                  onClick={() => onReview(markId)}
                  style={{
                    background: 'none', border: 'none',
                    color: '#7ec8a0', cursor: 'pointer',
                    fontSize: 13, padding: '3px 8px', lineHeight: 1,
                  }}
                  title="Accept / mark reviewed"
                >✓</button>
                <button
                  onClick={onNext}
                  disabled={aiMarks.length < 2}
                  style={{ background: 'none', border: 'none', color: '#c4b49a', cursor: 'pointer', fontSize: 16, padding: '3px 8px', lineHeight: 1 }}
                  title="Next AI edit"
                >›</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Arrow handle dots ──────────────────────────────────────────────────────────
// Four blue circles around a single selected shape; drag to create bound arrows.
const ARROW_HANDLE_TYPES  = new Set(['geo', 'text', 'arrow', 'note', 'embed']);
const ARROW_HANDLE_OFFSET = 26; // viewport px outward from the shape edge
const ARROW_HANDLE_R      = 8;  // dot radius in px

function ArrowHandles() {
  const editor = useEditor();
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ arrowId: TLShapeId } | null>(null);

  type HandleData = {
    shapeId: TLShapeId;
    handles: { id: string; vx: number; vy: number; anchor: { x: number; y: number } }[];
  };
  const handleDataRef = useRef<HandleData | null>(null);

  function computeHandleData(): HandleData | null {
    if (editor.getEditingShapeId()) return null;
    const selected = editor.getSelectedShapes();
    if (selected.length !== 1) return null;
    const shape = selected[0];
    if (!ARROW_HANDLE_TYPES.has(shape.type)) return null;
    const bounds = editor.getShapePageBounds(shape.id);
    if (!bounds) return null;
    const tl = editor.pageToViewport({ x: bounds.x,           y: bounds.y            });
    const br = editor.pageToViewport({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
    const cx = (tl.x + br.x) / 2;
    const cy = (tl.y + br.y) / 2;
    return {
      shapeId: shape.id as TLShapeId,
      handles: [
        { id: 'top',    vx: cx,                        vy: tl.y - ARROW_HANDLE_OFFSET, anchor: { x: 0.5, y: 0   } },
        { id: 'right',  vx: br.x + ARROW_HANDLE_OFFSET, vy: cy,                        anchor: { x: 1,   y: 0.5 } },
        { id: 'bottom', vx: cx,                        vy: br.y + ARROW_HANDLE_OFFSET, anchor: { x: 0.5, y: 1   } },
        { id: 'left',   vx: tl.x - ARROW_HANDLE_OFFSET, vy: cy,                        anchor: { x: 0,   y: 0.5 } },
      ],
    };
  }

  const handleData = useValue('arrowHandlePositions', computeHandleData, [editor]);
  handleDataRef.current = handleData ?? null;

  function onHandlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    shapeId: TLShapeId,
    anchor: { x: number; y: number },
  ) {
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    e.preventDefault();

    const pageOrigin = editor.screenToPage({ x: e.clientX, y: e.clientY });
    const arrowId = createShapeId();
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: pageOrigin.x,
      y: pageOrigin.y,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } } as any,
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: shapeId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { terminal: 'start', normalizedAnchor: anchor, isExact: false, isPrecise: true } as any,
    });
    editor.setSelectedShapes([arrowId]);

    dragRef.current = { arrowId };
    setDragging(true);

    function handleMove(ev: PointerEvent) {
      if (!dragRef.current) return;
      ev.stopPropagation();
      const arrow = editor.getShape(dragRef.current.arrowId);
      if (!arrow) return;
      const pageEnd = editor.screenToPage({ x: ev.clientX, y: ev.clientY });
      editor.updateShape({
        id: dragRef.current.arrowId,
        type: 'arrow',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        props: { end: { x: pageEnd.x - arrow.x, y: pageEnd.y - arrow.y } } as any,
      });
    }

    function handleUp(ev: PointerEvent) {
      window.removeEventListener('pointermove', handleMove, true);
      window.removeEventListener('pointerup',   handleUp,   true);
      if (!dragRef.current) return;
      ev.stopPropagation();

      const { arrowId: activeArrowId } = dragRef.current;
      const pageEnd = editor.screenToPage({ x: ev.clientX, y: ev.clientY });
      const arrow = editor.getShape(activeArrowId);

      if (arrow) {
        const hit = editor.getShapeAtPoint(pageEnd, { hitInside: true, margin: 8 });
        const target = hit && hit.id !== shapeId && hit.id !== activeArrowId && hit.type !== 'frame' ? hit : null;

        if (target) {
          editor.createBinding({
            type: 'arrow',
            fromId: activeArrowId,
            toId: target.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } as any,
          });
          editor.setSelectedShapes([activeArrowId]);
        } else {
          const BOX_W = 180, BOX_H = 90;
          const newId = createShapeId();
          editor.createShape({
            id: newId,
            type: 'geo',
            x: pageEnd.x - BOX_W / 2,
            y: pageEnd.y - BOX_H / 2,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            props: { geo: 'rectangle', w: BOX_W, h: BOX_H, fill: 'none', dash: 'solid', color: 'black', size: 'm' } as any,
          });
          editor.createBinding({
            type: 'arrow',
            fromId: activeArrowId,
            toId: newId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } as any,
          });
          editor.setSelectedShapes([newId]);
          editor.setEditingShape(newId);
        }
      }

      dragRef.current = null;
      setDragging(false);
    }

    window.addEventListener('pointermove', handleMove, true);
    window.addEventListener('pointerup',   handleUp,   true);
  }

  if (!handleData || dragging) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 490 }}>
      {handleData.handles.map(({ id, vx, vy, anchor }) => (
        <div
          key={id}
          title="Drag to connect"
          style={{
            position: 'absolute',
            left: vx,
            top: vy,
            width: ARROW_HANDLE_R * 2,
            height: ARROW_HANDLE_R * 2,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: '#2b83f6',
            border: '2.5px solid #fff',
            boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
            cursor: 'crosshair',
            pointerEvents: 'auto',
          }}
          onPointerDown={(e) => onHandlePointerDown(e, handleData.shapeId, anchor)}
        />
      ))}
    </div>
  );
}

// ── Locked shapes overlay — intentionally hidden ───────────────────────────────
// Lock icons only appear transiently via lockFlash; no permanent badge.
function LockedShapesOverlay() {
  return null;
}

// ── Corner radius direct-drag handle ──────────────────────────────────────────
const CR_HANDLE_R = 5;

function CornerRadiusHandle() {
  const editor = useEditor();
  const draggingRef = useRef<{
    startX: number;
    startRadius: number;
    shapeId: TLShapeId;
    maxRadius: number;
  } | null>(null);
  const [liveRadius, setLiveRadius] = useState<number | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);

  const handlePos = useValue('crHandle', () => {
    if (editor.getEditingShapeId()) return null;
    const ids = editor.getSelectedShapeIds();
    if (ids.length !== 1) return null;
    const shape = editor.getShape(ids[0]);
    if (!shape || shape.type === 'frame' || shape.isLocked) return null;
    if ((shape.meta as Record<string, unknown>)?.isThemeBg) return null;
    if (shape.type !== 'geo' && shape.type !== 'image') return null;
    const props = shape.props as unknown as { w?: number; h?: number };
    if (typeof props.w !== 'number' || typeof props.h !== 'number') return null;
    const radius = ((shape.meta as Record<string, unknown>)?.cornerRadius as number) ?? 0;
    const bounds = editor.getShapePageBounds(ids[0]);
    if (!bounds) return null;
    const zoom = editor.getZoomLevel();
    const tl = editor.pageToViewport({ x: bounds.x, y: bounds.y });
    const br = editor.pageToViewport({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
    const maxR = Math.min(Math.floor(bounds.w / 2), Math.floor(bounds.h / 2), 80);
    const crOff = Math.min(radius * zoom, (br.x - tl.x) / 3, (br.y - tl.y) / 3);
    return {
      id: ids[0] as TLShapeId,
      radius,
      x: tl.x + CR_HANDLE_R * 3 + crOff,
      y: tl.y + CR_HANDLE_R * 3 + crOff,
      maxRadius: maxR,
    };
  }, [editor]);

  function onPointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    e.preventDefault();
    if (!handlePos) return;
    draggingRef.current = {
      startX: e.clientX,
      startRadius: handlePos.radius,
      shapeId: handlePos.id,
      maxRadius: handlePos.maxRadius,
    };
    setLiveRadius(handlePos.radius);
    setLivePos({ x: e.clientX, y: e.clientY });

    function onMove(ev: PointerEvent) {
      if (!draggingRef.current) return;
      ev.stopPropagation();
      const { startX, startRadius, shapeId, maxRadius } = draggingRef.current;
      const zoom = editor.getZoomLevel();
      const dx = ev.clientX - startX;
      const newRadius = Math.max(0, Math.min(maxRadius, Math.round(startRadius + dx / zoom)));
      setLiveRadius(newRadius);
      setLivePos({ x: ev.clientX, y: ev.clientY });
      const shape = editor.getShape(shapeId);
      if (!shape) return;
      const existingMeta = (shape.meta ?? {}) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShape({ id: shapeId, type: shape.type, meta: { ...existingMeta, cornerRadius: newRadius } } as any);
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      draggingRef.current = null;
      setLiveRadius(null);
      setLivePos(null);
    }

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  if (!handlePos) return null;
  const displayRadius = liveRadius ?? handlePos.radius;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 489 }}>
      <div
        className="canvas-cr-handle"
        style={{
          position: 'absolute',
          left: handlePos.x,
          top: handlePos.y,
          transform: 'translate(-50%,-50%)',
          pointerEvents: 'auto',
        }}
        onPointerDown={onPointerDown}
        title={`Corner radius: ${displayRadius}px — drag right to round, left to sharpen`}
      />
      {livePos && (
        <div
          className="canvas-cr-label"
          style={{ position: 'fixed', left: livePos.x + 14, top: livePos.y - 22, pointerEvents: 'none' }}
        >
          {displayRadius}px
        </div>
      )}
    </div>
  );
}

// ── Modifier-key shortcut hints ────────────────────────────────────────────────
function CanvasShortcutHints() {
  const editor = useEditor();
  const show = useValue('showHints', () => {
    const ids = editor.getSelectedShapeIds();
    return ids.length > 0 && ids.some((id) => editor.getShape(id)?.type !== 'frame');
  }, [editor]);

  if (!show) return null;
  return (
    <div className="canvas-shortcut-hints" onPointerDown={(e) => e.stopPropagation()}>
      <span>Shift <em>lock ratio</em></span>
      <span className="canvas-shortcut-hints-sep">&middot;</span>
      <span>Alt <em>from center</em></span>
      <span className="canvas-shortcut-hints-sep">&middot;</span>
      <span>&#8984; <em>snap</em></span>
    </div>
  );
}

// ── Zoom indicator ─────────────────────────────────────────────────────────────
function ZoomIndicator() {
  const editor = useEditor();
  const zoom = useValue('zoom', () => Math.round(editor.getZoomLevel() * 100), [editor]);
  const anim = { animation: { duration: 200 } } as const;
  return (
    <div className="canvas-zoom-indicator" onPointerDown={(e) => e.stopPropagation()}>
      <button className="canvas-zoom-btn" onClick={() => editor.zoomOut(undefined, anim)} title="Zoom out">−</button>
      <button
        className="canvas-zoom-pct"
        onClick={() => editor.resetZoom(editor.getViewportScreenCenter(), anim)}
        onDoubleClick={() => editor.zoomToFit(anim)}
        title="Click: reset to 100% · double-click: fit all"
      >{zoom}%</button>
      <button className="canvas-zoom-btn" onClick={() => editor.zoomIn(undefined, anim)} title="Zoom in">+</button>
    </div>
  );
}

// ── Shape effects CSS injector ─────────────────────────────────────────────────
// Generates a <style> tag in document.head with box-shadow + border-radius rules
// for each shape that has meta.cornerRadius or meta.shadow set.
function ShapeEffectsStyle() {
  const editor = useEditor();

  const cssText = useValue('shapeEffectsCSS', () => {
    const shapes = editor.getCurrentPageShapes();
    const rules: string[] = [];
    for (const shape of shapes) {
      const meta = (shape.meta ?? {}) as Record<string, unknown>;
      const cr = meta.cornerRadius as number | undefined;
      const sh = meta.shadow as ShadowMeta | null | undefined;
      if (!cr && !sh) continue;
      let css = '';
      if (cr) css += `border-radius:${cr}px;overflow:hidden;`;
      if (sh) css += `box-shadow:${sh.x ?? 0}px ${sh.y ?? 0}px ${sh.blur ?? 0}px 0px ${hexToRgba(sh.color ?? '#000000', sh.opacity ?? 0.3)};`;
      rules.push(`[data-shape-id="${shape.id}"] { ${css} }`);
    }
    return rules.join('\n');
  }, [editor]);

  useEffect(() => {
    const STYLE_ID = 'tl-shape-effects-style';
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = cssText;
  }, [cssText]);

  useEffect(() => {
    return () => { document.getElementById('tl-shape-effects-style')?.remove(); };
  }, []);

  return null;
}

// ── Overlay error boundary ─────────────────────────────────────────────────────
// React error boundary for all overlay components. Any crash inside an overlay
// (CornerRadiusHandle, CanvasFormatPanel, ArrowHandles, etc.) is caught here so
// it never reaches tldraw's own error boundary, which would nuke the whole canvas.
class OverlayErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error('[CanvasOverlays] Overlay crash caught by error boundary:', error, info?.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) return null; // silently hide broken overlays
    return this.props.children;
  }
}

// ── Root overlay container ─────────────────────────────────────────────────────
// Mounted via tldraw's components={{ InFrontOfTheCanvas: CanvasOverlays }}
export function CanvasOverlays() {
  return (
    <OverlayErrorBoundary>
      <CanvasFormatPanel />
      <ArrowHandles />
      <ArrowAutoConnectHandler />
      <CanvasAIMarkOverlay />
      <LockedShapesOverlay />
      <ShapeEffectsStyle />
      <CornerRadiusHandle />
      <ZoomIndicator />
      <CanvasShortcutHints />
    </OverlayErrorBoundary>
  );
}
