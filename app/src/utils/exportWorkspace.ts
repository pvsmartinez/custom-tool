/**
 * exportWorkspace — core engine for workspace Build/Export targets.
 *
 * Supports 5 formats without system dependencies (pure JS except 'custom'):
 *   pdf         → markdown → PDF  (jsPDF + html2canvas, via exportMarkdownToPDF)
 *                 With merge:true → all matched files become one PDF
 *   canvas-png  → tldraw canvas → PNG per slide/frame (auto-opens canvas if needed)
 *   canvas-pdf  → tldraw canvas → multi-page PDF; merge:true → all canvases in one PDF
 *   zip         → bundle matching files into a .zip  (JSZip, includes binary files)
 *   custom      → run a shell command (desktop only, via Tauri shell_run)
 *
 * File selection: includeFiles (pinned list) > include extensions, minus excludeFiles.
 * Canvas auto-open: pass onOpenFileForExport + onRestoreAfterExport to unlock.
 */

import { readTextFile, writeFile, mkdir, exists, readDir, readFile as readBinaryFile } from '../services/fs';
import { invoke } from '@tauri-apps/api/core';
import jsPDF from 'jspdf';
import JSZip from 'jszip';
import { exportMarkdownToPDF } from './exportPDF';
import type { ExportTarget } from '../types';
import type { Editor, TLShape } from 'tldraw';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportResult {
  targetId: string;
  /** Relative paths of files that were produced */
  outputs: string[];
  errors: string[];
  /** ms elapsed */
  elapsed: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decode a data URL directly to bytes without using `fetch()`.
 * More reliable than fetch(dataUrl).arrayBuffer() in WebKit sandboxes.
 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('Invalid data URL — missing comma separator');
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type AnyFrame = TLShape & {
  x: number; y: number;
  props: { w: number; h: number; name: string };
};

function basename(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

function stripExt(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

/** Strip trailing `.json` from `.tldr.json` → `.tldr` then strip that too */
function canvasBasename(relPath: string): string {
  return stripExt(stripExt(basename(relPath)));
}

/** List all workspace files (flat), skipping hidden/generated dirs */
export async function listAllFiles(wsPath: string, rel = ''): Promise<string[]> {
  const SKIP = new Set(['.git', '.cafezin', 'node_modules', '.DS_Store']);
  let entries;
  try { entries = await readDir(`${wsPath}${rel ? `/${rel}` : ''}`); } catch { return []; }
  const files: string[] = [];
  for (const e of entries) {
    if (!e.name || SKIP.has(e.name)) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) files.push(...await listAllFiles(wsPath, relPath));
    else files.push(relPath);
  }
  return files;
}

/**
 * Resolve which workspace files a target should act on.
 * Priority: includeFiles (explicit pinned list) > include extensions
 * Always applies excludeFiles filter afterward.
 */
export function resolveFiles(allFiles: string[], target: ExportTarget): string[] {
  let pool: string[];

  if (target.includeFiles && target.includeFiles.length > 0) {
    const ws = new Set(allFiles);
    pool = target.includeFiles.filter((f) => ws.has(f));
  } else if (target.include.length > 0) {
    pool = allFiles.filter((f) => {
      const lower = f.toLowerCase();
      return target.include.some((ext) => lower.endsWith(`.${ext.toLowerCase()}`));
    });
  } else {
    pool = [...allFiles];
  }

  if (target.excludeFiles && target.excludeFiles.length > 0) {
    const excl = new Set(target.excludeFiles);
    pool = pool.filter((f) => !excl.has(f));
  }
  return pool;
}

/** Ensure output directory exists */
async function ensureDir(absDir: string) {
  if (!(await exists(absDir))) await mkdir(absDir, { recursive: true });
}

// ── Pre-processing helpers ────────────────────────────────────────────────────

/** Apply markdown transformations before rendering to PDF. */
function preProcessMarkdown(
  content: string,
  opts: ExportTarget['preProcess'],
): string {
  if (!opts) return content;
  let out = content;

  if (opts.stripFrontmatter) {
    // Must be at the very start of the file (no `m` flag so ^ = start of string).
    // Handles \r\n and plain \n line endings.
    out = out.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  }

  if (opts.stripDetails) {
    // Remove <details>…</details> HTML blocks (greedy across newlines)
    out = out.replace(/<details[\s\S]*?<\/details>/gi, '');
  }

  if (opts.stripDraftSections) {
    // Line-by-line approach — reliable, avoids \Z (not valid in JS)
    const lines = out.split('\n');
    const kept: string[] = [];
    let inDraft = false;
    for (const line of lines) {
      if (/^### Draft\b/.test(line)) { inDraft = true; continue; }
      // Any heading at the same or higher level ends the draft section
      if (inDraft && /^#{1,3}\s/.test(line)) inDraft = false;
      if (!inDraft) kept.push(line);
    }
    out = kept.join('\n');
  }

  return out.trim();
}

/** Build a styled HTML title page string. */
function buildTitlePageHtml(tp: NonNullable<ExportTarget['titlePage']>): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts: string[] = ['<div class="title-page">'];
  if (tp.title)    parts.push(`<div class="tp-title">${escape(tp.title)}</div>`);
  if (tp.subtitle) parts.push(`<div class="tp-subtitle">${escape(tp.subtitle)}</div>`);
  if (tp.author)   parts.push(`<div class="tp-author">${escape(tp.author)}</div>`);
  if (tp.version)  parts.push(`<div class="tp-version">${escape(tp.version)}</div>`);
  parts.push('</div>');
  return parts.join('\n');
}

/** Extract headings from markdown and build an HTML TOC.
 *  Skips headings that appear inside fenced code blocks (``` or ~~~). */
function buildTocHtml(content: string): string {
  const lines = content.split('\n');
  const items: string[] = [];
  let inFence = false;
  for (const line of lines) {
    // Toggle fence state on opening/closing ``` or ~~~
    if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const heading = h1 ?? h2;
    if (!heading) continue;
    const level = h1 ? 'h1' : 'h2';
    // Strip inline markdown (bold, italic, code, links) from heading text
    const raw = heading[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .trim();
    const text = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    items.push(`<li class="toc-${level}">${text}</li>`);
  }
  if (items.length === 0) return '';
  return [
    '<div class="toc-page">',
    '<h2 class="toc-heading">Table of Contents</h2>',
    '<ul class="toc-list">',
    ...items,
    '</ul>',
    '</div>',
  ].join('\n');
}

/**
 * Return the output path, applying versioning when requested.
 * - 'timestamp' → appends _YYYY-MM-DD before the extension
 * - 'counter'   → appends _v1, _v2 … scanning existing files
 */
async function versionedPath(
  wsPath: string,
  outputDir: string,
  baseName: string,
  ext: string,
  mode: ExportTarget['versionOutput'],
): Promise<string> {
  if (!mode) return `${outputDir}/${baseName}.${ext}`;

  if (mode === 'timestamp') {
    const today = new Date().toISOString().slice(0, 10);
    return `${outputDir}/${baseName}_${today}.${ext}`;
  }

  // counter mode: find the first unused _vN
  let n = 1;
  while (await exists(`${wsPath}/${outputDir}/${baseName}_v${n}.${ext}`)) n++;
  return `${outputDir}/${baseName}_v${n}.${ext}`;
}

async function exportPDF(
  wsPath: string,
  files: string[],
  target: ExportTarget,
): Promise<ExportResult> {
  const t0 = Date.now();
  const outputs: string[] = [];
  const errors: string[] = [];
  const absOutDir = `${wsPath}/${target.outputDir}`;
  await ensureDir(absOutDir);

  if (files.length === 0) {
    return { targetId: target.id, outputs: [], errors: ['No files matched this target. Check the include extensions or pinned file list.'], elapsed: Date.now() - t0 };
  }

  // ── Load optional custom CSS ──────────────────────────────────────────────
  let customCss: string | undefined;
  if (target.pdfCssFile?.trim()) {
    try { customCss = await readTextFile(`${wsPath}/${target.pdfCssFile.trim()}`); }
    catch (e) { errors.push(`CSS file "${target.pdfCssFile}" not found — using default styles. (${e})`); }
  }

  // ── Build optional prepend HTML (title page + TOC) ───────────────────────
  // toc is supported for both merged and single-file exports.
  function buildPrependHtml(markdown: string): string {
    let html = '';
    if (target.titlePage && Object.values(target.titlePage).some(Boolean)) {
      html += buildTitlePageHtml(target.titlePage);
    }
    if (target.toc) {
      const tocHtml = buildTocHtml(markdown);
      if (tocHtml) html += '\n' + tocHtml;
    }
    return html;
  }

  if (target.merge && files.length >= 1) {
    // ── Merge: concatenate all markdown into one PDF ──────────────────────
    const parts: string[] = [];
    for (const rel of files) {
      try {
        const raw = await readTextFile(`${wsPath}/${rel}`);
        parts.push(preProcessMarkdown(raw, target.preProcess));
      } catch (e) { errors.push(`${rel}: ${e}`); }
    }
    if (parts.length > 0) {
      // Join chapters with double newlines. Chapter-level headings (# H1)
      // provide natural visual separation in the rendered PDF.
      const merged = parts.join('\n\n');
      const name = target.mergeName?.trim() || 'merged';
      const outRel = await versionedPath(wsPath, target.outputDir, name, 'pdf', target.versionOutput);
      try {
        await exportMarkdownToPDF(merged, `${wsPath}/${outRel}`, wsPath, {
          customCss,
          prependHtml: buildPrependHtml(merged),
        });
        outputs.push(outRel);
      } catch (e) { errors.push(`merge: ${e}`); }
    }
  } else {
    // ── One PDF per file ──────────────────────────────────────────────────
    for (const rel of files) {
      const baseName = stripExt(basename(rel));
      const outRel = await versionedPath(wsPath, target.outputDir, baseName, 'pdf', target.versionOutput);
      try {
        const raw = await readTextFile(`${wsPath}/${rel}`);
        const content = preProcessMarkdown(raw, target.preProcess);
        await exportMarkdownToPDF(content, `${wsPath}/${outRel}`, wsPath, {
          customCss,
          prependHtml: buildPrependHtml(content),
        });
        outputs.push(outRel);
      } catch (e) { errors.push(`${rel}: ${e}`); }
    }
  }
  return { targetId: target.id, outputs, errors, elapsed: Date.now() - t0 };
}

async function exportCanvasPNG(
  wsPath: string,
  files: string[],
  target: ExportTarget,
  opts: RunExportOptions,
): Promise<ExportResult> {
  const t0 = Date.now();
  const outputs: string[] = [];
  const errors: string[] = [];
  const absOutDir = `${wsPath}/${target.outputDir}`;
  await ensureDir(absOutDir);

  const liveEditor = () => opts.canvasEditorRef?.current ?? opts.canvasEditor ?? null;

  if (files.length === 0) {
    return { targetId: target.id, outputs: [], errors: ['No canvas files matched this target. Check the include extensions or pinned file list.'], elapsed: Date.now() - t0 };
  }

  for (let fi = 0; fi < files.length; fi++) {
    const rel = files[fi];
    let opened = false;
    if (rel !== opts.activeCanvasRel || !liveEditor()) {
      if (opts.onOpenFileForExport) {
        try { await opts.onOpenFileForExport(rel); opened = true; }
        catch (e) { errors.push(`${rel}: could not open canvas — ${e}`); opts.onProgress?.(fi + 1, files.length, rel); continue; }
      } else {
        errors.push(`${rel}: canvas must be open in the editor to export PNG.`);
        opts.onProgress?.(fi + 1, files.length, rel);
        continue;
      }
    }
    const editor = liveEditor();
    if (!editor) {
      errors.push(`${rel}: editor not available after open`);
      if (opened) opts.onRestoreAfterExport?.(); // must restore even without entering the try block
      opts.onProgress?.(fi + 1, files.length, rel);
      continue;
    }
    try {
      const shapes = editor.getCurrentPageShapes();
      if (!shapes.length) { errors.push(`${rel}: canvas is empty`); opts.onProgress?.(fi + 1, files.length, rel); continue; }
      const frames = (shapes as AnyFrame[]).filter((s) => s.type === 'frame').sort((a, b) => a.x - b.x);
      const ids = frames.length ? frames.map((f) => f.id) : shapes.map((s) => s.id);

      for (let i = 0; i < ids.length; i++) {
        const shapeName = frames.length ? ((frames[i] as AnyFrame).props.name || `slide-${i + 1}`) : 'canvas';
        const suffix = ids.length > 1 ? `-${shapeName.replace(/[^a-z0-9]/gi, '-')}` : '';
        const outRel = `${target.outputDir}/${canvasBasename(rel)}${suffix}.png`;
        const { url } = await editor.toImageDataUrl([ids[i]], { format: 'png', pixelRatio: 2, background: true });
        await writeFile(`${wsPath}/${outRel}`, dataUrlToBytes(url));
        outputs.push(outRel);
      }
    } catch (e) {
      errors.push(`${rel}: ${e}`);
    } finally {
      if (opened) opts.onRestoreAfterExport?.();
    }
    opts.onProgress?.(fi + 1, files.length, rel);
  }
  return { targetId: target.id, outputs, errors, elapsed: Date.now() - t0 };
}

async function exportCanvasPDF(
  wsPath: string,
  files: string[],
  target: ExportTarget,
  opts: RunExportOptions,
): Promise<ExportResult> {
  const t0 = Date.now();
  const outputs: string[] = [];
  const errors: string[] = [];
  const absOutDir = `${wsPath}/${target.outputDir}`;
  await ensureDir(absOutDir);

  const liveEditor = () => opts.canvasEditorRef?.current ?? opts.canvasEditor ?? null;
  let mergePdf: jsPDF | null = null;
  const mergedRelPath = `${target.outputDir}/${target.mergeName?.trim() || 'merged'}.pdf`;

  if (files.length === 0) {
    return { targetId: target.id, outputs: [], errors: ['No canvas files matched this target. Check the include extensions or pinned file list.'], elapsed: Date.now() - t0 };
  }

  for (let fi = 0; fi < files.length; fi++) {
    const rel = files[fi];
    let opened = false;
    if (rel !== opts.activeCanvasRel || !liveEditor()) {
      if (opts.onOpenFileForExport) {
        try { await opts.onOpenFileForExport(rel); opened = true; }
        catch (e) { errors.push(`${rel}: could not open canvas — ${e}`); opts.onProgress?.(fi + 1, files.length, rel); continue; }
      } else {
        errors.push(`${rel}: canvas must be open in the editor to export.`);
        opts.onProgress?.(fi + 1, files.length, rel);
        continue;
      }
    }
    const editor = liveEditor();
    if (!editor) {
      errors.push(`${rel}: editor not available after open`);
      if (opened) opts.onRestoreAfterExport?.(); // must restore even without entering the try block
      opts.onProgress?.(fi + 1, files.length, rel);
      continue;
    }

    try {
      const shapes = editor.getCurrentPageShapes();
      if (!shapes.length) { errors.push(`${rel}: canvas is empty`); opts.onProgress?.(fi + 1, files.length, rel); continue; }
      const frames = (shapes as AnyFrame[]).filter((s) => s.type === 'frame').sort((a, b) => a.x - b.x);
      const slideIds = frames.length ? frames.map((f) => f.id) : [null];
      const allIds   = shapes.map((s) => s.id);
      const fw = frames.length ? frames[0].props.w : 1280;
      const fh = frames.length ? frames[0].props.h : 720;
      const orientation: 'landscape' | 'portrait' = fw >= fh ? 'landscape' : 'portrait';

      if (target.merge) {
        if (!mergePdf) { mergePdf = new jsPDF({ orientation, unit: 'px', format: [fw, fh] }); mergePdf.deletePage(1); }
        for (const sid of slideIds) {
          const { url } = await editor.toImageDataUrl(sid ? [sid] : allIds, { format: 'png', pixelRatio: 2, background: true });
          mergePdf.addPage([fw, fh], orientation);
          mergePdf.addImage(url, 'PNG', 0, 0, fw, fh);
        }
      } else {
        const pdf = new jsPDF({ orientation, unit: 'px', format: [fw, fh] });
        pdf.deletePage(1);
        for (const sid of slideIds) {
          const { url } = await editor.toImageDataUrl(sid ? [sid] : allIds, { format: 'png', pixelRatio: 2, background: true });
          pdf.addPage([fw, fh], orientation);
          pdf.addImage(url, 'PNG', 0, 0, fw, fh);
        }
        const outRel = `${target.outputDir}/${canvasBasename(rel)}.pdf`;
        await writeFile(`${wsPath}/${outRel}`, new Uint8Array(pdf.output('arraybuffer') as ArrayBuffer));
        outputs.push(outRel);
      }
    } catch (e) {
      errors.push(`${rel}: ${e}`);
    } finally {
      if (opened) opts.onRestoreAfterExport?.();
    }
    opts.onProgress?.(fi + 1, files.length, rel);
  }

  if (target.merge && mergePdf) {
    try {
      await writeFile(`${wsPath}/${mergedRelPath}`, new Uint8Array(mergePdf.output('arraybuffer') as ArrayBuffer));
      outputs.push(mergedRelPath);
    } catch (e) { errors.push(`merge write: ${e}`); }
  }
  return { targetId: target.id, outputs, errors, elapsed: Date.now() - t0 };
}

async function exportZip(
  wsPath: string,
  files: string[],
  target: ExportTarget,
): Promise<ExportResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const absOutDir = `${wsPath}/${target.outputDir}`;
  await ensureDir(absOutDir);

  if (files.length === 0) {
    return { targetId: target.id, outputs: [], errors: ['No files matched this target. Check the include extensions or pinned file list.'], elapsed: Date.now() - t0 };
  }

  const zip = new JSZip();
  let addedCount = 0;
  for (const rel of files) {
    try {
      // Binary read so images/fonts/PDFs are included correctly
      const bytes = await readBinaryFile(`${wsPath}/${rel}`);
      zip.file(rel, bytes);
      addedCount++;
    } catch (e) {
      errors.push(`${rel}: ${e}`);
    }
  }

  if (addedCount === 0) {
    return { targetId: target.id, outputs: [], errors, elapsed: Date.now() - t0 };
  }

  const zipName = target.mergeName?.trim() || 'export';
  const outRel = `${target.outputDir}/${zipName}.zip`;
  const zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  await writeFile(`${wsPath}/${outRel}`, zipBytes);
  return { targetId: target.id, outputs: [outRel], errors, elapsed: Date.now() - t0 };
}

async function exportCustom(
  wsPath: string,
  files: string[],
  target: ExportTarget,
): Promise<ExportResult> {
  const t0 = Date.now();
  const outputs: string[] = [];
  const errors: string[] = [];
  const cmd = target.customCommand?.trim() ?? '';
  if (!cmd) {
    return { targetId: target.id, outputs: [], errors: ['No custom command configured.'], elapsed: 0 };
  }
  if (files.length === 0 && target.include.length > 0) {
    // Only warn about no matches when a filter was set; no-filter custom commands are run once
    return { targetId: target.id, outputs: [], errors: ['No files matched this target. Check the include extensions or pinned file list.'], elapsed: Date.now() - t0 };
  }

  const absOutDir = `${wsPath}/${target.outputDir}`;
  await ensureDir(absOutDir);

  if (files.length === 0) {
    // Run the command once with no substitution
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        'shell_run', { cmd, cwd: wsPath },
      );
      if (result.exit_code !== 0) errors.push(result.stderr || `exit code ${result.exit_code}`);
      else outputs.push(target.outputDir);
    } catch (e) { errors.push(String(e)); }
  } else {
    for (const rel of files) {
      const outName = stripExt(basename(rel));
      const finalCmd = cmd
        .replace(/\{\{input\}\}/g, rel)
        .replace(/\{\{output\}\}/g, `${target.outputDir}/${outName}`);
      try {
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
          'shell_run', { cmd: finalCmd, cwd: wsPath },
        );
        if (result.exit_code !== 0) errors.push(`${rel}: ${result.stderr || `exit ${result.exit_code}`}`);
        else outputs.push(`${target.outputDir}/${outName}`);
      } catch (e) { errors.push(`${rel}: ${e}`); }
    }
  }
  return { targetId: target.id, outputs, errors, elapsed: Date.now() - t0 };
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface RunExportOptions {
  workspacePath: string;
  target: ExportTarget;
  /**
   * Ref to the live canvas editor — re-read after onOpenFileForExport resolves
   * so the fresh instance is used. Preferred over canvasEditor.
   */
  canvasEditorRef?: { current: Editor | null };
  /**
   * Concrete editor — used by the Copilot agent tool path which lacks a ref.
   * Ignored when canvasEditorRef is provided.
   */
  canvasEditor?: Editor | null;
  /** Relative path of the currently-open canvas file */
  activeCanvasRel?: string | null;
  /**
   * Programmatically switch to a canvas file before exporting it.
   * Must resolve only after the tldraw Editor is fully mounted.
   * When provided, canvas exports no longer require the file to be pre-opened.
   */
  onOpenFileForExport?: (relPath: string) => Promise<void>;
  /** Restore the previous tab after each canvas file export. */
  onRestoreAfterExport?: () => void;
  /**
   * Progress callback fired after each canvas file is processed.
   * @param done   Number of canvas files completed so far.
   * @param total  Total canvas files to process.
   * @param label  Relative path of the just-finished file.
   */
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function runExportTarget(opts: RunExportOptions): Promise<ExportResult> {
  const { workspacePath, target } = opts;
  const allFiles = await listAllFiles(workspacePath);
  const matched  = resolveFiles(allFiles, target);

  switch (target.format) {
    case 'pdf':
      return exportPDF(workspacePath, matched, target);
    case 'canvas-png':
      return exportCanvasPNG(workspacePath, matched, target, opts);
    case 'canvas-pdf':
      return exportCanvasPDF(workspacePath, matched, target, opts);
    case 'zip':
      return exportZip(workspacePath, matched, target);
    case 'custom':
      return exportCustom(workspacePath, matched, target);
    default:
      return { targetId: target.id, outputs: [], errors: [`Unknown format: ${(target as ExportTarget).format}`], elapsed: 0 };
  }
}
