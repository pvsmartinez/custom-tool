import { useState, useCallback, useEffect, useRef } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import './TabBar.css';

interface TabBarProps {
  tabs: string[];           // array of filePaths (each is a unique tab ID)
  activeTabId: string | null;
  dirtyFiles: Set<string>;
  lockedFiles?: Set<string>;
  previewTabId?: string | null;
  workspacePath: string;
  onSelect: (filePath: string) => void;
  onClose: (filePath: string) => void;
  onCloseOthers: (filePath: string) => void;
  onCloseToRight: (filePath: string) => void;
  onCloseAll: () => void;
  onPromoteTab?: (filePath: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}

interface CtxMenu { x: number; y: number; filePath: string; }

export default function TabBar({
  tabs,
  activeTabId,
  dirtyFiles,
  lockedFiles,
  previewTabId,
  workspacePath,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onPromoteTab,
  onReorder,
}: TabBarProps) {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  // Detect when the tab strip overflows its container
  useEffect(() => {
    const el = tabsContainerRef.current;
    if (!el) return;
    const check = () => setIsOverflowing(el.scrollWidth > el.clientWidth + 2);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [tabs]);

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function onOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [dropdownOpen]);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    function onOutside(e: MouseEvent) {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setCtxMenu(null); }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onOutside); document.removeEventListener('keydown', onKey); };
  }, [ctxMenu]);

  const handleSelect = useCallback((filePath: string) => {
    onSelect(filePath);
    setDropdownOpen(false);
  }, [onSelect]);

  function openCtxMenu(e: React.MouseEvent, filePath: string) {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 200;
    const MENU_H = 180;
    const x = Math.min(e.clientX, window.innerWidth  - MENU_W - 6);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 6);
    setCtxMenu({ x, y, filePath });
  }

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  function handleDragStart(e: React.DragEvent, idx: number) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tab-index', String(idx));
    setDragFromIdx(idx);
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    // Only respond to tab drags, not sidebar file drags
    if (!e.dataTransfer.types.includes('application/x-tab-index')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }

  function handleDrop(e: React.DragEvent, toIdx: number) {
    e.preventDefault();
    const fromIdx = dragFromIdx;
    setDragFromIdx(null);
    setDragOverIdx(null);
    if (fromIdx === null || fromIdx === toIdx) return;
    onReorder(fromIdx, toIdx);
  }

  function handleDragEnd() {
    setDragFromIdx(null);
    setDragOverIdx(null);
  }

  if (tabs.length === 0) return null;

  const ctxTabIdx   = ctxMenu ? tabs.indexOf(ctxMenu.filePath) : -1;
  const hasTabsToRight = ctxTabIdx !== -1 && ctxTabIdx < tabs.length - 1;
  const hasOtherTabs   = tabs.length > 1;

  return (
    <div className="tab-bar">
      <div className="tab-bar-tabs" ref={tabsContainerRef}>
        {tabs.map((filePath, idx) => {
          const name = filePath.split('/').pop() ?? filePath;
          const isDirty   = dirtyFiles.has(filePath);
          const isActive  = filePath === activeTabId;
          const isLocked  = !!lockedFiles?.has(filePath);
          const isPreview = filePath === previewTabId;
          const isDragging = dragFromIdx === idx;
          const isDragOver = dragOverIdx === idx && dragFromIdx !== null && dragFromIdx !== idx;
          return (
            <div
              key={filePath}
              draggable
              className={[
                'tab-item',
                isActive   ? 'active'          : '',
                isPreview  ? 'preview'         : '',
                isLocked   ? 'copilot-locked'  : '',
                isDragging ? 'dragging'        : '',
                isDragOver ? 'drag-over'       : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(filePath)}
              onDoubleClick={() => onPromoteTab?.(filePath)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(filePath); } }}
              onContextMenu={(e) => openCtxMenu(e, filePath)}
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              title={isPreview ? `${filePath} (preview — edit or double-click to keep)` : filePath}
            >
              {isDirty && <span className="tab-dirty" title="Unsaved changes" />}
              <span className="tab-name">{name}</span>
              <button
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); onClose(filePath); }}
                title="Close tab"
              >×</button>
            </div>
          );
        })}
      </div>

      {/* Overflow dropdown — shown when tabs exceed the bar width */}
      {isOverflowing && (
        <div className="tab-overflow-wrap" ref={dropdownRef}>
          <button
            className={`tab-overflow-btn${dropdownOpen ? ' active' : ''}`}
            onClick={() => setDropdownOpen((v) => !v)}
            title="All open tabs"
          >▾</button>
          {dropdownOpen && (
            <div className="tab-overflow-menu">
              {tabs.map((filePath) => {
                const name = filePath.split('/').pop() ?? filePath;
                const isDirty = dirtyFiles.has(filePath);
                const isActive = filePath === activeTabId;
                return (
                  <div
                    key={filePath}
                    className={`tab-overflow-item${isActive ? ' active' : ''}`}
                    onClick={() => handleSelect(filePath)}
                    title={filePath}
                  >
                    {isDirty && <span className="tab-dirty" />}
                    <span className="tab-overflow-name">{name}</span>
                    <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); onClose(filePath); setDropdownOpen(false); }}
                      title="Close tab"
                    >×</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tabs.length > 1 && (
        <button
          className="tab-close-all"
          onClick={onCloseAll}
          title="Close all tabs and return to workspace home"
        >
          Close all
        </button>
      )}

      {/* ── Right-click context menu ── */}
      {ctxMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={() => setCtxMenu(null)} />
          <div
            ref={ctxMenuRef}
            className="tab-ctx-menu"
            style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button onClick={() => { onClose(ctxMenu.filePath); setCtxMenu(null); }}>Close</button>
            <button
              disabled={!hasOtherTabs}
              onClick={() => { onCloseOthers(ctxMenu.filePath); setCtxMenu(null); }}
            >Close Others</button>
            <button
              disabled={!hasTabsToRight}
              onClick={() => { onCloseToRight(ctxMenu.filePath); setCtxMenu(null); }}
            >Close to the Right</button>
            <button
              disabled={tabs.length < 2}
              onClick={() => { onCloseAll(); setCtxMenu(null); }}
            >Close All</button>
            <div className="tab-ctx-sep" />
            <button onClick={() => { navigator.clipboard.writeText(ctxMenu.filePath).catch(() => {}); setCtxMenu(null); }}>
              Copy Relative Path
            </button>
            <button onClick={() => { revealItemInDir(`${workspacePath}/${ctxMenu.filePath}`).catch(() => {}); setCtxMenu(null); }}>
              Reveal in Finder
            </button>
          </div>
        </>
      )}
    </div>
  );
}