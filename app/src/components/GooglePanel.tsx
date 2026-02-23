import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  isGoogleConnected,
  startGoogleAuth,
  clearTokens,
  getStoredTokens,
  listDriveBackups,
  backupFileToDrive,
  downloadFromDrive,
  markdownToSlideOutline,
  createSlidesPresentation,
  openInBrowser,
  type DriveFile,
  type GoogleTokens,
} from '../services/google';
import './GooglePanel.css';

interface GooglePanelProps {
  open: boolean;
  onClose: () => void;
  /** Currently open file in the editor (relative path) */
  activeFile: string | null;
  /** Current document content */
  content: string;
  /** Called when the user restores a file from Drive */
  onRestoreContent: (content: string, filename: string) => void;
}

export default function GooglePanel({
  open,
  onClose,
  activeFile,
  content,
  onRestoreContent,
}: GooglePanelProps) {
  const [connected, setConnected]       = useState(isGoogleConnected);
  const [email, setEmail]               = useState<string | null>(() => getStoredTokens()?.email ?? null);
  const [authStatus, setAuthStatus]     = useState<'idle' | 'waiting' | 'error'>('idle');
  const [authError, setAuthError]       = useState<string | null>(null);

  // Drive
  const [driveFiles, setDriveFiles]     = useState<DriveFile[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveMsg, setDriveMsg]         = useState<string | null>(null);

  // Slides
  type SlidesStatus = 'idle' | 'generating' | 'done' | 'error';
  const [slidesStatus, setSlidesStatus] = useState<SlidesStatus>('idle');
  const [slidesUrl, setSlidesUrl]       = useState<string | null>(null);
  const [slidesEmbed, setSlidesEmbed]   = useState<string | null>(null);
  const [showEmbed, setShowEmbed]       = useState(false);
  const [slidesError, setSlidesError]   = useState<string | null>(null);

  const loadDriveFiles = useCallback(async () => {
    setDriveLoading(true);
    try {
      setDriveFiles(await listDriveBackups());
    } catch (err) {
      console.error('Drive list error:', err);
    } finally {
      setDriveLoading(false);
    }
  }, []);

  // Load Drive files when panel opens (if connected)
  useEffect(() => {
    if (open && connected) loadDriveFiles();
  }, [open, connected, loadDriveFiles]);

  // ── Auth ─────────────────────────────────────────────────────
  async function handleConnect() {
    setAuthStatus('waiting');
    setAuthError(null);
    try {
      const tokens: GoogleTokens = await startGoogleAuth();
      setConnected(true);
      setEmail(tokens.email ?? null);
      setAuthStatus('idle');
      loadDriveFiles();
    } catch (err) {
      setAuthStatus('error');
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDisconnect() {
    clearTokens();
    setConnected(false);
    setEmail(null);
    setDriveFiles([]);
    setSlidesUrl(null);
    setSlidesEmbed(null);
    setShowEmbed(false);
  }

  // ── Drive ────────────────────────────────────────────────────
  async function handleBackup() {
    if (!activeFile || !content) return;
    setDriveMsg('Backing up…');
    try {
      await backupFileToDrive(activeFile, content);
      setDriveMsg('✓ Backed up');
      loadDriveFiles();
    } catch (err) {
      setDriveMsg(`⚠ ${err instanceof Error ? err.message : 'Backup failed'}`);
    }
    setTimeout(() => setDriveMsg(null), 3000);
  }

  async function handleRestore(file: DriveFile) {
    try {
      const text = await downloadFromDrive(file.id);
      onRestoreContent(text, file.name);
      onClose();
    } catch (err) {
      alert(`Restore failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Slides ───────────────────────────────────────────────────
  async function handleGenerateSlides() {
    setSlidesStatus('generating');
    setSlidesUrl(null);
    setSlidesEmbed(null);
    setSlidesError(null);
    setShowEmbed(false);
    try {
      const { presentationTitle, slides } = markdownToSlideOutline(content);
      if (slides.length === 0) {
        throw new Error(
          'No ## headings found in this document.\nAdd ## sections to create slides.',
        );
      }
      const result = await createSlidesPresentation(presentationTitle, slides);
      setSlidesUrl(result.url);
      setSlidesEmbed(result.embedUrl);
      setSlidesStatus('done');
    } catch (err) {
      setSlidesStatus('error');
      setSlidesError(err instanceof Error ? err.message : String(err));
      setTimeout(() => { setSlidesStatus('idle'); setSlidesError(null); }, 5000);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="gpanel-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="gpanel-modal">

        {/* ── Header ── */}
        <div className="gpanel-header">
          <span className="gpanel-header-left">
            <span className="gpanel-icon">⊡</span>
            <span className="gpanel-title">Google</span>
          </span>
          <button className="gpanel-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* ── Body ── */}
        <div className="gpanel-body">

          {!connected ? (
            /* ─────────── Not connected ─────────── */
            <div className="gpanel-connect">
              <p className="gpanel-desc">
                Connect your Google account to back up Markdown files to Drive
                and generate presentations in Google Slides.
              </p>
              <p className="gpanel-scopes-note">
                Requires: <code>drive.file</code> (your files only) ·{' '}
                <code>presentations</code>
              </p>
              <button
                className="gpanel-btn gpanel-btn-primary"
                onClick={handleConnect}
                disabled={authStatus === 'waiting'}
              >
                {authStatus === 'waiting'
                  ? <><span className="gpanel-spinner" />&nbsp;Waiting for Google…</>
                  : 'Connect Google Account'}
              </button>
              {authStatus === 'waiting' && (
                <p className="gpanel-hint">Complete the sign-in in your browser, then return here.</p>
              )}
              {authStatus === 'error' && authError && (
                <p className="gpanel-error">{authError}</p>
              )}
            </div>
          ) : (
            /* ─────────── Connected ─────────── */
            <>
              {/* Account row */}
              <div className="gpanel-account">
                <span className="gpanel-account-dot" />
                <span className="gpanel-account-email">{email ?? 'Connected'}</span>
                <button className="gpanel-btn gpanel-btn-ghost" onClick={handleDisconnect}>
                  Disconnect
                </button>
              </div>

              <div className="gpanel-divider" />

              {/* ── Drive ── */}
              <section className="gpanel-section">
                <div className="gpanel-section-header">
                  <span className="gpanel-section-title">Drive Backup</span>
                  <button
                    className="gpanel-btn gpanel-btn-sm"
                    onClick={handleBackup}
                    disabled={!activeFile || !!driveMsg}
                    title={activeFile ? `Backup "${activeFile}" to Drive` : 'Open a file first'}
                  >
                    {driveMsg ?? 'Backup current file'}
                  </button>
                </div>

                {driveLoading ? (
                  <p className="gpanel-muted">Loading…</p>
                ) : driveFiles.length === 0 ? (
                  <p className="gpanel-muted">No backups yet.</p>
                ) : (
                  <ul className="gpanel-file-list">
                    {driveFiles.map((f) => (
                      <li key={f.id} className="gpanel-file-item">
                        <span className="gpanel-file-icon">◎</span>
                        <span className="gpanel-file-name">{f.name}</span>
                        <span className="gpanel-file-date">
                          {new Date(f.modifiedTime).toLocaleDateString()}
                        </span>
                        <button
                          className="gpanel-btn gpanel-btn-xs"
                          onClick={() => handleRestore(f)}
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="gpanel-divider" />

              {/* ── Slides ── */}
              <section className="gpanel-section">
                <div className="gpanel-section-header">
                  <span className="gpanel-section-title">Google Slides</span>
                  <button
                    className="gpanel-btn gpanel-btn-sm"
                    onClick={handleGenerateSlides}
                    disabled={!content || slidesStatus === 'generating'}
                  >
                    {slidesStatus === 'generating'
                      ? <><span className="gpanel-spinner" />&nbsp;Generating…</>
                      : 'Generate from document'}
                  </button>
                </div>

                <p className="gpanel-muted">
                  Each <code>## Heading</code> in your document becomes a slide.
                </p>

                {slidesStatus === 'error' && slidesError && (
                  <p className="gpanel-error" style={{ whiteSpace: 'pre-line' }}>{slidesError}</p>
                )}

                {slidesStatus === 'done' && slidesUrl && (
                  <div className="gpanel-slides-result">
                    <div className="gpanel-slides-actions">
                      <button
                        className="gpanel-btn gpanel-btn-primary"
                        onClick={() => openInBrowser(slidesUrl)}
                      >
                        Open in Google Slides ↗
                      </button>
                      <button
                        className="gpanel-btn gpanel-btn-ghost"
                        onClick={() => setShowEmbed((v) => !v)}
                      >
                        {showEmbed ? 'Hide preview' : 'Preview'}
                      </button>
                    </div>
                    {showEmbed && slidesEmbed && (
                      <iframe
                        className="gpanel-slides-embed"
                        src={slidesEmbed}
                        title="Presentation preview"
                        allowFullScreen
                      />
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
