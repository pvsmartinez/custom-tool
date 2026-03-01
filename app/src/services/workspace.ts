import { open } from '@tauri-apps/plugin-dialog';
import {
  readTextFile,
  writeTextFile,
  readDir,
  mkdir,
  exists,
  remove,
  copyFile,
  rename,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, WorkspaceConfig, RecentWorkspace, FileTreeNode } from '../types';
import { CONFIG_DIR, WORKSPACE_SKIP } from './config';

const RECENTS_KEY = 'cafezin-recent-workspaces';
const CONFIG_FILE = 'config.json';
const AGENT_FILE = 'AGENT.md';

/**
 * Recursively build a file tree starting at `dirAbsPath`.
 * `relBase` is the prefix to prepend to child paths (relative to workspace root).
 */
async function buildFileTree(
  dirAbsPath: string,
  relBase: string = '',
  depth = 0,
): Promise<FileTreeNode[]> {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readDir(dirAbsPath);
  } catch {
    return [];
  }

  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    if (WORKSPACE_SKIP.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const children = await buildFileTree(`${dirAbsPath}/${entry.name}`, relPath, depth + 1);
      nodes.push({ name: entry.name, path: relPath, isDirectory: true, children });
    } else {
      nodes.push({ name: entry.name, path: relPath, isDirectory: false });
    }
  }

  return nodes.sort((a, b) => {
    // Directories first, then alphabetical
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Recursively walk a directory and return a flat, sorted list of relative file
 * paths, applying the standard workspace skip rules (WORKSPACE_SKIP, hidden
 * entries starting with `.`).
 *
 * @param dir     Absolute path of the directory to walk.
 * @param rel     Prefix to prepend to each relative path (used internally for recursion).
 * @param filter  Optional predicate `(relPath, ext) => boolean`.
 *                When provided, only files for which the predicate returns `true`
 *                are included.  Directories are always traversed regardless.
 */
export async function walkFilesFlat(
  dir: string,
  rel = '',
  filter?: (relPath: string, ext: string) => boolean,
): Promise<string[]> {
  let entries;
  try { entries = await readDir(dir); } catch { return []; }
  const paths: string[] = [];
  for (const e of entries) {
    if (!e.name || WORKSPACE_SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) {
      paths.push(...await walkFilesFlat(`${dir}/${e.name}`, relPath, filter));
    } else {
      const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
      if (!filter || filter(relPath, ext)) paths.push(relPath);
    }
  }
  return paths.sort();
}

/** Open a native folder-picker dialog and return the selected path. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: 'Open Workspace Folder' });
  return typeof selected === 'string' ? selected : null;
}

/** Load (or create) workspace config + agent context + file list. */
export async function loadWorkspace(folderPath: string): Promise<Workspace> {
  // 1. Ensure cafezin/ dir exists.
  // Uses a direct Rust std::fs command to bypass tauri-plugin-fs scope checks,
  // which fail for non-existent paths on iOS: the scope uses the canonical
  // /private/var/... form but non-existent paths can't be canonicalized for
  // comparison. We use the RAW path here (no canonicalize) — iOS sandbox
  // allows writes via /var/mobile/... but rejects /private/var/... directly.
  await invoke('ensure_config_dir', { workspacePath: folderPath });
  const configDir = `${folderPath}/${CONFIG_DIR}`;
  const configPath = `${configDir}/${CONFIG_FILE}`;

  // 2. Read or create config
  let config: WorkspaceConfig;
  if (await exists(configPath)) {
    try {
      config = JSON.parse(await readTextFile(configPath));
    } catch {
      config = { name: folderName(folderPath) };
    }
  } else {
    config = { name: folderName(folderPath) };
    await writeTextFile(configPath, JSON.stringify(config, null, 2));
  }

  // 3. Read AGENT.md if present (this workspace or .vscode agent/copilot instructions)
  let agentContext: string | undefined;
  const agentPaths = [
    `${folderPath}/${AGENT_FILE}`,
    `${folderPath}/.github/copilot-instructions.md`,
    `${folderPath}/.vscode/copilot-instructions.md`,
  ];
  for (const ap of agentPaths) {
    try {
      if (await exists(ap)) {
        agentContext = await readTextFile(ap);
        break;
      }
    } catch { /* hidden path or permission denied — skip */ }
  }

  // 4. Auto-init git if needed; then detect if a remote is configured
  try {
    await invoke('git_init', { path: folderPath });
  } catch { /* not fatal */ }

  let hasGit = false;
  let gitRemote: string | undefined;
  try {
    const remote = await invoke<string>('git_get_remote', { path: folderPath });
    gitRemote = remote?.trim() || undefined;
    hasGit = !!gitRemote;
  } catch { /* no remote = local only */ }

  // 5. Build full recursive file tree (and derive .md file list from it)
  const fileTree = await buildFileTree(folderPath);
  const files = flatMdFiles(fileTree);

  const workspace: Workspace = {
    path: folderPath,
    name: config.name,
    config,
    agentContext,
    files,
    fileTree,
    hasGit,
  };

  // 6. Persist to recents (include hasGit + gitRemote so picker can match against cloud workspaces)
  saveRecent({ path: folderPath, name: config.name, lastOpened: new Date().toISOString(), lastEditedAt: config.lastEditedAt, hasGit, gitRemote });

  return workspace;
}

export async function saveWorkspaceConfig(workspace: Workspace): Promise<void> {
  const configPath = `${workspace.path}/${CONFIG_DIR}/${CONFIG_FILE}`;
  await writeTextFile(configPath, JSON.stringify(workspace.config, null, 2));
}

export async function readFile(workspace: Workspace, filename: string): Promise<string> {
  return readTextFile(`${workspace.path}/${filename}`);
}

export async function writeFile(workspace: Workspace, filename: string, content: string): Promise<void> {
  await writeTextFile(`${workspace.path}/${filename}`, content);
}

/** Record that a file was opened — updates lastOpenedFile and recentFiles in config. */
export async function trackFileOpen(workspace: Workspace, filename: string): Promise<Workspace> {
  const prev = workspace.config.recentFiles ?? [];
  const recentFiles = [filename, ...prev.filter((f) => f !== filename)].slice(0, 8);
  const updated: Workspace = {
    ...workspace,
    config: { ...workspace.config, lastOpenedFile: filename, recentFiles },
  };
  await saveWorkspaceConfig(updated);
  return updated;
}

/** Record that a file was edited — updates lastEditedAt in config. */
export async function trackFileEdit(workspace: Workspace): Promise<Workspace> {
  const updated: Workspace = {
    ...workspace,
    config: { ...workspace.config, lastEditedAt: new Date().toISOString() },
  };
  await saveWorkspaceConfig(updated);
  return updated;
}

export async function createFile(workspace: Workspace, filename: string): Promise<void> {
  const absPath = `${workspace.path}/${filename}`;
  // Ensure parent directory exists for nested paths
  const parentDir = absPath.substring(0, absPath.lastIndexOf('/'));
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  if (!(await exists(absPath))) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    let content = '';
    if (ext === 'md' || ext === 'mdx') {
      const baseName = filename.split('/').pop()?.replace(/\.mdx?$/, '') ?? 'Untitled';
      content = `# ${baseName}\n\n`;
    }
    await writeTextFile(absPath, content);
  }
}

/** Create an empty tldraw canvas file (.tldr.json). */
export async function createCanvasFile(workspace: Workspace, filename: string): Promise<void> {
  const name = filename.endsWith('.tldr.json') ? filename : `${filename}.tldr.json`;
  const absPath = `${workspace.path}/${name}`;
  const parentDir = absPath.substring(0, absPath.lastIndexOf('/'));
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  if (!(await exists(absPath))) {
    // An empty string tells CanvasEditor to start with a blank canvas
    await writeTextFile(absPath, '');
  }
}

/** Delete a file or directory from the workspace. */
export async function deleteFile(workspace: Workspace, relPath: string, isDir = false): Promise<void> {
  await remove(`${workspace.path}/${relPath}`, isDir ? { recursive: true } : undefined);
}

/** Duplicate a file. Returns the relative path of the new copy. */
export async function duplicateFile(workspace: Workspace, relPath: string): Promise<string> {
  const src = `${workspace.path}/${relPath}`;
  const slashIdx = relPath.lastIndexOf('/');
  const dotIdx = relPath.lastIndexOf('.');
  // Derive base + ext, keeping the directory prefix
  let dupRelPath: string;
  if (dotIdx > slashIdx) {
    const base = relPath.slice(0, dotIdx);
    const ext = relPath.slice(dotIdx);
    dupRelPath = `${base} copy${ext}`;
  } else {
    dupRelPath = `${relPath} copy`;
  }
  // Avoid collisions by appending a counter
  let candidate = dupRelPath;
  let n = 2;
  while (await exists(`${workspace.path}/${candidate}`)) {
    if (dotIdx > slashIdx) {
      const base = relPath.slice(0, dotIdx);
      const ext = relPath.slice(dotIdx);
      candidate = `${base} copy ${n}${ext}`;
    } else {
      candidate = `${dupRelPath} ${n}`;
    }
    n++;
  }
  await copyFile(src, `${workspace.path}/${candidate}`);
  return candidate;
}

/** Rename (or move) a file to a new relative path within the workspace. */
export async function renameFile(workspace: Workspace, oldRel: string, newRel: string): Promise<void> {
  const src = `${workspace.path}/${oldRel}`;
  const dest = `${workspace.path}/${newRel}`;
  const parentDir = dest.substring(0, dest.lastIndexOf('/'));
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  // rename works atomically on both files and directories
  await rename(src, dest);
}

// ── Reference update ──────────────────────────────────────────────────────────

const BINARY_EXTS_REF = new Set([
  'png','jpg','jpeg','gif','webp','avif','bmp','ico','tiff','tif','svg',
  'pdf','mp4','webm','mov','mkv','avi','m4v','ogv','mp3','wav','aac','ogg','flac','m4a',
  'zip','tar','gz','wasm','exe','dmg','pkg',
]);

function collectAllTextPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  function walk(n: FileTreeNode) {
    if (n.isDirectory) { n.children?.forEach(walk); return; }
    if (n.name.endsWith('.tldr.json')) { paths.push(n.path); return; }
    const ext = n.name.split('.').pop()?.toLowerCase() ?? '';
    if (!BINARY_EXTS_REF.has(ext)) paths.push(n.path);
  }
  nodes.forEach(walk);
  return paths;
}

