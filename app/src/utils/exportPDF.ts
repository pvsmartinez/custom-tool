/**
 * exportMarkdownToPDF
 *
 * Pure-JS PDF export — no system dependencies, works on macOS, Windows, iOS and Android.
 *
 * Pipeline:
 *   1. Render markdown → HTML with `marked`
 *   2. Mount in an off-screen, white, print-styled div
 *   3. Resolve workspace-relative image <img src> → asset:// so html2canvas can load them
 *   4. Capture with html2canvas (retina quality)
 *   5. Paginate onto A4 pages with jsPDF
 *   6. Write bytes to disk via Tauri plugin-fs
 */

import { marked } from 'marked';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { writeFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';

marked.setOptions({ gfm: true, breaks: false });

/** A4 page width at 96 dpi (CSS pixels) — height is handled dynamically */
const A4_W_PX = 794;

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  body, .pdf-root {
    margin: 0; padding: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 16px;
    line-height: 1.75;
    color: #1a1a1a;
    background: #ffffff;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    color: #111;
    margin: 1.5em 0 0.5em;
    line-height: 1.3;
  }
  h1 { font-size: 2em;   border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  h3 { font-size: 1.25em; }
  p  { margin: 0.9em 0; }
  a  { color: #0066cc; text-decoration: none; }
  code {
    font-family: "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 0.875em;
    background: #f5f5f5;
    padding: 0.15em 0.4em;
    border-radius: 3px;
  }
  pre {
    background: #f8f8f8;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 14px 18px;
    overflow: hidden;
    margin: 1.2em 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  pre code { background: none; padding: 0; border-radius: 0; font-size: 0.82em; }
  blockquote {
    border-left: 3px solid #bbb;
    margin: 1em 0;
    padding: 4px 16px;
    color: #555;
  }
  ul, ol { padding-left: 1.8em; margin: 0.8em 0; }
  li     { margin: 0.3em 0; }
  table  { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: 0.95em; }
  th, td { border: 1px solid #ccc; padding: 7px 11px; text-align: left; }
  th     { background: #f0f0f0; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  hr     { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  img    { max-width: 100%; border-radius: 4px; }
  strong { font-weight: 700; color: #111; }
  em     { font-style: italic; color: inherit; }
`;

export async function exportMarkdownToPDF(
  content: string,
  /** Absolute path where the .pdf will be written */
  destAbsPath: string,
  /** Absolute path of the workspace root, used to resolve relative image paths */
  workspaceAbsPath: string,
): Promise<void> {
  // ── 1. Render markdown ───────────────────────────────────────────────────────
  const rawHtml = marked.parse(content) as string;

  // ── 2. Mount off-screen container ───────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.style.cssText = [
    'position:fixed',
    'top:-99999px',
    'left:-99999px',
    `width:${A4_W_PX}px`,
    'background:#ffffff',
    'padding:72px 80px',
  ].join(';');

  const styleEl = document.createElement('style');
  styleEl.textContent = PRINT_STYLES;
  wrapper.appendChild(styleEl);

  const body = document.createElement('div');
  body.className = 'pdf-root';
  body.innerHTML = rawHtml;
  wrapper.appendChild(body);

  document.body.appendChild(wrapper);

  try {
    // ── 3. Resolve relative <img src> to asset:// URLs ─────────────────────────
    const imgs = Array.from(body.querySelectorAll<HTMLImageElement>('img'));
    await Promise.all(imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src || src.startsWith('http') || src.startsWith('data:') || src.startsWith('asset:')) return;
      const absPath = src.startsWith('/')
        ? src
        : `${workspaceAbsPath}/${src}`;
      img.src = convertFileSrc(absPath);
      // Wait for the image to load (or fail gracefully)
      await new Promise<void>((resolve) => {
        if (img.complete) { resolve(); return; }
        img.onload  = () => resolve();
        img.onerror = () => resolve(); // don't abort on missing images
      });
    }));

    // ── 4. Capture with html2canvas ──────────────────────────────────────────
    const canvas = await html2canvas(wrapper, {
      scale: 2,               // retina sharpness
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      width: A4_W_PX,
      windowWidth: A4_W_PX,
      logging: false,
    });

    // ── 5. Paginate into A4 PDF ──────────────────────────────────────────────
    const imgData   = canvas.toDataURL('image/png');
    const pdf       = new jsPDF({ orientation: 'portrait', unit: 'px', format: 'a4' });
    const pageW     = pdf.internal.pageSize.getWidth();
    const pageH     = pdf.internal.pageSize.getHeight();

    // Scale canvas to fit PDF page width
    const ratio      = pageW / canvas.width;
    const totalPdfH  = canvas.height * ratio;
    let   yOffset    = 0;

    while (yOffset < totalPdfH) {
      if (yOffset > 0) pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, -yOffset, pageW, totalPdfH);
      yOffset += pageH;
    }

    // ── 6. Write to disk ─────────────────────────────────────────────────────
    const pdfBytes = new Uint8Array(pdf.output('arraybuffer') as ArrayBuffer);
    await writeFile(destAbsPath, pdfBytes);

  } finally {
    document.body.removeChild(wrapper);
  }
}
