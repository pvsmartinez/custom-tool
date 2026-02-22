import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import './UpdateModal.css';

type Status = 'building' | 'success' | 'error';

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

export default function UpdateModal({ open, onClose }: UpdateModalProps) {
  const [status, setStatus] = useState<Status>('building');
  const [lines, setLines] = useState<string[]>([]);
  const [countdown, setCountdown] = useState(3);
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Reset state every time the modal opens
  useEffect(() => {
    if (!open) return;
    setStatus('building');
    setLines([]);
    setCountdown(3);
    setCopied(false);
  }, [open]);

  // Subscribe to update events while open
  useEffect(() => {
    if (!open) return;

    const uls = [
      listen<string>('update:log', (e) =>
        setLines((prev) => [...prev, e.payload])
      ),
      listen('update:success', () => setStatus('success')),
      listen<string>('update:error', (e) => {
        setLines((prev) => [...prev, '', `✗  ${e.payload}`]);
        setStatus('error');
      }),
    ];

    return () => { uls.forEach((p) => p.then((fn) => fn())); };
  }, [open]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Success countdown
  useEffect(() => {
    if (status !== 'success' || countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [status, countdown]);

  async function handleCopy() {
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!open) return null;

  return createPortal(
    <div className="um-overlay">
      <div className="um-modal">

        {/* Header */}
        <div className="um-header">
          <span className="um-title">↑ Update custom-tool</span>
          {status !== 'building' && (
            <button className="um-close" onClick={onClose} title="Close">✕</button>
          )}
        </div>

        {/* Terminal log */}
        <div className="um-log">
          {lines.map((line, i) => (
            <div key={i} className="um-line">{line || '\u00a0'}</div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Status bar */}
        <div className={`um-status um-status--${status}`}>
          {status === 'building' && (
            <span className="um-spinner">⟳</span>
          )}

          {status === 'building' && ' Building… this takes 30s–2min'}

          {status === 'success' && (
            <>✓&nbsp; Done! Relaunching in {countdown}s…</>
          )}

          {status === 'error' && (
            <>
              <span>✗&nbsp; Build failed</span>
              <button
                className={`um-copy-btn ${copied ? 'um-copy-btn--done' : ''}`}
                onClick={handleCopy}
              >
                {copied ? '✓ Copied!' : 'Copy log'}
              </button>
            </>
          )}
        </div>

      </div>
    </div>,
    document.body
  );
}
