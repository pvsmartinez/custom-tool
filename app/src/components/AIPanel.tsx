import { useState, useRef, useEffect, useCallback } from 'react';
import { streamCopilotChat } from '../services/copilot';
import { COPILOT_MODELS, DEFAULT_MODEL } from '../types';
import type { ChatMessage, CopilotModel } from '../types';
import './AIPanel.css';

// Pull DEFAULT_MODEL from types
const _DEFAULT = DEFAULT_MODEL;

interface AIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  onInsert?: (text: string) => void;
  documentContext?: string;
  agentContext?: string;
}

// Web Speech API typings (not yet in standard TS DOM lib)
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SpeechRecognition?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webkitSpeechRecognition?: any;
  }
}

export default function AIPanel({
  isOpen,
  onClose,
  initialPrompt = '',
  onInsert,
  documentContext = '',
  agentContext = '',
}: AIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<CopilotModel>(_DEFAULT);
  const [isListening, setIsListening] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<unknown>(null);

  useEffect(() => {
    if (isOpen) {
      setInput(initialPrompt);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // ── Voice control ────────────────────────────────────────────
  const startListening = useCallback(() => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      setError('Voice input is not supported in this browser.');
      return;
    }
    const rec: any = new SpeechRecognitionAPI();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onstart = () => setIsListening(true);
    rec.onend = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);

    rec.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join('');
      setInput(transcript);
      if (event.results[event.results.length - 1].isFinal) {
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = rec;
    rec.start();
  }, []);

  const stopListening = useCallback(() => {
    (recognitionRef.current as any)?.stop();
    setIsListening(false);
  }, []);

  // ── System prompt ────────────────────────────────────────────
  const systemPrompt: ChatMessage = {
    role: 'system',
    content: [
      'You are a helpful AI writing assistant embedded in a document editor.',
      'You help the user write books, courses, articles, and other long-form content.',
      'Be concise, thoughtful, and match the user\'s writing style.',
      agentContext ? `\nWorkspace context (from AGENT.md):\n${agentContext.slice(0, 3000)}` : '',
      documentContext ? `\nCurrent document (excerpt):\n${documentContext.slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n'),
  };

  // ── Send ─────────────────────────────────────────────────────
  async function handleSend() {
    if (!input.trim() || isStreaming) return;
    setError(null);

    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages: ChatMessage[] = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsStreaming(true);
    setStreamingText('');

    let fullResponse = '';

    await streamCopilotChat(
      [systemPrompt, ...newMessages],
      (chunk) => { fullResponse += chunk; setStreamingText(fullResponse); },
      () => {
        setMessages((prev) => [...prev, { role: 'assistant', content: fullResponse }]);
        setStreamingText('');
        setIsStreaming(false);
      },
      (err) => {
        setError(err.message);
        setIsStreaming(false);
        setStreamingText('');
      },
      model
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="ai-panel">
      {/* Header */}
      <div className="ai-panel-header">
        <span className="ai-panel-title">✦ Copilot</span>
        <div className="ai-panel-header-right">
          <select
            className="ai-model-select"
            value={model}
            onChange={(e) => setModel(e.target.value as CopilotModel)}
            title="Switch model"
          >
            {COPILOT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button
            onClick={() => setMessages([])}
            className="ai-btn-ghost"
            title="Clear chat"
          >
            Clear
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
            <div className="ai-message-content">{msg.content}</div>
            {msg.role === 'assistant' && onInsert && (
              <button className="ai-btn-insert" onClick={() => { onInsert(msg.content); }}>
                Insert into document
              </button>
            )}
          </div>
        ))}

        {isStreaming && streamingText && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-label">✦ Copilot</div>
            <div className="ai-message-content">
              {streamingText}<span className="ai-cursor" />
            </div>
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

      {/* Input */}
      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Copilot…"
          rows={2}
          disabled={isStreaming}
          className="ai-input"
        />
        <div className="ai-input-actions">
          <button
            className={`ai-btn-mic ${isListening ? 'listening' : ''}`}
            onMouseDown={startListening}
            onMouseUp={stopListening}
            onTouchStart={startListening}
            onTouchEnd={stopListening}
            title="Hold to speak"
            type="button"
          >
            {isListening ? '⏹' : '🎙'}
          </button>
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
