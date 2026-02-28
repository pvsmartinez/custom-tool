import { useEffect, useRef, useState } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import type { FileKind } from '../utils/fileType';
import { getMimeType } from '../utils/mime';
import './MediaViewer.css';

interface MediaViewerProps {
  /** Absolute path to the file on disk */
  absPath: string;
  filename: string;
  kind: Extract<FileKind, 'video' | 'audio' | 'image'>;
  /** Called once metadata is known — e.g. "1920×1080", "3:42" */
  onStat?: (stat: string) => void;
}

/** Read a binary file via the fs plugin and return a blob: URL.
 *  Returns '' while loading, '__error__' on failure. */
function useBlobUrl(absPath: string, mimeType: string): string {
  const [url, setUrl] = useState('');
  const prevUrl = useRef('');

  useEffect(() => {
    let cancelled = false;
    setUrl('');
    readFile(absPath)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        prevUrl.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[MediaViewer] Failed to load file:', err);
          setUrl('__error__');
        }
      });
    return () => {
      cancelled = true;
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
    };
  // absPath changing means a different file — re-read
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath]);

  return url;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MediaViewer({ absPath, filename, kind, onStat }: MediaViewerProps) {
  const mime = getMimeType(filename);
  const src = useBlobUrl(absPath, mime);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [zoomed, setZoomed] = useState(false);

  if (kind === 'image') {
    const isGif = filename.toLowerCase().endsWith('.gif');
    return (
      <div className="mv-root">
        <div className="mv-toolbar">
          <span className="mv-filename">{filename}</span>
          {isGif && <span className="mv-badge">GIF</span>}
          <button
            className={`mv-zoom-btn${zoomed ? ' active' : ''}`}
            onClick={() => setZoomed((z) => !z)}
            title={zoomed ? 'Fit to window' : 'Actual size'}
          >
            {zoomed ? '⊡' : '⊞'}
          </button>
        </div>
        <div className={`mv-image-area${zoomed ? ' zoomed' : ''}`}>
          {src === '__error__'
            ? <div className="mv-loading mv-error">Could not load image.</div>
            : !src
            ? <div className="mv-loading">Loading…</div>
            : <img
                src={src}
                alt={filename}
                className={`mv-image${zoomed ? ' zoomed' : ''}`}
                draggable={false}
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  if (w && h) onStat?.(`${w}×${h}`);
                }}
              />
          }
        </div>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="mv-root">
        <div className="mv-toolbar">
          <span className="mv-filename">{filename}</span>
          <span className="mv-badge">audio</span>
        </div>
        <div className="mv-audio-area">
          {src === '__error__'
            ? <div className="mv-loading mv-error">Could not load audio.</div>
            : !src
            ? <div className="mv-loading">Loading…</div>
            : <audio
                src={src}
                className="mv-audio"
                controls
                preload="metadata"
                onLoadedMetadata={(e) => {
                  const t = formatDuration(e.currentTarget.duration);
                  if (t) onStat?.(t);
                }}
              />
          }
        </div>
      </div>
    );
  }

  // Video
  return (
    <div className="mv-root">
      <div className="mv-toolbar">
        <span className="mv-filename">{filename}</span>
        <span className="mv-badge">video</span>
      </div>
      <div className="mv-video-area">
        {src === '__error__'
          ? <div className="mv-loading mv-error">Could not load video.</div>
          : !src
          ? <div className="mv-loading">Loading…</div>
          : <video
              ref={videoRef}
              src={src}
              className="mv-video"
              controls
              autoPlay={false}
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => {
                const t = formatDuration(e.currentTarget.duration);
                if (t) onStat?.(t);
              }}
            >
              Your browser does not support this video format.
            </video>
        }
      </div>
    </div>
  );
}
