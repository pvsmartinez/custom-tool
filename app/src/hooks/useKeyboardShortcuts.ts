/**
 * useKeyboardShortcuts
 *
 * Registers a global `keydown` listener for all app-level shortcuts.
 * The listener is recreated whenever the options reference changes, so
 * all callbacks must be stable (useCallback) or wrapped in refs by the
 * caller to avoid excessive re-renders.
 *
 * Shortcuts handled:
 *   Cmd/Ctrl+K           Open AI panel
 *   Cmd/Ctrl+W           Close active tab
 *   Cmd/Ctrl+,           Open settings
 *   Cmd/Ctrl+B           Toggle sidebar
 *   Cmd/Ctrl+S           Save current file immediately
 *   Cmd/Ctrl+Shift+R     Reload / revert file from disk
 *   Cmd/Ctrl+T / N       New file
 *   Ctrl+Tab             Next tab
 *   Ctrl+Shift+Tab       Previous tab
 *   Cmd/Ctrl+F           Toggle inline find/replace
 *   Cmd/Ctrl+Shift+F     Project-wide search
 *   Cmd/Ctrl+Shift+P     Toggle Edit / Preview mode
 *   Escape               Close AI panel (when open)
 *   Cmd/Ctrl+J           Toggle terminal panel
 */
import { useEffect } from 'react';

export interface KeyboardShortcutOptions {
  /** Whether the AI panel is currently open (used for Escape key). */
  aiOpen: boolean;
  /** Currently-active tab path. */
  activeTabId: string | null;
  /** All open tab paths (for Ctrl+Tab cycling). */
  tabs: string[];
  /** Metadata about the active file (kind, supportsPreview, language). */
  fileTypeInfo: {
    kind: string;
    supportsPreview?: boolean;
    language?: string;
  } | null;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onOpenAI:       () => void;
  onCloseAI:      () => void;
  onCloseTab:     (id: string) => void;
  onOpenSettings: () => void;
  onToggleSidebar:() => void;
  /** Called for Cmd+S. The handler itself is responsible for saving and toasting. */
  onSave:         () => void;
  onReload:       () => void;
  onNewFile:      () => void;
  /** Switch to an adjacent tab by path. */
  onSwitchTab:    (id: string) => void;
  onToggleFind:   () => void;
  onGlobalSearch: () => void;
  onTogglePreview:() => void;
  onToggleTerminal:() => void;
}

export function useKeyboardShortcuts(opts: KeyboardShortcutOptions): void {
  const {
    aiOpen, activeTabId, tabs, fileTypeInfo,
    onOpenAI, onCloseAI, onCloseTab, onOpenSettings,
    onToggleSidebar, onSave, onReload, onNewFile, onSwitchTab,
    onToggleFind, onGlobalSearch, onTogglePreview, onToggleTerminal,
  } = opts;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;

      // Cmd+K → open AI panel
      if (cmd && e.key === 'k') {
        e.preventDefault();
        onOpenAI();
      }
      // Cmd+W → close current tab
      if (cmd && !e.shiftKey && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) onCloseTab(activeTabId);
      }
      // Cmd+, → open settings
      if (cmd && e.key === ',') {
        e.preventDefault();
        onOpenSettings();
      }
      // Cmd+B → toggle sidebar
      if (cmd && !e.shiftKey && e.key === 'b') {
        e.preventDefault();
        onToggleSidebar();
      }
      // Cmd/Ctrl+S → save current file immediately
      if (cmd && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        onSave();
      }
      // Cmd+Shift+R → reload/revert file from disk
      if (cmd && e.shiftKey && e.key === 'r') {
        e.preventDefault();
        onReload();
      }
      // Cmd+T / Cmd+N → new file at workspace root
      if (cmd && (e.key === 't' || e.key === 'n') && !e.shiftKey) {
        e.preventDefault();
        onNewFile();
      }
      // Ctrl+Tab → next tab
      if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        if (tabs.length > 1 && activeTabId) {
          const idx = tabs.indexOf(activeTabId);
          onSwitchTab(tabs[(idx + 1) % tabs.length]);
        }
      }
      // Ctrl+Shift+Tab → previous tab
      if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        if (tabs.length > 1 && activeTabId) {
          const idx = tabs.indexOf(activeTabId);
          onSwitchTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
        }
      }
      // Cmd+F → toggle inline find/replace bar
      if (cmd && !e.shiftKey && e.key === 'f') {
        if (fileTypeInfo?.kind && !['pdf', 'video', 'image'].includes(fileTypeInfo.kind)) {
          e.preventDefault();
          onToggleFind();
        }
      }
      // Cmd+Shift+F → project-wide search
      if (cmd && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        onGlobalSearch();
      }
      // Cmd+Shift+P → toggle Edit / Preview
      if (cmd && e.shiftKey && e.key === 'p') {
        if (fileTypeInfo?.supportsPreview) {
          e.preventDefault();
          onTogglePreview();
        }
      }
      // Escape → close AI panel
      if (e.key === 'Escape' && aiOpen) onCloseAI();
      // Cmd+J → toggle terminal panel
      if (cmd && e.key === 'j') {
        e.preventDefault();
        onToggleTerminal();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOpen, fileTypeInfo, activeTabId, tabs,
      onOpenAI, onCloseAI, onCloseTab, onOpenSettings, onToggleSidebar,
      onSave, onReload, onNewFile, onSwitchTab, onToggleFind,
      onGlobalSearch, onTogglePreview, onToggleTerminal]);
}
