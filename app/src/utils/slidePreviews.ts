/**
 * Slide preview generation and loading.
 *
 * Canvas files (.tldr.json) are converted to per-frame PNG "sidecar" images
 * stored at:
 *   <workspace>/<CONFIG_DIR>/previews/<slug>/slide-001.png
 *                                             slide-002.png …
 *
 * The slug is derived from the canvas relative path, e.g.:
 *   "deck.tldr.json"               → "deck"
 *   "presentations/deck.tldr.json" → "presentations__deck"
 *
 * These files are hidden inside the config dir so they never appear in the
 * sidebar — from the user's perspective they are just "viewing the canvas file".
 */

import { writeFile, mkdir, exists, readDir } from '../services/fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getSvgAsImage } from '@tldraw/editor';
import type { Editor, TLShapeId } from 'tldraw';
import { CONFIG_DIR } from '../services/config';

type AnyFrame = { id: string; type: string; x: number; props: { w: number; h: number } };

/** Derive a filesystem-safe slug from a canvas relative path. */
export function previewSlug(canvasRelPath: string): string {
  return canvasRelPath
    .replace(/\.tldr\.json$/, '')
    .replace(/[/\\]/g, '__');
}

/** Absolute path to the preview directory for a given canvas file. */
export function previewDirPath(workspacePath: string, canvasRelPath: string): string {
  return `${workspacePath}/${CONFIG_DIR}/previews/${previewSlug(canvasRelPath)}`;
}

/**
 * Generate PNG previews for every frame in the canvas and write them to
 * <CONFIG_DIR>/previews/<slug>/.  Returns the asset:// URLs for each slide
 * (in frame order, left-to-right by x position).
 *
 * Runs inside the browser/WebView context — relies on XMLSerializer and
 * OffscreenCanvas which are both available in WebKit.
 */
export async function generateSlidePreviews(
  editor: Editor,
  workspacePath: string,
  canvasRelPath: string,
): Promise<string[]> {
  const frames = (editor.getCurrentPageShapesSorted() as unknown as AnyFrame[])
    .filter((s) => s.type === 'frame')
    .sort((a, b) => a.x - b.x);

  if (frames.length === 0) return [];

  const previewDir = previewDirPath(workspacePath, canvasRelPath);
  await mkdir(previewDir, { recursive: true });

  const urls: string[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      const result = await editor.getSvgElement([frame.id as TLShapeId], {
        background: true,
      });
      if (!result) { urls.push(''); continue; }

      const { svg, width, height } = result;
      const svgString = new XMLSerializer().serializeToString(svg);

      const blob = await getSvgAsImage(svgString, {
        type: 'png',
        width,
        height,
        pixelRatio: 2,
      });
      if (!blob) { urls.push(''); continue; }

      const buf = await blob.arrayBuffer();
      const filename = `slide-${String(i + 1).padStart(3, '0')}.png`;
      const absPath = `${previewDir}/${filename}`;
      await writeFile(absPath, new Uint8Array(buf));
      // Add cache-busting timestamp so the browser re-fetches after regeneration
      urls.push(`${convertFileSrc(absPath)}?t=${Date.now()}`);
    } catch (err) {
      console.warn(`[slidePreviews] Failed to render slide ${i + 1}:`, err);
      urls.push('');
    }
  }

  return urls;
}

/**
 * Load slide preview URLs for a canvas file from existing files on disk.
 * Returns an empty array if no previews have been generated yet.
 */
export async function loadSlidePreviews(
  workspacePath: string,
  canvasRelPath: string,
): Promise<string[]> {
  const previewDir = previewDirPath(workspacePath, canvasRelPath);
  if (!(await exists(previewDir))) return [];
  try {
    const entries = await readDir(previewDir);
    const pngFiles = entries
      .filter((e) => e.name?.endsWith('.png'))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    if (pngFiles.length === 0) return [];
    return pngFiles.map((e) => convertFileSrc(`${previewDir}/${e.name}`));
  } catch {
    return [];
  }
}
