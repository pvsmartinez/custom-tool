/**
 * CanvasPresentOverlay — PNG slide stage + navigation bar shown while presenting.
 */
import type { TLShape } from 'tldraw';

interface CanvasPresentOverlayProps {
  frameIndex: number;
  frames: TLShape[];
  previewUrls: string[];
  previewGenState: 'idle' | 'generating';
  onExit: () => void;
  onGoToFrame: (idx: number) => void;
}

export function CanvasPresentOverlay({
  frameIndex, frames, previewUrls, previewGenState, onExit, onGoToFrame,
}: CanvasPresentOverlayProps) {
  return (
    <>
      {/* Fullscreen PNG slide backdrop */}
      <div className="canvas-present-stage">
        {previewUrls.length > 0 && previewUrls[frameIndex] ? (
          <img
            className="canvas-present-slide"
            src={previewUrls[frameIndex]}
            alt={`Slide ${frameIndex + 1}`}
            draggable={false}
          />
        ) : previewGenState === 'generating' ? (
          <div className="canvas-present-generating">Generating preview…</div>
        ) : null}
      </div>

      {/* Bottom navigation bar */}
      <div className="canvas-present-overlay">
        <button className="canvas-present-exit" onClick={onExit} title="Exit (Esc)">
          ✕ Exit
        </button>
        {frames.length > 0 ? (
          <div className="canvas-present-nav">
            <button
              className="canvas-present-nav-btn"
              disabled={frameIndex === 0}
              onClick={() => onGoToFrame(frameIndex - 1)}
              title="Previous (←)"
            >←</button>
            <span className="canvas-present-counter">
              {frameIndex + 1} <span>/</span> {frames.length}
            </span>
            <button
              className="canvas-present-nav-btn"
              disabled={frameIndex === frames.length - 1}
              onClick={() => onGoToFrame(frameIndex + 1)}
              title="Next (→)"
            >→</button>
          </div>
        ) : (
          <div className="canvas-present-hint">
            No frames — press <kbd>F</kbd> and draw one
          </div>
        )}
      </div>
    </>
  );
}
