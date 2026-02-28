import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tauriFs from '@tauri-apps/plugin-fs';
import { loadMarks, saveMarks, addMark, addMarksBulk, markReviewed } from '../services/aiMarks';
import type { Workspace, AIEditMark } from '../types';

const mockWorkspace: Workspace = {
  name: 'Test Workspace',
  path: '/test/workspace',
} as Workspace;

const sampleMark: AIEditMark = {
  id: 'mark-1',
  fileRelPath: 'docs/notes.md',
  text: 'This was AI-generated.',
  model: 'gpt-4o',
  insertedAt: '2026-01-01T00:00:00.000Z',
  reviewed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── loadMarks ─────────────────────────────────────────────────────────────────
describe('loadMarks', () => {
  it('returns an empty array when the marks file does not exist', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    const marks = await loadMarks(mockWorkspace);
    expect(marks).toEqual([]);
  });

  it('parses and returns marks from the JSON file', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    const marks = await loadMarks(mockWorkspace);
    expect(marks).toHaveLength(1);
    expect(marks[0].id).toBe('mark-1');
    expect(marks[0].reviewed).toBe(false);
  });

  it('returns an empty array when the JSON is invalid', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('not valid json{{{');
    const marks = await loadMarks(mockWorkspace);
    expect(marks).toEqual([]);
  });

  it('returns an empty array when readTextFile throws', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockRejectedValue(new Error('disk error'));
    const marks = await loadMarks(mockWorkspace);
    expect(marks).toEqual([]);
  });

  it('reads from the correct path', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('[]');
    await loadMarks(mockWorkspace);
    expect(tauriFs.readTextFile).toHaveBeenCalledWith(
      '/test/workspace/cafezin/ai-marks.json',
    );
  });
});

// ── saveMarks ─────────────────────────────────────────────────────────────────
describe('saveMarks', () => {
  it('creates directory if it does not exist, then writes the file', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    vi.mocked(tauriFs.mkdir).mockResolvedValue(undefined);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await saveMarks(mockWorkspace, [sampleMark]);

    expect(tauriFs.mkdir).toHaveBeenCalledWith(
      '/test/workspace/cafezin',
      { recursive: true },
    );
    expect(tauriFs.writeTextFile).toHaveBeenCalledWith(
      '/test/workspace/cafezin/ai-marks.json',
      expect.any(String),
    );
  });

  it('skips mkdir when directory already exists', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await saveMarks(mockWorkspace, []);

    expect(tauriFs.mkdir).not.toHaveBeenCalled();
  });

  it('serialises marks as pretty-printed JSON', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await saveMarks(mockWorkspace, [sampleMark]);

    const [, written] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    const parsed = JSON.parse(written as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('mark-1');
  });
});

// ── addMark ───────────────────────────────────────────────────────────────────
describe('addMark', () => {
  it('appends a new mark to the existing list', async () => {
    const existingMark: AIEditMark = {
      id: 'mark-0',
      fileRelPath: 'old.md',
      text: 'existing',
      model: 'gpt-4o',
      insertedAt: '2025-01-01T00:00:00.000Z',
      reviewed: false,
    };

    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([existingMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const updated = await addMark(mockWorkspace, sampleMark);
    expect(updated).toHaveLength(2);
    expect(updated[1].id).toBe('mark-1');
  });

  it('returns just the new mark when no prior marks exist', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false);
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);
    // mkdir may be called since the dir doesn't exist
    vi.mocked(tauriFs.mkdir).mockResolvedValue(undefined);

    const updated = await addMark(mockWorkspace, sampleMark);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual(sampleMark);
  });
});

// ── markReviewed ──────────────────────────────────────────────────────────────
describe('markReviewed', () => {
  it('sets reviewed=true and stamps reviewedAt on the matching mark', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const updated = await markReviewed(mockWorkspace, 'mark-1');
    const m = updated.find((x) => x.id === 'mark-1');
    expect(m?.reviewed).toBe(true);
    expect(m?.reviewedAt).toBeDefined();
    expect(typeof m?.reviewedAt).toBe('string');
  });

  it('leaves other marks unchanged', async () => {
    const anotherMark: AIEditMark = {
      id: 'mark-2',
      fileRelPath: 'other.md',
      text: 'another',
      model: 'gpt-4o',
      insertedAt: '2026-01-02T00:00:00.000Z',
      reviewed: false,
    };
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(
      JSON.stringify([sampleMark, anotherMark]),
    );
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const updated = await markReviewed(mockWorkspace, 'mark-1');
    const other = updated.find((x) => x.id === 'mark-2');
    expect(other?.reviewed).toBe(false);
    expect(other?.reviewedAt).toBeUndefined();
  });

  it('is a no-op (does not throw) when the id does not match any mark', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const updated = await markReviewed(mockWorkspace, 'nonexistent');
    // Mark is unchanged
    expect(updated[0].reviewed).toBe(false);
  });

  it('persists the reviewed state to disk', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await markReviewed(mockWorkspace, 'mark-1');
    expect(tauriFs.writeTextFile).toHaveBeenCalledOnce();
    const [, written] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    const parsed: AIEditMark[] = JSON.parse(written as string);
    expect(parsed[0].reviewed).toBe(true);
  });
});

// ── addMarksBulk ──────────────────────────────────────────────────────────────────
describe('addMarksBulk', () => {
  it('appends multiple marks in a single read-modify-write cycle', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const newMarks: AIEditMark[] = [
      { ...sampleMark, id: 'bulk-1' },
      { ...sampleMark, id: 'bulk-2' },
    ];
    const result = await addMarksBulk(mockWorkspace, newMarks);

    expect(result).toHaveLength(3); // 1 existing + 2 new
    expect(result.map((m) => m.id)).toContain('bulk-1');
    expect(result.map((m) => m.id)).toContain('bulk-2');
  });

  it('writes to disk exactly once for multiple marks', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('[]');
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await addMarksBulk(mockWorkspace, [
      { ...sampleMark, id: 'bulk-a' },
      { ...sampleMark, id: 'bulk-b' },
    ]);

    expect(tauriFs.writeTextFile).toHaveBeenCalledOnce();
  });

  it('skips writing and returns existing marks when newMarks is empty', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue(JSON.stringify([sampleMark]));
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    const result = await addMarksBulk(mockWorkspace, []);

    expect(result).toHaveLength(1);
    expect(tauriFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('all new marks are present in the persisted JSON', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true);
    vi.mocked(tauriFs.readTextFile).mockResolvedValue('[]');
    vi.mocked(tauriFs.writeTextFile).mockResolvedValue(undefined);

    await addMarksBulk(mockWorkspace, [{ ...sampleMark, id: 'persist-1' }]);

    const [, written] = vi.mocked(tauriFs.writeTextFile).mock.calls[0];
    const parsed: AIEditMark[] = JSON.parse(written as string);
    expect(parsed[0].id).toBe('persist-1');
  });
});
