export type BlockStatus = 'ai-generated' | 'human-edited' | 'human-written' | 'reviewed';

export interface ContentBlock {
  id: string;
  status: BlockStatus;
  aiModel?: string;
  generatedAt?: string;
  reviewedAt?: string;
}

export interface Document {
  id: string;
  title: string;
  content: string;
  blocks: ContentBlock[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CopilotStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}

export interface WorkspaceConfig {
  name: string;
  lastOpenedFile?: string;
  preferredModel?: string;
}

export interface Workspace {
  path: string;         // absolute path to workspace folder
  name: string;
  config: WorkspaceConfig;
  agentContext?: string; // contents of AGENT.md if present
  files: string[];       // .md filenames (relative) – kept for compat
  fileTree: FileTreeNode[]; // full recursive tree of the workspace
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string;
}

export interface FileTreeNode {
  name: string;
  /** Relative path from workspace root (e.g. "src/lib/utils.ts") */
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
}

export type CopilotModel = string; // resolved dynamically from /models endpoint

export interface CopilotModelInfo {
  id: string;
  name: string;
  /** Billing multiplier from the API (0 = free, 1 = standard, 2 = 2× premium, …) */
  multiplier: number;
  /** True when multiplier > 1 */
  isPremium: boolean;
  vendor?: string;
}

export const DEFAULT_MODEL: CopilotModel = 'gpt-4o';

/** Static fallback shown before the API responds (or if it fails) */
export const FALLBACK_MODELS: CopilotModelInfo[] = [
  // Free tier
  { id: 'gpt-4o-mini',           name: 'GPT-4o mini',           multiplier: 0,   isPremium: false, vendor: 'OpenAI' },
  { id: 'gpt-4o',                name: 'GPT-4o',                multiplier: 1,   isPremium: false, vendor: 'OpenAI' },
  // Premium tier
  { id: 'claude-sonnet-4-5',     name: 'Claude Sonnet 4.6',     multiplier: 1,   isPremium: true,  vendor: 'Anthropic' },
  { id: 'gemini-2.0-flash-001',  name: 'Gemini 2.0 Flash',      multiplier: 0.5, isPremium: true,  vendor: 'Google' },
];

/** @deprecated use CopilotModelInfo[] from fetchCopilotModels() instead */
export const COPILOT_MODELS: { id: CopilotModel; label: string }[] = [
  { id: 'gpt-4o',            label: 'GPT-4o' },
  { id: 'gpt-4o-mini',       label: 'GPT-4o mini' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.6' },
  { id: 'gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
];
