import { useState, useEffect, useCallback } from 'react';
import type {
  MutableRefObject,
  RefObject,
  Dispatch,
  SetStateAction,
} from 'react';
import type { Editor as TldrawEditor, TLShapeId } from 'tldraw';
import type { EditorHandle } from '../components/Editor';
import {
  loadMarks,
  addMark,
  addMarksBulk,
  saveMarks,
  markReviewed,
} from '../services/aiMarks';
import { generateId } from '../utils/generateId';
import type { Workspace, AIEditMark } from '../types';

// ── Pure helper (also exported for use in App.tsx's handleInsert) ──────────
export function makeCanvasMark(
  relPath: string,
  shapeIds: string[],
  model: string,
): AIEditMark {
  return {
    id: generateId(),
    fileRelPath: relPath,
    text: `AI canvas edit — ${shapeIds.length} shape${shapeIds.length !== 1 ? 's' : ''}`,
    model,
    insertedAt: new Date().toISOString(),
    reviewed: false,
    canvasShapeIds: shapeIds,
  };
}

// ── Hook params ─────────────────────────────────────────────────────────────
interface UseAIMarksParams {
  workspace: Workspace | null;
  activeFile: string | null;
  initHighlightDefault: boolean;
  // Refs passed from useTabManager / useAutosave
  activeTabIdRef: MutableRefObject<string | null>;
  tabsRef: MutableRefObject<string[]>;
  tabContentsRef: MutableRefObject<Map<string, string>>;
  savedContentRef: MutableRefObject<Map<string, string>>;
  // Refs from useCanvasState / App.tsx
  canvasEditorRef: MutableRefObject<TldrawEditor | null>;
  editorRef: RefObject<EditorHandle | null>;
  // Setters from useTabManager
  setContent: Dispatch<SetStateAction<string>>;
  setDirtyFiles: Dispatch<SetStateAction<Set<string>>>;
}

// ── Hook return type ────────────────────────────────────────────────────────
export interface UseAIMarksReturn {
  aiMarks: AIEditMark[];
  /** Set from App.tsx when loading a workspace or switching. */
  setAiMarks: Dispatch<SetStateAction<AIEditMark[]>>;
  aiHighlight: boolean;
  setAiHighlight: Dispatch<SetStateAction<boolean>>;
  aiNavIndex: number;
  setAiNavIndex: Dispatch<SetStateAction<number>>;
  /** Marks for the currently active file that have not been reviewed. */
  activeFileMarks: AIEditMark[];
  // ── Loaders ──────────────────────────────────────────────────────────────
  /** Load marks from disk for a freshly opened workspace. */
  loadMarksForWorkspace: (ws: Workspace) => void;
  // ── Handlers forwarded to components ─────────────────────────────────────
  handleMarkRecorded: (relPath: string, written: string, aiModel: string) => void;
  handleCanvasMarkRecorded: (relPath: string, shapeIds: string[], aiModel: string) => void;
  handleMarkReviewed: (id: string) => void;
  handleReviewAllMarks: () => void;
  handleMarkUserEdited: (markId: string) => void;
  handleAINavNext: () => void;
  handleAINavPrev: () => void;
  /**
   * Add a single mark (e.g. from handleInsert in App.tsx).
   * No-ops when workspace is null.
   */
  recordMark: (mark: AIEditMark) => void;
  /**
   * Auto-remove marks whose text no longer exists in the document.
   * Called from handleContentChange in App.tsx.
   */
  cleanupMarksForContent: (file: string, newContent: string) => void;
}

/**
 * Manages all AI edit-mark state and the navigation / review handlers
 * so App.tsx only sees a clean interface instead of ~150 lines of callbacks.
 */
