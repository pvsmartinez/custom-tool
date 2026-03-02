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
import { getCanvasEditor, ensureCanvasTabOpen, setCopilotOverlay } from '../canvasRegistry';
import type { ToolDefinition, DomainExecutor } from './shared';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const CANVAS_TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_canvas_shapes',
      description:
        "List all shapes currently on the open canvas. Returns the canvas filename first (so you can verify you are editing the correct file), then each shape's short ID (last 10 chars), type, position, size, color, fill, and text content. Arrow shapes include their start/end coordinates. Call this before update, move, or delete operations to get valid shape IDs.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canvas_op',
      description:
        'Create, update, move, or delete shapes on a canvas (.tldr.json file). You MUST pass expected_file with the relative path of the canvas you intend to edit (e.g. "aulas/Aula-02.tldr.json") — the tool will automatically switch to that tab if needed. Call list_canvas_shapes first if the user wants to modify existing shapes — you need the IDs.',
      parameters: {
        type: 'object',
        properties: {
          expected_file: {
            type: 'string',
            description: 'Relative workspace path of the canvas file you intend to edit, e.g. "aulas/Aula-02.tldr.json". Must match the currently open tab — the tool will return an error if it does not, so the user knows to switch files before proceeding.',
          },
          commands: {
            type: 'string',
            description: [
              'Newline-separated JSON command objects. Supported ops:',
              '  {"op":"add_slide","name":"Slide title"}  ← create a new 16:9 frame/slide (appended after the last existing one)',
              '  {"op":"duplicate_slide","slide":"abc1234567","name":"Slide 2"}  ← SHORTHAND: copy a slide + ALL its content (bg, text, shapes) as a new slide — much faster than recreating manually',
              '  {"op":"add_note","text":"…","x":100,"y":100,"color":"yellow","size":"m","font":"sans","align":"middle","slide":"abc1234567"}  ← slide = last-10-char frame ID; makes shape a child of that frame (ALWAYS include when targeting a slide)',
              '  {"op":"add_text","text":"…","x":100,"y":200,"color":"black","size":"xl","font":"sans","align":"start","slide":"abc1234567"}',
              '  {"op":"add_geo","geo":"rectangle","text":"Label","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid","size":"m","font":"sans","align":"middle","slide":"abc1234567"}',
              '  {"op":"add_arrow","x1":100,"y1":150,"x2":400,"y2":150,"label":"depends on","color":"grey"}',
              '  {"op":"add_image","url":"https://…","x":0,"y":0,"w":800,"h":450,"slide":"abc1234567","to_back":true}  ← place an image inside a slide; to_back:true sends it behind other shapes',
              '  {"op":"set_slide_background","url":"https://…","slide":"abc1234567"}  ← SHORTHAND: fills the entire slide (1280×720) with the image, removes existing bg, sends to back.',
              '  {"op":"set_slide_background","color":"blue","slide":"abc1234567"}  ← same but with a solid color fill instead of image (supports all valid tldraw colors).',
              '  {"op":"copy_slide_background","from_slide":"abc1234567","to_slides":["def1234567","ghi1234567"]}  ← copy background (image OR color) from one slide to others.',
              '  {"op":"apply_theme","bg_color":"black","text_color":"white","to_slides":"all"}  ← BATCH: apply bg + recolor all text/geo on ALL slides in one call. to_slides can be "all" or an array of IDs. bg_color, bg_url, text_color are each optional.',
              '  {"op":"recolor_slide","slide":"abc1234567","text_color":"white","geo_color":"light-blue"}  ← recolor text/notes/arrows and/or geo shapes in one slide. geo_color defaults to text_color if omitted.',
              '  {"op":"move","id":"abc1234567","x":300,"y":400}       ← reposition a shape',
              '  {"op":"update","id":"abc1234567","text":"New text","color":"red","fill":"solid","size":"l","font":"sans","align":"start"}   ← text/color/fill/size/font/align are each optional; also works on frames (updates slide name). id from list_canvas_shapes',
              '  {"op":"delete","id":"abc1234567"}',
              '  {"op":"clear","confirm":"yes"}  ← DANGER: removes ALL shapes. confirm:"yes" is required. Only use when the user explicitly asks to wipe the canvas.',
              'IMPORTANT: always include "slide":"<frameId>" on add_* commands to parent shapes inside a frame. Without it shapes float on the page and are NOT grouped with the slide.',
              'When "slide" is set, x/y are PARENT-RELATIVE (0,0 = frame top-left, not page origin). Frame size is 1280×720.',
              'READING THE SUMMARY: image shapes tagged [BG] are full-frame backgrounds — their src:"filename" shows the image. Non-[BG] images are regular content shapes.',
              'Valid colors: yellow, blue, green, red, orange, violet, grey, black, white, light-blue, light-violet',
              'Valid sizes (font size): s=small, m=medium, l=large, xl=extra-large (title)',
              'Valid fonts: sans (clean/modern), serif (editorial), draw (handwritten), mono (code)',
              'Valid align: start (left), middle (center), end (right)',
              'Valid geo shapes: rectangle, ellipse, triangle, diamond, hexagon, cloud, star, arrow-right',
              'Spacing tip: use 240px column gaps, 160px row gaps to avoid overlaps.',
              'WORKFLOW TIPS: (1) Same bg+theme on all slides → ONE call: apply_theme with bg_color/bg_url + text_color + to_slides:"all". (2) Template slide → duplicate_slide is 1 call instead of N add_* calls. (3) Rename slide → update with id=frameId and text="New name". (4) Fix text colors after bg change → recolor_slide.',
            ].join('\n'),
          },
        },
        required: ['expected_file', 'commands'],
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
        'Fetch an image from a URL and place it as a free-floating image shape on the canvas PAGE (not inside any slide). ' +
        'Use this only when the user wants an image outside all slides. ' +
        'IMPORTANT: if you want to place an image INSIDE a slide (with a slide: field), use canvas_op with add_image or set_slide_background instead. ' +
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
      const regEditor = activeFile ? getCanvasEditor(activeFile) : undefined;
      const editor = regEditor ?? canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      // Always prefix with the open file so the AI can verify it is editing the right file.
      const fileHeader = activeFile ? `Canvas file: ${activeFile}` : '';
      const summary = summarizeCanvas(editor);
      return fileHeader ? `${fileHeader}\n${summary}` : summary;
    }

    // ── canvas_op ───────────────────────────────────────────────────────
    case 'canvas_op': {
      // Show overlay and auto-switch to the target canvas tab if needed
      const expectedFile = String(args.expected_file ?? '').trim();
      setCopilotOverlay(true);
      try {
        if (expectedFile) await ensureCanvasTabOpen(expectedFile);
      } catch (e) {
        setCopilotOverlay(false);
        return `Error opening canvas tab "${expectedFile}": ${e instanceof Error ? e.message : String(e)}`;
      }
      // Resolve editor: prefer registry lookup for the target file
      const targetFile = expectedFile || (activeFile ?? '');
      const editor = (targetFile ? getCanvasEditor(targetFile) : undefined) ?? canvasEditor.current;
      if (!editor) {
        setCopilotOverlay(false);
        return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      }

      const rawCommands = String(args.commands ?? '');
      const stripped = rawCommands
        .replace(/^```canvas\r?\n/, '')
        .replace(/\n```\s*$/, '');
      const fenced = '```canvas\n' + stripped + '\n```';
      if (targetFile) lockFile(targetFile, ctx.agentId);
      await new Promise<void>((r) => setTimeout(r, 0));
      let count = 0;
      let shapeIds: string[] = [];
      let errors: string[] = [];
      try {
        ({ count, shapeIds, errors } = executeCanvasCommands(editor, fenced));
      } finally {
        if (targetFile) unlockFile(targetFile);
        setCopilotOverlay(false);
      }
      if (count === 0) {
        if (errors.length > 0) {
          return `Canvas operation failed — all changes rolled back. ${errors.length} error(s): ${errors.join('; ')}`;
        }
        return `No commands were executed. Check the command syntax.`;
      }
      onCanvasModified?.(shapeIds);
      const fileTag = targetFile ? ` on ${targetFile.split('/').pop()}` : '';
      return `Executed ${count} canvas operation(s) successfully${fileTag}.`;
    }

    // ── canvas_screenshot ───────────────────────────────────────────────
    case 'canvas_screenshot': {
      const editor = canvasEditor.current;
      if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
      const url = await canvasToDataUrl(editor, 0.5);
      if (!url) return 'Canvas is empty — nothing to screenshot.';
      // 320px wide, 0.55 quality — keeps a photographic canvas background under ~50 KB
      const compressed = await compressDataUrl(url, 320, 0.55);
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
          const compressed = await compressDataUrl(offscreenUrl, 320, 0.55);
          return `__PREVIEW_PNG__:${compressed}`;
        }
      }

      if (webPreviewRef?.current) {
        const url = await webPreviewRef.current.getScreenshot();
        if (url) {
          const compressed = await compressDataUrl(url, 320, 0.55);
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
          const timeout = setTimeout(resolve, 10_000); // 10s timeout — unreachable URLs hang forever otherwise
          img.onload = () => { clearTimeout(timeout); natW = img.naturalWidth || 800; natH = img.naturalHeight || 600; resolve(); };
          img.onerror = () => { clearTimeout(timeout); resolve(); };
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
