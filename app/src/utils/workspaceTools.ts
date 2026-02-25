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
 */

import {
  readTextFile,
  writeTextFile,
  readDir,
  mkdir,
  exists,
} from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { Editor } from 'tldraw';
import { executeCanvasCommands, canvasToDataUrl, summarizeCanvas } from './canvasAI';
import { runExportTarget } from './exportWorkspace';
import { emitTerminalEntry } from '../services/terminalBus';
import { lockFile, unlockFile } from '../services/copilotLock';
import { WORKSPACE_SKIP } from '../services/config';
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
        'Read the full content of a file. Use this to look at a document, course material, or config file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from workspace root, e.g. "chapter1.md" or "notes/ideas.md"',
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
        'List all shapes currently on the open canvas. Returns each shape\'s short ID (last 6 chars), type, position, size, color, fill, and text content. Arrow shapes include their start/end coordinates. Call this before update, move, or delete operations to get valid shape IDs.',
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
              '  {"op":"add_note","text":"…","x":100,"y":100,"color":"yellow"}',
              '  {"op":"add_text","text":"…","x":100,"y":200,"color":"black"}',
              '  {"op":"add_geo","geo":"rectangle","text":"Label","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid"}',
              '  {"op":"add_arrow","x1":100,"y1":150,"x2":400,"y2":150,"label":"depends on","color":"grey"}',
              '  {"op":"move","id":"abc123","x":300,"y":400}       ← reposition a shape',
              '  {"op":"update","id":"abc123","text":"New text"}   ← id from list_canvas_shapes',
              '  {"op":"delete","id":"abc123"}',
              '  {"op":"clear"}  ← DANGER: removes ALL shapes. Only use when the user explicitly asks to wipe the canvas.',
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
      parameters: { type: 'object', properties: {}, required: [] },
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
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['md', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'rs', 'toml', 'yaml', 'yml', 'sh']);

async function listFilesFlat(dir: string, rel = ''): Promise<string[]> {
  let entries;
  try { entries = await readDir(dir); } catch { return []; }
  const paths: string[] = [];
  for (const e of entries) {
    if (!e.name || WORKSPACE_SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) {
      paths.push(...await listFilesFlat(`${dir}/${e.name}`, relPath));
    } else {
      paths.push(relPath);
    }
  }
  return paths.sort();
}

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
): ToolExecutor {
  return async (name, args) => {
    switch (name) {

      // ── list_workspace_files ────────────────────────────────────────────
      case 'list_workspace_files': {
        const files = await listFilesFlat(workspacePath);
        if (files.length === 0) return 'The workspace is empty.';
        return `${files.length} file(s) in workspace:\n${files.join('\n')}`;
      }

      // ── read_workspace_file ─────────────────────────────────────────────
      case 'read_workspace_file': {
        const relPath = String(args.path ?? '');
        if (!relPath) return 'Error: path is required.';
        const abs = `${workspacePath}/${relPath}`;
        if (!(await exists(abs))) return `File not found: ${relPath}`;
        try {
          const text = await readTextFile(abs);
          // Cap at 12 kB to avoid blowing the context window
          const cap = 12_000;
          if (text.length > cap) {
            return text.slice(0, cap) + `\n\n[… truncated at ${cap} chars. File is ${text.length} chars total.]`;
          }
          return text;
        } catch (e) {
          return `Error reading file: ${e}`;
        }
      }

      // ── write_workspace_file ────────────────────────────────────────────
      case 'write_workspace_file': {
        const relPath = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!relPath) return 'Error: path is required.';
        if (!content) return 'Error: content is empty — the file was not written. Check argument parsing.';
        console.debug('[write_workspace_file] path:', relPath, 'content length:', content.length);
        const abs = `${workspacePath}/${relPath}`;
        // Create any parent dirs
        const dir = abs.split('/').slice(0, -1).join('/');
        lockFile(relPath);
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
        unlockFile(relPath);
        onFileWritten?.(relPath);
        onMarkRecorded?.(relPath, content);
        return `File written successfully: ${relPath} (${content.length} chars)`;
      }

      // ── search_workspace ────────────────────────────────────────────────
      case 'search_workspace': {
        const query = String(args.query ?? '').trim();
        if (!query) return 'Error: query is required.';
        const files = await listFilesFlat(workspacePath);
        const textFiles = files.filter((f) => {
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
        const commands = String(args.commands ?? '');
        // Wrap in a ```canvas block so executeCanvasCommands can parse it
        const fenced = '```canvas\n' + commands + '\n```';
        if (activeFile) lockFile(activeFile);
        const { count, shapeIds } = executeCanvasCommands(editor, fenced);
        if (activeFile) unlockFile(activeFile);
        if (count === 0) return 'No commands were executed. Check the command syntax.';
        // Notify the parent so it can: (a) record AI marks, (b) force-sync the slide strip
        onCanvasModified?.(shapeIds);
        return `Executed ${count} canvas operation(s) successfully.`;
      }
      // ── canvas_screenshot ──────────────────────────────────────
      case 'canvas_screenshot': {
        const editor = canvasEditor.current;
        if (!editor) return 'No canvas is currently open.';
        const url = await canvasToDataUrl(editor, 0.5);
        if (!url) return 'Canvas is empty — nothing to screenshot.';
        // The agent loop detects this sentinel and injects a vision user message
        // so the model can visually verify the canvas.
        return `__CANVAS_PNG__:${url}`;
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
        const MIME_MAP: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        };
        const mimeType = MIME_MAP[ext] ?? 'image/png';

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

        // Compute display size — scale down if too wide, respect optional override
        const maxW = 800;
        const desiredW = typeof args.width === 'number' ? args.width : Math.min(natW, maxW);
        const scale = desiredW / natW;
        const dispW = Math.round(desiredW);
        const dispH = Math.round(natH * scale);

        // Determine placement position
        let placeX: number;
        let placeY: number;
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          placeX = args.x;
          placeY = args.y;
        } else {
          const vp = editor.getViewportPageBounds();
          placeX = Math.round(vp.x + vp.w / 2 - dispW / 2);
          placeY = Math.round(vp.y + vp.h / 2 - dispH / 2);
        }

        // Create the asset record (inline URL — tldraw stores the src as-is)
        const assetId = `asset:img_${Math.random().toString(36).slice(2)}` as ReturnType<typeof editor.getAssets>[0]['id'];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.createAssets([{
          id: assetId,
          typeName: 'asset',
          type: 'image',
          props: {
            name: imgUrl.split('/').pop()?.split('?')[0] ?? 'image',
            src: imgUrl,
            w: natW,
            h: natH,
            mimeType,
            isAnimated: mimeType === 'image/gif',
          },
          meta: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any]);

        // Create the image shape
        editor.createShape({
          type: 'image',
          x: placeX,
          y: placeY,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { assetId, w: dispW, h: dispH } as any,
        });

        return `Image added to canvas at (${placeX}, ${placeY}) with size ${dispW}×${dispH}px. Source: ${imgUrl}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
