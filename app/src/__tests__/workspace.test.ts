import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tauriFs from '@tauri-apps/plugin-fs';
import {
  readFile,
  writeFile,
  trackFileOpen,
  trackFileEdit,
  createFile,
  duplicateFile,
  getRecents,
  removeRecent,
  wsRelativePath,
} from '../services/workspace';
import type { Workspace } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    path: '/test/ws',
    name: 'Test',
    config: { name: 'Test' },
    files: [],
    fileTree: [],
    ...overrides,
  } as unknown as Workspace;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ── readFile ──────────────────────────────────────────────────────────────────
describe('readFile', () => {
  it('reads the file at workspace.path + "/" + filename', async () => {
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('hello content');
    const ws = makeWorkspace();
    const text = await readFile(ws, 'notes.md');
    expect(tauriFs.readTextFile).toHaveBeenCalledWith('/test/ws/notes.md');
    expect(text).toBe('hello content');
  });

  it('supports nested paths', async () => {
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('nested');
    await readFile(makeWorkspace(), 'docs/guide.md');
    expect(tauriFs.readTextFile).toHaveBeenCalledWith('/test/ws/docs/guide.md');
  });
});

// ── writeFile ─────────────────────────────────────────────────────────────────
describe('writeFile', () => {
  it('writes content to workspace.path + "/" + filename', async () => {
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
    const ws = makeWorkspace();
    await writeFile(ws, 'output.md', 'some text');
    expect(tauriFs.writeTextFile).toHaveBeenCalledWith('/test/ws/output.md', 'some text');
  });
});

// ── trackFileOpen ─────────────────────────────────────────────────────────────
describe('trackFileOpen', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
  });

  it('prepends the opened file to recentFiles', async () => {
    const ws = makeWorkspace({ config: { name: 'Test', recentFiles: ['old.md'] } } as any);
    const updated = await trackFileOpen(ws, 'new.md');
    expect(updated.config.recentFiles![0]).toBe('new.md');
    expect(updated.config.recentFiles).toContain('old.md');
  });

  it('sets lastOpenedFile', async () => {
    const ws = makeWorkspace();
    const updated = await trackFileOpen(ws, 'readme.md');
    expect(updated.config.lastOpenedFile).toBe('readme.md');
  });

  it('deduplicates — moving an already-open file to the front', async () => {
    const ws = makeWorkspace({ config: { name: 'T', recentFiles: ['a.md', 'b.md', 'c.md'] } } as any);
    const updated = await trackFileOpen(ws, 'b.md');
    expect(updated.config.recentFiles![0]).toBe('b.md');
    const count = updated.config.recentFiles!.filter((f) => f === 'b.md').length;
    expect(count).toBe(1);
  });

  it('caps recentFiles list at 8 entries', async () => {
    const ws = makeWorkspace({
      config: { name: 'T', recentFiles: ['1.md','2.md','3.md','4.md','5.md','6.md','7.md','8.md'] },
    } as any);
    const updated = await trackFileOpen(ws, 'new.md');
    expect(updated.config.recentFiles!.length).toBeLessThanOrEqual(8);
  });

  it('persists the config to disk', async () => {
    const ws = makeWorkspace();
    await trackFileOpen(ws, 'notes.md');
    expect(tauriFs.writeTextFile).toHaveBeenCalledOnce();
  });
});

// ── trackFileEdit ─────────────────────────────────────────────────────────────
describe('trackFileEdit', () => {
  it('sets lastEditedAt to a valid ISO string', async () => {
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
    const ws = makeWorkspace();
    const before = new Date();
    const updated = await trackFileEdit(ws);
    const after = new Date();
    expect(updated.config.lastEditedAt).toBeDefined();
    const ts = new Date(updated.config.lastEditedAt!);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('does not modify any other config field', async () => {
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
    const ws = makeWorkspace({ config: { name: 'My Workspace', lastOpenedFile: 'keep.md' } } as any);
    const updated = await trackFileEdit(ws);
    expect(updated.config.name).toBe('My Workspace');
    expect(updated.config.lastOpenedFile).toBe('keep.md');
  });
});

// ── createFile ────────────────────────────────────────────────────────────────
describe('createFile', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
    vi.mocked(tauriFs.mkdir).mockResolvedValue(undefined);
  });

  it('seeds an .md file with a # heading derived from the filename', async () => {
    const ws = makeWorkspace();
    await createFile(ws, 'ideas.md');
    const [, content] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    expect(content).toMatch(/^# ideas\n/);
  });

  it('seeds an .mdx file with a # heading too', async () => {
    const ws = makeWorkspace();
    await createFile(ws, 'page.mdx');
    const [, content] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    expect(content).toMatch(/^# page\n/);
  });

  it('seeds a non-markdown file with empty content', async () => {
    const ws = makeWorkspace();
    await createFile(ws, 'utils.ts');
    const [, content] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    expect(content).toBe('');
  });

  it('creates parent directories for nested paths', async () => {
    const ws = makeWorkspace();
    await createFile(ws, 'docs/guide.md');
    expect(tauriFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('docs'),
      { recursive: true },
    );
  });

  it('does not overwrite a file that already exists', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    const ws = makeWorkspace();
    await createFile(ws, 'existing.md');
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });
});

