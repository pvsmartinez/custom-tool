import { useRef, useState } from 'react';
import type { Editor as TldrawEditor } from 'tldraw';

export interface UseCanvasStateReturn {
  /** Live tldraw Editor instance when a canvas file is open. */
  canvasEditorRef: React.MutableRefObject<TldrawEditor | null>;
  /** Imperative flush so Cmd+S always saves the latest snapshot
   *  within the canvas's debounce window. */
  forceSaveRef: React.MutableRefObject<(() => void) | null>;
  /** Lets CanvasEditor expose rescanFrames() so AIPanel can force-sync
   *  the slide strip immediately after canvas_op. */
  rescanFramesRef: React.MutableRefObject<(() => void) | null>;
  /** Incremented each time the user recovers from a canvas error — forces remount. */
  canvasResetKey: number;
  setCanvasResetKey: React.Dispatch<React.SetStateAction<number>>;
  /** Number of tldraw frames (slides) in the active canvas. */
  canvasSlideCount: number;
  setCanvasSlideCount: React.Dispatch<React.SetStateAction<number>>;
}

/**
 * Groups the refs and ephemeral state owned by CanvasEditor so App.tsx
 * doesn't scatter them across 5 unrelated declarations.
 */
export function useCanvasState(): UseCanvasStateReturn {
  const canvasEditorRef = useRef<TldrawEditor | null>(null);
  const forceSaveRef = useRef<(() => void) | null>(null);
  const rescanFramesRef = useRef<(() => void) | null>(null);
  const [canvasResetKey, setCanvasResetKey] = useState(0);
  const [canvasSlideCount, setCanvasSlideCount] = useState(0);

  return {
    canvasEditorRef,
    forceSaveRef,
    rescanFramesRef,
    canvasResetKey,
    setCanvasResetKey,
    canvasSlideCount,
    setCanvasSlideCount,
  };
}
