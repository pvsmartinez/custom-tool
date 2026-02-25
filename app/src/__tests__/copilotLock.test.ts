/**
 * Tests for the file-lock pub/sub system (copilotLock.ts).
 * This module is pure in-memory — no Tauri or network calls needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lockFile,
  unlockFile,
  unlockAll,
  getLockedFiles,
  onLockedFilesChange,
} from '../services/copilotLock';

// Reset module state before every test
beforeEach(() => {
  unlockAll();
});

// ── getLockedFiles ────────────────────────────────────────────────────────────
describe('getLockedFiles', () => {
  it('returns an empty set when nothing is locked', () => {
    expect(getLockedFiles().size).toBe(0);
  });

  it('returns a snapshot, not the live internal set', () => {
    lockFile('a.md');
    const snap = getLockedFiles();
    lockFile('b.md');
    // Adding b after the snapshot should not affect the snapshot
    expect(snap.has('b.md')).toBe(false);
    expect(snap.size).toBe(1);
  });
});

// ── lockFile ──────────────────────────────────────────────────────────────────
describe('lockFile', () => {
  it('adds a file to the locked set', () => {
    lockFile('notes.md');
    expect(getLockedFiles().has('notes.md')).toBe(true);
  });

  it('is idempotent — locking twice does not duplicate the entry', () => {
    lockFile('docs/readme.md');
    lockFile('docs/readme.md');
    expect(getLockedFiles().size).toBe(1);
  });

  it('can lock multiple files simultaneously', () => {
    lockFile('a.md');
    lockFile('b.ts');
    lockFile('c.json');
    expect(getLockedFiles().size).toBe(3);
  });

  it('fires subscribed listeners when a file is locked', () => {
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    lockFile('report.md');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toBeInstanceOf(Set);
    expect(listener.mock.calls[0][0].has('report.md')).toBe(true);
    unsub();
  });
});

// ── unlockFile ────────────────────────────────────────────────────────────────
describe('unlockFile', () => {
  it('removes a file from the locked set', () => {
    lockFile('notes.md');
    unlockFile('notes.md');
    expect(getLockedFiles().has('notes.md')).toBe(false);
  });

  it('does not throw when unlocking a file that was never locked', () => {
    expect(() => unlockFile('never-locked.md')).not.toThrow();
  });

  it('only removes the targeted file, leaving others locked', () => {
    lockFile('a.md');
    lockFile('b.md');
    unlockFile('a.md');
    const locked = getLockedFiles();
    expect(locked.has('a.md')).toBe(false);
    expect(locked.has('b.md')).toBe(true);
  });

  it('fires subscribed listeners when a file is unlocked', () => {
    lockFile('file.ts');
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    unlockFile('file.ts');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].has('file.ts')).toBe(false);
    unsub();
  });
});

// ── unlockAll ─────────────────────────────────────────────────────────────────
describe('unlockAll', () => {
  it('clears all locked files at once', () => {
    lockFile('a.md');
    lockFile('b.md');
    lockFile('c.md');
    unlockAll();
    expect(getLockedFiles().size).toBe(0);
  });

  it('does not fire listeners when nothing is locked (no-op)', () => {
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    unlockAll(); // already empty from beforeEach
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('fires listeners when it clears a non-empty set', () => {
    lockFile('x.ts');
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    unlockAll();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].size).toBe(0);
    unsub();
  });
});

// ── onLockedFilesChange ───────────────────────────────────────────────────────
describe('onLockedFilesChange', () => {
  it('calls the listener immediately on state changes', () => {
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    lockFile('a.md');
    unlockFile('a.md');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('does not call the listener after unsubscribing', () => {
    const listener = vi.fn();
    const unsub = onLockedFilesChange(listener);
    lockFile('a.md');
    unsub();
    lockFile('b.md'); // should not trigger listener
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports multiple independent listeners', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const u1 = onLockedFilesChange(l1);
    const u2 = onLockedFilesChange(l2);
    lockFile('shared.md');
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
    u1();
    u2();
  });

  it('passes a Set snapshot — mutations to it do not affect internal state', () => {
    let captured: Set<string> | null = null;
    const unsub = onLockedFilesChange((set) => { captured = set; });
    lockFile('snap.md');
    // Mutate the captured snapshot
    captured!.add('sneaky.md');
    // Internal state should be unaffected
    expect(getLockedFiles().has('sneaky.md')).toBe(false);
    unsub();
  });
});
