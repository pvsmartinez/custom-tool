import { useState, useRef } from 'react';
import {
  streamCopilotChat,
  runCopilotAgent,
  getLastRateLimit,
  isQuotaError,
  estimateTokens,
  modelSupportsVision,
} from '../services/copilot';
import { appendLogEntry } from '../services/copilotLog';
import { WORKSPACE_TOOLS, buildToolExecutor } from '../utils/workspaceTools';
import { canvasToDataUrl, compressDataUrl } from '../utils/canvasAI';
import { unlockAll } from '../services/copilotLock';
import type {
  ChatMessage,
  ContentPart,
  CopilotModel,
  MessageItem,
  ToolActivity,
  Workspace,
  WorkspaceConfig,
  WorkspaceExportConfig,
} from '../types';
import type { Editor as TldrawEditor } from 'tldraw';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface QuotaInfo {
  remaining: number | null;
  limit: number | null;
  quotaExceeded: boolean;
}

export interface UseAIStreamParams {
  // ── Model / history ───────────────────────────────────────────────────────
  model: CopilotModel;
  systemPrompt: ChatMessage;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sessionIdRef: React.MutableRefObject<string>;
  sessionStartedAtRef: React.MutableRefObject<string>;
  /** Called when the API returns NOT_AUTHENTICATED error. */
  onNotAuthenticated?: () => void;
  // ── Workspace / tools ─────────────────────────────────────────────────────
  workspace?: Workspace | null;
  workspacePath?: string;
  canvasEditorRef?: React.RefObject<TldrawEditor | null>;
  activeFile?: string;
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  workspaceExportConfig?: WorkspaceExportConfig;
  onExportConfigChange?: (cfg: WorkspaceExportConfig) => void;
  workspaceConfig?: WorkspaceConfig;
  onWorkspaceConfigChange?: (patch: Partial<WorkspaceConfig>) => void;
  onFileWritten?: (path: string) => void;
  onMarkRecorded?: (relPath: string, content: string, model: string) => void;
  onCanvasMarkRecorded?: (relPath: string, shapeIds: string[], model: string) => void;
  // ── Misc ──────────────────────────────────────────────────────────────────
  webPreviewRef?: React.RefObject<{ getScreenshot: () => Promise<string | null> } | null>;
  getActiveHtml?: () => { html: string; absPath: string } | null;
  onStreamingChange?: (v: boolean) => void;
  setMemoryContent: (v: string) => void;
}

