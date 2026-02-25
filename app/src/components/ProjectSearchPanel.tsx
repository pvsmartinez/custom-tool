/**
 * ProjectSearchPanel — workspace-wide search + replace.
 *
 * Searches all text files in the workspace, presents grouped results
 * with line context, highlights matches, and supports Replace All.
 *
 * Toggles: case-sensitive · whole-word · regex
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Workspace, FileTreeNode } from '../types';
import './ProjectSearchPanel.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineMatch {
  lineNo: number;    // 1-based
  lineText: string;  // full line
  matchStart: number; // index within lineText
  matchEnd: number;
}

interface FileResult {
  relPath: string;
  matches: LineMatch[];
  collapsed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all non-directory text-file paths from the file tree. */
function collectTextPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  const BINARY_EXTS = new Set([
    'png','jpg','jpeg','gif','webp','svg','avif','bmp','ico','tiff','tif',
    'pdf','mp4','webm','mov','mkv','avi','m4v','ogv',
    'zip','tar','gz','wasm','exe','dmg','pkg',
    'tldr','tldr.json',
  ]);
  function isBinary(name: string): boolean {
    const parts = name.split('.');
    const ext = parts[parts.length - 1].toLowerCase();
    // Special case for .tldr.json
    if (name.endsWith('.tldr.json')) return true;
    return BINARY_EXTS.has(ext);
  }
  function walk(n: FileTreeNode) {
    if (n.isDirectory) {
      n.children?.forEach(walk);
    } else if (!isBinary(n.name)) {
      paths.push(n.path);
    }
  }
  nodes.forEach(walk);
  return paths;
}

/** Build a RegExp from the search options. Returns null if pattern is invalid. */
function buildRegex(
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  useRegex: boolean,
): RegExp | null {
  if (!query) return null;
  try {
    let pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) pattern = `\\b${pattern}\\b`;
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Search a file's text for all matches. Returns array of LineMatch. */
function searchText(text: string, re: RegExp): LineMatch[] {
  const lines = text.split('\n');
  const results: LineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // Only record first match per line (for display), but capture all for replace
    while ((m = re.exec(line)) !== null) {
      results.push({
        lineNo: i + 1,
        lineText: line,
        matchStart: m.index,
        matchEnd: m.index + m[0].length,
      });
      // prevent infinite loops for zero-width matches
      if (m[0].length === 0) { re.lastIndex++; }
    }
  }
  return results;
}

// ── Highlighted line ──────────────────────────────────────────────────────────

