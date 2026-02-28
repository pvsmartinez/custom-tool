import { useState, useRef } from 'react';
import { getFileTypeInfo } from '../utils/fileType';

/**
 * Manages all multi-tab state for the editor.
 *
 * Responsibilities:
 *   - `tabs` / `activeTabId` / `previewTabId` state and their always-fresh refs
 *   - Per-tab content + viewMode refs (switching is O(1) — no I/O)
 *   - `savedContentRef` — last-persisted content per file (drives dirty tracking)
 *   - All tab CRUD operations: open, close, close-others, close-to-right, reorder, promote
 *   - `switchToTab` — saves the outgoing tab's ephemeral state then loads the incoming one
 *
 * What this hook does NOT own:
 *   - `dirtyFiles` — App.tsx owns this; pass an `onClosed` callback to close operations
 *     so App.tsx can remove closed paths from the dirty set.
 *   - File I/O — `handleOpenFile` in App.tsx reads the file then calls `addTab`.
 *   - AI nav index reset — App.tsx does `useEffect(() => resetNav(), [activeFile])`.
 */

export interface TabManagerOptions {
  /** Initial content shown before any file is opened. */
  fallbackContent?: string;
}

export interface TabManager {
  // ── Readable state ───────────────────────────────────────────────────────
  tabs: string[];
  activeTabId: string | null;
  /** Convenience alias — same value as activeTabId. */
  activeFile: string | null;
  previewTabId: string | null;
  content: string;
  viewMode: 'edit' | 'preview';

  // ── Setters for external updates ─────────────────────────────────────────
  setTabs: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setPreviewTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  setViewMode: React.Dispatch<React.SetStateAction<'edit' | 'preview'>>;

  // ── Always-fresh refs (safe to read inside async callbacks) ──────────────
  activeTabIdRef: React.MutableRefObject<string | null>;
  tabsRef: React.MutableRefObject<string[]>;

  // ── Per-tab content maps ──────────────────────────────────────────────────
  /** Per-tab display content. Updated on every keystroke; switching reads from here. */
  tabContentsRef: React.MutableRefObject<Map<string, string>>;
  /** Per-tab view mode ('edit' | 'preview'). Persisted across switches. */
  tabViewModeRef: React.MutableRefObject<Map<string, 'edit' | 'preview'>>;
  /** Per-tab last-saved content. Compared against tabContentsRef to drive dirty state. */
  savedContentRef: React.MutableRefObject<Map<string, string>>;

  // ── Operations ────────────────────────────────────────────────────────────

  /**
   * Save the current tab's ephemeral state, then switch to `filePath`.
   * Pass `null` to return to the workspace home screen.
   */
  switchToTab: (filePath: string | null) => void;

  /**
   * Register a new file as an open tab (does NOT read the file — caller does that).
   * If there is a floating preview tab, it is replaced rather than appended.
   *
   * Typical usage in App.tsx:
   *   const text = await readFile(ws, filename);
   *   savedContentRef.current.set(filename, text);
   *   tabContentsRef.current.set(filename, text);
   *   tabViewModeRef.current.set(filename, mode);
   *   addTab(filename);
   *   switchToTab(filename);
   */
  addTab: (filePath: string) => void;

  /**
   * Close a single tab. Lands on the adjacent tab or home.
   * @param onClosed - called with the closed path so App.tsx can clear dirty state.
   */
  closeTab: (filePath: string, onClosed?: (path: string) => void) => void;

  /** Close every tab. */
  closeAllTabs: (onClosed?: (paths: string[]) => void) => void;

  /** Close every tab except `filePath`. */
  closeOthers: (filePath: string, onClosed?: (paths: string[]) => void) => void;

  /** Close all tabs to the right of `filePath`. */
  closeToRight: (filePath: string, onClosed?: (paths: string[]) => void) => void;

  /** Drag-reorder: move the tab at `fromIdx` to `toIdx`. */
  reorderTabs: (fromIdx: number, toIdx: number) => void;

  /** Promote a preview tab to a permanent one (e.g. on double-click in TabBar). */
  promoteTab: (filePath: string) => void;

  /**
   * Clear all tab state — used when switching workspaces.
   * Does NOT call onClosed (dirty state is also cleared wholesale by the caller).
   */
  clearAll: () => void;
}

