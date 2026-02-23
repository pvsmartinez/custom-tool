export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export interface ToolActivity {
  callId: string;
  /** '__thinking__' for model reasoning text, otherwise the tool function name */
  name: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
  /** 'tool' (default) or 'thinking' for model reasoning emitted before a tool call */
  kind?: 'tool' | 'thinking';
  /** Model reasoning text captured before a tool call (when kind === 'thinking') */
  thinkingText?: string;
  /** Zero-based agent loop round this activity belongs to */
  round?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Present on assistant messages that request tool calls */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages (role === 'tool') */
  tool_call_id?: string;
  /** Tool function name — required by some API providers on tool messages */
  name?: string;
  /** Tool activities recorded during an agent run — attached to the assistant message on completion */
  toolActivities?: ToolActivity[];
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
  /** Up to 5 most-recently opened files (relative paths) */
  recentFiles?: string[];
  /** ISO timestamp of the last auto-save */
  lastEditedAt?: string;
}

/** A span of text inserted by the AI and not yet reviewed by the human. */
export interface AIEditMark {
  id: string;
  /** Relative path from workspace root */
  fileRelPath: string;
  /** The exact text that was inserted */
  text: string;
  /** AI model that generated it */
  model: string;
  insertedAt: string; // ISO
  reviewed: boolean;
  reviewedAt?: string;
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

export const DEFAULT_MODEL: CopilotModel = 'gpt-4.1';

/** Static fallback shown before the API responds (or if it fails).
 * IDs must match what GitHub Copilot's /models endpoint returns.
 * Keep in sync with: https://docs.github.com/en/copilot/reference/ai-models/supported-models
 */
export const FALLBACK_MODELS: CopilotModelInfo[] = [
  // Free / 0× tier
  { id: 'gpt-4o-mini',          name: 'GPT-4o mini',          multiplier: 0,    isPremium: false, vendor: 'OpenAI' },
  { id: 'gpt-4.1',              name: 'GPT-4.1',              multiplier: 0,    isPremium: false, vendor: 'OpenAI' },
  { id: 'gpt-5-mini',           name: 'GPT-5 mini',           multiplier: 0,    isPremium: false, vendor: 'OpenAI' },
  { id: 'claude-haiku-4-5',     name: 'Claude Haiku 4.5',     multiplier: 0.33, isPremium: false, vendor: 'Anthropic' },
  // Standard / 1× tier
  { id: 'gpt-4o',               name: 'GPT-4o',               multiplier: 1,    isPremium: false, vendor: 'OpenAI' },
  { id: 'claude-sonnet-4',      name: 'Claude Sonnet 4',      multiplier: 1,    isPremium: false, vendor: 'Anthropic' },
  { id: 'claude-sonnet-4-5',    name: 'Claude Sonnet 4.5',    multiplier: 1,    isPremium: false, vendor: 'Anthropic' },
  { id: 'claude-sonnet-4-6',    name: 'Claude Sonnet 4.6',    multiplier: 1,    isPremium: false, vendor: 'Anthropic' },
  { id: 'gemini-2.5-pro',       name: 'Gemini 2.5 Pro',       multiplier: 1,    isPremium: false, vendor: 'Google' },
  // Premium / >1× tier
  { id: 'claude-opus-4-5',      name: 'Claude Opus 4.5',      multiplier: 3,    isPremium: true,  vendor: 'Anthropic' },
  { id: 'claude-opus-4-6',      name: 'Claude Opus 4.6',      multiplier: 3,    isPremium: true,  vendor: 'Anthropic' },
];

