/**
 * CanvasSlideStrip — bottom slide strip with cards, add button, and slide actions.
 *
 * Manages its own drag-to-reorder and context-menu state internally so the
 * parent (CanvasEditor) doesn't need to know about those details.
 */
import { useState, useRef } from 'react';
import type { Editor, TLShape, TLShapeId } from 'tldraw';
import { createPortal } from 'react-dom';
import type { AnyFrame } from './canvasTypes';

interface CanvasSlideStripProps {
  frames: TLShape[];
  frameIndex: number;
  editorRef: React.MutableRefObject<Editor | null>;
  // Navigation
  onGoToFrame: (i: number) => void;
  onEnterPresent: (i: number) => void;
  // Slide operations
  onAddSlide: () => void;
  onRescanFrames: () => void;
  onExportFrame: (frame: TLShape, idx: number) => void;
  onMoveFrameDir: (idx: number, dir: -1 | 1) => void;
  onDuplicateFrame: (idx: number) => void;
  onReorderFrames: (from: number, to: number) => void;
  onFitSlide: () => void;
}

export function CanvasSlideStrip({
  frames, frameIndex, editorRef,
  onGoToFrame, onEnterPresent,
  onAddSlide, onRescanFrames, onExportFrame, onMoveFrameDir,
  onDuplicateFrame, onReorderFrames, onFitSlide,
}: CanvasSlideStripProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; frameIdx: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll active card into view when frameIndex changes.
  // (parent scrolls via stripScrollRef already; this is the internal ref)
  const activeCardRef = (node: HTMLButtonElement | null) => {
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  };

  return (
    <>
      {/* Single header row: strip toggle | slide cards | theme toggle lives
          outside this component — we only render the toggle + strip section */}
      <button
        className="canvas-strip-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand slides' : 'Collapse slides'}
      >
        {collapsed ? '▶' : '◀'}&nbsp;Slides
        {frames.length > 0 && (
          <span className="canvas-strip-count">{frames.length}</span>
        )}
      </button>

      <button
        className="canvas-strip-rescan"
        onClick={onRescanFrames}
        title="Re-scan canvas for slide frames"
      >↺</button>

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

      {frames.length > 0 && (
        <button
          className="canvas-strip-rescan"
          onClick={onFitSlide}
          title="Zoom to fit current slide"
        >⊡ Fit</button>
      )}

      {!collapsed && (
        <div className="canvas-strip-scroll" ref={scrollRef}>
          {frames.length === 0 && (
            <div className="canvas-strip-empty">
              Press <kbd>F</kbd> or click&nbsp;<strong>+ Slide</strong>
            </div>
          )}
          {frames.map((frame, i) => {
            const name = (frame as AnyFrame).props?.name;
            const isActive = i === frameIndex;
            const isDragTarget = dragOverIdx === i && dragIdx !== null && dragIdx !== i;
            return (
              <button
                key={frame.id}
                data-strip-index={i}
                ref={isActive ? activeCardRef : null}
                draggable
                className={[
                  'canvas-strip-card',
                  isActive ? 'canvas-strip-card--active' : '',
                  dragIdx === i ? 'canvas-strip-card--dragging' : '',
                  isDragTarget ? 'canvas-strip-card--drag-over' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onGoToFrame(i)}
                onDoubleClick={() => onEnterPresent(i)}
                title={`${name || `Slide ${i + 1}`} — click to zoom, double-click to present`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const MENU_W = 190, MENU_H = 240;
                  const cx = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
                  const cy = Math.min(e.clientY, window.innerHeight - MENU_H - 6);
                  setCtxMenu({ x: cx, y: cy, frameIdx: i });
                }}
                onDragStart={(e) => {
                  e.stopPropagation(); // prevent Tauri native drag-drop
                  e.dataTransfer.effectAllowed = 'move';
                  setDragIdx(i);
                }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIdx(i); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null) onReorderFrames(dragIdx, i);
                  setDragIdx(null);
                  setDragOverIdx(null);
                }}
                onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
              >
                <span className="canvas-strip-num">{i + 1}</span>
                <span className="canvas-strip-name">{name || `Slide ${i + 1}`}</span>
                <span
                  className="canvas-strip-delete"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    editorRef.current?.deleteShapes([frame.id as TLShapeId]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Delete') {
                      e.stopPropagation();
                      editorRef.current?.deleteShapes([frame.id as TLShapeId]);
                    }
                  }}
                  title="Delete slide"
                >✕</span>
              </button>
            );
          })}
          <button
            className="canvas-strip-add"
            onClick={onAddSlide}
            title="New 16:9 slide"
          >
            + Slide
          </button>
        </div>
      )}

      {/* Slide context menu portal */}
      {ctxMenu && (() => {
        const { x, y, frameIdx } = ctxMenu;
        const frame = frames[frameIdx];
        const total = frames.length;
        const dismiss = () => setCtxMenu(null);
        return createPortal(
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={dismiss} />
            <div
              className="canvas-ctx-menu"
              style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button className="canvas-ctx-item" onClick={() => { onExportFrame(frame, frameIdx); dismiss(); }}>
                <span className="canvas-ctx-icon">↓</span> Export PNG
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item" disabled={frameIdx === 0} onClick={() => { onMoveFrameDir(frameIdx, -1); dismiss(); }}>
                <span className="canvas-ctx-icon">←</span> Move Left
              </button>
              <button className="canvas-ctx-item" disabled={frameIdx === total - 1} onClick={() => { onMoveFrameDir(frameIdx, 1); dismiss(); }}>
                <span className="canvas-ctx-icon">→</span> Move Right
              </button>
              <div className="canvas-ctx-sep" />
              <button className="canvas-ctx-item" onClick={() => { onDuplicateFrame(frameIdx); dismiss(); }}>
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
    </>
  );
}
