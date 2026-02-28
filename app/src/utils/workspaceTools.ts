/**
 * Workspace tool definitions (OpenAI function calling format) + their executors.
 *
 * Tools give Copilot the ability to:
 *   - list_workspace_files   → see the whole file tree
 *   - read_workspace_file    → read any file on demand (AI-driven RAG)
 *   - write_workspace_file   → create or overwrite a file
 *   - search_workspace       → grep-like search across all files
 *   - list_canvas_shapes     → inspect shapes on the open canvas
 *   - canvas_op              → draw/edit shapes on the active canvas
 *   - canvas_screenshot      → take a PNG screenshot of the canvas
 *   - web_search             → search the web via DuckDuckGo (no API key)
 *   - search_stock_images    → search Pexels for free stock photos
 *   - add_canvas_image       → fetch an image URL and place it on the canvas
 *   - remember               → persist a fact/note to .cafezin/memory.md across sessions
 *   - fetch_url              → fetch and read any web page as plain text
 *   - check_file             → lint front-matter, internal links, and canvas JSON
 *   - rename_workspace_file  → rename or move a file/folder within the workspace
 *   - delete_workspace_file  → permanently delete a file (with safety guard)
 *   - scaffold_workspace     → create a folder structure + stub files atomically
 *   - screenshot_preview     → capture a PNG of the live HTML preview pane
 */

import {
  readTextFile,
  writeTextFile,
  mkdir,
  exists,
  rename,
  remove,
} from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { Editor } from 'tldraw';
import { executeCanvasCommands, canvasToDataUrl, summarizeCanvas, placeImageOnCanvas } from './canvasAI';
import { runExportTarget } from './exportWorkspace';
import { emitTerminalEntry } from '../services/terminalBus';
import { lockFile, unlockFile } from '../services/copilotLock';
import { walkFilesFlat } from '../services/workspace';
import { getMimeType } from './mime';
import type { WorkspaceExportConfig, ExportTarget, ExportFormat } from '../types';

