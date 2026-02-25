/**
 * terminalBus — lightweight pub/sub for terminal entries.
 *
 * Any part of the app that runs a shell command (AI tools, the user) publishes
 * an entry here.  The BottomPanel subscribes and displays them in real-time.
 */

export interface TerminalEntry {
  id: string;
  source: 'ai' | 'user';
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  ts: number;
}

type Listener = (entry: TerminalEntry) => void;

const listeners = new Set<Listener>();

export function onTerminalEntry(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitTerminalEntry(entry: Omit<TerminalEntry, 'id'>): void {
  const full: TerminalEntry = {
    ...entry,
    id: `te-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  listeners.forEach((l) => l(full));
}
