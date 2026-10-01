// Track T8 — the autosave hook (DESIGN.md §5.5.2; §5.2.1 `UseAutosaveFn`): the save chip's status and a
// `flush()` that saves now.
//
// The saving itself runs outside React, in the session of `persistence.ts` (800 ms after the last change, on
// tab hide, page hide, before the library, before a hand-over or an upgrade). Importing this module starts
// that session in a browser (the shell imports it at start-up for the save chip); where there is no
// IndexedDB — node and happy-dom tests — nothing starts and the shell's memory backend stays.
import { useMemo } from 'react';
import { autosaveStatus } from '../../core/persist/autosave';
import { useProjectStore } from '../../state/projectStore';
import type { UseAutosaveFn } from '../../types/entryPoints';
import { autoStartPersistence, getPersistence } from './persistence';

autoStartPersistence();

/** Saves the open project now; resolves when it is saved, or when the save failed (the chip says so). */
export function flushAutosave(): Promise<void> {
  return getPersistence()?.autosave.flush() ?? Promise.resolve();
}

/**
 * `saved` · `saving` (a save is running, or changes wait for the 800 ms debounce) · `error` (the last save
 * failed; it is retried) · `read-only` (another tab edits this project).
 */
export const useAutosave: UseAutosaveFn = () => {
  const status = autosaveStatus(useProjectStore((s) => s.saveStatus));
  return useMemo(() => ({ status, flush: flushAutosave }), [status]);
};
