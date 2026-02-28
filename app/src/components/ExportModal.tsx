/**
 * ExportModal — workspace Build / Export settings.
 *
 * Inspired by Unity's Build Settings:  define named targets, configure them,
 * run one or all.  Config is persisted in <workspace>/.cafezin/config.json
 * via the saveWorkspaceConfig service.
 */

import { useState, useCallback, useEffect } from 'react';
import { X, Plus, Play, Trash, CaretDown, CaretUp, CheckCircle, WarningCircle, CircleNotch, FolderOpen } from '@phosphor-icons/react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { runExportTarget, listAllFiles, resolveFiles, type ExportResult } from '../utils/exportWorkspace';
import { saveWorkspaceConfig } from '../services/workspace';
import type { Workspace, ExportTarget, ExportFormat, WorkspaceExportConfig } from '../types';
import type { Editor } from 'tldraw';
import './ExportModal.css';

// ── Helpers ────────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

const FORMAT_LABELS: Record<ExportFormat, string> = {
  'pdf':        'Markdown → PDF',
  'canvas-png': 'Canvas → PNG',
  'canvas-pdf': 'Canvas → PDF (slides)',
  'zip':        'Zip bundle',
  'custom':     'Custom command',
};

const FORMAT_BADGE_COLOR: Record<ExportFormat, string> = {
  'pdf':        'red',
  'canvas-png': 'blue',
  'canvas-pdf': 'purple',
  'zip':        'orange',
  'custom':     'grey',
};

const DEFAULT_TARGET: Omit<ExportTarget, 'id' | 'name'> = {
  include: ['md'],
  format: 'pdf',
  outputDir: 'dist',
  enabled: true,
};

const FORMAT_DEFAULTS: Record<ExportFormat, { include: string[]; outputDir: string }> = {
  'pdf':         { include: ['md', 'mdx'],          outputDir: 'dist' },
  'canvas-png':  { include: ['tldr.json'],          outputDir: 'dist' },
  'canvas-pdf':  { include: ['tldr.json'],          outputDir: 'dist' },
  'zip':         { include: ['html', 'css', 'js'],  outputDir: 'dist' },
  'custom':      { include: [],                     outputDir: 'dist' },
};

type RunStatus = 'idle' | 'running' | 'done' | 'error';

interface TargetStatus {
  status: RunStatus;
  result?: ExportResult;
  progress?: { done: number; total: number; label: string };
}

// ── Component ──────────────────────────────────────────────────────────────────

interface ExportModalProps {
  workspace: Workspace;
  onWorkspaceChange: (ws: Workspace) => void;
  canvasEditorRef: React.RefObject<Editor | null>;
  activeCanvasRel?: string | null;
  /** Called before exporting a canvas: switches to that file and waits for editor mount */
  onOpenFileForExport: (relPath: string) => Promise<void>;
  /** Called after each canvas export to restore the previous tab */
  onRestoreAfterExport: () => void;
  onClose: () => void;
}

