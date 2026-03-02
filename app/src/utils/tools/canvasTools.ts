/**
 * Canvas workspace tools: list shapes, execute canvas operations, take
 * canvas/preview screenshots, and place images on the canvas.
 */

import { readTextFile } from '../../services/fs';
import {
  executeCanvasCommands,
  canvasToDataUrl,
  compressDataUrl,
  summarizeCanvas,
  placeImageOnCanvas,
} from '../canvasAI';
import { renderHtmlOffscreen } from '../htmlPreview';
import { lockFile, unlockFile } from '../../services/copilotLock';
import { getMimeType } from '../mime';
import type { ToolDefinition, DomainExecutor } from './shared';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const CANVAS_TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_canvas_shapes',
      description:
        "List all shapes currently on the open canvas. Returns each shape's short ID (last 10 chars), type, position, size, color, fill, and text content. Arrow shapes include their start/end coordinates. Call this before update, move, or delete operations to get valid shape IDs.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canvas_op',
      description:
        'Create, update, move, or delete shapes on the currently open canvas (.tldr.json file). Only call this when the user is looking at a canvas. Call list_canvas_shapes first if the user wants to modify existing shapes — you need the IDs.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'string',
            description: [
              'Newline-separated JSON command objects. Supported ops:',
              '  {"op":"add_slide","name":"Slide title"}  ← create a new 16:9 frame/slide (appended after the last existing one)',
              '  {"op":"add_note","text":"…","x":100,"y":100,"color":"yellow","slide":"abc1234567"}  ← slide = last-10-char frame ID; makes shape a child of that frame (ALWAYS include when targeting a slide)',
              '  {"op":"add_text","text":"…","x":100,"y":200,"color":"black","slide":"abc1234567"}',
              '  {"op":"add_geo","geo":"rectangle","text":"Label","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid","slide":"abc1234567"}',
              '  {"op":"add_arrow","x1":100,"y1":150,"x2":400,"y2":150,"label":"depends on","color":"grey"}',
              '  {"op":"move","id":"abc1234567","x":300,"y":400}       ← reposition a shape',
              '  {"op":"update","id":"abc1234567","text":"New text","color":"red","fill":"solid"}   ← text/color/fill are each optional; id from list_canvas_shapes',
              '  {"op":"delete","id":"abc1234567"}',
              '  {"op":"clear","confirm":"yes"}  ← DANGER: removes ALL shapes. confirm:"yes" is required. Only use when the user explicitly asks to wipe the canvas.',
              'IMPORTANT: always include "slide":"<frameId>" on add_* commands to parent shapes inside a frame. Without it shapes float on the page and are NOT grouped with the slide.',
              'When "slide" is set, x/y are PARENT-RELATIVE (0,0 = frame top-left, not page origin). Frame size is 1280×720.',
              'Valid colors: yellow, blue, green, red, orange, violet, grey, black, white, light-blue, light-violet',
              'Valid geo shapes: rectangle, ellipse, triangle, diamond, hexagon, cloud, star, arrow-right',
              'Spacing tip: use 240px column gaps, 160px row gaps to avoid overlaps.',
            ].join('\n'),
          },
        },
        required: ['commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canvas_screenshot',
      description:
        'Take a PNG screenshot of the current canvas and inject it into the conversation as a visual image. ' +
        'Call this ONCE after completing all canvas_op modifications to visually verify the result looks correct. ' +
        'This is your only way to see what the canvas actually looks like — use it to catch layout issues, overlapping shapes, or wrong colors before replying to the user. ' +
        'Do NOT call this repeatedly — one visual check per interaction.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_preview',
      description:
        'Capture a screenshot of the live HTML/CSS preview pane and inject it as a vision image so you can ' +
        'visually verify layout, spacing, typography, and interactive element positioning. ' +
        'ALWAYS call this after writing or patching an HTML or CSS file to check the rendered result. ' +
        'Use it iteratively: write → screenshot → spot issues → patch → screenshot again until the layout is correct. ' +
        'Works in both preview mode and editor mode whenever an HTML file is active.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_canvas_image',
      description:
        'Fetch an image from a URL and place it on the currently open canvas as an image shape. ' +
        'Use this when the user wants to add a picture, logo, diagram, or photo to their canvas. ' +
        'Optionally specify x/y position (page coordinates). Defaults to the current viewport center.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full image URL (https://…). Supported: jpg, png, gif, webp, svg.',
          },
          x: {
            type: 'number',
            description: 'X position on the canvas page (optional — defaults to viewport center).',
          },
          y: {
            type: 'number',
            description: 'Y position on the canvas page (optional — defaults to viewport center).',
          },
          width: {
            type: 'number',
            description: 'Desired display width in pixels (optional — defaults to natural image width, capped at 800px).',
          },
        },
        required: ['url'],
      },
    },
  },
];

