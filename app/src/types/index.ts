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

/** One item in an ordered message stream: either a text chunk or a tool call. */
export type MessageItem =
  | { type: 'text'; content: string }
  | { type: 'tool'; activity: ToolActivity };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Present on assistant messages that request tool calls */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages (role === 'tool') */
  tool_call_id?: string;
  /** Tool function name — required by some API providers on tool messages */
  name?: string;
  /** Ordered stream items (text + tool calls in arrival order) */
  items?: MessageItem[];
  /** UI-only: the active file path when this message was sent. Stripped before sending to the API. */
  activeFile?: string;
  /** UI-only: base64 data URL of a user-attached image. Merged into multipart content before sending. */
  attachedImage?: string;
  /** UI-only: filename of a user-attached non-image file. Content is injected into the API message. */
  attachedFile?: string;
}

export interface CopilotStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}

// ── Export / Build config ─────────────────────────────────────────────────────

/** What to produce from a set of source files. */
export type ExportFormat =
  | 'pdf'         // markdown → PDF (jsPDF, pure JS)
  | 'canvas-png'  // each canvas file → PNG (via tldraw)
  | 'canvas-pdf'  // each canvas → PDF, one page per slide/frame
  | 'zip'         // bundle matching files into a .zip (JSZip, pure JS)
  | 'custom';     // run an arbitrary shell command (desktop only)

export interface ExportTarget {
  id: string;
  name: string;
  /** Human/AI readable description of what this target produces */
  description?: string;
  /**
   * File extensions to match (without leading dot), e.g. ["md"] or ["tldr.json"].
   * Ignored when `includeFiles` is set.
   */
  include: string[];
  /**
   * Pin specific files (relative paths from workspace root).
   * When non-empty this takes priority over `include` extensions.
   * e.g. ["notes/chapter1.md", "notes/chapter2.md"]
   */
  includeFiles?: string[];
  /**
   * Relative paths to skip even if matched by `include` extensions.
   * e.g. ["drafts/scratch.md"]
   */
  excludeFiles?: string[];
  format: ExportFormat;
  /** Output directory relative to workspace root, e.g. "dist" */
  outputDir: string;
  /**
   * For 'custom' format: shell command run with workspace root as cwd.
   * Placeholders: {{input}} = source file, {{output}} = output path.
   */
  customCommand?: string;
  enabled: boolean;
  /**
   * Merge all matched files into a single output instead of one per file.
   * Supported for: pdf (concatenated markdown), canvas-pdf (all frames across canvases).
   */
  merge?: boolean;
  /** Filename (without extension) for the merged output. Default: 'merged' */
  mergeName?: string;
}

export interface WorkspaceExportConfig {
  targets: ExportTarget[];
}

export interface WorkspaceConfig {
  name: string;
  lastOpenedFile?: string;
  preferredModel?: string;
  /** Up to 5 most-recently opened files (relative paths) */
  recentFiles?: string[];
  /** ISO timestamp of the last auto-save */
  lastEditedAt?: string;
  /** Export / Build targets, persisted in the workspace config file */
  exportConfig?: WorkspaceExportConfig;
}

/** A span of text inserted by the AI and not yet reviewed by the human. */
export interface AIEditMark {
  id: string;
  /** Relative path from workspace root */
  fileRelPath: string;
  /** The exact text that was inserted (for text files: the literal text; for canvas: a label/description) */
  text: string;
  /** AI model that generated it */
  model: string;
  insertedAt: string; // ISO
  reviewed: boolean;
  reviewedAt?: string;
  /** Canvas-only: tldraw shape IDs that were created by this AI action */
  canvasShapeIds?: string[];
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
  /** ISO timestamp of the last file edit — persisted at open time from workspace config */
  lastEditedAt?: string;
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
  /** Whether the model accepts image_url content (false for o-series reasoning models) */
  supportsVision: boolean;
}

/** Application-level settings persisted in localStorage. */
export interface AppSettings {
  theme: 'dark' | 'light';
  /** Editor font size in px */
  editorFontSize: number;
  /** Autosave debounce delay in ms */
  autosaveDelay: number;
  /** Show word count in header */
  showWordCount: boolean;
  /** Enable AI edit highlights by default */
  aiHighlightDefault: boolean;
  /** Show sidebar on startup */
  sidebarOpenDefault: boolean;
  /** Run Prettier on manual save (Cmd/Ctrl+S) for JS/TS/JSON/CSS/HTML */
  formatOnSave: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'dark',
  editorFontSize: 14,
  autosaveDelay: 1000,
  showWordCount: true,
  aiHighlightDefault: true,
  sidebarOpenDefault: true,
  formatOnSave: true,
};

export const APP_SETTINGS_KEY = 'cafezin-app-settings';

export const DEFAULT_MODEL: CopilotModel = 'gpt-4.1';

/** Static fallback shown before the API responds (or if it fails).
 * IDs must match what GitHub Copilot's /models endpoint returns.
 * Keep in sync with: https://docs.github.com/en/copilot/reference/ai-models/supported-models
 * Rule: only keep the latest minor version per model family.
 */
export const FALLBACK_MODELS: CopilotModelInfo[] = [
  // Free / 0× tier
  { id: 'gpt-4o-mini',          name: 'GPT-4o mini',          multiplier: 0,    isPremium: false, vendor: 'OpenAI',    supportsVision: true  },
  { id: 'gpt-4.1-mini',         name: 'GPT-4.1 mini',         multiplier: 0,    isPremium: false, vendor: 'OpenAI',    supportsVision: true  },
  { id: 'claude-haiku-4-5',     name: 'Claude Haiku 4.5',     multiplier: 0,    isPremium: false, vendor: 'Anthropic', supportsVision: true  },
  // Standard / 1× tier
  { id: 'gpt-4.1',              name: 'GPT-4.1',              multiplier: 1,    isPremium: false, vendor: 'OpenAI',    supportsVision: true  },
  { id: 'gpt-4o',               name: 'GPT-4o',               multiplier: 1,    isPremium: false, vendor: 'OpenAI',    supportsVision: true  },
  { id: 'claude-sonnet-4-5',    name: 'Claude Sonnet 4.5',    multiplier: 1,    isPremium: false, vendor: 'Anthropic', supportsVision: true  },
  { id: 'gemini-2.5-pro',       name: 'Gemini 2.5 Pro',       multiplier: 1,    isPremium: false, vendor: 'Google',    supportsVision: true  },
  { id: 'o3-mini',              name: 'o3-mini',              multiplier: 1,    isPremium: false, vendor: 'OpenAI',    supportsVision: false },
  // Premium / >1× tier
  { id: 'claude-opus-4-5',      name: 'Claude Opus 4.5',      multiplier: 3,    isPremium: true,  vendor: 'Anthropic', supportsVision: true  },
  { id: 'o3',                   name: 'o3',                   multiplier: 2,    isPremium: true,  vendor: 'OpenAI',    supportsVision: false },
];

