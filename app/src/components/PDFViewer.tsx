import { useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import './PDFViewer.css';

interface PDFViewerProps {
  /** Absolute path to the PDF file on disk */
  absPath: string;
  filename: string;
}

export default function PDFViewer({ absPath, filename }: PDFViewerProps) {
  // convertFileSrc turns a fs path into a Tauri asset:// URL the WebView can load
  const src = useMemo(() => convertFileSrc(absPath), [absPath]);

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