function HighlightedLine({
  lineText,
  matchStart,
  matchEnd,
}: {
  lineText: string;
  matchStart: number;
  matchEnd: number;
}) {
  // Trim very long lines for display
  const MAX = 120;
  let text = lineText.trimStart();
  const trimmed = lineText.length - text.length;
  const start = Math.max(0, matchStart - trimmed);
  const end = matchEnd - trimmed;

  if (text.length > MAX) {
    // Center window around match
    const pad = 40;
    const wStart = Math.max(0, start - pad);
    const wEnd = Math.min(text.length, end + pad);
    text = (wStart > 0 ? '…' : '') + text.slice(wStart, wEnd) + (wEnd < text.length ? '…' : '');
    const offset = wStart > 0 ? wStart - 1 : wStart;
    return (
      <span className="psp-line-text">
        {text.slice(0, start - offset)}
        <mark className="psp-match">{text.slice(start - offset, end - offset)}</mark>
        {text.slice(end - offset)}
      </span>
    );
  }

  return (
    <span className="psp-line-text">
      {text.slice(0, start)}
      <mark className="psp-match">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ProjectSearchPanelProps {
  workspace: Workspace;
  onOpenFile: (relPath: string, lineNo?: number, matchText?: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProjectSearchPanel({ workspace, onOpenFile }: ProjectSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);

  const [results, setResults] = useState<FileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [totalMatches, setTotalMatches] = useState(0);
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Run search ──────────────────────────────────────────────────────────────
  const runSearch = useCallback(
    async (q: string, cs: boolean, ww: boolean, rx: boolean) => {
      if (!q.trim()) {
        setResults([]);
        setTotalMatches(0);
        setSearchError(null);
        return;
      }

      const re = buildRegex(q, cs, ww, rx);
      if (!re) {
        setSearchError('Invalid regular expression');
        return;
      }
      setSearchError(null);
      setSearching(true);

      const paths = collectTextPaths(workspace.fileTree);
      const fileResults: FileResult[] = [];
      let total = 0;

      for (const relPath of paths) {
        try {
          const text = await readTextFile(`${workspace.path}/${relPath}`);
          re.lastIndex = 0;
          const matches = searchText(text, re);
          if (matches.length > 0) {
            fileResults.push({ relPath, matches, collapsed: false });
            total += matches.length;
          }
        } catch {
          // skip unreadable files
        }
      }

      setResults(fileResults);
      setTotalMatches(total);
      setSearching(false);
    },
    [workspace],
  );

  // Debounce search as user types
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(query, caseSensitive, wholeWord, useRegex);
    }, 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, caseSensitive, wholeWord, useRegex, runSearch]);

  // ── Replace All ─────────────────────────────────────────────────────────────
  async function handleReplaceAll() {
    if (!query || results.length === 0) return;
    const re = buildRegex(query, caseSensitive, wholeWord, useRegex);
    if (!re) return;

    let filesChanged = 0;
    let totalReplaced = 0;

    setReplaceStatus('Replacing…');
    for (const fr of results) {
      try {
        const text = await readTextFile(`${workspace.path}/${fr.relPath}`);
        re.lastIndex = 0;
        const newText = text.replace(re, replacement);
        if (newText !== text) {
          await writeTextFile(`${workspace.path}/${fr.relPath}`, newText);
          filesChanged++;
          totalReplaced += fr.matches.length;
        }
      } catch {
        // skip
      }
    }

    setReplaceStatus(`Replaced ${totalReplaced} match${totalReplaced !== 1 ? 'es' : ''} in ${filesChanged} file${filesChanged !== 1 ? 's' : ''}`);
    setTimeout(() => setReplaceStatus(null), 3000);
    // Re-run search to clear results
    runSearch(query, caseSensitive, wholeWord, useRegex);
  }

  function toggleCollapse(idx: number) {
    setResults((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, collapsed: !r.collapsed } : r)),
    );
  }

  // ── Keyboard: Escape clears query ──────────────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      searchInputRef.current?.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      runSearch(query, caseSensitive, wholeWord, useRegex);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="psp-root">
      {/* Search input */}
      <div className="psp-search-wrap">
        <input
          ref={searchInputRef}
          className={`psp-search-input${searchError ? ' psp-input-error' : ''}`}
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
        {searching && <span className="psp-spinner">⌛</span>}
        {query && !searching && (
          <button className="psp-clear" onClick={() => setQuery('')} title="Clear">✕</button>
        )}
      </div>

      {/* Options */}
      <div className="psp-options">
        <button
          className={`psp-opt${caseSensitive ? ' active' : ''}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Case sensitive"
        >Aa</button>
        <button
          className={`psp-opt${wholeWord ? ' active' : ''}`}
          onClick={() => setWholeWord((v) => !v)}
          title="Whole word"
        >[W]</button>
        <button
          className={`psp-opt${useRegex ? ' active' : ''}`}
          onClick={() => setUseRegex((v) => !v)}
          title="Use regular expression"
        >.*</button>
        <button
          className={`psp-opt psp-opt-replace${showReplace ? ' active' : ''}`}
          onClick={() => setShowReplace((v) => !v)}
          title="Toggle replace"
        >⇄</button>
      </div>

      {searchError && <div className="psp-error">{searchError}</div>}

      {/* Replace row */}
      {showReplace && (
        <div className="psp-replace-row">
          <input
            className="psp-search-input psp-replace-input"
            placeholder="Replace with…"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            spellCheck={false}
          />
          <button
            className="psp-replace-btn"
            onClick={handleReplaceAll}
            disabled={results.length === 0 || !query}
            title="Replace all matches across all files"
          >
            Replace All
          </button>
        </div>
      )}

      {replaceStatus && <div className="psp-replace-status">{replaceStatus}</div>}

      {/* Results summary */}
      {!searching && query && (
        <div className="psp-summary">
          {totalMatches === 0
            ? 'No results'
            : `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${results.length} file${results.length !== 1 ? 's' : ''}`}
        </div>
      )}

      {/* Results list */}
      <div className="psp-results">
        {results.map((fr, fi) => (
          <div key={fr.relPath} className="psp-file-group">
            {/* File header */}
            <button
              className="psp-file-header"
              onClick={() => toggleCollapse(fi)}
              title={fr.relPath}
            >
              <span className="psp-file-arrow">{fr.collapsed ? '▸' : '▾'}</span>
              <span className="psp-file-name">{fr.relPath.split('/').pop()}</span>
              <span className="psp-file-path">{fr.relPath.includes('/') ? fr.relPath.substring(0, fr.relPath.lastIndexOf('/')) : ''}</span>
              <span className="psp-file-count">{fr.matches.length}</span>
            </button>

            {/* Match lines */}
            {!fr.collapsed && fr.matches.map((lm, li) => (
              <button
                key={li}
                className="psp-match-row"
                onClick={() => onOpenFile(fr.relPath, lm.lineNo, lm.lineText.trim())}
                title={`Line ${lm.lineNo}`}
              >
                <span className="psp-line-no">{lm.lineNo}</span>
                <HighlightedLine
                  lineText={lm.lineText}
                  matchStart={lm.matchStart}
                  matchEnd={lm.matchEnd}
                />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
