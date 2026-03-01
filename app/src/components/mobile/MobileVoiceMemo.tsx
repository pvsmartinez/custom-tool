import { useState, useEffect, useRef, useCallback } from 'react';
import { saveApiSecret } from '../../services/apiSecrets';
import { invoke } from '@tauri-apps/api/core';
import {
  readDir,
  readFile,
  readTextFile,
  writeFile,
  mkdir,
} from '../../services/fs';

// ── Constants ─────────────────────────────────────────────────────────────────
const GROQ_KEY_STORAGE = 'cafezin-groq-key';
const MEMO_DIR_NAME    = '.cafezin/voice-memos';

// ── Types ─────────────────────────────────────────────────────────────────────
interface MemoRecord {
  stem: string;         // e.g. "memo_2026-02-28_14-30-00"
  audioExt: string;     // "webm" | "ogg" | "m4a"
  audioPath: string;
  transcriptPath: string;
  hasTranscript: boolean;
  timestamp: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pad(n: number): string { return String(n).padStart(2, '0'); }

function nowStem(): string {
  const d = new Date();
  return `memo_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function parseStemDate(stem: string): Date {
  // stem = "memo_YYYY-MM-DD_HH-mm-ss"
  const body = stem.replace(/^memo_/, '');
  // "2026-02-28_14-30-00" → "2026-02-28T14:30:00"
  const iso = body.replace(/_(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function formatDuration(s: number): string {
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// ── VoiceMemoItem ─────────────────────────────────────────────────────────────
function VoiceMemoItem({ memo, onDelete }: { memo: MemoRecord; onDelete: () => void }) {
  const [expanded,    setExpanded]    = useState(false);
  const [transcript,  setTranscript]  = useState<string | null>(null);
  const [audioSrc,    setAudioSrc]    = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  // Revoke blob URL on unmount to avoid memory leaks
  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
  }, []);

  async function toggleExpand() {
    if (!expanded) {
      setLoadingBody(true);
      try {
        // Load transcript
        if (memo.hasTranscript && transcript === null) {
          try { setTranscript(await readTextFile(memo.transcriptPath)); }
          catch { setTranscript('(transcript unavailable)'); }
        }
        // Load audio as Blob URL
        if (audioSrc === null) {
          try {
            const bytes = await readFile(memo.audioPath);
            const mimeMap: Record<string, string> = {
              webm: 'audio/webm', ogg: 'audio/ogg',
              m4a: 'audio/mp4', mp4: 'audio/mp4',
            };
            const mime = mimeMap[memo.audioExt] ?? 'audio/webm';
            const blob = new Blob([bytes], { type: mime });
            const url  = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            setAudioSrc(url);
          } catch { /* no audio */ }
        }
      } finally { setLoadingBody(false); }
    }
    setExpanded(v => !v);
  }

  const date = memo.timestamp;
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mb-memo-item">
      <button className="mb-memo-header" onClick={toggleExpand}>
        <div className="mb-memo-meta">
          <span className="mb-memo-date">{dateStr}</span>
          <span className="mb-memo-time">{timeStr}</span>
        </div>
        <span className="mb-memo-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mb-memo-body">
          {loadingBody ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
              <div className="mb-spinner" />
            </div>
          ) : (
            <>
              {audioSrc && (
                /* eslint-disable-next-line jsx-a11y/media-has-caption */
                <audio controls src={audioSrc} className="mb-memo-audio" />
              )}
              {transcript !== null && (
                <p className="mb-memo-transcript">{transcript}</p>
              )}
            </>
          )}
          <button className="mb-memo-delete" onClick={onDelete} title="Delete memo">
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
interface MobileVoiceMemoProps {
  workspacePath: string;
}

export default function MobileVoiceMemo({ workspacePath }: MobileVoiceMemoProps) {
  const memoDir = `${workspacePath}/${MEMO_DIR_NAME}`;

  const [groqKey,       setGroqKey]       = useState(() => localStorage.getItem(GROQ_KEY_STORAGE) ?? '');
  const [groqInput,     setGroqInput]     = useState('');
  const [showKeySetup,  setShowKeySetup]  = useState(false);

  const [memos,         setMemos]         = useState<MemoRecord[]>([]);
  const [loadingMemos,  setLoadingMemos]  = useState(false);

  const [recording,     setRecording]     = useState(false);
  const [transcribing,  setTranscribing]  = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [error,         setError]         = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load memos from disk ──────────────────────────────────────────────────
  const loadMemos = useCallback(async () => {
    setLoadingMemos(true);
    try {
      const entries = await readDir(memoDir).catch(() => []);
      const map = new Map<string, { audioExt?: string; hasTranscript: boolean }>();

      for (const entry of entries) {
        if (!entry.name) continue;
        const dot  = entry.name.lastIndexOf('.');
        if (dot < 0) continue;
        const stem = entry.name.slice(0, dot);
        const ext  = entry.name.slice(dot + 1).toLowerCase();

        if (!map.has(stem)) map.set(stem, { hasTranscript: false });
        const rec = map.get(stem)!;
        if (['webm', 'ogg', 'm4a', 'mp4'].includes(ext)) rec.audioExt = ext;
        if (ext === 'txt') rec.hasTranscript = true;
      }

      const list: MemoRecord[] = [];
      for (const [stem, info] of map) {
        if (!info.audioExt) continue;
        list.push({
          stem,
          audioExt:       info.audioExt,
          audioPath:      `${memoDir}/${stem}.${info.audioExt}`,
          transcriptPath: `${memoDir}/${stem}.txt`,
          hasTranscript:  info.hasTranscript,
          timestamp:      parseStemDate(stem),
        });
      }
      list.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setMemos(list);
    } finally {
      setLoadingMemos(false);
    }
  }, [memoDir]);

  useEffect(() => { loadMemos(); }, [loadMemos]);

  // ── Recording ─────────────────────────────────────────────────────────────
  async function startRecording() {
    if (!groqKey) { setShowKeySetup(true); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                     : MediaRecorder.isTypeSupported('audio/ogg')  ? 'audio/ogg'
                     : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        handleRecordingStop(mimeType);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(200);
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
    } catch (err) {
      setError(`Microphone error: ${err}`);
    }
  }

  function stopRecording() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }

  async function handleRecordingStop(mimeType: string) {
    setTranscribing(true);
    setError(null);
    try {
      const ext  = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'm4a';
      const stem = nowStem();

      const blob     = new Blob(audioChunksRef.current, { type: mimeType });
      const arrayBuf = await blob.arrayBuffer();
      const uint8    = new Uint8Array(arrayBuf);

      // Base64 encode for Tauri command
      let binary = '';
      uint8.forEach(b => (binary += String.fromCharCode(b)));
      const b64 = btoa(binary);

      // Transcribe via Groq Whisper
      const transcript = await invoke<string>('transcribe_audio', {
        audioBase64: b64,
        mimeType,
        apiKey: groqKey,
      });

      // Ensure directory exists
      await mkdir(memoDir, { recursive: true }).catch(() => {});

      // Save audio bytes
      await writeFile(`${memoDir}/${stem}.${ext}`, uint8);

      // Save transcript
      await writeFile(`${memoDir}/${stem}.txt`, new TextEncoder().encode(transcript));

      await loadMemos();
    } catch (err) {
      setError(`Recording failed: ${err}`);
    } finally {
      setTranscribing(false);
    }
  }

  // ── Delete memo ───────────────────────────────────────────────────────────
  async function deleteMemo(memo: MemoRecord) {
    // We use writeFile with empty bytes to effectively remove — Tauri FS doesn't
    // have a top-level remove() in all versions; we use dynamic import as fallback.
    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(memo.audioPath).catch(() => {});
      if (memo.hasTranscript) await remove(memo.transcriptPath).catch(() => {});
    } catch {
      // If remove isn't available, just reload (files remain but won't auto-delete)
    }
    await loadMemos();
  }

  // ── Groq key ──────────────────────────────────────────────────────────────
  function saveGroqKey() {
    const key = groqInput.trim();
    if (!key) return;
    void saveApiSecret(GROQ_KEY_STORAGE, key);
    setGroqKey(key);
    setGroqInput('');
    setShowKeySetup(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="mb-header">
        <span className="mb-header-title">Voice Memos</span>
        <button
          className="mb-icon-btn"
          onClick={() => setShowKeySetup(v => !v)}
          title="Groq API key settings"
        >
          {groqKey ? '🔑' : '⚙️'}
        </button>
      </div>

      <div className="mb-voice-scroll">
        {/* ── Groq key setup ── */}
        {(showKeySetup || !groqKey) && (
          <div className="mb-voice-key-setup">
            <p className="mb-voice-key-hint">
              Voice transcription uses{' '}
              <a
                href="https://console.groq.com/keys"
                style={{ color: 'var(--mb-accent)' }}
                onClick={e => {
                  e.preventDefault();
                  import('@tauri-apps/plugin-opener').then(m => m.openUrl('https://console.groq.com/keys'));
                }}
              >
                Groq Whisper
              </a>
              . Enter your free API key:
            </p>
            <div className="mb-voice-key-row">
              <input
                type="password"
                className="mb-input"
                value={groqInput}
                onChange={e => setGroqInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveGroqKey()}
                placeholder="gsk_…"
              />
              <button
                className="mb-btn mb-btn-primary"
                onClick={saveGroqKey}
                disabled={!groqInput.trim()}
              >
                Save
              </button>
            </div>
            {groqKey && (
              <button
                className="mb-btn mb-btn-ghost"
                onClick={() => setShowKeySetup(false)}
                style={{ fontSize: 12 }}
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {/* ── Record area ── */}
        {groqKey && !showKeySetup && (
          <div className="mb-voice-record-area">
            {transcribing ? (
              <div className="mb-voice-transcribing">
                <div className="mb-spinner" />
                <span>Transcribing with Whisper…</span>
              </div>
            ) : (
              <button
                className={`mb-record-btn${recording ? ' recording' : ''}`}
                onClick={recording ? stopRecording : startRecording}
                aria-label={recording ? 'Stop recording' : 'Start recording'}
              >
                {recording ? '⏹' : '🎙'}
              </button>
            )}

            {recording && (
              <div className="mb-record-timer">{formatDuration(recordSeconds)}</div>
            )}

            {!recording && !transcribing && (
              <div className="mb-voice-hint">
                {error ? (
                  <span style={{ color: 'var(--mb-danger)' }}>{error}</span>
                ) : (
                  <span>Tap to record</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Memo list ── */}
        {loadingMemos && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <div className="mb-spinner" />
          </div>
        )}

        {!loadingMemos && memos.length === 0 && groqKey && !showKeySetup && (
          <div className="mb-empty" style={{ paddingTop: 24 }}>
            <div className="mb-empty-icon">🎙</div>
            <div className="mb-empty-desc">No memos yet — tap the button to record.</div>
          </div>
        )}

        {memos.map(memo => (
          <VoiceMemoItem
            key={memo.stem}
            memo={memo}
            onDelete={() => deleteMemo(memo)}
          />
        ))}
      </div>
    </>
  );
}
