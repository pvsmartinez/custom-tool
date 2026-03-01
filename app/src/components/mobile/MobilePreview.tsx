import { useState, useEffect } from 'react';
import { readTextFile, readFile } from '../../services/fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { CaretLeft, SpeakerSimpleHigh } from '@phosphor-icons/react';
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
          <div className="mb-empty-desc">Sem slides gerados. Abra este canvas no desktop para gerar as imagens.</div>
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

// ── HTML / webpage viewer ────────────────────────────────────────────────

function HtmlViewer({ absPath }: { absPath: string }) {
  const src = convertFileSrc(absPath);
  return (
    <iframe
      src={src}
      title="webpage preview"
      className="mb-html-frame"
      sandbox="allow-scripts allow-same-origin"
    />
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

// ── Audio player ────────────────────────────────────────────────────────

function AudioViewer({ absPath }: { absPath: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    readFile(absPath).then(bytes => {
      const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
      const mimeMap: Record<string, string> = {
        webm: 'audio/webm', ogg: 'audio/ogg',
        m4a: 'audio/mp4',  mp4: 'audio/mp4',
        mp3: 'audio/mpeg', wav: 'audio/wav',
        aac: 'audio/aac',  opus: 'audio/ogg',
      };
      const mime = mimeMap[ext] ?? 'audio/webm';
      const blob = new Blob([bytes], { type: mime });
      url = URL.createObjectURL(blob);
      setSrc(url);
    }).catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [absPath]);

  if (!src) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <div className="mb-spinner" />
      </div>
    );
  }

  return (
    <div className="mb-audio-wrap">
      <div className="mb-audio-icon"><SpeakerSimpleHigh weight="thin" size={56} /></div>
      <div className="mb-audio-filename">{absPath.split('/').pop()}</div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls src={src} className="mb-audio-player" />
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
      case 'html':
        return <HtmlViewer absPath={absPath} />;
      case 'markdown':
        return <MarkdownViewer absPath={absPath} />;
      case 'image':
        return <ImageViewer absPath={absPath} />;
      case 'video':
        return <VideoViewer absPath={absPath} />;
      case 'audio':
        return <AudioViewer absPath={absPath} />;
      case 'pdf':
        return <PDFViewer absPath={absPath} />;
      case 'code':
        return <TextViewer absPath={absPath} />;
      default:
        return (
          <div className="mb-empty">
            <div className="mb-empty-desc">Sem preview disponível para este tipo de arquivo.</div>
          </div>
        );
    }
  }

  return (
    <>
      <div className="mb-header">
        <button className="mb-icon-btn" onClick={onClear} title="Voltar">
          <CaretLeft weight="bold" size={18} />
        </button>
        <span className="mb-header-title">{filename === 'index.html' ? (filePath.split('/').slice(-2)[0] ?? filename) : filename}</span>
      </div>

      <div className={`mb-preview-body${kind === 'html' ? ' mb-html' : ''}`}>
        {renderBody()}
      </div>
    </>
  );
}
