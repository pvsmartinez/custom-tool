import { writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { CONFIG_DIR } from './config';
const LOG_FILE = 'copilot-log.jsonl';

export interface CopilotLogEntry {
  /** Groups all exchanges within one "chat session" (cleared on New Chat) */
  sessionId: string;
  /** ISO timestamp when this session was started */
  sessionStartedAt: string;
  /** ISO timestamp of this specific exchange */
  timestamp: string;
  model: string;
  userMessage: string;
  aiResponse: string;
  /** Number of tool calls made by the agent during this exchange, if any */
  toolCalls?: number;
}

/**
 * An `archive` entry is written when the agent auto-summarizes the context mid-run
 * because it was approaching the token limit. It contains:
 *   - A model-generated dense summary of what happened
 *   - A full snapshot of the conversation at that point (base64 images stripped)
 *
 * The file format is JSONL — one JSON object per line. `entryType` distinguishes
 * archive entries (`"archive"`) from normal exchange entries (no `entryType` field).
 *
 * How the in-app Copilot (agent) can use this file:
 *   - Path: `<workspace>/cafezin/copilot-log.jsonl`
 *   - Read with `read_file` (the `path` is available in the system prompt as `workspacePath`)
 *   - Each line is valid JSON; parse with `JSON.parse`
 *   - Entries with `entryType: "archive"` are session snapshots — read `summary` for a concise
 *     overview and `messages` for the full turn-by-turn transcript (sans images)
 *   - Entries without `entryType` are normal exchange records with `userMessage` / `aiResponse`
 */
export interface CopilotArchiveEntry {
  entryType: 'archive';
  /** Links back to the session that was summarized */
  sessionId: string;
  /** ISO timestamp of when the archive was written */
  archivedAt: string;
  /** Agent round number at archival time */
  round: number;
  /** Estimated token count that triggered archival */
  estimatedTokens: number;
  /** Model-generated dense summary of the session up to this point */
  summary: string;
  /** Full conversation snapshot (base64 images replaced with "[image]") */
  messages: object[];
}

/**
 * Append one exchange as a JSON line to `cafezin/copilot-log.jsonl`.
 * The file is newline-delimited JSON (JSONL) — one object per line —
 * so it is easy to tail, grep, and parse incrementally.
 */
/** Shared implementation — append one serialised JSON line to the log file. */
async function writeLogLine(workspacePath: string, data: object): Promise<void> {
  const dir = `${workspacePath}/${CONFIG_DIR}`;
  try {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(`${dir}/${LOG_FILE}`, JSON.stringify(data) + '\n', { append: true });
  } catch (err) {
    // Logging is best-effort; never surface errors to the user
    console.warn('[copilotLog] Failed to write log line:', err);
  }
}

export async function appendLogEntry(
  workspacePath: string,
  entry: CopilotLogEntry,
): Promise<void> {
  await writeLogLine(workspacePath, entry);
}

/**
 * Append a context-archive entry to the same copilot-log.jsonl file.
 * Called automatically by the agent when it mid-run summarizes context.
 */
export async function appendArchiveEntry(
  workspacePath: string,
  entry: CopilotArchiveEntry,
): Promise<void> {
  await writeLogLine(workspacePath, entry);
}

/** Generate a short session ID based on the current timestamp. */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}`;
}
