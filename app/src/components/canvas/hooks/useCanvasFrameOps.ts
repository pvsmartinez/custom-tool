/**
 * useCanvasFrameOps — frame/slide CRUD and navigation operations.
 *
 * Owns: frames[], frameIndex, frameToolActive
 * Provides: zoomToFrame, addSlide, rescanFrames, forceSave, exportFrame,
 *           reorderFrames, duplicateFrame, moveFrameDir, insertTextPreset
 */
import { useRef, useState, useCallback } from 'react';
import type { Editor, TLShape, TLShapeId } from 'tldraw';
import { exportAs, createShapeId, toRichText } from 'tldraw';
import type { CanvasTheme, AnyFrame } from '../canvasTypes';
import { SLIDE_W, SLIDE_H, SLIDE_GAP } from '../canvasConstants';
import {
  loadThemeFromDoc, applyThemeToSlides, applyTextPreset,
  applySlideLayout,
} from '../canvasTheme';
import { sanitizeSnapshot } from '../../../utils/canvasAI';

interface UseCanvasFrameOpsOptions {
  editorRef: React.MutableRefObject<Editor | null>;
  /** Current active theme — needed by addSlide and insertTextPreset. */
  theme: CanvasTheme;
  saveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  onChangeRef: React.MutableRefObject<(json: string) => void>;
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  forceSaveRef?: React.MutableRefObject<(() => void) | null>;
}

export function useCanvasFrameOps({
  editorRef,
  theme,
  saveTimerRef,
  onChangeRef,
  rescanFramesRef,
  forceSaveRef,
}: UseCanvasFrameOpsOptions) {
  const [frames, setFrames] = useState<TLShape[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [frameToolActive, setFrameToolActive] = useState(false);
  const lastFrameCountRef = useRef<number>(0);

  // Stable callback — never changes identity so mount listeners can reference it safely.
  const zoomToFrame = useCallback((editor: Editor, frame: TLShape) => {
    const bounds = editor.getShapePageBounds(frame.id);
    if (bounds) editor.zoomToBounds(bounds, { animation: { duration: 350 }, inset: 40 });
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
    setTimeout(() => {
      const updated = editor.getCurrentPageShapesSorted()
        .filter((s) => s.type === 'frame')
        .sort((a, b) => (a as AnyFrame).x - (b as AnyFrame).x);
      lastFrameCountRef.current = updated.length;
      setFrames(updated);
      const newFrame = updated[updated.length - 1];
      if (newFrame) {
        zoomToFrame(editor, newFrame);
        setFrameIndex(updated.length - 1);
      }
      const currentTheme = loadThemeFromDoc(editor);
      applyThemeToSlides(editor, currentTheme);
      const layoutId = currentTheme.defaultLayout ?? 'title-body';
      if (layoutId !== 'blank' && newFrame) {
        applySlideLayout(editor, newFrame as AnyFrame, layoutId, currentTheme);
      }
    }, 60);
  }

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
  if (rescanFramesRef) rescanFramesRef.current = rescanFrames;

  function forceSave() {
    const editor = editorRef.current;
    if (!editor) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try { onChangeRef.current(JSON.stringify(sanitizeSnapshot(editor.getSnapshot()))); }
    catch (err) { console.warn('[CanvasEditor] forceSave serialization failed:', err); }
  }
  if (forceSaveRef) forceSaveRef.current = forceSave;

  async function exportFrame(frame: TLShape, idx: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const name = (frame as AnyFrame).props?.name || `Slide ${idx + 1}`;
    await exportAs(editor, [frame.id as TLShapeId], { format: 'png', name });
  }

  function insertTextPreset(variant: 'heading' | 'body') {
    const editor = editorRef.current;
    if (!editor) return;
    applyTextPreset(editor, variant, theme);
    const targetFrame = frames[frameIndex] as AnyFrame | undefined;
    if (!targetFrame) return;
    const s = variant === 'heading' ? theme.heading : theme.body;
    const PAD = 60;
    const yOff = variant === 'heading' ? PAD : PAD + 140;
    const textId = createShapeId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.createShape({
      id: textId,
      type: 'text',
      parentId: targetFrame.id as TLShapeId,
      x: PAD,
      y: yOff,
      meta: { textRole: variant },
      props: {
        richText: toRichText(variant === 'heading' ? 'Heading' : 'Body text'),
        color: s.color,
        size: s.size,
        font: s.font,
        textAlign: s.align,
        autoSize: true,
      },
    } as never);
    editor.setSelectedShapes([textId]);
    editor.setEditingShape(textId as TLShapeId);
    zoomToFrame(editor, targetFrame);
  }

  function reorderFrames(fromIdx: number, toIdx: number) {
    const editor = editorRef.current;
    if (!editor || fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= frames.length || toIdx >= frames.length) return;
    const newOrder = [...frames];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    const xPositions = frames.map((f) => (f as AnyFrame).x).sort((a, b) => a - b);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newOrder.forEach((frame, i) => editor.updateShape({ id: frame.id, type: 'frame', x: xPositions[i] } as any));
    setFrames(newOrder);
    setFrameIndex(toIdx);
  }

  function duplicateFrame(idx: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const frame = frames[idx] as AnyFrame;
    editor.duplicateShapes([frame.id as TLShapeId], { x: frame.props.w + SLIDE_GAP, y: 0 });
  }

  function moveFrameDir(idx: number, dir: -1 | 1) {
    reorderFrames(idx, idx + dir);
  }

  return {
    frames, setFrames,
    frameIndex, setFrameIndex,
    frameToolActive, setFrameToolActive,
    lastFrameCountRef,
    zoomToFrame,
    addSlide,
    rescanFrames,
    forceSave,
    exportFrame,
    insertTextPreset,
    reorderFrames,
    duplicateFrame,
    moveFrameDir,
  };
}
