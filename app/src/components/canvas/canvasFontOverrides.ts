/**
 * Canvas font-override helpers.
 *
 * tldraw ships four built-in font "slots" (draw, sans, serif, mono).  Users can
 * substitute any of the last three with a system font.  The override mapping is
 * persisted in the tldraw document meta so it survives across sessions, and
 * applied to the editor container as CSS custom properties so every text shape
 * that uses a given slot automatically reflects the chosen font.
 */
import type { Editor } from 'tldraw';
import type { FontOverrides } from './canvasTypes';

export type { FontOverrides };

// Curated macOS/cross-platform system fonts for the picker
export const SYSTEM_FONT_LIST = [
  // Sans-serif
  'Arial', 'Arial Narrow', 'Helvetica', 'Helvetica Neue', 'Gill Sans', 'Futura', 'Avenir',
  'Avenir Next', 'Optima', 'Trebuchet MS', 'Verdana', 'Tahoma', 'Geneva', 'Lucida Grande',
  'Impact', 'Calibri', 'Candara', 'Segoe UI', 'Myriad Pro',
  // Serif
  'Georgia', 'Times New Roman', 'Palatino', 'Garamond', 'Baskerville', 'Didot',
  'Hoefler Text', 'Book Antiqua', 'Cambria', 'Cochin', 'Big Caslon',
  // Monospace
  'Courier New', 'Menlo', 'Monaco', 'Andale Mono', 'Consolas', 'SF Mono',
  // Expressive
  'Comic Sans MS', 'Papyrus', 'Marker Felt', 'Chalkboard SE', 'American Typewriter',
];

/** Canvas-based font availability detection — works in WebKit/Chromium. */
export function detectAvailableFonts(fontList: string[]): string[] {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) return fontList;
  const TEST = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZilIi!|';
  ctx.font = '16px monospace';
  const base = ctx.measureText(TEST).width;
  return fontList.filter((font) => {
    ctx.font = `16px "${font}", monospace`;
    return ctx.measureText(TEST).width !== base;
  });
}

export function loadFontOverrides(editor: Editor): FontOverrides {
  const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
  return (meta?.fontOverrides as FontOverrides) ?? {};
}

export function saveFontOverrides(editor: Editor, overrides: FontOverrides) {
  const existing = editor.getDocumentSettings().meta as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.updateDocumentSettings({ meta: { ...existing, fontOverrides: overrides as any } });
}

export function applyFontOverridesToContainer(editor: Editor, overrides: FontOverrides) {
  const c = editor.getContainer();
  if (overrides.sans) c.style.setProperty('--tl-font-sans', `"${overrides.sans}", sans-serif`);
  else c.style.removeProperty('--tl-font-sans');
  if (overrides.serif) c.style.setProperty('--tl-font-serif', `"${overrides.serif}", serif`);
  else c.style.removeProperty('--tl-font-serif');
  if (overrides.mono) c.style.setProperty('--tl-font-mono', `"${overrides.mono}", monospace`);
  else c.style.removeProperty('--tl-font-mono');
}
