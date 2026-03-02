import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  X, Check, ArrowUp, ArrowDown, Warning, Camera, Paperclip, Copy,
} from '@phosphor-icons/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '../services/fs';

import {
  fetchCopilotModels,
  startDeviceFlow,
  getStoredOAuthToken,
  clearOAuthToken,
  getLastRequestDump,
  modelSupportsVision,
} from '../services/copilot';
import type { DeviceFlowState } from '../services/copilot';
import { DEFAULT_MODEL, FALLBACK_MODELS } from '../types';
import type { CopilotModel, CopilotModelInfo, MessageItem } from '../types';
import type { Workspace, WorkspaceExportConfig, WorkspaceConfig } from '../types';
import type { Editor as TldrawEditor } from 'tldraw';
import { getMimeType, IMAGE_EXTS } from '../utils/mime';

// ── Sub-components ──────────────────────────────────────────────────────────
import { ModelPicker } from './ai/AIModelPicker';
import { CodeBlock, parseSegments } from './ai/AICodeBlock';
import { CollapsibleProcess, ToolItem, useSessionStats } from './ai/AIToolProcess';
import { AIAuthScreen } from './ai/AIAuthScreen';

// ── Hooks ───────────────────────────────────────────────────────────────────
import { useAISession, contentToString, fmtRelative } from '../hooks/useAISession';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useSystemPrompt, useWorkspaceMemory } from '../hooks/useSystemPrompt';
import { useAIStream } from '../hooks/useAIStream';
import { useAIScreenshot } from '../hooks/useAIScreenshot';

import './AIPanel.css';

// ── Types ───────────────────────────────────────────────────────────────────
interface AIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  initialModel?: string;
  onModelChange?: (model: string) => void;
  onInsert?: (text: string, model: string) => void;
  documentContext?: string;
  agentContext?: string;
  workspacePath?: string;
  workspace?: Workspace | null;
  canvasEditorRef?: React.RefObject<TldrawEditor | null>;
  onFileWritten?: (path: string) => void;
  onMarkRecorded?: (relPath: string, content: string, model: string) => void;
  onCanvasMarkRecorded?: (relPath: string, shapeIds: string[], model: string) => void;
  activeFile?: string;
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  aiMarks?: import('../types').AIEditMark[];
  aiMarkIndex?: number;
  onAIMarkPrev?: () => void;
  onAIMarkNext?: () => void;
  onAIMarkReview?: (id: string) => void;
  workspaceExportConfig?: WorkspaceExportConfig;
  onExportConfigChange?: (config: WorkspaceExportConfig) => void;
  style?: React.CSSProperties;
  onStreamingChange?: (streaming: boolean) => void;
  screenshotTargetRef?: React.RefObject<HTMLElement | null>;
  webPreviewRef?: React.RefObject<{ getScreenshot: () => Promise<string | null> } | null>;
  getActiveHtml?: () => { html: string; absPath: string } | null;
  workspaceConfig?: WorkspaceConfig;
  onWorkspaceConfigChange?: (patch: Partial<WorkspaceConfig>) => void;
}

export interface AIPanelHandle {
  receiveFinderFiles(paths: string[]): void;
}

