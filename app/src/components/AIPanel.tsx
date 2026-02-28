import { useState, useRef, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { X, Check, CaretRight, CaretUp, CaretDown, ArrowUp, ArrowDown, ArrowClockwise, Warning, Snowflake, Play, Copy, Camera, Paperclip } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { streamCopilotChat, fetchCopilotModels, startDeviceFlow, getStoredOAuthToken, clearOAuthToken, runCopilotAgent, getLastRequestDump, getLastRateLimit, isQuotaError } from '../services/copilot';
import { appendLogEntry, newSessionId } from '../services/copilotLog';
import type { DeviceFlowState } from '../services/copilot';
import { DEFAULT_MODEL, FALLBACK_MODELS } from '../types';
import type { ChatMessage, CopilotModel, CopilotModelInfo, ToolActivity, MessageItem } from '../types';
import { WORKSPACE_TOOLS, buildToolExecutor } from '../utils/workspaceTools';
import { canvasToDataUrl } from '../utils/canvasAI';
import { getMimeType, IMAGE_EXTS } from '../utils/mime';
import { toPng } from 'html-to-image';
import { modelSupportsVision } from '../services/copilot';
import { unlockAll } from '../services/copilotLock';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { readFile, readTextFile, exists } from '@tauri-apps/plugin-fs';
import type { Workspace, WorkspaceExportConfig, FileTreeNode } from '../types';
import type { Editor as TldrawEditor } from 'tldraw';
import './AIPanel.css';

// ── Rate badge helper ────────────────────────────────────────────────────────
// Shows billing tier for all models: free (0×), standard (1×), premium (N×)
function MultiplierBadge({ value }: { value: number }) {
  if (value === 0) return <span className="ai-rate-badge ai-rate-free">free</span>;
  if (value <= 1)  return <span className="ai-rate-badge ai-rate-standard">1×</span>;
  return <span className="ai-rate-badge ai-rate-premium">{value}×</span>;
}

// ── Model picker dropdown ────────────────────────────────────────────────────
interface ModelPickerProps {
  models: CopilotModelInfo[];
  value: CopilotModel;
  onChange: (id: CopilotModel) => void;
  loading: boolean;
  onSignOut?: () => void;
}

function ModelPicker({ models, value, onChange, loading, onSignOut }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Keep a ref in sync so the stable listener always sees the latest value
  // without needing to re-register on every open/close toggle.
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (!openRef.current) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // registers once on mount — openRef always tracks current value

  const current = models.find((m) => m.id === value) ?? { id: value, name: value, multiplier: 1, isPremium: false };

  const free = models.filter((m) => m.multiplier === 0);
  const standard = models.filter((m) => m.multiplier > 0 && m.multiplier <= 1);
  const premium = models.filter((m) => m.multiplier > 1);
  // Only show group labels when 2+ groups are non-empty — if everything lands in
  // one bucket the label adds no information.
  const nonEmptyGroups = [free, standard, premium].filter((g) => g.length > 0).length;
  const showLabels = nonEmptyGroups > 1;

  function renderGroup(label: string, items: CopilotModelInfo[]) {
    if (items.length === 0) return null;
    return (
      <>
        {showLabels && <div className="ai-model-group-label">{label}</div>}
        {items.map((m) => (
          <button
            key={m.id}
            className={`ai-model-option ${m.id === value ? 'selected' : ''}`}
            onClick={() => { onChange(m.id); setOpen(false); }}
          >
            <span className="ai-model-option-name">
              {m.name}
              {m.vendor && <span className="ai-model-option-vendor">{m.vendor}</span>}
            </span>
            <MultiplierBadge value={m.multiplier} />
          </button>
        ))}
      </>
    );
  }

  return (
    <div className="ai-model-picker" ref={ref}>
      <button
        className="ai-model-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Switch model"
        disabled={loading}
      >
        <span className="ai-model-trigger-name">{loading ? '…' : current.name}</span>
        <MultiplierBadge value={current.multiplier} />
        <span className="ai-model-trigger-caret">▾</span>
      </button>

      {open && (
        <div className="ai-model-menu">
          {renderGroup('Free', free)}
          {renderGroup('Standard', standard)}
          {renderGroup('Premium', premium)}
          {onSignOut && (
            <>
              <div className="ai-model-menu-divider" />
              <button
                className="ai-model-signout-btn"
                onClick={() => { setOpen(false); onSignOut(); }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

interface AIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  initialModel?: string;
  onModelChange?: (model: string) => void;
  /** Called when user hits "Insert into document". Receives inserted text and model id. */
  onInsert?: (text: string, model: string) => void;
  documentContext?: string;
  agentContext?: string;
  /** Absolute path of workspace root for shell_run cwd and tool calling */
  workspacePath?: string;
  /** Current workspace object — enables tool calling when provided */
  workspace?: Workspace | null;
  /** Live tldraw editor ref — enables canvas_op tool when a canvas is open */
  canvasEditorRef?: React.RefObject<TldrawEditor | null>;
  /** Called after write_workspace_file so the sidebar can refresh */
  onFileWritten?: (path: string) => void;
  /** Called after write_workspace_file so the parent can record an AI edit mark */
  onMarkRecorded?: (relPath: string, content: string, model: string) => void;
  /** Called after canvas_op so the parent can record an AI canvas mark */
  onCanvasMarkRecorded?: (relPath: string, shapeIds: string[], model: string) => void;
  /** Active canvas/text file path — used to tag canvas AI marks with the right file */
  activeFile?: string;
  /**
   * When provided, the component calls rescanFramesRef.current() after canvas_op
   * to guarantee the slide strip is in sync regardless of store-listener timing.
   */
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  /** Unreviewed AI marks for the currently active file — drives the review bar. */
  aiMarks?: import('../types').AIEditMark[];
  /** Index of the currently focused mark (0-based). */
  aiMarkIndex?: number;
  onAIMarkPrev?: () => void;
  onAIMarkNext?: () => void;
  /** Called to accept/dismiss the mark at the given id. */
  onAIMarkReview?: (id: string) => void;
  /** Export/Build configuration for the workspace — enables the export_workspace agent tool */
  workspaceExportConfig?: WorkspaceExportConfig;
  /** Called when Copilot adds/updates/removes an export target via configure_export_targets */
  onExportConfigChange?: (config: WorkspaceExportConfig) => void;
  /** Inline style override — used by parent to control width via drag */
  style?: React.CSSProperties;
  /** Notifies parent whenever Copilot starts or stops streaming */
  onStreamingChange?: (streaming: boolean) => void;
  /** Ref to the editor-area DOM element — used for content-area screenshots */
  screenshotTargetRef?: React.RefObject<HTMLElement | null>;
  /** Ref to the live HTML preview pane — enables the screenshot_preview tool. */
  webPreviewRef?: React.RefObject<{ getScreenshot: () => Promise<string | null> } | null>;
}

const GROQ_KEY_STORAGE = 'cafezin-groq-key';
function getGroqKey(): string { return localStorage.getItem(GROQ_KEY_STORAGE) ?? ''; }
function saveGroqKey(k: string) { localStorage.setItem(GROQ_KEY_STORAGE, k.trim()); }

// ── Imperative handle exposed to parent ──────────────────────────────────────
export interface AIPanelHandle {
  /** Called by App when Tauri detects a Finder file drop over the AI panel area. */
  receiveFinderFiles(paths: string[]): void;
}

// ── Last-session persistence ─────────────────────────────────────────────
const LAST_SESSION_KEY = 'cafezin-last-session';

interface SavedSession {
  messages: ChatMessage[];
  model: string;
  savedAt: string;
}

function loadSavedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch { return null; }
}

function persistSession(msgs: ChatMessage[], mdl: string) {
  // Only persist user/assistant roles; strip attachedImage (base64) to stay within storage limits
  const slim = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.activeFile  ? { activeFile:  m.activeFile  } : {}),
      ...(m.attachedFile ? { attachedFile: m.attachedFile } : {}),
    } as ChatMessage));
  if (slim.length === 0) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ messages: slim, model: mdl, savedAt: new Date().toISOString() }));
  } catch { /* quota exceeded — skip silently */ }
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Code-block parser ─────────────────────────────────────────────────────

type MsgSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string; code: string };

function parseSegments(raw: string): MsgSegment[] {
  // Create the regex inside the function so each call gets a fresh stateless
  // instance — a module-level /g regex retains lastIndex across calls, which
  // causes skipped matches when parseSegments is called concurrently or rapidly.
  const CODE_BLOCK_RE = /```(\w*)\n?([\s\S]*?)```/g;
  const segments: MsgSegment[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(raw)) !== null) {
    if (match.index > lastIdx) {
      segments.push({ type: 'text', content: raw.slice(lastIdx, match.index) });
    }
    segments.push({ type: 'code', lang: match[1] ?? '', code: match[2] ?? '' });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < raw.length) {
    segments.push({ type: 'text', content: raw.slice(lastIdx) });
  }
  return segments;
}

const RUNNABLE_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'python', 'py']);

interface CodeBlockProps {
  lang: string;
  code: string;
  workspacePath?: string;
}

function CodeBlock({ lang, code, workspacePath }: CodeBlockProps) {
  const [output, setOutput] = useState<{ stdout: string; stderr: string; exit_code: number } | null>(null);
  const [running, setRunning] = useState(false);

  async function runCode() {
    setRunning(true);
    setOutput(null);
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        'shell_run',
        { cmd: code, cwd: workspacePath ?? '.' },
      );
      setOutput(result);
    } catch (err) {
      setOutput({ stdout: '', stderr: String(err), exit_code: -1 });
    } finally {
      setRunning(false);
    }
  }

  const canRun = RUNNABLE_LANGS.has(lang.toLowerCase());

  return (
    <div className="ai-code-block">
      <div className="ai-code-block-header">
        {lang && <span className="ai-code-lang">{lang}</span>}
        {canRun && (
          <button className="ai-code-run-btn" onClick={runCode} disabled={running}>
            {running ? <ArrowClockwise weight="thin" size={13} /> : <><Play weight="thin" size={13} />{' Run'}</>}
          </button>
        )}
      </div>
      <pre className="ai-code-pre"><code>{code}</code></pre>
      {output && (
        <div className={`ai-code-output ${output.exit_code !== 0 ? 'ai-code-output--error' : ''}`}>
          {output.stdout && <pre className="ai-code-stdout">{output.stdout}</pre>}
          {output.stderr && <pre className="ai-code-stderr">{output.stderr}</pre>}
          <span className="ai-code-exit">exit {output.exit_code}</span>
        </div>
      )}
    </div>
  );
}

// ── Agent process display ─────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  list_workspace_files: '⊟',
  read_workspace_file: '◎',
  write_workspace_file: '⊕',
  search_workspace:     '⊙',
  run_command:          '$',
  canvas_op:            '◈',
  list_canvas_shapes:   '⊡',
  canvas_screenshot:    '⬡',
  move_workspace_file:  '⇄',
  delete_workspace_file:'×',
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⚙';
}

/** Human-readable one-liner describing what the tool did. */
function getActionSummary(activity: ToolActivity): string {
  const { name, args } = activity;
  if (activity.kind === 'thinking') return 'Reasoning…';
  const p = (k: string) => String(args[k] ?? '').slice(0, 50);
  switch (name) {
    case 'read_workspace_file':   return `Read "${p('path')}"`;
    case 'write_workspace_file':  return `Wrote "${p('path')}"`;
    case 'search_workspace':      return `Searched for "${p('query')}"`;
    case 'list_workspace_files':  return args.folder ? `Listed files in ${p('folder')}` : 'Listed workspace files';
    case 'run_command': { const cmd = p('command'); return `Ran: ${cmd}${String(args.command ?? '').length > 50 ? '…' : ''}`; }
    case 'canvas_op':             return 'Updated canvas';
    case 'list_canvas_shapes':    return 'Listed canvas shapes';
    case 'canvas_screenshot':     return 'Captured canvas screenshot';
    case 'move_workspace_file':   return `Moved "${p('src')}" → "${p('dst')}"`;
    case 'delete_workspace_file': return `Deleted "${p('path')}"`;
    default: return name.replace(/_/g, ' ');
  }
}

