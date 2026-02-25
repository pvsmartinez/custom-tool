/**
 * useFileWatcher
 *
 * Sets up a Tauri fs.watch() on the workspace root path and auto-reloads
 * open text tabs when their on-disk content changes (provided the tab has
 * no unsaved user edits).
 *
 * Re-attaches the watcher only when `watchPath` changes.  The caller must
 * pass stable refs (created once with useRef) so the effect dependency array
 * stays minimal.
 */
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { watch as fsWatch } from '@tauri-apps/plugin-fs';
import type { Workspace } from '../types';
import { readFile } from '../services/workspace';
import { getFileTypeInfo } from '../utils/fileType';

const RELOAD_SKIP_KINDS = new Set(['pdf', 'video', 'audio', 'image', 'canvas']);

export interface UseFileWatcherOptions {
  /** Absolute workspace path; pass null/undefined to disable the watcher. */
  watchPath: string | null | undefined;
  /** Always-fresh ref to the current workspace object. */
  workspaceRef:    MutableRefObject<Workspace | null>;
  /** Always-fresh ref to the list of currently-open tab paths. */
  tabsRef:         MutableRefObject<string[]>;
  /** Always-fresh ref to the set of files with unsaved edits. */
  dirtyFilesRef:   MutableRefObject<Set<string>>;
  /** Always-fresh ref to the currently-active tab path. */
  activeTabIdRef:  MutableRefObject<string | null>;
  /** Always-fresh ref to the per-tab content map. */
  tabContentsRef:  MutableRefObject<Map<string, string>>;
  /** Always-fresh ref to the last-saved content map. */
  savedContentRef: MutableRefObject<Map<string, string>>;
  /** Callback to refresh the sidebar file tree after an external change. */
  onRefresh: (ws: Workspace) => Promise<void>;
  /** Callback to push new content to the editor for the active tab. */
  setContent: (content: string) => void;
}

export function useFileWatcher({
  watchPath,
  workspaceRef,
  tabsRef,
  dirtyFilesRef,
  activeTabIdRef,
  tabContentsRef,
  savedContentRef,
  onRefresh,
  setContent,
}: UseFileWatcherOptions): void {
  useEffect(() => {
    if (!watchPath) return;

    let unwatch: (() => void | Promise<void>) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    fsWatch(
      watchPath,
      () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const ws = workspaceRef.current;
          if (!ws || ws.path !== watchPath) return; // workspace changed — bail
          try {
            await onRefresh(ws);
          } catch { /* workspace may have been closed — ignore */ }

          // Auto-reload any open text tabs whose content changed on disk and
          // that have no unsaved user edits (dirty = false).
          const currentTabs  = tabsRef.current;
          const currentDirty = dirtyFilesRef.current;
          for (const tabPath of currentTabs) {
            if (currentDirty.has(tabPath)) continue; // has unsaved edits — skip
            const tabKind = getFileTypeInfo(tabPath).kind;
            if (RELOAD_SKIP_KINDS.has(tabKind)) continue;
            try {
              const ws2 = workspaceRef.current;
              if (!ws2) break;
              const freshText = await readFile(ws2, tabPath);
              const savedText = savedContentRef.current.get(tabPath);
              if (freshText === savedText) continue; // no actual change
              savedContentRef.current.set(tabPath, freshText);
              tabContentsRef.current.set(tabPath, freshText);
              if (tabPath === activeTabIdRef.current) setContent(freshText);
            } catch { /* file may be deleted — ignore */ }
          }
        }, 600);
      },
      { recursive: true },
    )
      .then((fn) => { unwatch = fn; })
      .catch(() => { /* watch not available — ignore */ });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (unwatch) { try { unwatch(); } catch { /* ignore */ } }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchPath]);
}
