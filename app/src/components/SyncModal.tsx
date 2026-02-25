import { useState, useEffect } from 'react';
import { X, Warning } from '@phosphor-icons/react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import './SyncModal.css';

interface SyncModalProps {
  open: boolean;
  workspacePath: string;
  onConfirm: (message: string) => Promise<void>;
  onClose: () => void;
}

interface DiffResult {
  files: string[];
  diff: string;
}

// Parse a "git status --short" line into flag + filename
function parseStatusLine(line: string): { flag: string; file: string } {
  const flag = line.slice(0, 2).trim();
  const file = line.slice(3);
  return { flag, file };
}

function StatusFlag({ flag }: { flag: string }) {
  const cls =
    flag === 'M' || flag === 'MM' ? 'sm-flag--modified' :
    flag === 'A' || flag === 'AM' ? 'sm-flag--added' :
    flag === 'D' ? 'sm-flag--deleted' :
    flag === '??' ? 'sm-flag--untracked' :
    flag === 'R' ? 'sm-flag--renamed' :
    'sm-flag--other';
  const label =
    flag === 'M' || flag === 'MM' ? 'M' :
    flag === 'A' || flag === 'AM' ? 'A' :
    flag === 'D' ? 'D' :
    flag === '??' ? 'U' :
    flag === 'R' ? 'R' :
    flag;
  return <span className={`sm-flag ${cls}`}>{label}</span>;
}

// Render a unified diff with syntax-highlighted lines
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return null;

  return (
    <div className="sm-diff">
      {diff.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---') ? 'sm-diff-file' :
          line.startsWith('+') ? 'sm-diff-add' :
          line.startsWith('-') ? 'sm-diff-del' :
          line.startsWith('@@') ? 'sm-diff-hunk' :
          line.startsWith('diff ') || line.startsWith('index ') ? 'sm-diff-meta' :
          'sm-diff-ctx';
        return (
          <div key={i} className={`sm-diff-line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

export default function SyncModal({ open, workspacePath, onConfirm, onClose }: SyncModalProps) {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [reverting, setReverting] = useState<Set<string>>(new Set());

  function fetchDiff() {
    setResult(null);
    setError(null);
    setLoading(true);
    invoke<DiffResult>('git_diff', { path: workspacePath })
      .then((r) => setResult(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  // Fetch diff when modal opens
  useEffect(() => {
    if (!open) return;
    setSyncing(false);
    setReverting(new Set());
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    setCommitMsg(`sync: ${ts}`);
    fetchDiff();
  }, [open, workspacePath]);

  async function handleRevert(file: string) {
    setReverting((prev) => new Set([...prev, file]));
    try {
      await invoke('git_checkout_file', { path: workspacePath, file });
      // Re-fetch diff to reflect the revert
      fetchDiff();
    } catch (e) {
      setError(`Revert failed: ${String(e)}`);
    } finally {
      setReverting((prev) => { const next = new Set(prev); next.delete(file); return next; });
    }
  }

  if (!open) return null;

  async function handleConfirm() {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      await onConfirm(commitMsg || `sync: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
      onClose();
    } catch (e) {
      setError(String(e));
      setSyncing(false);
    }
  }

  const hasChanges = (result?.files.length ?? 0) > 0;

  return createPortal(
    <div className="sm-overlay" onClick={(e) => { if (e.target === e.currentTarget && !syncing) onClose(); }}>
      <div className="sm-modal">
        {/* Header */}
        <div className="sm-header">
          <span className="sm-title">
            ⇅ Sync changes
            {result && (
              <span className="sm-file-count">
                {result.files.length} file{result.files.length !== 1 ? 's' : ''}
              </span>
            )}
          </span>
          <button className="sm-close" onClick={onClose} disabled={syncing}><X weight="thin" size={14} /></button>
        </div>

        {/* Body */}
        <div className="sm-body">
          {loading && (
            <div className="sm-loading">Fetching changes…</div>
          )}

          {!loading && error && (
            <div className="sm-error"><Warning weight="thin" size={14} /> {error}</div>
          )}

          {!loading && result && (
            <>
              {/* File list */}
              {result.files.length === 0 ? (
                <div className="sm-empty">Nothing to sync — working tree is clean.</div>
              ) : (
                <div className="sm-files">
                  <div className="sm-section-label">Changed files</div>
                  {result.files.map((line, i) => {
                    const { flag, file } = parseStatusLine(line);
                    const isReverting = reverting.has(file);
                    return (
                      <div key={i} className="sm-file-row">
                        <StatusFlag flag={flag} />
                        <span className="sm-file-name">{file}</span>
                        {flag !== '??' && (
                          <button
                            className={`sm-revert-btn${isReverting ? ' reverting' : ''}`}
                            onClick={() => handleRevert(file)}
                            disabled={isReverting || syncing}
                            title="Discard changes"
                          >
                            {isReverting ? '…' : '↩'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Diff */}
              {result.diff.trim() && (
                <div className="sm-diff-section">
                  <div className="sm-section-label">Diff</div>
                  <DiffView diff={result.diff} />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sm-footer">
          <input
            className="sm-commit-input"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message…"
            disabled={syncing}
            onKeyDown={(e) => { if (e.key === 'Enter' && hasChanges) handleConfirm(); }}
          />
          <div className="sm-footer-actions">
            <button className="sm-btn sm-btn-cancel" onClick={onClose} disabled={syncing}>
              Cancel
            </button>
            <button
              className={`sm-btn sm-btn-confirm${syncing ? ' syncing' : ''}`}
              onClick={handleConfirm}
              disabled={syncing || loading}
            >
              {syncing ? '⇅ Syncing…' : hasChanges ? '⇅ Commit & push' : '⇅ Push'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
