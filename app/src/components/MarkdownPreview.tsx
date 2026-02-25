import { useCallback, useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import { openUrl } from '@tauri-apps/plugin-opener';
import './MarkdownPreview.css';

// Configure marked: GitHub-flavoured, synchronous
marked.setOptions({ gfm: true, breaks: false });

interface MarkdownPreviewProps {
  content: string;
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return '<p style="color:#c97570">Failed to render markdown.</p>';
    }
  }, [content]);

  // Inject copy buttons into every <pre> block after each render.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
      if (pre.querySelector('.md-copy-btn')) return; // already injected
      const btn = document.createElement('button');
      btn.className = 'md-copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        navigator.clipboard.writeText(code?.textContent ?? '').then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });
      });
      pre.appendChild(btn);
    });
  }, [html]);

  // Intercept link clicks: open external URLs in the system browser.
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('http://') || href.startsWith('https://')) {
      openUrl(href);
    }
    // Anchor / relative links (e.g. #heading) can be handled by the browser normally.
    // For now we only intercept absolute external links to avoid WebView navigation.
  }, []);

  return (
    <div className="md-preview-scroll">
      <div
        ref={containerRef}
        className="md-preview-body"
        onClick={handleClick}
        // marked sanitises nothing — but content is local files the user owns
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
