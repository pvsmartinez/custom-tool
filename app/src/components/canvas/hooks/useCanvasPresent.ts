/**
 * useCanvasPresent — present/slideshow mode.
 *
 * Owns: isPresenting, previewUrls, previewGenState
 * Provides: enterPresent, exitPresent, goToFrame
 * Side-effect: keyboard navigation while presenting (window keydown capture)
 */
import { useState, useEffect } from 'react';
import type { Editor, TLShape } from 'tldraw';
import type { AnyFrame } from '../canvasTypes';
import { generateSlidePreviews, loadSlidePreviews } from '../../../utils/slidePreviews';

interface UseCanvasPresentOptions {
  editorRef: React.MutableRefObject<Editor | null>;
  workspacePath: string;
  canvasRelPath?: string;
  frames: TLShape[];
  zoomToFrame: (editor: Editor, frame: TLShape) => void;
  setFrameIndex: React.Dispatch<React.SetStateAction<number>>;
  presentModeProp?: boolean;
  onPresentModeChange?: (presenting: boolean) => void;
}

export function useCanvasPresent({
  editorRef,
  workspacePath,
  canvasRelPath,
  frames,
  zoomToFrame,
  setFrameIndex,
  presentModeProp,
  onPresentModeChange,
}: UseCanvasPresentOptions) {
  const [isPresenting, setIsPresenting] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [previewGenState, setPreviewGenState] = useState<'idle' | 'generating'>('idle');

  async function enterPresent(startIdx = 0) {
    const editor = editorRef.current;
    if (!editor) return;
    // Resolve sorted frames from live editor in case strip is stale.
    const sorted = editor.getCurrentPageShapesSorted()
      .filter((s) => s.type === 'frame')
      .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
    setFrameIndex(startIdx);
    setIsPresenting(true);
    // Deselect + switch to hand tool → canvas is view-only while presenting.
    editor.setSelectedShapes([]);
    editor.setCurrentTool('hand');
    if (sorted.length > 0) zoomToFrame(editor, sorted[startIdx]);
    else editor.zoomToFit({ animation: { duration: 350 } });

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
    editorRef.current?.setCurrentTool('select');
    setIsPresenting(false);
    onPresentModeChange?.(false);
  }

  function goToFrame(idx: number) {
    const editor = editorRef.current;
    if (!editor || frames.length === 0) return;
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    setFrameIndex(clamped);
    zoomToFrame(editor, frames[clamped]);
  }

  // Sync controlled presentMode prop → internal state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (presentModeProp === undefined) return;
    if (presentModeProp && !isPresenting) enterPresent(0);
    else if (!presentModeProp && isPresenting) exitPresent();
  // Re-run only when the prop changes, not when isPresenting changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentModeProp]);

  // Keyboard navigation while presenting.
  useEffect(() => {
    if (!isPresenting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { exitPresent(); return; }
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
      // Swallow every other key in capture phase so tldraw shortcuts can't fire.
      e.stopPropagation();
    }
    // capture: true → fires before tldraw bubble-phase listeners.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isPresenting, frames, zoomToFrame]);

  return {
    isPresenting,
    previewUrls, setPreviewUrls,
    previewGenState, setPreviewGenState,
    enterPresent,
    exitPresent,
    goToFrame,
  };
}
