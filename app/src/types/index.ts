/** A single part in a multipart (vision) message sent to the API. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

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
  /**
   * Message content: a plain string for text-only messages, or a ContentPart[]
   * array for multipart messages (e.g. vision requests with image_url + text).
   */
  content: string | ContentPart[];
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
  /**
   * When set, a "Publish to Vercel" button appears after a successful export.
   * The Vercel token is read from workspace vercelConfig > global cafezin-vercel-token.
   */
  vercelPublish?: {
    /** Vercel project name (e.g. "santacruz" → deploys to santacruz.vercel.app) */
    projectName: string;
  };
  enabled: boolean;
  /**
   * Merge all matched files into a single output instead of one per file.
   * Supported for: pdf (concatenated markdown), canvas-pdf (all frames across canvases).
   */
  merge?: boolean;
  /** Filename (without extension) for the merged output. Default: 'merged' */
  mergeName?: string;

  // ── PDF-only options ────────────────────────────────────────────────────────

  /**
   * Path (workspace-relative) to a .css file whose contents are appended after
   * the default PDF styles, allowing full overrides (fonts, page size, colors…).
   * e.g. "styles/book.css"
   */
  pdfCssFile?: string;
  /**
   * When set, a title page is prepended to the PDF before the content.
   * All fields are optional — omit any you don't want.
   */
  titlePage?: {
    title?: string;
    subtitle?: string;
    author?: string;
    version?: string;
  };
  /**
   * Generate a Table of Contents from H1/H2 headings in the merged content.
   * Only meaningful when merge: true. Inserted after the title page (if any).
   */
  toc?: boolean;
  /**
   * Automatically version the output file instead of overwriting it.
   * - 'timestamp' → appends _YYYY-MM-DD  (e.g. manuscript_2026-02-28.pdf)
   * - 'counter'   → appends _v1, _v2 …   (e.g. manuscript_v3.pdf)
   */
  versionOutput?: 'timestamp' | 'counter';
  /**
   * Pre-export markdown transformations applied to each file's content
   * before it is rendered (merge or single-file).
   */
  preProcess?: {
    /** Strip YAML front-matter blocks (---...---) */
    stripFrontmatter?: boolean;
    /** Remove ### Draft … sections (until next same-level heading or EOF) */
    stripDraftSections?: boolean;
    /** Remove <details>…</details> HTML blocks */
    stripDetails?: boolean;
  };
}

export interface WorkspaceExportConfig {
  targets: ExportTarget[];
}

/** Vercel publish config stored per-workspace (overrides global token) */
export interface VercelWorkspaceConfig {
  /** Override the global Vercel token for this workspace */
  token?: string;
  /** Vercel team/org ID — leave empty for personal accounts */
  teamId?: string;
}

/** A custom action button shown at the bottom of the sidebar. */
export interface SidebarButton {
  id: string;
  /** Short label displayed on the button, e.g. "⊡ Export" */
  label: string;
  /** Shell command run with the workspace root as cwd */
  command: string;
  /** Optional tooltip / description */
  description?: string;
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
  /** Custom action buttons shown at the bottom of the sidebar */
  sidebarButtons?: SidebarButton[];
  /** Relative path of the voice-dump inbox file (default: 00_Inbox/raw_transcripts.md) */
  inboxFile?: string;
  /** Vercel publish config — workspace-level override (token, teamId) */
  vercelConfig?: VercelWorkspaceConfig;
  /**
   * Git branch used for sync. Defaults to the remote's default branch (usually main/master).
   * Set on desktop via Settings → Workspace. Mobile uses this branch when cloning/pulling.
   */
  gitBranch?: string;
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
  /** True when the workspace folder has a git remote configured (origin). */
  hasGit: boolean;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string;
  /** ISO timestamp of the last file edit — persisted at open time from workspace config */
  lastEditedAt?: string;
  /** Cached git status from last open. undefined = unknown (old entry). */
  hasGit?: boolean;
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

