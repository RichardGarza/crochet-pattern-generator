// The save chip's status. T8's `useAutosave` when it exists; until then projects live in this tab only and the
// chip says "not saved yet". The hook is chosen once, at module scope: a stub hook must not be called behind an
// `if` (§5.2.1).
import { isImplemented } from '../../core/stub';
import { useProjectStore } from '../../state/projectStore';
import { useAutosave } from '../library/useAutosave';

export type SaveChipStatus = 'saved' | 'saving' | 'error' | 'read-only' | 'not-saved';

function useMemoryStatus(): SaveChipStatus {
  const readOnly = useProjectStore((s) => s.readOnly);
  return readOnly ? 'read-only' : 'not-saved';
}

function useRepositoryStatus(): SaveChipStatus {
  return useAutosave().status;
}

export const useSaveChipStatus: () => SaveChipStatus = isImplemented(useAutosave) ? useRepositoryStatus : useMemoryStatus;
