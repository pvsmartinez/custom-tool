/**
 * AI ↔ Canvas bridge.
 *
 * Two concerns:
 *  1. Summarise the current canvas into human-readable text for the AI system prompt.
 *  2. Parse a ```canvas … ``` code block from an AI response and execute the
 *     commands against the live tldraw Editor instance.
 *
 * Command format (one JSON object per line inside the fenced block):
 *   {"op":"add_slide", "name":"Slide title"}                              ← new 16:9 frame, appended after the last existing frame
 *   {"op":"add_note",  "text":"…", "x":100, "y":100, "color":"yellow"}
 *   {"op":"add_text",  "text":"…", "x":100, "y":100, "color":"black"}
 *   {"op":"add_geo",   "text":"…", "geo":"rectangle", "x":100, "y":100, "w":200, "h":120, "color":"blue", "fill":"solid"}
 *   {"op":"add_image", "url":"https://…", "x":0, "y":0, "w":1280, "h":720, "slide":"frameId", "to_back":true}
 *   {"op":"set_slide_background", "url":"https://…", "slide":"frameId"}   ← fills whole frame, sends to back, removes old bg
 *   {"op":"copy_slide_background", "from_slide":"abc1234567", "to_slides":["def1234567"]}
 *   {"op":"update",    "id":"abc123", "text":"New text"}
 *   {"op":"delete",    "id":"abc123"}
 *   {"op":"clear"}
 *
 * "id" values match the last-10-characters of a shape ID shown in the summary.
 *
 * NOTE: add_slide is the only way to create a frame/slide. After creation the
 * CanvasEditor store listener automatically applies the current theme to it.
 */

import type { Editor, TLRichText, TLShapeId, TLEditorSnapshot } from 'tldraw';
import { createShapeId, renderPlaintextFromRichText, toRichText, createTLSchema } from 'tldraw';
import type { TLNoteShape, TLGeoShape, TLTextShape, TLGeoShapeGeoStyle, TLArrowShape, TLFrameShape } from '@tldraw/tlschema';

// ── Lazy-cached current tldraw schema (sequences + versions) ────────────────
// Used by sanitizeSnapshot to clamp out-of-range sequence versions in
// AI-generated or externally-produced canvas files.
let _tlSerializedSchema: Record<string, number> | null = null;
function getTLSequences(): Record<string, number> {
  // Only cache on success — if createTLSchema() throws, return {} without
  // caching so the next call retries. Caching {} would make sanitizeSnapshot
  // treat EVERY sequence in a valid file as "unknown" and delete them,
  // silently corrupting the file.
  if (_tlSerializedSchema !== null) return _tlSerializedSchema;
  try {
    const s = createTLSchema().serialize() as { schemaVersion: number; sequences: Record<string, number> };
    _tlSerializedSchema = s.sequences ?? {};
    return _tlSerializedSchema;
  } catch {
    return {}; // don't cache — retry on next call
  }
}

// ── Slide layout constants — keep in sync with CanvasEditor.tsx ─────────────
const SLIDE_W = 1280;
const SLIDE_H = 720;
const SLIDE_GAP = 80;

// ── Color mapping ────────────────────────────────────────────────────────────
type TLColor =
  | 'black' | 'blue' | 'green' | 'grey' | 'light-blue' | 'light-green'
  | 'light-red' | 'light-violet' | 'orange' | 'red' | 'violet' | 'white' | 'yellow';

const COLOR_MAP: Record<string, TLColor> = {
  yellow: 'yellow', blue: 'blue', green: 'green', red: 'red', orange: 'orange',
  purple: 'violet', violet: 'violet', lavender: 'light-violet',
  grey: 'grey', gray: 'grey',
  white: 'white', black: 'black',
  'light-blue': 'light-blue', 'light-green': 'light-green',
  'light-red': 'light-red', 'light-violet': 'light-violet',
  pink: 'light-red', teal: 'light-blue',
};

type TLFill = 'none' | 'semi' | 'solid' | 'pattern';
type TLSize = 's' | 'm' | 'l' | 'xl';
type TLFont = 'draw' | 'sans' | 'serif' | 'mono';
type TLAlign = 'start' | 'middle' | 'end';

export function mapFill(raw: unknown): TLFill {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'none' || s === 'semi' || s === 'solid' || s === 'pattern') return s as TLFill;
  return 'solid';
}

export function mapColor(raw: unknown, fallback: TLColor = 'yellow'): TLColor {
  return COLOR_MAP[String(raw ?? '').toLowerCase()] ?? fallback;
}

export function mapSize(raw: unknown, fallback: TLSize = 'm'): TLSize {
  const s = String(raw ?? '').toLowerCase();
  if (s === 's' || s === 'm' || s === 'l' || s === 'xl') return s as TLSize;
  // Accept aliases: small/large/xlarge
  if (s === 'small') return 's';
  if (s === 'large') return 'l';
  if (s === 'xlarge' || s === 'x-large' || s === 'title') return 'xl';
  return fallback;
}

export function mapFont(raw: unknown, fallback: TLFont = 'sans'): TLFont {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'draw' || s === 'sans' || s === 'serif' || s === 'mono') return s as TLFont;
  return fallback;
}

export function mapAlign(raw: unknown, fallback: TLAlign = 'start'): TLAlign {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'start' || s === 'left') return 'start';
  if (s === 'middle' || s === 'center') return 'middle';
  if (s === 'end' || s === 'right') return 'end';
  return fallback;
}

// ── Snapshot sanitizer ───────────────────────────────────────────────────────
/**
 * Repairs known schema violations in a raw tldraw snapshot so tldraw v4.4+
 * doesn't throw ValidationErrors or migration-errors when loading older or
 * AI-generated canvas files.
 *
 * Strategy: Rather than replacing the schema (which would prevent tldraw's own
 * migrations from running), we manually apply the same repairs that tldraw's
 * migrations would apply.  This way files persisted with an old schema get fixed
 * in-memory before tldraw sees them, so migrateStoreSnapshot → put → validateRecord
 * sees only valid records and never throws.
 *
 * Repairs applied per shape type:
 *  geo / note / arrow / text (`richTextTypes`):
 *    • `props.text` (string, pre-richText era) → converted to `props.richText` object
 *    • `props.richText` missing              → created from `props.text ?? ""`
 *    • `props.richText` malformed            → re-created via toRichText()
 *    • `props.richText.attrs`                → stripped (rejected by validator)
 *  geo / note / arrow / line (`scaleTypes`):
 *    • `props.scale` missing / non-finite    → set to 1
 *
 * Returns the same object (mutates inline — the caller owns the freshly-parsed value).
 */

/** Minimal richText shape: `{ type: string, content: unknown[] }` */
function isValidRichText(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const rt = v as Record<string, unknown>;
  return typeof rt['type'] === 'string' && Array.isArray(rt['content']);
}

const RICH_TEXT_SHAPE_TYPES = new Set(['geo', 'note', 'arrow', 'text']);
const SCALE_SHAPE_TYPES      = new Set(['geo', 'note', 'arrow', 'line']);

