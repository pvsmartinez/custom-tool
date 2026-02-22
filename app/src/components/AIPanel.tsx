import { useState, useRef, useEffect } from 'react';
import { streamCopilotChat } from '../services/copilot';
import type { ChatMessage } from '../types';
import './AIPanel.css';

interface AIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  onInsert?: (text: string) => void;
  documentContext?: string;
}

export default function AIPanel({
  isOpen,
  onClose,
  initialPrompt = '',
  onInsert,
  documentContext = '',
}: AIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setInput(initialPrompt);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const systemPrompt: ChatMessage = {
    role: 'system',
    content: `You are a helpful AI writing assistant embedded in a document editor. 
You help the user write books, courses, articles, and other long-form content.
Be concise, thoughtful, and match the user's writing style.
${documentContext ? `\nCurrent document context:\n${documentContext.slice(0, 2000)}` : ''}`,
  };

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
      (chunk) => {
        fullResponse += chunk;
        setStreamingText(fullResponse);
      },
      () => {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: fullResponse },
        ]);
        setStreamingText('');
        setIsStreaming(false);
      },
      (err) => {
        setError(err.message);
        setIsStreaming(false);
        setStreamingText('');
      }
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') onClose();
  }

  function handleInsert(text: string) {
    onInsert?.(text);
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <span className="ai-panel-title">✦ Copilot</span>
        <div className="ai-panel-actions">
          <button onClick={() => setMessages([])} className="ai-btn-ghost" title="Clear chat">
            Clear
          </button>
          <button onClick={onClose} className="ai-btn-ghost ai-btn-close" title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="ai-messages">
        {messages.length === 0 && !isStreaming && (
          <div className="ai-empty-state">
            Ask Copilot anything about your document.<br />
            <span className="ai-hint">Shift+Enter for new line · Enter to send · Esc to close</span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-message ai-message--${msg.role}`}>
            <div className="ai-message-label">{msg.role === 'user' ? 'You' : '✦ Copilot'}</div>
            <div className="ai-message-content">{msg.content}</div>
            {msg.role === 'assistant' && onInsert && (
              <button
                className="ai-btn-insert"
                onClick={() => handleInsert(msg.content)}
              >
                Insert into document
              </button>
            )}
          </div>
        ))}

        {isStreaming && streamingText && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-label">✦ Copilot</div>
            <div className="ai-message-content">
              {streamingText}
              <span className="ai-cursor" />
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

      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Copilot… (Enter to send, Shift+Enter for new line)"
          rows={2}
          disabled={isStreaming}
          className="ai-input"
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          className="ai-btn-send"
        >
          {isStreaming ? '…' : '↑'}
        </button>
      </div>
    </div>
  );
}