export function useAIMarks({
  workspace,
  activeFile,
  initHighlightDefault,
  activeTabIdRef,
  tabsRef,
  tabContentsRef,
  savedContentRef,
  canvasEditorRef,
  editorRef,
  setContent,
  setDirtyFiles,
}: UseAIMarksParams): UseAIMarksReturn {
  const [aiMarks, setAiMarks] = useState<AIEditMark[]>([]);
  const [aiHighlight, setAiHighlight] = useState(initHighlightDefault);
  const [aiNavIndex, setAiNavIndex] = useState(0);

  const activeFileMarks = aiMarks.filter(
    (m) => m.fileRelPath === activeFile && !m.reviewed,
  );

  // Reset nav index on file change
  useEffect(() => { setAiNavIndex(0); }, [activeFile]);

  // ── Loaders ───────────────────────────────────────────────────────────────
  const loadMarksForWorkspace = useCallback((ws: Workspace) => {
    loadMarks(ws).then(setAiMarks).catch(() => setAiMarks([]));
  }, []);

  // ── Canvas mark (agent canvas_op path) ───────────────────────────────────
  const handleCanvasMarkRecorded = useCallback(
    (relPath: string, shapeIds: string[], aiModel: string) => {
      if (!workspace || shapeIds.length === 0) return;
      const mark = makeCanvasMark(relPath, shapeIds, aiModel);
      addMark(workspace, mark).then(setAiMarks).catch(() => {});
    },
    [workspace],
  );

  // ── Text mark (agent write_workspace_file path) ───────────────────────────
  const handleMarkRecorded = useCallback(
    (relPath: string, written: string, aiModel: string) => {
      if (!workspace) return;
      // Canvas files are tracked via canvasShapeIds — skip text marks for them
      if (relPath.endsWith('.tldr.json')) return;

      const MIN_CHUNK = 40;
      const MAX_CHUNKS = 12;
      const chunks = written
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter((s) => s.length >= MIN_CHUNK)
        .slice(0, MAX_CHUNKS);
      if (chunks.length === 0) return;

      const now = new Date().toISOString();
      const newMarks = chunks.map((text) => ({
        id: generateId(),
        fileRelPath: relPath,
        text,
        model: aiModel,
        insertedAt: now,
        reviewed: false,
      }));
      addMarksBulk(workspace, newMarks).then(setAiMarks).catch(() => {});

      // Update editor content if the file is currently open
      const currentActiveFile = activeTabIdRef.current;
      const currentTabs = tabsRef.current;
      if (relPath === currentActiveFile) {
        setContent(written);
        savedContentRef.current.set(relPath, written);
        tabContentsRef.current.set(relPath, written);
        setDirtyFiles((prev) => {
          const s = new Set(prev);
          s.delete(relPath);
          return s;
        });
      } else if (currentTabs.includes(relPath)) {
        tabContentsRef.current.set(relPath, written);
        savedContentRef.current.set(relPath, written);
      }
    },
    [
      workspace,
      activeTabIdRef,
      tabsRef,
      tabContentsRef,
      savedContentRef,
      setContent,
      setDirtyFiles,
    ],
  );

  // ── Mark as reviewed ──────────────────────────────────────────────────────
  const handleMarkReviewed = useCallback(
    (id: string) => {
      if (!workspace) return;
      markReviewed(workspace, id).then(setAiMarks).catch(() => {});
    },
    [workspace],
  );

  // ── Mark ALL as reviewed ──────────────────────────────────────────────────
  const handleReviewAllMarks = useCallback(() => {
    if (!workspace) return;
    const now = new Date().toISOString();
    setAiMarks((prev) => {
      const updated = prev.map((m) =>
        m.reviewed ? m : { ...m, reviewed: true, reviewedAt: now },
      );
      saveMarks(workspace, updated).catch(() => {});
      return updated;
    });
  }, [workspace]);

  // ── Canvas: mark as reviewed when user edits the shape ───────────────────
  const handleMarkUserEdited = useCallback(
    (markId: string) => {
      if (!workspace) return;
      markReviewed(workspace, markId).then(setAiMarks).catch(() => {});
    },
    [workspace],
  );

  // ── Expose single-mark insert for App.tsx handleInsert ───────────────────
  const recordMark = useCallback(
    (mark: AIEditMark) => {
      if (!workspace) return;
      addMark(workspace, mark).then(setAiMarks).catch(() => {});
    },
    [workspace],
  );

  // ── Auto-remove marks whose text was overwritten by the human ─────────────
  const cleanupMarksForContent = useCallback(
    (file: string, newContent: string) => {
      if (!workspace) return;
      setAiMarks((prev) => {
        const fileMarks = prev.filter(
          (m) => m.fileRelPath === file && !m.reviewed,
        );
        const toRemove = fileMarks
          .filter((m) => !m.canvasShapeIds?.length && !newContent.includes(m.text))
          .map((m) => m.id);
        if (toRemove.length === 0) return prev;
        const updated = prev.map((m) =>
          toRemove.includes(m.id)
            ? { ...m, reviewed: true, reviewedAt: new Date().toISOString() }
            : m,
        );
        saveMarks(workspace, updated).catch(() => {});
        return updated;
      });
    },
    [workspace],
  );

  // ── Navigation within active file ────────────────────────────────────────
  const handleAINavNext = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex + 1) % activeFileMarks.length;
    setAiNavIndex(idx);
    const mark = activeFileMarks[idx];
    if (mark.canvasShapeIds?.length && canvasEditorRef.current) {
      // Try each shape ID in order — the first one might have been deleted by the user.
      let zoomed = false;
      for (const sid of mark.canvasShapeIds) {
        const bounds = canvasEditorRef.current.getShapePageBounds(sid as TLShapeId);
        if (bounds) {
          canvasEditorRef.current.zoomToBounds(bounds, { animation: { duration: 300 }, inset: 60 });
          zoomed = true;
          break;
        }
      }
      if (!zoomed) {
        // eslint-disable-next-line no-console
        console.warn('[useAIMarks] All shapes in canvas mark have been deleted — skipping zoom');
      }
    } else {
      editorRef.current?.jumpToText(mark.text);
    }
  }, [activeFileMarks, aiNavIndex, canvasEditorRef, editorRef]);

  const handleAINavPrev = useCallback(() => {
    if (activeFileMarks.length === 0) return;
    const idx = (aiNavIndex - 1 + activeFileMarks.length) % activeFileMarks.length;
    setAiNavIndex(idx);
    const mark = activeFileMarks[idx];
    if (mark.canvasShapeIds?.length && canvasEditorRef.current) {
      // Try each shape ID in order — the first one might have been deleted by the user.
      let zoomed = false;
      for (const sid of mark.canvasShapeIds) {
        const bounds = canvasEditorRef.current.getShapePageBounds(sid as TLShapeId);
        if (bounds) {
          canvasEditorRef.current.zoomToBounds(bounds, { animation: { duration: 300 }, inset: 60 });
          zoomed = true;
          break;
        }
      }
      if (!zoomed) {
        // eslint-disable-next-line no-console
        console.warn('[useAIMarks] All shapes in canvas mark have been deleted — skipping zoom');
      }
    } else {
      editorRef.current?.jumpToText(mark.text);
    }
  }, [activeFileMarks, aiNavIndex, canvasEditorRef, editorRef]);

  return {
    aiMarks,
    setAiMarks,
    aiHighlight,
    setAiHighlight,
    aiNavIndex,
    setAiNavIndex,
    activeFileMarks,
    loadMarksForWorkspace,
    handleMarkRecorded,
    handleCanvasMarkRecorded,
    handleMarkReviewed,
    handleReviewAllMarks,
    handleMarkUserEdited,
    handleAINavNext,
    handleAINavPrev,
    recordMark,
    cleanupMarksForContent,
  };
}
