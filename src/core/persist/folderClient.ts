// Track T8 — the app's side of the folder mirror (DESIGN.md §5.5.4): the `/__projects` client and the sync
// engine that mirrors every save into the projects folder of the dev/preview server.
//
//   - Mirroring: after a save (debounced 5 s) the project's missing assets are uploaded (the folder lists what
//     it has), then its project.json with a compare-and-swap on the folder (`x-cpg-base-sha256` = the hash this
//     installation last synced). Success writes the `meta` entry `sync:<id>` = { lastSyncedRev, lastSyncedHash }.
//   - On start (`reconcile`): folder = last synced and the local rev newer ⇒ push; local unchanged and the folder
//     changed ⇒ offer to load the folder version; both changed (a two-sided edit, detectable only with the sync
//     base) ⇒ keep both — the folder's copy is imported as "<name> (from folder)", then this browser's version
//     goes to the folder; in the folder but not in this browser ⇒ offer to restore.
//   - Nothing is ever overwritten without a copy: loading the folder version snapshots the browser's first,
//     restores go through `importFile` (which never overwrites), and the server moves deleted projects to
//     `Backups/deleted/`.
//
// Pushes and the start-up reconcile of all tabs run one at a time under the Web Lock `cpg-mirror`, so two tabs
// never race each other into a false two-sided edit. Pure TypeScript: `fetch`, the repository, timers and the
// lock manager are injected (unit tests run it against the real plugin on a temp folder).
import type { LockManagerLike } from '../../types/entryPoints';
import type { ProjectDoc } from '../../types/project';
import { collectAssetKeys, expandAssetKeys, sha256Hex, shaOfKey } from './assets';
import { buildProjectFile, checkDoc, projectFileBlob } from './fileFormat';
import {
  BASE_SHA_HEADER,
  BACKUPS_ROUTE,
  MIRROR_HEADER,
  NO_BASE,
  PROJECTS_ROUTE,
  SHA_HEADER,
  assetUrl,
  assetsUrl,
  backupAssetUrl,
  backupDocUrl,
  docUrl,
  isFolderProjectId,
  projectUrl,
  type BackupListing,
  type DeleteResult,
  type FolderListing,
  type FolderProjectEntry,
  type FolderStatus,
  type PutAssetResult,
  type PutDocResult,
} from './folderProtocol';
import { migrateDoc } from './migrations';
import { SYNC_PREFIX, realTimers, sameContent, type ImportOutcome, type PersistRepository, type Timers } from './repo';

/** §5.5.4: the app mirrors every save, debounced 5 s. */
export const MIRROR_DEBOUNCE_MS = 5000;
/** The Web Lock that serializes pushes and reconciles across tabs. */
export const MIRROR_LOCK = 'cpg-mirror';

export type FetchLike = (url: string, init?: { method?: string; body?: Blob | string; headers?: Record<string, string>; cache?: 'no-store' }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
}>;

export class FolderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FolderError';
    this.status = status;
  }
}

/** The `/__projects` and `/__backups` client. */
export interface FolderApi {
  /** `HEAD /__projects` answers `x-cpg-mirror: on`. Never rejects. */
  probe(): Promise<boolean>;
  list(): Promise<FolderListing>;
  getDoc(id: string): Promise<{ text: string; sha256: string } | null>;
  /** `base`: the sha last synced, null = "the folder must not have it", undefined = unconditional. */
  putDoc(id: string, text: string, base: string | null | undefined): Promise<PutDocResult>;
  listAssets(id: string): Promise<string[]>;
  getAsset(id: string, sha: string): Promise<Blob | null>;
  putAsset(id: string, sha: string, blob: Blob): Promise<PutAssetResult>;
  remove(id: string): Promise<DeleteResult>;
  listBackups(): Promise<BackupListing>;
  getBackupDoc(backup: string, id: string): Promise<string | null>;
  getBackupAsset(sha: string): Promise<Blob | null>;
}

