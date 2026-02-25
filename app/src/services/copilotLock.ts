/**
 * Pub/sub registry of files currently being modified by the Copilot agent.
 * Locked files show a shimmer in the sidebar and a lock overlay in the editor.
 */

type Listener = (locked: Set<string>) => void;

const lockedFiles = new Set<string>();
const listeners = new Set<Listener>();

function notify() {
  const snapshot = new Set(lockedFiles);
  listeners.forEach((fn) => fn(snapshot));
}

/** Mark a file as actively being edited by Copilot. */
export function lockFile(path: string): void {
  lockedFiles.add(path);
  notify();
}

/** Release the lock on a file after Copilot finishes or errors. */
export function unlockFile(path: string): void {
  lockedFiles.delete(path);
  notify();
}

/** Release all locks — call on agent run completion, error, or user stop. */
export function unlockAll(): void {
  if (lockedFiles.size === 0) return;
  lockedFiles.clear();
  notify();
}

/** Get a snapshot of all currently locked file paths. */
export function getLockedFiles(): Set<string> {
  return new Set(lockedFiles);
}

/**
 * Subscribe to lock-set changes.
 * Returns an unsubscribe function.
 */
export function onLockedFilesChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