// ── Tool definition schema (OpenAI format) ──────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: { type: string };
      }>;
      required?: string[];
    };
  };
}

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_workspace_files',
      description:
        'List every file in the workspace. Call this first when you need to know what documents exist before reading or searching.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_workspace_file',
      description:
        'Read the content of a file. Returns the full text or a specific line range. ' +
        'For files larger than 40 KB the response is truncated — call again with start_line/end_line to page through the rest.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from workspace root, e.g. "chapter1.md" or "notes/ideas.md"',
          },
          start_line: {
            type: 'number',
            description: '1-based line number to start reading from (inclusive). Omit to start at the beginning.',
          },
          end_line: {
            type: 'number',
            description: '1-based line number to stop reading at (inclusive). Omit to read to the end (up to the 40 KB cap).',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_workspace_file',
      description:
        'Create a new file or completely overwrite an existing one. Use for generating new documents, drafts, or outlines.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from workspace root, e.g. "chapter2.md". Include the extension.',
          },
          content: {
            type: 'string',
            description: 'The complete file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_workspace_file',
      description:
        'Make a targeted find-and-replace edit inside a file without overwriting the whole thing. ' +
        'Reads the file, replaces the specified occurrence of `search` with `replace`, then writes back. ' +
        'Use this for surgical edits — fixing a sentence, updating a heading, changing a value — instead of ' +
        'rewriting the entire file with write_workspace_file. Set occurrence=0 to replace all occurrences.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from workspace root, e.g. "chapter1.md"',
          },
          search: {
            type: 'string',
            description: 'Exact text to find — must match character-for-character including whitespace and newlines.',
          },
          replace: {
            type: 'string',
            description: 'Text to substitute in place of the match. Use an empty string to delete the match.',
          },
          occurrence: {
            type: 'number',
            description: '1-based index of which match to replace. Defaults to 1 (first match). Pass 0 to replace all occurrences.',
          },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Search for a word or phrase across all text files in the workspace. Returns matching lines with file context. Good for finding where a topic is mentioned.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text to search for (case-insensitive). Can be a word, phrase, or sentence fragment.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_canvas_shapes',
      description:
        'List all shapes currently on the open canvas. Returns each shape\'s short ID (last 10 chars), type, position, size, color, fill, and text content. Arrow shapes include their start/end coordinates. Call this before update, move, or delete operations to get valid shape IDs.',
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
        'Only available when an HTML file is open in preview mode.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and return a summary of top results. Use this when the user asks about current events, real-world facts, documentation, or anything not in the workspace. ' +
        'Returns an abstract summary and related topic links.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "TypeScript generics tutorial" or "latest React 19 features".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_stock_images',
      description:
        'Search Pexels for free high-quality stock photos. Returns up to 6 results with image URLs, sizes, and photographer credits. ' +
        'Use this when the user asks to find, search, or add a photo/image to a slide or canvas. ' +
        'After getting results, pick the most relevant URL and call add_canvas_image to place it on the canvas.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to search for, e.g. "mountain landscape", "team meeting", "abstract blue technology"',
          },
          count: {
            type: 'number',
            description: 'Number of results to return (1–6, default 4).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell (bash) command in the workspace directory. Use this to create folders, run npm/node/git commands, install packages, scaffold projects, execute scripts, and perform any other terminal operations. ' +
        'Returns stdout, stderr, and the exit code. Commands run with the workspace root as the working directory unless cwd is specified.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to run, e.g. "npm init -y" or "mkdir -p src/components" or "npm install react".',
          },
          cwd: {
            type: 'string',
            description: 'Optional subdirectory (relative to workspace root) to run the command in. Defaults to the workspace root.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_workspace',
      description:
        'Run export targets for this workspace — markdown → PDF, canvas → PNG/PDF, zip bundles, or custom commands. ' +
        'Call this when the user says to export, build, publish, deploy, or produce output files. ' +
        'With no argument it runs all enabled targets. Pass a target name to run just one.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target name to run, or "all" to run all enabled targets (default: "all").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_export_targets',
      description:
        'List, add, update, or remove export targets in the workspace Build/Export settings. ' +
        'Use this when the user wants to set up, tweak, or inspect export rules without opening the UI. ' +
        'The config is persisted immediately. ' +
        'action="list" returns all targets as JSON. ' +
        'action="add" creates a new target (name, format, and outputDir required). ' +
        'action="update" patches an existing target by id or name. ' +
        'action="remove" deletes a target by id or name.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'Operation to perform.' },
          id:          { type: 'string', description: 'Target id (for update/remove).' },
          name:        { type: 'string', description: 'Target name (required for add; used to find target in update/remove).' },
          description: { type: 'string', description: 'Human/AI readable description of what this target produces.' },
          format: {
            type: 'string',
            enum: ['pdf', 'canvas-png', 'canvas-pdf', 'zip', 'custom'],
            description: 'Export format.'
          },
          include:      { type: 'array', items: { type: 'string' }, description: 'File extensions to match, e.g. ["md"] or ["tldr.json"].' },
          includeFiles: { type: 'array', items: { type: 'string' }, description: 'Pinned specific files (relative paths). Overrides include extensions when set.' },
          excludeFiles: { type: 'array', items: { type: 'string' }, description: 'Relative paths to skip.' },
          outputDir:    { type: 'string', description: 'Output directory relative to workspace root.' },
          customCommand:{ type: 'string', description: 'Shell command for custom format. Use {{input}} and {{output}} placeholders.' },
          enabled:      { type: 'boolean', description: 'Whether this target is included in Export All.' },
          merge:        { type: 'boolean', description: 'Merge all matched files into one output (pdf/canvas-pdf).' },
          mergeName:    { type: 'string', description: 'Filename (no extension) for merged output.' },
        },
        required: ['action'],
      },
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
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a fact, note, or preference to the workspace memory (.cafezin/memory.md) so it persists across chat sessions. ' +
        'Use this proactively whenever the user tells you something important about their project — character names, ' +
        'writing style preferences, world-building facts, glossary terms, plot decisions. ' +
        'The memory file is automatically included in every future conversation in this workspace.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The fact, note, or preference to remember. Be specific and write it so it is self-contained out of context.',
          },
          heading: {
            type: 'string',
            description: 'Category heading to file this under, e.g. "Characters", "Style Preferences", "Plot Notes", "Glossary", "World Building". Creates the section if it does not exist.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch the content of any web page by URL and return its readable text. ' +
        'Use this after web_search to get the full content of a result page, ' +
        'or to read documentation, articles, or reference material directly from a URL. ' +
        'Strips HTML tags and returns plain text (up to ~16 KB).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (https://…).',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_file',
      description:
        'Validate a file for common errors after creating or editing it. ' +
        'For Markdown (.md): checks YAML front-matter is well-formed and that internal [text](path) links resolve to existing files. ' +
        'For canvas files (.tldr.json): checks the JSON is a valid tldraw snapshot.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file to check, e.g. "chapter1.md" or "diagrams/overview.tldr.json".',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_workspace_file',
      description:
        'Rename or move a file or folder to a new path within the workspace. ' +
        'Creates any missing parent directories in the destination path automatically. ' +
        'Use this when the user asks to rename, move, or reorganise files.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Current relative path from workspace root, e.g. "drafts/chapter1.md".',
          },
          to: {
            type: 'string',
            description: 'New relative path from workspace root, e.g. "book/part1/chapter1.md". Include the filename.',
          },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_workspace_file',
      description:
        'Permanently delete a file from the workspace. ' +
        'Only use when the user explicitly asks to delete or remove a file. ' +
        'Cannot delete folders — use run_command for that.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from workspace root of the file to delete.',
          },
          confirm: {
            type: 'string',
            description: 'Must be the exact string "yes" to confirm the deletion. Safety gate — never pass "yes" without the user explicitly authorising the delete.',
          },
        },
        required: ['path', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scaffold_workspace',
      description:
        'Create a folder structure and stub files in one atomic operation. ' +
        'Use when the user asks to set up a project layout, create a chapter structure, ' +
        'scaffold a course, or initialise any multi-file structure. ' +
        'Each entry can be a folder (path ending with /) or a file (with optional stub content).',
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'string',
            description:
              'JSON array of objects. Each object has:\n' +
              '  { "path": "relative/path/file.md", "content": "optional stub text" }\n' +
              '  { "path": "relative/folder/" }  ← trailing slash = create directory only\n' +
              'Paths are relative to the workspace root. Parent directories are created automatically.',
          },
          description: {
            type: 'string',
            description: 'Brief human-readable description of the structure being created, e.g. "3-part book scaffold".',
          },
        },
        required: ['entries'],
      },
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['md', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'rs', 'toml', 'yaml', 'yml', 'sh']);

// ── Tool executor factory ────────────────────────────────────────────────────

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Build the executor function for all workspace tools.
 * Pass the live tldraw editor ref (null when no canvas is open).
 * `onFileWritten` is called after write_workspace_file so the UI can refresh.
 * `onMarkRecorded` is called after write_workspace_file so the parent can record an AI edit mark.
 * `onCanvasModified` is called after canvas_op with the IDs of shapes that were created.
 * `onMemoryWritten` is called after remember so the UI can update the in-memory prompt state.
 * `webPreviewRef` exposes the live HTML preview pane so screenshot_preview can capture it.
 */
