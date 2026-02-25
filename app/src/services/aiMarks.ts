import {
  readTextFile,
  writeTextFile,
  exists,
  mkdir,
} from '@tauri-apps/plugin-fs';
import type { Workspace, AIEditMark } from '../types';
import { CONFIG_DIR } from './config';
const MARKS_FILE = 'ai-marks.json';

function marksPath(workspace: Workspace): string {
  return `${workspace.path}/${CONFIG_DIR}/${MARKS_FILE}`;
}

export async function loadMarks(workspace: Workspace): Promise<AIEditMark[]> {
  const path = marksPath(workspace);
  try {
    if (!(await exists(path))) return [];
    return JSON.parse(await readTextFile(path)) as AIEditMark[];
  } catch {
    return [];
  }
}

export async function saveMarks(workspace: Workspace, marks: AIEditMark[]): Promise<void> {
  const dir = `${workspace.path}/${CONFIG_DIR}`;
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(marksPath(workspace), JSON.stringify(marks, null, 2));
}

export async function addMark(workspace: Workspace, mark: AIEditMark): Promise<AIEditMark[]> {
  const marks = await loadMarks(workspace);
  const updated = [...marks, mark];
  await saveMarks(workspace, updated);
  return updated;
}

/** Append multiple marks in a single read-modify-write cycle. */
export async function addMarksBulk(workspace: Workspace, newMarks: AIEditMark[]): Promise<AIEditMark[]> {
  if (newMarks.length === 0) return loadMarks(workspace);
  const existing = await loadMarks(workspace);
  const updated = [...existing, ...newMarks];
  await saveMarks(workspace, updated);
  return updated;
}

export async function markReviewed(workspace: Workspace, id: string): Promise<AIEditMark[]> {
  const marks = await loadMarks(workspace);
  const updated = marks.map((m) =>
    m.id === id ? { ...m, reviewed: true, reviewedAt: new Date().toISOString() } : m,
  );
  await saveMarks(workspace, updated);
  return updated;
}
