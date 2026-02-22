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