export default function ExportModal({
  workspace,
  onWorkspaceChange,
  canvasEditorRef,
  activeCanvasRel,
  onOpenFileForExport,
  onRestoreAfterExport,
  onClose,
}: ExportModalProps) {
  const savedConfig = workspace.config.exportConfig;
  const [targets, setTargets] = useState<ExportTarget[]>(savedConfig?.targets ?? []);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, TargetStatus>>(new Map());
  // Async file-count per target: targetId → number
  const [fileCounts, setFileCounts] = useState<Map<string, number>>(new Map());
  const [isRunningAll, setIsRunningAll] = useState(false);

  // ── Async file-count preview ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const allFiles = await listAllFiles(workspace.path);
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const t of targets) counts.set(t.id, resolveFiles(allFiles, t).length);
        setFileCounts(counts);
      } catch { /* best-effort */ }
    }
    refresh();
    return () => { cancelled = true; };
  // Depend only on the file-selection fields that affect which files are matched
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets.map(t => ({ id: t.id, include: t.include, includeFiles: t.includeFiles, excludeFiles: t.excludeFiles })))]);

  // ── Persist helpers ─────────────────────────────────────────────────────────
  const persist = useCallback(async (nextTargets: ExportTarget[]) => {
    const exportConfig: WorkspaceExportConfig = { targets: nextTargets };
    const updated: Workspace = {
      ...workspace,
      config: { ...workspace.config, exportConfig },
    };
    onWorkspaceChange(updated);
    await saveWorkspaceConfig(updated);
  }, [workspace, onWorkspaceChange]);

  const updateTargets = useCallback((next: ExportTarget[]) => {
    setTargets(next);
    persist(next);
  }, [persist]);

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  function addTarget() {
    const id = uid();
    const n: ExportTarget = { id, name: 'New target', ...DEFAULT_TARGET };
    const next = [...targets, n];
    setTargets(next);
    setExpandedId(id);
    persist(next); // use derived `next`, not stale `targets` closure
  }

  function deleteTarget(id: string) {
    const next = targets.filter((t) => t.id !== id);
    updateTargets(next);
    if (expandedId === id) setExpandedId(null);
  }

  function updateTarget(id: string, patch: Partial<ExportTarget>) {
    const next = targets.map((t) => t.id === id ? { ...t, ...patch } : t);
    updateTargets(next);
  }

  // ── Run ───────────────────────────────────────────────────────────────────────
  function setStatus(id: string, s: TargetStatus) {
    setStatuses((prev) => new Map(prev).set(id, s));
  }

  async function runTarget(target: ExportTarget) {
    setStatus(target.id, { status: 'running' });
    try {
      const result = await runExportTarget({
        workspacePath: workspace.path,
        target,
        canvasEditorRef: canvasEditorRef,
        activeCanvasRel,
        onOpenFileForExport,
        onRestoreAfterExport,
        onProgress: (done, total, label) => {
          setStatus(target.id, { status: 'running', progress: { done, total, label } });
        },
      });
      setStatus(target.id, {
        status: result.errors.length > 0 ? 'error' : 'done',
        result,
      });
    } catch (e) {
      setStatus(target.id, {
        status: 'error',
        result: { targetId: target.id, outputs: [], errors: [String(e)], elapsed: 0 },
      });
    }
  }

  async function runAll() {
    if (isRunningAll) return;
    setIsRunningAll(true);
    try {
      for (const t of targets.filter((t) => t.enabled)) {
        await runTarget(t);
      }
    } finally {
      setIsRunningAll(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  const enabledCount = targets.filter((t) => t.enabled).length;

  return (
    <div className="em-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="em-modal">

        {/* Header */}
        <div className="em-header">
          <span className="em-title">Export / Build Settings</span>
          <button className="em-close" onClick={onClose}><X weight="bold" /></button>
        </div>

        {/* Target list */}
        <div className="em-body">
          {targets.length === 0 && (
            <div className="em-empty">
              No export targets yet. Add one below to define what your workspace produces.
            </div>
          )}

          {targets.map((target) => {
            const s = statuses.get(target.id);
            const isExpanded = expandedId === target.id;

            return (
              <div key={target.id} className={`em-target${isExpanded ? ' expanded' : ''}`}>
                {/* Row */}
                <div className="em-target-row">
                  <input
                    type="checkbox"
                    className="em-checkbox"
                    checked={target.enabled}
                    onChange={(e) => updateTarget(target.id, { enabled: e.target.checked })}
                    title="Enable this target in Export All"
                  />
                  <span
                    className="em-target-name"
                    onDoubleClick={() => {
                      const n = prompt('Rename target:', target.name);
                      if (n?.trim()) updateTarget(target.id, { name: n.trim() });
                    }}
                    title="Double-click to rename"
                  >
                    {target.name}
                  </span>
                  <span className={`em-badge em-badge--${FORMAT_BADGE_COLOR[target.format]}`}>
                    {FORMAT_LABELS[target.format]}
                  </span>
                  <span className="em-target-out" title="Output directory">{target.outputDir}/</span>
                  {fileCounts.has(target.id) && (
                    <span className="em-file-count" title="Files matched by this target">
                      {fileCounts.get(target.id)} file{fileCounts.get(target.id) !== 1 ? 's' : ''}
                    </span>
                  )}

                  <StatusChip status={s} />

                  <button
                    className="em-run-btn"
                    onClick={() => runTarget(target)}
                    disabled={s?.status === 'running'}
                    title="Run this target"
                  >
                    {s?.status === 'running'
                      ? <CircleNotch className="em-spin" />
                      : <Play weight="fill" />
                    }
                    {s?.status === 'running' ? 'Running…' : 'Run'}
                  </button>

                  <button
                    className="em-icon-btn"
                    onClick={() => setExpandedId(isExpanded ? null : target.id)}
                    title={isExpanded ? 'Collapse' : 'Edit settings'}
                  >
                    {isExpanded ? <CaretUp /> : <CaretDown />}
                  </button>
                  <button
                    className="em-icon-btn em-icon-btn--danger"
                    onClick={() => deleteTarget(target.id)}
                    title="Delete target"
                  >
                    <Trash />
                  </button>
                </div>

                {/* Progress bar while canvas files are being processed */}
                {s?.status === 'running' && s.progress && (
                  <div className="em-progress-wrap">
                    <div
                      className="em-progress-bar"
                      style={{ width: `${Math.round((s.progress.done / s.progress.total) * 100)}%` }}
                    />
                    <span className="em-progress-label">
                      {s.progress.done}/{s.progress.total} — {s.progress.label.split('/').pop()}
                    </span>
                  </div>
                )}

                {/* Result row after completion */}
                {s?.result && (
                  <div className={`em-result${s.status === 'error' ? ' em-result--error' : ''}`}>
                    {s.result.outputs.length > 0 && (
                      <div className="em-result-row">
                        <span>✓ {s.result.outputs.length} file{s.result.outputs.length !== 1 ? 's' : ''} → {s.result.outputs.join(', ')} ({s.result.elapsed}ms)</span>
                        <button
                          className="em-reveal-btn"
                          title="Reveal in Finder"
                          onClick={() => revealItemInDir(`${workspace.path}/${s.result!.outputs[0]}`)}
                        >
                          <FolderOpen weight="fill" size={13} />
                          Reveal
                        </button>
                      </div>
                    )}
                    {s.result.errors.map((e, i) => (
                      <span key={i} className="em-result-error">{e}</span>
                    ))}
                  </div>
                )}

                {/* Expanded config */}
                {isExpanded && (
                  <div className="em-config">
                    <div className="em-field">
                      <label>Name</label>
                      <input
                        value={target.name}
                        onChange={(e) => updateTarget(target.id, { name: e.target.value })}
                      />
                    </div>
                    <div className="em-field">
                      <label>Description <span className="em-hint">(optional — helps AI understand this target)</span></label>
                      <input
                        placeholder="e.g. Course handout for Chapter 3 students"
                        value={target.description ?? ''}
                        onChange={(e) => updateTarget(target.id, { description: e.target.value || undefined })}
                      />
                    </div>
                    <div className="em-field">
                      <label>Format</label>
                      <select
                        value={target.format}
                        onChange={(e) => {
                          const f = e.target.value as ExportFormat;
                          updateTarget(target.id, {
                            format: f,
                            include: FORMAT_DEFAULTS[f].include,
                            outputDir: FORMAT_DEFAULTS[f].outputDir,
                          });
                        }}
                      >
                        {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
                          <option key={f} value={f}>{FORMAT_LABELS[f]}</option>
                        ))}
                      </select>
                    </div>

                    {/* File selection —————————————————————————————— */}
                    <div className="em-section-label">File selection</div>
                    <div className="em-field">
                      <label>Pinned files <span className="em-hint">(one per line — overrides extensions below when set)</span></label>
                      <textarea
                        className="em-monaco"
                        rows={3}
                        placeholder={`notes/chapter1.md\nnotes/chapter2.md`}
                        value={(target.includeFiles ?? []).join('\n')}
                        onChange={(e) => {
                          const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                          updateTarget(target.id, { includeFiles: lines.length ? lines : undefined });
                        }}
                      />
                      <span className="em-hint">Leave empty to use extension matching instead.</span>
                    </div>
                    <div className="em-field">
                      <label>Match extensions <span className="em-hint">(comma-separated, no dot — ignored when Pinned files is set)</span></label>
                      <input
                        placeholder="md, tldr.json, html …"
                        value={target.include.join(', ')}
                        onChange={(e) =>
                          updateTarget(target.id, {
                            include: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                          })
                        }
                      />
                    </div>
                    <div className="em-field">
                      <label>Exclude files <span className="em-hint">(one per line)</span></label>
                      <textarea
                        className="em-monaco"
                        rows={2}
                        placeholder="drafts/scratch.md"
                        value={(target.excludeFiles ?? []).join('\n')}
                        onChange={(e) => {
                          const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                          updateTarget(target.id, { excludeFiles: lines.length ? lines : undefined });
                        }}
                      />
                    </div>

                    {/* Output ————————————————————————————————————— */}
                    <div className="em-section-label">Output</div>
                    <div className="em-field">
                      <label>Output directory</label>
                      <input
                        placeholder="dist"
                        value={target.outputDir}
                        onChange={(e) => updateTarget(target.id, { outputDir: e.target.value || 'dist' })}
                      />
                    </div>
                    {(target.format === 'pdf' || target.format === 'canvas-pdf') && (
                      <div className="em-field em-field--row">
                        <label>
                          <input
                            type="checkbox"
                            checked={target.merge ?? false}
                            onChange={(e) => updateTarget(target.id, { merge: e.target.checked || undefined })}
                          />
                          {' '}Merge into one file
                        </label>
                        {target.merge && (
                          <input
                            className="em-inline-input"
                            placeholder="merged"
                            value={target.mergeName ?? ''}
                            onChange={(e) => updateTarget(target.id, { mergeName: e.target.value || undefined })}
                          />
                        )}
                        <span className="em-hint">
                          {target.format === 'pdf' ? 'Combines all matched markdown into one PDF.' : 'Packs all canvas frames into one PDF.'}
                          {target.merge && ` Output: ${target.mergeName?.trim() || 'merged'}.pdf`}
                        </span>
                      </div>
                    )}
                    {target.format === 'zip' && (
                      <div className="em-field">
                        <label>Zip file name</label>
                        <input
                          placeholder="export"
                          value={target.mergeName ?? ''}
                          onChange={(e) => updateTarget(target.id, { mergeName: e.target.value || undefined })}
                        />
                      </div>
                    )}

                    {target.format === 'custom' && (
                      <div className="em-field">
                        <label>Command</label>
                        <input
                          className="em-mono"
                          placeholder="pandoc {{input}} -o {{output}}.pdf"
                          value={target.customCommand ?? ''}
                          onChange={(e) => updateTarget(target.id, { customCommand: e.target.value })}
                        />
                        <span className="em-hint">
                          Placeholders: {'{{input}}'} = source file, {'{{output}}'} = output path (no extension).
                          Runs with workspace root as cwd.
                        </span>
                      </div>
                    )}
                    {(target.format === 'canvas-png' || target.format === 'canvas-pdf') && (
                      <div className="em-hint em-hint--block em-hint--info">
                        Canvas files are opened headlessly during export. A full-screen overlay covers the UI — no visible tab switching.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="em-footer">
          <button className="em-add-btn" onClick={addTarget}>
            <Plus weight="bold" /> New target
          </button>
          <div className="em-footer-right">
            {enabledCount > 0 && (
              <span className="em-enabled-count">{enabledCount} target{enabledCount !== 1 ? 's' : ''} enabled</span>
            )}
            <button
              className="em-export-all-btn"
              onClick={runAll}
              disabled={enabledCount === 0 || isRunningAll}
              title="Run all enabled targets"
            >
              <Play weight="fill" /> Export All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Status chip ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status?: TargetStatus }) {
  if (!status || status.status === 'idle') return null;
  if (status.status === 'running') return <span className="em-status em-status--running"><CircleNotch className="em-spin" /> Running</span>;
  if (status.status === 'done')    return <span className="em-status em-status--done"><CheckCircle weight="fill" /> Done</span>;
  if (status.status === 'error')   return <span className="em-status em-status--error"><WarningCircle weight="fill" /> Error</span>;
  return null;
}