// ── Main panel ──────────────────────────────────────────────────────────────
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
  workspaceConfig,
  onWorkspaceConfigChange,
  style,
  onStreamingChange,
  screenshotTargetRef,
  webPreviewRef,
  getActiveHtml,
}, ref) {

  // ── Auth ────────────────────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<'checking' | 'unauthenticated' | 'connecting' | 'authenticated'>('checking');
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAuthStatus(getStoredOAuthToken() ? 'authenticated' : 'unauthenticated');
  }, [isOpen]);

  // stream is declared below; we use a ref to break the circular dependency.
  const streamErrorRef = useRef<((msg: string | null) => void) | null>(null);

  async function handleSignIn() {
    streamErrorRef.current?.(null);
    setAuthStatus('connecting');
    setDeviceFlow(null);
    try {
      await startDeviceFlow((state) => setDeviceFlow(state));
      setAuthStatus('authenticated');
      setDeviceFlow(null);
    } catch (err) {
      streamErrorRef.current?.(String(err));
      setAuthStatus('unauthenticated');
      setDeviceFlow(null);
    }
  }

  // ── Model ────────────────────────────────────────────────────────────────
  const [model, setModel] = useState<CopilotModel>(initialModel ?? DEFAULT_MODEL);
  const [availableModels, setAvailableModels] = useState<CopilotModelInfo[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsLoadedRef = useRef(false);

  useEffect(() => { if (initialModel) setModel(initialModel as CopilotModel); }, [initialModel]);

  useEffect(() => {
    if (!isOpen) return;
    if (authStatus === 'authenticated') modelsLoadedRef.current = false;
    if (modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    setModelsLoading(true);
    fetchCopilotModels()
      .then((models) => { setAvailableModels(models); setModelsLoading(false); })
      .catch(() => setModelsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authStatus]);

  // ── Input / attachments ──────────────────────────────────────────────────
  const [input, setInput] = useState(initialPrompt);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [pendingFileRef, setPendingFileRef] = useState<{ name: string; content: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) { setInput(initialPrompt); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [isOpen, initialPrompt]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const capped = el.scrollHeight > 200;
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    el.style.overflowY = capped ? 'auto' : 'hidden';
  }, [input]);

  // ── Domain hooks ──────────────────────────────────────────────────────────
  const [memoryContent, setMemoryContent] = useWorkspaceMemory(workspacePath);

  const session      = useAISession({ model, onInsert });
  const sessionStats = useSessionStats(session.messages);

  const systemPrompt = useSystemPrompt({
    model,
    workspace,
    workspacePath,
    documentContext,
    agentContext,
    activeFile,
    memoryContent,
    workspaceExportConfig,
    workspaceConfig,
  });

  const stream = useAIStream({
    model,
    systemPrompt,
    messages: session.messages,
    setMessages: session.setMessages,
    sessionIdRef: session.sessionIdRef,
    sessionStartedAtRef: session.sessionStartedAtRef,
    workspace,
    workspacePath,
    canvasEditorRef,
    activeFile,
    rescanFramesRef,
    workspaceExportConfig,
    onExportConfigChange,
    workspaceConfig,
    onWorkspaceConfigChange,
    onFileWritten,
    onMarkRecorded,
    onCanvasMarkRecorded,
    webPreviewRef,
    getActiveHtml,
    onStreamingChange,
    setMemoryContent,
    onNotAuthenticated: () => setAuthStatus('unauthenticated'),
  });

  streamErrorRef.current = stream.setError;

  function handleSignOut() {
    clearOAuthToken();
    setAuthStatus('unauthenticated');
    session.setMessages([]);
  }

  const voice = useVoiceInput({
    onTranscript: (t) => setInput((prev) => prev ? `${prev} ${t}` : t),
    onError: (msg) => stream.setError(msg),
  });

  // ── Send wrapper ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async (imageOverride?: string, textOverride?: string) => {
    await stream.handleSend(
      imageOverride,
      textOverride,
      pendingImage,
      pendingFileRef,
      input,
      () => { setInput(''); setPendingImage(null); setPendingFileRef(null); },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.handleSend, pendingImage, pendingFileRef, input]);

  const screenshot = useAIScreenshot({
    canvasEditorRef,
    screenshotTargetRef,
    webPreviewRef,
    input,
    isStreaming: stream.isStreaming,
    onReady: (url) => handleSend(url),
    onStage: setPendingImage,
  });

  // ── Session actions ────────────────────────────────────────────────────────
  function handleNewChat() {
    session.handleNewChat();
    stream.clearStream();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleRestoreSession() {
    const restoredModel = session.handleRestoreSession();
    if (restoredModel) { setModel(restoredModel as CopilotModel); onModelChange?.(restoredModel); }
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, stream.liveItems]);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') {
      if (stream.isStreaming) stream.handleStop();
      else onClose();
    }
  }

  // ── Finder drop handler ──────────────────────────────────────────────────
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

  // ── Drag + drop / paste ──────────────────────────────────────────────────
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }
  function handleDragLeave(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => { const url = ev.target?.result as string; if (url) setPendingImage(url); };
      reader.readAsDataURL(file);
    } else {
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
    } catch (err) { console.error('[attach-file]', err); }
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

  // ── Early exits ───────────────────────────────────────────────────────────
  if (!isOpen) return null;

  if (authStatus === 'unauthenticated' || authStatus === 'connecting') {
    return (
      <AIAuthScreen
        authStatus={authStatus}
        deviceFlow={deviceFlow}
        error={stream.error}
        style={style}
        onSignIn={handleSignIn}
      />
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="ai-panel" data-panel="ai" style={style}>
      {/* Header */}
      <div className="ai-panel-header">
        <span className="ai-panel-title">✶ Copilot</span>
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

      {/* Quota bar */}
      {stream.quotaInfo.limit !== null && stream.quotaInfo.remaining !== null && !stream.quotaInfo.quotaExceeded && (() => {
        const pct = Math.max(0, Math.min(100, (stream.quotaInfo.remaining / stream.quotaInfo.limit!) * 100));
        return (
          <div
            className="ai-quota-bar-wrap"
            data-low={pct < 30 ? 'true' : undefined}
            title={`${stream.quotaInfo.remaining} / ${stream.quotaInfo.limit} requests remaining`}
          >
            <div className="ai-quota-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        );
      })()}

      {/* AI edit review bar */}
      {aiMarksForFile && aiMarksForFile.length > 0 && (
        <div className="ai-review-bar">
          <span className="ai-review-bar-icon">✶</span>
          <span className="ai-review-bar-label">
            {aiMarksForFile.length} AI edit{aiMarksForFile.length !== 1 ? 's' : ''}
          </span>
          <button className="ai-review-bar-btn" onClick={onAIMarkPrev} disabled={aiMarksForFile.length < 2} title="Previous AI edit">‹</button>
          <span className="ai-review-bar-count">{aiMarkIndex + 1}/{aiMarksForFile.length}</span>
          <button className="ai-review-bar-btn" onClick={onAIMarkNext} disabled={aiMarksForFile.length < 2} title="Next AI edit">›</button>
          <button
            className="ai-review-bar-btn ai-review-bar-btn--accept"
            onClick={() => onAIMarkReview?.(aiMarksForFile[aiMarkIndex]?.id)}
            title="Mark as reviewed"
          >✓ Accept</button>
        </div>
      )}

      {/* Messages */}
      <div className="ai-messages">
        {/* Session stats bar */}
        {(sessionStats.filesCount > 0 || sessionStats.canvasOps > 0) && (
          <div className="ai-session-stats">
            <span className="ai-session-stats-label">Session</span>
            {sessionStats.filesCount > 0 && (
              <span className="ai-session-stat-chip">
                <span className="ai-stat-chip-icon">⊝</span>
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

        {/* Empty state */}
        {session.messages.length === 0 && !stream.isStreaming && (
          <div className="ai-empty-state">
            Ask Copilot anything about your document.
            <br />
            <span className="ai-hint">Enter to send · Shift+Enter new line · Esc to close</span>
            {agentContext && <div className="ai-agent-notice">✶ AGENT.md loaded as context</div>}
            {session.savedSession && session.savedSession.messages.length > 0 && (
              <button className="ai-restore-session-btn" onClick={handleRestoreSession}>
                <span className="ai-restore-session-label">↩ Restore last conversation</span>
                <span className="ai-restore-session-meta">
                  {session.savedSession.messages.filter((m) => m.role === 'user').length}{' '}
                  message{session.savedSession.messages.filter((m) => m.role === 'user').length !== 1 ? 's' : ''}{' '}
                  · {fmtRelative(session.savedSession.savedAt)}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Message list */}
        {session.messages.map((msg, i) => (
          <div key={i} className={`ai-message ai-message--${msg.role}`}>
            <div className="ai-message-label">{msg.role === 'user' ? 'You' : '✶ Copilot'}</div>
            <div className="ai-message-content">
              {msg.role === 'assistant'
                ? parseSegments(contentToString(msg.content)).map((seg, si) =>
                    seg.type === 'code'
                      ? <CodeBlock key={si} lang={seg.lang} code={seg.code} workspacePath={workspacePath} />
                      : <span key={si} style={{ whiteSpace: 'pre-wrap' }}>{seg.content}</span>
                  )
                : <span style={{ whiteSpace: 'pre-wrap' }}>{contentToString(msg.content)}</span>
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
            {msg.role === 'assistant' && msg.items && <CollapsibleProcess items={msg.items} />}
            {msg.role === 'assistant' && msg.content && (
              <div className="ai-msg-actions">
                {onInsert && (
                  <button
                    className={`ai-msg-action-btn ${session.insertedMsgs.has(i) ? 'ai-msg-action-btn--done' : ''}`}
                    onClick={() => session.handleInsertMessage(i, contentToString(msg.content))}
                    title="Insert into document and track as AI edit"
                  >
                    {session.insertedMsgs.has(i)
                      ? <><Check weight="thin" size={12} />{' Inserted'}</>
                      : <><ArrowDown weight="thin" size={12} />{' Insert'}</>
                    }
                  </button>
                )}
                <button
                  className={`ai-msg-action-btn ${session.copiedMsgs.has(i) ? 'ai-msg-action-btn--done' : ''}`}
                  onClick={() => session.handleCopyMessage(i, contentToString(msg.content))}
                  title="Copy to clipboard"
                >
                  {session.copiedMsgs.has(i)
                    ? <><Check weight="thin" size={12} />{' Copied'}</>
                    : <><Copy weight="thin" size={12} />{' Copy'}</>
                  }
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Live streaming row */}
        {stream.isStreaming && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-label">✶ Copilot</div>
            <div className="ai-message-content">
              {stream.liveItems.length > 0
                ? <>
                    {stream.liveItems.map((item: MessageItem, idx: number) =>
                      item.type === 'text'
                        ? <span key={idx} style={{ whiteSpace: 'pre-wrap' }}>{item.content}</span>
                        : <ToolItem key={item.activity.callId} activity={item.activity} />
                    )}
                    <div className="ai-thinking-indicator ai-thinking-indicator--inline">
                      <span className="ai-thinking-dot" /><span className="ai-thinking-dot" /><span className="ai-thinking-dot" />
                    </div>
                  </>
                : <div className="ai-thinking-indicator">
                    <span className="ai-thinking-dot" /><span className="ai-thinking-dot" /><span className="ai-thinking-dot" />
                  </div>
              }
            </div>
          </div>
        )}

        {/* ask_user card */}
        {stream.askUserState && (
          <div className="ai-ask-user-card">
            <div className="ai-ask-user-question">{stream.askUserState.question}</div>
            {stream.askUserState.options && stream.askUserState.options.length > 0 && (
              <div className="ai-ask-user-options">
                {stream.askUserState.options.map((opt) => (
                  <button key={opt} className="ai-ask-user-option" onClick={() => stream.handleAskUserAnswer(opt)}>
                    {opt}
                  </button>
                ))}
              </div>
            )}
            <div className="ai-ask-user-input-row">
              <input
                className="ai-ask-user-input"
                type="text"
                placeholder="Ou escreva sua resposta…"
                value={stream.askUserInput}
                onChange={(e) => stream.setAskUserInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') stream.handleAskUserAnswer(stream.askUserInput); }}
                autoFocus
              />
              <button
                className="ai-ask-user-submit"
                disabled={!stream.askUserInput.trim()}
                onClick={() => stream.handleAskUserAnswer(stream.askUserInput)}
              >
                Responder
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {stream.error && (
          <div className="ai-error">
            <span><Warning weight="thin" size={14} /> {stream.error}</span>
            {stream.error.includes('VITE_GITHUB_TOKEN') && (
              <span> — Add your token to <code>app/.env</code></span>
            )}
            {(stream.isQuotaError(stream.error) || stream.quotaInfo.quotaExceeded) && (
              <button
                className="ai-quota-manage-btn"
                onClick={() => openUrl('https://github.com/github-copilot/usage').catch(() =>
                  window.open('https://github.com/github-copilot/usage', '_blank')
                )}
              >
                Manage paid tokens ↗
              </button>
            )}
            <button
              className="ai-error-copy"
              onClick={() => {
                const dump = getLastRequestDump();
                navigator.clipboard.writeText(`ERROR:\n${stream.error}\n\nLAST REQUEST DUMP:\n${dump}`);
              }}
              title="Copy error + full last request to clipboard"
            >Copy logs</button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Continue button */}
      {stream.agentExhausted && !stream.isStreaming && (
        <div className="ai-continue-bar">
          <button className="ai-continue-btn" onClick={() => handleSend(undefined, 'continue')}>
            Continuar ↻
          </button>
        </div>
      )}

      {/* Groq key setup overlay */}
      {voice.showGroqSetup && (
        <div className="ai-groq-overlay">
          <div className="ai-groq-card">
            <div className="ai-groq-title">🎤 Enable Voice Input</div>
            <p className="ai-groq-desc">
              Voice uses <strong>Groq Whisper</strong> for fast, free transcription.
              Get a free API key at{' '}
              <button
                className="ai-groq-link"
                onClick={() => openUrl('https://console.groq.com/keys').catch(() =>
                  window.open('https://console.groq.com/keys', '_blank')
                )}
              >
                console.groq.com/keys ↗
              </button>
            </p>
            <input
              className="ai-groq-input"
              type="password"
              placeholder="gsk_…"
              value={voice.groqKeyInput}
              onChange={(e) => voice.setGroqKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && voice.groqKeyInput.trim()) voice.saveGroqKeyAndClose(); }}
              autoFocus
            />
            <div className="ai-groq-actions">
              <button className="ai-auth-btn" disabled={!voice.groqKeyInput.trim()} onClick={voice.saveGroqKeyAndClose}>
                Save key
              </button>
              <button className="ai-btn-ghost" onClick={() => { voice.setShowGroqSetup(false); voice.setGroqKeyInput(''); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input area */}
      <div
        className={`ai-input-row${isDragOver ? ' drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {pendingImage && (
          <div className="ai-img-preview">
            <img src={pendingImage} alt="attached" />
            <button className="ai-img-remove" onClick={() => setPendingImage(null)} title="Remove image">
              <X weight="thin" size={12} />
            </button>
            {!modelSupportsVision(model) && (
              <span className="ai-no-vision-warning">
                <Warning weight="thin" size={12} /> Model doesn't support images
              </span>
            )}
          </div>
        )}
        {pendingFileRef && (
          <div className="ai-file-chip">
            <span className="ai-file-chip-icon">📄</span>
            <span className="ai-file-chip-name" title={pendingFileRef.name}>{pendingFileRef.name}</span>
            <span className="ai-file-chip-size">
              {pendingFileRef.content.length > 1000
                ? `${Math.round(pendingFileRef.content.length / 1000)}k chars`
                : `${pendingFileRef.content.length} chars`}
            </span>
            <button className="ai-img-remove" onClick={() => setPendingFileRef(null)} title="Remove file">
              <X weight="thin" size={12} />
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            stream.isStreaming ? 'Type to interrupt…' :
            isDragOver ? 'Drop image or file here…' :
            'Ask Copilot…'
          }
          className="ai-input"
        />
        <div className="ai-input-actions">
          <canvas
            ref={voice.vizCanvasRef}
            className={`ai-viz-canvas ${voice.isRecording ? 'active' : ''}`}
            width={72}
            height={28}
          />
          {screenshotTargetRef && (
            <button
              className={`ai-btn-screenshot ${screenshot.isCapturing ? 'capturing' : ''}`}
              onClick={screenshot.handleTakeScreenshot}
              disabled={screenshot.isCapturing}
              title={canvasEditorRef?.current
                ? 'Screenshot canvas → send to Copilot'
                : 'Screenshot current view → send to Copilot'}
              type="button"
            >
              <Camera weight="thin" size={14} />
            </button>
          )}
          <button
            className="ai-btn-attach"
            onClick={handleAttachFile}
            title="Attach file (image or document)"
            type="button"
            disabled={stream.isStreaming}
          >
            <Paperclip weight="thin" size={14} />
          </button>
          <button
            className={`ai-btn-mic ${voice.isRecording ? 'recording' : ''} ${voice.isTranscribing ? 'transcribing' : ''}`}
            onClick={voice.handleMicClick}
            title={
              voice.isRecording ? 'Stop recording' :
              voice.isTranscribing ? 'Transcribing…' :
              voice.groqKey ? 'Click to speak' :
              'Set up voice input'
            }
            type="button"
            disabled={voice.isTranscribing}
          >
            {voice.isTranscribing
              ? <span className="ai-mic-spinner" />
              : voice.isRecording
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
            disabled={stream.isStreaming}
          >↺</button>

          {stream.isStreaming && !input.trim() ? (
            <button onClick={stream.handleStop} className="ai-btn-send ai-btn-send--stop" title="Stop (Esc)">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                <rect x="1" y="1" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() && !pendingImage}
              className={`ai-btn-send${stream.isStreaming ? ' ai-btn-send--interrupt' : ''}`}
              title={stream.isStreaming ? 'Interrupt and send (Enter)' : 'Send (Enter)'}
            >
              {stream.isStreaming
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
