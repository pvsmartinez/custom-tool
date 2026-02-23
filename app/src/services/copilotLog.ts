import { writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';

const CONFIG_DIR = 'customtool';
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
 * Append one exchange as a JSON line to `customtool/copilot-log.jsonl`.
 * The file is newline-delimited JSON (JSONL) — one object per line —
 * so it is easy to tail, grep, and parse incrementally.
 */
export async function appendLogEntry(
  workspacePath: string,
  entry: CopilotLogEntry,
): Promise<void> {
  const dir = `${workspacePath}/${CONFIG_DIR}`;
  try {
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    await writeTextFile(`${dir}/${LOG_FILE}`, line, { append: true });
  } catch (err) {
    // Logging is best-effort; never surface errors to the user
    console.warn('[copilotLog] Failed to write log entry:', err);
  }
}

/** Generate a short session ID based on the current timestamp. */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}`;
}
