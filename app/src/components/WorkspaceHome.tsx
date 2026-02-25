import React, { useEffect, useState } from 'react';
import { Play } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, AIEditMark, FileTreeNode } from '../types';
import './WorkspaceHome.css';

interface WorkspaceHomeProps {
  workspace: Workspace;
  onOpenFile: (filename: string) => void;
  aiMarks?: AIEditMark[];
  onOpenAIReview?: () => void;
}

interface SyncState {
  loading: boolean;
  changedCount: number;
  error: boolean;
}

// Count all non-directory nodes in the file tree
function countFiles(nodes: FileTreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.isDirectory ? countFiles(n.children ?? []) : 1), 0);
}

// Human-readable relative time
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// File-type icon (same logic as Sidebar)
function fileIcon(name: string): React.ReactNode {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'mdx'].includes(ext)) return '◎';
  if (['ts', 'tsx'].includes(ext)) return 'TS';
  if (['js', 'jsx', 'mjs'].includes(ext)) return 'JS';
  if (['json', 'jsonc'].includes(ext)) return '{}';
  if (['css', 'scss', 'less'].includes(ext)) return '#';
  if (['html', 'htm'].includes(ext)) return '<>';
  if (['rs'].includes(ext)) return '⛭';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi'].includes(ext)) return <Play weight="thin" size={11} />;
  if (ext === 'gif') return 'GIF';
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return '⬡';
  if (ext === 'pdf') return '⬡';
  return '·';
}

export default function WorkspaceHome({ workspace, onOpenFile, aiMarks = [] }: WorkspaceHomeProps) {
  const [sync, setSync] = useState<SyncState>({ loading: true, changedCount: 0, error: false });

  useEffect(() => {
    setSync({ loading: true, changedCount: 0, error: false });
    invoke<{ files: string[]; diff: string }>('git_diff', { path: workspace.path })
      .then((r) => setSync({ loading: false, changedCount: r.files.length, error: false }))
      .catch(() => setSync({ loading: false, changedCount: 0, error: true }));
  }, [workspace.path]);

  const { config } = workspace;
  const recentFiles = config.recentFiles ?? [];
  const lastEditedAt = config.lastEditedAt;

  // Pick a greeting based on time of day
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? 'Good morning' :
    hour < 17 ? 'Good afternoon' :
    'Good evening';

  return (
    <div className="wh-root">
      <div className="wh-content">

        {/* Project name */}
        <div className="wh-greeting">{greeting}</div>
        <h1 className="wh-project-name">{workspace.name}</h1>
        <div className="wh-path">{workspace.path}</div>

        {/* Stats row */}
        <div className="wh-stats">
          {/* Last edited */}
          <div className="wh-stat">
            <span className="wh-stat-label">Last edited</span>
            <span className="wh-stat-value">
              {lastEditedAt ? relativeTime(lastEditedAt) : '—'}
            </span>
          </div>

          {/* Sync status */}
          <div className="wh-stat">
            <span className="wh-stat-label">Sync status</span>
            <span
              className={`wh-stat-value wh-sync${
                sync.loading ? ' loading' :
                sync.error   ? ' error' :
                sync.changedCount > 0 ? ' dirty' :
                ' clean'
              }`}
            >
              {sync.loading
                ? '…'
                : sync.error
                ? 'unavailable'
                : sync.changedCount > 0
                ? `${sync.changedCount} unsync'd file${sync.changedCount !== 1 ? 's' : ''}`
                : 'up to date'}
            </span>
          </div>

          {/* File count */}
          <div className="wh-stat">
            <span className="wh-stat-label">Files</span>
            <span className="wh-stat-value">{countFiles(workspace.fileTree)}</span>
          </div>
        </div>

        {/* Recent files */}
        {recentFiles.length > 0 && (
          <div className="wh-recent">
            <div className="wh-section-label">Recent files</div>
            <div className="wh-file-list">
              {recentFiles.map((file) => (
                <button
                  key={file}
                  className="wh-file-btn"
                  onClick={() => onOpenFile(file)}
                  title={file}
                >
                  <span className="wh-file-icon">{fileIcon(file)}</span>
                  <span className="wh-file-name">{file.split('/').pop()}</span>
                  {file.includes('/') && (
                    <span className="wh-file-dir">{file.split('/').slice(0, -1).join('/')}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Agent context badge */}
        {workspace.agentContext && (
          <div className="wh-agent-note">
            <span className="wh-agent-icon">✦</span>
            AGENT.md loaded as AI context
          </div>
        )}

        {/* AI edits section */}
        {(() => {
          const unreviewed = aiMarks.filter((m) => !m.reviewed);
          if (unreviewed.length === 0) return null;
          const byFile = new Map<string, number>();
          for (const m of unreviewed) {
            byFile.set(m.fileRelPath, (byFile.get(m.fileRelPath) ?? 0) + 1);
          }
          return (
            <div className="wh-ai-section">
              <div className="wh-section-label">
                AI edits pending review
                <span className="wh-ai-total">{unreviewed.length}</span>
              </div>
              <div className="wh-ai-file-list">
                {Array.from(byFile.entries()).map(([file, count]) => (
                  <button
                    key={file}
                    className="wh-ai-file-btn"
                    onClick={() => {
                      onOpenFile(file);
                    }}
                    title={file}
                  >
                    <span className="wh-ai-file-icon">✦</span>
                    <span className="wh-ai-file-name">{file.split('/').pop()}</span>
                    <span className="wh-ai-file-dir">
                      {file.split('/').slice(0, -1).join('/') || '/'}
                    </span>
                    <span className="wh-ai-file-count">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
