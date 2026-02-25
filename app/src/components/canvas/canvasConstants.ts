/**
 * Module-level constants shared across the canvas subsystem.
 * Must NOT be created inside React components — they are stable references.
 */

// ── Slide dimensions ──────────────────────────────────────────────────────────
export const SLIDE_W = 1280;
export const SLIDE_H = 720;
export const SLIDE_GAP = 80;

// ── tldraw options (Figma-like camera: pinch/scroll = zoom, not pan) ─────────
export const CAMERA_OPTIONS = {
  wheelBehavior: 'zoom' as const,
  zoomSteps: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8],
  zoomSpeed: 1,
  panSpeed: 1,
  isLocked: false,
};

// Double the default snap threshold so snapping feels responsive
export const TLDRAW_OPTIONS = {
  snapThreshold: 16, // screen-pixels at zoom-1 (default: 8)
} as const;

// ── Format panel data ─────────────────────────────────────────────────────────

// Representative hex values for tldraw's 13 named colors (light-mode)
export const TLDRAW_COLORS: [string, string][] = [
  ['black', '#1d1d1d'], ['grey', '#aaaaaa'], ['red', '#f73c49'],
  ['light-red', '#ffb3c1'], ['orange', '#ff9133'], ['yellow', '#f5cf61'],
  ['green', '#41b356'], ['light-green', '#a8db7a'], ['blue', '#4465e9'],
  ['light-blue', '#4ba1f1'], ['violet', '#9d50ff'], ['light-violet', '#e4ccff'],
  ['white', '#f8f8f8'],
];

export const FONT_OPTIONS = [
  { value: 'draw', label: 'Hand' },
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
] as const;

export const ARROW_KIND_OPTIONS = [
  { value: 'straight', label: '⟶', title: 'Straight' },
  { value: 'curve',    label: '⤵', title: 'Curved' },
  { value: 'elbow',    label: '⌞', title: 'Elbow / right-angle' },
] as const;

export const ARROWHEAD_OPTIONS = [
  { value: 'none',     icon: '—',  title: 'None' },
  { value: 'arrow',    icon: '→',  title: 'Arrow' },
  { value: 'triangle', icon: '▶', title: 'Triangle' },
  { value: 'dot',      icon: '●', title: 'Dot' },
  { value: 'diamond',  icon: '◆', title: 'Diamond' },
  { value: 'bar',      icon: '|',   title: 'Bar' },
] as const;

export const SIZE_OPTIONS = [
  { value: 's',  label: 'S'  },
  { value: 'm',  label: 'M'  },
  { value: 'l',  label: 'L'  },
  { value: 'xl', label: 'XL' },
] as const;

export const ALIGN_OPTIONS = [
  { value: 'start',   icon: '\u2190', label: 'Align left' },
  { value: 'middle',  icon: '\u2261', label: 'Align center' },
  { value: 'end',     icon: '\u2192', label: 'Align right' },
  { value: 'justify', icon: '\u2630', label: 'Justify' },
] as const;

export const FILL_OPTIONS = [
  { value: 'none',    icon: '\u25a1', label: 'No fill' },
  { value: 'semi',    icon: '\u25d1', label: 'Semi fill' },
  { value: 'solid',   icon: '\u25a0', label: 'Solid fill' },
  { value: 'pattern', icon: '\u25a6', label: 'Pattern fill' },
] as const;

export const DASH_OPTIONS = [
  { value: 'draw',   icon: '\u223c', label: 'Hand drawn' },
  { value: 'solid',  icon: '\u2014', label: 'Solid' },
  { value: 'dashed', icon: '\u254c', label: 'Dashed' },
  { value: 'dotted', icon: '\u22ef', label: 'Dotted' },
] as const;

// ── Geo shape type options ────────────────────────────────────────────────────
export const GEO_TYPES_COMMON = [
  { value: 'rectangle', icon: '▬', label: 'Rect' },
  { value: 'ellipse',   icon: '◯', label: 'Ellipse' },
  { value: 'triangle',  icon: '△', label: 'Tri' },
  { value: 'diamond',   icon: '◇', label: 'Diamond' },
  { value: 'hexagon',   icon: '⬡', label: 'Hex' },
  { value: 'star',      icon: '☆', label: 'Star' },
  { value: 'cloud',     icon: '☁', label: 'Cloud' },
  { value: 'heart',     icon: '♡', label: 'Heart' },
  { value: 'check-box', icon: '☑', label: 'Check' },
  { value: 'x-box',     icon: '⊠', label: 'X-Box' },
] as const;

export const GEO_TYPES_EXTRA = [
  { value: 'pentagon',    icon: '⬠', label: 'Pent' },
  { value: 'octagon',     icon: '8✦', label: 'Oct' },
  { value: 'oval',        icon: '⬭', label: 'Oval' },
  { value: 'trapezoid',   icon: '⏢', label: 'Trap' },
  { value: 'rhombus',     icon: '⬧', label: 'Rhomb' },
  { value: 'rhombus-2',   icon: '◆', label: 'Rhomb2' },
  { value: 'arrow-right', icon: '▶', label: '→' },
  { value: 'arrow-left',  icon: '◀', label: '←' },
  { value: 'arrow-up',    icon: '▲', label: '↑' },
  { value: 'arrow-down',  icon: '▼', label: '↓' },
] as const;

// ── Shadow ────────────────────────────────────────────────────────────────────
import type { ShadowMeta } from './canvasTypes';

export function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${opacity.toFixed(2)})`;
}

export const SHADOW_PRESETS: { label: string; value: ShadowMeta }[] = [
  { label: 'Soft', value: { blur: 20, x: 0, y: 6, color: '#000000', opacity: 0.22 } },
  { label: 'Med',  value: { blur: 28, x: 0, y: 8, color: '#000000', opacity: 0.38 } },
  { label: 'Hard', value: { blur: 10, x: 2, y: 8, color: '#000000', opacity: 0.55 } },
];