// ── Executor ─────────────────────────────────────────────────────────────────

export const executeCanvasTools: DomainExecutor = async (name, args, ctx) => {
  const { canvasEditor, activeFile, webPreviewRef, onCanvasModified, getActiveHtml } = ctx;

  switch (name) {

    // ── list_canvas_shapes ──────────────────────────────────────────────
    case 'list_canvas_shapes': {
      const editor = canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      return summarizeCanvas(editor);
    }

    // ── canvas_op ───────────────────────────────────────────────────────
    case 'canvas_op': {
      const editor = canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      const rawCommands = String(args.commands ?? '');
      const stripped = rawCommands
        .replace(/^```canvas\r?\n/, '')
        .replace(/\n```\s*$/, '');
      const fenced = '```canvas\n' + stripped + '\n```';
      if (activeFile) lockFile(activeFile, ctx.agentId);
      await new Promise<void>((r) => setTimeout(r, 0));
      let count = 0;
      let shapeIds: string[] = [];
      let errors: string[] = [];
      try {
        ({ count, shapeIds, errors } = executeCanvasCommands(editor, fenced));
      } finally {
        if (activeFile) unlockFile(activeFile);
      }
      if (count === 0) {
        const errDetail = errors.length ? ` Errors: ${errors.join('; ')}` : '';
        return `No commands were executed. Check the command syntax.${errDetail}`;
      }
      onCanvasModified?.(shapeIds);
      return `Executed ${count} canvas operation(s) successfully.`;
    }

    // ── canvas_screenshot ───────────────────────────────────────────────
    case 'canvas_screenshot': {
      const editor = canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      const url = await canvasToDataUrl(editor, 0.5);
      if (!url) return 'Canvas is empty — nothing to screenshot.';
      const compressed = await compressDataUrl(url, 512, 0.65);
      return `__CANVAS_PNG__:${compressed}`;
    }

    // ── screenshot_preview ──────────────────────────────────────────────
    case 'screenshot_preview': {
      const activeHtml = getActiveHtml?.();
      if (activeHtml) {
        let freshHtml: string;
        try {
          freshHtml = await readTextFile(activeHtml.absPath);
        } catch {
          freshHtml = activeHtml.html;
        }
        const offscreenUrl = await renderHtmlOffscreen(freshHtml, activeHtml.absPath);
        if (offscreenUrl) {
          const compressed = await compressDataUrl(offscreenUrl, 512, 0.65);
          return `__PREVIEW_PNG__:${compressed}`;
        }
      }

      if (webPreviewRef?.current) {
        const url = await webPreviewRef.current.getScreenshot();
        if (url) {
          const compressed = await compressDataUrl(url, 512, 0.65);
          return `__PREVIEW_PNG__:${compressed}`;
        }
      }

      return 'No HTML preview is available. Open an HTML file and try again.';
    }

    // ── add_canvas_image ────────────────────────────────────────────────
    case 'add_canvas_image': {
      const editor = canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';

      const imgUrl = String(args.url ?? '').trim();
      if (!imgUrl) return 'Error: url is required.';

      const ext = imgUrl.split('?')[0].split('.').pop()?.toLowerCase() ?? 'png';
      const mimeType = getMimeType(ext, 'image/png');

      let natW = 800;
      let natH = 600;
      try {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => { natW = img.naturalWidth || 800; natH = img.naturalHeight || 600; resolve(); };
          img.onerror = () => resolve();
          img.src = imgUrl;
        });
      } catch { /* use defaults */ }

      const imgName = imgUrl.split('/').pop()?.split('?')[0] ?? 'image';
      const placed = placeImageOnCanvas(editor, imgUrl, imgName, mimeType, natW, natH, {
        x: typeof args.x === 'number' ? args.x : undefined,
        y: typeof args.y === 'number' ? args.y : undefined,
        width: typeof args.width === 'number' ? args.width : undefined,
      });

      return `Image added to canvas at (${placed.x}, ${placed.y}) with size ${placed.w}×${placed.h}px. Source: ${imgUrl}`;
    }

    default:
      return null;
  }
};
