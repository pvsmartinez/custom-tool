import { useMemo, useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { toPng } from 'html-to-image';
import { convertFileSrc } from '@tauri-apps/api/core';
import './WebPreview.css';

export interface WebPreviewHandle {
  /** Capture a PNG screenshot of the currently rendered HTML preview. */
  getScreenshot: () => Promise<string | null>;
}

interface WebPreviewProps {
  /** Raw HTML content (in-memory, may be unsaved) */
  content: string;
  /** Absolute path to the file on disk — used to resolve relative asset URLs */
  absPath: string;
  filename: string;
  /** When true (Copilot is writing this file) freeze live updates and show an overlay. */
  isLocked?: boolean;
}

/**
 * Returns true if a URL value should be left untouched (already absolute or
 * a special scheme that the browser handles natively).
 */
function isAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z\d+\-.]*:|\/\/|#|data:|blob:|javascript:)/i.test(url);
}

/**
 * Rewrite every relative src/href/url() reference in an HTML string to an
 * absolute asset:// URL so that Tauri's WebView can load them from
 * within an srcdoc iframe (which has a null origin and cannot follow a
 * <base> tag to asset:// resources in all WebKit versions).
 */
function rewriteAssetPaths(html: string, dir: string): string {
  // Rewrite src="..." and href="..." attributes
  let result = html.replace(
    /(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi,
    (_match, attr, quote, url) => {
      if (isAbsoluteUrl(url)) return _match;
      const absPath = url.startsWith('/')
        ? url  // web-root-relative: leave as-is (no known root to resolve against)
        : dir + url;
      return `${attr}${quote}${convertFileSrc(absPath)}${quote}`;
    },
  );

  // Rewrite url('...') / url("...") / url(...) inside <style> blocks and style="" attrs
  result = result.replace(
    /url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (_match, quote, url) => {
      if (isAbsoluteUrl(url)) return _match;
      const absPath = url.startsWith('/') ? url : dir + url;
      return `url(${quote}${convertFileSrc(absPath)}${quote})`;
    },
  );

  return result;
}

/**
 * Renders an HTML file inside an <iframe> using srcdoc so the preview
 * always reflects the current in-memory content — no save required.
 *
 * Relative URLs (CSS, JS, images) are rewritten directly to absolute
 * asset:// URLs so they load correctly regardless of iframe origin.
 */
const WebPreview = forwardRef<WebPreviewHandle, WebPreviewProps>(function WebPreview(
  { content, absPath, filename, isLocked = false },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Holds the latest computed srcDoc while locked so we can flush it on unlock
  const pendingDocRef = useRef<string | null>(null);
  // Bump to force a reload even if srcDoc hasn't changed
  const [reloadKey, setReloadKey] = useState(0);

  // Directory that contains the HTML file (trailing slash included)
  const dir = useMemo(
    () => absPath.substring(0, absPath.lastIndexOf('/') + 1),
    [absPath],
  );

  // Rewrite relative paths to asset:// URLs, then optionally keep a <base>
  // tag as a fallback for any dynamic paths the rewriter cannot see at
  // parse time (e.g. paths built in JS).
  const srcDoc = useMemo(() => {
    // Skip files that already have a <base> tag — honour the author's intent
    if (/<base\s/i.test(content)) return content;

    const rewritten = rewriteAssetPaths(content, dir);
    const baseTag = `<base href="${convertFileSrc(dir)}">`;

    if (/<head(\s[^>]*)?>/i.test(rewritten)) {
      return rewritten.replace(/(<head(\s[^>]*)?>)/i, `$1${baseTag}`);
    }
    if (/<html(\s[^>]*)?>/i.test(rewritten)) {
      return rewritten.replace(/(<html(\s[^>]*)?>)/i, `$1<head>${baseTag}</head>`);
    }
    return baseTag + rewritten;
  }, [content, dir]);

  // Keep iframe src-doc in sync — freeze when Copilot is writing, flush on unlock
  const prevDocRef = useRef('');
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (isLocked) {
      // Buffer latest content; do NOT push to iframe while locked
      pendingDocRef.current = srcDoc;
      return;
    }
    // Flush any buffered content accumulated during the lock period
    const doc = pendingDocRef.current ?? srcDoc;
    pendingDocRef.current = null;
    if (doc === prevDocRef.current) return;
    prevDocRef.current = doc;
    iframe.srcdoc = doc;
  // reloadKey is intentionally included so a manual reload forces even same-content refresh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcDoc, isLocked, reloadKey]);

  const handleReload = useCallback(() => {
    // Force re-push of current content to iframe
    prevDocRef.current = '';
    setReloadKey((k) => k + 1);
  }, []);

  // ⌘R / Ctrl+R to reload the preview
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        handleReload();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [handleReload]);

  // Expose screenshot capability to parent via ref
  useImperativeHandle(ref, () => ({
    getScreenshot: async (): Promise<string | null> => {
      // Primary: render via the live iframe (it has allow-same-origin in its sandbox)
      const iframe = iframeRef.current;
      if (iframe?.contentDocument?.body) {
        try {
          return await toPng(iframe.contentDocument.body, {
            width: iframe.offsetWidth || 900,
            height: iframe.offsetHeight || 600,
            backgroundColor: '#ffffff',
          });
        } catch {
          // fall through to off-screen fallback
        }
      }
      // Fallback: render body + styles in an off-screen div so layout/spacing
      // is captured even if the iframe content is inaccessible.
      const container = document.createElement('div');
      container.style.cssText =
        'position:fixed;left:-9999px;top:0;width:900px;background:#fff;pointer-events:none;';
      const styleBlocks = [...srcDoc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
        .map(m => m[0]).join('\n');
      const bodyMatch = srcDoc.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyHtml = bodyMatch ? bodyMatch[1] : srcDoc;
      const safe = (styleBlocks + '\n' + bodyHtml).replace(/<script[\s\S]*?<\/script>/gi, '');
      container.innerHTML = safe;
      document.body.appendChild(container);
      try {
        return await toPng(container, { width: 900, backgroundColor: '#ffffff' });
      } catch {
        return null;
      } finally {
        document.body.removeChild(container);
      }
    },
  }), [srcDoc]);

  return (
    <div className="web-preview-container" ref={containerRef} tabIndex={-1}>
      <div className="web-preview-toolbar">
        <span className="web-preview-label">Preview — {filename}</span>
        {isLocked && (
          <span className="web-preview-lock-badge">✦ Copilot writing…</span>
        )}
        <button
          className="web-preview-reload-btn"
          onClick={handleReload}
          title="Reload preview (⌘R)"
          aria-label="Reload preview"
        >
          ↺
        </button>
      </div>
      <div className="web-preview-frame-wrapper">
        {isLocked && <div className="web-preview-lock-overlay" aria-hidden />}
        <iframe
          ref={iframeRef}
          className="web-preview-frame"
          srcDoc={srcDoc}
          title={`Preview: ${filename}`}
          // allow-same-origin lets the base tag resolve asset:// resources AND
          // enables getScreenshot() to access contentDocument for the vision tool.
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
        />
      </div>
    </div>
  );
});

export default WebPreview;
