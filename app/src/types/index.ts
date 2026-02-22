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
  files: string[];       // .md filenames (relative)
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string;
}

export type CopilotModel =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'claude-3.5-sonnet'
  | 'o3-mini'
  | 'o1';

export const DEFAULT_MODEL: CopilotModel = 'gpt-4o';

export const COPILOT_MODELS: { id: CopilotModel; label: string }[] = [
  { id: 'gpt-4o',            label: 'GPT-4o' },
  { id: 'gpt-4o-mini',       label: 'GPT-4o mini' },
  { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'o3-mini',           label: 'o3-mini' },
  { id: 'o1',                label: 'o1' },
];
