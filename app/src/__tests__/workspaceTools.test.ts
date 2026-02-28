/**
 * Tests for buildToolExecutor — the runtime implementation of all workspace tools.
 * The heavy canvas / network tools are lightly tested (no-editor guard, etc.);
 * the file-system tools get thorough coverage via the mocked @tauri-apps/plugin-fs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DirEntry } from '@tauri-apps/plugin-fs';
import * as tauriFs from '@tauri-apps/plugin-fs';
import { buildToolExecutor } from '../utils/workspaceTools';
import type { Editor } from 'tldraw';

const WS_PATH = '/test/workspace';

function makeExecutor(
  editorOverride: Editor | null = null,
  callbacks: {
    onFileWritten?: (p: string) => void;
    onMarkRecorded?: (p: string, c: string) => void;
    onCanvasModified?: (ids: string[]) => void;
  } = {},
) {
  return buildToolExecutor(
    WS_PATH,
    { current: editorOverride },
    callbacks.onFileWritten,
    callbacks.onMarkRecorded,
    callbacks.onCanvasModified,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── list_workspace_files ──────────────────────────────────────────────────────
describe('list_workspace_files', () => {
  it('returns all file paths when the workspace has files', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([
      { name: 'notes.md', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
      { name: 'ideas.md', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]);
    const exec = makeExecutor();
    const result = await exec('list_workspace_files', {});
    expect(result).toContain('notes.md');
    expect(result).toContain('ideas.md');
    expect(result).toMatch(/2 file\(s\)/);
  });

  it('returns an empty-workspace message when the directory is empty', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([]);
    const exec = makeExecutor();
    const result = await exec('list_workspace_files', {});
    expect(result).toBe('The workspace is empty.');
  });

  it('skips ignored directories (node_modules, .git, target, etc.)', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([
      { name: 'node_modules', isDirectory: true, isFile: false, isSymlink: false } as DirEntry,
      { name: 'src', isDirectory: true, isFile: false, isSymlink: false } as DirEntry,
      { name: 'index.ts', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]);
    // readDir is also called recursively for 'src'; make it return empty
    vi.mocked(tauriFs.readDir).mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: true, isFile: false, isSymlink: false } as DirEntry,
      { name: 'src', isDirectory: true, isFile: false, isSymlink: false } as DirEntry,
      { name: 'index.ts', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]).mockResolvedValue([]);
    const exec = makeExecutor();
    const result = await exec('list_workspace_files', {});
    expect(result).not.toContain('node_modules');
  });
});

// ── read_workspace_file ───────────────────────────────────────────────────────
describe('read_workspace_file', () => {
  it('returns file content when the file exists', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('# My Notes\nHello!');
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: 'notes.md' });
    expect(result).toBe('# My Notes\nHello!');
    expect(tauriFs.readTextFile).toHaveBeenCalledWith(`${WS_PATH}/notes.md`);
  });

  it('returns a "file not found" message when it does not exist', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: 'missing.md' });
    expect(result).toContain('not found');
    expect(result).toContain('missing.md');
  });

  it('requires a path argument', async () => {
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', {});
    expect(result).toContain('path is required');
  });

  it('truncates files larger than 40 000 characters at a line boundary', async () => {
    // The CAP is 40 KB — build a file of 41 000 chars (over the limit).
    // Use lines so the truncation message lands on a clean boundary.
    const line = 'x'.repeat(100) + '\n';          // 101 chars per line
    const bigText = line.repeat(410);             // ~41 410 chars total
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(bigText);
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: 'big.md' });
    expect(result.length).toBeLessThanOrEqual(bigText.length);
    expect(result).toContain('truncated');
  });

  it('returns an error string when readTextFile throws', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockRejectedValue(new Error('permission denied'));
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: 'locked.md' });
    expect(result).toContain('Error');
  });
});

// ── write_workspace_file ──────────────────────────────────────────────────────
describe('write_workspace_file', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
  });

  it('writes the file and returns a success message', async () => {
    const exec = makeExecutor();
    const result = await exec('write_workspace_file', {
      path: 'output.md',
      content: '# Draft\n\nSome text.',
    });
    expect(result).toContain('written successfully');
    expect(result).toContain('output.md');
    expect(tauriFs.writeTextFile).toHaveBeenCalledWith(
      `${WS_PATH}/output.md`,
      '# Draft\n\nSome text.',
    );
  });

  it('requires a path argument', async () => {
    const exec = makeExecutor();
    const result = await exec('write_workspace_file', { content: 'text' });
    expect(result).toContain('path is required');
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('rejects empty content', async () => {
    const exec = makeExecutor();
    const result = await exec('write_workspace_file', { path: 'file.md', content: '' });
    expect(result).toContain('content is empty');
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('calls onFileWritten callback after a successful write', async () => {
    const onFileWritten = vi.fn();
    const exec = makeExecutor(null, { onFileWritten });
    await exec('write_workspace_file', { path: 'cb.md', content: 'hello' });
    expect(onFileWritten).toHaveBeenCalledWith('cb.md');
  });

  it('calls onMarkRecorded callback after a successful write', async () => {
    const onMarkRecorded = vi.fn();
    const exec = makeExecutor(null, { onMarkRecorded });
    await exec('write_workspace_file', { path: 'marked.md', content: 'AI text' });
    expect(onMarkRecorded).toHaveBeenCalledWith('marked.md', 'AI text');
  });

  it('creates parent directories when they do not exist', async () => {
    vi.mocked(tauriFs.exists)
      .mockResolvedValueOnce(false) // parent dir does not exist
      .mockResolvedValueOnce(true); // subsequent checks
    vi.mocked(tauriFs.mkdir).mockResolvedValue(undefined);
    const exec = makeExecutor();
    await exec('write_workspace_file', { path: 'deep/nested/file.md', content: 'hi' });
    expect(tauriFs.mkdir).toHaveBeenCalled();
  });
});

// ── search_workspace ──────────────────────────────────────────────────────────
describe('search_workspace', () => {
  it('returns a "no matches" message when nothing is found', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([
      { name: 'notes.md', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('no match here');
    const exec = makeExecutor();
    const result = await exec('search_workspace', { query: 'unicorn' });
    expect(result).toContain('No matches found');
    expect(result).toContain('unicorn');
  });

  it('returns matching lines with file context when a hit is found', async () => {
    vi.mocked(tauriFs.readDir)
      .mockResolvedValueOnce([
        { name: 'readme.md', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
      ])
      .mockResolvedValue([]);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(
      'first line\nThis contains the TARGET keyword\nthird line',
    );
    const exec = makeExecutor();
    const result = await exec('search_workspace', { query: 'TARGET' });
    expect(result).toContain('TARGET');
    expect(result).toContain('readme.md');
    expect(result).toContain('1 match');
  });

  it('requires a non-empty query', async () => {
    const exec = makeExecutor();
    const result = await exec('search_workspace', { query: '' });
    expect(result).toContain('query is required');
  });
});

// ── list_canvas_shapes: no editor guard ──────────────────────────────────────
describe('list_canvas_shapes (no editor)', () => {
  it('returns an informative message when no canvas is open', async () => {
    const exec = makeExecutor(null); // no editor
    const result = await exec('list_canvas_shapes', {});
    expect(result).toContain('No canvas');
  });
});

// ── canvas_op: no editor guard ────────────────────────────────────────────────
describe('canvas_op (no editor)', () => {
  it('returns an informative message when no canvas is open', async () => {
    const exec = makeExecutor(null);
    const result = await exec('canvas_op', { commands: '{"op":"add_note","text":"hi"}' });
    expect(result).toContain('No canvas');
  });
});

// ── canvas_screenshot: no editor guard ───────────────────────────────────────
describe('canvas_screenshot (no editor)', () => {
  it('returns an informative message when no canvas is open', async () => {
    const exec = makeExecutor(null);
    const result = await exec('canvas_screenshot', {});
    expect(result).toContain('No canvas');
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────────
describe('unknown tool', () => {
  it('returns an "Unknown tool" message for unrecognised tool names', async () => {
    const exec = makeExecutor();
    const result = await exec('totally_fake_tool', {});
    expect(result).toContain('Unknown tool');
    expect(result).toContain('totally_fake_tool');
  });
});

// ── read_workspace_file: path traversal ──────────────────────────────────────
describe('read_workspace_file — path traversal', () => {
  it('rejects paths that escape the workspace via ../', async () => {
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: '../../etc/passwd' });
    expect(result).toContain('Path traversal detected');
    expect(tauriFs.readTextFile).not.toHaveBeenCalled();
  });

  it('rejects multi-hop traversal that resolves outside the workspace', async () => {
    const exec = makeExecutor();
    const result = await exec('read_workspace_file', { path: 'sub/../../../secret' });
    expect(result).toContain('Path traversal detected');
    expect(tauriFs.readTextFile).not.toHaveBeenCalled();
  });
});

// ── write_workspace_file: canvas file rejection ───────────────────────────────
describe('write_workspace_file — canvas file rejection', () => {
  it('refuses to write content to a .tldr.json canvas file', async () => {
    const exec = makeExecutor();
    const result = await exec('write_workspace_file', {
      path: 'board.tldr.json',
      content: '{"shapes":[]}',
    });
    expect(result).toContain('canvas files (.tldr.json) cannot be written');
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('blocks top-level and subdirectory canvas files alike', async () => {
    const exec = makeExecutor();
    const result = await exec('write_workspace_file', {
      path: 'slides/deck.tldr.json',
      content: '{}',
    });
    expect(result).toContain('canvas files (.tldr.json) cannot be written');
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });
});

// ── search_workspace: canvas file exclusion ───────────────────────────────────
describe('search_workspace — canvas file exclusion', () => {
  it('does not read .tldr.json files when searching', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([
      { name: 'notes.md', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
      { name: 'board.tldr.json', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('TARGET keyword here');
    const exec = makeExecutor();
    await exec('search_workspace', { query: 'TARGET' });

    // Only notes.md should have been read — not the canvas file
    expect(tauriFs.readTextFile).toHaveBeenCalledOnce();
    expect(tauriFs.readTextFile).toHaveBeenCalledWith(`${WS_PATH}/notes.md`);
  });

  it('reports zero text files when only canvas files exist', async () => {
    vi.mocked(tauriFs.readDir).mockResolvedValue([
      { name: 'board.tldr.json', isDirectory: false, isFile: true, isSymlink: false } as DirEntry,
    ]);
    const exec = makeExecutor();
    const result = await exec('search_workspace', { query: 'anything' });
    expect(result).toContain('No matches found');
    expect(tauriFs.readTextFile).not.toHaveBeenCalled();
  });
});
