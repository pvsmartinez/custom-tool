import { useMemo } from 'react';
import { marked } from 'marked';
import './MarkdownPreview.css';

// Configure marked: GitHub-flavoured, synchronous
marked.setOptions({ gfm: true, breaks: false });

interface MarkdownPreviewProps {
  content: string;
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return '<p style="color:#e06c75">Failed to render markdown.</p>';
    }
  }, [content]);

  return (
    <div className="md-preview-scroll">
      <div
        className="md-preview-body"
        // marked sanitises nothing — but content is local files the user owns
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
