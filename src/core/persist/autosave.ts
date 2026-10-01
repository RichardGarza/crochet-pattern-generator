// Track T8 — the autosave controller (DESIGN.md §5.5.2): saves the open project 800 ms after its last authored
// change, on demand (`flush`: tab hidden, page hide, leaving the project, a hand-over), and turns a
// compare-and-swap conflict into exactly one copy that the tab then keeps editing.
//
// No DOM and no React: `ui/library/persistence.ts` wires it to the page (visibilitychange, pagehide) and
// `ui/library/useAutosave.ts` shows its status. It drives `projectStore` only through the save hooks of Step 0
// (`beginSave` → `repo.save` → `markSaved` | `saveAsCopy` + `rebind` | `markSaveFailed`).
import type { ProjectStore, SaveStatus } from '../../state/projectStore';
import { copyName, realTimers, type PersistRepository, type Timers } from './repo';

export const AUTOSAVE_DEBOUNCE_MS = 800;
/** Waits before the next try after a failed save (the last one repeats). */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

export interface ConflictInfo {
  originalId: string;
  originalName: string;
  copyId: string;
  copyName: string;
  /** The rev another tab stored, newer than the one this tab had loaded. */
  storedRev: number;
}

export interface AutosaveOptions {
  store: ProjectStore;
  repo: Pick<PersistRepository, 'save' | 'saveAsCopy' | 'putAssetBlob' | 'release' | 'holdsLock'>;
  debounceMs?: number;
  timers?: Timers;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
  /** A save found a newer stored version: the tab now edits the copy (rebound already). */
  onConflict?: (info: ConflictInfo) => void;
  /** A save failed; another try is scheduled. `attempt` counts consecutive failures from 1. */
  onError?: (error: unknown, attempt: number) => void;
  /** A save succeeded after failures. */
  onRecovered?: () => void;
  /** The saved document names assets that neither the database nor this tab's cache has (or storing them failed). */
  onMissingAssets?: (keys: string[]) => void;
}

export interface Autosave {
  /** Saves now (cancels the debounce) and resolves when nothing is left to save or a save failed. */
  flush(): Promise<void>;
  /** True while a save is waiting for its debounce or a retry, or running. */
  pending(): boolean;
  /** Consecutive failed saves (0 after a success). */
  failures(): number;
  dispose(): void;
}

/** `useAutosave().status` from the store's `saveStatus`: changes not yet saved count as saving (s0b request 11). */
export function autosaveStatus(s: SaveStatus): 'saved' | 'saving' | 'error' | 'read-only' {
  return s === 'unsaved' ? 'saving' : s;
}

/** At most this many saves per `flush` while edits keep arriving during the saves. */
const MAX_ROUNDS = 8;

export function createAutosave(o: AutosaveOptions): Autosave {
  const { store, repo } = o;
  const debounceMs = o.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const timers = o.timers ?? realTimers;
  const now = o.now ?? (() => new Date());
  const retryDelays = o.retryDelaysMs ?? RETRY_DELAYS_MS;

  let timer: unknown = null;
  let running: Promise<boolean> | null = null;
  let failures = 0;
  let disposed = false;

  const clear = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    if (disposed) return;
    clear();
    timer = timers.setTimeout(() => {
      timer = null;
      void flush();
    }, ms);
  };

  /**
   * Re-stores assets the saved document names but the database lacks (from the store's cache). Runs after
   * `markSaved`, so a failure here never leaves the tab on a stale base rev; what cannot be restored is reported.
   */
  const restoreMissing = async (keys: readonly string[]): Promise<void> => {
    const cache = store.getState().assets;
    const lost: string[] = [];
    for (const key of keys) {
      const blob = cache.get(key);
      try {
        if (blob) await repo.putAssetBlob(key, blob);
        else lost.push(key);
      } catch {
        lost.push(key);
      }
    }
    if (lost.length > 0) o.onMissingAssets?.(lost);
  };

  /** One save of the current changes. False when it failed (a retry is scheduled). */
  const saveOnce = async (): Promise<boolean> => {
    const ticket = store.getState().beginSave();
    if (!ticket) return true;
    try {
      const result = await repo.save(ticket.doc, ticket.newAssets, { baseRev: ticket.baseRev });
      if (result.ok) {
        store.getState().markSaved(ticket, { rev: result.rev });
        if ('missingAssets' in result && result.missingAssets) await restoreMissing(result.missingAssets);
      } else {
        // Never overwrite: the tab's document becomes a new project, and the tab goes on editing that (§5.5.2).
        const name = copyName(ticket.doc.name, now());
        const copy = await repo.saveAsCopy({ ...ticket.doc, name }, ticket.newAssets);
        if (store.getState().rebind(ticket, { id: copy.id, rev: copy.rev, name })) {
          repo.release(ticket.doc.id);
          if (repo.holdsLock(copy.id)) store.getState().setReadOnly(false);
          o.onConflict?.({ originalId: ticket.doc.id, originalName: ticket.doc.name, copyId: copy.id, copyName: name, storedRev: result.conflict.storedRev });
        }
      }
      if (failures > 0) {
        failures = 0;
        o.onRecovered?.();
      }
      return true;
    } catch (error) {
      store.getState().markSaveFailed(ticket, error);
      failures++;
      schedule(retryDelays[Math.min(failures, retryDelays.length) - 1] ?? 30_000);
      o.onError?.(error, failures);
      return false;
    }
  };

  const dirty = (): boolean => {
    const s = store.getState();
    return s.doc !== null && s.changeId !== s.savedChangeId;
  };

  const flush = async (): Promise<void> => {
    clear();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (running) {
        await running;
        continue;
      }
      if (!dirty()) return;
      running = saveOnce().finally(() => {
        running = null;
      });
      if (!(await running)) return;
    }
    // Still edits arriving: the debounce picks them up.
    if (dirty()) schedule(debounceMs);
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.session !== prev.session) {
      // Another project (or none): the leave path flushed the old one first.
      clear();
      failures = 0;
      if (dirty()) schedule(debounceMs);
      return;
    }
    if (s.changeId !== prev.changeId && dirty()) schedule(debounceMs);
  });

  return {
    flush,
    pending: () => timer !== null || running !== null,
    failures: () => failures,
    dispose() {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}
