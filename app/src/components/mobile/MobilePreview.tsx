import { useState, useEffect } from 'react';
import { readTextFile, readFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getFileTypeInfo } from '../../utils/fileType';
import { loadSlidePreviews } from '../../utils/slidePreviews';
import MarkdownPreview from '../MarkdownPreview';

interface MobilePreviewProps {
  /** Absolute workspace path */
  workspacePath: string;
  /** Relative file path within workspace */
  filePath: string;
  onClear: () => void;
}

// ── Canvas slide viewer ───────────────────────────────────────────────────

function SlideViewer({ workspacePath, filePath }: { workspacePath: string; filePath: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setIdx(0);
    loadSlidePreviews(workspacePath, filePath).then(u => {
      setUrls(u);
      setLoading(false);
    });
  }, [workspacePath, filePath]);

  if (loading) {
    return (
      <div className="mb-slide-viewer">
        <div className="mb-spinner" />
      </div>
    );
  }

  if (urls.length === 0) {
    return (
      <div className="mb-slide-viewer">
        <div className="mb-empty">
          <div className="mb-empty-icon">🎨</div>
          <div className="mb-empty-desc">No slide previews yet. Open this canvas on desktop to generate them.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-slide-viewer">
      <img
        key={urls[idx]}
        src={urls[idx]}
        alt={`Slide ${idx + 1}`}
        className="mb-slide-img"
      />
      <div className="mb-slide-nav">
        <button
          className="mb-slide-btn"
          disabled={idx === 0}
          onClick={() => setIdx(i => i - 1)}
        >‹</button>
        <span className="mb-slide-counter">{idx + 1} / {urls.length}</span>
        <button
          className="mb-slide-btn"
          disabled={idx === urls.length - 1}
          onClick={() => setIdx(i => i + 1)}
        >›</button>
      </div>
    </div>
  );
}

// ── Markdown viewer ──────────────────────────────────────────────────────

function MarkdownViewer({ absPath }: { absPath: string }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    readTextFile(absPath)
      .then(text => { setContent(text); setLoading(false); })
      .catch(() => { setContent('*Error reading file.*'); setLoading(false); });
  }, [absPath]);

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><div className="mb-spinner" /></div>;
  }

  return (
    <div className="mb-md-wrap">
      <MarkdownPreview content={content} />
    </div>
  );
}

// ── Image viewer ─────────────────────────────────────────────────────────

function ImageViewer({ absPath }: { absPath: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // Use asset:// protocol — works with assetProtocol enabled in tauri.conf.json
    setSrc(convertFileSrc(absPath));
  }, [absPath]);

  if (!src) return null;
  return (
    <div className="mb-image-wrap">
      <img src={src} alt="" />
    </div>
  );
}

// ── Video viewer ─────────────────────────────────────────────────────────

function VideoViewer({ absPath }: { absPath: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // Read into Blob to avoid CORS / asset-protocol issues with video seeking
    readFile(absPath).then(bytes => {
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      setSrc(url);
      return () => URL.revokeObjectURL(url);
    }).catch(() => {});
  }, [absPath]);

  if (!src) return <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><div className="mb-spinner" /></div>;
  return (
    <div style={{ padding: 12 }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src={src} controls style={{ width: '100%', borderRadius: 8 }} />
    </div>
  );
}

// ── PDF viewer ───────────────────────────────────────────────────────────

function PDFViewer({ absPath }: { absPath: string }) {
  const src = convertFileSrc(absPath);
  return (
    <embed src={src} type="application/pdf" className="mb-pdf-embed" />
  );
}

// ── Text / code viewer ────────────────────────────────────────────────────

function TextViewer({ absPath }: { absPath: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    readTextFile(absPath)
      .then(t => setText(t))
      .catch(() => setText('(Could not read file)'));
  }, [absPath]);

  if (text === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><div className="mb-spinner" /></div>;
  return <pre className="mb-text-preview">{text}</pre>;
}

// ── Main preview ──────────────────────────────────────────────────────────

export default function MobilePreview({ workspacePath, filePath, onClear }: MobilePreviewProps) {
  const absPath = `${workspacePath}/${filePath}`;
  const filename = filePath.split('/').pop() ?? filePath;
  const { kind } = getFileTypeInfo(filename);

  function renderBody() {
    switch (kind) {
      case 'canvas':
        return <SlideViewer workspacePath={workspacePath} filePath={filePath} />;
      case 'markdown':
        return <MarkdownViewer absPath={absPath} />;
      case 'image':
        return <ImageViewer absPath={absPath} />;
      case 'video':
        return <VideoViewer absPath={absPath} />;
      case 'pdf':
        return <PDFViewer absPath={absPath} />;
      case 'code':
        return <TextViewer absPath={absPath} />;
      default:
        return (
          <div className="mb-empty">
            <div className="mb-empty-icon">📎</div>
            <div className="mb-empty-desc">No preview available for this file type.</div>
          </div>
        );
    }
  }

  return (
    <>
      <div className="mb-header">
        <button className="mb-icon-btn" onClick={onClear} title="Back">‹</button>
        <span className="mb-header-title">{filename}</span>
      </div>

      <div className="mb-preview-body">
        {renderBody()}
      </div>
    </>
  );
}
