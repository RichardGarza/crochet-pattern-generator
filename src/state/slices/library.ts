// Track T8 — the library's state (DESIGN.md §5.7, §5.5.4, §5.5.5): what the start screen shows besides the
// project summaries (those stay in appStore.library, which the shell and the session keep current):
//
//   - "Recently deleted" (null until loaded);
//   - the folder mirror: on/off, the folder's path and free space, restore offers, projects changed in the
//     folder, two-sided edits kept as copies;
//   - thumbnails (object URLs by asset key: content-addressed, so a key's URL never goes stale);
//   - which project an action is running on (the card shows it busy).
//
// The actions live in ui/library (they need the repository and the mirror); this slice only holds state.
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { MIRROR_OFF, type MirrorState } from '../../core/persist/folderClient';
import type { TrashEntry } from '../../core/persist/repo';

export interface LibraryState {
  trash: TrashEntry[] | null;
  mirror: MirrorState;
  /** Object URLs of thumbnails by asset key. */
  thumbs: Readonly<Record<string, string>>;
  /** Project id → what is running on it ("Duplicating…"). */
  busy: Readonly<Record<string, string>>;
  setTrash(list: TrashEntry[] | null): void;
  setMirror(state: MirrorState): void;
  setThumb(key: string, url: string): void;
  setBusy(id: string, what: string | null): void;
  /** Forgets everything (and revokes the thumbnail URLs through `revoke`). */
  reset(revoke?: (url: string) => void): void;
}

export type LibraryStore = StoreApi<LibraryState>;

export function createLibraryStore(): LibraryStore {
  return createStore<LibraryState>()((set, get) => ({
    trash: null,
    mirror: MIRROR_OFF,
    thumbs: {},
    busy: {},
    setTrash: (list) => set({ trash: list === null ? null : [...list] }),
    setMirror: (mirror) => set({ mirror }),
    setThumb: (key, url) => {
      if (get().thumbs[key] === url) return;
      set({ thumbs: { ...get().thumbs, [key]: url } });
    },
    setBusy: (id, what) => {
      const busy = { ...get().busy };
      if (what === null) delete busy[id];
      else busy[id] = what;
      set({ busy });
    },
    reset: (revoke) => {
      if (revoke) for (const url of Object.values(get().thumbs)) revoke(url);
      set({ trash: null, mirror: MIRROR_OFF, thumbs: {}, busy: {} });
    },
  }));
}

export const libraryStore: LibraryStore = createLibraryStore();

export function useLibrary<T>(selector: (state: LibraryState) => T): T {
  return useStore(libraryStore, selector);
}

/** Days left before a deleted project is purged (never below 0). */
export function daysLeft(deletedAt: string, now: Date, keepMs: number): number {
  const at = Date.parse(deletedAt);
  if (!Number.isFinite(at)) return Math.ceil(keepMs / 86_400_000);
  return Math.max(0, Math.ceil((at + keepMs - now.getTime()) / 86_400_000));
}
