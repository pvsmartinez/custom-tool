/**
 * AIMarkOverlay — hover-only ✓ buttons anchored to each AI-marked region.
 *
 * Each mark gets one small checkmark button at the right edge of its highlight.
 * The button is invisible by default and only appears on hover so it never
 * obscures the marked text.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { AIEditMark } from '../types';
import type { EditorHandle } from './Editor';
import './AIMarkOverlay.css';

interface AIMarkOverlayProps {
  visible: boolean;
  marks: AIEditMark[];
  editorRef: React.RefObject<EditorHandle | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onReview: (id: string) => void;
}

interface MarkPos {
  btnTop: number;
  btnLeft: number;
  hoverTop: number;
  hoverBottom: number;
  hoverLeft: number;
  markId: string;
}

export default function AIMarkOverlay({
  visible,
  marks,
  editorRef,
  containerRef,
  onReview,
}: AIMarkOverlayProps) {
  const [positions, setPositions] = useState<MarkPos[]>([]);
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null);
  const positionsRef = useRef<MarkPos[]>([]);
  const rafRef = useRef<number>(0);

  const recalculate = useCallback(() => {
    if (!visible || marks.length === 0) {
      setPositions([]);
      positionsRef.current = [];
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    const next: MarkPos[] = [];
    for (const mark of marks) {
      const coords = editorRef.current?.getMarkCoords(mark.text);
      if (!coords) continue;
      next.push({
        btnTop: coords.top - containerRect.top,
        btnLeft: coords.right - containerRect.left,
        hoverTop: coords.top - containerRect.top - 3,
        hoverBottom: coords.bottom - containerRect.top + 3,
        hoverLeft: coords.left - containerRect.left - 6,
        markId: mark.id,
      });
    }
    setPositions(next);
    positionsRef.current = next;
  }, [visible, marks, editorRef, containerRef]);

  // RAF loop — keeps button positions in sync with scroll/resize
  useEffect(() => {
    if (!visible) {
      setPositions([]);
      positionsRef.current = [];
      return;
    }
    let active = true;
    function loop() {
      if (!active) return;
      recalculate();
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [visible, recalculate]);

  // Mouse tracking — reveal the button for whichever mark the cursor is over
  useEffect(() => {
    if (!visible) { setHoveredMarkId(null); return; }
    const container = containerRef.current;
    if (!container) return;

    function onMouseMove(e: MouseEvent) {
      const rect = (containerRef.current as HTMLDivElement | null)?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      for (const p of positionsRef.current) {
        // Cover from mark start to ~500px right (generous width for any line length)
        if (
          mx >= p.hoverLeft &&
          mx <= p.hoverLeft + 500 &&
          my >= p.hoverTop &&
          my <= p.hoverBottom
        ) {
          setHoveredMarkId(p.markId);
          return;
        }
      }
      setHoveredMarkId(null);
    }

    container.addEventListener('mousemove', onMouseMove);
    return () => container.removeEventListener('mousemove', onMouseMove);
  }, [visible, containerRef]);

  if (!visible || marks.length === 0) return null;

  return (
    <div className="aimo-layer" aria-hidden="true">
      {positions.map(({ btnTop, btnLeft, markId }) => (
        <button
          key={markId}
          className={`aimo-accept-btn${hoveredMarkId === markId ? ' aimo-accept-btn--visible' : ''}`}
          style={{ top: btnTop, left: btnLeft }}
          title="Accept AI edit"
          onClick={(e) => { e.stopPropagation(); onReview(markId); }}
        >✓</button>
      ))}
    </div>
  );
}