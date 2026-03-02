/**
 * Global canvas editor registry + tab-control callbacks.
 *
 * Using module-level state avoids prop-drilling switchToCanvasTab /
 * setCopilotOverlay through App → AIPanel → AgentSession → useAIStream →
 * buildToolExecutor → canvasTools (5 layers).
 *
 * CanvasEditor.tsx writes into the registry when a canvas mounts/unmounts.
 * App.tsx registers the tab-switch and overlay callbacks.
 * canvasTools.ts uses the registry to target the correct Editor.
 */

import type { Editor } from 'tldraw';

// ── Editor instances per canvas relPath ───────────────────────────────────────

const _editorMap = new Map<string, Editor>();

export function registerCanvasEditor(relPath: string, editor: Editor): void {
  _editorMap.set(relPath, editor);
}

export function unregisterCanvasEditor(relPath: string): void {
  _editorMap.delete(relPath);
}

/** Returns the live Editor for the given canvas relPath if it is currently mounted. */
export function getCanvasEditor(relPath: string): Editor | undefined {
  return _editorMap.get(relPath);
}

// ── Tab-control callbacks (registered by App.tsx) ─────────────────────────────

type SwitchFn = (relPath: string) => Promise<void>;
type OverlayFn = (active: boolean) => void;

let _switchToCanvasTab: SwitchFn | null = null;
let _setCopilotOverlay: OverlayFn | null = null;

/** Called by App.tsx once on mount to provide stable callback wrappers. */
export function registerCanvasTabControls(switchFn: SwitchFn, overlayFn: OverlayFn): void {
  _switchToCanvasTab = switchFn;
  _setCopilotOverlay = overlayFn;
}

/**
 * Ensures the canvas tab for `relPath` is open and its Editor is mounted.
 * If the Editor is already in the registry (tab already active), returns immediately.
 * Otherwise triggers a tab switch in App and waits up to 10 s for the Editor to mount.
 */
export async function ensureCanvasTabOpen(relPath: string): Promise<void> {
  if (_editorMap.has(relPath)) return;
  if (!_switchToCanvasTab) throw new Error('[canvasRegistry] Tab controls not registered — cannot switch canvas tab.');
  return _switchToCanvasTab(relPath);
}

/** Show or hide the "Copilot a trabalhar..." full-window overlay in App. */
export function setCopilotOverlay(active: boolean): void {
  _setCopilotOverlay?.(active);
}
