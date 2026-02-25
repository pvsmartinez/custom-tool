/**
 * FindReplaceBar — floating Ctrl+F bar that appears at the top of the editor area.
 *
 * For text/code files (CodeMirror): uses @codemirror/search SearchQuery API.
 * For canvas files (tldraw): searches shape text and zooms between matches.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { X, ArrowUp, ArrowDown, CaretDown, CaretRight } from '@phosphor-icons/react';
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search';
import { SearchCursor } from '@codemirror/search';
import type { EditorHandle } from './Editor';
import type { Editor as TldrawEditor, TLShape } from 'tldraw';
import './FindReplaceBar.css';

export interface FindReplaceBarProps {
  /** Whether the bar is visible */
  open: boolean;
  onClose: () => void;
  /** CodeMirror editor ref — present when a text/code file is open */
  editorRef?: React.RefObject<EditorHandle | null>;
  /** tldraw editor — present when a canvas is open */
  canvasEditor?: TldrawEditor | null;
  /** 'editor' | 'canvas' | null */
  fileKind?: string | null;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────
function canvasMatches(
  editor: TldrawEditor,
  needle: string,
  caseSensitive: boolean,
): TLShape[] {
  if (!needle) return [];
  const shapes = editor.getCurrentPageShapes();
  return shapes.filter((s) => {
    const text = (s.props as Record<string, unknown>).text as string | undefined;
    if (!text) return false;
    return caseSensitive
      ? text.includes(needle)
      : text.toLowerCase().includes(needle.toLowerCase());
  });
}

function zoomToShape(editor: TldrawEditor, shape: TLShape) {
  const bounds = editor.getShapePageBounds(shape.id);
  if (!bounds) return;
  editor.zoomToBounds(bounds, { animation: { duration: 200 }, inset: 80 });
  editor.select(shape.id);
}