// ── duplicateFile ─────────────────────────────────────────────────────────────
describe('duplicateFile', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.copyFile).mockResolvedValue(undefined);
  });

  it('appends " copy" before the extension', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const ws = makeWorkspace();
    const result = await duplicateFile(ws, 'notes.md');
    expect(result).toBe('notes copy.md');
  });

  it('appends " copy" for files without extension', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const ws = makeWorkspace();
    const result = await duplicateFile(ws, 'Makefile');
    expect(result).toBe('Makefile copy');
  });

  it('appends a counter to avoid collisions', async () => {
    // First call: the "copy" path already exists; second call: it does not
    vi.mocked(tauriFs.exists)
      .mockResolvedValueOnce(true)   // "notes copy.md" exists
      .mockResolvedValueOnce(false); // "notes copy 2.md" does not
    const ws = makeWorkspace();
    const result = await duplicateFile(ws, 'notes.md');
    expect(result).toBe('notes copy 2.md');
  });

  it('preserves directory prefix in the duplicate path', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const ws = makeWorkspace();
    const result = await duplicateFile(ws, 'docs/chapter1.md');
    expect(result).toBe('docs/chapter1 copy.md');
  });

  it('copies to the correct absolute path', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const ws = makeWorkspace();
    await duplicateFile(ws, 'script.ts');
    expect(tauriFs.copyFile).toHaveBeenCalledWith(
      '/test/ws/script.ts',
      '/test/ws/script copy.ts',
    );
  });
});

// ── wsRelativePath ────────────────────────────────────────────────────────────
describe('wsRelativePath', () => {
  it('returns a same-directory path as a plain name', () => {
    expect(wsRelativePath('chapter1.md', 'chapter2.md')).toBe('chapter2.md');
  });

  it('returns a sibling-directory path correctly', () => {
    // From docs/intro.md → assets/logo.png should be ../assets/logo.png
    expect(wsRelativePath('docs/intro.md', 'assets/logo.png')).toBe('../assets/logo.png');
  });

  it('computes nested relative paths', () => {
    // From a/b/c.md → a/d/e.md: dir is a/b, common prefix with a/d/e.md is 'a', so 1 up then d/e.md
    expect(wsRelativePath('a/b/c.md', 'a/d/e.md')).toBe('../d/e.md');
  });

  it('handles root-level from-file correctly', () => {
    // From top.md → images/photo.png
    expect(wsRelativePath('top.md', 'images/photo.png')).toBe('images/photo.png');
  });

  it('handles deeply nested common prefix', () => {
    // From a/b/c/d.md → a/b/e/f.md: dir is a/b/c, common prefix with a/b/e/f.md is 'a/b', so 1 up then e/f.md
    expect(wsRelativePath('a/b/c/d.md', 'a/b/e/f.md')).toBe('../e/f.md');
  });
});

// ── getRecents / removeRecent ─────────────────────────────────────────────────
describe('getRecents', () => {
  it('returns an empty array when localStorage has nothing', () => {
    expect(getRecents()).toEqual([]);
  });

  it('returns parsed recents from localStorage', () => {
    const entries = [{ path: '/foo', name: 'Foo', lastOpened: new Date().toISOString() }];
    localStorage.setItem('custom-tool-recent-workspaces', JSON.stringify(entries));
    expect(getRecents()).toHaveLength(1);
    expect(getRecents()[0].name).toBe('Foo');
  });

  it('returns an empty array when the stored value is malformed JSON', () => {
    localStorage.setItem('custom-tool-recent-workspaces', '}{bad json}{');
    expect(getRecents()).toEqual([]);
  });
});

describe('removeRecent', () => {
  it('removes the entry with the matching path', () => {
    const entries = [
      { path: '/a', name: 'A', lastOpened: new Date().toISOString() },
      { path: '/b', name: 'B', lastOpened: new Date().toISOString() },
    ];
    localStorage.setItem('custom-tool-recent-workspaces', JSON.stringify(entries));
    removeRecent('/a');
    const remaining = getRecents();
    expect(remaining.some((r) => r.path === '/a')).toBe(false);
    expect(remaining.some((r) => r.path === '/b')).toBe(true);
  });

  it('is a no-op when the path does not exist in recents', () => {
    const entries = [{ path: '/a', name: 'A', lastOpened: new Date().toISOString() }];
    localStorage.setItem('custom-tool-recent-workspaces', JSON.stringify(entries));
    removeRecent('/nonexistent');
    expect(getRecents()).toHaveLength(1);
  });
});
