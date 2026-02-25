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
 *   {"op":"update",    "id":"abc123", "text":"New text"}
 *   {"op":"delete",    "id":"abc123"}
 *   {"op":"clear"}
 *
 * "id" values match the last-6-characters of a shape ID shown in the summary.
 *
 * NOTE: add_slide is the only way to create a frame/slide. After creation the
 * CanvasEditor store listener automatically applies the current theme to it.
 */

import type { Editor, TLRichText } from 'tldraw';
import { createShapeId, renderPlaintextFromRichText, toRichText } from 'tldraw';
import type { TLNoteShape, TLGeoShape, TLTextShape, TLGeoShapeGeoStyle, TLArrowShape, TLFrameShape } from '@tldraw/tlschema';

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

export function mapFill(raw: unknown): TLFill {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'none' || s === 'semi' || s === 'solid' || s === 'pattern') return s as TLFill;
  return 'solid';
}

export function mapColor(raw: unknown, fallback: TLColor = 'yellow'): TLColor {
  return COLOR_MAP[String(raw ?? '').toLowerCase()] ?? fallback;
}

/** Render a single non-frame shape as a one-line description string. */
function describeShape(editor: Editor, shape: ReturnType<Editor['getCurrentPageShapes']>[number]): string {
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
  const shortId = shape.id.slice(-6);
  const x = Math.round(shape.x);
  const y = Math.round(shape.y);
  const attrs: string[] = [];
  if (props.color) attrs.push(`color:${props.color}`);
  if (props.fill && props.fill !== 'none') attrs.push(`fill:${props.fill}`);
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
  return `[${shortId}] ${shape.type} at (${x},${y})` + (text ? ` text:"${text}"` : '') + attrStr;
}

/** Returns a short human-readable description of every shape on the canvas. */
export function summarizeCanvas(editor: Editor): string {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return 'The canvas is currently empty.';

  const page = editor.getCurrentPage();
  // Separate frames (slides) from regular shapes for clarity
  const frames = shapes.filter((s) => s.type === 'frame') as TLFrameShape[];
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
      lines.push(`    [${f.id.slice(-6)}] slide ${i + 1}: "${name}" at (${Math.round(f.x)},${Math.round(f.y)}) size ${f.props.w}×${f.props.h}`);
      const children = frameChildren.get(f.id) ?? [];
      if (children.length === 0) {
        lines.push(`      (empty slide)`);
      } else {
        for (const s of children) {
          lines.push('      ' + describeShape(editor, s));
        }
      }
    });
  }

  // Non-frame shapes not parented to any slide
  const shapesToList = frames.length > 0 ? freeShapes : shapes;

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
    'To modify the canvas use the canvas_op tool (call it with a "commands" argument).',
    'Each command is a JSON object on its own line. Supported ops:',
    '  {"op":"add_slide","name":"Slide title"}          ← create a new 16:9 frame/slide (appended after the last existing one)',
    '  {"op":"add_note","text":"Your text","x":100,"y":100,"color":"yellow"}',
    '  {"op":"add_text","text":"Your text","x":100,"y":200,"color":"black"}',
    '  {"op":"add_geo","geo":"rectangle","text":"Label","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid"}',
    '  {"op":"add_arrow","x1":100,"y1":100,"x2":400,"y2":200,"label":"depends on","color":"grey"}',
    '  {"op":"update","id":"abc123","text":"New text"}  ← id = last 6 chars of shape ID above',
    '  {"op":"move","id":"abc123","x":300,"y":400}       ← reposition a shape',
    '  {"op":"delete","id":"abc123"}',
    '  {"op":"clear"}                                   ← removes all shapes',
    'Slide note: when adding content to a specific slide, use x/y coordinates relative to that slide\'s frame position (shown in the summary).',
    'To populate a slide, add_slide first, then add shapes whose x/y are offset from the slide origin.',
    'Valid colors: yellow, blue, green, red, orange, violet, grey, black, white, light-blue, light-green, light-red, light-violet',
    'Valid geo shapes: rectangle, ellipse, triangle, diamond, hexagon, cloud, star, arrow-right',
    'Canvas coordinates: (0,0) is top-left; a typical 16:9 view is ~2200 wide × 1400 tall.',
    'Plan layouts thoughtfully: use consistent spacing (e.g. 240px columns, 160px rows) so shapes do not overlap.',
    'Use color to signal meaning: yellow=idea, blue=process, green=outcome, red=risk, grey=connection.',
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

// ── Write: parse AI response and execute commands ────────────────────────────