// ── Match count helper for CodeMirror ─────────────────────────────────────────
function countCMMatches(
  view: ReturnType<EditorHandle['getView']>,
  query: SearchQuery,
): number {
  if (!view) return 0;
  const doc = view.state.doc;
  const cursor = new SearchCursor(doc, query.search, 0, doc.length);
  let n = 0;
  while (!cursor.next().done) n++;
  return n;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function FindReplaceBar({
  open,
  onClose,
  editorRef,
  canvasEditor,
  fileKind,
}: FindReplaceBarProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(false);

  // Canvas navigation state
  const [canvasMatchIdx, setCanvasMatchIdx] = useState(0);
  const [canvasMatchCount, setCanvasMatchCount] = useState(0);
  const [cmMatchCount, setCmMatchCount] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when bar opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
    }
  }, [open]);

  // Build and apply CodeMirror SearchQuery whenever query/options change
  const applyQuery = useCallback(() => {
    if (fileKind === 'canvas') return;
    const view = editorRef?.current?.getView();
    if (!view) return;

    let searchStr = query;
    let isRegex = useRegex;

    // Whole-word: wrap in \b...\b as regex
    if (wholeWord && !useRegex && searchStr) {
      searchStr = `\\b${searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
      isRegex = true;
    }

    const sq = new SearchQuery({
      search: searchStr,
      caseSensitive,
      regexp: isRegex,
      replace: replacement,
    });

    view.dispatch({ effects: setSearchQuery.of(sq) });

    // Count matches
    if (query) {
      const count = countCMMatches(view, sq);
      setCmMatchCount(count);
    } else {
      setCmMatchCount(0);
    }
  }, [query, caseSensitive, useRegex, wholeWord, replacement, editorRef, fileKind]);

  // Recompute whenever query/options change
  useEffect(() => {
    applyQuery();
  }, [applyQuery]);

  // Canvas: recount matches when query/options/canvasEditor change
  useEffect(() => {
    if (fileKind !== 'canvas' || !canvasEditor) return;
    const matches = canvasMatches(canvasEditor, query, caseSensitive);
    setCanvasMatchCount(matches.length);
    setCanvasMatchIdx(0);
    if (matches.length > 0) zoomToShape(canvasEditor, matches[0]);
  }, [query, caseSensitive, canvasEditor, fileKind]);

  function handleFindNext() {
    if (fileKind === 'canvas') {
      if (!canvasEditor || canvasMatchCount === 0) return;
      const matches = canvasMatches(canvasEditor, query, caseSensitive);
      const idx = (canvasMatchIdx + 1) % matches.length;
      setCanvasMatchIdx(idx);
      zoomToShape(canvasEditor, matches[idx]);
      return;
    }
    const view = editorRef?.current?.getView();
    if (!view) return;
    applyQuery();
    findNext(view);
  }

  function handleFindPrev() {
    if (fileKind === 'canvas') {
      if (!canvasEditor || canvasMatchCount === 0) return;
      const matches = canvasMatches(canvasEditor, query, caseSensitive);
      const idx = (canvasMatchIdx - 1 + matches.length) % matches.length;
      setCanvasMatchIdx(idx);
      zoomToShape(canvasEditor, matches[idx]);
      return;
    }
    const view = editorRef?.current?.getView();
    if (!view) return;
    applyQuery();
    findPrevious(view);
  }

  function handleReplaceOne() {
    const view = editorRef?.current?.getView();
    if (!view || fileKind === 'canvas') return;
    applyQuery();
    replaceNext(view);
    applyQuery(); // recount after replace
  }

  function handleReplaceAll() {
    const view = editorRef?.current?.getView();
    if (!view || fileKind === 'canvas') return;
    applyQuery();
    replaceAll(view);
    applyQuery(); // recount after replace
  }

  // Close on Escape anywhere in the bar
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      handleClose();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleFindNext();
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleFindPrev();
    }
  }

  function handleClose() {
    // Clear CM highlight on close
    const view = editorRef?.current?.getView();
    if (view) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    }
    setCmMatchCount(0);
    onClose();
  }

  if (!open) return null;

  const isCanvas = fileKind === 'canvas';
  const matchCount = isCanvas ? canvasMatchCount : cmMatchCount;

  return (
    <div className="frb-root" onKeyDown={handleKeyDown} role="dialog" aria-label="Find and replace">
      {/* Toggle expand/collapse replace row */}
      <button
        className="frb-toggle"
        onClick={() => setShowReplace((v) => !v)}
        title="Toggle replace"
      >
        {showReplace ? <CaretDown weight="thin" size={11} /> : <CaretRight weight="thin" size={11} />}
      </button>

      <div className="frb-main">
        {/* ── Find row ── */}
        <div className="frb-row">
          <div className="frb-input-wrap">
            <input
              ref={searchInputRef}
              className="frb-input"
              placeholder="Find…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query && (
              <span className="frb-count">
                {matchCount === 0 ? 'no results' : `${matchCount} match${matchCount !== 1 ? 'es' : ''}`}
              </span>
            )}
          </div>

          {/* Options */}
          <div className="frb-options">
            <button
              className={`frb-opt${caseSensitive ? ' active' : ''}`}
              onClick={() => setCaseSensitive((v) => !v)}
              title="Case sensitive"
            >Aa</button>
            <button
              className={`frb-opt${wholeWord ? ' active' : ''}`}
              onClick={() => setWholeWord((v) => !v)}
              title="Whole word"
              disabled={isCanvas}
            >[W]</button>
            <button
              className={`frb-opt${useRegex ? ' active' : ''}`}
              onClick={() => setUseRegex((v) => !v)}
              title="Use regex"
              disabled={isCanvas}
            >.*</button>
          </div>

          {/* Navigation */}
          <div className="frb-nav">
            <button className="frb-nav-btn" onClick={handleFindPrev} title="Previous match (Shift+Enter)" disabled={matchCount === 0}><ArrowUp weight="thin" size={13} /></button>
            <button className="frb-nav-btn" onClick={handleFindNext} title="Next match (Enter)" disabled={matchCount === 0}><ArrowDown weight="thin" size={13} /></button>
          </div>

          <button className="frb-close" onClick={handleClose} title="Close (Esc)"><X weight="thin" size={14} /></button>
        </div>

        {/* ── Replace row ── */}
        {showReplace && !isCanvas && (
          <div className="frb-row frb-replace-row">
            <div className="frb-input-wrap">
              <input
                ref={replaceInputRef}
                className="frb-input frb-input--replace"
                placeholder="Replace…"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="frb-replace-actions">
              <button className="frb-rep-btn" onClick={handleReplaceOne} disabled={matchCount === 0 || !query}>Replace</button>
              <button className="frb-rep-btn" onClick={handleReplaceAll} disabled={matchCount === 0 || !query}>Replace All</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
