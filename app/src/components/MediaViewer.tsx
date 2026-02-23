import { useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { FileKind } from '../utils/fileType';
import './MediaViewer.css';

interface MediaViewerProps {
  /** Absolute path to the file on disk */
  absPath: string;
  filename: string;
  kind: Extract<FileKind, 'video' | 'image'>;
}

export default function MediaViewer({ absPath, filename, kind }: MediaViewerProps) {
  const src = useMemo(() => convertFileSrc(absPath), [absPath]);
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
          <img
            src={src}
            alt={filename}
            className={`mv-image${zoomed ? ' zoomed' : ''}`}
            draggable={false}
          />
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
        <video
          ref={videoRef}
          src={src}
          className="mv-video"
          controls
          autoPlay={false}
          playsInline
          preload="metadata"
        >
          Your browser does not support this video format.
        </video>
      </div>
    </div>
  );
}
