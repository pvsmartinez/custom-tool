import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { onTerminalEntry, emitTerminalEntry } from '../services/terminalBus';
import type { TerminalEntry } from '../services/terminalBus';
import './BottomPanel.css';

interface Props {
  workspacePath: string;
  open: boolean;
  height: number;
  onToggle: () => void;
  onHeightChange: (h: number) => void;
  /** When set, opens the panel and cd's to this absolute path. */
  requestCd?: string;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;

export default function BottomPanel({ workspacePath, open, height, onToggle, onHeightChange, requestCd }: Props) {
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState(workspacePath);
  const historyIdxRef = useRef(-1);
  const [inputHistory, setInputHistory] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartY = useRef<number>(0);
  const dragStartH = useRef<number>(0);

  // Keep cwd up to date if workspace changes
  useEffect(() => { setCwd(workspacePath); }, [workspacePath]);

  // External request to cd into a specific directory.
  // Value format: "<absPath>|<timestamp>" — the timestamp forces re-triggering
  // the same directory; strip it before using.
  useEffect(() => {
    if (!requestCd) return;
    const absDir = requestCd.includes('|') ? requestCd.split('|')[0] : requestCd;
    setCwd(absDir);
    if (!open) onToggle();
    setTimeout(() => inputRef.current?.focus(), 100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestCd]);

  // Subscribe to AI-emitted terminal entries
  useEffect(() => {
    return onTerminalEntry((entry) => {
      setEntries((prev) => [...prev, entry]);
    });
  }, []);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, open]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  // ── Resize drag ──────────────────────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartH.current = height;

    function onMove(ev: MouseEvent) {
      const delta = dragStartY.current - ev.clientY; // dragging up = bigger
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragStartH.current + delta));
      onHeightChange(newH);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height, onHeightChange]);

  // ── Run a command ────────────────────────────────────────────────────────────
  async function runCommand(cmd: string, cwd: string) {
    // Handle built-in `cd`
    const cdMatch = cmd.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      const target = cdMatch[1].trim().replace(/^~/, workspacePath);
      const newCwd = target.startsWith('/') ? target : `${cwd}/${target}`;
      setCwd(newCwd);
      const entry: Omit<TerminalEntry, 'id'> = {
        source: 'user', command: cmd, cwd,
        stdout: `[changed directory to ${newCwd}]`,
        stderr: '', exitCode: 0, ts: Date.now(),
      };
      emitTerminalEntry(entry);
      return;
    }

    setRunning(true);
    const ts = Date.now();
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        'shell_run',
        { cmd, cwd },
      );
      emitTerminalEntry({
        source: 'user', command: cmd, cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
        ts,
      });
    } catch (e) {
      emitTerminalEntry({
        source: 'user', command: cmd, cwd,
        stdout: '', stderr: String(e), exitCode: 1, ts,
      });
    } finally {
      setRunning(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd) return;
    setInputHistory((prev) => [cmd, ...prev.slice(0, 99)]);
    historyIdxRef.current = -1;
    setInput('');
    if (!open) onToggle(); // open panel if closed
    runCommand(cmd, cwd);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, inputHistory.length - 1);
      historyIdxRef.current = next;
      setInput(inputHistory[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = next;
      setInput(next === -1 ? '' : (inputHistory[next] ?? ''));
    }
  }

  // ── Short display path ───────────────────────────────────────────────────────
  function shortPath(p: string) {
    if (p === workspacePath) return '~';
    if (p.startsWith(workspacePath + '/')) return '~/' + p.slice(workspacePath.length + 1);
    const home = workspacePath.split('/').slice(0, 3).join('/'); // /Users/name
    if (p.startsWith(home)) return '~' + p.slice(home.length);
    return p;
  }

  const panelHeight = open ? height : 36;

  return (
    <div className="bottom-panel" style={{ height: panelHeight }}>

      {/* Resize grip — only visible when expanded */}
      {open && (
        <div className="bottom-panel-grip" onMouseDown={startDrag} title="Drag to resize" />
      )}

      {/* Tab row — always visible, clicking toggles open/close */}
      <div className="bottom-panel-tabrow" onClick={onToggle}>
        <div className={`bottom-panel-tab ${open ? 'active' : ''}`}>
          <span className="bottom-panel-tab-icon">⌨</span>
          Terminal
          {!open && entries.length > 0 && (() => {
            const last = entries[entries.length - 1];
            // Pick the last non-empty output line, or fall back to the command
            const lines = (last.stdout + '\n' + last.stderr)
              .split('\n')
              .map((l) => l.trimEnd())
              .filter(Boolean);
            const outputText = lines[lines.length - 1] ?? last.command;
            return (
              <span className="bottom-panel-preview">
                <span className="bottom-panel-preview-sep">›</span>
                <span className="bottom-panel-preview-text">{outputText}</span>
              </span>
            );
          })()}
        </div>
        <div className="bottom-panel-tabrow-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="bottom-panel-action-btn"
            onClick={() => setEntries([])}
            title="Clear terminal"
          >⊘</button>
          <button
            className="bottom-panel-action-btn"
            onClick={onToggle}
            title={open ? 'Collapse (⌘J)' : 'Expand (⌘J)'}
          >{open ? '⌄' : '⌃'}</button>
        </div>
      </div>

      {/* Terminal content — only visible when expanded */}
      {open && (
        <div className="bottom-panel-body">
          <div className="bottom-panel-scroll" ref={scrollRef}>
            {entries.length === 0 ? (
              <div className="bottom-panel-empty">
                No commands run yet. Type a command below or ask Copilot to run one.
              </div>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className={`bottom-panel-entry${entry.source === 'ai' ? ' ai' : ''}`}>
                  <div className="bottom-panel-cmd-row">
                    {entry.source === 'ai' && <span className="bottom-panel-source-badge">✦ AI</span>}
                    <span className="bottom-panel-prompt-path">{shortPath(entry.cwd)}</span>
                    <span className="bottom-panel-prompt-sym">$</span>
                    <span className="bottom-panel-cmd-text">{entry.command}</span>
                    <span className={`bottom-panel-exit ${entry.exitCode === 0 ? 'ok' : 'err'}`}>
                      {entry.exitCode !== 0 && `[exit ${entry.exitCode}]`}
                    </span>
                  </div>
                  {entry.stdout.trim() && (
                    <pre className="bottom-panel-output">{entry.stdout}</pre>
                  )}
                  {entry.stderr.trim() && (
                    <pre className="bottom-panel-output stderr">{entry.stderr}</pre>
                  )}
                </div>
              ))
            )}
            {running && (
              <div className="bottom-panel-running">Running…</div>
            )}
          </div>

          {/* User input */}
          <form className="bottom-panel-input-row" onSubmit={handleSubmit}>
            <span className="bottom-panel-prompt-path">{shortPath(cwd)}</span>
            <span className="bottom-panel-prompt-sym">$</span>
            <input
              ref={inputRef}
              className="bottom-panel-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={running}
              placeholder="type a command…"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
            <button
              type="submit"
              className="bottom-panel-run-btn"
              disabled={running || !input.trim()}
              title="Run (Enter)"
            >↵</button>
          </form>
        </div>
      )}
    </div>
  );
}