export function createFolderApi(o: { fetch?: FetchLike; base?: string } = {}): FolderApi {
  const fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const base = o.base ?? '';
  const call = async (path: string, init: Parameters<FetchLike>[1] = {}) => {
    const r = await fetchFn(base + path, { cache: 'no-store', ...init });
    return r;
  };
  const failed = async (r: Awaited<ReturnType<FetchLike>>, what: string): Promise<never> => {
    let detail = '';
    try {
      const body = (await r.json()) as { error?: unknown };
      if (typeof body?.error === 'string') detail = `: ${body.error}`;
    } catch {
      // not JSON
    }
    throw new FolderError(r.status, `The projects folder could not ${what} (${r.status})${detail}`);
  };
  const json = async <T>(path: string, what: string, init?: Parameters<FetchLike>[1]): Promise<T> => {
    const r = await call(path, init);
    if (!r.ok) return failed(r, what);
    return (await r.json()) as T;
  };
  return {
    async probe() {
      try {
        const r = await call(PROJECTS_ROUTE, { method: 'HEAD' });
        return r.headers.get(MIRROR_HEADER) === 'on';
      } catch {
        return false;
      }
    },
    list: () => json<FolderListing>(PROJECTS_ROUTE, 'be read'),
    async getDoc(id) {
      const r = await call(docUrl(id));
      if (r.status === 404) return null;
      if (!r.ok) return failed(r, 'send a project');
      const text = await r.text();
      return { text, sha256: r.headers.get(SHA_HEADER) ?? (await sha256Hex(new TextEncoder().encode(text))) };
    },
    putDoc: (id, text, b) =>
      json<PutDocResult>(docUrl(id), 'save a project', {
        method: 'PUT',
        body: text,
        headers: { 'Content-Type': 'application/json', ...(b === undefined ? {} : { [BASE_SHA_HEADER]: b ?? NO_BASE }) },
      }),
    async listAssets(id) {
      return (await json<{ assets: string[] }>(assetsUrl(id), 'list files')).assets;
    },
    async getAsset(id, sha) {
      const r = await call(assetUrl(id, sha));
      if (r.status === 404) return null;
      if (!r.ok) return failed(r, 'send a file');
      return r.blob();
    },
    putAsset: (id, sha, blob) => json<PutAssetResult>(assetUrl(id, sha), 'save a file', { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } }),
    remove: (id) => json<DeleteResult>(projectUrl(id), 'delete a project', { method: 'DELETE' }),
    listBackups: () => json<BackupListing>(BACKUPS_ROUTE, 'list backups'),
    async getBackupDoc(backup, id) {
      const r = await call(backupDocUrl(backup, id));
      if (r.status === 404) return null;
      if (!r.ok) return failed(r, 'send a backed-up project');
      return r.text();
    },
    async getBackupAsset(sha) {
      const r = await call(backupAssetUrl(sha));
      if (r.status === 404) return null;
      if (!r.ok) return failed(r, 'send a backed-up file');
      return r.blob();
    },
  };
}

/** The `meta` entry `sync:<id>` (§5.5.1). */
export interface SyncBase {
  lastSyncedRev: number;
  lastSyncedHash: string;
}

const isSyncBase = (v: unknown): v is SyncBase =>
  typeof v === 'object' && v !== null && typeof (v as SyncBase).lastSyncedRev === 'number' && typeof (v as SyncBase).lastSyncedHash === 'string';

/** A two-sided edit resolved by keeping both. */
export interface KeptBoth {
  id: string;
  name: string;
  copyId: string;
  copyName: string;
}

export interface MirrorState {
  /** `off`: no mirror here; `error`: the last call failed (retried with the next save or start). */
  status: 'off' | 'starting' | 'idle' | 'syncing' | 'error';
  folder: FolderStatus | null;
  /** In the folder, not in this browser: "Restore". */
  restorable: FolderProjectEntry[];
  /** Changed in the folder while this browser's copy did not change: "Load the folder version" / "Keep both". */
  changedInFolder: FolderProjectEntry[];
  /** Two-sided edits this session resolved by keeping both. */
  keptBoth: KeptBoth[];
  /** Projects whose id the folder cannot hold (an imported file's odd id): not mirrored. */
  unsupported: string[];
  lastError: string | null;
}

export const MIRROR_OFF: MirrorState = { status: 'off', folder: null, restorable: [], changedInFolder: [], keptBoth: [], unsupported: [], lastError: null };

export type PushOutcome = 'pushed' | 'up-to-date' | 'gone' | 'unsupported' | 'kept-both';

export interface FolderMirrorOptions {
  repo: PersistRepository;
  api: FolderApi;
  /** Serializes pushes and reconciles across tabs (default: none). */
  locks?: LockManagerLike;
  timers?: Timers;
  debounceMs?: number;
  /** Ids of projects imported as "(from folder)" copies. */
  newId?: () => string;
}

