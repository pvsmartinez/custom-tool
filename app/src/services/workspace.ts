import { open } from '@tauri-apps/plugin-dialog';
import {
  readTextFile,
  writeTextFile,
  readDir,
  mkdir,
  exists,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, WorkspaceConfig, RecentWorkspace } from '../types';

const RECENTS_KEY = 'custom-tool-recent-workspaces';
const CONFIG_DIR = '.customtool';
const CONFIG_FILE = 'config.json';
const AGENT_FILE = 'AGENT.md';

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
    if (await exists(ap)) {
      try {
        agentContext = await readTextFile(ap);
        break;
      } catch { /* skip */ }
    }
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

  const workspace: Workspace = {
    path: folderPath,
    name: config.name,
    config,
    agentContext,
    files,
  };

  // 6. Persist to recents
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

export async function createFile(workspace: Workspace, filename: string): Promise<void> {
  const path = `${workspace.path}/${filename}`;
  if (!(await exists(path))) {
    await writeTextFile(path, `# ${filename.replace(/\.md$/, '')}\n\n`);
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
