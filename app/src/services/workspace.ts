import { open } from '@tauri-apps/plugin-dialog';
import {
  readTextFile,
  writeTextFile,
  readDir,
  mkdir,
  exists,
  remove,
  copyFile,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, WorkspaceConfig, RecentWorkspace, FileTreeNode } from '../types';

const RECENTS_KEY = 'custom-tool-recent-workspaces';
const CONFIG_DIR = 'customtool';
const CONFIG_FILE = 'config.json';
const AGENT_FILE = 'AGENT.md';

// Directory/file names to skip when building the file tree
const SKIP_NAMES = new Set(['node_modules', '.git', '.customtool', 'customtool', 'target', '.DS_Store']);

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
    if (SKIP_NAMES.has(entry.name)) continue;
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

/** Open a native folder-picker dialog and return the selected path. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: 'Open Workspace Folder' });
  return typeof selected === 'string' ? selected : null;
}

/** Load (or create) workspace config + agent context + file list. */
export async function loadWorkspace(folderPath: string): Promise<Workspace> {
  // 1. Ensure .customtool/ dir exists
  const configDir = `${folderPath}/${CONFIG_DIR}`;
  const configPath = `${configDir}/${CONFIG_FILE}`;

  if (!(await exists(configDir))) {
    await mkdir(configDir, { recursive: true });
  }

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

  // 4. Auto-init git if needed
  try {
    await invoke('git_init', { path: folderPath });
  } catch { /* not fatal */ }

  // 5. List .md files (top-level only for now)
  let files: string[] = [];
  try {
    const entries = await readDir(folderPath);
    files = entries
      .filter((e) => !e.isDirectory && e.name?.endsWith('.md') && e.name !== AGENT_FILE)
      .map((e) => e.name!)
      .sort();
  } catch { /* not fatal */ }

  // 6. Build full recursive file tree
  const fileTree = await buildFileTree(folderPath);

  const workspace: Workspace = {
    path: folderPath,
    name: config.name,
    config,
    agentContext,
    files,
    fileTree,
  };

  // 7. Persist to recents
  saveRecent({ path: folderPath, name: config.name, lastOpened: new Date().toISOString() });

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
  const recentFiles = [filename, ...prev.filter((f) => f !== filename)].slice(0, 5);
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

/** Delete a file from the workspace. */
export async function deleteFile(workspace: Workspace, relPath: string): Promise<void> {
  await remove(`${workspace.path}/${relPath}`);
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

/** Create a new directory (and any missing parents). */
export async function createFolder(workspace: Workspace, relPath: string): Promise<void> {
  const absPath = `${workspace.path}/${relPath}`;
  if (!(await exists(absPath))) {
    await mkdir(absPath, { recursive: true });
  }
}

/** Reload file list for a workspace (call after creating new files). */
export async function refreshFiles(workspace: Workspace): Promise<string[]> {
  const entries = await readDir(workspace.path);
  return entries
    .filter((e) => !e.isDirectory && e.name?.endsWith('.md') && e.name !== AGENT_FILE)
    .map((e) => e.name!)
    .sort();
}

/** Rebuild the full file tree for a workspace (call after creating/deleting files). */
export async function refreshFileTree(workspace: Workspace): Promise<FileTreeNode[]> {
  return buildFileTree(workspace.path);
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
