import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { saveApiSecret } from '../services/apiSecrets';

// ── Groq key storage ──────────────────────────────────────────────────────────
const GROQ_KEY_STORAGE = 'cafezin-groq-key';
export function getGroqKey(): string { return localStorage.getItem(GROQ_KEY_STORAGE) ?? ''; }
export function saveGroqKey(k: string) { void saveApiSecret(GROQ_KEY_STORAGE, k.trim()); }

// ── useVoiceInput ─────────────────────────────────────────────────────────────
interface UseVoiceInputParams {
  onTranscript: (text: string) => void;
  onError: (msg: string) => void;
}

export function useVoiceInput({ onTranscript, onError }: UseVoiceInputParams) {
  const [isRecording, setIsRecording]     = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [groqKey, setGroqKey]             = useState(() => getGroqKey());
  const [showGroqSetup, setShowGroqSetup] = useState(false);
  const [groqKeyInput, setGroqKeyInput]   = useState('');

  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const audioChunksRef    = useRef<Blob[]>([]);
  const micPermissionRef  = useRef(false);
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const analyserRef       = useRef<AnalyserNode | null>(null);
  const animFrameRef      = useRef<number>(0);
  const vizCanvasRef      = useRef<HTMLCanvasElement>(null);

  // ── Frequency visualizer ──────────────────────────────────────────────────
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

  // ── Mic permission warm-up ────────────────────────────────────────────────
  // Call getUserMedia once as soon as a Groq key exists, then immediately
  // stop the tracks. This registers the permission with macOS/WKWebView so
  // subsequent recording clicks don't re-show the system prompt.
  const warmUpMicPermission = useCallback(async () => {
    if (micPermissionRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      micPermissionRef.current = true;
    } catch { /* denied — will surface on actual record click */ }
  }, []);

  useEffect(() => {
    if (groqKey) warmUpMicPermission();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groqKey]);

  // ── Recording ─────────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (!groqKey) { setShowGroqSetup(true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                      : MediaRecorder.isTypeSupported('audio/ogg')  ? 'audio/ogg'
                      : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(animFrameRef.current);
        analyserRef.current = null;
        // Close the AudioContext to free OS-level audio resources.
        // WebKit caps open AudioContext instances at ~6; without close() each recording
        // session leaks one context until the visualiser silently fails.
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        const cv = vizCanvasRef.current;
        if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
        setIsRecording(false);
        setIsTranscribing(true);
        try {
          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          const arrayBuf = await blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuf);
          let binary = '';
          uint8.forEach((b) => (binary += String.fromCharCode(b)));
          const b64 = btoa(binary);
          const transcript = await invoke<string>('transcribe_audio', {
            audioBase64: b64,
            mimeType,
            apiKey: groqKey,
          });
          onTranscript(transcript);
        } catch (err) {
          onError(`Transcription failed: ${err}`);
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
      onError(`Microphone access denied: ${err}`);
    }
  }, [groqKey, drawViz, onTranscript, onError]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  const handleMicClick = useCallback(() => {
    if (!groqKey) { setShowGroqSetup(true); return; }
    if (isRecording) stopRecording();
    else startRecording();
  }, [groqKey, isRecording, startRecording, stopRecording]);

  function saveGroqKeyAndClose() {
    saveGroqKey(groqKeyInput);
    setGroqKey(groqKeyInput.trim());
    setShowGroqSetup(false);
    setGroqKeyInput('');
    warmUpMicPermission();
  }

  return {
    isRecording,
    isTranscribing,
    groqKey,
    showGroqSetup,
    setShowGroqSetup,
    groqKeyInput,
    setGroqKeyInput,
    vizCanvasRef,
    handleMicClick,
    saveGroqKeyAndClose,
    warmUpMicPermission,
  };
}
