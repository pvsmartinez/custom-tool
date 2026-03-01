import { useState, useRef, useEffect } from 'react';
import { newSessionId } from '../services/copilotLog';
import type { ChatMessage, CopilotModel } from '../types';

// ── Persistence utils ─────────────────────────────────────────────────────────
const LAST_SESSION_KEY = 'cafezin-last-session';

export interface SavedSession {
  messages: ChatMessage[];
  model: string;
  savedAt: string;
}

export function loadSavedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch { return null; }
}

export function persistSession(msgs: ChatMessage[], mdl: string) {
  // Only persist user/assistant roles; strip attachedImage (base64) to stay within storage limits
  const slim = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.activeFile   ? { activeFile: m.activeFile }   : {}),
      ...(m.attachedFile ? { attachedFile: m.attachedFile } : {}),
    } as ChatMessage));
  if (slim.length === 0) return;
  try {
    localStorage.setItem(
      LAST_SESSION_KEY,
      JSON.stringify({ messages: slim, model: mdl, savedAt: new Date().toISOString() }),
    );
  } catch { /* quota exceeded — skip silently */ }
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Flatten content to plain text (for copy / insert / log) ──────────────────
export const contentToString = (content: ChatMessage['content']): string =>
  typeof content === 'string'
    ? content
    : (content as import('../types').ContentPart[])
        .filter((p): p is Extract<import('../types').ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('');

// ── useAISession ──────────────────────────────────────────────────────────────
interface UseAISessionParams {
  model: CopilotModel;
  onInsert?: (text: string, model: string) => void;
}

export function useAISession({ model, onInsert }: UseAISessionParams) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [insertedMsgs, setInsertedMsgs] = useState<Set<number>>(new Set());
  const [copiedMsgs, setCopiedMsgs] = useState<Set<number>>(new Set());
  const [savedSession, setSavedSession] = useState<SavedSession | null>(() => loadSavedSession());

  // Log session identifiers
  const sessionIdRef = useRef<string>(newSessionId());
  const sessionStartedAtRef = useRef<string>(new Date().toISOString());

  // Auto-save conversation to localStorage whenever messages change
  useEffect(() => {
    if (messages.length === 0) return;
    persistSession(messages, model);
    setSavedSession(loadSavedSession());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /** Resets messages and session refs. Caller is responsible for clearing stream state. */
  function handleNewChat() {
    setSavedSession(loadSavedSession());
    setMessages([]);
    setInsertedMsgs(new Set());
    setCopiedMsgs(new Set());
    sessionIdRef.current = newSessionId();
    sessionStartedAtRef.current = new Date().toISOString();
  }

  /** Returns the restored model string (for the caller to call setModel), or null if no session. */
  function handleRestoreSession(): string | null {
    if (!savedSession) return null;
    setMessages(savedSession.messages);
    return savedSession.model;
  }

  function handleInsertMessage(idx: number, content: string) {
    onInsert?.(content, model);
    setInsertedMsgs((prev) => new Set([...prev, idx]));
    setTimeout(() => setInsertedMsgs((prev) => { const n = new Set(prev); n.delete(idx); return n; }), 3000);
  }

  async function handleCopyMessage(idx: number, content: string) {
    await navigator.clipboard.writeText(content);
    setCopiedMsgs((prev) => new Set([...prev, idx]));
    setTimeout(() => setCopiedMsgs((prev) => { const n = new Set(prev); n.delete(idx); return n; }), 2000);
  }

  return {
    messages,
    setMessages,
    insertedMsgs,
    copiedMsgs,
    savedSession,
    setSavedSession,
    sessionIdRef,
    sessionStartedAtRef,
    handleNewChat,
    handleRestoreSession,
    handleInsertMessage,
    handleCopyMessage,
  };
}