export function useTabManager(
  options: TabManagerOptions = {},
): TabManager {
  const { fallbackContent = '' } = options;

  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [previewTabId, setPreviewTabId] = useState<string | null>(null);
  const [content, setContent] = useState<string>(fallbackContent);
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');

  // Always-fresh refs — safe to read inside async callbacks / effects
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const tabsRef = useRef<string[]>(tabs);
  const previewTabIdRef = useRef<string | null>(previewTabId);
  activeTabIdRef.current = activeTabId;
  tabsRef.current = tabs;
  previewTabIdRef.current = previewTabId;

  // Per-tab content maps
  const tabContentsRef = useRef<Map<string, string>>(new Map());
  const tabViewModeRef = useRef<Map<string, 'edit' | 'preview'>>(new Map());
  const savedContentRef = useRef<Map<string, string>>(new Map());

  // ── Auto-promote preview → permanent as soon as the file becomes dirty ──
  // (App.tsx drives this by calling setDirtyFiles — the effect below reacts.)
  // Rather than coupling to dirtyFiles here, App.tsx calls promoteTab explicitly
  // from its dirty-tracking logic. See handleContentChange in App.tsx.

  // ── Operations ─────────────────────────────────────────────────────────────

  function switchToTab(filePath: string | null) {
    // Save outgoing tab's content + mode
    if (activeTabIdRef.current) {
      tabContentsRef.current.set(activeTabIdRef.current, content);
      tabViewModeRef.current.set(activeTabIdRef.current, viewMode);
    }
    setActiveTabId(filePath);
    if (filePath) {
      const savedContent = tabContentsRef.current.get(filePath) ?? '';
      const savedMode =
        tabViewModeRef.current.get(filePath) ??
        (getFileTypeInfo(filePath).defaultMode as 'edit' | 'preview');
      setContent(savedContent);
      setViewMode(savedMode);
    } else {
      setContent(fallbackContent);
      setViewMode('edit');
    }
  }

  function addTab(filePath: string) {
    if (tabsRef.current.includes(filePath)) return;
    // Use a ref so this is always the fresh preview tab id, even in async contexts
    const currentPreview = previewTabIdRef.current;
    if (currentPreview) {
      // Replace floating preview tab — clean up its refs first
      _cleanRefs([currentPreview]);
      setTabs((prev) => prev.map((t) => (t === currentPreview ? filePath : t)));
    } else {
      setTabs((prev) => [...prev, filePath]);
    }
    setPreviewTabId(filePath);
  }

  function _cleanRefs(paths: string[]) {
    for (const p of paths) {
      tabContentsRef.current.delete(p);
      tabViewModeRef.current.delete(p);
      savedContentRef.current.delete(p);
    }
  }

  function closeTab(filePath: string, onClosed?: (path: string) => void) {
    setPreviewTabId((prev) => (prev === filePath ? null : prev));
    onClosed?.(filePath);

    setTabs((prev) => {
      const next = prev.filter((p) => p !== filePath);
      if (activeTabIdRef.current === filePath) {
        const idx = prev.indexOf(filePath);
        const newActive = next[idx] ?? next[idx - 1] ?? null;
        // Snapshot the content and view mode BEFORE cleaning refs, so a rapid
        // sequence of closeTab calls (e.g. "Close All") doesn't delete the
        // newActive entry from tabContentsRef before we can read it.
        const nextContent = newActive
          ? (tabContentsRef.current.get(newActive) ?? '')
          : fallbackContent;
        const nextViewMode = newActive
          ? (tabViewModeRef.current.get(newActive) ?? (getFileTypeInfo(newActive).defaultMode as 'edit' | 'preview'))
          : 'edit';
        _cleanRefs([filePath]);
        setContent(nextContent);
        setViewMode(nextViewMode);
        setActiveTabId(newActive);
      } else {
        _cleanRefs([filePath]);
      }
      return next;
    });
  }

  function closeAllTabs(onClosed?: (paths: string[]) => void) {
    const current = tabsRef.current;
    _cleanRefs(current);
    onClosed?.(current);
    setTabs([]);
    setActiveTabId(null);
    setPreviewTabId(null);
    setContent(fallbackContent);
    setViewMode('edit');
  }

  function closeOthers(filePath: string, onClosed?: (paths: string[]) => void) {
    const toClose = tabsRef.current.filter((t) => t !== filePath);
    _cleanRefs(toClose);
    setPreviewTabId((prev) => (prev && prev !== filePath ? null : prev));
    onClosed?.(toClose);
    setTabs([filePath]);
    // Switch to the kept tab if active tab was among the closed ones
    if (activeTabIdRef.current !== filePath) switchToTab(filePath);
  }

  function closeToRight(filePath: string, onClosed?: (paths: string[]) => void) {
    const idx = tabsRef.current.indexOf(filePath);
    if (idx === -1) return;
    const toClose = tabsRef.current.slice(idx + 1);
    _cleanRefs(toClose);
    setPreviewTabId((prev) => (prev && toClose.includes(prev) ? null : prev));
    onClosed?.(toClose);
    setTabs((prev) => prev.slice(0, idx + 1));
    if (activeTabIdRef.current && toClose.includes(activeTabIdRef.current)) {
      switchToTab(filePath);
    }
  }

  function reorderTabs(fromIdx: number, toIdx: number) {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }

  function promoteTab(filePath: string) {
    setPreviewTabId((prev) => (prev === filePath ? null : prev));
  }

  function clearAll() {
    tabContentsRef.current.clear();
    tabViewModeRef.current.clear();
    savedContentRef.current.clear();
    setTabs([]);
    setActiveTabId(null);
    setPreviewTabId(null);
    setContent(fallbackContent);
    setViewMode('edit');
  }

  return {
    tabs,
    activeTabId,
    activeFile: activeTabId,
    previewTabId,
    content,
    viewMode,
    setTabs,
    setActiveTabId,
    setPreviewTabId,
    setContent,
    setViewMode,
    activeTabIdRef,
    tabsRef,
    tabContentsRef,
    tabViewModeRef,
    savedContentRef,
    switchToTab,
    addTab,
    closeTab,
    closeAllTabs,
    closeOthers,
    closeToRight,
    reorderTabs,
    promoteTab,
    clearAll,
  };
}