// ── useAIStream ───────────────────────────────────────────────────────────────
export function useAIStream({
  model,
  systemPrompt,
  messages,
  setMessages,
  sessionIdRef,
  sessionStartedAtRef,
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
  onNotAuthenticated,
}: UseAIStreamParams) {
  const [isStreaming, setIsStreamingState] = useState(false);
  const [agentExhausted, setAgentExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo>({ remaining: null, limit: null, quotaExceeded: false });

  // ── ask_user (human-in-the-loop) ──────────────────────────────────────────
  const [askUserState, setAskUserState] = useState<{ question: string; options?: string[] } | null>(null);
  const [askUserInput, setAskUserInput] = useState('');
  const askUserResolveRef = useRef<((answer: string) => void) | null>(null);

  // ── Live streaming items (text + tool calls interleaved) ──────────────────
  const [liveItems, setLiveItemsState] = useState<MessageItem[]>([]);
  const liveItemsRef = useRef<MessageItem[]>([]);

  function setLiveItems(updater: MessageItem[] | ((prev: MessageItem[]) => MessageItem[])) {
    setLiveItemsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      liveItemsRef.current = next;
      return next;
    });
  }

  // ── Abort / run-id tracking ───────────────────────────────────────────────
  const abortRef  = useRef<AbortController | null>(null);
  const runIdRef  = useRef(0);

  function setIsStreaming(v: boolean) {
    setIsStreamingState(v);
    onStreamingChange?.(v);
  }

  // ── ask_user ──────────────────────────────────────────────────────────────
  function onAskUser(question: string, options?: string[]): Promise<string> {
    return new Promise((resolve) => {
      askUserResolveRef.current = resolve;
      setAskUserInput('');
      setAskUserState({ question, options });
    });
  }

  function handleAskUserAnswer(answer: string) {
    if (!answer.trim()) return;
    setAskUserState(null);
    setAskUserInput('');
    askUserResolveRef.current?.(answer.trim());
    askUserResolveRef.current = null;
  }

  // ── Stop ─────────────────────────────────────────────────────────────────
  function handleStop() {
    if (!isStreaming) return;
    const partial = liveItemsRef.current
      .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
      .map((it) => it.content).join('');
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
    setAskUserState(null);
    askUserResolveRef.current?.('');
    askUserResolveRef.current = null;
    runIdRef.current++;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function handleSend(
    imageOverride?: string,
    textOverride?: string,
    pendingImageRef?: string | null,
    pendingFileRefVal?: { name: string; content: string } | null,
    input?: string,
    clearInputAndAttachments?: () => void,
  ): Promise<void> {
    const textToSend = (textOverride ?? input ?? '').trim();
    if (!textToSend && !imageOverride && !pendingImageRef) {
      if (isStreaming) handleStop();
      return;
    }

    // If an agent run is in progress, commit the partial response and abort it.
    if (isStreaming) {
      const partial = liveItemsRef.current
        .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
        .map((it) => it.content).join('');
      if (partial.trim()) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: partial.trim() + '\n\n_[interrupted]_' },
        ]);
      }
      abortRef.current?.abort();
      setLiveItems([]);
      setAskUserState(null);
      askUserResolveRef.current?.('');
      askUserResolveRef.current = null;
    }

    const runId = ++runIdRef.current;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setError(null);
    setLiveItems([]);
    clearInputAndAttachments?.();

    const capturedImage   = imageOverride ?? pendingImageRef ?? null;
    const capturedFileRef = pendingFileRefVal ?? null;
    const userMsg: ChatMessage = {
      role: 'user',
      content: textToSend || '📸',
      activeFile,
      ...(capturedImage    ? { attachedImage: capturedImage }         : {}),
      ...(capturedFileRef  ? { attachedFile: capturedFileRef.name }   : {}),
    };
    setIsStreaming(true);
    setAgentExhausted(false);

    // Build multipart user message for the API
    const prefix     = activeFile ? `[Context: user sent this prompt while "${activeFile.split('/').pop()}" was open]\n` : '';
    const fileContext = capturedFileRef
      ? `[Attached file: "${capturedFileRef.name}"]\n---\n${capturedFileRef.content}\n---\n\n`
      : '';
    const apiText = `${fileContext}${prefix}${textToSend || 'Describe what you see in this screenshot and note any issues.'}`;

    let finalUserMsg: ChatMessage = (activeFile || capturedFileRef)
      ? { role: 'user', content: apiText }
      : userMsg;

    if (modelSupportsVision(model)) {
      const parts: ContentPart[] = [];
      if (canvasEditorRef?.current) {
        const url = await canvasToDataUrl(canvasEditorRef.current, 0.5);
        if (url) {
          const compressed = await compressDataUrl(url, 512, 0.65);
          parts.push({ type: 'text', text: 'Current canvas state (before any edits) — study this carefully before making changes:' });
          parts.push({ type: 'image_url', image_url: { url: compressed } });
        }
      }
      if (capturedImage) {
        const compressedCapture = await compressDataUrl(capturedImage, 512, 0.65);
        parts.push({ type: 'text', text: 'Attached image:' });
        parts.push({ type: 'image_url', image_url: { url: compressedCapture } });
      }
      if (parts.length > 0) {
        parts.push({ type: 'text', text: apiText });
        finalUserMsg = { role: 'user', content: parts };
      }
    }

    const newMessages: ChatMessage[] = [...messages, finalUserMsg];
    setMessages((prev) => [...prev, userMsg]); // UI shows plain-text version

    let fullResponse = '';

    const onChunk = (chunk: string) => {
      if (runIdRef.current !== runId) return;
      fullResponse += chunk;
      setLiveItems((prev) => {
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
      const toolCount     = capturedItems.filter((it) => it.type === 'tool').length;
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
      setQuotaInfo(getLastRateLimit());
      if (workspacePath) {
        void appendLogEntry(workspacePath, {
          sessionId: sessionIdRef.current,
          sessionStartedAt: sessionStartedAtRef.current,
          timestamp: new Date().toISOString(),
          model,
          userMessage: typeof userMsg.content === 'string' ? userMsg.content : '',
          aiResponse: fullResponse,
          ...(toolCount > 0 ? { toolCalls: toolCount } : {}),
        });
      }
    };

    const onError = (err: Error) => {
      if (runIdRef.current !== runId) return;
      const partial = liveItemsRef.current
        .filter((it): it is { type: 'text'; content: string } => it.type === 'text')
        .map((it) => it.content).join('');
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
      if (err.message === 'NOT_AUTHENTICATED') {
        onNotAuthenticated?.();
      } else {
        setError(err.message);
      }
      setLiveItems([]);
      setIsStreaming(false);
      unlockAll();
      setAskUserState(null);
      askUserResolveRef.current?.('');
      askUserResolveRef.current = null;
      setQuotaInfo(getLastRateLimit());
    };

    // ── Sliding-window token budget ────────────────────────────────────────
    const apiMessages = (() => {
      const CHAT_TOKEN_BUDGET = 70_000;
      const all = [systemPrompt, ...newMessages];
      if (estimateTokens(all) <= CHAT_TOKEN_BUDGET) return all;
      const firstUserIdx = all.findIndex((m, i) => i > 0 && m.role === 'user');
      const pinned = firstUserIdx >= 0 ? all.slice(0, firstUserIdx + 1) : [all[0]];
      const pinnedTokens = estimateTokens(pinned);
      const tail: typeof all = [];
      let tailTokens = 0;
      for (let i = all.length - 1; i > (firstUserIdx >= 0 ? firstUserIdx : 0); i--) {
        const t = estimateTokens([all[i]]);
        if (pinnedTokens + tailTokens + t > CHAT_TOKEN_BUDGET) break;
        tail.unshift(all[i]);
        tailTokens += t;
      }
      return [...pinned, ...tail];
    })();

    if (workspace) {
      const executor = buildToolExecutor(
        workspace.path,
        canvasEditorRef ?? { current: null },
        onFileWritten,
        (relPath, content) => onMarkRecorded?.(relPath, content, model),
        (shapeIds) => {
          if (shapeIds.length > 0 && activeFile) {
            onCanvasMarkRecorded?.(activeFile, shapeIds, model);
          }
          rescanFramesRef?.current?.();
        },
        activeFile,
        workspaceExportConfig,
        onExportConfigChange,
        setMemoryContent,
        webPreviewRef as { current: { getScreenshot: () => Promise<string | null> } | null } | undefined,
        onAskUser,
        getActiveHtml,
        workspaceConfig,
        onWorkspaceConfigChange,
      );

      const CANVAS_TOOL_NAMES = new Set(['list_canvas_shapes', 'canvas_op', 'canvas_screenshot', 'add_canvas_image']);
      const hasCanvas           = !!(canvasEditorRef?.current);
      const isMobilePlatform    = import.meta.env.VITE_TAURI_MOBILE === 'true';
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
        (activity: ToolActivity) => {
          if (runIdRef.current !== runId) return;
          setLiveItems((prev) => {
            const pIdx = prev.findIndex(
              (it) => it.type === 'tool' && it.activity.callId === activity.callId,
            );
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
        () => { if (runIdRef.current === runId) setAgentExhausted(true); },
      );
    } else {
      await streamCopilotChat(apiMessages, onChunk, onDone, onError, model, undefined, signal);
    }
  }

  /** Clears live stream state — call alongside session.handleNewChat(). */
  function clearStream() {
    setLiveItems([]);
    setIsStreamingState(false);
    setError(null);
  }

  return {
    isStreaming,
    agentExhausted,
    error,
    setError,
    quotaInfo,
    liveItems,
    askUserState,
    askUserInput,
    setAskUserInput,
    handleStop,
    handleSend,
    handleAskUserAnswer,
    clearStream,
    isQuotaError,
  };
}
