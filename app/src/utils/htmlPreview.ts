/**
 * Shared utilities for rendering HTML preview content.
 *
 * Used by:
 *   - WebPreview.tsx          — live iframe preview component
 *   - workspaceTools.ts       — screenshot_preview offscreen fallback
 */

import { toPng } from 'html-to-image';
import { convertFileSrc } from '@tauri-apps/api/core';

// ── Asset path rewriting ─────────────────────────────────────────────────────

/**
 * Returns true if a URL value should be left untouched (already absolute or
 * a special scheme that the browser handles natively).
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z\d+\-.]*:|\/\/|#|data:|blob:|javascript:)/i.test(url);
}

/**
 * Rewrite every relative src/href/url() reference in an HTML string to an
 * absolute asset:// URL so that Tauri's WebView can load them from
 * within an srcdoc iframe (which has a null origin and cannot follow a
 * <base> tag to asset:// resources in all WebKit versions).
 */
export function rewriteAssetPaths(html: string, dir: string): string {
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
 * Build the full srcdoc string for an iframe preview:
 * rewrites relative asset paths to asset:// URLs and injects a <base> tag.
 *
 * @param html    Raw HTML content (in-memory, may be unsaved)
 * @param dir     Directory containing the file (trailing slash required)
 */
export function buildSrcDoc(html: string, dir: string): string {
  // Honour an existing <base> tag — don't double-inject one
  if (/<base\s/i.test(html)) return html;

  const rewritten = rewriteAssetPaths(html, dir);
  const baseTag = `<base href="${convertFileSrc(dir)}">`;

  if (/<head(\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/(<head(\s[^>]*)?>)/i, `$1${baseTag}`);
  }
  if (/<html(\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/(<html(\s[^>]*)?>)/i, `$1<head>${baseTag}</head>`);
  }
  return baseTag + rewritten;
}

// ── Off-screen rendering ─────────────────────────────────────────────────────

/**
 * Render an HTML string off-screen and return a PNG data URL.
 *
 * Works without a live iframe — strips <script> tags so nothing executes, then
 * uses html-to-image's toPng on an off-screen div. This is the fallback used by
 * the screenshot_preview tool when the preview pane is not currently mounted
 * (i.e. the user is in editor mode, not preview mode).
 *
 * Returns null on failure.
 */
export async function renderHtmlOffscreen(
  html: string,
  absPath: string,
): Promise<string | null> {
  const dir = absPath.substring(0, absPath.lastIndexOf('/') + 1);
  const srcDoc = buildSrcDoc(html, dir);

  // Extract <style> blocks and <body> content for the off-screen div
  const styleBlocks = [...srcDoc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[0]).join('\n');
  const bodyMatch = srcDoc.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : srcDoc;
  const safe = (styleBlocks + '\n' + bodyHtml).replace(/<script[\s\S]*?<\/script>/gi, '');

  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:900px;background:#fff;pointer-events:none;';
  container.innerHTML = safe;
  document.body.appendChild(container);

  try {
    return await toPng(container, { width: 900, backgroundColor: '#ffffff' });
  } catch {
    return null;
  } finally {
    document.body.removeChild(container);
  }
}
