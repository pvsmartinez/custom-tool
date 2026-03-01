/**
 * useCanvasLockUI — shape context-menu, long-press unlock pill, and lock-flash.
 *
 * Owns: shapeCtxMenu, lockPill, lockFlash
 * Side-effects: capture-phase contextmenu + pointerdown/move/up on mainDivRef
 */
import { useState, useRef, useEffect } from 'react';
import type { Editor, TLShape, TLShapeId } from 'tldraw';

interface UseCanvasLockUIOptions {
  editorRef: React.MutableRefObject<Editor | null>;
  mainDivRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function useCanvasLockUI({ editorRef, mainDivRef }: UseCanvasLockUIOptions) {
  const [shapeCtxMenu, setShapeCtxMenu] = useState<{
    x: number; y: number; shapeId: TLShapeId; isLocked: boolean;
  } | null>(null);
  const [lockPill, setLockPill] = useState<{ x: number; y: number; shapeId: TLShapeId } | null>(null);
  const [lockFlash, setLockFlash] = useState<{ x: number; y: number } | null>(null);
  const lockFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Capture-phase contextmenu: only for unlocked shapes (Lock + Delete) ──────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;
    function onContextMenu(e: MouseEvent) {
      const editor = editorRef.current;
      if (!editor) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('.canvas-strip') ||
        target.closest('.canvas-strip-scroll') ||
        target.closest('.canvas-theme-body')
      ) return;
      const rect = el!.getBoundingClientRect();
      const pagePoint = editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      const shapes = editor.getCurrentPageShapes();
      let hit: TLShape | null = null;
      for (const shape of shapes) {
        if (shape.type === 'frame') continue;
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) continue;
        if (
          pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
          pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h
        ) { hit = shape; }
      }
      if (!hit) return;
      // Always suppress browser context menu on canvas shapes.
      e.preventDefault();
      e.stopPropagation();
      // Locked shapes: suppress only — unlock is handled via long-press.
      if (hit.isLocked) return;
      const MENU_W = 180;
      const cx = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
      const cy = Math.min(e.clientY, window.innerHeight - 140  - 6);
      setShapeCtxMenu({ x: cx, y: cy, shapeId: hit.id as TLShapeId, isLocked: false });
    }
    el.addEventListener('contextmenu', onContextMenu, true);
    return () => el.removeEventListener('contextmenu', onContextMenu, true);
  }, []); // refs are stable

  // ── Long-press on a locked shape → show Unlock pill ──────────────────────────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;
    let startX = 0, startY = 0;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);

      // Immediately show a brief lock-flash if press lands on a locked non-bg shape.
      const editorNow = editorRef.current;
      const elNow = mainDivRef.current;
      if (editorNow && elNow) {
        const rectNow = elNow.getBoundingClientRect();
        const ppNow = editorNow.screenToPage({ x: startX - rectNow.left, y: startY - rectNow.top });
        for (const shape of editorNow.getCurrentPageShapes()) {
          if (shape.type === 'frame' || !shape.isLocked || (shape.meta as Record<string, unknown>)?.isThemeBg) continue;
          const bounds = editorNow.getShapePageBounds(shape.id);
          if (!bounds) continue;
          if (
            ppNow.x >= bounds.x && ppNow.x <= bounds.x + bounds.w &&
            ppNow.y >= bounds.y && ppNow.y <= bounds.y + bounds.h
          ) {
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
        let hit: TLShape | null = null;
        for (const shape of editor.getCurrentPageShapes()) {
          if (shape.type === 'frame' || !shape.isLocked || (shape.meta as Record<string, unknown>)?.isThemeBg) continue;
          const bounds = editor.getShapePageBounds(shape.id);
          if (!bounds) continue;
          if (
            pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
            pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h
          ) { hit = shape; }
        }
        if (!hit) return;
        if (lockFlashTimerRef.current) clearTimeout(lockFlashTimerRef.current);
        setLockFlash(null);
        const PILL_W = 120, PILL_H = 36;
        const px = Math.min(Math.max(startX - PILL_W / 2, 6), window.innerWidth  - PILL_W - 6);
        const py = Math.max(startY - PILL_H - 12, 6);
        setLockPill({ x: px, y: py, shapeId: hit.id as TLShapeId });
      }, 500);
    }

    function cancel() {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }

    function onPointerMove(e: PointerEvent) {
      if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancel();
    }

    el.addEventListener('pointerdown',   onPointerDown);
    el.addEventListener('pointermove',   onPointerMove);
    el.addEventListener('pointerup',     cancel);
    el.addEventListener('pointercancel', cancel);
    return () => {
      cancel();
      el.removeEventListener('pointerdown',   onPointerDown);
      el.removeEventListener('pointermove',   onPointerMove);
      el.removeEventListener('pointerup',     cancel);
      el.removeEventListener('pointercancel', cancel);
    };
  }, []); // refs are stable

  return {
    shapeCtxMenu, setShapeCtxMenu,
    lockPill,     setLockPill,
    lockFlash,
  };
}