export function sanitizeSnapshot(raw: unknown): TLEditorSnapshot {
  if (!raw || typeof raw !== 'object') return raw as TLEditorSnapshot;
  const snap = raw as Record<string, unknown>;

  // Support both legacy TLStoreSnapshot ({ schema, store }) and new TLEditorSnapshot
  // ({ document: { schema, store } }).  Walk whichever store object is present.
  const storeObj =
    (snap.store && typeof snap.store === 'object')
      ? snap.store as Record<string, unknown>
      : (snap.document && typeof snap.document === 'object')
          ? ((snap.document as Record<string, unknown>).store as Record<string, unknown> | undefined)
          : undefined;

  if (!storeObj) return raw as TLEditorSnapshot;

  let patchCount = 0;

  for (const record of Object.values(storeObj)) {
    if (!record || typeof record !== 'object') continue;
    const r = record as Record<string, unknown>;
    if (r.typeName !== 'shape') continue;

    const props = r.props;
    if (!props || typeof props !== 'object') continue;
    const p = props as Record<string, unknown>;

    // ── richText repair ───────────────────────────────────────────────────
    if (RICH_TEXT_SHAPE_TYPES.has(r.type as string)) {
      if (!isValidRichText(p.richText)) {
        // Old format: `text` was a plain string.
        const plainText = typeof p.text === 'string' ? p.text : '';
        p.richText = toRichText(plainText);
        patchCount++;
      }
      // Strip `attrs` from richText root — tldraw v4.4 validator rejects it.
      if (p.richText && typeof p.richText === 'object') {
        const rt = p.richText as Record<string, unknown>;
        if ('attrs' in rt) { delete rt['attrs']; patchCount++; }
      }
      // Remove legacy `text` prop if richText is now present (avoids unknown-prop errors).
      if ('text' in p && isValidRichText(p.richText)) { delete p['text']; }
    }

    // ── scale repair ─────────────────────────────────────────────────────
    if (SCALE_SHAPE_TYPES.has(r.type as string)) {
      if (typeof p.scale !== 'number' || !Number.isFinite(p.scale as number) || p.scale === 0) {
        p.scale = 1;
        patchCount++;
      }
    }
  }

  // ── Schema sequence version clamp ────────────────────────────────────────
  // If any sequence version in the snapshot is NEWER than what the running
  // tldraw build knows, migrateStoreSnapshot throws "migration-error".
  // Clamp each sequence down to the installed tldraw version so it can load
  // cleanly. Under-versioned sequences are left alone so forward migrations
  // still run. Unknown sequences are removed entirely (AI hallucinated types).
  try {
    const currentSeqs = getTLSequences();
    const schemaBlocks: Record<string, unknown>[] = [];
    if (snap.schema && typeof snap.schema === 'object')
      schemaBlocks.push(snap.schema as Record<string, unknown>);
    if (snap.document && typeof snap.document === 'object') {
      const doc = snap.document as Record<string, unknown>;
      if (doc.schema && typeof doc.schema === 'object')
        schemaBlocks.push(doc.schema as Record<string, unknown>);
    }
    // Guard: if currentSeqs is empty (schema init failed), skip entirely.
    // Proceeding with an empty map would delete every valid sequence from the file.
    if (Object.keys(currentSeqs).length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[canvasAI] sanitizeSnapshot: schema sequences unavailable — skipping version clamp');
    } else {
      for (const schemaObj of schemaBlocks) {
        const seqs = schemaObj['sequences'];
        if (!seqs || typeof seqs !== 'object') continue;
        for (const key of Object.keys(seqs)) {
          const storedVer = (seqs as Record<string, number>)[key];
          const knownVer  = currentSeqs[key];
          if (knownVer == null) {
            // Unknown sequence type (AI hallucination) — remove it.
            delete (seqs as Record<string, unknown>)[key];
            patchCount++;
          } else if (typeof storedVer === 'number' && storedVer > knownVer) {
            // Sequence version too new — clamp to current so no TargetVersionTooNew error.
            (seqs as Record<string, number>)[key] = knownVer;
            patchCount++;
          }
        }
      }
    }
  } catch (schemaErr) {
    // eslint-disable-next-line no-console
    console.warn('[canvasAI] sanitizeSnapshot: schema normalization failed (non-fatal):', schemaErr);
  }

  if (patchCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[canvasAI] sanitizeSnapshot: repaired ${patchCount} prop(s) in snapshot`);
  }
  return raw as TLEditorSnapshot;
}

/**
 * Render a single non-frame shape as a one-line description string.
 * Pass `frameW`/`frameH` when the shape is a child of a frame so image shapes
 * can be tagged `[BG]` when they cover ≥80% of the frame area.
 */
function describeShape(
  editor: Editor,
  shape: ReturnType<Editor['getCurrentPageShapes']>[number],
  frameW?: number,
  frameH?: number,
): string {
  const props = shape.props as {
    richText?: TLRichText;
    color?: string;
    fill?: string;
    geo?: string;
    w?: number;
    h?: number;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    text?: string;
  };
  let text = '';
  if (props.richText) {
    try { text = renderPlaintextFromRichText(editor, props.richText); } catch { /* skip */ }
  } else if (typeof props.text === 'string') {
    text = props.text;
  }
  // 10 chars — 6 chars created ~1/16M collision probability at 50 shapes which is too risky;
  // 10 chars reduces it to ~1/1T which is safe for any realistic canvas size.
  const shortId = shape.id.slice(-10);
  const x = Math.round(shape.x);
  const y = Math.round(shape.y);
  const attrs: string[] = [];
  if (props.color) attrs.push(`color:${props.color}`);
  if (props.fill && props.fill !== 'none') attrs.push(`fill:${props.fill}`);
  const anyProps = props as Record<string, unknown>;
  if (anyProps.size) attrs.push(`size:${anyProps.size}`);
  if (anyProps.font && anyProps.font !== 'sans') attrs.push(`font:${anyProps.font}`);
  const attrStr = attrs.length ? ` [${attrs.join(', ')}]` : '';
  if (shape.type === 'arrow') {
    const ap = props as unknown as { start: { x: number; y: number }; end: { x: number; y: number } };
    const sx = Math.round(shape.x + (ap.start?.x ?? 0));
    const sy = Math.round(shape.y + (ap.start?.y ?? 0));
    const ex = Math.round(shape.x + (ap.end?.x ?? 0));
    const ey = Math.round(shape.y + (ap.end?.y ?? 0));
    return `[${shortId}] arrow from (${sx},${sy}) → (${ex},${ey})` + (text ? ` label:"${text}"` : '') + attrStr;
  }
  if (shape.type === 'geo') {
    const w = props.w ? Math.round(props.w) : '?';
    const h = props.h ? Math.round(props.h) : '?';
    return `[${shortId}] ${props.geo ?? 'geo'} at (${x},${y}) size ${w}×${h}` + (text ? ` text:"${text}"` : '') + attrStr;
  }
  if (shape.type === 'image') {
    const imgProps = shape.props as { assetId?: string; w?: number; h?: number };
    const iw = typeof imgProps.w === 'number' ? imgProps.w : 0;
    const ih = typeof imgProps.h === 'number' ? imgProps.h : 0;
    const w = iw ? Math.round(iw) : '?';
    const h = ih ? Math.round(ih) : '?';
    // Tag as [BG] when this image covers ≥80% of its parent frame — helps the
    // AI identify background images without trial-and-error deletes.
    const isBg =
      frameW !== undefined && frameH !== undefined &&
      iw >= frameW * 0.8 && ih >= frameH * 0.8;
    const bgTag = isBg ? ' [BG]' : '';
    // Resolve the source URL from the asset store so the AI can identify the image.
    // Falls back to empty string if the asset can't be found (blob URLs, offline, etc.).
    let srcPart = '';
    if (imgProps.assetId) {
      try {
        const asset = editor.getAsset(imgProps.assetId as Parameters<Editor['getAsset']>[0]) as { props?: { src?: string } } | undefined;
        const src = asset?.props?.src ?? '';
        if (src && !src.startsWith('data:')) {
          // Show only the filename (last URL segment) to keep the summary concise.
          const filename = src.split('/').pop()?.split('?')[0] ?? '';
          if (filename) srcPart = ` src:"${filename.slice(0, 40)}"`;
        } else if (src.startsWith('data:')) {
          srcPart = ' src:"<data-url>"`';
        }
      } catch { /* asset store unavailable — skip */ }
    }
    return `[${shortId}] image${bgTag} at (${x},${y}) size ${w}×${h}${srcPart}`;
  }
  return `[${shortId}] ${shape.type} at (${x},${y})` + (text ? ` text:"${text}"` : '') + attrStr;
}

