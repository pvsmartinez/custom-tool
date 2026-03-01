/**
 * CanvasImageDialog — modal dialog for adding an image to the canvas.
 * Supports two tabs: URL input and workspace image picker.
 */
import { convertFileSrc } from '@tauri-apps/api/core';

interface CanvasImageDialogProps {
  workspacePath: string;
  imgUrlInput: string;
  setImgUrlInput: (v: string) => void;
  imgTab: 'url' | 'workspace';
  setImgTab: (v: 'url' | 'workspace') => void;
  wsImages: string[];
  wsImagesLoading: boolean;
  onClose: () => void;
  onAddFromUrl: (url: string) => void;
  onPickWorkspaceImage: (relPath: string) => void;
  onLoadWsImages: () => void;
}

export function CanvasImageDialog({
  workspacePath,
  imgUrlInput, setImgUrlInput,
  imgTab, setImgTab,
  wsImages, wsImagesLoading,
  onClose, onAddFromUrl, onPickWorkspaceImage, onLoadWsImages,
}: CanvasImageDialogProps) {
  return (
    <div
      className="canvas-img-dialog"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="canvas-img-dialog-box">
        <div className="canvas-img-dialog-header">
          <div className="canvas-img-dialog-title">Add image</div>
          <div className="canvas-img-dialog-tabs">
            <button
              className={`canvas-img-tab${imgTab === 'url' ? ' canvas-img-tab--active' : ''}`}
              onClick={() => setImgTab('url')}
            >URL</button>
            <button
              className={`canvas-img-tab${imgTab === 'workspace' ? ' canvas-img-tab--active' : ''}`}
              onClick={() => { setImgTab('workspace'); if (wsImages.length === 0) onLoadWsImages(); }}
            >Workspace</button>
          </div>
        </div>

        {imgTab === 'url' ? (
          <>
            <input
              className="canvas-img-dialog-input"
              type="url"
              placeholder="https://example.com/image.png"
              value={imgUrlInput}
              onChange={(e) => setImgUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onAddFromUrl(imgUrlInput); onClose(); }
                else if (e.key === 'Escape') onClose();
              }}
              autoFocus
            />
            <div className="canvas-img-dialog-actions">
              <button className="canvas-img-dialog-cancel" onClick={onClose}>Cancel</button>
              <button
                className="canvas-img-dialog-add"
                disabled={!imgUrlInput.trim()}
                onClick={() => { onAddFromUrl(imgUrlInput); onClose(); }}
              >Add</button>
            </div>
          </>
        ) : (
          <>
            <div className="canvas-img-ws-grid">
              {wsImagesLoading ? (
                <div className="canvas-img-ws-loading">Loading…</div>
              ) : wsImages.length === 0 ? (
                <div className="canvas-img-ws-empty">No images found in workspace</div>
              ) : (
                wsImages.map((relPath) => (
                  <button
                    key={relPath}
                    className="canvas-img-ws-thumb"
                    title={relPath}
                    onClick={() => { onPickWorkspaceImage(relPath); onClose(); }}
                  >
                    <img
                      src={convertFileSrc(`${workspacePath}/${relPath}`)}
                      alt={relPath.split('/').pop()}
                      className="canvas-img-ws-thumb-img"
                      loading="lazy"
                    />
                    <span className="canvas-img-ws-thumb-name">{relPath.split('/').pop()}</span>
                  </button>
                ))
              )}
            </div>
            <div className="canvas-img-dialog-actions">
              <button className="canvas-img-dialog-cancel" onClick={onClose}>Cancel</button>
              <button className="canvas-img-dialog-cancel" onClick={onLoadWsImages} style={{ marginRight: 'auto' }}>↺ Refresh</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
