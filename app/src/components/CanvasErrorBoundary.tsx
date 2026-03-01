/**
 * CanvasErrorBoundary
 *
 * Wraps the tldraw CanvasEditor. Catches any unhandled React render errors that
 * would otherwise bubble up and trigger Tauri's "reload app?" dialog.
 *
 * Recovery options offered to the user:
 *   1. Restore from the last git commit (`git checkout HEAD -- <relPath>`).
 *   2. Start fresh — clears the file to an empty canvas and reopens it.
 */

import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeFile as tauriWriteFile } from '../services/fs';

interface Props {
  /** Absolute workspace path — used as cwd for git commands. */
  workspacePath: string;
  /** Relative path of the canvas file, e.g. "deck.tldr.json". */
  canvasRelPath: string;
  /**
   * Called after a successful recovery so the parent can reload the file
   * content and remount the editor with the recovered data.
   */
  onRecovered: () => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  recovering: boolean;
  recoveryStatus: string | null;
}

export class CanvasErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '', recovering: false, recoveryStatus: null };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[CanvasErrorBoundary] tldraw error caught:', error, info.componentStack);
  }

  private async restoreFromGit() {
    const { workspacePath, canvasRelPath } = this.props;
    this.setState({ recovering: true, recoveryStatus: null });
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        'shell_run',
        { cmd: `git checkout HEAD -- "${canvasRelPath}"`, cwd: workspacePath },
      );
      if (result.exit_code !== 0) {
        this.setState({ recovering: false, recoveryStatus: `Git restore failed:\n${result.stderr || result.stdout}` });
        return;
      }
      this.setState({ hasError: false, errorMessage: '', recovering: false, recoveryStatus: null });
      this.props.onRecovered();
    } catch (err) {
      this.setState({ recovering: false, recoveryStatus: `Error: ${String(err)}` });
    }
  }

  private async clearCanvas() {
    const { workspacePath, canvasRelPath } = this.props;
    this.setState({ recovering: true, recoveryStatus: null });
    try {
      const absPath = `${workspacePath}/${canvasRelPath}`;
      await tauriWriteFile(absPath, new TextEncoder().encode(''));
      this.setState({ hasError: false, errorMessage: '', recovering: false, recoveryStatus: null });
      this.props.onRecovered();
    } catch (err) {
      this.setState({ recovering: false, recoveryStatus: `Error: ${String(err)}` });
    }
  }

  render() {
    const { hasError, errorMessage, recovering, recoveryStatus } = this.state;

    if (!hasError) return this.props.children;

    const fileName = this.props.canvasRelPath.split('/').pop() ?? this.props.canvasRelPath;

    return (
      <div className="canvas-error-boundary">
        <div className="canvas-error-inner">
          <div className="canvas-error-icon">⚠</div>
          <div className="canvas-error-title">Canvas error</div>
          <div className="canvas-error-file">{fileName}</div>
          <div className="canvas-error-msg">{errorMessage}</div>

          <div className="canvas-error-actions">
            <button
              className="canvas-error-btn canvas-error-btn--primary"
              onClick={() => this.restoreFromGit()}
              disabled={recovering}
            >
              {recovering ? 'Restoring…' : '↩ Restore from last git commit'}
            </button>
            <button
              className="canvas-error-btn canvas-error-btn--danger"
              onClick={() => this.clearCanvas()}
              disabled={recovering}
            >
              Start fresh (clear file)
            </button>
          </div>

          {recoveryStatus && (
            <pre className="canvas-error-status">{recoveryStatus}</pre>
          )}

          <div className="canvas-error-hint">
            The editor encountered an unexpected error and was paused to prevent data loss.
            Other files and the rest of the app are unaffected.
          </div>
        </div>
      </div>
    );
  }
}
