/**
 * Mobile Pending Tasks — service to read/write the desktop task queue.
 *
 * Tasks are written by the Copilot on mobile when the user requests something
 * that cannot be done on iOS (run scripts, canvas edits, compile code, etc.).
 *
 * File location: {workspacePath}/cafezin/mobile-pending.json
 * Never committed to git — should be in .gitignore (cafezin/ already is).
 */

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { CONFIG_DIR } from './config';

export interface MobilePendingTask {
  id: string;
  /** Short description of what should be done on desktop */
  description: string;
  /** Optional context: file path, code snippet, etc. */
  context?: string;
  /** ISO timestamp when the task was created */
  createdAt: string;
}

const PENDING_FILE = 'mobile-pending.json';

function pendingPath(workspacePath: string): string {
  return `${workspacePath}/${CONFIG_DIR}/${PENDING_FILE}`;
}

export async function loadPendingTasks(workspacePath: string): Promise<MobilePendingTask[]> {
  const path = pendingPath(workspacePath);
  try {
    if (!(await exists(path))) return [];
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MobilePendingTask[]) : [];
  } catch {
    return [];
  }
}

export async function savePendingTasks(
  workspacePath: string,
  tasks: MobilePendingTask[],
): Promise<void> {
  const dir = `${workspacePath}/${CONFIG_DIR}`;
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  await writeTextFile(pendingPath(workspacePath), JSON.stringify(tasks, null, 2));
}

export async function appendPendingTask(
  workspacePath: string,
  task: Omit<MobilePendingTask, 'id' | 'createdAt'>,
): Promise<MobilePendingTask> {
  const current = await loadPendingTasks(workspacePath);
  const newTask: MobilePendingTask = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...task,
  };
  await savePendingTasks(workspacePath, [...current, newTask]);
  return newTask;
}

export async function deletePendingTask(workspacePath: string, id: string): Promise<void> {
  const current = await loadPendingTasks(workspacePath);
  await savePendingTasks(workspacePath, current.filter(t => t.id !== id));
}
