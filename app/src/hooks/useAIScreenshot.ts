import { useState, useCallback } from 'react';
import { canvasToDataUrl, compressDataUrl } from '../utils/canvasAI';
import { toPng } from 'html-to-image';
import type { Editor as TldrawEditor } from 'tldraw';

interface UseAIScreenshotParams {
  canvasEditorRef?: React.RefObject<TldrawEditor | null>;
  screenshotTargetRef?: React.RefObject<HTMLElement | null>;
  webPreviewRef?: React.RefObject<{ getScreenshot: () => Promise<string | null> } | null>;
  input: string;
  isStreaming: boolean;
  /** Called when screenshot is ready. If input is empty, screen is sent immediately. */
  onReady: (dataUrl: string) => Promise<void>;
  onStage: (dataUrl: string) => void;
}

/**
 * Captures a screenshot of the active content area (canvas, HTML preview, or editor)
 * and either sends it immediately (when input is empty) or stages it as a pending image.
 */
export function useAIScreenshot({
  canvasEditorRef,
  screenshotTargetRef,
  webPreviewRef,
  input,
  isStreaming,
  onReady,
  onStage,
}: UseAIScreenshotParams) {
  const [isCapturing, setIsCapturing] = useState(false);

  const handleTakeScreenshot = useCallback(async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    try {
      let dataUrl: string | null = null;

      if (canvasEditorRef?.current) {
        // Canvas file — use tldraw's high-quality export
        dataUrl = await canvasToDataUrl(canvasEditorRef.current, 0.85);
      } else if (webPreviewRef?.current) {
        // HTML preview — the editor-area contains an <iframe> which html-to-image
        // cannot read (always produces a black rect). Use the WebPreview's own
        // getScreenshot() which reads the iframe's contentDocument directly.
        dataUrl = await webPreviewRef.current.getScreenshot();
      } else if (screenshotTargetRef?.current) {
        // Text editor / other views — capture the editor-area DOM element.
        // Use backgroundColor so Tauri's WebKit doesn't composite over black.
        const bg = getComputedStyle(screenshotTargetRef.current).backgroundColor;
        const resolvedBg = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#1a1a1a';
        dataUrl = await toPng(screenshotTargetRef.current, {
          quality: 0.9,
          backgroundColor: resolvedBg,
          // pixelRatio: 1 avoids a WebKit/Retina bug where scaled canvases
          // are cleared to black before html-to-image can read them.
          pixelRatio: 1,
          filter: (node) => {
            if (node instanceof HTMLElement) {
              if (node.classList.contains('copilot-lock-overlay')) return false;
              if (node.classList.contains('find-replace-bar')) return false;
            }
            return true;
          },
        });
      }

      if (dataUrl) {
        const compressed = await compressDataUrl(dataUrl, 512, 0.65);
        if (!input.trim() && !isStreaming) {
          // One-click: capture + send immediately — no intermediate pending state
          await onReady(compressed);
        } else {
          // User has text in progress — stage so it goes with their message
          onStage(compressed);
        }
      }
    } catch (err) {
      console.error('[screenshot]', err);
    } finally {
      setIsCapturing(false);
    }
  }, [canvasEditorRef, screenshotTargetRef, webPreviewRef, input, isStreaming, onReady, onStage, isCapturing]);

  return { isCapturing, handleTakeScreenshot };
}
