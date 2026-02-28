/**
 * preprocessMath — converts $$...$$ block and $...$ inline LaTeX
 * to rendered KaTeX HTML before markdown parsing.
 *
 * Shared between MarkdownPreview (live preview) and exportMarkdownToPDF (PDF export).
 */
import katex from 'katex';

export function preprocessMath(markdown: string): string {
  // Block math: $$...$$ → wrapped <div class="katex-block">
  let out = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr: string) => {
    try {
      return `<div class="katex-block">${katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false })}</div>`;
    } catch {
      return `<div class="katex-block katex-error">${expr}</div>`;
    }
  });

  // Inline math: $...$ (not preceded by another $)
  out = out.replace(/(?<!\$)\$([^\n$]+?)\$/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return `<span class="katex-error">$${expr}$</span>`;
    }
  });

  return out;
}