export function buildToolExecutor(
  workspacePath: string,
  canvasEditor: { current: Editor | null },
  onFileWritten?: (path: string) => void,
  onMarkRecorded?: (relPath: string, content: string) => void,
  onCanvasModified?: (shapeIds: string[]) => void,
  activeFile?: string,
  workspaceExportConfig?: WorkspaceExportConfig,
  onExportConfigChange?: (config: WorkspaceExportConfig) => void,
  onMemoryWritten?: (newContent: string) => void,
  webPreviewRef?: { current: { getScreenshot: () => Promise<string | null> } | null },
): ToolExecutor {
  /**
   * Validates that a workspace-relative path does not escape the workspace root
   * via path traversal sequences (e.g. "../../etc/passwd").
   * Returns the resolved absolute path on success, or throws on violation.
   */
  function safeResolvePath(wsPath: string, relPath: string): string {
    // Normalise: collapse any ".."/"." segments without touching the filesystem
    const segments: string[] = [];
    for (const seg of (`${wsPath}/${relPath}`).split('/')) {
      if (seg === '..') {
        segments.pop();
      } else if (seg !== '.') {
        segments.push(seg);
      }
    }
    const abs = segments.join('/');
    // Ensure the resolved path is still inside the workspace
    const wsNorm = wsPath.endsWith('/') ? wsPath : wsPath + '/';
    if (abs !== wsPath && !abs.startsWith(wsNorm)) {
      throw new Error(`Path traversal detected: "${relPath}" resolves outside the workspace.`);
    }
    return abs;
  }

  return async (name, args) => {
    switch (name) {

      // ── list_workspace_files ────────────────────────────────────────────
      case 'list_workspace_files': {
        const files = await walkFilesFlat(workspacePath);
        if (files.length === 0) return 'The workspace is empty.';
        return `${files.length} file(s) in workspace:\n${files.join('\n')}`;
      }

      // ── read_workspace_file ─────────────────────────────────────────────
      case 'read_workspace_file': {
        const relPath = String(args.path ?? '');
        if (!relPath) return 'Error: path is required.';
        let abs: string;
        try { abs = safeResolvePath(workspacePath, relPath); }
        catch (e) { return String(e); }
        if (!(await exists(abs))) return `File not found: ${relPath}`;
        try {
          const text = await readTextFile(abs);
          const lines = text.split('\n');
          const totalLines = lines.length;

          const hasRange = typeof args.start_line === 'number' || typeof args.end_line === 'number';
          if (hasRange) {
            const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
            const endLine   = typeof args.end_line   === 'number' ? Math.min(totalLines, args.end_line) : totalLines;
            const slice = lines.slice(startLine - 1, endLine).join('\n');
            return `[Lines ${startLine}\u2013${endLine} of ${totalLines} in ${relPath}]\n${slice}`;
          }

          // No range: full file, cap at 40 KB (raised from 12 KB)
          const CAP = 40_000;
          if (text.length > CAP) {
            // Truncate on a line boundary so the last returned line is complete
            const capText = text.slice(0, CAP);
            const capLines = capText.split('\n');
            const lastFullLine = capLines.length - 1; // the partial last line is dropped
            const truncated = capLines.slice(0, lastFullLine).join('\n');
            return `${truncated}\n\n[\u2026 truncated after line ${lastFullLine} of ${totalLines} total. ` +
              `Re-call with start_line=${lastFullLine + 1} to continue reading.]`;
          }
          return text;
        } catch (e) {
          return `Error reading file: ${e}`;
        }
      }

      // ── patch_workspace_file ────────────────────────────────────────────
      case 'patch_workspace_file': {
        const relPath = String(args.path    ?? '');
        const search  = String(args.search  ?? '');
        const replace = String(args.replace ?? '');
        if (!relPath) return 'Error: path is required.';
        if (!search)  return 'Error: search string is required (may not be empty).';
        if (relPath.endsWith('.tldr.json')) {
          return 'Error: canvas files (.tldr.json) cannot be patched — use canvas_op instead.';
        }
        let abs: string;
        try { abs = safeResolvePath(workspacePath, relPath); }
        catch (e) { return String(e); }
        if (!(await exists(abs))) return `File not found: ${relPath}`;
        let text: string;
        try { text = await readTextFile(abs); } catch (e) { return `Error reading file: ${e}`; }

        const occurrence = typeof args.occurrence === 'number' ? args.occurrence : 1;
        let newText: string;
        let replacementCount = 0;

        if (occurrence === 0) {
          // Replace all occurrences
          const parts = text.split(search);
          if (parts.length === 1) {
            return `Error: search string not found in ${relPath}. No changes made. ` +
              `(searched for: "${search.slice(0, 80)}${search.length > 80 ? '\u2026' : ''}")`;
          }
          replacementCount = parts.length - 1;
          newText = parts.join(replace);
        } else {
          // Replace the Nth occurrence (1-based)
          let pos = -1;
          let n = 0;
          let cursor = 0;
          while (n < occurrence) {
            const idx = text.indexOf(search, cursor);
            if (idx === -1) break;
            pos = idx;
            n++;
            cursor = idx + search.length;
          }
          if (pos === -1) {
            const total = text.split(search).length - 1;
            const preview = `"${search.slice(0, 80)}${search.length > 80 ? '\u2026' : ''}"`;
            if (total === 0) {
              return `Error: search string not found in ${relPath}. No changes made. (searched for: ${preview})`;
            }
            return `Error: occurrence ${occurrence} requested but only ${total} match(es) found in ${relPath}. No changes made.`;
          }
          newText = text.slice(0, pos) + replace + text.slice(pos + search.length);
          replacementCount = 1;
        }

        lockFile(relPath);
        await new Promise<void>((r) => setTimeout(r, 0));
        try {
          await writeTextFile(abs, newText);
        } catch (e) {
          unlockFile(relPath);
          return `Error writing file: ${e}`;
        }
        try {
          onFileWritten?.(relPath);
          onMarkRecorded?.(relPath, newText);
          await new Promise<void>((r) => setTimeout(r, 400));
        } finally {
          unlockFile(relPath);
        }

        const occStr = occurrence === 0 ? `all ${replacementCount}` : `occurrence ${occurrence}`;
        return `Patched ${relPath}: replaced ${occStr} occurrence(s) successfully (${text.length} \u2192 ${newText.length} chars).`;
      }

      // ── write_workspace_file ────────────────────────────────────────────
      case 'write_workspace_file': {
        const relPath = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!relPath) return 'Error: path is required.';
        if (!content) return 'Error: content is empty — the file was not written. Check argument parsing.';
        // Canvas files must be modified through canvas_op, not raw text writes.
        // Overwriting a .tldr.json with arbitrary text corrupts the tldraw snapshot.
        if (relPath.endsWith('.tldr.json')) {
          return 'Error: canvas files (.tldr.json) cannot be written with write_workspace_file — use the canvas_op tool instead. Writing raw JSON to a canvas file would corrupt its tldraw format.';
        }
        console.debug('[write_workspace_file] path:', relPath, 'content length:', content.length);
        let abs: string;
        try { abs = safeResolvePath(workspacePath, relPath); }
        catch (e) { return String(e); }
        // Create any parent dirs
        const dir = abs.split('/').slice(0, -1).join('/');
        lockFile(relPath);
        // Yield once so React can paint the shimmer before the write starts
        await new Promise<void>((r) => setTimeout(r, 0));
        try {
          if (!(await exists(dir))) {
            await mkdir(dir, { recursive: true });
          }
          await writeTextFile(abs, content);
          console.debug('[write_workspace_file] success:', abs);
        } catch (e) {
          console.error('[write_workspace_file] FAILED:', e);
          unlockFile(relPath);
          return `Error writing file: ${e}`;
        }
        // Notify sidebar now (while still locked — shimmer shows during refresh).
        // Use try/finally so the lock is ALWAYS released even if a callback throws.
        try {
          onFileWritten?.(relPath);
          onMarkRecorded?.(relPath, content);
          // Hold lock for a minimum visible duration so the shimmer is noticeable
          await new Promise<void>((r) => setTimeout(r, 400));
        } finally {
          unlockFile(relPath);
        }
        return `File written successfully: ${relPath} (${content.length} chars)`;
      }

      // ── search_workspace ────────────────────────────────────────────────
      case 'search_workspace': {
        const query = String(args.query ?? '').trim();
        if (!query) return 'Error: query is required.';
        const files = await walkFilesFlat(workspacePath);
        const textFiles = files.filter((f) => {
          // Canvas files (.tldr.json) use JSON as a binary-ish format — searching
          // them returns raw shape JSON that is meaningless to the user.
          if (f.endsWith('.tldr.json')) return false;
          const ext = f.split('.').pop()?.toLowerCase() ?? '';
          return TEXT_EXTS.has(ext);
        });

        const needle = query.toLowerCase();
        const hits: string[] = [];
        const MAX_HITS = 30;

        for (const rel of textFiles) {
          if (hits.length >= MAX_HITS) break;
          let text: string;
          try { text = await readTextFile(`${workspacePath}/${rel}`); } catch { continue; }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= MAX_HITS) break;
            if (lines[i].toLowerCase().includes(needle)) {
              const before = i > 0 ? `  ${lines[i - 1]}` : '';
              const after  = i < lines.length - 1 ? `  ${lines[i + 1]}` : '';
              hits.push(`${rel}:${i + 1}:\n${before}\n> ${lines[i]}\n${after}`);
            }
          }
        }

        if (hits.length === 0) return `No matches found for "${query}" across ${textFiles.length} files.`;
        return `Found ${hits.length} match(es) for "${query}":\n\n${hits.join('\n\n')}`;
      }

      // ── list_canvas_shapes ───────────────────────────────────────────────
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
        // Strip any ```canvas...``` fencing the AI may have double-wrapped around
        // its commands before we re-wrap it — prevents running the block twice.
        const stripped = rawCommands
          .replace(/^```canvas\r?\n/, '')
          .replace(/\n```\s*$/, '');
        // Wrap in a ```canvas block so executeCanvasCommands can parse it
        const fenced = '```canvas\n' + stripped + '\n```';
        if (activeFile) lockFile(activeFile);
        // Yield so React renders the lock overlay before we mutate the canvas
        await new Promise<void>((r) => setTimeout(r, 0));
        let count = 0;
        let shapeIds: string[] = [];
        let errors: string[] = [];
        try {
          ({ count, shapeIds, errors } = executeCanvasCommands(editor, fenced));
        } finally {
          // Always release the lock — even if executeCanvasCommands throws
          if (activeFile) unlockFile(activeFile);
        }
        if (count === 0) {
          const errDetail = errors.length ? ` Errors: ${errors.join('; ')}` : '';
          return `No commands were executed. Check the command syntax.${errDetail}`;
        }
        // Notify the parent so it can: (a) record AI marks, (b) force-sync the slide strip
        onCanvasModified?.(shapeIds);
        // No artificial delay — the lock was released in the finally block above
        // immediately after executeCanvasCommands returned, so the shimmer already
        // cleared at the right time (when mutations finished, not 400ms later).
        // errors.length is always 0 here — executeCanvasCommands returns count:0
        // on any error (rollback), so `count > 0` and `errors.length > 0` are
        // mutually exclusive. No errSuffix needed.
        return `Executed ${count} canvas operation(s) successfully.`;
      }
      // ── canvas_screenshot ──────────────────────────────────────
      case 'canvas_screenshot': {
        const editor = canvasEditor.current;
        if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';
        const url = await canvasToDataUrl(editor, 0.5);
        if (!url) return 'Canvas is empty — nothing to screenshot.';
        // The agent loop detects this sentinel and injects a vision user message
        // so the model can visually verify the canvas.
        return `__CANVAS_PNG__:${url}`;
      }

      // ── screenshot_preview ────────────────────────────────────────
      case 'screenshot_preview': {
        if (!webPreviewRef?.current) {
          return 'No HTML preview is currently open. Open an HTML file and switch to preview mode, then try again.';
        }
        const url = await webPreviewRef.current.getScreenshot();
        if (!url) return 'Preview screenshot failed — the preview may still be loading or the file is empty.';
        // The agent loop detects this sentinel and injects a vision user message.
        return `__PREVIEW_PNG__:${url}`;
      }

      // ── web_search ─────────────────────────────────────────────
      case 'web_search': {
        const query = String(args.query ?? '').trim();
        if (!query) return 'Error: query is required.';

        // DuckDuckGo Instant Answer API — free, no key required
        const ddgUrl =
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        try {
          const res = await tauriFetch(ddgUrl, { method: 'GET' });
          if (!res.ok) return `Search API returned ${res.status}. Try rephrasing your query.`;
          const data = await res.json() as {
            AbstractText?: string;
            AbstractURL?: string;
            AbstractSource?: string;
            RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
            Answer?: string;
            Infobox?: { content?: Array<{ label?: string; value?: unknown }> };
          };

          const lines: string[] = [];

          // Direct answer (e.g. "2 + 2 = 4" type queries)
          if (data.Answer) lines.push(`**Answer:** ${data.Answer}`);

          // Main abstract
          if (data.AbstractText) {
            lines.push(data.AbstractText);
            if (data.AbstractSource && data.AbstractURL) {
              lines.push(`Source: [${data.AbstractSource}](${data.AbstractURL})`);
            }
          }

          // Related topics (up to 8)
          const topics: Array<{ Text?: string; FirstURL?: string }> = [];
          for (const t of (data.RelatedTopics ?? [])) {
            if (topics.length >= 8) break;
            if (t.Text) {
              topics.push(t);
            } else if (t.Topics) {
              // Nested topic group
              for (const sub of t.Topics) {
                if (topics.length >= 8) break;
                if (sub.Text) topics.push(sub);
              }
            }
          }
          if (topics.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push('**Related topics:**');
            for (const t of topics) {
              lines.push(`• ${t.Text ?? ''}${t.FirstURL ? `\n  ${t.FirstURL}` : ''}`);
            }
          }

          if (lines.length === 0) {
            return (
              `No DuckDuckGo summary found for "${query}". ` +
              `Try a more specific query, or suggest the user search at https://duckduckgo.com/?q=${encodeURIComponent(query)}`
            );
          }
          return `**Web search results for "${query}":**\n\n${lines.join('\n')}`;
        } catch (e) {
          return `Web search failed: ${e}. The user may need to allow network access in Tauri capabilities.`;
        }
      }

      // ── search_stock_images ────────────────────────────────────
      case 'search_stock_images': {
        const query = String(args.query ?? '').trim();
        if (!query) return 'Error: query is required.';

        // Read Pexels API key from localStorage (set by the UI ImageSearchPanel)
        const pexelsKey = typeof window !== 'undefined'
          ? (window.localStorage.getItem('cafezin_pexels_key') ?? '')
          : '';

        if (!pexelsKey) {
          return (
            'No Pexels API key configured. ' +
            'Ask the user to click the "🖼 Images" button in the sidebar, then enter their free API key from pexels.com/api (takes ~30 seconds to get one). ' +
            'Once set, you can search for images automatically.'
          );
        }

        const count = Math.min(6, Math.max(1, typeof args.count === 'number' ? args.count : 4));
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;

        try {
          const res = await tauriFetch(url, {
            method: 'GET',
            headers: { Authorization: pexelsKey },
          });
          if (!res.ok) return `Pexels API error: HTTP ${res.status}. Check your API key.`;

          const data = await res.json() as {
            total_results: number;
            photos: Array<{
              id: number; alt: string; photographer: string; width: number; height: number;
              src: { large: string; medium: string };
            }>;
          };

          if (!data.photos?.length) return `No stock photos found for "${query}". Try different keywords.`;

          const lines: string[] = [`Found ${data.total_results.toLocaleString()} photos on Pexels for "${query}". Top ${data.photos.length} results:\n`];
          for (const p of data.photos) {
            lines.push(
              `**[${p.id}]** ${p.alt || 'Untitled'} — by ${p.photographer}\n` +
              `  Size: ${p.width}×${p.height}px\n` +
              `  URL: ${p.src.large}`
            );
          }
          lines.push('\nTo place an image on the canvas, call add_canvas_image with one of the URLs above.');
          return lines.join('\n');
        } catch (e) {
          return `Stock image search failed: ${e}`;
        }
      }

      // ── run_command ────────────────────────────────────────────
      case 'run_command': {
        if (import.meta.env.VITE_TAURI_MOBILE === 'true') {
          return 'Error: run_command is not available on iOS — shell execution is not supported on mobile devices.';
        }
        const command = String(args.command ?? '').trim();
        if (!command) return 'Error: command is required.';
        const relCwd = String(args.cwd ?? '').trim();
        const absCwd = relCwd ? `${workspacePath}/${relCwd}` : workspacePath;
        try {
          const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
            'shell_run',
            { cmd: command, cwd: absCwd },
          );
          // Surface AI-run commands in the bottom terminal panel
          emitTerminalEntry({
            source: 'ai',
            command,
            cwd: absCwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exit_code,
            ts: Date.now(),
          });
          const parts: string[] = [`$ ${command}`, `exit code: ${result.exit_code}`];
          if (result.stdout.trim()) parts.push(`stdout:
${result.stdout.trim()}`);
          if (result.stderr.trim()) parts.push(`stderr:
${result.stderr.trim()}`);
          return parts.join('\n');
        } catch (e) {
          return `Error running command: ${e}`;
        }
      }

      // ── export_workspace ───────────────────────────────────────
      case 'export_workspace': {
        const targets = workspaceExportConfig?.targets ?? [];
        if (targets.length === 0) {
          return 'No export targets configured. Ask the user to open Export Settings (via the ↓ Export button) and define at least one target, or use configure_export_targets to add one.';
        }
        const targetArg = String(args.target ?? 'all').toLowerCase();
        const toRun = targetArg === 'all'
          ? targets.filter((t) => t.enabled)
          : targets.filter((t) => t.name.toLowerCase() === targetArg || t.id === args.target);

        if (toRun.length === 0) {
          const names = targets.map((t) => `"${t.name}"`).join(', ');
          return `No matching target found for "${args.target ?? 'all'}". Available targets: ${names}`;
        }

        const lines: string[] = [];
        for (const target of toRun) {
          try {
            const result = await runExportTarget({
              workspacePath,
              target,
              canvasEditorRef: canvasEditor,
              activeCanvasRel: typeof activeFile === 'string' ? activeFile : null,
            });
            const okPart  = result.outputs.length > 0 ? `✓ ${result.outputs.join(', ')}` : '';
            const errPart = result.errors.length  > 0 ? `⚠ ${result.errors.join('; ')}` : '';
            lines.push(`[${target.name}] ${[okPart, errPart].filter(Boolean).join(' | ')} (${result.elapsed}ms)`);
          } catch (e) {
            lines.push(`[${target.name}] Failed: ${e}`);
          }
        }
        return lines.join('\n');
      }

      // ── configure_export_targets ──────────────────────────────────
      case 'configure_export_targets': {
        const action = String(args.action ?? 'list');
        const currentTargets: ExportTarget[] = workspaceExportConfig?.targets ?? [];

        if (action === 'list') {
          if (currentTargets.length === 0) return 'No export targets configured yet.';
          return JSON.stringify(currentTargets, null, 2);
        }

        if (!onExportConfigChange) {
          return 'Export config changes are not available in this context.';
        }

        if (action === 'add') {
          if (!args.name) return 'Error: name is required for add.';
          if (!args.format) return 'Error: format is required for add.';
          const newTarget: ExportTarget = {
            id: Math.random().toString(36).slice(2, 9),
            name: String(args.name),
            description: args.description ? String(args.description) : undefined,
            format: String(args.format) as ExportFormat,
            include: Array.isArray(args.include) ? args.include.map(String) : [],
            includeFiles: Array.isArray(args.includeFiles) ? args.includeFiles.map(String) : undefined,
            excludeFiles: Array.isArray(args.excludeFiles) ? args.excludeFiles.map(String) : undefined,
            outputDir: args.outputDir ? String(args.outputDir) : 'dist',
            customCommand: args.customCommand ? String(args.customCommand) : undefined,
            enabled: args.enabled !== false,
            merge: args.merge === true ? true : undefined,
            mergeName: args.mergeName ? String(args.mergeName) : undefined,
          };
          const next: WorkspaceExportConfig = { targets: [...currentTargets, newTarget] };
          onExportConfigChange(next);
          return `Added target "${newTarget.name}" (id: ${newTarget.id}).`;
        }

        if (action === 'update') {
          const match = currentTargets.find((t) =>
            (args.id && t.id === args.id) || (args.name && t.name.toLowerCase() === String(args.name).toLowerCase())
          );
          if (!match) return `Target not found: ${args.id ?? args.name}`;
          const patch: Partial<ExportTarget> = {};
          if (args.name        !== undefined) patch.name         = String(args.name);
          if (args.description !== undefined) patch.description  = String(args.description);
          if (args.format      !== undefined) patch.format       = String(args.format) as ExportFormat;
          if (args.include     !== undefined) patch.include      = Array.isArray(args.include) ? args.include.map(String) : [];
          if (args.includeFiles!== undefined) patch.includeFiles = Array.isArray(args.includeFiles) ? args.includeFiles.map(String) : [];
          if (args.excludeFiles!== undefined) patch.excludeFiles = Array.isArray(args.excludeFiles) ? args.excludeFiles.map(String) : [];
          if (args.outputDir   !== undefined) patch.outputDir    = String(args.outputDir);
          if (args.customCommand!==undefined) patch.customCommand= String(args.customCommand);
          if (args.enabled     !== undefined) patch.enabled      = Boolean(args.enabled);
          if (args.merge       !== undefined) patch.merge        = Boolean(args.merge);
          if (args.mergeName   !== undefined) patch.mergeName    = String(args.mergeName);
          const next: WorkspaceExportConfig = { targets: currentTargets.map((t) => t.id === match.id ? { ...t, ...patch } : t) };
          onExportConfigChange(next);
          return `Updated target "${match.name}".`;
        }

        if (action === 'remove') {
          const match = currentTargets.find((t) =>
            (args.id && t.id === args.id) || (args.name && t.name.toLowerCase() === String(args.name).toLowerCase())
          );
          if (!match) return `Target not found: ${args.id ?? args.name}`;
          const next: WorkspaceExportConfig = { targets: currentTargets.filter((t) => t.id !== match.id) };
          onExportConfigChange(next);
          return `Removed target "${match.name}".`;
        }

        return `Unknown action: ${action}. Use list, add, update, or remove.`;
      }

      // ── add_canvas_image ───────────────────────────────────────
      case 'add_canvas_image': {
        const editor = canvasEditor.current;
        if (!editor) return 'No canvas is currently open. Ask the user to open a .tldr.json canvas file first.';

        const imgUrl = String(args.url ?? '').trim();
        if (!imgUrl) return 'Error: url is required.';

        // Detect mime type from URL extension
        const ext = imgUrl.split('?')[0].split('.').pop()?.toLowerCase() ?? 'png';
        const mimeType = getMimeType(ext, 'image/png');

        // Get natural dimensions by loading the image in the browser
        let natW = 800;
        let natH = 600;
        try {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => { natW = img.naturalWidth || 800; natH = img.naturalHeight || 600; resolve(); };
            img.onerror = () => resolve(); // use defaults on error
            img.src = imgUrl;
          });
        } catch { /* use defaults */ }

        const imgName = imgUrl.split('/').pop()?.split('?')[0] ?? 'image';
        const placed = placeImageOnCanvas(editor, imgUrl, imgName, mimeType, natW, natH, {
          x: typeof args.x === 'number' ? args.x : undefined,
          y: typeof args.y === 'number' ? args.y : undefined,
          width: typeof args.width === 'number' ? args.width : undefined,
        });

        return `Image added to canvas at (${placed.x}, ${placed.y}) with size ${placed.w}\u00d7${placed.h}px. Source: ${imgUrl}`;
      }

      // ── remember ──────────────────────────────────────────────
      case 'remember': {
        const memContent = String(args.content ?? '').trim();
        const heading    = String(args.heading  ?? '').trim();
        if (!memContent) return 'Error: content is required.';

        const memRelPath = '.cafezin/memory.md';
        let abs: string;
        try { abs = safeResolvePath(workspacePath, memRelPath); }
        catch (e) { return String(e); }

        const dir = abs.split('/').slice(0, -1).join('/');
        if (!(await exists(dir))) await mkdir(dir, { recursive: true });

        let existing = '';
        try { if (await exists(abs)) existing = await readTextFile(abs); } catch { /* treat as empty */ }

        const sectionTitle = heading || 'Notes';
        const sectionHeader = `## ${sectionTitle}`;
        const idx = existing.indexOf(sectionHeader);
        let updated: string;
        if (idx !== -1) {
          const nextSection = existing.indexOf('\n## ', idx + sectionHeader.length);
          const insertAt = nextSection !== -1 ? nextSection : existing.length;
          updated = existing.slice(0, insertAt).trimEnd() + `\n- ${memContent}\n` + existing.slice(insertAt);
        } else {
          const base = existing.trimEnd();
          updated = (base ? base + '\n\n' : '# Workspace Memory\n\n') + `${sectionHeader}\n- ${memContent}\n`;
        }

        try {
          await writeTextFile(abs, updated);
          onMemoryWritten?.(updated);
          onFileWritten?.(memRelPath);
        } catch (e) {
          return `Error saving memory: ${e}`;
        }
        const preview = memContent.length > 80 ? memContent.slice(0, 80) + '\u2026' : memContent;
        return `Remembered under "${sectionTitle}": "${preview}" (saved to ${memRelPath})`;
      }

      // ── fetch_url ──────────────────────────────────────────────
      case 'fetch_url': {
        const url = String(args.url ?? '').trim();
        if (!url) return 'Error: url is required.';
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return 'Error: URL must start with http:// or https://';
        }
        try {
          const res = await tauriFetch(url, {
            method: 'GET',
            headers: { Accept: 'text/html,text/plain,*/*', 'User-Agent': 'Mozilla/5.0' },
          });
          if (!res.ok) return `HTTP ${res.status} from ${url}. The server refused the request.`;
          const raw = await res.text();
          const stripped = raw
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          const CAP = 16_000;
          const result = stripped.length > CAP
            ? stripped.slice(0, CAP) + `\n\n[\u2026 truncated after ${CAP} chars. Full page is ${stripped.length} chars.]`
            : stripped;
          return `Content of ${url}:\n\n${result}`;
        } catch (e) {
          return `Error fetching URL: ${e}`;
        }
      }

      // ── check_file ────────────────────────────────────────────
      case 'check_file': {
        const relPath = String(args.path ?? '').trim();
        if (!relPath) return 'Error: path is required.';
        let abs: string;
        try { abs = safeResolvePath(workspacePath, relPath); }
        catch (e) { return String(e); }
        if (!(await exists(abs))) return `File not found: ${relPath}`;
        let text: string;
        try { text = await readTextFile(abs); } catch (e) { return `Error reading file: ${e}`; }

        const issues: string[] = [];

        if (relPath.endsWith('.tldr.json')) {
          try {
            const json = JSON.parse(text) as Record<string, unknown>;
            const hasKeys = json.document !== undefined || json.store !== undefined || json.records !== undefined;
            if (!hasKeys) {
              issues.push('JSON parses but is missing expected tldraw keys (document/store/records). The canvas may be corrupted.');
            } else {
              const store = json.store as Record<string, unknown> | undefined;
              const records = json.records as unknown[] | undefined;
              const shapeCount = store
                ? Object.keys(store).filter((k) => k.startsWith('shape:')).length
                : (records ?? []).filter((r: any) => r?.typeName === 'shape').length;
              return `\u2713 Valid tldraw canvas (${shapeCount} shape(s)).`;
            }
          } catch (e) {
            issues.push(`Invalid JSON: ${e}`);
          }
        } else if (relPath.endsWith('.md') || relPath.endsWith('.mdx')) {
          // 1. YAML front-matter
          if (text.startsWith('---')) {
            const fmEnd = text.indexOf('\n---', 3);
            if (fmEnd === -1) {
              issues.push('Front-matter: opening "---" found but no closing "---" delimiter. The block is unclosed.');
            } else {
              const fmLines = text.slice(3, fmEnd).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
              for (const line of fmLines) {
                if (!/^[ \t]*[a-zA-Z0-9_-]+\s*:/.test(line) && !/^[ \t]*-/.test(line) && !/^[ \t]+/.test(line)) {
                  issues.push(`Front-matter: possibly malformed line: "${line.trim()}". Expected "key: value" format.`);
                }
              }
            }
          }
          // 2. Internal Markdown links [text](path)
          const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
          let m: RegExpExecArray | null;
          while ((m = linkRe.exec(text)) !== null) {
            const href = m[2].split('#')[0].trim();
            if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('/')) continue;
            // Resolve relative to the directory containing this file
            const fileDir = relPath.split('/').slice(0, -1).join('/');
            const raw = fileDir ? `${fileDir}/${href}` : href;
            const segs: string[] = [];
            for (const seg of raw.split('/')) {
              if (seg === '..') segs.pop();
              else if (seg !== '.') segs.push(seg);
            }
            const linkedAbs = `${workspacePath}/${segs.join('/')}`;
            if (!(await exists(linkedAbs))) {
              issues.push(`Broken link: [${m[1]}](${m[2]}) \u2192 "${segs.join('/')}" not found in workspace.`);
            }
          }
        } else {
          return `check_file only supports .md, .mdx, and .tldr.json files (got: ${relPath}).`;
        }

        if (issues.length === 0) return `\u2713 No issues found in ${relPath}.`;
        return `Found ${issues.length} issue(s) in ${relPath}:\n${issues.map((is, n) => `${n + 1}. ${is}`).join('\n')}`;
      }

      // ── rename_workspace_file ──────────────────────────────────
      case 'rename_workspace_file': {
        const fromRel = String(args.from ?? '').trim();
        const toRel   = String(args.to   ?? '').trim();
        if (!fromRel) return 'Error: from is required.';
        if (!toRel)   return 'Error: to is required.';
        if (fromRel === toRel) return 'Error: from and to are the same path — nothing to do.';
        let fromAbs: string, toAbs: string;
        try {
          fromAbs = safeResolvePath(workspacePath, fromRel);
          toAbs   = safeResolvePath(workspacePath, toRel);
        } catch (e) { return String(e); }
        if (!(await exists(fromAbs))) return `File not found: ${fromRel}`;
        if (await exists(toAbs)) return `Error: destination already exists: ${toRel}. Choose a different name or delete it first.`;
        // Create any missing parent directories in the destination
        const toDir = toAbs.split('/').slice(0, -1).join('/');
        if (!(await exists(toDir))) await mkdir(toDir, { recursive: true });
        try {
          await rename(fromAbs, toAbs);
          onFileWritten?.(toRel);
        } catch (e) { return `Error renaming file: ${e}`; }
        return `Renamed "${fromRel}" → "${toRel}" successfully.`;
      }

      // ── delete_workspace_file ──────────────────────────────────
      case 'delete_workspace_file': {
        const relPath = String(args.path    ?? '').trim();
        const confirm = String(args.confirm ?? '').trim();
        if (!relPath)          return 'Error: path is required.';
        if (confirm !== 'yes') return 'Error: confirm must be "yes" to delete a file. Do not pass "yes" without explicit user authorisation.';
        // Guard precious system files
        if (relPath === '.cafezin/memory.md') {
          return 'Error: .cafezin/memory.md is the workspace memory file. Use the remember tool to edit it — do not delete it.';
        }
        let abs: string;
        try { abs = safeResolvePath(workspacePath, relPath); }
        catch (e) { return String(e); }
        if (!(await exists(abs))) return `File not found: ${relPath}.`;
        try {
          await remove(abs);
          onFileWritten?.(relPath);
        } catch (e) { return `Error deleting file: ${e}`; }
        return `Deleted "${relPath}" permanently.`;
      }

      // ── scaffold_workspace ────────────────────────────────────
      case 'scaffold_workspace': {
        const raw = String(args.entries ?? '').trim();
        if (!raw) return 'Error: entries is required.';
        let entries: Array<{ path: string; content?: string }>;
        try {
          entries = JSON.parse(raw);
          if (!Array.isArray(entries)) return 'Error: entries must be a JSON array.';
        } catch (e) { return `Error: entries is not valid JSON: ${e}`; }

        const created: string[] = [];
        const skipped: string[] = [];
        const errors: string[] = [];

        for (const entry of entries) {
          const entryPath = String(entry?.path ?? '').trim();
          if (!entryPath) { errors.push('Entry with empty path — skipped.'); continue; }
          const isDir = entryPath.endsWith('/');
          let abs: string;
          try { abs = safeResolvePath(workspacePath, entryPath.replace(/\/$/, '')); }
          catch (e) { errors.push(`Path traversal: ${entryPath}`); continue; }

          if (await exists(abs)) { skipped.push(entryPath); continue; }

          try {
            if (isDir) {
              await mkdir(abs, { recursive: true });
              created.push(`${entryPath} (dir)`);
            } else {
              // Ensure parent dir exists
              const dir = abs.split('/').slice(0, -1).join('/');
              if (!(await exists(dir))) await mkdir(dir, { recursive: true });
              const stubContent = typeof entry.content === 'string' ? entry.content : '';
              await writeTextFile(abs, stubContent);
              onFileWritten?.(entryPath);
              created.push(entryPath);
            }
          } catch (e) {
            errors.push(`Failed to create ${entryPath}: ${e}`);
          }
        }

        const desc = args.description ? ` (${args.description})` : '';
        const parts: string[] = [`Scaffold complete${desc}.`];
        if (created.length)  parts.push(`Created (${created.length}): ${created.join(', ')}`);
        if (skipped.length)  parts.push(`Skipped — already exist (${skipped.length}): ${skipped.join(', ')}`);
        if (errors.length)   parts.push(`Errors (${errors.length}): ${errors.join('; ')}`);
        return parts.join('\n');
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