export interface FolderMirror {
  state(): MirrorState;
  subscribe(listener: (s: MirrorState) => void): () => void;
  /** The start-up comparison of §5.5.4 (also "Check again"). */
  reconcile(): Promise<void>;
  /** Pushes `id` after the debounce. */
  schedule(id: string): void;
  /** Pushes every scheduled project now. */
  flush(): Promise<void>;
  push(id: string): Promise<PushOutcome>;
  /** Imports a folder project this browser does not have. */
  restoreFromFolder(id: string): Promise<ImportOutcome>;
  /** Replaces this browser's copy with the folder's (after a snapshot of the browser's). */
  loadFolderVersion(id: string): Promise<void>;
  /** Keeps both: the folder's copy is imported as "<name> (from folder)", then this browser's goes to the folder. */
  keepBoth(id: string): Promise<KeptBoth>;
  listBackups(): Promise<BackupListing>;
  /** Imports a project from a backup (never overwrites: an existing id becomes a copy). */
  restoreFromBackup(backup: string, id: string): Promise<ImportOutcome>;
  dispose(): void;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The folder's doc as a ProjectDoc (migrated, checked). */
function readFolderDoc(text: string): ProjectDoc {
  const raw = JSON.parse(text) as unknown;
  const { doc } = migrateDoc(raw);
  return checkDoc(doc);
}

export function createFolderMirror(o: FolderMirrorOptions): FolderMirror {
  const { repo, api } = o;
  const timers = o.timers ?? realTimers;
  const debounceMs = o.debounceMs ?? MIRROR_DEBOUNCE_MS;
  const newId = o.newId ?? (() => crypto.randomUUID());
  const listeners = new Set<(s: MirrorState) => void>();
  const pending = new Map<string, unknown>();
  let disposed = false;
  let current: MirrorState = { ...MIRROR_OFF, status: 'starting' };

  const set = (patch: Partial<MirrorState>): void => {
    current = { ...current, ...patch };
    for (const l of [...listeners]) l(current);
  };

  /** Runs `fn` under the cross-tab mirror lock (queued: every tab gets its turn). */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    if (!o.locks) return fn();
    let result: T;
    return o.locks
      .request(MIRROR_LOCK, {}, async () => {
        result = await fn();
      })
      .then(() => result);
  };

  const syncBase = async (id: string): Promise<SyncBase | undefined> => {
    const v = await repo.getMeta(SYNC_PREFIX + id);
    return isSyncBase(v) ? v : undefined;
  };

  /** Loads an asset for the folder side: this browser's copy, else the folder's. */
  const folderAssets = async (doc: ProjectDoc, fetchMissing: (sha: string) => Promise<Blob | null>): Promise<Map<string, Blob>> => {
    const assets = new Map<string, Blob>();
    const load = async (key: string): Promise<Blob | undefined> => {
      if (assets.has(key)) return assets.get(key);
      const sha = shaOfKey(key);
      if (!sha) return undefined;
      const blob = (await repo.getAssetByKey(key)) ?? (await fetchMissing(sha)) ?? undefined;
      if (blob) assets.set(key, blob);
      return blob;
    };
    const keys = await expandAssetKeys(collectAssetKeys(doc), load);
    for (const key of keys) await load(key);
    return assets;
  };

  /** Uploads what the folder lacks of `doc`'s assets (transitively through JSON assets). */
  const uploadAssets = async (id: string, doc: ProjectDoc): Promise<void> => {
    const have = new Set(await api.listAssets(id));
    const keys = await expandAssetKeys(collectAssetKeys(doc), (key) => repo.getAssetByKey(key));
    for (const key of [...keys].sort()) {
      const sha = shaOfKey(key);
      if (!sha || have.has(sha)) continue;
      const blob = await repo.getAssetByKey(key);
      if (!blob) continue; // missing here too: nothing to copy (the autosave reports it)
      await api.putAsset(id, sha, blob);
      have.add(sha);
    }
  };

  /** Imports a folder (or backup) document as a project of this browser. */
  const importDoc = async (doc: ProjectDoc, assets: Map<string, Blob>): Promise<ImportOutcome> => {
    const file = await buildProjectFile({ doc, assets });
    return repo.importFile(projectFileBlob(file));
  };

