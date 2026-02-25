import { useMemo, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import './PDFViewer.css';

interface PDFViewerProps {
  /** Absolute path to the PDF file on disk */
  absPath: string;
  filename: string;
  /** Called once page count is known */
  onStat?: (stat: string) => void;
}

export default function PDFViewer({ absPath, filename, onStat }: PDFViewerProps) {
  const src = useMemo(() => convertFileSrc(absPath), [absPath]);

  // Count PDF pages by scanning raw bytes for /Type /Page entries
  useEffect(() => {
    if (!onStat) return;
    readFile(absPath).then((bytes) => {
      const text = new TextDecoder('latin1').decode(bytes);
      // PDF spec: each page object contains "/Type /Page" (with optional spaces)
      const matches = text.match(/\/Type\s*\/Page[^s]/g);
      const count = matches?.length ?? 0;
      if (count > 0) onStat(`${count} page${count !== 1 ? 's' : ''}`);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath]);

  return (
    <div className="pdf-viewer">
      <embed
        className="pdf-embed"
        src={src}
        type="application/pdf"
        title={filename}
      />
    </div>
  );
}
