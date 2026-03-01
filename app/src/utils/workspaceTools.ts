/**
 * Workspace tool definitions (OpenAI function calling format) + their executors.
 *
 * This module is now a thin aggregator. Each domain is implemented in:
 *   utils/tools/fileTools.ts    - list, read, write, patch, search, rename, delete, scaffold, check_file
 *   utils/tools/canvasTools.ts  - list_canvas_shapes, canvas_op, canvas_screenshot, add_canvas_image, screenshot_preview
 *   utils/tools/webTools.ts     - web_search, search_stock_images, fetch_url, run_command
 *   utils/tools/configTools.ts  - export_workspace, configure_export_targets, configure_workspace, remember, ask_user
 *
 * Public API is unchanged: WORKSPACE_TOOLS, buildToolExecutor, ToolDefinition, ToolExecutor.
 */

import type { Editor } from 'tldraw';
import { FILE_TOOL_DEFS, executeFileTools } from './tools/fileTools';
import { CANVAS_TOOL_DEFS, executeCanvasTools } from './tools/canvasTools';
import { WEB_TOOL_DEFS, executeWebTools } from './tools/webTools';
import { CONFIG_TOOL_DEFS, executeConfigTools } from './tools/configTools';
import type { WorkspaceExportConfig, WorkspaceConfig } from '../types';

// Re-export types so existing importers do not break
export type { ToolDefinition, ToolExecutor } from './tools/shared';

// Aggregated tool list
export const WORKSPACE_TOOLS = [
  ...FILE_TOOL_DEFS,
  ...CANVAS_TOOL_DEFS,
  ...WEB_TOOL_DEFS,
  ...CONFIG_TOOL_DEFS,
];

// Aggregated executor factory - same signature as before
export function buildToolExecutor(
  workspacePath: string,
  canvasEditor: { current: Editor | null },
  onFileWritten?: (path: string) => void,
  onMarkRecorded?: (relPath: string, content: string) => void,
  onCanvasModified?: (shapeIds: string[]) => void,
  activeFile?: string,
  workspaceExportConfig?: WorkspaceExportConfig,
  onExportConfigChange?: (config: WorkspaceExportConfig) => void,
  onMemoryWritten?: (newContent: string) => void,
  webPreviewRef?: { current: { getScreenshot: () => Promise<string | null> } | null },
  onAskUser?: (question: string, options?: string[]) => Promise<string>,
  getActiveHtml?: () => { html: string; absPath: string } | null,
  workspaceConfig?: WorkspaceConfig,
  onWorkspaceConfigChange?: (patch: Partial<WorkspaceConfig>) => void,
) {
  const ctx = {
    workspacePath,
    canvasEditor,
    activeFile,
    workspaceExportConfig,
    workspaceConfig,
    webPreviewRef,
    onFileWritten,
    onMarkRecorded,
    onCanvasModified,
    onMemoryWritten,
    onExportConfigChange,
    onWorkspaceConfigChange,
    onAskUser,
    getActiveHtml,
  };

  const domains = [executeFileTools, executeCanvasTools, executeWebTools, executeConfigTools];

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    for (const domain of domains) {
      const result = await domain(name, args, ctx);
      if (result !== null) return result;
    }
    return `Unknown tool: ${name}`;
  };
}
