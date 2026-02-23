import { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { streamCopilotChat, fetchCopilotModels, startDeviceFlow, getStoredOAuthToken, clearOAuthToken, runCopilotAgent } from '../services/copilot';
import { appendLogEntry, newSessionId } from '../services/copilotLog';
import type { DeviceFlowState } from '../services/copilot';
import { DEFAULT_MODEL, FALLBACK_MODELS } from '../types';
import type { ChatMessage, CopilotModel, CopilotModelInfo, ToolActivity } from '../types';
import { WORKSPACE_TOOLS, buildToolExecutor } from '../utils/workspaceTools';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Workspace } from '../types';
import type { Editor as TldrawEditor } from 'tldraw';
import './AIPanel.css';

// ── Rate badge helper ────────────────────────────────────────────────────────
function MultiplierBadge({ value }: { value: number }) {
  const label = value === 0 ? 'free' : `${value}×`;
  const cls =
    value === 0
      ? 'ai-rate-badge ai-rate-free'
      : value <= 1
      ? 'ai-rate-badge ai-rate-standard'
      : 'ai-rate-badge ai-rate-premium';
  return <span className={cls}>{label}</span>;
}

// ── Model picker dropdown ────────────────────────────────────────────────────
interface ModelPickerProps {
  models: CopilotModelInfo[];
  value: CopilotModel;
  onChange: (id: CopilotModel) => void;
  loading: boolean;
}