/** Compute the relative path from one workspace file to another workspace file. */
export function wsRelativePath(fromFileRel: string, toFileRel: string): string {
  const fromDir = fromFileRel.includes('/')
    ? fromFileRel.substring(0, fromFileRel.lastIndexOf('/'))
    : '';
  const fromParts = fromDir ? fromDir.split('/') : [];
  const toParts = toFileRel.split('/');
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) { common++; }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  if (ups === 0) return downs.join('/');
  return [...Array(ups).fill('..'), ...downs].join('/');
}

/**
 * After renaming/moving a file or folder (oldRel → newRel), scan every text
 * file in the workspace and patch stale references.
 *
 * - Canvas (.tldr.json): asset src URLs contain the absolute path; we replace
 *   the embedded absolute segment.
 * - Text/markdown: relative path references (markdown links, src="", href="")
 *   are recomputed per-file so the relative offsets remain correct.
 *
 * Pass `isDir = true` when a directory was renamed/moved so that child-path
 * prefixes are also updated.
 */
export async function updateFileReferences(
  workspace: Workspace,
  fileTree: FileTreeNode[],
  oldRel: string,
  newRel: string,
  isDir = false,
): Promise<void> {
  if (oldRel === newRel) return;
  const wsPath = workspace.path;
  const textPaths = collectAllTextPaths(fileTree);

  for (const filePath of textPaths) {
    // Skip the file that was just moved (its own content references are internal)
    if (filePath === oldRel || filePath === newRel) continue;
    if (filePath.startsWith(oldRel + '/') || filePath.startsWith(newRel + '/')) continue;

    const absPath = `${wsPath}/${filePath}`;
    let text: string;
    try { text = await readTextFile(absPath); } catch { continue; }
    let updated = text;

    // ── 1. Canvas files: patch absolute asset:// src values ──────────────────
    if (filePath.endsWith('.tldr.json')) {
      // asset://localhost/abs/path  or  asset://localhost/url%20encoded/path
      const patchAbs = (src: string, dst: string) => {
        if (updated.includes(src)) updated = updated.split(src).join(dst);
        const srcEnc = encodeURIComponent(src).replace(/%2F/gi, '/');
        const dstEnc = encodeURIComponent(dst).replace(/%2F/gi, '/');
        if (srcEnc !== src && updated.includes(srcEnc)) {
          updated = updated.split(srcEnc).join(dstEnc);
        }
      };

      if (isDir) {
        // patch all children: oldRel/foo → newRel/foo
        patchAbs(`${wsPath}/${oldRel}/`, `${wsPath}/${newRel}/`);
      } else {
        patchAbs(`${wsPath}/${oldRel}`, `${wsPath}/${newRel}`);
      }
    } else {
      // ── 2. Text/markdown: patch relative path references ──────────────────
      // We build the relative path from this file to old and new targets,
      // then replace each pattern we might find in markdown / HTML / JSON.

      const patchRelPattern = (oldTarget: string, newTarget: string) => {
        if (!oldTarget) return;
        // Patterns that typically surround a path: (), "", '', bare in JSON
        const fenced = [
          [`(${oldTarget})`,       `(${newTarget})`],
          [`"${oldTarget}"`,       `"${newTarget}"`],
          [`'${oldTarget}'`,       `'${newTarget}'`],
          // with ./ prefix variant
          [`(./${oldTarget})`,     `(./${newTarget})`],
          [`"./${oldTarget}"`,     `"./${newTarget}"`],
          [`'./${oldTarget}'`,     `'./${newTarget}'`],
        ];
        for (const [from, to] of fenced) {
          if (updated.includes(from)) updated = updated.split(from).join(to);
        }
      };

      if (isDir) {
        // patch references to any file under the folder (prefix match)
        const oldPrefix = wsRelativePath(filePath, oldRel);
        const newPrefix = wsRelativePath(filePath, newRel);
        patchRelPattern(oldPrefix + '/', newPrefix + '/');
      } else {
        const oldRelRef = wsRelativePath(filePath, oldRel);
        const newRelRef = wsRelativePath(filePath, newRel);
        patchRelPattern(oldRelRef, newRelRef);
      }
    }

    if (updated !== text) {
      try { await writeTextFile(absPath, updated); } catch { /* skip */ }
    }
  }
}