  /** Two-sided edit (§5.5.4): keep both. Caller holds the mirror lock. */
  const keepBothLocked = async (id: string, local: ProjectDoc): Promise<KeptBoth> => {
    const folder = await api.getDoc(id);
    if (!folder) throw new FolderError(404, 'The project is no longer in the folder.');
    const folderDoc = readFolderDoc(folder.text);
    const copyId = newId();
    const copyName = `${folderDoc.name} (from folder)`;
    const assets = await folderAssets(folderDoc, (sha) => api.getAsset(id, sha));
    const imported = await importDoc({ ...folderDoc, id: copyId, name: copyName }, assets);
    // This browser's version goes to the folder in place of the one just kept as a copy.
    await uploadAssets(id, local);
    const r = await api.putDoc(id, JSON.stringify(local), folder.sha256);
    if (r.ok) await repo.putMeta(SYNC_PREFIX + id, { lastSyncedRev: local.rev, lastSyncedHash: r.sha256 } satisfies SyncBase);
    const kept: KeptBoth = { id, name: local.name, copyId: imported.id, copyName: imported.name };
    set({ keptBoth: [...current.keptBoth, kept], changedInFolder: current.changedInFolder.filter((p) => p.id !== id) });
    // The copy is a project of its own: mirror it too.
    schedule(imported.id);
    return kept;
  };

  /** One push. Caller holds the mirror lock. */
  const pushLocked = async (id: string): Promise<PushOutcome> => {
    const doc = await repo.peek(id);
    if (!doc) return 'gone';
    if (!isFolderProjectId(id)) {
      if (!current.unsupported.includes(id)) set({ unsupported: [...current.unsupported, id] });
      return 'unsupported';
    }
    const base = await syncBase(id);
    if (base && base.lastSyncedRev === doc.rev) return 'up-to-date';
    await uploadAssets(id, doc);
    const text = JSON.stringify(doc);
    const r = await api.putDoc(id, text, base ? base.lastSyncedHash : null);
    if (r.ok) {
      await repo.putMeta(SYNC_PREFIX + id, { lastSyncedRev: doc.rev, lastSyncedHash: r.sha256 } satisfies SyncBase);
      return 'pushed';
    }
    // The folder holds a version this installation did not sync. The same content (another serialization, or
    // a first sync after the browser's data was reset): adopt it. Otherwise both sides changed: keep both.
    const folder = r.sha256 === null ? null : await api.getDoc(id);
    if (folder) {
      let same = false;
      try {
        same = sameContent(readFolderDoc(folder.text), doc);
      } catch {
        same = false; // a damaged folder doc: keep it as a copy is impossible; overwrite below would lose it
      }
      if (same) {
        const again = await api.putDoc(id, text, folder.sha256);
        if (again.ok) {
          await repo.putMeta(SYNC_PREFIX + id, { lastSyncedRev: doc.rev, lastSyncedHash: again.sha256 } satisfies SyncBase);
          return 'pushed';
        }
      }
    }
    await keepBothLocked(id, doc);
    return 'kept-both';
  };

  const run = async <T>(what: () => Promise<T>): Promise<T> => {
    try {
      const out = await what();
      if (current.status === 'error' || current.status === 'syncing') set({ status: 'idle', lastError: null });
      return out;
    } catch (error) {
      set({ status: 'error', lastError: errorText(error) });
      throw error;
    }
  };

  const push = (id: string): Promise<PushOutcome> => run(() => exclusive(() => pushLocked(id)));

  function schedule(id: string): void {
    if (disposed) return;
    const old = pending.get(id);
    if (old !== undefined) timers.clearTimeout(old);
    pending.set(
      id,
      timers.setTimeout(() => {
        pending.delete(id);
        void push(id).catch(() => {});
      }, debounceMs),
    );
  }

  const unsubscribe = repo.subscribe((e) => {
    if (disposed) return;
    if ((e.type === 'saved' || e.type === 'restored') && !e.remote) schedule(e.id);
    // A project deleted for good here (purged from "Recently deleted"): the folder moves it to Backups/deleted.
    if (e.type === 'removed' && !e.remote && isFolderProjectId(e.id)) {
      const old = pending.get(e.id);
      if (old !== undefined) timers.clearTimeout(old);
      pending.delete(e.id);
      void run(() => exclusive(() => api.remove(e.id))).catch(() => {});
    }
  });

