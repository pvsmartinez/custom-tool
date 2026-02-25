import { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  streamCopilotChat,
  startDeviceFlow,
  getStoredOAuthToken,
  clearOAuthToken,
  fetchCopilotModels,
} from '../../services/copilot';
import type { DeviceFlowState } from '../../services/copilot';
import { DEFAULT_MODEL, FALLBACK_MODELS } from '../../types';
import type { ChatMessage, CopilotModelInfo } from '../../types';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Workspace } from '../../types';

const GROQ_KEY = 'cafezin-groq-key';
function getGroqKey(): string { return localStorage.getItem(GROQ_KEY) ?? ''; }
function saveGroqKey(k: string) { localStorage.setItem(GROQ_KEY, k.trim()); }

interface MobileCopilotProps {
  workspace: Workspace | null;
  /** Relative path of the currently open file — used as context */
  contextFilePath?: string;
  contextFileContent?: string;
}

export default function MobileCopilot({
  workspace,
  contextFilePath,
  contextFileContent,
}: MobileCopilotProps) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<'checking' | 'unauthenticated' | 'connecting' | 'authenticated'>(
    () => getStoredOAuthToken() ? 'authenticated' : 'unauthenticated'
  );
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);

  async function handleSignIn() {
    setAuthStatus('connecting');
    setDeviceFlow(null);
    try {
      await startDeviceFlow(state => setDeviceFlow(state));
      setAuthStatus('authenticated');
      setDeviceFlow(null);
    } catch {
      setAuthStatus('unauthenticated');
      setDeviceFlow(null);
    }
  }

  function handleSignOut() {
    clearOAuthToken();
    setAuthStatus('unauthenticated');
    setMessages([]);
  }

  // ── Models ───────────────────────────────────────────────────────────────
  const [models, setModels] = useState<CopilotModelInfo[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelsLoadedRef = useRef(false);

  useEffect(() => {
    if (authStatus !== 'authenticated' || modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    fetchCopilotModels().then(m => setModels(m)).catch(() => {});
  }, [authStatus]);

  // ── Messages ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [input]);

  async function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setError(null);

    const userMsg: ChatMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    // Build system prompt with workspace + file context
    const systemParts: string[] = [
      'You are a helpful coding and writing assistant. Keep answers concise and clear.',
    ];
    if (workspace) {
      systemParts.push(`Workspace: ${workspace.name}.`);
    }
    if (workspace?.agentContext) {
      systemParts.push(`\n${workspace.agentContext}`);
    }
    if (contextFilePath && contextFileContent) {
      systemParts.push(
        `\nThe user has "${contextFilePath}" open:\n\`\`\`\n${contextFileContent.slice(0, 4000)}\n\`\`\``
      );
    }

    const apiMessages: ChatMessage[] = [
      { role: 'system', content: systemParts.join('\n') },
      ...newMessages,
    ];

    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming(true);
    setStreamingText('');

    let accumulated = '';

    try {
      await streamCopilotChat(
        apiMessages,
        /* onChunk */ (chunk: string) => {
          accumulated += chunk;
          setStreamingText(accumulated);
        },
        /* onDone */ () => {},
        /* onError */ (err: Error) => {
          setError(err.message);
        },
        model,
        undefined,
        abort.signal,
      );
    } catch {
      // aborted or network error — keep accumulated text if any
    }

    // Commit streamed text as assistant message
    if (accumulated) {
      setMessages(prev => [...prev, { role: 'assistant', content: accumulated }]);
    }
    setStreamingText('');
    setStreaming(false);
    abortRef.current = null;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [groqKey, setGroqKey] = useState(() => getGroqKey());
  const [showGroqSetup, setShowGroqSetup] = useState(false);
  const [groqKeyInput, setGroqKeyInput] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const ab = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab));
        setIsTranscribing(true);
        try {
          const transcript = await invoke<string>('transcribe_audio', {
            audioData: bytes,
            mimeType,
            apiKey: groqKey,
          });
          setInput(prev => prev ? `${prev} ${transcript}` : transcript);
        } catch (err) {
          setError(`Voice transcription failed: ${err}`);
        } finally {
          setIsTranscribing(false);
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      setError(`Microphone access denied: ${err}`);
    }
  }, [groqKey]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  function handleVoice() {
    if (!groqKey) { setShowGroqSetup(v => !v); return; }
    if (isRecording) stopRecording();
    else startRecording();
  }

  function saveGroq() {
    saveGroqKey(groqKeyInput);
    setGroqKey(groqKeyInput);
    setShowGroqSetup(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (authStatus === 'unauthenticated' || authStatus === 'connecting') {
    return (
      <div className="mb-chat">
        <div className="mb-header">
          <span className="mb-header-title">Copilot</span>
        </div>
        <div className="mb-chat-auth">
          {authStatus === 'connecting' && deviceFlow ? (
            <>
              <div className="mb-empty-icon">🔑</div>
              <div className="mb-chat-auth-title">Sign in to GitHub</div>
              <div className="mb-chat-auth-desc">
                Go to the URL below and enter the code to authorize.
              </div>
              <button
                className="mb-device-flow-url"
                onClick={() => { if (deviceFlow.verificationUri) openUrl(deviceFlow.verificationUri); }}
              >
                {deviceFlow.verificationUri}
              </button>
              <div className="mb-device-flow-code">{deviceFlow.userCode}</div>
              <div className="mb-chat-auth-desc" style={{ fontSize: 12 }}>
                Waiting for authorization…
              </div>
            </>
          ) : (
            <>
              <div className="mb-empty-icon">🤖</div>
              <div className="mb-chat-auth-title">Sign in to use Copilot</div>
              <div className="mb-chat-auth-desc">
                Connect your GitHub Copilot account to start chatting.
              </div>
              <button className="mb-btn" onClick={handleSignIn}>
                Sign in with GitHub
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const currentModel = models.find(m => m.id === model) ?? { name: model };

  return (
    <div className="mb-chat">
      <div className="mb-header">
        <span className="mb-header-title">Copilot</span>
        <button
          className="mb-icon-btn"
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, background: 'var(--mb-surface2)', color: 'var(--mb-muted)' }}
          onClick={() => setShowModelPicker(v => !v)}
        >
          {currentModel.name} ▾
        </button>
        <button className="mb-icon-btn" onClick={handleSignOut} title="Sign out" style={{ fontSize: 14, color: 'var(--mb-muted)' }}>
          ⊘
        </button>
      </div>

      {/* Model picker dropdown */}
      {showModelPicker && (
        <div style={{
          background: 'var(--mb-surface)',
          border: '1px solid var(--mb-border)',
          borderRadius: 10,
          margin: '0 12px',
          padding: '8px 0',
          position: 'relative',
          zIndex: 20,
          maxHeight: 220,
          overflowY: 'auto',
        }}>
          {models.map(m => (
            <button
              key={m.id}
              onClick={() => { setModel(m.id); setShowModelPicker(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '9px 16px',
                background: m.id === model ? 'rgba(79,163,224,0.12)' : 'none',
                border: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                color: 'var(--mb-text)',
                fontSize: 14,
                gap: 8,
              }}
            >
              <span style={{ flex: 1 }}>{m.name}</span>
              {m.multiplier === 0 && <span style={{ fontSize: 11, color: 'var(--mb-accent2)' }}>free</span>}
              {m.multiplier > 1 && <span style={{ fontSize: 11, color: 'var(--mb-muted)' }}>{m.multiplier}×</span>}
            </button>
          ))}
        </div>
      )}

      {/* File context indicator */}
      {contextFilePath && (
        <div className="mb-context-pill">
          <span className="mb-context-pill-dot" />
          <span>Context: {contextFilePath.split('/').pop()}</span>
        </div>
      )}

      {/* Messages */}
      <div className="mb-chat-messages">
        {messages.length === 0 && !streaming && (
          <div style={{ textAlign: 'center', color: 'var(--mb-muted)', fontSize: 13, padding: '40px 16px', lineHeight: 1.6 }}>
            Ask anything about your workspace
            {contextFilePath ? ` or ${contextFilePath.split('/').pop()}` : ''}.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`mb-msg ${msg.role === 'user' ? 'mb-msg-user' : 'mb-msg-assistant'}`}
          >
            {msg.content}
          </div>
        ))}
        {streaming && streamingText && (
          <div className="mb-msg mb-msg-assistant mb-msg-streaming">
            {streamingText}
          </div>
        )}
        {streaming && !streamingText && (
          <div style={{ display: 'flex', padding: '4px 8px' }}>
            <div className="mb-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          </div>
        )}
        {error && (
          <div className="mb-chat-error">{error}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Groq key setup (shown when tapping mic without a key) */}
      {showGroqSetup && (
        <div className="mb-groq-setup">
          <p>Enter your <a href="https://console.groq.com" style={{ color: 'var(--mb-accent)' }}>Groq API key</a> for voice input:</p>
          <div className="mb-groq-row">
            <input
              className="mb-groq-input"
              type="password"
              placeholder="gsk_..."
              value={groqKeyInput}
              onChange={e => setGroqKeyInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveGroq()}
            />
            <button className="mb-btn" style={{ padding: '8px 14px', fontSize: 13 }} onClick={saveGroq}>Save</button>
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="mb-chat-input-area">
        <button
          className={`mb-chat-voice ${isRecording ? 'recording' : ''}`}
          onClick={handleVoice}
          title={isRecording ? 'Stop recording' : 'Voice input'}
          disabled={isTranscribing}
        >
          {isTranscribing ? '…' : isRecording ? '⏹' : '🎤'}
        </button>
        <textarea
          ref={textareaRef}
          className="mb-chat-textarea"
          rows={1}
          placeholder="Message Copilot…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="mb-chat-send"
          onClick={handleSend}
          disabled={!input.trim() || streaming}
        >
          {streaming ? '⏸' : '↑'}
        </button>
      </div>
    </div>
  );
}
