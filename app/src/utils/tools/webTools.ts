/**
 * Web and system workspace tools: web search, stock image search,
 * URL fetching, and shell command execution.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { emitTerminalEntry } from '../../services/terminalBus';
import type { ToolDefinition, DomainExecutor } from './shared';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const WEB_TOOL_DEFS: ToolDefinition[] = [
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
];

// ── Executor ─────────────────────────────────────────────────────────────────

export const executeWebTools: DomainExecutor = async (name, args, ctx) => {
  const { workspacePath } = ctx;

  switch (name) {

    // ── web_search ───────────────────────────────────────────────────────
    case 'web_search': {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: query is required.';

      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      try {
        const res = await tauriFetch(ddgUrl, { method: 'GET' });
        if (!res.ok) return `Search API returned ${res.status}. Try rephrasing your query.`;
        const data = await res.json() as {
          AbstractText?: string;
          AbstractURL?: string;
          AbstractSource?: string;
          RelatedTopics?: Array<{
            Text?: string;
            FirstURL?: string;
            Topics?: Array<{ Text?: string; FirstURL?: string }>;
          }>;
          Answer?: string;
          Infobox?: { content?: Array<{ label?: string; value?: unknown }> };
        };

        const lines: string[] = [];

        if (data.Answer) lines.push(`**Answer:** ${data.Answer}`);

        if (data.AbstractText) {
          lines.push(data.AbstractText);
          if (data.AbstractSource && data.AbstractURL) {
            lines.push(`Source: [${data.AbstractSource}](${data.AbstractURL})`);
          }
        }

        const topics: Array<{ Text?: string; FirstURL?: string }> = [];
        for (const t of (data.RelatedTopics ?? [])) {
          if (topics.length >= 8) break;
          if (t.Text) {
            topics.push(t);
          } else if (t.Topics) {
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

    // ── search_stock_images ──────────────────────────────────────────────
    case 'search_stock_images': {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: query is required.';

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
            id: number;
            alt: string;
            photographer: string;
            width: number;
            height: number;
            src: { large: string; medium: string };
          }>;
        };

        if (!data.photos?.length) return `No stock photos found for "${query}". Try different keywords.`;

        const lines: string[] = [
          `Found ${data.total_results.toLocaleString()} photos on Pexels for "${query}". Top ${data.photos.length} results:\n`,
        ];
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

    // ── fetch_url ────────────────────────────────────────────────────────
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
          ? stripped.slice(0, CAP) + `\n\n[… truncated after ${CAP} chars. Full page is ${stripped.length} chars.]`
          : stripped;
        return `Content of ${url}:\n\n${result}`;
      } catch (e) {
        return `Error fetching URL: ${e}`;
      }
    }

    // ── run_command ──────────────────────────────────────────────────────
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
        if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
        if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
        return parts.join('\n');
      } catch (e) {
        return `Error running command: ${e}`;
      }
    }

    default:
      return null;
  }
};