/** Move a file or folder into a destination directory. Returns the new relative path. */
export async function moveFile(workspace: Workspace, srcRel: string, destDirRel: string): Promise<string> {
  const name = srcRel.split('/').pop()!;
  const newRel = destDirRel ? `${destDirRel}/${name}` : name;
  if (newRel === srcRel) return srcRel; // same location — no-op
  const src = `${workspace.path}/${srcRel}`;
  const dest = `${workspace.path}/${newRel}`;
  const destDir = `${workspace.path}/${destDirRel}`;
  if (destDirRel && !(await exists(destDir))) {
    await mkdir(destDir, { recursive: true });
  }
  await rename(src, dest);
  return newRel;
}

/** Duplicate a folder recursively. Returns the new relative path. */
export async function duplicateFolder(workspace: Workspace, relPath: string): Promise<string> {
  const dupBase = `${relPath} copy`;
  let candidate = dupBase;
  let n = 2;
  while (await exists(`${workspace.path}/${candidate}`)) {
    candidate = `${dupBase} ${n}`;
    n++;
  }
  await copyDirRecursive(`${workspace.path}/${relPath}`, `${workspace.path}/${candidate}`);
  return candidate;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readDir(src);
  for (const entry of entries) {
    if (!entry.name) continue;
    if (entry.isDirectory) {
      await copyDirRecursive(`${src}/${entry.name}`, `${dest}/${entry.name}`);
    } else {
      await copyFile(`${src}/${entry.name}`, `${dest}/${entry.name}`);
    }
  }
}

