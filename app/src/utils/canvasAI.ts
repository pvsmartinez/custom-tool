/**
 * AI ↔ Canvas bridge.
 *
 * Two concerns:
 *  1. Summarise the current canvas into human-readable text for the AI system prompt.
 *  2. Parse a ```canvas … ``` code block from an AI response and execute the
 *     commands against the live tldraw Editor instance.
 *
 * Command format (one JSON object per line inside the fenced block):
 *   {"op":"add_note",  "text":"…", "x":100, "y":100, "color":"yellow"}
 *   {"op":"add_text",  "text":"…", "x":100, "y":100, "color":"black"}
 *   {"op":"add_geo",   "text":"…", "geo":"rectangle", "x":100, "y":100, "w":200, "h":120, "color":"blue", "fill":"solid"}
 *   {"op":"update",    "id":"abc123", "text":"New text"}
 *   {"op":"delete",    "id":"abc123"}
 *   {"op":"clear"}
 *
 * "id" values match the last-6-characters of a shape ID shown in the summary.
 */

import type { Editor, TLRichText } from 'tldraw';
import { createShapeId, renderPlaintextFromRichText, toRichText } from 'tldraw';
import type { TLNoteShape, TLGeoShape, TLTextShape, TLGeoShapeGeoStyle, TLArrowShape } from '@tldraw/tlschema';

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

function mapFill(raw: unknown): TLFill {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'none' || s === 'semi' || s === 'solid' || s === 'pattern') return s as TLFill;
  return 'solid';
}

function mapColor(raw: unknown, fallback: TLColor = 'yellow'): TLColor {
  return COLOR_MAP[String(raw ?? '').toLowerCase()] ?? fallback;
}

/** Returns a short human-readable description of every shape on the canvas. */
export function summarizeCanvas(editor: Editor): string {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return 'The canvas is currently empty.';

  const page = editor.getCurrentPage();
  const lines: string[] = [
    `Canvas page: "${page.name}" — ${shapes.length} shape(s):`,
  ];

  for (const shape of shapes) {
    const props = shape.props as {
      richText?: TLRichText;
      color?: string;
      fill?: string;
      geo?: string;
      w?: number;
      h?: number;
      // arrow
      start?: { x: number; y: number };
      end?: { x: number; y: number };
      text?: string;
    };

    // Text content
    let text = '';
    if (props.richText) {
      try { text = renderPlaintextFromRichText(editor, props.richText); } catch { /* skip */ }
    } else if (typeof props.text === 'string') {
      text = props.text;
    }

    const shortId = shape.id.slice(-6);
    const x = Math.round(shape.x);
    const y = Math.round(shape.y);

    // Build attribute list for visual context
    const attrs: string[] = [];
    if (props.color) attrs.push(`color:${props.color}`);
    if (props.fill && props.fill !== 'none') attrs.push(`fill:${props.fill}`);

    if (shape.type === 'arrow') {
      const arrowProps = props as unknown as { start: { x: number; y: number }; end: { x: number; y: number } };
      const sx = Math.round(shape.x + (arrowProps.start?.x ?? 0));
      const sy = Math.round(shape.y + (arrowProps.start?.y ?? 0));
      const ex = Math.round(shape.x + (arrowProps.end?.x ?? 0));
      const ey = Math.round(shape.y + (arrowProps.end?.y ?? 0));
      lines.push(
        `  [${shortId}] arrow from (${sx},${sy}) → (${ex},${ey})` +
        (text ? ` label:"${text}"` : '') +
        (attrs.length ? ` [${attrs.join(', ')}]` : ''),
      );
    } else if (shape.type === 'geo') {
      const w = props.w ? Math.round(props.w) : '?';
      const h = props.h ? Math.round(props.h) : '?';
      lines.push(
        `  [${shortId}] ${props.geo ?? 'geo'} at (${x},${y}) size ${w}×${h}` +
        (text ? ` text:"${text}"` : '') +
        (attrs.length ? ` [${attrs.join(', ')}]` : ''),
      );
    } else {
      lines.push(
        `  [${shortId}] ${shape.type} at (${x},${y})` +
        (text ? ` text:"${text}"` : '') +
        (attrs.length ? ` [${attrs.join(', ')}]` : ''),
      );
    }
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
    '  {"op":"add_note","text":"Your text","x":100,"y":100,"color":"yellow"}',
    '  {"op":"add_text","text":"Your text","x":100,"y":200,"color":"black"}',
    '  {"op":"add_geo","geo":"rectangle","text":"Label","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid"}',
    '  {"op":"add_arrow","x1":100,"y1":100,"x2":400,"y2":200,"label":"depends on","color":"grey"}',
    '  {"op":"update","id":"abc123","text":"New text"}  ← id = last 6 chars of shape ID above',
    '  {"op":"move","id":"abc123","x":300,"y":400}       ← reposition a shape',
    '  {"op":"delete","id":"abc123"}',
    '  {"op":"clear"}                                   ← removes all shapes',
    'Valid colors: yellow, blue, green, red, orange, violet, grey, black, white, light-blue, light-green, light-red, light-violet',
    'Valid geo shapes: rectangle, ellipse, triangle, diamond, hexagon, cloud, star, arrow-right',
    'Canvas coordinates: (0,0) is top-left; a typical 16:9 view is ~2200 wide × 1400 tall.',
    'Plan layouts thoughtfully: use consistent spacing (e.g. 240px columns, 160px rows) so shapes do not overlap.',
    'Use color to signal meaning: yellow=idea, blue=process, green=outcome, red=risk, grey=connection.',
  ].join('\n');
}

