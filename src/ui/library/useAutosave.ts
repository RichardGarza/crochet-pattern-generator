// Track T8 — the autosave hook: saves 800 ms after the last update, flushes on hide and navigation, and
// reports the save chip's status (DESIGN.md §5.5.2; §5.2.1).
//
// Step 0 stub. T8 replaces it with the real hook and keeps the frozen signature (src/types/entryPoints.ts).
// The stub throws when called, and a hook must not be called conditionally, so a component that needs it
// before T8 lands chooses once, at module scope, and then calls its choice unconditionally:
//
//   const useSaveStatus: UseAutosaveFn = isImplemented(useAutosave)
//     ? useAutosave
//     : () => ({ status: 'saved', flush: async () => {} });
import { stub } from '../../core/stub';
import type { UseAutosaveFn } from '../../types/entryPoints';

export const useAutosave = stub<UseAutosaveFn>('useAutosave');
