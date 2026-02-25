/**
 * Shared TypeScript interfaces for the canvas subsystem.
 * Imported by CanvasEditor.tsx, CanvasFormatPanel.tsx, canvasTheme.ts, etc.
 */
import type { TLShape, TLShapeId } from 'tldraw';
import type { AIEditMark } from '../../types';

export interface TextStyle {
  font: string;
  size: string;
  color: string;
  align: string;
}

export interface CanvasTheme {
  /** tldraw color name — used when slideBgImage is empty */
  slideBg: string;
  /** Optional image URL — takes priority over slideBg */
  slideBgImage?: string;
  heading: TextStyle;
  body: TextStyle;
  /** Default layout for new slides (blank | title-only | title-body | …) */
  defaultLayout?: string;
}

/** Drop shadow stored in shape.meta */
export interface ShadowMeta {
  blur: number;    // 0–60
  x: number;       // -30–30
  y: number;       // -30–30
  color: string;   // hex e.g. '#000000'
  opacity: number; // 0–1
}

/** Custom system font names mapped to tldraw's built-in font slots */
export interface FontOverrides {
  sans?: string;
  serif?: string;
  mono?: string;
}

/** Typed helper for frame/slide shape props (TLFrameShape is not exported from tldraw v4) */
export type AnyFrame = TLShape & {
  x: number;
  y: number;
  props: { w: number; h: number; name?: string };
};

// ── Re-export from types so canvas subfiles only need one import ─────────────
export type { AIEditMark, TLShapeId };
