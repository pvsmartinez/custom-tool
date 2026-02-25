import { useMemo, useRef, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import './WebPreview.css';

interface WebPreviewProps {
  /** Raw HTML content (in-memory, may be unsaved) */
  content: string;
  /** Absolute path to the file on disk — used to resolve relative asset URLs */
  absPath: string;
  filename: string;
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
export default function WebPreview({ content, absPath, filename }: WebPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  // Keep iframe src-doc in sync without remounting (avoids scroll reset on every keystroke)
  const prevDocRef = useRef('');
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || srcDoc === prevDocRef.current) return;
    prevDocRef.current = srcDoc;
    // Setting srcdoc programmatically reloads the iframe content
    iframe.srcdoc = srcDoc;
  }, [srcDoc]);

  return (
    <div className="web-preview-container">
      <div className="web-preview-toolbar">
        <span className="web-preview-label">Preview — {filename}</span>
      </div>
      <iframe
        ref={iframeRef}
        className="web-preview-frame"
        srcDoc={srcDoc}
        title={`Preview: ${filename}`}
        // allow-same-origin lets the base tag resolve asset:// resources
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
      />
    </div>
  );
}