  const mirror: FolderMirror = {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async reconcile() {
      set({ status: 'syncing' });
      await run(() =>
        exclusive(async () => {
          const listing = await api.list();
          const local = new Map((await repo.storedProjects()).map((p) => [p.id, p]));
          const restorable: FolderProjectEntry[] = [];
          const changedInFolder: FolderProjectEntry[] = [];
          const inFolder = new Set<string>();
          for (const f of listing.projects) {
            inFolder.add(f.id);
            const l = local.get(f.id);
            if (!l) {
              restorable.push(f);
              continue;
            }
            const base = await syncBase(f.id);
            if (!base) {
              await pushLocked(f.id); // adopts the same content, or keeps both
              continue;
            }
            const localNewer = l.rev > base.lastSyncedRev;
            const localOlder = l.rev < base.lastSyncedRev;
            const folderChanged = f.docSha256 !== base.lastSyncedHash;
            if (localNewer && folderChanged) {
              const doc = await repo.peek(f.id);
              if (doc) await keepBothLocked(f.id, doc);
            } else if (localNewer) {
              await pushLocked(f.id);
            } else if (folderChanged || localOlder) {
              changedInFolder.push(f);
            }
          }
          for (const id of local.keys()) if (!inFolder.has(id)) await pushLocked(id);
          set({ folder: listing.status, restorable, changedInFolder });
        }),
      );
      set({ status: 'idle' });
    },

    schedule,

    async flush() {
      const ids = [...pending.keys()];
      for (const id of ids) {
        timers.clearTimeout(pending.get(id));
        pending.delete(id);
      }
      for (const id of ids) await push(id).catch(() => {});
    },

    push,

    restoreFromFolder: (id) =>
      run(() =>
        exclusive(async () => {
          const folder = await api.getDoc(id);
          if (!folder) throw new FolderError(404, 'The project is no longer in the folder.');
          const doc = readFolderDoc(folder.text);
          const outcome = await importDoc(doc, await folderAssets(doc, (sha) => api.getAsset(id, sha)));
          if (outcome.status === 'imported') {
            const stored = await repo.peek(outcome.id);
            if (stored) await repo.putMeta(SYNC_PREFIX + id, { lastSyncedRev: stored.rev, lastSyncedHash: folder.sha256 } satisfies SyncBase);
          } else if (outcome.status === 'imported-as-copy') {
            schedule(outcome.id);
          }
          set({ restorable: current.restorable.filter((p) => p.id !== id) });
          return outcome;
        }),
      ),

    loadFolderVersion: (id) =>
      run(() =>
        exclusive(async () => {
          const folder = await api.getDoc(id);
          if (!folder) throw new FolderError(404, 'The project is no longer in the folder.');
          const folderDoc = readFolderDoc(folder.text);
          const assets = await folderAssets(folderDoc, (sha) => api.getAsset(id, sha));
          for (const [key, blob] of assets) await repo.putAssetBlob(key, blob);
          const held = repo.holdsLock(id);
          const opened = await repo.open(id, 'edit');
          if (opened.readOnly) throw new Error('This project is open in another tab; close it there first.');
          try {
            await repo.snapshot(id, 'Before loading the folder version');
            const r = await repo.save({ ...folderDoc, id }, new Map(), { baseRev: opened.doc.rev });
            if (!r.ok) throw new Error('The project changed meanwhile; try again.');
            await repo.putMeta(SYNC_PREFIX + id, { lastSyncedRev: r.rev, lastSyncedHash: folder.sha256 } satisfies SyncBase);
          } finally {
            if (!held) repo.release(id);
          }
          set({ changedInFolder: current.changedInFolder.filter((p) => p.id !== id) });
        }),
      ),

    keepBoth: (id) =>
      run(() =>
        exclusive(async () => {
          const doc = await repo.peek(id);
          if (!doc) throw new Error('This project is no longer in this browser.');
          return keepBothLocked(id, doc);
        }),
      ),

    listBackups: () => run(() => api.listBackups()),

    restoreFromBackup: (backup, id) =>
      run(async () => {
        const text = await api.getBackupDoc(backup, id);
        if (text === null) throw new FolderError(404, 'That project is not in the backup.');
        const doc = readFolderDoc(text);
        return importDoc(doc, await folderAssets(doc, (sha) => api.getBackupAsset(sha)));
      }),

    dispose() {
      disposed = true;
      unsubscribe();
      for (const handle of pending.values()) timers.clearTimeout(handle);
      pending.clear();
      listeners.clear();
    },
  };
  return mirror;
}
