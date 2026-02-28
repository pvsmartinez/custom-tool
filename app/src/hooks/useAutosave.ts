/**
 * useAutosave
 *
 * Owns the debounced-write lifecycle for editable text files.
 * Creates and exposes `scheduleAutosave`, `cancelAutosave`, and
 * `autosaveDelayRef` (runtime-configurable delay).
 *
 * Call `scheduleAutosave(ws, filePath, newContent)` on every content change.
 * The hook updates the dirty-file set immediately and flushes the write after
 * `autosaveDelayRef.current` milliseconds.  A delay of 0 means "never auto-save".
 */
import { useRef, useCallback, useEffect } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { Workspace } from '../types';
import { writeFile, trackFileEdit } from '../services/workspace';

export interface UseAutosaveOptions {
  savedContentRef: MutableRefObject<Map<string, string>>;
  setDirtyFiles: (fn: (prev: Set<string>) => Set<string>) => void;
  setSaveError:  Dispatch<SetStateAction<string | null>>;
  setWorkspace:  Dispatch<SetStateAction<Workspace | null>>;
  /** Delay in ms from initSettings.autosaveDelay; default 1000. */
  initialDelay?: number;
}

export function useAutosave({
  savedContentRef,
  setDirtyFiles,
  setSaveError,
  setWorkspace,
  initialDelay = 1000,
}: UseAutosaveOptions) {
  const saveTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDelayRef = useRef<number>(initialDelay);

  const scheduleAutosave = useCallback(
    (ws: Workspace, file: string, newContent: string) => {
      const lastSaved = savedContentRef.current.get(file);
      const isDirty   = newContent !== lastSaved;

      setDirtyFiles((prev) => {
        const wasDirty = prev.has(file);
        if (isDirty === wasDirty) return prev;
        const next = new Set(prev);
        if (isDirty) next.add(file); else next.delete(file);
        return next;
      });

      if (!isDirty) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        return;
      }

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (autosaveDelayRef.current === 0) return;

      saveTimerRef.current = setTimeout(async () => {
        try {
          await writeFile(ws, file, newContent);
          savedContentRef.current.set(file, newContent);
          setDirtyFiles((prev) => {
            if (!prev.has(file)) return prev;
            const next = new Set(prev);
            next.delete(file);
            return next;
          });
          setSaveError(null);
          trackFileEdit(ws).then((updated) => {
            setWorkspace(updated);
          }).catch(() => {});
        } catch (err) {
          console.error('Auto-save failed:', err);
          setSaveError(String((err as Error)?.message ?? err));
        }
      }, autosaveDelayRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const cancelAutosave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  // Cancel any pending write on unmount to avoid setState-on-unmounted-component
  // warnings in React 18+ and prevent ghost saves after workspace switch.
  useEffect(() => {
    return cancelAutosave;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { saveTimerRef, autosaveDelayRef, scheduleAutosave, cancelAutosave };
}