/** Single tool call row — collapses/expands result on click. */
function ToolItem({ activity, defaultOpen = false }: { activity: ToolActivity; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const isDone  = activity.result !== undefined || !!activity.error;
  const isError = !!activity.error;
  const summary = activity.kind === 'thinking'
    ? (activity.thinkingText?.slice(0, 100) ?? 'Reasoning…')
    : getActionSummary(activity);
  const resultText = activity.error ?? activity.result ?? '';

  return (
    <div className={`ai-tool-item ai-tool-item--${isDone ? (isError ? 'error' : 'done') : 'running'}`}>
      <button className="ai-tool-item-row" onClick={() => isDone && setOpen(v => !v)} disabled={!isDone}>
        <span className="ai-tool-item-icon">{getToolIcon(activity.name)}</span>
        <span className="ai-tool-item-summary">{summary}</span>
        <span className="ai-tool-item-status">
          {!isDone && <span className="ai-tool-spinner" />}
          {isDone && !isError && <span className="ai-tool-ok"><Check weight="thin" size={12} /></span>}
          {isError && <span className="ai-tool-err"><X weight="thin" size={12} /></span>}
          {isDone && <span className="ai-tool-chevron">{open ? <CaretUp weight="thin" size={10} /> : <CaretDown weight="thin" size={10} />}</span>}
        </span>
      </button>
      {open && isDone && (
        <pre className={`ai-tool-item-result${isError ? ' error' : ''}`}>{resultText}</pre>
      )}
    </div>
  );
}

/** Collapsible "Process" section shown below completed agent messages. */
function CollapsibleProcess({ items }: { items: MessageItem[] }) {
  const [open, setOpen] = useState(false);
  const toolItems = items.filter(
    (it): it is { type: 'tool'; activity: ToolActivity } => it.type === 'tool'
  );
  if (toolItems.length === 0) return null;
  const hasError = toolItems.some(it => !!it.activity.error);
  return (
    <div className="ai-process-section">
      <button className="ai-process-toggle" onClick={() => setOpen(v => !v)}>
        <span className="ai-process-toggle-icon">{open ? <CaretDown weight="thin" size={12} /> : <CaretRight weight="thin" size={12} />}</span>
        <span className="ai-process-toggle-label">
          {hasError ? <><Warning weight="thin" size={12} />{' '}</> : '✦ '}Process
        </span>
        <span className="ai-process-toggle-count">
          {toolItems.length} {toolItems.length === 1 ? 'step' : 'steps'}
        </span>
      </button>
      {open && (
        <div className="ai-process-body">
          {toolItems.map(it => (
            <ToolItem key={it.activity.callId} activity={it.activity} defaultOpen={false} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compute session-wide edit stats from completed messages. */
function useSessionStats(messages: ChatMessage[]) {
  const writtenPaths = new Set<string>();
  let canvasOps = 0;
  for (const msg of messages) {
    if (!msg.items) continue;
    for (const item of msg.items) {
      if (item.type !== 'tool' || item.activity.error) continue;
      if (item.activity.name === 'write_workspace_file') {
        const p = item.activity.args.path as string | undefined;
        if (p) writtenPaths.add(p);
      }
      if (item.activity.name === 'canvas_op') canvasOps++;
    }
  }
  return { filesCount: writtenPaths.size, canvasOps };
}

// ── Main panel ───────────────────────────────────────────────────────────────

const AIPanel = forwardRef<AIPanelHandle, AIPanelProps>(function AIPanel({
  isOpen,
  onClose,
  initialPrompt = '',
  initialModel,
  onModelChange,
  onInsert,
  documentContext = '',
  agentContext = '',
  workspacePath,
  workspace,
  canvasEditorRef,
  onFileWritten,
  onMarkRecorded,
  onCanvasMarkRecorded,
  activeFile,
  rescanFramesRef,
  aiMarks: aiMarksForFile,
  aiMarkIndex = 0,
  onAIMarkPrev,
  onAIMarkNext,
  onAIMarkReview,
  workspaceExportConfig,
  onExportConfigChange,
  style,
  onStreamingChange,
  screenshotTargetRef,
  webPreviewRef,
}, ref) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [isStreaming, setIsStreaming] = useState(false);
  // Track which message indices have had the Insert action used
  const [insertedMsgs, setInsertedMsgs] = useState<Set<number>>(new Set());
  const [copiedMsgs, setCopiedMsgs] = useState<Set<number>>(new Set());
  // Session-level edit stats derived from completed messages
  const sessionStats = useSessionStats(messages);
  // Ordered live items during agent streaming — text + tool calls interleaved
  const [liveItems, setLiveItemsState] = useState<MessageItem[]>([]);
  const liveItemsRef = useRef<MessageItem[]>([]);
  function setLiveItems(updater: MessageItem[] | ((prev: MessageItem[]) => MessageItem[])) {
    setLiveItemsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      liveItemsRef.current = next;
      return next;
    });
  }

  // Auto-save conversation to localStorage whenever messages change
  useEffect(() => {
    if (messages.length === 0) return;
    persistSession(messages, model);
    setSavedSession(loadSavedSession());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Notify parent when streaming state changes
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<CopilotModel>(initialModel ?? DEFAULT_MODEL);
  // (toolActivities removed — use liveItems)

  // ── Auth state ────────────────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<'checking' | 'unauthenticated' | 'connecting' | 'authenticated'>('checking');
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);

  // Check auth on every open
  useEffect(() => {
    if (!isOpen) return;
    setAuthStatus(getStoredOAuthToken() ? 'authenticated' : 'unauthenticated');
  }, [isOpen]);

  async function handleSignIn() {
    setError(null);
    setAuthStatus('connecting');
    setDeviceFlow(null);
    try {
      await startDeviceFlow((state) => setDeviceFlow(state));
      setAuthStatus('authenticated');
      setDeviceFlow(null);
    } catch (err) {
      setError(String(err));
      setAuthStatus('unauthenticated');
      setDeviceFlow(null);
    }
  }

  function handleSignOut() {
    clearOAuthToken();
    setAuthStatus('unauthenticated');
    setMessages([]);
  }

  // Sync model when workspace changes (initialModel updates)
  useEffect(() => {
    if (initialModel) setModel(initialModel);
  }, [initialModel]);
  // ── Voice state ────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [groqKey, setGroqKey] = useState(() => getGroqKey());
  const [showGroqSetup, setShowGroqSetup] = useState(false);
  const [groqKeyInput, setGroqKeyInput] = useState('');
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [pendingFileRef, setPendingFileRef] = useState<{ name: string; content: string } | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // ── Finder drop handler (called from App.tsx's OS-level drag event) ─────────
  useImperativeHandle(ref, () => ({
    receiveFinderFiles(paths: string[]) {
      const first = paths[0];
      if (!first) return;
      const name = first.split('/').pop() ?? first;
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      readFile(first).then((bytes) => {
        if (IMAGE_EXTS.has(ext)) {
          const mime = getMimeType(ext, 'image/png');
          const b64 = btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(''));
          setPendingImage(`data:${mime};base64,${b64}`);
        } else {
          const content = new TextDecoder().decode(bytes).slice(0, 20000);
          setPendingFileRef({ name, content });
        }
      }).catch((err) => console.error('[AIPanel] receiveFinderFiles:', err));
    },
  }));
  const audioChunksRef = useRef<Blob[]>([]);
  // Tracks whether we've already done a one-time getUserMedia() warm-up so
  // macOS/WKWebView doesn't re-prompt for microphone permission on every click.
  const micPermissionRef = useRef(false);

  const [availableModels, setAvailableModels] = useState<CopilotModelInfo[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsLoadedRef = useRef(false);
  const [quotaInfo, setQuotaInfo] = useState<{ remaining: number | null; limit: number | null; quotaExceeded: boolean }>({ remaining: null, limit: null, quotaExceeded: false });
  // Last-session restore
  const [savedSession, setSavedSession] = useState<SavedSession | null>(() => loadSavedSession());

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vizCanvasRef = useRef<HTMLCanvasElement>(null);
  // ── Interrupt/abort tracking ─────────────────────────────────────────────
  // VS Code-style: user can send a new message mid-run; the current run is
  // interrupted and the new message is sent immediately.
  const abortRef = useRef<AbortController | null>(null);
  // runId increments on every send so stale callbacks from an aborted run
  // don't update React state after the new run has already started.
  const runIdRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);

  // ── Session tracking for the copilot log ─────────────────────────────────
  const sessionIdRef = useRef<string>(newSessionId());
  const sessionStartedAtRef = useRef<string>(new Date().toISOString());

  // Auto-grow textarea: starts at 2 rows (~52px = X), doubles at 4 rows (~100px = 2X), scrolls after ~200px
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  // Frequency visualizer draw loop
  const drawViz = useCallback(() => {
    const canvas = vizCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bufLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barCount = 18;
    const barW = canvas.width / barCount;
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * bufLen * 0.6); // focus on vocal range
      const val = data[idx] / 255;
      const h = Math.max(2, val * canvas.height);
      const alpha = 0.35 + val * 0.65;
      ctx.fillStyle = `hsla(${195 + val * 45}, 75%, 62%, ${alpha})`;
      ctx.fillRect(i * barW + 1, canvas.height - h, barW - 2, h);
    }
    animFrameRef.current = requestAnimationFrame(drawViz);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setInput(initialPrompt);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialPrompt]);

  // Fetch available models: once on first open, and again whenever auth becomes authenticated
  useEffect(() => {
    if (!isOpen) return;
    if (authStatus === 'authenticated') {
      // Always re-fetch when (re-)authenticated — token may have changed
      modelsLoadedRef.current = false;
    }
    if (modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    setModelsLoading(true);
    fetchCopilotModels().then((models) => {
      setAvailableModels(models);
      setModelsLoading(false);
    }).catch(() => {
      // Network / auth error — stop the spinner so the UI isn't stuck.
      setModelsLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveItems]);

  // ── One-time mic permission warm-up ──────────────────────────────────────
  // Call getUserMedia once as soon as a Groq key exists, then immediately
  // stop the tracks.  This registers the permission with macOS/WKWebView so
  // subsequent recording clicks don't re-show the system prompt.
  const warmUpMicPermission = useCallback(async () => {
    if (micPermissionRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // release immediately
      micPermissionRef.current = true;
    } catch { /* denied — will surface on actual record click */ }
  }, []);

  useEffect(() => {
    if (groqKey) warmUpMicPermission();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groqKey]);

  // ── Voice control (MediaRecorder → Groq Whisper) ─────────────────────────
  const startRecording = useCallback(async () => {
    if (!groqKey) { setShowGroqSetup(true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                      : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg'
                      : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(animFrameRef.current);
        analyserRef.current = null;
        // Close the AudioContext to free OS-level audio resources.
        // WebKit caps open AudioContext instances at ~6; without close() each
        // recording session leaks one context until the visualiser silently fails.
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        // clear canvas
        const cv = vizCanvasRef.current;
        if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
        setIsRecording(false);
        setIsTranscribing(true);
        try {
          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          const arrayBuf = await blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuf);
          // Convert to base64
          let binary = '';
          uint8.forEach((b) => (binary += String.fromCharCode(b)));
          const b64 = btoa(binary);
          const transcript = await invoke<string>('transcribe_audio', {
            audioBase64: b64,
            mimeType,
            apiKey: groqKey,
          });
          setInput((prev) => prev ? prev + ' ' + transcript : transcript);
        } catch (err) {
          setError(`Transcription failed: ${err}`);
        } finally {
          setIsTranscribing(false);
        }
      };
      // Wire up audio analyser for visualizer
      try {
        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;
        animFrameRef.current = requestAnimationFrame(drawViz);
      } catch { /* viz not critical */ }
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError(`Microphone access denied: ${err}`);
    }
  }, [groqKey]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  function handleNewChat() {
    // Refresh the saved session snapshot so the CTA shows up-to-date info
    setSavedSession(loadSavedSession());
    setMessages([]);
    setInsertedMsgs(new Set());
    setCopiedMsgs(new Set());
    setError(null);
    setLiveItems([]);
    setIsStreaming(false);
    // Start a fresh log session
    sessionIdRef.current = newSessionId();
    sessionStartedAtRef.current = new Date().toISOString();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleRestoreSession() {
    if (!savedSession) return;
    setMessages(savedSession.messages);
    setModel(savedSession.model as CopilotModel);
    onModelChange?.(savedSession.model);
    setError(null);
    setLiveItems([]);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }

  function handleInsertMessage(idx: number, content: string) {
    onInsert?.(content, model);
    setInsertedMsgs((prev) => new Set([...prev, idx]));
    // Clear the "Inserted" flash after 3 s
    setTimeout(() => setInsertedMsgs((prev) => { const n = new Set(prev); n.delete(idx); return n; }), 3000);
  }

  async function handleCopyMessage(idx: number, content: string) {
    await navigator.clipboard.writeText(content);
    setCopiedMsgs((prev) => new Set([...prev, idx]));
    setTimeout(() => setCopiedMsgs((prev) => { const n = new Set(prev); n.delete(idx); return n; }), 2000);
  }

  const handleMicClick = useCallback(() => {
    if (!groqKey) { setShowGroqSetup(true); return; }
    if (isRecording) stopRecording();
    else startRecording();
  }, [groqKey, isRecording, startRecording, stopRecording]);

  // ── Image drag+drop / paste ───────────────────────────────────
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => { const url = ev.target?.result as string; if (url) setPendingImage(url); };
      reader.readAsDataURL(file);
    } else {
      // Non-image file — read as text and attach as inline context
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        if (content != null) setPendingFileRef({ name: file.name, content: content.slice(0, 20000) });
      };
      reader.readAsText(file);
    }
  }

  async function handleAttachFile() {
    try {
      const selected = await openFileDialog({ multiple: false });
      if (!selected || typeof selected !== 'string') return;
      const name = selected.split('/').pop() ?? selected;
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const bytes = await readFile(selected);
      if (IMAGE_EXTS.has(ext)) {
        const mime = getMimeType(ext, 'image/png');
        const b64 = btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(''));
        setPendingImage(`data:${mime};base64,${b64}`);
      } else {
        const content = new TextDecoder().decode(bytes).slice(0, 20000);
        setPendingFileRef({ name, content });
      }
    } catch (err) {
      console.error('[attach-file]', err);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const imgItem = items.find((it) => it.type.startsWith('image/'));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { const url = ev.target?.result as string; if (url) setPendingImage(url); };
    reader.readAsDataURL(file);
  }

  async function handleTakeScreenshot() {
    if (isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    try {
      let dataUrl: string | null = null;
      // Canvas file — use tldraw's high-quality export
      if (canvasEditorRef?.current) {
        dataUrl = await canvasToDataUrl(canvasEditorRef.current, 0.85);
      } else if (webPreviewRef?.current) {
        // HTML preview — the editor-area contains an <iframe> which html-to-image
        // cannot read (always produces a black rect). Use the WebPreview's own
        // getScreenshot() which reads the iframe's contentDocument directly.
        dataUrl = await webPreviewRef.current.getScreenshot();
      } else if (screenshotTargetRef?.current) {
        // Text editor / other views — capture the editor-area DOM element.
        // Use backgroundColor so Tauri's WebKit doesn't composite over black.
        const bg = getComputedStyle(screenshotTargetRef.current).backgroundColor;
        const resolvedBg = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#1a1a1a';
        dataUrl = await toPng(screenshotTargetRef.current, {
          quality: 0.9,
          backgroundColor: resolvedBg,
          // pixelRatio: 1 avoids a WebKit/Retina bug where scaled canvases
          // are cleared to black before html-to-image can read them.
          pixelRatio: 1,
          filter: (node) => {
            if (node instanceof HTMLElement) {
              if (node.classList.contains('copilot-lock-overlay')) return false;
              if (node.classList.contains('find-replace-bar')) return false;
            }
            return true;
          },
        });
      }
      if (dataUrl) {
        if (!input.trim() && !isStreaming) {
          // One-click: capture + send immediately — no intermediate pending state
          await handleSend(dataUrl);
        } else {
          // User has text in progress — stage so it goes with their message
          setPendingImage(dataUrl);
        }
      }
    } catch (err) {
      console.error('[screenshot]', err);
    } finally {
      setIsCapturingScreenshot(false);
    }
  }

  // ── Persistent memory (.cafezin/memory.md) ────────────────────
  const [memoryContent, setMemoryContent] = useState<string>('');
  useEffect(() => {
    if (!workspacePath) { setMemoryContent(''); return; }
    const memPath = `${workspacePath}/.cafezin/memory.md`;
    exists(memPath).then((found) => {
      if (!found) { setMemoryContent(''); return; }
      readTextFile(memPath).then(setMemoryContent).catch(() => setMemoryContent(''));
    }).catch(() => setMemoryContent(''));
  }, [workspacePath]);

  // ── System prompt ────────────────────────────────────────────
  const hasTools = !!workspace;

  // Flatten the workspace file tree into a compact manifest for the system prompt.
  // Recalculated only when the tree reference changes (file added / removed / renamed).
  const workspaceFileList = useMemo(() => {
    if (!workspace?.fileTree?.length) return '';
    function flattenTree(nodes: FileTreeNode[]): string[] {
      const paths: string[] = [];
      for (const node of nodes) {
        if (node.isDirectory) paths.push(...flattenTree(node.children ?? []));
        else paths.push(node.path);
      }
      return paths;
    }
    const files = flattenTree(workspace.fileTree);
    return `${files.length} file(s) in workspace:\n${files.join('\n')}`;
  }, [workspace?.fileTree]);

  // Map model ID to a one-line capability hint injected at the top of the system prompt.
  function modelHint(id: string): string {
    if (/claude.*opus/i.test(id))   return 'You are running as Claude Opus — exceptionally strong at long-form reasoning, creative writing, and nuanced instruction following.';
    if (/claude.*sonnet/i.test(id)) return 'You are running as Claude Sonnet — excellent at creative writing, editing, and multi-step workspace tasks.';
    if (/claude.*haiku/i.test(id))  return 'You are running as Claude Haiku — fast and efficient; great for quick edits and concise responses.';
    if (/^o[1-9]/i.test(id))        return `You are running as ${id} — a deep-reasoning model. You excel at complex multi-step planning. Note: you cannot process images.`;
    if (/gpt-4o/i.test(id))         return `You are running as ${id} — fast, vision-capable, well-rounded for writing and tool use.`;
    if (/gpt-4\.1/i.test(id))      return `You are running as ${id} — strong instruction following and long-context document work.`;
    if (/gemini/i.test(id))         return `You are running as ${id} — very large context window; great for long documents.`;
    return `You are running as ${id}.`;
  }

  // Rebuilt only when workspace presence, model, agent context, or document context changes.
  const systemPrompt = useMemo<ChatMessage>(() => ({
    role: 'system',
    content: [
      // ── Model identity ────────────────────────────────────────
      modelHint(model),

      // ── What this app is ──────────────────────────────────────
      `You are a helpful AI assistant built into "Cafezin" — a desktop productivity app (Tauri + React, macOS-first) designed for writers, educators, and knowledge workers. It is NOT a code editor; it is built for creative and knowledge-work workflows: writing books, building courses, note-taking, and research.`,

      // ── File types the app supports ───────────────────────────
      `The app supports the following file types in the left sidebar:
  • Markdown (.md) — the primary format. Rendered with live preview (marked library). Full Markdown + YAML frontmatter. Users write, edit, and structure long-form content here.
  • PDF (.pdf) — read-only viewer embedded natively via WebKit. Users open PDFs for reference; AI can discuss their content if given excerpts.
  • Canvas (.tldr.json) — visual/diagram files powered by tldraw v4. Users create mind-maps, flowcharts, mood boards, and brainstorming canvases. These are NOT code — they are freeform visual workspaces.`,

      // ── Canvas / visual editing ───────────────────────────────
      `Canvas files (.tldr.json) are tldraw v4 whiteboards. Rules:
• NEVER write raw JSON to a canvas file — use canvas_op exclusively.
• list_canvas_shapes returns each shape's ID, position, size, and — critically — the "Occupied area" and "Next free row" so you know exactly where existing content ends and where to safely add new content.
• Always read the occupied area before adding shapes to avoid overlaps.
• The canvas_op "commands" string is one JSON object per line (no commas between lines).
• Always include "slide":"<frameId>" on add_* commands when targeting a slide. x/y are then frame-relative (0,0 = frame top-left). Frame size is 1280×720.
• After every canvas build, call canvas_screenshot once to visually verify — fix any overlaps or layout issues before replying.

── LAYOUT PLANNING PROTOCOL ──────────────────────────────────────────────────
BEFORE issuing canvas_op, write a short layout plan in your reply:
  1. List the elements you will place and their purpose.
  2. Pick a layout template (see below) or describe your grid.
  3. State the exact x/y/w/h for each element.
Then emit the canvas_op. This prevents overlaps, centering errors, and wasted rounds.

── LAYOUT TEMPLATES (frame-relative coords, 1280×720 slide) ─────────────────

Title slide
  Title:     add_text  x=100 y=220 w=1080 h=120  color=black
  Subtitle:  add_text  x=100 y=370 w=1080 h=60   color=grey
  Hero image/geo: x=880 y=180 w=320 h=320

Bullet list (up to 5 rows)
  Header:  add_text x=80 y=40  w=1120 h=80
  Row 1:   add_note x=80 y=150 w=1100 h=70  color=yellow
  Row 2:   x=80 y=240  (pitch: +90px per row)
  Row N:   x=80 y=150+(N-1)*90   max 5 rows fits inside 720px

2-column layout
  Header:   x=80  y=40  w=1120 h=70
  Left col:  x=80  y=140 w=520 h=variable  (right edge x=600)
  Right col: x=680 y=140 w=520 h=variable  (right edge x=1200)
  Gap between columns: 80px

3-column layout
  Header:   x=80  y=40  w=1120 h=70
  Col-1:    x=80  y=130 w=340 h=variable  (right x=420)
  Col-2:    x=470 y=130 w=340 h=variable  (right x=810)
  Col-3:    x=860 y=130 w=340 h=variable  (right x=1200)
  Gap: 50px

Timeline (horizontal, 4–6 nodes)
  Spine arrow: x1=80 y1=380 x2=1200 y2=380
  Node N:  add_geo x=80+(N-1)*230 y=280 w=160 h=80  (bottom sits at y=360)
  Label N: add_text x=same y=420 w=160 h=50

Mind-map (hub + up to 6 branches)
  Hub:     add_geo x=540 y=300 w=200 h=120 fill=solid color=blue
  Branches (center of hub is ~640,360):
    Top:         x=540 y=80   w=200 h=80
    Top-right:   x=880 y=140  w=200 h=80
    Right:       x=950 y=320  w=200 h=80
    Bottom-right:x=880 y=500  w=200 h=80
    Bottom:      x=540 y=540  w=200 h=80
    Left:        x=130 y=320  w=200 h=80
  Add arrows from hub center to each branch center.

Kanban (3 columns)
  Col headers: y=40 h=60, Col-L x=80 Col-M x=460 Col-R x=840, w=340 each
  Cards:       y=130 h=80, step +100 per card, same x as column

── COLOR SEMANTICS ───────────────────────────────────────────────────────────
yellow=idea/brainstorm  blue=process/step  green=outcome/done
red=risk/blocker  orange=action/todo  violet=concept/theme
grey=neutral/connector  white=background panel  black=title/header text

── SPACING RULES ─────────────────────────────────────────────────────────────
• Min gap between shapes: 20px
• Row pitch: shape height + 20px minimum
• Never place shape at x<80, x>1200, y<40, y>680 (safe margins)
• Text-heavy content: w≥200; geo labels: w≥120
• NEVER use {"op":"clear"} unless the user explicitly asks to wipe everything`,
      hasTools
        ? `You have access to workspace tools. ALWAYS call the appropriate tool when the user asks about their documents, wants to find/summarize/cross-reference content, or asks you to create/edit files. Never guess at file contents — read them first. When writing a file, always call the write_workspace_file tool — do not output the file as a code block. For small targeted edits to an existing file, prefer patch_workspace_file over rewriting the whole file.`
        : 'No workspace is currently open, so file tools are unavailable.',

      workspaceFileList ? `\nWorkspace files:\n${workspaceFileList}` : '',
      memoryContent ? `\nWorkspace memory (.cafezin/memory.md — persisted facts about this project):\n${memoryContent.slice(0, 4000)}` : '',
      agentContext ? `\nWorkspace context (from AGENT.md):\n${agentContext.slice(0, 3000)}` : '',
      documentContext ? `\nCurrent document context:\n${documentContext.slice(0, 6000)}` : '',

      // ── HTML / interactive demo guidance (injected when an HTML file is active) ───────
      activeFile && (activeFile.endsWith('.html') || activeFile.endsWith('.htm'))
        ? `\n\u2500\u2500 HTML / INTERACTIVE DEMO GUIDANCE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nThe active file is an HTML document rendered live in the preview pane (~900px wide).\n\nLayout & spacing principles:\n\u2022 Prefer relative units: %, rem, vw/vh, clamp() \u2014 avoid px for spacing and font sizes\n\u2022 Use CSS custom properties (--gap, --radius, --color-accent) for consistency\n\u2022 Flexbox or CSS Grid for all multi-element layouts; avoid float / position: absolute for flow\n\u2022 Comfortable reading width: max-width: 800px; margin: 0 auto; padding: 2rem\n\u2022 Interactive demos: always style :hover and :focus states; add transition: 0.2s ease\n\u2022 Buttons/inputs: min-height: 2.5rem; padding: 0.5rem 1.25rem; border-radius: 0.375rem\n\u2022 Section gaps: use row-gap / column-gap on flex/grid containers, never margin hacks\n\u2022 Color contrast: body text on background must be AA-compliant (4.5:1 ratio minimum)\n\nVisual verification workflow:\n1. Write or patch the HTML/CSS file.\n2. Immediately call screenshot_preview to see the rendered result.\n3. Identify any spacing, overflow, alignment, or readability issues.\n4. Call patch_workspace_file to fix them.\n5. Call screenshot_preview again to confirm.\nNever report the demo as done without at least one screenshot_preview call.`
        : '',
    ].filter(Boolean).join('\n\n'),
  }), [hasTools, model, workspaceFileList, memoryContent, agentContext, documentContext, activeFile]);

  // ── Stop: abort without sending a new message ─────────────────
  function handleStop() {
    if (!isStreaming) return;
    const partial = liveItemsRef.current
      .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
      .map(it => it.content).join('');
    if (partial.trim()) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: partial.trim() + '\n\n_[stopped]_' },
      ]);
    }
    abortRef.current?.abort();
    setLiveItems([]);
    setIsStreaming(false);
    unlockAll();
    runIdRef.current++;
  }

  // ── Send (or interrupt-and-send) ──────────────────────────────
  async function handleSend(imageOverride?: string) {
    const textToSend = input.trim();
    // Allow sending with no text if an image is being injected directly or is already staged
    if (!textToSend && !imageOverride && !pendingImage) {
      if (isStreaming) handleStop();
      return;
    }

    // If an agent run is in progress, commit the partial response and abort it.
    if (isStreaming) {
      const partial = liveItemsRef.current
        .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
        .map(it => it.content).join('');
      if (partial.trim()) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: partial.trim() + '\n\n_[interrupted]_' },
        ]);
      }
      abortRef.current?.abort();
      setLiveItems([]);
      // Don't setIsStreaming(false) — the new run starts immediately below.
    }

    // Start new run
    const runId = ++runIdRef.current;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setError(null);
    setLiveItems([]);
    const capturedImage = imageOverride ?? pendingImage;
    const capturedFileRef = pendingFileRef;
    const userMsg: ChatMessage = { role: 'user', content: textToSend || '📸', activeFile: activeFile, ...(capturedImage ? { attachedImage: capturedImage } : {}), ...(capturedFileRef ? { attachedFile: capturedFileRef.name } : {}) };
    setInput('');
    setPendingImage(null);
    setPendingFileRef(null);
    setIsStreaming(true);

    // Build multipart message with canvas screenshot and/or attached image
    const prefix = activeFile ? `[Context: user sent this prompt while "${activeFile.split('/').pop()}" was open]\n` : '';
    const fileContext = capturedFileRef
      ? `[Attached file: "${capturedFileRef.name}"]\n---\n${capturedFileRef.content}\n---\n\n`
      : '';
    const apiText = `${fileContext}${prefix}${textToSend || 'Describe what you see in this screenshot and note any issues.'}`;
    let finalUserMsg: ChatMessage = (activeFile || capturedFileRef)
      ? { role: 'user', content: apiText }
      : userMsg;
    if (modelSupportsVision(model)) {
      const parts: any[] = [];
      if (canvasEditorRef?.current) {
        const url = await canvasToDataUrl(canvasEditorRef.current, 0.5);
        if (url) {
          parts.push({ type: 'text', text: 'Current canvas state (before any edits) — study this carefully before making changes:' });
          parts.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (capturedImage) {
        parts.push({ type: 'text', text: 'Attached image:' });
        parts.push({ type: 'image_url', image_url: { url: capturedImage } });
      }
      if (parts.length > 0) {
        parts.push({ type: 'text', text: apiText });
        finalUserMsg = { role: 'user', content: parts as any };
      }
    }

    const newMessages: ChatMessage[] = [...messages, finalUserMsg];
    setMessages((prev) => [...prev, userMsg]); // UI shows plain-text version

    let fullResponse = '';

    const onChunk = (chunk: string) => {
      if (runIdRef.current !== runId) return;
      fullResponse += chunk;
      setLiveItems(prev => {
        const last = prev[prev.length - 1];
        if (last?.type === 'text') {
          return [...prev.slice(0, -1), { type: 'text', content: last.content + chunk }];
        }
        return [...prev, { type: 'text', content: chunk }];
      });
    };

    const onDone = () => {
      if (runIdRef.current !== runId) return;
      const capturedItems = liveItemsRef.current;
      const toolCount = capturedItems.filter(it => it.type === 'tool').length;
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: fullResponse,
          items: capturedItems.length > 0 ? capturedItems : undefined,
        },
      ]);
      setLiveItems([]);
      setIsStreaming(false);
      unlockAll();
      // Refresh rate-limit / quota snapshot after the response completes
      setQuotaInfo(getLastRateLimit());
      if (workspacePath) {
        void appendLogEntry(workspacePath, {
          sessionId: sessionIdRef.current,
          sessionStartedAt: sessionStartedAtRef.current,
          timestamp: new Date().toISOString(),
          model,
          userMessage: userMsg.content,
          aiResponse: fullResponse,
          ...(toolCount > 0 ? { toolCalls: toolCount } : {}),
        });
      }
    };

    const onError = (err: Error) => {
      if (runIdRef.current !== runId) return;

      // Preserve whatever was already streamed — commit it as an assistant
      // message so the user can see it, then show the error below it.
      const partial = liveItemsRef.current
        .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
        .map((it) => it.content)
        .join('');
      if (partial.trim()) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: partial.trim(),
            items: liveItemsRef.current.length > 0 ? liveItemsRef.current : undefined,
          },
        ]);
      }

      if (err.message === 'NOT_AUTHENTICATED') setAuthStatus('unauthenticated');
      else setError(err.message);
      setLiveItems([]);
      setIsStreaming(false);
      unlockAll();
      // Capture quota state (quota error sets quotaExceeded=true in copilot.ts)
      setQuotaInfo(getLastRateLimit());
    };

    const apiMessages = [systemPrompt, ...newMessages];

    if (workspace) {
      const executor = buildToolExecutor(
        workspace.path,
        canvasEditorRef ?? { current: null },
        onFileWritten,
        (relPath, content) => onMarkRecorded?.(relPath, content, model),
        (shapeIds) => {
          // Record AI mark for canvas edits
          if (shapeIds.length > 0 && activeFile) {
            onCanvasMarkRecorded?.(activeFile, shapeIds, model);
          }
          // Force-sync slide strip immediately after canvas_op (no debounce wait)
          rescanFramesRef?.current?.();
        },
        activeFile,
        workspaceExportConfig,
        onExportConfigChange,
        setMemoryContent,
        webPreviewRef as { current: { getScreenshot: () => Promise<string | null> } | null } | undefined,
      );
      // Only expose canvas tools when a canvas is actually open — prevents
      // the model from attempting canvas ops when no .tldr.json is active.
      const CANVAS_TOOL_NAMES = new Set(['list_canvas_shapes', 'canvas_op', 'canvas_screenshot', 'add_canvas_image']);
      const hasCanvas = !!(canvasEditorRef?.current);
      const isMobilePlatform = import.meta.env.VITE_TAURI_MOBILE === 'true';
      const activeTools = WORKSPACE_TOOLS.filter((t) => {
        if (!hasCanvas && CANVAS_TOOL_NAMES.has(t.function.name)) return false;
        if (isMobilePlatform && t.function.name === 'run_command') return false;
        return true;
      });

      await runCopilotAgent(
        apiMessages,
        activeTools,
        executor,
        onChunk,
        (activity) => {
          if (runIdRef.current !== runId) return;
          setLiveItems(prev => {
            const pIdx = prev.findIndex(it => it.type === 'tool' && (it as any).activity?.callId === activity.callId);
            if (pIdx >= 0) {
              const next = [...prev]; next[pIdx] = { type: 'tool', activity }; return next;
            }
            return [...prev, { type: 'tool', activity }];
          });
        },
        onDone,
        onError,
        model,
        workspacePath,
        sessionIdRef.current,
        signal,
      );
    } else {
      await streamCopilotChat(apiMessages, onChunk, onDone, onError, model, undefined, signal);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') {
      if (isStreaming) handleStop();
      else onClose();
    }
  }

  if (!isOpen) return null;

  // ── Auth screens ───────────────────────────────────────────────────────────
  if (authStatus === 'unauthenticated' || authStatus === 'connecting') {
    return (
      <div className="ai-panel" data-panel="ai" style={style}>
        <div className="ai-panel-header">
          <span className="ai-panel-title"><Snowflake weight="thin" size={14} /> Copilot</span>
        </div>
        <div className="ai-auth-screen">
          <div className="ai-auth-icon"><Snowflake weight="thin" size={48} /></div>
          <div className="ai-auth-title">Connect GitHub Copilot</div>
          {!deviceFlow ? (
            <>
              <p className="ai-auth-desc">
                Sign in with GitHub to use Copilot in this app.
                {error && <><br /><span className="ai-auth-error">{error}</span></>}
              </p>
              <button
                className="ai-auth-btn"
                onClick={handleSignIn}
                disabled={authStatus === 'connecting'}
              >
                {authStatus === 'connecting' ? 'Starting…' : 'Sign in with GitHub'}
              </button>
            </>
          ) : (
            <>
              <p className="ai-auth-desc">Open the link below and enter your code:</p>
              <code className="ai-auth-code">{deviceFlow.userCode}</code>
              <button
                className="ai-auth-btn ai-auth-btn--link"
                onClick={() => openUrl(deviceFlow.verificationUri).catch(() =>
                  window.open(deviceFlow.verificationUri, '_blank')
                )}
              >
                Open github.com/login/device ↗
              </button>
              <p className="ai-auth-waiting"><ArrowClockwise weight="thin" size={13} /> Waiting for authorization…</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel" data-panel="ai" style={style}>
      {/* Header */}
      <div className="ai-panel-header">
        <span className="ai-panel-title">✦ Copilot</span>
        <div className="ai-panel-header-right">
          <ModelPicker
            models={availableModels}
            value={model}
            onChange={(id) => { setModel(id); onModelChange?.(id); }}
            loading={modelsLoading}
            onSignOut={handleSignOut}
          />
        </div>
      </div>

      {/* Quota usage bar — only visible when rate-limit data is available */}
      {quotaInfo.limit !== null && quotaInfo.remaining !== null && !quotaInfo.quotaExceeded && (() => {
        const pct = Math.max(0, Math.min(100, (quotaInfo.remaining / quotaInfo.limit!) * 100));
        return (
          <div className="ai-quota-bar-wrap" data-low={pct < 30 ? 'true' : undefined} title={`${quotaInfo.remaining} / ${quotaInfo.limit} requests remaining`}>
            <div className="ai-quota-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        );
      })()}

      {/* Messages */}
      {/* AI edit review bar — shown when the active file has unreviewed marks */}
      {aiMarksForFile && aiMarksForFile.length > 0 && (
        <div className="ai-review-bar">
          <span className="ai-review-bar-icon">✦</span>
          <span className="ai-review-bar-label">{aiMarksForFile.length} AI edit{aiMarksForFile.length !== 1 ? 's' : ''}</span>
          <button
            className="ai-review-bar-btn"
            onClick={onAIMarkPrev}
            disabled={aiMarksForFile.length < 2}
            title="Previous AI edit"
          >‹</button>
          <span className="ai-review-bar-count">{aiMarkIndex + 1}/{aiMarksForFile.length}</span>
          <button
            className="ai-review-bar-btn"
            onClick={onAIMarkNext}
            disabled={aiMarksForFile.length < 2}
            title="Next AI edit"
          >›</button>
          <button
            className="ai-review-bar-btn ai-review-bar-btn--accept"
            onClick={() => onAIMarkReview?.(aiMarksForFile[aiMarkIndex]?.id)}
            title="Mark as reviewed"
          >✓ Accept</button>
        </div>
      )}

      <div className="ai-messages">
        {/* Session stats bar */}
        {(sessionStats.filesCount > 0 || sessionStats.canvasOps > 0) && (
          <div className="ai-session-stats">
            <span className="ai-session-stats-label">Session</span>
            {sessionStats.filesCount > 0 && (
              <span className="ai-session-stat-chip">
                <span className="ai-stat-chip-icon">⊕</span>
                {sessionStats.filesCount} {sessionStats.filesCount === 1 ? 'file' : 'files'} edited
              </span>
            )}
            {sessionStats.canvasOps > 0 && (
              <span className="ai-session-stat-chip">
                <span className="ai-stat-chip-icon">◈</span>
                {sessionStats.canvasOps} canvas {sessionStats.canvasOps === 1 ? 'op' : 'ops'}
              </span>
            )}
          </div>
        )}

        {messages.length === 0 && !isStreaming && (
          <div className="ai-empty-state">
            Ask Copilot anything about your document.
            <br />
            <span className="ai-hint">Enter to send · Shift+Enter new line · Esc to close</span>
            {agentContext && (
              <div className="ai-agent-notice">✦ AGENT.md loaded as context</div>
            )}
            {savedSession && savedSession.messages.length > 0 && (
              <button className="ai-restore-session-btn" onClick={handleRestoreSession}>
                <span className="ai-restore-session-label">↩ Restore last conversation</span>
                <span className="ai-restore-session-meta">
                  {savedSession.messages.filter((m) => m.role === 'user').length} message{savedSession.messages.filter((m) => m.role === 'user').length !== 1 ? 's' : ''} · {fmtRelative(savedSession.savedAt)}
                </span>
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-message ai-message--${msg.role}`}>
            <div className="ai-message-label">{msg.role === 'user' ? 'You' : '✦ Copilot'}</div>
            <div className="ai-message-content">
              {msg.role === 'assistant'
                ? parseSegments(msg.content).map((seg, si) =>
                    seg.type === 'code'
                      ? <CodeBlock key={si} lang={seg.lang} code={seg.code} workspacePath={workspacePath} />
                      : <span key={si} style={{ whiteSpace: 'pre-wrap' }}>{seg.content}</span>
                  )
                : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
              }
            </div>
            {msg.role === 'user' && msg.attachedImage && (
              <img src={msg.attachedImage} className="ai-message-img" alt="attached" />
            )}
            {msg.role === 'user' && msg.attachedFile && (
              <div className="ai-message-file-pill">
                <span className="ai-message-file-pill-icon">📄</span>
                <span className="ai-message-file-pill-name">{msg.attachedFile}</span>
              </div>
            )}
            {msg.role === 'user' && msg.activeFile && (
              <div className="ai-message-file-tag">📄 {msg.activeFile.split('/').pop()}</div>
            )}
            {msg.role === 'assistant' && msg.items && (
              <CollapsibleProcess items={msg.items} />
            )}

            {/* Action row for completed assistant messages */}
            {msg.role === 'assistant' && msg.content && (
              <div className="ai-msg-actions">
                {onInsert && (
                  <button
                    className={`ai-msg-action-btn ${insertedMsgs.has(i) ? 'ai-msg-action-btn--done' : ''}`}
                    onClick={() => handleInsertMessage(i, msg.content)}
                    title="Insert into document and track as AI edit"
                  >
                    {insertedMsgs.has(i) ? <><Check weight="thin" size={12} />{' Inserted'}</> : <><ArrowDown weight="thin" size={12} />{' Insert'}</>}
                  </button>
                )}
                <button
                  className={`ai-msg-action-btn ${copiedMsgs.has(i) ? 'ai-msg-action-btn--done' : ''}`}
                  onClick={() => handleCopyMessage(i, msg.content)}
                  title="Copy to clipboard"
                >
                  {copiedMsgs.has(i) ? <><Check weight="thin" size={12} />{' Copied'}</> : <><Copy weight="thin" size={12} />{' Copy'}</>}
                </button>
              </div>
            )}

          </div>
        ))}

        {isStreaming && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-label">✦ Copilot</div>
            <div className="ai-message-content">
              {liveItems.length > 0
                ? <>
                    {liveItems.map((item, idx) =>
                      item.type === 'text'
                        ? <span key={idx} style={{ whiteSpace: 'pre-wrap' }}>{item.content}</span>
                        : <ToolItem key={item.activity.callId} activity={item.activity} />
                    )}
                    <div className="ai-thinking-indicator ai-thinking-indicator--inline">
                      <span className="ai-thinking-dot" />
                      <span className="ai-thinking-dot" />
                      <span className="ai-thinking-dot" />
                    </div>
                  </>
                : <div className="ai-thinking-indicator">
                    <span className="ai-thinking-dot" />
                    <span className="ai-thinking-dot" />
                    <span className="ai-thinking-dot" />
                  </div>
              }
            </div>
          </div>
        )}

        {error && (
          <div className="ai-error">
            <span><Warning weight="thin" size={14} /> {error}</span>
            {error.includes('VITE_GITHUB_TOKEN') && (
              <span> — Add your token to <code>app/.env</code></span>
            )}
            {(isQuotaError(error) || quotaInfo.quotaExceeded) && (
              <button
                className="ai-quota-manage-btn"
                onClick={() => openUrl('https://github.com/github-copilot/usage').catch(() => window.open('https://github.com/github-copilot/usage', '_blank'))}
              >
                Manage paid tokens ↗
              </button>
            )}
            <button
              className="ai-error-copy"
              onClick={() => {
                const dump = getLastRequestDump();
                const errorPart = error ?? '';
                navigator.clipboard.writeText(
                  `ERROR:\n${errorPart}\n\nLAST REQUEST DUMP:\n${dump}`
                );
              }}
              title="Copy error + full last request to clipboard"
            >Copy logs</button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Groq key setup overlay */}
      {showGroqSetup && (
        <div className="ai-groq-overlay">
          <div className="ai-groq-card">
            <div className="ai-groq-title">🎙 Enable Voice Input</div>
            <p className="ai-groq-desc">
              Voice uses <strong>Groq Whisper</strong> for fast, free transcription.
              Get a free API key at <button className="ai-groq-link" onClick={() => openUrl('https://console.groq.com/keys').catch(() => window.open('https://console.groq.com/keys', '_blank'))}>console.groq.com/keys ↗</button>
            </p>
            <input
              className="ai-groq-input"
              type="password"
              placeholder="gsk_…"
              value={groqKeyInput}
              onChange={(e) => setGroqKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && groqKeyInput.trim()) {
                  saveGroqKey(groqKeyInput);
                  setGroqKey(groqKeyInput.trim());
                  setShowGroqSetup(false);
                  setGroqKeyInput('');
                  warmUpMicPermission();
                }
              }}
              autoFocus
            />
            <div className="ai-groq-actions">
              <button className="ai-auth-btn" disabled={!groqKeyInput.trim()} onClick={() => {
                saveGroqKey(groqKeyInput);
                setGroqKey(groqKeyInput.trim());
                setShowGroqSetup(false);
                setGroqKeyInput('');
                warmUpMicPermission();
              }}>Save key</button>
              <button className="ai-btn-ghost" onClick={() => { setShowGroqSetup(false); setGroqKeyInput(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div
        className={`ai-input-row${isDragOver ? ' drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {pendingImage && (
          <div className="ai-img-preview">
            <img src={pendingImage} alt="attached" />
            <button className="ai-img-remove" onClick={() => setPendingImage(null)} title="Remove image"><X weight="thin" size={12} /></button>
            {!modelSupportsVision(model) && (
              <span className="ai-no-vision-warning"><Warning weight="thin" size={12} /> Model doesn't support images</span>
            )}
          </div>
        )}
        {pendingFileRef && (
          <div className="ai-file-chip">
            <span className="ai-file-chip-icon">📄</span>
            <span className="ai-file-chip-name" title={pendingFileRef.name}>{pendingFileRef.name}</span>
            <span className="ai-file-chip-size">{pendingFileRef.content.length > 1000 ? `${Math.round(pendingFileRef.content.length / 1000)}k chars` : `${pendingFileRef.content.length} chars`}</span>
            <button className="ai-img-remove" onClick={() => setPendingFileRef(null)} title="Remove file"><X weight="thin" size={12} /></button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isStreaming ? 'Type to interrupt…' : isDragOver ? 'Drop image or file here…' : 'Ask Copilot…'}
          className="ai-input"
        />
        <div className="ai-input-actions">
          <canvas
            ref={vizCanvasRef}
            className={`ai-viz-canvas ${isRecording ? 'active' : ''}`}
            width={72}
            height={28}
          />
          {/* Screenshot button — captures visible content area into prompt */}
          {screenshotTargetRef && (
            <button
              className={`ai-btn-screenshot ${isCapturingScreenshot ? 'capturing' : ''}`}
              onClick={handleTakeScreenshot}
              disabled={isCapturingScreenshot}
              title={canvasEditorRef?.current ? 'Screenshot canvas → send to Copilot' : 'Screenshot current view → send to Copilot'}
              type="button"
            >
              <Camera weight="thin" size={14} />
            </button>
          )}
          {/* Attach file button */}
          <button
            className="ai-btn-attach"
            onClick={handleAttachFile}
            title="Attach file (image or document)"
            type="button"
            disabled={isStreaming}
          >
            <Paperclip weight="thin" size={14} />
          </button>
          <button
            className={`ai-btn-mic ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
            onClick={handleMicClick}
            title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing…' : groqKey ? 'Click to speak' : 'Set up voice input'}
            type="button"
            disabled={isTranscribing}
          >
            {isTranscribing
              ? <span className="ai-mic-spinner" />
              : isRecording
              ? (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="1" width="9" height="9" rx="1.5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="4.5" y="0.7" width="5" height="7.3" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M2 7A5 5 0 0 0 12 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <line x1="7" y1="13" x2="7" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              )
            }
          </button>
          <button
            onClick={handleNewChat}
            className="ai-btn-new-chat"
            title="New chat"
            disabled={isStreaming}
          >↺</button>
          {/* Send / Interrupt / Stop button */}
          {isStreaming && !input.trim() ? (
            <button
              onClick={handleStop}
              className="ai-btn-send ai-btn-send--stop"
              title="Stop (Esc)"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                <rect x="1" y="1" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() && !pendingImage}
              className={`ai-btn-send${isStreaming ? ' ai-btn-send--interrupt' : ''}`}
              title={isStreaming ? 'Interrupt and send (Enter)' : 'Send (Enter)'}
            >
              {isStreaming
                ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <polygon points="6,1 11,11 1,11" />
                  </svg>
                : <ArrowUp weight="thin" size={16} />
              }
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

export default AIPanel;
