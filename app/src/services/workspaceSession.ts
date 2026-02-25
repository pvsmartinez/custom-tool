/**
 * Per-workspace session persistence.
 * Saves/restores open tabs and sidebar folder state using localStorage.
 * Copilot chat history is intentionally NOT persisted — it always starts fresh.
 */

const KEY_PREFIX = 'cafezin:session:';

export interface WorkspaceSession {
  /** Ordered open tab file paths */
  tabs: string[];
  /** Currently active tab */
  activeTabId: string | null;
  /** The single "preview" (temporary) tab, if any */
  previewTabId: string | null;
  /** Expanded folder paths in the sidebar */
  expandedDirs: string[];
}

function sessionKey(workspacePath: string): string {
  return `${KEY_PREFIX}${workspacePath}`;
}

export function loadWorkspaceSession(workspacePath: string): WorkspaceSession {
  try {
    const raw = localStorage.getItem(sessionKey(workspacePath));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSession>;
      return {
        tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
        activeTabId: parsed.activeTabId ?? null,
        previewTabId: parsed.previewTabId ?? null,
        expandedDirs: Array.isArray(parsed.expandedDirs) ? parsed.expandedDirs : [],
      };
    }
  } catch { /* corrupt data — ignore */ }
  return { tabs: [], activeTabId: null, previewTabId: null, expandedDirs: [] };
}

export function saveWorkspaceSession(
  workspacePath: string,
  session: Partial<WorkspaceSession>,
): void {
  try {
    const existing = loadWorkspaceSession(workspacePath);
    const merged: WorkspaceSession = { ...existing, ...session };
    localStorage.setItem(sessionKey(workspacePath), JSON.stringify(merged));
  } catch { /* quota exceeded or similar — ignore */ }
}