/**
 * Renders the current canvas page to a base64 PNG data URL.
 * Uses pixelRatio:1 to keep file size reasonable (~60-150 kB) for vision calls.
 * Returns '' when the canvas is empty or rendering fails.
 */
export async function canvasToDataUrl(editor: Editor): Promise<string> {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return '';
  const ids = shapes.map((s) => s.id);
  try {
    const { url } = await editor.toImageDataUrl(ids, {
      format: 'png',
      // pixelRatio 1 = CSS-pixel size; keeps PNG small enough for vision context
      pixelRatio: 1,
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
 * against the live editor, and return the number of shapes affected.
 * Returns 0 if no canvas block is found.
 */
export function executeCanvasCommands(editor: Editor, aiText: string): number {
  const match = aiText.match(/```canvas\r?\n([\s\S]*?)```/);
  if (!match) return 0;

  let count = 0;
  for (const line of match[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      count += runCommand(editor, JSON.parse(line) as Record<string, unknown>);
    } catch { /* skip malformed line */ }
  }
  return count;
}

function runCommand(editor: Editor, cmd: Record<string, unknown>): number {
  const op = String(cmd.op ?? '');
  const existing = editor.getCurrentPageShapes();

  // ── clear ────────────────────────────────────────────────────
  if (op === 'clear') {
    if (existing.length > 0) editor.deleteShapes(existing);
    return existing.length;
  }

  // ── delete ───────────────────────────────────────────────────
  if (op === 'delete') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) return 0;
    editor.deleteShapes([target]);
    return 1;
  }

  // ── update ───────────────────────────────────────────────────
  if (op === 'update') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target || cmd.text === undefined) return 0;
    // updateShapes is typed on the concrete shape union, cast via any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShapes([{
      id: target.id,
      type: target.type,
      props: { richText: toRichText(String(cmd.text)) },
    } as any]);
    return 1;
  }
  // ── move ─────────────────────────────────────────────────
  if (op === 'move') {
    const suffix = String(cmd.id ?? '');
    const target = existing.find((s) => s.id.endsWith(suffix));
    if (!target) return 0;
    const newX = typeof cmd.x === 'number' ? cmd.x : target.x;
    const newY = typeof cmd.y === 'number' ? cmd.y : target.y;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.updateShapes([{ id: target.id, type: target.type, x: newX, y: newY } as any]);
    return 1;
  }
  // ── auto-position new shapes (cascade so they don't all stack at 0,0) ────
  const idx = existing.length;
  const x = typeof cmd.x === 'number' ? cmd.x : 100 + (idx % 5) * 220;
  const y = typeof cmd.y === 'number' ? cmd.y : 100 + Math.floor(idx / 5) * 160;

  // ── add_note (sticky note) ───────────────────────────────────
  if (op === 'add_note') {
    editor.createShapes<TLNoteShape>([{
      id: createShapeId(),
      type: 'note',
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'yellow'),
      },
    }]);
    return 1;
  }

  // ── add_text (freestanding text label) ───────────────────────
  if (op === 'add_text') {
    editor.createShapes<TLTextShape>([{
      id: createShapeId(),
      type: 'text',
      x,
      y,
      props: {
        richText: toRichText(String(cmd.text ?? '')),
        color: mapColor(cmd.color, 'black'),
        autoSize: true,
      },
    }]);
    return 1;
  }

  // ── add_geo (rectangle, ellipse, triangle, …) ────────────────
  if (op === 'add_geo') {
    const geoVal = String(cmd.geo ?? 'rectangle') as TLGeoShapeGeoStyle;
    editor.createShapes<TLGeoShape>([{
      id: createShapeId(),
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
    return 1;
  }

  // ── add_arrow (free-standing arrow between two points) ───────
  if (op === 'add_arrow') {
    const x1 = typeof cmd.x1 === 'number' ? cmd.x1 : x;
    const y1 = typeof cmd.y1 === 'number' ? cmd.y1 : y;
    const x2 = typeof cmd.x2 === 'number' ? cmd.x2 : x1 + 200;
    const y2 = typeof cmd.y2 === 'number' ? cmd.y2 : y1;
    const label = String(cmd.label ?? cmd.text ?? '');
    editor.createShapes<TLArrowShape>([{
      id: createShapeId(),
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
    return 1;
  }

  return 0;
}