/**
 * Returns true when a shape is a full-frame background (image or solid-fill geo rectangle).
 * Uses `meta.isBg` marker first (set by our ops), then falls back to size heuristic so
 * older canvas files created before the marker was introduced still work.
 */
export function isBgShape(
  shape: ReturnType<Editor['getCurrentPageShapes']>[number],
  fw: number,
  fh: number,
): boolean {
  if ((shape.meta as Record<string, unknown>)?.isBg === true) return true;
  const p = shape.props as { w?: number; h?: number; fill?: string; geo?: string };
  const isFullFrame = (p.w ?? 0) >= fw * 0.8 && (p.h ?? 0) >= fh * 0.8;
  if (!isFullFrame) return false;
  if (shape.type === 'image') return true;
  if (shape.type === 'geo') return p.geo === 'rectangle' && (p.fill === 'solid' || p.fill === 'semi' || p.fill === 'pattern');
  return false;
}

/** Compute the axis-aligned bounding box for a set of shapes (parent-relative coords). */
function shapeBounds(ss: ReturnType<Editor['getCurrentPageShapes']>): { x1: number; y1: number; x2: number; y2: number } | null {
  if (ss.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of ss) {
    const p = s.props as { w?: number; h?: number };
    const w = p.w ?? 200;
    const h = p.h ?? 100;
    x1 = Math.min(x1, s.x);
    y1 = Math.min(y1, s.y);
    x2 = Math.max(x2, s.x + w);
    y2 = Math.max(y2, s.y + h);
  }
  return { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) };
}

/** Returns a short human-readable description of every shape on the canvas. */
export function summarizeCanvas(editor: Editor): string {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return 'The canvas is currently empty.';

  const page = editor.getCurrentPage();
  // Separate frames (slides) from regular shapes for clarity
  // Sort frames left-to-right by x so the summary order matches the slide strip.
  const frames = shapes.filter((s) => s.type === 'frame').sort((a, b) => (a as TLFrameShape).x - (b as TLFrameShape).x) as TLFrameShape[];
  const nonFrames = shapes.filter((s) => s.type !== 'frame');
  const lines: string[] = [
    `Canvas page: "${page.name}" — ${shapes.length} shape(s), ${frames.length} slide(s):`,
  ];

  // Build a map: frameId → shapes inside that frame
  const frameChildren = new Map<string, typeof nonFrames>();
  const freeShapes: typeof nonFrames = [];
  for (const s of nonFrames) {
    // In tldraw, shapes parented to a frame have parentId === frame.id (e.g. "shape:xxx")
    const parentFrame = frames.find((f) => f.id === s.parentId);
    if (parentFrame) {
      if (!frameChildren.has(parentFrame.id)) frameChildren.set(parentFrame.id, []);
      frameChildren.get(parentFrame.id)!.push(s);
    } else {
      freeShapes.push(s);
    }
  }

  // List frames with their children so the AI knows the hierarchical layout
  if (frames.length > 0) {
    lines.push('  Slides (frames):');
    frames.forEach((f, i) => {
      const name = (f.props as { name?: string }).name ?? `Slide ${i + 1}`;
      const children = frameChildren.get(f.id) ?? [];
      lines.push(`    [${f.id.slice(-10)}] slide ${i + 1}: "${name}" at (${Math.round(f.x)},${Math.round(f.y)}) size ${f.props.w}\u00d7${f.props.h}`);
      if (children.length === 0) {
        lines.push(`      (empty slide — free to fill entire ${f.props.w}\u00d7${f.props.h} area)`);
      } else {
        // Non-background shapes (used to calculate free space, hiding BG from bounding-box calc)
        const nonBgChildren = children.filter((s) => !isBgShape(s, f.props.w, f.props.h));
        // Show per-slide bounding box so the AI knows where free space is
        const bb = shapeBounds(nonBgChildren.length > 0 ? nonBgChildren : children);
        if (bb) {
          const freeY = bb.y2 + 20;
          lines.push(`      Occupied area: (${bb.x1},${bb.y1})\u2192(${bb.x2},${bb.y2}). Next free row starts at y\u2248${freeY}`);
        }
        for (const s of children) {
          // Pass frame dimensions so describeShape can tag background images as [BG]
          lines.push('      ' + describeShape(editor, s, f.props.w, f.props.h));
        }
      }
    });
  }

  // Non-frame shapes not parented to any slide
  const shapesToList = frames.length > 0 ? freeShapes : shapes;

  // Page-level bounding box for free shapes
  if (shapesToList.length > 0) {
    const bb = shapeBounds(shapesToList);
    if (bb) {
      lines.push(`  Page-level content occupies (${bb.x1},${bb.y1})\u2192(${bb.x2},${bb.y2}). Add new content below y\u2248${bb.y2 + 40} or right of x\u2248${bb.x2 + 40}.`);
    }
  }
  for (const shape of shapesToList) {
    lines.push('  ' + describeShape(editor, shape));
  }
  return lines.join('\n');
}

/**
 * Full AI document context for an open canvas file.
 * Includes the current shape summary AND the canvas_op tool protocol.
 */
export function canvasAIContext(editor: Editor, filename: string): string {
  return [
    `Canvas file: ${filename}`,
    summarizeCanvas(editor),
    '',
    'The summary above shows "Occupied area" and "Next free row" for each slide so you know exactly where to place new shapes without overlap.',
    'Use canvas_op to modify (one JSON object per line). Always include "slide":"<frameId>" to parent shapes inside a frame.',
    'x/y inside a slide are frame-relative: (0,0) = frame top-left, max ≈ (1280,720).',
  ].join('\n');
}

/**
 * Renders the current canvas page to a base64 PNG data URL.
 * pixelRatio 1 = screen size (~60-150 kB), 1.5 = sharper for vision sends (~150-350 kB).
 * Returns '' when the canvas is empty or rendering fails.
 */
export async function canvasToDataUrl(editor: Editor, pixelRatio = 1): Promise<string> {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return '';
  const ids = shapes.map((s) => s.id);
  try {
    const { url } = await editor.toImageDataUrl(ids, {
      format: 'png',
      pixelRatio,
      background: true,
    });
    return url;
  } catch {
    return '';
  }
}

/**
 * Compress an image data URL: scale down to `maxWidth` pixels and convert to
 * JPEG at `quality` (0–1). Helps keep vision payloads within API limits.
 *
 * Returns the original URL unchanged if it is already small (< 100 KB) or
 * if the conversion fails for any reason.
 */
