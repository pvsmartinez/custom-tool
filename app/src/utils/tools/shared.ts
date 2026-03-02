/**
 * Shared types and utilities for workspace tool domains.
 */

import type { Editor } from 'tldraw';
import type { WorkspaceExportConfig, WorkspaceConfig } from '../../types';

// ── Public tool schema type (OpenAI function-calling format) ─────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: { type: string };
      }>;
      required?: string[];
    };
  };
}

/** The public executor type consumed by the AI streamer. */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** Internal per-domain executor — returns null if the tool name is not handled. */
export type DomainExecutor = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string | null>;

// ── Context passed to every domain executor ──────────────────────────────────

export interface ToolContext {
  workspacePath: string;
  canvasEditor: { current: Editor | null };
  activeFile?: string;
  workspaceExportConfig?: WorkspaceExportConfig;
  workspaceConfig?: WorkspaceConfig;
  webPreviewRef?: { current: { getScreenshot: () => Promise<string | null> } | null };
  onFileWritten?: (path: string) => void;
  onMarkRecorded?: (relPath: string, content: string) => void;
  onCanvasModified?: (shapeIds: string[]) => void;
  onMemoryWritten?: (newContent: string) => void;
  onExportConfigChange?: (config: WorkspaceExportConfig) => void;
  onWorkspaceConfigChange?: (patch: Partial<WorkspaceConfig>) => void;
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  getActiveHtml?: () => { html: string; absPath: string } | null;
  /** Agent that owns locks created by this executor call. */
  agentId?: string;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Text file extensions eligible for search_workspace. */
export const TEXT_EXTS = new Set([
  'md', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx',
  'json', 'css', 'html', 'rs', 'toml', 'yaml', 'yml', 'sh',
]);

/**
 * Validate that a workspace-relative path does not escape the workspace root.
 * Returns the resolved absolute path on success, or throws on violation.
 */
export function safeResolvePath(wsPath: string, relPath: string): string {
  const segments: string[] = [];
  for (const seg of (`${wsPath}/${relPath}`).split('/')) {
    if (seg === '..') {
      segments.pop();
    } else if (seg !== '.') {
      segments.push(seg);
    }
  }
  const abs = segments.join('/');
  const wsNorm = wsPath.endsWith('/') ? wsPath : wsPath + '/';
  if (abs !== wsPath && !abs.startsWith(wsNorm)) {
    throw new Error(`Path traversal detected: "${relPath}" resolves outside the workspace.`);
  }
  return abs;
}