/** Create a new directory (and any missing parents). */
export async function createFolder(workspace: Workspace, relPath: string): Promise<void> {
  const absPath = `${workspace.path}/${relPath}`;
  if (!(await exists(absPath))) {
    await mkdir(absPath, { recursive: true });
  }
}

/** Derive the flat list of markdown file paths from an already-built file tree.
 * Avoids a second readDir pass — use this instead of the old refreshFiles().
 */
export function flatMdFiles(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  function walk(n: FileTreeNode) {
    if (n.isDirectory) { n.children?.forEach(walk); return; }
    if (n.name.endsWith('.md') && n.name !== AGENT_FILE) paths.push(n.path);
  }
  nodes.forEach(walk);
  return paths.sort();
}

/** Rebuild the full file tree for a workspace (call after creating/deleting files). */
export async function refreshFileTree(workspace: Workspace): Promise<FileTreeNode[]> {
  return buildFileTree(workspace.path);
}

/** Refresh both the file tree and the derived .md file list in a single pass.
 * The canonical helper for rebuilding workspace state after any file-system mutation.
 */
export async function refreshWorkspaceFiles(
  workspace: Workspace,
): Promise<{ files: string[]; fileTree: FileTreeNode[] }> {
  const fileTree = await buildFileTree(workspace.path);
  return { files: flatMdFiles(fileTree), fileTree };
}

// ── Recents ──────────────────────────────────────────────────
export function getRecents(): RecentWorkspace[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveRecent(entry: RecentWorkspace): void {
  const existing = getRecents().filter((r) => r.path !== entry.path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([entry, ...existing].slice(0, 10)));
}

export function removeRecent(path: string): void {
  const updated = getRecents().filter((r) => r.path !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
}

// ── Helpers ───────────────────────────────────────────────────
function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? 'Workspace';
}