export function compressDataUrl(
  dataUrl: string,
  maxWidth = 1024,
  quality = 0.7,
): Promise<string> {
  return new Promise((resolve) => {
    // Already small — no need to compress.
    if (dataUrl.length < 100_000) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve(dataUrl); // fallback: send original rather than nothing
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ── Write: parse AI response and execute commands ────────────────────────────

/**
 * Find the first ```canvas … ``` block in `aiText`, execute each JSON command
 * against the live editor, and return the count of affected shapes and the
 * IDs of any newly-created shapes.
 * Returns { count: 0, shapeIds: [] } if no canvas block is found.
 */
export function executeCanvasCommands(editor: Editor, aiText: string): { count: number; shapeIds: string[]; errors: string[] } {
  const matches = [...aiText.matchAll(/```canvas\r?\n([\s\S]*?)```/g)];
  if (matches.length === 0) return { count: 0, shapeIds: [], errors: [] };

  // Only execute the LAST block — the AI often emits an explanatory example block
  // before the real commands block, and running all blocks would duplicate shapes.
  const match = matches[matches.length - 1];
  let count = 0;
  const shapeIds: string[] = [];
  const errors: string[] = [];

  // Atomic rollback: create a history stopping point before any mutations.
  // If any command fails we bail back to this mark so the canvas is never left
  // in a partial state.
  const markId = editor.markHistoryStoppingPoint('canvas-op-batch');

  for (const line of match[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      errors.push(`JSON parse error on: ${line.slice(0, 80)}`);
      continue;
    }
    try {
      const result = runCommand(editor, parsed);
      count += result.count;
      if (result.shapeId) shapeIds.push(result.shapeId);
    } catch (e) {
      errors.push(`Command "${parsed.op}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Any error = roll back the entire batch atomically so the canvas is never
  // left partially applied. The caller will surface all error messages.
  if (errors.length > 0) {
    try { editor.bailToMark(markId); } catch { /* history may be empty — ignore */ }
    return { count: 0, shapeIds: [], errors };
  }

  return { count, shapeIds: [...new Set(shapeIds)], errors };
}

type CommandResult = { count: number; shapeId: string | null };

/** Coerce an AI-supplied number to a finite value — guards against NaN/Infinity in AI output. */
function safeCoord(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function runCommand(editor: Editor, cmd: Record<string, unknown>): CommandResult {
  const op = String(cmd.op ?? '');
  const existing = editor.getCurrentPageShapes();

  // ── add_slide (frame) ────────────────────────────────────────
  if (op === 'add_slide') {
    // Sort by x so the new slide is appended after the rightmost existing slide,
    // not after the topmost z-layer (getCurrentPageShapesSorted is z-order).
    // Re-use `existing` (already fetched above) — no need to call getCurrentPageShapes() again.
    const frames = existing
      .filter((s) => s.type === 'frame')
      .sort((a, b) => (a as TLFrameShape).x - (b as TLFrameShape).x) as TLFrameShape[];
    const last = frames[frames.length - 1];
    const sx = last ? last.x + (last.props.w ?? SLIDE_W) + SLIDE_GAP : 0;
    // Normalize y to the minimum y of all existing frames so slides always sit on the
    // same horizontal baseline — prevents a manually-dragged frame from skewing new ones.
    const sy = frames.length > 0 ? Math.min(...frames.map((f) => f.y)) : 0;
    const slideName = String(cmd.name ?? `Slide ${frames.length + 1}`);
    const slideId = createShapeId();
    editor.createShapes<TLFrameShape>([{
      id: slideId,
      type: 'frame',
      x: sx,
      y: sy,
      props: { w: SLIDE_W, h: SLIDE_H, name: slideName },
    }]);
    return { count: 1, shapeId: slideId };
  }

  // ── clear ────────────────────────────────────────────────────
  if (op === 'clear') {
    // Require an explicit confirmation field to prevent accidental wipes from
    // a hallucinated or malformed command.
    if (cmd.confirm !== 'yes') {
      console.warn('[canvasAI] clear op blocked: missing confirm:"yes"');
      return { count: 0, shapeId: null };
    }
    if (existing.length > 0) editor.deleteShapes(existing.map((s) => s.id as TLShapeId));
    return { count: existing.length, shapeId: null };
  }

  // ── delete ───────────────────────────────────────────────────
  if (op === 'delete') {
    const suffix = String(cmd.id ?? '');
    // Empty suffix matches every shape via .endsWith('') — guard to avoid
    // silently deleting the first shape when the AI omits the "id" field.
    if (!suffix) return { count: 0, shapeId: null };
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) return { count: 0, shapeId: null };
    editor.deleteShapes([target.id as TLShapeId]);
    return { count: 1, shapeId: null };
  }

  // ── update ───────────────────────────────────────────────────
  if (op === 'update') {
    const suffix = String(cmd.id ?? '');
    // Guard empty suffix — endsWith('') matches everything, so omitting "id"
    // would otherwise silently update the first shape on the canvas.
    if (!suffix) throw new Error('Missing "id" field on update command — call list_canvas_shapes to find shape IDs.');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) throw new Error(`Shape not found: "${suffix}" — call list_canvas_shapes to get valid IDs.`);
    // Require at least one updatable field — avoids silent no-ops
    if (cmd.text === undefined && cmd.color === undefined && cmd.fill === undefined &&
        cmd.size === undefined && cmd.font === undefined && cmd.align === undefined)
      return { count: 0, shapeId: null };

    // Shape-type aware update — prevents writing richText into shapes that don't
    // support it (image, bookmark, etc.) which would corrupt the store JSON.
    const RICH_TEXT_TYPES = new Set(['note', 'text', 'geo', 'arrow']);
    if (target.type === 'frame') {
      // Frame labels are stored in props.name (plain string), not richText.
      const patch: Record<string, unknown> = {};
      if (cmd.text !== undefined) patch.name = String(cmd.text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShapes([{ id: target.id, type: 'frame', props: patch } as any]);
    } else if (RICH_TEXT_TYPES.has(target.type)) {
      const patch: Record<string, unknown> = {};
      if (cmd.text  !== undefined) patch.richText = toRichText(String(cmd.text));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (cmd.color !== undefined) patch.color = mapColor(cmd.color, (target.props as any).color);
      if (cmd.fill  !== undefined) patch.fill  = mapFill(cmd.fill);
      if (cmd.size  !== undefined) patch.size  = mapSize(cmd.size);
      if (cmd.font  !== undefined) patch.font  = mapFont(cmd.font);
      if (cmd.align !== undefined) {
        // text shapes use 'textAlign'; note/geo/arrow use 'align'
        if (target.type === 'text') patch.textAlign = mapAlign(cmd.align);
        else patch.align = mapAlign(cmd.align);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.updateShapes([{ id: target.id, type: target.type, props: patch } as any]);
    } else {
      // Shape type doesn't support these props (image, bookmark, etc.) — skip.
      return { count: 0, shapeId: null };
    }
    // Return the shape ID so the parent can record it in an AI mark highlight.
    return { count: 1, shapeId: target.id };
  }
  // ── move ─────────────────────────────────────────────────
  if (op === 'move') {
    const suffix = String(cmd.id ?? '');
    // Guard empty suffix — same empty-id risk as update above.
    if (!suffix) throw new Error('Missing "id" field on move command — call list_canvas_shapes to find shape IDs.');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) throw new Error(`Shape not found: "${suffix}" — call list_canvas_shapes to get valid IDs.`);
    // Use safeCoord so string numbers (e.g. "300") are coerced correctly
    // rather than silently falling back to the shape's current position.
    const newX = safeCoord(cmd.x, target.x);
    const newY = safeCoord(cmd.y, target.y);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShapes([{ id: target.id, type: target.type, x: newX, y: newY } as any]);
    // Return the shape ID so the parent can record it in an AI mark highlight.
    return { count: 1, shapeId: target.id };
  }
  // ── auto-position new shapes (cascade so they don't all stack at 0,0) ────
  // safeCoord guards against NaN/Infinity that the AI may accidentally emit.
  const idx = existing.length;
  const x = safeCoord(cmd.x, 100 + (idx % 5) * 220);
  const y = safeCoord(cmd.y, 100 + Math.floor(idx / 5) * 160);

  // Optional slide/frame parentage — when the AI supplies "slide":"<frameId>"
  // the shape is parented directly inside that frame so it's grouped with it.
  // Coordinates are then PARENT-RELATIVE (0,0 = frame top-left), matching what
  // the canvas summary shows as frame-relative child positions.
  const parentFrameId = cmd.slide
    ? (existing.find((s) => s.type === 'frame' && s.id.endsWith(String(cmd.slide)))?.id as TLShapeId | undefined)
    : undefined;

  // ── add_note (sticky note) ───────────────────────────────────
  if (op === 'add_note') {
    const noteId = createShapeId();
    editor.createShapes<TLNoteShape>([{
      id: noteId,
      type: 'note',
      ...(parentFrameId ? { parentId: parentFrameId } : {}),
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'yellow'),
        size: mapSize(cmd.size, 'm'),
        font: mapFont(cmd.font, 'sans'),
        align: mapAlign(cmd.align, 'middle'),
      },
    }]);
    return { count: 1, shapeId: noteId };
  }

  // ── add_text (freestanding text label) ───────────────────────
  if (op === 'add_text') {
    const textId = createShapeId();
    editor.createShapes<TLTextShape>([{
      id: textId,
      type: 'text',
      ...(parentFrameId ? { parentId: parentFrameId } : {}),
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'black'),
        size: mapSize(cmd.size, 'm'),
        font: mapFont(cmd.font, 'sans'),
        textAlign: mapAlign(cmd.align, 'start'),
        autoSize: true,
      },
    }]);
    return { count: 1, shapeId: textId };
  }

  // ── add_geo (rectangle, ellipse, triangle, …) ────────────────
  if (op === 'add_geo') {
    const VALID_GEO = new Set([
      'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
      'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
      'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down',
      'x-box', 'check-box', 'cloud', 'heart',
    ]);
    const rawGeo = String(cmd.geo ?? 'rectangle');
    if (!VALID_GEO.has(rawGeo)) throw new Error(`Unknown geo type "${rawGeo}". Valid types: ${[...VALID_GEO].join(', ')}.`);
    const geoVal = rawGeo as TLGeoShapeGeoStyle;
    const geoId = createShapeId();
    editor.createShapes<TLGeoShape>([{
      id: geoId,
      type: 'geo',
      ...(parentFrameId ? { parentId: parentFrameId } : {}),
      x,
      y,
      props: {
        geo: geoVal,
        w: safeCoord(cmd.w, 200),
        h: safeCoord(cmd.h, 120),
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'blue'),
        fill: mapFill(cmd.fill),
        size: mapSize(cmd.size, 'm'),
        font: mapFont(cmd.font, 'sans'),
        align: mapAlign(cmd.align, 'middle'),
        // Always set scale explicitly — tldraw v4.4+ validates that scale is a
        // number and throws a ValidationError if the prop is missing or non-numeric.
        scale: 1,
      },
    }]);
    return { count: 1, shapeId: geoId };
  }

  // ── add_arrow (free-standing arrow between two points) ───────
  if (op === 'add_arrow') {
    const x1 = safeCoord(cmd.x1, x);
    const y1 = safeCoord(cmd.y1, y);
    const x2 = safeCoord(cmd.x2, x1 + 200);
    const y2 = safeCoord(cmd.y2, y1);
    const label = String(cmd.label ?? cmd.text ?? '');
    const arrowId = createShapeId();
    editor.createShapes<TLArrowShape>([{
      id: arrowId,
      type: 'arrow',
      ...(parentFrameId ? { parentId: parentFrameId } : {}),
      x: x1,
      y: y1,
      props: {
        start: { x: 0, y: 0 },
        end: { x: x2 - x1, y: y2 - y1 },
        richText: toRichText(label),
        color: mapColor(cmd.color, 'grey'),
        arrowheadEnd: 'arrow',
        arrowheadStart: 'none',
      } as TLArrowShape['props'],
    }]);
    return { count: 1, shapeId: arrowId };
  }

  // ── Helper: create an image asset + shape ─────────────────────
  // Shared by add_image, set_slide_background, copy_slide_background, apply_theme.
  // Pass isBg=true to mark the shape with meta.isBg so background detection is reliable
  // regardless of size (avoids false-positives for large content images).
  function _createImageShape(
    url: string,
    name: string,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    parentId?: TLShapeId,
    isBg = false,
  ): string {
    const assetId = `asset:${crypto.randomUUID()}` as unknown as ReturnType<typeof createShapeId>;
    editor.createAssets([{
      id: assetId,
      typeName: 'asset',
      type: 'image',
      props: {
        name,
        src: url,
        w: sw,
        h: sh,
        mimeType: url.match(/\.png(\?|$)/i) ? 'image/png'
          : url.match(/\.gif(\?|$)/i) ? 'image/gif'
          : url.match(/\.webp(\?|$)/i) ? 'image/webp'
          : url.match(/\.svg(\?|$)/i) ? 'image/svg+xml'
          : 'image/jpeg',
        isAnimated: false,
      },
      meta: {},
    } as any]);
    const imgId = createShapeId();
    editor.createShapes([{
      id: imgId,
      type: 'image',
      x: sx,
      y: sy,
      ...(parentId ? { parentId } : {}),
      meta: isBg ? { isBg: true } : {},
      props: {
        assetId,
        w: sw,
        h: sh,
        playing: true,
        url: '',
        crop: null,
        flipX: false,
        flipY: false,
        altText: '',
      } as any,
    }]);
    return imgId;
  }

  // ── Helper: create a solid-color full-frame background rectangle ──────────
  // Creates a geo rectangle tagged with meta.isBg so it's reliably identified
  // as a background by isBgShape() — not confused with content rectangles.
  function _createColorBgShape(
    color: TLColor,
    fw: number,
    fh: number,
    parentId?: TLShapeId,
  ): string {
    const bgId = createShapeId();
    editor.createShapes<TLGeoShape>([{
      id: bgId,
      type: 'geo',
      x: 0,
      y: 0,
      meta: { isBg: true },
      ...(parentId ? { parentId } : {}),
      props: {
        geo: 'rectangle',
        w: fw,
        h: fh,
        richText: toRichText(''),
        color,
        fill: 'solid',
        scale: 1,
      },
    }]);
    return bgId;
  }

  // ── Helper: reliably place a background shape behind all frame content ─────
  // sendToBack alone can fail silently for shapes inside a tldraw frame because
  // the z-order is frame-local and some tldraw versions apply it page-globally.
  // Double-fix: send bg to back AND bringToFront on every other frame child,
  // so the result is correct regardless of which side works.
  function _sendBgToBack(bgId: string, frameId: TLShapeId) {
    try { editor.sendToBack([bgId as TLShapeId]); } catch { /* older tldraw */ }
    // bringToFront on all siblings guarantees content is above the background
    // even if sendToBack had no effect within the frame context.
    const siblings = editor.getCurrentPageShapes().filter(
      (s) => s.parentId === frameId && s.id !== bgId,
    );
    if (siblings.length > 0) {
      try { editor.bringToFront(siblings.map((s) => s.id as TLShapeId)); } catch { /* older tldraw */ }
    }
  }

  // ── add_image ─────────────────────────────────────────────────
  // Place an image inside a slide (or free page) via canvas_op.
  // Example: {"op":"add_image","url":"https://…","x":0,"y":0,"w":1280,"h":720,"slide":"frameId","to_back":true}
  if (op === 'add_image') {
    const url = String(cmd.url ?? '').trim();
    if (!url) throw new Error('add_image requires a "url" field.');
    const imgW = safeCoord(cmd.w, parentFrameId ? SLIDE_W : 800);
    const imgH = safeCoord(cmd.h, parentFrameId ? SLIDE_H : 600);
    const imgX = safeCoord(cmd.x, 0);
    const imgY = safeCoord(cmd.y, 0);
    const imgName = url.split('/').pop()?.split('?')[0] ?? 'image';
    const imgId = _createImageShape(url, imgName, imgX, imgY, imgW, imgH, parentFrameId);
    if (cmd.to_back && parentFrameId) {
      _sendBgToBack(imgId, parentFrameId);
    } else if (cmd.to_back) {
      try { editor.sendToBack([imgId as TLShapeId]); } catch { /* older tldraw */ }
    }
    return { count: 1, shapeId: imgId };
  }

  // ── set_slide_background ──────────────────────────────────────
  // Fill an entire slide with a background image OR solid color, sent to back.
  // Removes all existing bg shapes (image or color rect) before placing the new one.
  // Examples:
  //   {"op":"set_slide_background","url":"https://…","slide":"frameId"}        ← image bg
  //   {"op":"set_slide_background","color":"blue","slide":"frameId"}            ← solid color bg
  if (op === 'set_slide_background') {
    const url = String(cmd.url ?? '').trim();
    const colorRaw = cmd.color ? String(cmd.color).trim() : '';
    if (!url && !colorRaw) throw new Error('set_slide_background requires either a "url" or a "color" field.');
    const slideId = String(cmd.slide ?? '').trim();
    if (!slideId) throw new Error('set_slide_background requires a "slide" field (last-10-char frame ID).');
    const frame = existing.find((s) => s.type === 'frame' && s.id.endsWith(slideId)) as TLFrameShape | undefined;
    if (!frame) throw new Error(`Slide not found: "${slideId}". Call list_canvas_shapes to get valid frame IDs.`);
    const fw = (frame.props as { w: number }).w ?? SLIDE_W;
    const fh = (frame.props as { h: number }).h ?? SLIDE_H;
    // Remove ALL existing background shapes (image or solid-geo) using the shared helper
    const children = existing.filter((s) => s.parentId === frame.id);
    const toRemove = children.filter((s) => isBgShape(s, fw, fh));
    if (toRemove.length > 0) editor.deleteShapes(toRemove.map((s) => s.id as TLShapeId));
    let bgId: string;
    if (url) {
      const imgName = url.split('/').pop()?.split('?')[0] ?? 'bg';
      bgId = _createImageShape(url, imgName, 0, 0, fw, fh, frame.id as TLShapeId, true);
    } else {
      bgId = _createColorBgShape(mapColor(colorRaw, 'grey'), fw, fh, frame.id as TLShapeId);
    }
    _sendBgToBack(bgId, frame.id as TLShapeId);
    return { count: 1, shapeId: bgId };
  }

  // ── copy_slide_background ─────────────────────────────────────
  // Copy background (image OR solid color) from one slide to one or more others.
  // Handles both image backgrounds and color-rect backgrounds created by set_slide_background.
  // Example: {"op":"copy_slide_background","from_slide":"abc1234567","to_slides":["def1234567","ghi1234567"]}
  if (op === 'copy_slide_background') {
    const fromId = String(cmd.from_slide ?? '').trim();
    if (!fromId) throw new Error('copy_slide_background requires a "from_slide" field.');
    const rawToSlides = Array.isArray(cmd.to_slides) ? cmd.to_slides.map(String) : [];
    if (rawToSlides.length === 0) throw new Error('copy_slide_background requires a "to_slides" array with at least one frame ID.');
    const fromFrame = existing.find((s) => s.type === 'frame' && s.id.endsWith(fromId)) as TLFrameShape | undefined;
    if (!fromFrame) throw new Error(`Source slide not found: "${fromId}"`);
    const fw = (fromFrame.props as { w: number }).w ?? SLIDE_W;
    const fh = (fromFrame.props as { h: number }).h ?? SLIDE_H;
    // Find ALL background shapes in source (image OR solid-color geo rect)
    const srcBgs = existing.filter((s) => s.parentId === fromFrame.id && isBgShape(s, fw, fh));
    if (srcBgs.length === 0) throw new Error(`No background found in source slide "${fromId}". Set a background with set_slide_background first.`);

    let total = 0;
    let lastId: string | null = null;
    for (const toSuffix of rawToSlides) {
      const toFrame = existing.find((s) => s.type === 'frame' && s.id.endsWith(toSuffix)) as TLFrameShape | undefined;
      if (!toFrame) continue;
      const tw = (toFrame.props as { w: number }).w ?? SLIDE_W;
      const th = (toFrame.props as { h: number }).h ?? SLIDE_H;
      // Remove existing backgrounds in target
      const tgtBgs = existing.filter((s) => s.parentId === toFrame.id && isBgShape(s, tw, th));
      if (tgtBgs.length > 0) editor.deleteShapes(tgtBgs.map((s) => s.id as TLShapeId));
      // Reproduce all source backgrounds in the target frame
      for (const bg of srcBgs) {
        let newId: string | null = null;
        if (bg.type === 'image') {
          const srcProps = bg.props as { assetId?: string };
          let srcUrl = '';
          if (srcProps.assetId) {
            try {
              const asset = editor.getAsset(srcProps.assetId as any) as { props?: { src?: string } } | undefined;
              srcUrl = asset?.props?.src ?? '';
            } catch { /* ignore */ }
          }
          if (!srcUrl) continue;
          const imgName = srcUrl.split('/').pop()?.split('?')[0] ?? 'bg';
          newId = _createImageShape(srcUrl, imgName, 0, 0, tw, th, toFrame.id as TLShapeId, true);
        } else if (bg.type === 'geo') {
          const gp = bg.props as { color?: string };
          newId = _createColorBgShape(mapColor(gp.color, 'grey'), tw, th, toFrame.id as TLShapeId);
        }
        if (!newId) continue;
        _sendBgToBack(newId, toFrame.id as TLShapeId);
        lastId = newId;
        total++;
      }
    }
    if (total === 0) throw new Error('No backgrounds were copied. Check that the source slide has a background and the target IDs are correct.');
    return { count: total, shapeId: lastId };
  }

  // ── apply_theme ────────────────────────────────────────────────────────────
  // Batch-apply a background (image or color) and/or text color to ALL slides
  // (or a specified subset) in a single call. Never touches shape positions or content.
  // Examples:
  //   {"op":"apply_theme","bg_color":"black","text_color":"white","to_slides":"all"}
  //   {"op":"apply_theme","bg_url":"https://…","to_slides":["abc1234567","def1234567"]}
  //   {"op":"apply_theme","bg_color":"violet","to_slides":"all"}  ← bg only, keep text colors
  if (op === 'apply_theme') {
    const bgUrl = String(cmd.bg_url ?? '').trim();
    const bgColor = cmd.bg_color ? String(cmd.bg_color).trim() : '';
    const textColorRaw = cmd.text_color ? String(cmd.text_color).trim() : '';
    if (!bgUrl && !bgColor && !textColorRaw)
      throw new Error('apply_theme requires at least one of: bg_url, bg_color, text_color.');

    const allFrames = existing.filter((s) => s.type === 'frame') as TLFrameShape[];
    if (allFrames.length === 0) throw new Error('No slides found. Create slides with add_slide first.');

    // Resolve target frames: "all" or array of last-10-char IDs
    const rawTarget = cmd.to_slides;
    let targetFrames: TLFrameShape[];
    if (!rawTarget || rawTarget === 'all' || (Array.isArray(rawTarget) && (rawTarget as string[]).includes('all'))) {
      targetFrames = allFrames;
    } else {
      const ids = (Array.isArray(rawTarget) ? rawTarget : [rawTarget]).map(String);
      targetFrames = allFrames.filter((f) => ids.some((id) => f.id.endsWith(id)));
      if (targetFrames.length === 0)
        throw new Error('No slides matched the given IDs. Call list_canvas_shapes to get valid frame IDs.');
    }

    let total = 0;
    let lastBgId: string | null = null;

    for (const frame of targetFrames) {
      const fw = (frame.props as { w: number }).w ?? SLIDE_W;
      const fh = (frame.props as { h: number }).h ?? SLIDE_H;
      const children = existing.filter((s) => s.parentId === frame.id);

      // Apply background (replaces any existing bg)
      if (bgUrl || bgColor) {
        const toRemove = children.filter((s) => isBgShape(s, fw, fh));
        if (toRemove.length > 0) editor.deleteShapes(toRemove.map((s) => s.id as TLShapeId));
        let bgId: string;
        if (bgUrl) {
          const imgName = bgUrl.split('/').pop()?.split('?')[0] ?? 'bg';
          bgId = _createImageShape(bgUrl, imgName, 0, 0, fw, fh, frame.id as TLShapeId, true);
        } else {
          bgId = _createColorBgShape(mapColor(bgColor, 'grey'), fw, fh, frame.id as TLShapeId);
        }
        _sendBgToBack(bgId, frame.id as TLShapeId);
        lastBgId = bgId;
        total++;
      }

      // Recolor all content (text, note, geo, arrow) — never touches images or backgrounds
      if (textColorRaw) {
        const mappedColor = mapColor(textColorRaw, 'black');
        const contentShapes = children.filter((s) =>
          !isBgShape(s, fw, fh) && ['note', 'text', 'geo', 'arrow'].includes(s.type),
        );
        for (const s of contentShapes) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.updateShapes([{ id: s.id, type: s.type, props: { color: mappedColor } } as any]);
          total++;
        }
      }
    }

    return { count: total, shapeId: lastBgId };
  }

  // ── recolor_slide ──────────────────────────────────────────────────────────
  // Recolor all text/note and/or geo shapes in a slide to match a theme.
  // Does NOT touch backgrounds, images, or shape positions.
  // Examples:
  //   {"op":"recolor_slide","slide":"abc1234567","text_color":"white"}
  //   {"op":"recolor_slide","slide":"abc1234567","text_color":"white","geo_color":"light-blue"}
  if (op === 'recolor_slide') {
    const slideId = String(cmd.slide ?? '').trim();
    if (!slideId) throw new Error('recolor_slide requires a "slide" field (last-10-char frame ID).');
    const frame = existing.find((s) => s.type === 'frame' && s.id.endsWith(slideId)) as TLFrameShape | undefined;
    if (!frame) throw new Error(`Slide not found: "${slideId}". Call list_canvas_shapes to get valid frame IDs.`);
    const fw = (frame.props as { w: number }).w ?? SLIDE_W;
    const fh = (frame.props as { h: number }).h ?? SLIDE_H;

    const textColorRaw = cmd.text_color ? String(cmd.text_color).trim() : '';
    // geo_color defaults to text_color if not specified
    const geoColorRaw = cmd.geo_color ? String(cmd.geo_color).trim() : textColorRaw;
    if (!textColorRaw && !geoColorRaw)
      throw new Error('recolor_slide requires at least "text_color" or "geo_color".');

    const children = existing.filter((s) => s.parentId === frame.id && !isBgShape(s, fw, fh));
    let total = 0;

    if (textColorRaw) {
      const cls = mapColor(textColorRaw, 'black');
      for (const s of children.filter((cs) => ['note', 'text', 'arrow'].includes(cs.type))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShapes([{ id: s.id, type: s.type, props: { color: cls } } as any]);
        total++;
      }
    }
    if (geoColorRaw) {
      const gc = mapColor(geoColorRaw, 'blue');
      for (const s of children.filter((cs) => cs.type === 'geo')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShapes([{ id: s.id, type: s.type, props: { color: gc } } as any]);
        total++;
      }
    }

    return { count: total, shapeId: null };
  }

  // ── duplicate_slide ───────────────────────────────────────────────────────
  // Deep-copy a slide (frame + all its content: notes, text, geo, arrows, images).
  // The new slide is appended after the rightmost existing frame.
  // Example: {"op":"duplicate_slide","slide":"abc1234567","name":"Slide 3"}
  if (op === 'duplicate_slide') {
    const srcSuffix = String(cmd.slide ?? '').trim();
    if (!srcSuffix) throw new Error('duplicate_slide requires a "slide" field (last-10-char frame ID). Call list_canvas_shapes to get the ID.');
    const srcFrame = existing.find((s) => s.type === 'frame' && s.id.endsWith(srcSuffix)) as TLFrameShape | undefined;
    if (!srcFrame) throw new Error(`Slide not found: "${srcSuffix}". Call list_canvas_shapes to get valid frame IDs.`);

    const frames = existing
      .filter((s) => s.type === 'frame')
      .sort((a, b) => (a as TLFrameShape).x - (b as TLFrameShape).x) as TLFrameShape[];
    const last = frames[frames.length - 1];
    const newX = last.x + (last.props.w ?? SLIDE_W) + SLIDE_GAP;
    const newY = Math.min(...frames.map((f) => f.y));

    const fw = (srcFrame.props as { w: number }).w ?? SLIDE_W;
    const fh = (srcFrame.props as { h: number }).h ?? SLIDE_H;
    const newName = String(cmd.name ?? srcFrame.props.name ?? `Slide ${frames.length + 1}`);
    const newFrameId = createShapeId();
    editor.createShapes<TLFrameShape>([{
      id: newFrameId,
      type: 'frame',
      x: newX,
      y: newY,
      props: { w: fw, h: fh, name: newName },
    }]);

    // Copy all direct children of the source frame.
    // Order: backgrounds first (sendToBack), then content on top — matches z-order intent.
    const children = existing.filter((s) => s.parentId === srcFrame.id);
    const bgChildren = children.filter((s) => isBgShape(s, fw, fh));
    const contentChildren = children.filter((s) => !isBgShape(s, fw, fh));

    let copied = 0;

    const copyChild = (child: typeof children[0]) => {
      const cp = child.props as Record<string, unknown>;
      if (child.type === 'note') {
        editor.createShapes<TLNoteShape>([{
          id: createShapeId(), type: 'note',
          parentId: newFrameId, x: child.x, y: child.y,
          props: {
            richText: cp.richText as TLRichText ?? toRichText(''),
            color: (cp.color as TLColor) ?? 'yellow',
          },
        }]);
        copied++;
      } else if (child.type === 'text') {
        editor.createShapes<TLTextShape>([{
          id: createShapeId(), type: 'text',
          parentId: newFrameId, x: child.x, y: child.y,
          props: {
            richText: cp.richText as TLRichText ?? toRichText(''),
            color: (cp.color as TLColor) ?? 'black',
            autoSize: (cp.autoSize as boolean) ?? true,
            w: safeCoord(cp.w, 200),
            scale: safeCoord(cp.scale, 1),
          },
        }]);
        copied++;
      } else if (child.type === 'geo') {
        const childIsBg = isBgShape(child, fw, fh);
        const geoId = createShapeId();
        editor.createShapes<TLGeoShape>([{
          id: geoId, type: 'geo',
          meta: childIsBg ? { isBg: true } : {},
          parentId: newFrameId, x: child.x, y: child.y,
          props: {
            geo: (cp.geo as TLGeoShapeGeoStyle) ?? 'rectangle',
            w: safeCoord(cp.w, 200), h: safeCoord(cp.h, 120),
            richText: cp.richText as TLRichText ?? toRichText(''),
            color: (cp.color as TLColor) ?? 'blue',
            fill: mapFill(cp.fill),
            scale: 1,
          },
        }]);
        if (childIsBg) { try { editor.sendToBack([geoId as TLShapeId]); } catch { /* older tldraw */ } }
        copied++;
      } else if (child.type === 'arrow') {
        const ap = cp as { start?: { x: number; y: number }; end?: { x: number; y: number }; richText?: TLRichText; color?: string; arrowheadEnd?: string; arrowheadStart?: string };
        editor.createShapes<TLArrowShape>([{
          id: createShapeId(), type: 'arrow',
          parentId: newFrameId, x: child.x, y: child.y,
          props: {
            start: ap.start ?? { x: 0, y: 0 },
            end: ap.end ?? { x: 200, y: 0 },
            richText: ap.richText ?? toRichText(''),
            color: mapColor(ap.color, 'grey'),
            arrowheadEnd: (ap.arrowheadEnd as TLArrowShape['props']['arrowheadEnd']) ?? 'arrow',
            arrowheadStart: (ap.arrowheadStart as TLArrowShape['props']['arrowheadStart']) ?? 'none',
          } as TLArrowShape['props'],
        }]);
        copied++;
      } else if (child.type === 'image') {
        const imgP = cp as { assetId?: string; w?: number; h?: number };
        let srcUrl = '';
        if (imgP.assetId) {
          try {
            const asset = editor.getAsset(imgP.assetId as Parameters<Editor['getAsset']>[0]) as { props?: { src?: string } } | undefined;
            srcUrl = asset?.props?.src ?? '';
          } catch { /* ignore */ }
        }
        if (srcUrl) {
          const imgW = safeCoord(imgP.w, fw);
          const imgH = safeCoord(imgP.h, fh);
          const childIsBg = isBgShape(child, fw, fh);
          const imgName = srcUrl.split('/').pop()?.split('?')[0] ?? 'image';
          const imgId = _createImageShape(srcUrl, imgName, child.x, child.y, imgW, imgH, newFrameId, childIsBg);
          if (childIsBg) { try { editor.sendToBack([imgId as TLShapeId]); } catch { /* older tldraw */ } }
          copied++;
        }
      }
      // Nested frames and other unknown shape types are skipped
    };

    // Backgrounds first (they end up behind content via sendToBack)
    for (const bg of bgChildren) { try { copyChild(bg); } catch { /* skip */ } }
    // Then content shapes on top
    for (const content of contentChildren) { try { copyChild(content); } catch { /* skip */ } }

    // Final z-order fix: ensure ALL bg shapes in the new frame are behind content.
    // This corrects any z-order issues from the per-shape sendToBack calls above
    // (which can be unreliable within a frame in tldraw v4).
    const newBgs = editor.getCurrentPageShapes().filter(
      (s) => s.parentId === newFrameId && isBgShape(s, fw, fh),
    );
    for (const bg of newBgs) { _sendBgToBack(bg.id, newFrameId); }

    return { count: 1 + copied, shapeId: newFrameId };
  }

  return { count: 0, shapeId: null };
}

// ── Shared image-placement helper ────────────────────────────────────────────
/**
 * Create a tldraw image asset + shape in a single call.
 *
 * Placement priority (first wins):
 *   1. `opts.x` / `opts.y`  — explicit top-left page coords (AI tool semantics)
 *   2. `opts.dropX` / `opts.dropY` — mouse-drop page center (drag-drop semantics)
 *   3. No coords — center in the current viewport
 *
 * `opts.width` overrides the default display width (capped at 800 px otherwise).
 */
export interface PlaceImageOpts {
  /** Explicit top-left page X (AI / direct placement). */
  x?: number;
  /** Explicit top-left page Y. */
  y?: number;
  /** Mouse-drop page center X (shape will be centered on this point). */
  dropX?: number;
  /** Mouse-drop page center Y. */
  dropY?: number;
  /** Override display width in pixels. */
  width?: number;
}

export function placeImageOnCanvas(
  editor: Editor,
  src: string,
  name: string,
  mimeType: string,
  natW: number,
  natH: number,
  opts: PlaceImageOpts = {},
): { x: number; y: number; w: number; h: number } {
  const maxW = 800;
  const desiredW = typeof opts.width === 'number' ? opts.width : Math.min(natW, maxW);
  const scale = natW > 0 ? desiredW / natW : 1;
  const dispW = Math.round(desiredW);
  const dispH = Math.round(natH * scale);

  let px: number, py: number;
  if (opts.x !== undefined && opts.y !== undefined) {
    // Explicit top-left coords — used by AI tools
    px = Math.round(opts.x);
    py = Math.round(opts.y);
  } else if (opts.dropX !== undefined && opts.dropY !== undefined) {
    // Mouse-drop — center shape on the drop point
    px = Math.round(opts.dropX - dispW / 2);
    py = Math.round(opts.dropY - dispH / 2);
  } else {
    // Fallback — viewport centre
    const vp = editor.getViewportPageBounds();
    px = Math.round(vp.x + vp.w / 2 - dispW / 2);
    py = Math.round(vp.y + vp.h / 2 - dispH / 2);
  }

  // Generate a unique asset ID in tldraw's expected "asset:<id>" format.
  // crypto.randomUUID() gives 128-bit uniqueness — far better than Math.random().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assetId = `asset:${crypto.randomUUID()}` as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', props: { name, src, w: natW, h: natH, mimeType, isAnimated: mimeType === 'image/gif' }, meta: {} } as any]);
  // Explicitly set all tldraw v4 image shape props so legacy canvas files that
  // pre-date fields like `altText` (added in v4.4.0) don't hit schema gaps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.createShape({ type: 'image', x: px, y: py, props: { assetId, w: dispW, h: dispH, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' } as any });
  return { x: px, y: py, w: dispW, h: dispH };
}
