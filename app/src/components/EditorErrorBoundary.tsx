/**
 * EditorErrorBoundary
 *
 * Wraps the text/code editor, markdown preview, PDF viewer, and media viewers.
 * Catches unhandled React render errors that would otherwise bubble up and
 * trigger Tauri's "reload app?" dialog.
 *
 * Recovery options:
 *   1. Reload file — re-opens the file from disk, resetting the viewer.
 *   2. Close tab   — closes the file tab so the user can continue working.
 */

import React from 'react';

interface Props {
  /** Relative path of the active file, e.g. "notes/readme.md". */
  activeFile: string | null;
  /** Called when the user wants to reload the file from disk. */
  onReload: (file: string) => void;
  /** Called when the user wants to close the tab. */
  onClose: (file: string) => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class EditorErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[EditorErrorBoundary] render error caught:', error, info.componentStack);
  }

  /** Reset boundary so children can re-render (called after onReload). */
  reset() {
    this.setState({ hasError: false, errorMessage: '' });
  }

  render() {
    const { hasError, errorMessage } = this.state;
    const { activeFile, onReload, onClose, children } = this.props;

    if (!hasError) return children;

    const fileName = activeFile?.split('/').pop() ?? activeFile ?? 'file';

    return (
      <div className="editor-error-boundary">
        <div className="editor-error-boundary__card">
          <div className="editor-error-boundary__icon">⚠️</div>
          <h3 className="editor-error-boundary__title">Failed to render "{fileName}"</h3>
          {errorMessage && (
            <p className="editor-error-boundary__message">{errorMessage}</p>
          )}
          <div className="editor-error-boundary__actions">
            {activeFile && (
              <button
                className="editor-error-boundary__btn editor-error-boundary__btn--primary"
                onClick={() => {
                  this.reset();
                  onReload(activeFile);
                }}
              >
                Reload file
              </button>
            )}
            {activeFile && (
              <button
                className="editor-error-boundary__btn editor-error-boundary__btn--secondary"
                onClick={() => onClose(activeFile)}
              >
                Close tab
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
