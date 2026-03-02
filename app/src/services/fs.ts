/**
 * Platform-aware FS wrapper for Tauri.
 *
 * On iOS/Android, ALL paths inside the Documents directory are automatically
 * passed with `baseDir: BaseDirectory.Document` (and the Documents prefix is
 * stripped to make them relative). This avoids the iOS sandbox path
 * canonicalization bug in tauri-plugin-fs where absolute `/var/mobile/...`
 * paths are canonicalized to `/private/var/...`, breaking scope checks.
 *
 * On desktop, paths outside Documents are passed unchanged (no baseDir),
 * preserving existing behaviour.
 *
 * Usage: import from this module instead of '@tauri-apps/plugin-fs'
 * anywhere that operates on workspace files.
 */
import {
  BaseDirectory,
  readTextFile as _readTextFile,
  writeTextFile as _writeTextFile,
  readFile as _readFile,
  writeFile as _writeFile,
  readDir as _readDir,
  mkdir as _mkdir,
  exists as _exists,
  remove as _remove,
  copyFile as _copyFile,
  rename as _rename,
  stat as _stat,
} from '@tauri-apps/plugin-fs';
import type { DirEntry, MkdirOptions, RemoveOptions, WriteFileOptions, FileInfo } from '@tauri-apps/plugin-fs';
import { documentDir } from '@tauri-apps/api/path';

// ── Internal helpers ────────────────────────────────────────────────────────

let _cachedDocDir: string | null = null;

async function getDocDir(): Promise<string | null> {
  if (_cachedDocDir !== null) return _cachedDocDir;
  try {
    _cachedDocDir = (await documentDir()).replace(/\/+$/, '');
    return _cachedDocDir;
  } catch {
    return null;
  }
}

/**
 * Remap an absolute iOS app-container path to the CURRENT container.
 *
 * The app container UUID changes with every TestFlight build update/reinstall.
 * A path like:
 *   /var/mobile/Containers/Data/Application/<OLD_UUID>/Documents/book
 * becomes:
 *   /var/mobile/Containers/Data/Application/<NEW_UUID>/Documents/book
 *
 * We extract the relative portion after "Documents" and prepend the current
 * documentDir().  Non-iOS paths (desktop) are returned unchanged.
 */
export async function remapToCurrentDocDir(absPath: string): Promise<string> {
  const doc = await getDocDir();
  if (!doc) return absPath;
  // Match any iOS sandbox Documents path (handles /private prefix too)
  const m = absPath.match(
    /^(?:\/private)?\/var\/mobile\/Containers\/Data\/Application\/[^/]+\/Documents(\/.*)?$/
  );
  if (m) {
    const rel = m[1] ?? ''; // e.g. "/book"
    return doc + rel;
  }
  return absPath;
}

interface FsPath {
  path: string;
  baseDir?: BaseDirectory;
}

/**
 * Convert an absolute path to a tauri-fs–compatible { path, baseDir } pair.
 *
 * - If the path lives inside the Documents directory → strip the prefix and
 *   return `{ path: relPath, baseDir: BaseDirectory.Document }`.
 * - Otherwise (desktop paths, app bundle, etc.) → return unchanged.
 *
 * iOS quirk: `documentDir()` returns `/var/mobile/...` but paths stored in
 * localStorage from older builds (that called Rust `canonicalize_path`) may
 * have the `/private/var/...` symlink-resolved form.  We normalise both sides
 * by stripping a leading `/private` before comparing so both forms match.
 */
async function toFsPath(absPath: string): Promise<FsPath> {
  const doc = await getDocDir();
  if (doc) {
    // Strip leading /private so /private/var/... and /var/... compare equal.
    const norm = (p: string) => p.startsWith('/private/') ? p.slice('/private'.length) : p;
    const normPath = norm(absPath);
    const normDoc  = norm(doc);
    if (normPath === normDoc) return { path: '.', baseDir: BaseDirectory.Document };
    if (normPath.startsWith(normDoc + '/')) {
      return { path: normPath.slice(normDoc.length + 1), baseDir: BaseDirectory.Document };
    }
  }
  return { path: absPath };
}

// ── Public API (mirrors @tauri-apps/plugin-fs) ──────────────────────────────

export async function readTextFile(path: string): Promise<string> {
  const { path: p, baseDir } = await toFsPath(path);
  return _readTextFile(p, baseDir ? { baseDir } : undefined);
}

export async function writeTextFile(
  path: string,
  data: string,
  options?: Omit<WriteFileOptions, 'baseDir'>,
): Promise<void> {
  const { path: p, baseDir } = await toFsPath(path);
  return _writeTextFile(p, data, { ...options, ...(baseDir ? { baseDir } : {}) });
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const { path: p, baseDir } = await toFsPath(path);
  return _readDir(p, baseDir ? { baseDir } : undefined);
}

export async function mkdir(path: string, options?: Omit<MkdirOptions, 'baseDir'>): Promise<void> {
  const { path: p, baseDir } = await toFsPath(path);
  return _mkdir(p, { ...options, ...(baseDir ? { baseDir } : {}) });
}

export async function exists(path: string): Promise<boolean> {
  const { path: p, baseDir } = await toFsPath(path);
  try {
    return await _exists(p, baseDir ? { baseDir } : undefined);
  } catch {
    // tauri-plugin-fs throws for non-existent paths on some platforms
    return false;
  }
}

export async function remove(path: string, options?: Omit<RemoveOptions, 'baseDir'>): Promise<void> {
  const { path: p, baseDir } = await toFsPath(path);
  return _remove(p, { ...options, ...(baseDir ? { baseDir } : {}) });
}

export async function copyFile(src: string, dest: string): Promise<void> {
  const { path: srcPath, baseDir: srcBase } = await toFsPath(src);
  const { path: destPath, baseDir: destBase } = await toFsPath(dest);
  return _copyFile(srcPath, destPath, {
    ...(srcBase ? { fromPathBaseDir: srcBase } : {}),
    ...(destBase ? { toPathBaseDir: destBase } : {}),
  });
}

export async function rename(src: string, dest: string): Promise<void> {
  const { path: srcPath, baseDir: srcBase } = await toFsPath(src);
  const { path: destPath, baseDir: destBase } = await toFsPath(dest);
  return _rename(srcPath, destPath, {
    ...(srcBase ? { oldPathBaseDir: srcBase } : {}),
    ...(destBase ? { newPathBaseDir: destBase } : {}),
  });
}

export async function readFile(path: string): Promise<Uint8Array> {
  const { path: p, baseDir } = await toFsPath(path);
  return _readFile(p, baseDir ? { baseDir } : undefined);
}

export async function writeFile(
  path: string,
  data: Uint8Array,
  options?: Omit<WriteFileOptions, 'baseDir'>,
): Promise<void> {
  const { path: p, baseDir } = await toFsPath(path);
  return _writeFile(p, data, { ...options, ...(baseDir ? { baseDir } : {}) });
}

export async function stat(path: string): Promise<FileInfo> {
  const { path: p, baseDir } = await toFsPath(path);
  return _stat(p, baseDir ? { baseDir } : undefined);
}

// Re-export types that callers might need
export type { DirEntry, FileInfo };
