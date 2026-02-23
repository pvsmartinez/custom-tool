import type { AIEditMark } from '../types';
import './AIReviewPanel.css';

interface AIReviewPanelProps {
  open: boolean;
  marks: AIEditMark[];
  /** Relative path of the currently active file (to filter marks) */
  activeFile: string | null;
  onMarkReviewed: (id: string) => void;
  onJumpToText: (text: string) => void;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

export default function AIReviewPanel({
  open,
  marks,
  activeFile,
  onMarkReviewed,
  onJumpToText,
  onClose,
}: AIReviewPanelProps) {
  if (!open) return null;

  const pending = marks.filter(
    (m) => m.fileRelPath === activeFile && !m.reviewed,
  );

  return (
    <div className="air-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="air-panel">
        {/* Header */}
        <div className="air-header">
          <span className="air-title">✦ AI Edit Review</span>
          <span className="air-subtitle">
            {pending.length} unreviewed · {activeFile ?? 'no file'}
          </span>
          <button className="air-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        <div className="air-body">
          {pending.length === 0 ? (
            <div className="air-empty">
              <div className="air-empty-icon">✓</div>
              <div className="air-empty-msg">All AI edits reviewed</div>
            </div>
          ) : (
            pending.map((mark) => (
              <div key={mark.id} className="air-card">
                <div className="air-card-meta">
                  <span className="air-model-badge">{mark.model}</span>
                  <span className="air-time">{relativeTime(mark.insertedAt)}</span>
                </div>
                <pre className="air-text-preview">{truncate(mark.text)}</pre>
                <div className="air-card-actions">
                  <button
                    className="air-btn air-btn-jump"
                    onClick={() => onJumpToText(mark.text)}
                    title="Jump to this passage in the editor"
                  >
                    ↗ Jump to
                  </button>
                  <button
                    className="air-btn air-btn-reviewed"
                    onClick={() => onMarkReviewed(mark.id)}
                    title="Mark as reviewed"
                  >
                    ✓ Mark reviewed
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
