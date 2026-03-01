import { useState } from 'react';
import { Check, X, CaretRight, CaretUp, CaretDown, Warning } from '@phosphor-icons/react';
import type { ToolActivity, MessageItem, ChatMessage } from '../../types';

// ── Tool icons ────────────────────────────────────────────────────────────────
const TOOL_ICONS: Record<string, string> = {
  list_workspace_files:  '⊟',
  read_workspace_file:   '◎',
  write_workspace_file:  '⊕',
  search_workspace:      '⊙',
  run_command:           '$',
  canvas_op:             '◈',
  list_canvas_shapes:    '⊡',
  canvas_screenshot:     '⬡',
  move_workspace_file:   '⇄',
  delete_workspace_file: '×',
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⚙';
}

/** Human-readable one-liner describing what the tool did. */
export function getActionSummary(activity: ToolActivity): string {
  const { name, args } = activity;
  if (activity.kind === 'thinking') return 'Reasoning…';
  const p = (k: string) => String(args[k] ?? '').slice(0, 50);
  switch (name) {
    case 'read_workspace_file':   return `Read "${p('path')}"`;
    case 'write_workspace_file':  return `Wrote "${p('path')}"`;
    case 'search_workspace':      return `Searched for "${p('query')}"`;
    case 'list_workspace_files':  return args.folder ? `Listed files in ${p('folder')}` : 'Listed workspace files';
    case 'run_command': {
      const cmd = p('command');
      return `Ran: ${cmd}${String(args.command ?? '').length > 50 ? '…' : ''}`;
    }
    case 'canvas_op':             return 'Updated canvas';
    case 'list_canvas_shapes':    return 'Listed canvas shapes';
    case 'canvas_screenshot':     return 'Captured canvas screenshot';
    case 'move_workspace_file':   return `Moved "${p('src')}" → "${p('dst')}"`;
    case 'delete_workspace_file': return `Deleted "${p('path')}"`;
    default: return name.replace(/_/g, ' ');
  }
}

// ── ToolItem ──────────────────────────────────────────────────────────────────
/** Single tool call row — collapses/expands result on click. */
export function ToolItem({ activity, defaultOpen = false }: { activity: ToolActivity; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const isDone   = activity.result !== undefined || !!activity.error;
  const isError  = !!activity.error;
  const summary  = activity.kind === 'thinking'
    ? (activity.thinkingText?.slice(0, 100) ?? 'Reasoning…')
    : getActionSummary(activity);
  const resultText = activity.error ?? activity.result ?? '';

  return (
    <div className={`ai-tool-item ai-tool-item--${isDone ? (isError ? 'error' : 'done') : 'running'}`}>
      <button className="ai-tool-item-row" onClick={() => isDone && setOpen((v) => !v)} disabled={!isDone}>
        <span className="ai-tool-item-icon">{getToolIcon(activity.name)}</span>
        <span className="ai-tool-item-summary">{summary}</span>
        <span className="ai-tool-item-status">
          {!isDone && <span className="ai-tool-spinner" />}
          {isDone && !isError && <span className="ai-tool-ok"><Check weight="thin" size={12} /></span>}
          {isError && <span className="ai-tool-err"><X weight="thin" size={12} /></span>}
          {isDone && (
            <span className="ai-tool-chevron">
              {open ? <CaretUp weight="thin" size={10} /> : <CaretDown weight="thin" size={10} />}
            </span>
          )}
        </span>
      </button>
      {open && isDone && (
        <pre className={`ai-tool-item-result${isError ? ' error' : ''}`}>{resultText}</pre>
      )}
    </div>
  );
}

// ── CollapsibleProcess ────────────────────────────────────────────────────────
/** Collapsible "Process" section shown below completed agent messages. */
export function CollapsibleProcess({ items }: { items: MessageItem[] }) {
  const [open, setOpen] = useState(false);

  const toolItems = items.filter(
    (it): it is { type: 'tool'; activity: ToolActivity } => it.type === 'tool',
  );
  if (toolItems.length === 0) return null;

  const hasError = toolItems.some((it) => !!it.activity.error);

  return (
    <div className="ai-process-section">
      <button className="ai-process-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="ai-process-toggle-icon">
          {open ? <CaretDown weight="thin" size={12} /> : <CaretRight weight="thin" size={12} />}
        </span>
        <span className="ai-process-toggle-label">
          {hasError ? <><Warning weight="thin" size={12} />{' '}</> : '✦ '}Process
        </span>
        <span className="ai-process-toggle-count">
          {toolItems.length} {toolItems.length === 1 ? 'step' : 'steps'}
        </span>
      </button>
      {open && (
        <div className="ai-process-body">
          {toolItems.map((it) => (
            <ToolItem key={it.activity.callId} activity={it.activity} defaultOpen={false} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── useSessionStats ───────────────────────────────────────────────────────────
/** Compute session-wide edit stats from completed messages. */
export function useSessionStats(messages: ChatMessage[]) {
  const writtenPaths = new Set<string>();
  let canvasOps = 0;
  for (const msg of messages) {
    if (!msg.items) continue;
    for (const item of msg.items) {
      if (item.type !== 'tool' || item.activity.error) continue;
      if (item.activity.name === 'write_workspace_file') {
        const p = item.activity.args.path as string | undefined;
        if (p) writtenPaths.add(p);
      }
      if (item.activity.name === 'canvas_op') canvasOps++;
    }
  }
  return { filesCount: writtenPaths.size, canvasOps };
}