/**
 * Find the first ```canvas … ``` block in `aiText`, execute each JSON command
 * against the live editor, and return the count of affected shapes and the
 * IDs of any newly-created shapes.
 * Returns { count: 0, shapeIds: [] } if no canvas block is found.
 */
export function executeCanvasCommands(editor: Editor, aiText: string): { count: number; shapeIds: string[] } {
  const match = aiText.match(/```canvas\r?\n([\s\S]*?)```/);
  if (!match) return { count: 0, shapeIds: [] };

  let count = 0;
  const shapeIds: string[] = [];
  for (const line of match[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const result = runCommand(editor, JSON.parse(line) as Record<string, unknown>);
      count += result.count;
      if (result.shapeId) shapeIds.push(result.shapeId);
    } catch { /* skip malformed line */ }
  }
  return { count, shapeIds: [...new Set(shapeIds)] };
}

type CommandResult = { count: number; shapeId: string | null };

function runCommand(editor: Editor, cmd: Record<string, unknown>): CommandResult {
  const op = String(cmd.op ?? '');
  const existing = editor.getCurrentPageShapes();

  // ── add_slide (frame) ────────────────────────────────────────
  if (op === 'add_slide') {
    const frames = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame') as TLFrameShape[];
    const last = frames[frames.length - 1];
    const sx = last ? last.x + (last.props.w ?? SLIDE_W) + SLIDE_GAP : 0;
    const sy = last ? last.y : 0;
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
    if (existing.length > 0) editor.deleteShapes(existing);
    return { count: existing.length, shapeId: null };
  }

  // ── delete ───────────────────────────────────────────────────
  if (op === 'delete') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) return { count: 0, shapeId: null };
    editor.deleteShapes([target]);
    return { count: 1, shapeId: null };
  }

  // ── update ───────────────────────────────────────────────────
  if (op === 'update') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target || cmd.text === undefined) return { count: 0, shapeId: null };
    // updateShapes is typed on the concrete shape union, cast via any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShapes([{
      id: target.id,
      type: target.type,
      props: { richText: toRichText(String(cmd.text)) },
    } as any]);
    // Return the shape ID so the parent can record it in an AI mark highlight.
    return { count: 1, shapeId: target.id };
  }
  // ── move ─────────────────────────────────────────────────
  if (op === 'move') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) return { count: 0, shapeId: null };
    const newX = typeof cmd.x === 'number' ? cmd.x : target.x;
    const newY = typeof cmd.y === 'number' ? cmd.y : target.y;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShapes([{ id: target.id, type: target.type, x: newX, y: newY } as any]);
    // Return the shape ID so the parent can record it in an AI mark highlight.
    return { count: 1, shapeId: target.id };
  }
  // ── auto-position new shapes (cascade so they don't all stack at 0,0) ────
  const idx = existing.length;
  const x = typeof cmd.x === 'number' ? cmd.x : 100 + (idx % 5) * 220;
  const y = typeof cmd.y === 'number' ? cmd.y : 100 + Math.floor(idx / 5) * 160;

  // ── add_note (sticky note) ───────────────────────────────────
  if (op === 'add_note') {
    const noteId = createShapeId();
    editor.createShapes<TLNoteShape>([{
      id: noteId,
      type: 'note',
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'yellow'),
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
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'black'),
        autoSize: true,
      },
    }]);
    return { count: 1, shapeId: textId };
  }

  // ── add_geo (rectangle, ellipse, triangle, …) ────────────────
  if (op === 'add_geo') {
    const geoVal = String(cmd.geo ?? 'rectangle') as TLGeoShapeGeoStyle;
    const geoId = createShapeId();
    editor.createShapes<TLGeoShape>([{
      id: geoId,
      type: 'geo',
      x,
      y,
      props: {
        geo: geoVal,
        w: typeof cmd.w === 'number' ? cmd.w : 200,
        h: typeof cmd.h === 'number' ? cmd.h : 120,
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'blue'),
        fill: mapFill(cmd.fill),
      },
    }]);
    return { count: 1, shapeId: geoId };
  }

  // ── add_arrow (free-standing arrow between two points) ───────
  if (op === 'add_arrow') {
    const x1 = typeof cmd.x1 === 'number' ? cmd.x1 : x;
    const y1 = typeof cmd.y1 === 'number' ? cmd.y1 : y;
    const x2 = typeof cmd.x2 === 'number' ? cmd.x2 : x1 + 200;
    const y2 = typeof cmd.y2 === 'number' ? cmd.y2 : y1;
    const label = String(cmd.label ?? cmd.text ?? '');
    const arrowId = createShapeId();
    editor.createShapes<TLArrowShape>([{
      id: arrowId,
      type: 'arrow',
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

  return { count: 0, shapeId: null };
}