function ModelPicker({ models, value, onChange, loading }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const current = models.find((m) => m.id === value) ?? { id: value, name: value, multiplier: 1, isPremium: false };

  const free = models.filter((m) => m.multiplier === 0);
  const standard = models.filter((m) => m.multiplier > 0 && m.multiplier <= 1);
  const premium = models.filter((m) => m.multiplier > 1);

  function renderGroup(label: string, items: CopilotModelInfo[]) {
    if (items.length === 0) return null;
    return (
      <>
        <div className="ai-model-group-label">{label}</div>
        {items.map((m) => (
          <button
            key={m.id}
            className={`ai-model-option ${m.id === value ? 'selected' : ''}`}
            onClick={() => { onChange(m.id); setOpen(false); }}
          >
            <span className="ai-model-option-name">{m.name}</span>
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
  /** Inline style override — used by parent to control width via drag */
  style?: React.CSSProperties;
  /** Notifies parent whenever Copilot starts or stops streaming */
  onStreamingChange?: (streaming: boolean) => void;
}

const GROQ_KEY_STORAGE = 'custom-tool-groq-key';
function getGroqKey(): string { return localStorage.getItem(GROQ_KEY_STORAGE) ?? ''; }
function saveGroqKey(k: string) { localStorage.setItem(GROQ_KEY_STORAGE, k.trim()); }

// ── Code-block parser ─────────────────────────────────────────────────────
const CODE_BLOCK_RE = /```(\w*)\n?([\s\S]*?)```/g;

type MsgSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string; code: string };

function parseSegments(raw: string): MsgSegment[] {
  const segments: MsgSegment[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  CODE_BLOCK_RE.lastIndex = 0;
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
            {running ? '⏳' : '▶ Run'}
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
  list_workspace_files: '📁',
  read_workspace_file: '📄',
  write_workspace_file: '✏️',
  search_workspace: '🔍',
  shell_run: '⚡',
  canvas_op: '🎨',
  list_canvas_shapes: '🖼️',
  canvas_screenshot: '📷',
  move_workspace_file: '↔',
  delete_workspace_file: '🗑',
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧';
}

function formatArgsSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      const val = raw.length > 50 ? raw.slice(0, 50) + '…' : raw;
      return `${k}: ${val}`;
    })
    .join('\n');
}

interface ToolCallCardProps {
  activity: ToolActivity;
}

function ToolCallCard({ activity }: ToolCallCardProps) {
  const [showResult, setShowResult] = useState(false);
  const isDone = activity.result !== undefined || !!activity.error;
  const isError = !!activity.error;
  const isRunning = !isDone;

  const argsText = formatArgsSummary(activity.args);
  const resultFull = activity.error ?? activity.result ?? '';
  const resultPreview = resultFull.split('\n')[0]?.slice(0, 80) ?? '';
  const resultHasMore = resultFull.length > resultPreview.length;

  const statusClass = isRunning ? 'running' : isError ? 'error' : 'done';

  return (
    <div className={`ai-tool-card ai-tool-card--${statusClass}`}>
      <div className="ai-tool-card-header">
        <span className="ai-tool-card-icon">{getToolIcon(activity.name)}</span>
        <span className="ai-tool-card-name">{activity.name}</span>
        <span className="ai-tool-card-status-badge">
          {isRunning
            ? <span className="ai-tool-spinner" />
            : isError
            ? <span className="ai-tool-status-err">✕</span>
            : <span className="ai-tool-status-ok">✓</span>}
        </span>
      </div>
      {argsText && (
        <pre className="ai-tool-card-args">{argsText}</pre>
      )}
      {isDone && (
        <button
          className={`ai-tool-card-result-toggle ${isError ? 'error' : ''}`}
          onClick={() => setShowResult((v) => !v)}
        >
          <span className="ai-tool-result-prefix">{isError ? '⚠ Error' : '→'}</span>
          <span className="ai-tool-result-preview">{resultPreview}</span>
          {resultHasMore && (
            <span className="ai-tool-result-chevron">{showResult ? '▲' : '▼'}</span>
          )}
        </button>
      )}
      {showResult && isDone && (
        <pre className={`ai-tool-card-result-full${isError ? ' error' : ''}`}>{resultFull}</pre>
      )}
    </div>
  );
}

function AgentProcess({ activities }: { activities: ToolActivity[] }) {
  if (activities.length === 0) return null;
  return (
    <div className="ai-agent-process">
      <div className="ai-agent-process-header">
        <span className="ai-agent-process-icon">✦</span>
        <span className="ai-agent-process-label">Agent process</span>
        <span className="ai-agent-process-count">{activities.length} call{activities.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="ai-agent-process-body">
        {activities.map((activity) =>
          <ToolCallCard key={activity.callId} activity={activity} />
        )}
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function AIPanel({
  isOpen,
  onClose,
  initialPrompt = '',
  initialModel,
  onModelChange,
  onInsert: _onInsert,
  documentContext = '',
  agentContext = '',
  workspacePath,
  workspace,
  canvasEditorRef,
  onFileWritten,
  onMarkRecorded,
  style,
  onStreamingChange,
}: AIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');

  // Notify parent when streaming state changes
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<CopilotModel>(initialModel ?? DEFAULT_MODEL);
  // Active tool calls during the current agent run
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);

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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const [availableModels, setAvailableModels] = useState<CopilotModelInfo[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsLoadedRef = useRef(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vizCanvasRef = useRef<HTMLCanvasElement>(null);
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

  // Fetch available models once on first open
  useEffect(() => {
    if (!isOpen || modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    setModelsLoading(true);
    fetchCopilotModels().then((models) => {
      setAvailableModels(models);
      setModelsLoading(false);
    });
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

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
    setMessages([]);
    setError(null);
    setStreamingText('');
    setIsStreaming(false);
    // Start a fresh log session
    sessionIdRef.current = newSessionId();
    sessionStartedAtRef.current = new Date().toISOString();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  const handleMicClick = useCallback(() => {
    if (!groqKey) { setShowGroqSetup(true); return; }
    if (isRecording) stopRecording();
    else startRecording();
  }, [groqKey, isRecording, startRecording, stopRecording]);

  // ── System prompt ────────────────────────────────────────────
  const hasTools = !!workspace;
  const systemPrompt: ChatMessage = {
    role: 'system',
    content: [
      // ── What this app is ──────────────────────────────────────
      `You are a helpful AI assistant built into "custom-tool" — a desktop productivity app (Tauri + React, macOS-first) designed for writers, educators, and knowledge workers. It is NOT a code editor; it is built for creative and knowledge-work workflows: writing books, building courses, note-taking, and research.`,

      // ── File types the app supports ───────────────────────────
      `The app supports the following file types in the left sidebar:
  • Markdown (.md) — the primary format. Rendered with live preview (marked library). Full Markdown + YAML frontmatter. Users write, edit, and structure long-form content here.
  • PDF (.pdf) — read-only viewer embedded natively via WebKit. Users open PDFs for reference; AI can discuss their content if given excerpts.
  • Canvas (.tldr.json) — visual/diagram files powered by tldraw v4. Users create mind-maps, flowcharts, mood boards, and brainstorming canvases. These are NOT code — they are freeform visual workspaces.`,

      // ── Canvas / visual editing ───────────────────────────────
      `Canvas files (.tldr.json) work differently from text files:
• A canvas is a tldraw v4 whiteboard. The user sees a freeform 2-D surface with sticky notes, labels, boxes, and arrows.
• NEVER edit a canvas by writing raw text or JSON to a file. Instead, call the canvas_op tool.
• ALWAYS call list_canvas_shapes first when modifying an existing canvas — you need the shape IDs.
• canvas_op takes a "commands" string — one JSON object per line:
    {"op":"add_note","text":"Idea","x":100,"y":100,"color":"yellow"}
    {"op":"add_text","text":"Title","x":100,"y":60,"color":"black"}
    {"op":"add_geo","geo":"rectangle","text":"Box","x":100,"y":100,"w":200,"h":120,"color":"blue","fill":"solid"}
    {"op":"add_arrow","x1":100,"y1":150,"x2":400,"y2":150,"label":"leads to","color":"grey"}
    {"op":"move","id":"abc123","x":300,"y":400}
    {"op":"update","id":"abc123","text":"New text"}
    {"op":"delete","id":"abc123"}
    {"op":"clear"}
• Design mindfully: use consistent spacing so shapes don't overlap. Color-code by meaning (yellow=idea, blue=process, green=outcome, red=risk).
• For large diagrams, place a header add_text first, then build rows of boxes, then add arrows last.
• After you finish all canvas_op calls, ALWAYS call canvas_screenshot once to visually verify your work. Look for: overlapping shapes, wrong colors, missing labels, awkward spacing. Fix any issues before replying.
• canvas_screenshot is your only way to see what the canvas actually looks like — treat it like a final review step, not an optional extra.
• When the user asks you to build a mind-map, diagram, or visual layout, use canvas_op — never substitute a markdown list or table.`,
      hasTools
        ? `You have access to workspace tools. ALWAYS call the appropriate tool when the user asks about their documents, wants to find/summarize/cross-reference content, or asks you to create/edit files. Never guess at file contents — read them first. When writing a file, always call the write_workspace_file tool — do not output the file as a code block.`
        : 'No workspace is currently open, so file tools are unavailable.',

      agentContext ? `\nWorkspace context (from AGENT.md):\n${agentContext.slice(0, 3000)}` : '',
      // Canvas gets a larger window since it's structured data, not prose
      documentContext ? `\nCurrent document context:\n${documentContext.slice(0, 6000)}` : '',
    ].filter(Boolean).join('\n\n'),
  };

  // ── Send ─────────────────────────────────────────────────────
  async function handleSend() {
    if (!input.trim() || isStreaming) return;
    setError(null);
    setToolActivities([]);

    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages: ChatMessage[] = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsStreaming(true);
    setStreamingText('');

    let fullResponse = '';
    // Accumulate activities outside React state so onDone can snapshot them
    let capturedActivities: ToolActivity[] = [];

    const onChunk = (chunk: string) => { fullResponse += chunk; setStreamingText(fullResponse); };
    const onDone = () => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: fullResponse,
          toolActivities: capturedActivities.length > 0 ? capturedActivities : undefined,
        },
      ]);
      setStreamingText('');
      setToolActivities([]);
      setIsStreaming(false);
      // ── Persist to copilot log ──────────────────────────────
      if (workspacePath) {
        appendLogEntry(workspacePath, {
          sessionId: sessionIdRef.current,
          sessionStartedAt: sessionStartedAtRef.current,
          timestamp: new Date().toISOString(),
          model,
          userMessage: userMsg.content,
          aiResponse: fullResponse,
          ...(capturedActivities.length > 0 ? { toolCalls: capturedActivities.length } : {}),
        });
      }
    };
    const onError = (err: Error) => {
      if (err.message === 'NOT_AUTHENTICATED') setAuthStatus('unauthenticated');
      else setError(err.message);
      setIsStreaming(false);
      setStreamingText('');
    };

    const apiMessages = [systemPrompt, ...newMessages];

    if (workspace) {
      // ─ Agent mode: tool calling enabled ──────────────
      const executor = buildToolExecutor(
        workspace.path,
        canvasEditorRef ?? { current: null },
        onFileWritten,
        (relPath, content) => onMarkRecorded?.(relPath, content, model),
      );
      await runCopilotAgent(
        apiMessages,
        WORKSPACE_TOOLS,
        executor,
        onChunk,
        (activity) => {
          // Keep capturedActivities in sync for onDone snapshot
          const idx = capturedActivities.findIndex((a) => a.callId === activity.callId);
          if (idx >= 0) {
            capturedActivities = [...capturedActivities];
            capturedActivities[idx] = activity;
          } else {
            capturedActivities = [...capturedActivities, activity];
          }
          // Update React state for live display
          setToolActivities((prev) => {
            const pIdx = prev.findIndex((a) => a.callId === activity.callId);
            if (pIdx >= 0) { const next = [...prev]; next[pIdx] = activity; return next; }
            return [...prev, activity];
          });
        },
        onDone,
        onError,
        model,
      );
    } else {
      // ─ Plain chat (no workspace loaded yet) ───────────
      await streamCopilotChat(apiMessages, onChunk, onDone, onError, model);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') onClose();
  }

  if (!isOpen) return null;

  // ── Auth screens ───────────────────────────────────────────────────────────
  if (authStatus === 'unauthenticated' || authStatus === 'connecting') {
    return (
      <div className="ai-panel" style={style}>
        <div className="ai-panel-header">
          <span className="ai-panel-title">❆ Copilot</span>
          <button onClick={onClose} className="ai-btn-ghost ai-btn-close" title="Close">✕</button>
        </div>
        <div className="ai-auth-screen">
          <div className="ai-auth-icon">❆</div>
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
              <p className="ai-auth-waiting">⟳ Waiting for authorization…</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel" style={style}>
      {/* Header */}
      <div className="ai-panel-header">
        <span className="ai-panel-title">✦ Copilot</span>
        <div className="ai-panel-header-right">
          <ModelPicker
            models={availableModels}
            value={model}
            onChange={(id) => { setModel(id); onModelChange?.(id); }}
            loading={modelsLoading}
          />
          <button
            onClick={handleNewChat}
            className="ai-btn-ghost"
            title="New chat (clears history)"
          >
            ↺ New
          </button>
          <button
            onClick={handleSignOut}
            className="ai-btn-ghost"
            title="Sign out of GitHub Copilot"
          >
            Sign out
          </button>
          <button
            onClick={onClose}
            className="ai-btn-ghost ai-btn-close"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="ai-messages">
        {messages.length === 0 && !isStreaming && (
          <div className="ai-empty-state">
            Ask Copilot anything about your document.
            <br />
            <span className="ai-hint">Enter to send · Shift+Enter new line · Esc to close</span>
            {agentContext && (
              <div className="ai-agent-notice">✦ AGENT.md loaded as context</div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-message ai-message--${msg.role}`}>
            <div className="ai-message-label">{msg.role === 'user' ? 'You' : '✦ Copilot'}</div>
            {msg.role === 'assistant' && msg.toolActivities && msg.toolActivities.length > 0 && (
              <AgentProcess activities={msg.toolActivities} />
            )}
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

          </div>
        ))}

        {isStreaming && (toolActivities.length > 0 || streamingText) && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-label">✦ Copilot</div>
            {toolActivities.length > 0 && <AgentProcess activities={toolActivities} />}
            {streamingText && (
              <div className="ai-message-content">
                {streamingText}<span className="ai-cursor" />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="ai-error">
            ⚠ {error}
            {error.includes('VITE_GITHUB_TOKEN') && (
              <span> — Add your token to <code>app/.env</code></span>
            )}
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
              }}>Save key</button>
              <button className="ai-btn-ghost" onClick={() => { setShowGroqSetup(false); setGroqKeyInput(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Copilot…"
          disabled={isStreaming}
          className="ai-input"
        />
        <div className="ai-input-actions">
          <canvas
            ref={vizCanvasRef}
            className={`ai-viz-canvas ${isRecording ? 'active' : ''}`}
            width={72}
            height={28}
          />
          <button
            className={`ai-btn-mic ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
            onClick={handleMicClick}
            title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing…' : groqKey ? 'Click to speak' : 'Set up voice input'}
            type="button"
            disabled={isTranscribing}
          >
            {isTranscribing ? '⌛' : isRecording ? '⏹' : '🎙'}
          </button>
          <button
            onClick={handleNewChat}
            className="ai-btn-new-chat"
            title="New chat"
            disabled={isStreaming}
          >↺</button>
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="ai-btn-send"
          >
            {isStreaming ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}
