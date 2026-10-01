// Track T8 — the project repository on IndexedDB (DESIGN.md §5.5; §5.2.1 `createProjectRepository`):
//
//   - compare-and-swap saves: `save` reads the stored rev inside its readwrite transaction and never writes
//     over a newer one (the caller then saves its document as a copy, `saveAsCopy`);
//   - one writer per project: `open(id, 'edit')` holds the Web Lock `project:<id>` while the project is open;
//     a second tab opens read-only, asks for the lock ("Edit here instead": a `release` message on the
//     `BroadcastChannel('cpg')`, the holder flushes and lets go) and, when nobody answers within 5 s, may take
//     it (`takeOver`: a steal that also bumps the stored rev, so anything the old holder still saves becomes a
//     copy);
//   - schema upgrades: a `versionchange` from a newer tab flushes, closes this connection and tells the app
//     ("This tab was closed for an update"); a blocked upgrade asks to close the other tabs;
//   - snapshots (every 20 revs or 5 minutes, before migrations, imports and take-overs; retention of §5.5.2);
//   - `.crochet.json` export and import (import never overwrites), asset store and GC, `storage.persist()`;
//   - the library (T8.2): "Recently deleted" (a deleted project stays 30 days, `meta` entry `trash:<id>`),
//     duplicate, and the `meta` entries of the folder mirror (`sync:<id>`).
//
// Unit tests pass fake-indexeddb, the lock fake and the channel fake (src/test/fakes.ts); the app passes
// nothing and gets `indexedDB`, `navigator.locks` and `BroadcastChannel`.
import { canonicalJson } from '../kernel/hash';
import type { ChannelLike, CreateProjectRepositoryFn, LockManagerLike, ProjectRepository } from '../../types/entryPoints';
import type { AssetRef, ProjectDoc, ProjectSummary } from '../../types/project';
import { assetKeyOf, collectAssetKeys, expandAssetKeys, refFor, selectUnreferenced, sha256Hex, shaOfKey, ASSET_GC_MIN_AGE_MS } from './assets';
import { MAX_REV, buildProjectFile, checkDoc, isValidProjectId, parseProjectFile, projectFileBlob, type ProjectFileRevision } from './fileFormat';
import type { IDBPTransaction } from 'idb';
import { openDatabase, projectRange, type CpgDatabase, type CpgDB, type StoredAsset, type StoredRevision } from './idb';
import { holdLock, lockName, type HeldLock, type LockSnapshot, type QueryableLocks } from './locks';
import { CURRENT_DOC_VERSION, isNewerVersion, migrateDoc } from './migrations';
import { revsToKeep, snapshotDue, type SnapshotInfo } from './snapshots';

export type { ChannelLike, LockManagerLike, ProjectRepository } from '../../types/entryPoints';

const AUTOSAVE_LABEL = 'Autosave';

/** The BroadcastChannel name of §5.5.2. */
export const CHANNEL_NAME = 'cpg';
/** How long "Edit here instead" waits for the other tab before offering Take over (§5.5.2). */
export const HAND_OVER_TIMEOUT_MS = 5000;
/** How often "Edit here instead" retries the lock after the holder said it let go. */
export const HAND_OVER_RETRY_MS = 100;
/** How long a hand-over or an upgrade waits for the pending save before letting go anyway. */
export const FLUSH_TIMEOUT_MS = 4000;
/** "Recently deleted" keeps a project this long before it is purged (§5.5.5). */
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** `meta` key of a deleted project: `{ deletedAt }`. */
export const TRASH_PREFIX = 'trash:';
/** `meta` key of the folder mirror's sync base of a project (§5.5.1). */
export const SYNC_PREFIX = 'sync:';
/** `meta` key of a project deleted for good whose folder copy the mirror must still move away: `{ deletedAt, lastSyncedHash }`. */
export const GONE_PREFIX = 'gone:';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What the repository uses of `navigator.storage`. */
export interface StorageLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export interface RepositoryOptions {
  idb?: IDBFactory;
  locks?: LockManagerLike;
  channel?: (name: string) => ChannelLike;
  now?: () => Date;
  /** New project ids (default `crypto.randomUUID()`); must satisfy `isProjectId`. */
  newId?: () => string;
  /** This tab's id on the channel (default random). */
  tabId?: string;
  timers?: Timers;
  /** `navigator.storage` (null: none). */
  storage?: StorageLike | null;
  dbName?: string;
  /** Tests of the upgrade path only. */
  dbVersion?: number;
  handOverTimeoutMs?: number;
  flushTimeoutMs?: number;
  /**
   * Lists the origin's held Web Locks (`navigator.locks.query`): start-up GC skips its round while another tab
   * edits a project. Default: the lock manager's own `query`, if it has one.
   */
  queryLocks?: () => Promise<LockSnapshot>;
}

export type LockLostReason = 'stolen' | 'handed-over' | 'failed';

export type RepositoryEvent =
  /** This tab no longer holds the project's lock: it must switch to read-only. */
  | { type: 'lock-lost'; id: string; reason: LockLostReason }
  /** A hand-over this tab asked for arrived after "Edit here instead" had timed out. */
  | { type: 'lock-acquired'; id: string; doc: ProjectDoc }
  /** Another tab asked this one to hand the project over (the flush runs next). */
  | { type: 'hand-over-requested'; id: string }
  | { type: 'saved'; id: string; rev: number; summary: ProjectSummary; remote: boolean }
  | { type: 'removed'; id: string; remote: boolean }
  /** Moved to "Recently deleted" (the document is kept). */
  | { type: 'trashed'; id: string; remote: boolean }
  /** Back from "Recently deleted". */
  | { type: 'restored'; id: string; summary: ProjectSummary; remote: boolean }
  /** A newer version of the app wants the database: the pending save is flushed, then the connection closes. */
  | { type: 'blocking' }
  | { type: 'closed-for-upgrade' }
  /** This tab's upgrade waits for other tabs to close. */
  | { type: 'blocked' }
  | { type: 'unblocked' }
  /** The browser closed the database (storage cleared, disk failure). */
  | { type: 'terminated' };

export type HandOverResult = { ok: true; doc: ProjectDoc } | { ok: false; reason: 'timeout' | 'busy' | 'closed' };

export type ImportOutcome = {
  id: string;
  renamed: boolean;
  /** `already-present`: same id and identical content ("already in your library"). */
  status: 'imported' | 'imported-as-copy' | 'already-present';
  name: string;
};

export interface SaveOk {
  ok: true;
  rev: number;
  /** Asset keys the saved document names that are neither stored nor in `newAssets` (put them, `putAssetBlob`). */
  missingAssets?: string[];
}

export interface RevisionInfo {
  rev: number;
  at: string;
  label: string;
}

/** A project in "Recently deleted". */
export interface TrashEntry {
  summary: ProjectSummary;
  /** ISO time it was deleted. */
  deletedAt: string;
}

/** A stored project as the folder mirror sees it. */
export interface StoredProjectInfo {
  id: string;
  rev: number;
  name: string;
  trashed: boolean;
}

export type GcResult = { deleted: string[]; skipped?: 'editing-elsewhere' | 'no-lock-query' };

/** The repository of the app: the frozen `ProjectRepository` plus what the session and the library need. */
export interface PersistRepository extends ProjectRepository {
  readonly tabId: string;
  /** Stores a new project at rev 1 and holds its lock (§5.5.2: requests `storage.persist()`). Fails for an existing id. */
  create(doc: ProjectDoc): Promise<ProjectDoc>;
  save(doc: ProjectDoc, newAssets: Map<string, Blob>, o: { baseRev: number }): Promise<SaveOk | { ok: false; conflict: { storedRev: number } }>;
  importFile(f: Blob): Promise<ImportOutcome>;
  /** Lets go of the project's lock (leaving the project). */
  release(id: string): void;
  holdsLock(id: string): boolean;
  /** The projects whose lock this tab holds. */
  heldIds(): string[];
  /** "Edit here instead": asks the holder to hand the lock over; `timeout` after 5 s (then offer Take over). */
  requestHandOver(id: string, o?: { timeoutMs?: number }): Promise<HandOverResult>;
  /** Forgets a pending hand-over request (the user left the project or took over). */
  cancelHandOver(id: string): void;
  /**
   * What the repository awaits before it lets go of a lock or closes for an upgrade: the pending save. It
   * resolves `true` when nothing is left unsaved (a hand-over happens only then).
   */
  setFlushHandler(flush: (() => Promise<boolean>) | null): void;
  subscribe(listener: (e: RepositoryEvent) => void): () => void;
  /** Snapshots the stored document under its rev with `label` (before migrations, imports, rebuilds, cuts, deletes). */
  snapshot(id: string, label: string): Promise<number | null>;
  listRevisions(id: string): Promise<RevisionInfo[]>;
  getRevision(id: string, rev: number): Promise<StoredRevision | undefined>;
  /** An asset by key (`projectStore.setAssetLoader`), undefined when it is not stored. */
  getAssetByKey(key: string): Promise<Blob | undefined>;
  /** Stores a blob under its key (hash checked), unless it is there already. */
  putAssetBlob(key: string, blob: Blob): Promise<void>;
  /**
   * Deletes assets referenced by no project and no snapshot, older than 7 days (§5.5.5). With
   * `skipWhileEditing` (start-up) the round is skipped while another tab holds a `project:` lock.
   */
  gcAssets(o?: { minAgeMs?: number; skipWhileEditing?: boolean }): Promise<GcResult>;
  getSetting(key: string): Promise<unknown>;
  putSetting(key: string, value: unknown): Promise<void>;
  /** The `meta` store (per installation, never exported): `sync:<id>`, `trash:<id>`. */
  getMeta(key: string): Promise<unknown>;
  putMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Every stored project (trashed ones too) with its rev: what the folder mirror compares. */
  storedProjects(): Promise<StoredProjectInfo[]>;
  /** A stored document without taking its lock (migrated in memory, never written); undefined when absent. */
  peek(id: string): Promise<ProjectDoc | undefined>;
  /**
   * Library delete: snapshots the project and moves it to "Recently deleted" (kept 30 days). Refuses a project
   * another tab is editing (`ProjectLockedError`).
   */
  trash(id: string): Promise<void>;
  /** Back from "Recently deleted". */
  restoreFromTrash(id: string): Promise<ProjectSummary>;
  /** "Recently deleted", newest first. */
  listTrash(): Promise<TrashEntry[]>;
  /** Deletes for good (`remove`) the projects deleted more than `keepMs` ago; skips any another tab holds. */
  purgeTrash(o?: { keepMs?: number }): Promise<string[]>;
  /** A copy of a stored project under a new id, named "<name> (copy)"; assets are shared by key. */
  duplicate(id: string): Promise<ProjectSummary>;
  /** `navigator.storage.persist()`; null when there is no storage manager. */
  requestPersistence(): Promise<boolean | null>;
  estimate(): Promise<{ usage: number; quota: number } | null>;
  /** Closes the database and the channel and lets go of every lock. */
  close(): void;
  readonly isClosed: () => boolean;
}

export class ProjectNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`There is no project ${JSON.stringify(id)} in this browser.`);
    this.name = 'ProjectNotFoundError';
    this.id = id;
  }
}

export class ProjectLockedError extends Error {
  readonly id: string;
  constructor(id: string, what: string) {
    super(`This project is open for editing in another tab; ${what} there, or close it first.`);
    this.name = 'ProjectLockedError';
    this.id = id;
  }
}

export class RepositoryClosedError extends Error {
  constructor(why: 'closed' | 'upgrade') {
    super(why === 'upgrade' ? 'This tab was closed for an update; reload it to keep working.' : 'The project storage is closed.');
    this.name = 'RepositoryClosedError';
  }
}

export class AssetNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`The file ${key} is missing from this browser's storage.`);
    this.name = 'AssetNotFoundError';
    this.key = key;
  }
}

/** The library card of a document (the same fields as the shell's `summaryOf`). */
export function summaryOfDoc(doc: ProjectDoc): ProjectSummary {
  return {
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    updatedAt: doc.updatedAt,
    ...(doc.thumbnail ? { thumbnail: doc.thumbnail } : {}),
    ...(doc.qa?.awaiting ? { awaitingClaudeDesign: true } : {}),
  };
}

/** Library order: last changed first, then by id (names may repeat, §5.5.2). */
export const newestFirst = (a: ProjectSummary, b: ProjectSummary): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** "<name> (copy, 14:05)" — the conflict copy's name (§5.5.2). */
export function copyName(name: string, at: Date): string {
  return `${name} (copy, ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')})`;
}

/** "<name> (imported 2026-10-01)" (§5.5.3). */
export function importedName(name: string, at: Date): string {
  return `${name} (imported ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')})`;
}

const defaultId = (): string => crypto.randomUUID();

type TxStore = 'projects' | 'assets' | 'revisions' | 'meta';

/** The content of a document for "identical" (§5.5.3): everything but the persistence counters. */
const contentOf = (doc: ProjectDoc): string => canonicalJson({ ...doc, rev: 0, updatedAt: '' });

/** True when two documents hold the same content (ignoring `rev` and `updatedAt`). */
export const sameContent = (a: ProjectDoc, b: ProjectDoc): boolean => contentOf(a) === contentOf(b);

type ChannelMessage =
  | { type: 'release'; id: string; from: string }
  | { type: 'released'; id: string; to: string }
  | { type: 'saved'; id: string; rev: number; summary: ProjectSummary; from: string }
  | { type: 'removed'; id: string; from: string }
  | { type: 'trashed'; id: string; from: string }
  | { type: 'restored'; id: string; summary: ProjectSummary; from: string }
  | { type: 'taken-over'; id: string; from: string };

function readMessage(data: unknown): ChannelMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  switch (m.type) {
    case 'release':
    case 'saved':
    case 'removed':
    case 'trashed':
    case 'restored':
    case 'taken-over':
      if (typeof m.from !== 'string') return null;
      if (m.type === 'saved' && (typeof m.rev !== 'number' || typeof m.summary !== 'object' || m.summary === null)) return null;
      if (m.type === 'restored' && (typeof m.summary !== 'object' || m.summary === null)) return null;
      return m as ChannelMessage;
    case 'released':
      return typeof m.to === 'string' ? (m as ChannelMessage) : null;
    default:
      return null;
  }
}

function defaultLocks(): LockManagerLike {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike | null }).locks : undefined;
  if (!locks) throw new Error('createProjectRepository: no lock manager (pass `locks`)');
  return locks;
}

function defaultChannel(name: string): ChannelLike {
  return new BroadcastChannel(name) as unknown as ChannelLike;
}

function defaultStorage(): StorageLike | null {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

/** The repository with everything the app needs (`createProjectRepository` is this, typed as frozen). */
export function createPersistRepository(o: RepositoryOptions = {}): PersistRepository {
  const factory = o.idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new Error('createProjectRepository: no IndexedDB (pass `idb`)');
  const locks: QueryableLocks = o.locks ?? defaultLocks();
  const queryLocks = o.queryLocks ?? (typeof locks.query === 'function' ? () => locks.query!() : undefined);
  const now = o.now ?? (() => new Date());
  const newId = o.newId ?? defaultId;
  const timers = o.timers ?? realTimers;
  const storage = o.storage === undefined ? defaultStorage() : o.storage;
  const tabId = o.tabId ?? defaultId();
  const handOverTimeoutMs = o.handOverTimeoutMs ?? HAND_OVER_TIMEOUT_MS;
  const flushTimeoutMs = o.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

  const listeners = new Set<(e: RepositoryEvent) => void>();
  const held = new Map<string, HeldLock>();
  /** Hand-overs this tab asked for: resolved by the holder's `released` message. */
  const waiting = new Map<string, { resolve: () => void; late: boolean }>();
  let flushHandler: (() => Promise<boolean>) | null = null;
  let closed: 'closed' | 'upgrade' | null = null;
  let dbPromise: Promise<CpgDatabase> | null = null;
  let blocked = false;

  const emit = (e: RepositoryEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (error) {
        // A listener's bug must not stop the others (or the save that emitted).
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const channel = (o.channel ?? defaultChannel)(CHANNEL_NAME);
  const post = (m: ChannelMessage): void => {
    if (closed === 'closed') return;
    try {
      channel.postMessage(m);
    } catch {
      // A closed channel (page going away): nothing to tell.
    }
  };

  /**
   * Waits for the pending save, but never longer than `flushTimeoutMs`. True when it finished in time and left
   * nothing unsaved.
   */
  const flushPending = async (): Promise<boolean> => {
    if (!flushHandler) return true;
    let handle: unknown;
    const done = await Promise.race([
      flushHandler().catch(() => false),
      new Promise<false>((resolve) => {
        handle = timers.setTimeout(() => resolve(false), flushTimeoutMs);
      }),
    ]);
    timers.clearTimeout(handle);
    return done;
  };

  const closeForUpgrade = async (): Promise<void> => {
    if (closed) return;
    emit({ type: 'blocking' });
    await flushPending();
    if (closed) return;
    closed = 'upgrade';
    const db = await dbPromise?.catch(() => null);
    db?.close();
    for (const [id, lock] of [...held]) {
      held.delete(id);
      lock.release();
    }
    emit({ type: 'closed-for-upgrade' });
  };

  const db = (): Promise<CpgDatabase> => {
    if (closed) return Promise.reject(new RepositoryClosedError(closed));
    dbPromise ??= openDatabase({
      factory,
      name: o.dbName,
      version: o.dbVersion,
      onBlocking: () => void closeForUpgrade(),
      onBlocked: () => {
        blocked = true;
        emit({ type: 'blocked' });
      },
      onTerminated: () => emit({ type: 'terminated' }),
    }).then(
      (opened) => {
        if (blocked) {
          blocked = false;
          emit({ type: 'unblocked' });
        }
        return opened;
      },
      (error: unknown) => {
        dbPromise = null; // a later call may try again
        throw error;
      },
    );
    return dbPromise;
  };

  // ---- locks

  const keep = (id: string, lock: HeldLock): void => {
    held.set(id, lock);
    void lock.ended.then((reason) => {
      if (held.get(id) !== lock) return;
      held.delete(id);
      if (reason !== 'released') emit({ type: 'lock-lost', id, reason });
    });
  };

  const acquire = async (id: string, opts: { ifAvailable?: boolean; steal?: boolean }): Promise<boolean> => {
    if (held.get(id)?.held()) return true;
    const lock = await holdLock(locks, lockName(id), opts);
    if (!lock) return false;
    if (closed) {
      lock.release();
      return false;
    }
    keep(id, lock);
    return true;
  };

  const release = (id: string): void => {
    const lock = held.get(id);
    held.delete(id);
    lock?.release();
  };

  /** The holder's side of "Edit here instead". */
  const handOver = async (id: string, to: string): Promise<void> => {
    const lock = held.get(id);
    if (!lock?.held()) return;
    emit({ type: 'hand-over-requested', id });
    const saved = await flushPending();
    if (held.get(id) !== lock) {
      // Released meanwhile (its unsaved changes went into a copy) or stolen: not ours to give, but the asker
      // need not wait for its timeout.
      if (!lock.held()) post({ type: 'released', id, to });
      return;
    }
    // Hand over only what is saved: with a failed or unfinished save the holder keeps the project, the asker
    // times out and may Take over — which bumps the rev, so the holder's late save becomes a copy.
    if (!saved) return;
    held.delete(id);
    lock.release();
    emit({ type: 'lock-lost', id, reason: 'handed-over' });
    // Tell the asker once the lock manager has really let go (its request settled), not before.
    await lock.ended;
    post({ type: 'released', id, to });
  };

  channel.onmessage = (event) => {
    const m = readMessage(event.data);
    if (!m) return;
    switch (m.type) {
      case 'release':
        void handOver(m.id, m.from);
        return;
      case 'released': {
        if (m.to !== tabId) return;
        waiting.get(m.id)?.resolve();
        return;
      }
      case 'saved':
        if (m.from !== tabId) emit({ type: 'saved', id: m.id, rev: m.rev, summary: m.summary, remote: true });
        return;
      case 'removed':
        if (m.from !== tabId) emit({ type: 'removed', id: m.id, remote: true });
        return;
      case 'trashed':
        if (m.from !== tabId) emit({ type: 'trashed', id: m.id, remote: true });
        return;
      case 'restored':
        if (m.from !== tabId) emit({ type: 'restored', id: m.id, summary: m.summary, remote: true });
        return;
      case 'taken-over':
        return; // the stolen lock's AbortError tells the old holder
    }
  };

  // ---- documents

  const readDoc = async (id: string): Promise<ProjectDoc | undefined> => (await db()).get('projects', id);

  const migrated = (raw: ProjectDoc): ReturnType<typeof migrateDoc> => {
    const r = migrateDoc(raw);
    checkDoc(r.doc);
    return r;
  };

  /** Writes a snapshot of `doc` (unless one exists for that rev) and prunes by the retention rules. */
  const writeSnapshot = async (
    store: unknown,
    doc: ProjectDoc,
    label: string,
    at: Date,
  ): Promise<void> => {
    const revisions = store as unknown as {
      get(key: [string, number]): Promise<StoredRevision | undefined>;
      put(v: StoredRevision): Promise<unknown>;
      getAll(range: IDBKeyRange): Promise<StoredRevision[]>;
      delete(key: [string, number]): Promise<void>;
    };
    const existing = await revisions.get([doc.id, doc.rev]);
    if (!existing) {
      await revisions.put({ projectId: doc.id, rev: doc.rev, at: at.toISOString(), label, doc });
    } else if (existing.label === AUTOSAVE_LABEL && label !== AUTOSAVE_LABEL) {
      // The same document at the same rev: a named reason says more than "Autosave".
      await revisions.put({ ...existing, label });
    }
    const all = await revisions.getAll(projectRange(doc.id));
    const keepRevs = revsToKeep(all.map((r) => ({ rev: r.rev, at: r.at })), at);
    for (const r of all) if (!keepRevs.has(r.rev)) await revisions.delete([doc.id, r.rev]);
  };

  const newestSnapshot = async (store: unknown, id: string): Promise<SnapshotInfo | undefined> => {
    const cursor = await (store as { openCursor(range: IDBKeyRange, dir: IDBCursorDirection): Promise<{ value: StoredRevision } | null> }).openCursor(
      projectRange(id),
      'prev',
    );
    return cursor ? { rev: cursor.value.rev, at: cursor.value.at } : undefined;
  };

  const putAssets = async (store: unknown, assets: ReadonlyMap<string, Blob>, at: Date): Promise<void> => {
    const s = store as { getKey(k: string): Promise<string | undefined>; put(v: StoredAsset, k: string): Promise<unknown> };
    for (const [key, blob] of assets) {
      if (!shaOfKey(key)) throw new TypeError(`Not an asset key: ${JSON.stringify(key)}`);
      if ((await s.getKey(key)) !== undefined) continue; // content-addressed: write once
      await s.put({ blob, mime: blob.type || 'application/octet-stream', bytes: blob.size, createdAt: at.toISOString() }, key);
    }
  };

  /** Runs `body` in one readwrite transaction; aborts it (nothing written) when `body` throws. */
  const inTransaction = async <T>(stores: TxStore[], body: (tx: IDBPTransaction<CpgDB, TxStore[], 'readwrite'>) => Promise<T>): Promise<T> => {
    const tx = (await db()).transaction(stores, 'readwrite');
    let result: T;
    try {
      result = await body(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await tx.done.catch(() => {});
      throw error;
    }
    await tx.done;
    return result;
  };

  const checkSavable = (doc: ProjectDoc): void => {
    if (!Number.isSafeInteger(doc.rev) || doc.rev < 0 || doc.rev > MAX_REV) throw new RangeError(`Invalid rev ${String(doc.rev)}`);
    if (typeof doc !== 'object' || doc === null || doc.schema !== 'crochet-project') throw new TypeError('Not a crochet-project document');
    if (!isValidProjectId(doc.id)) throw new TypeError(`Invalid project id ${JSON.stringify(doc.id)}`);
    if (doc.version !== CURRENT_DOC_VERSION) throw new TypeError(`Cannot save a document of version ${String(doc.version)}`);
  };

  const announceSaved = (doc: ProjectDoc): void => {
    const summary = summaryOfDoc(doc);
    emit({ type: 'saved', id: doc.id, rev: doc.rev, summary, remote: false });
    post({ type: 'saved', id: doc.id, rev: doc.rev, summary, from: tabId });
  };

  /** A stored asset's blob (typed), for following JSON assets to the keys inside them. */
  const loadStored =
    (d: CpgDatabase) =>
    async (key: string): Promise<Blob | undefined> => {
      const asset = await d.get('assets', key);
      if (!asset) return undefined;
      return asset.blob.type ? asset.blob : new Blob([asset.blob], { type: asset.mime });
    };

  /** The ids in "Recently deleted". */
  const trashedIds = async (d: CpgDatabase): Promise<Set<string>> => {
    if (!d.objectStoreNames.contains('meta')) return new Set(); // a foreign or damaged database: nothing trashed
    const keys = await d.getAllKeys('meta', IDBKeyRange.bound(TRASH_PREFIX, TRASH_PREFIX + '\uffff'));
    return new Set(keys.map((k) => String(k).slice(TRASH_PREFIX.length)));
  };

  const repo: PersistRepository = {
    tabId,
    isClosed: () => closed !== null,

    async list() {
      const d = await db();
      const docs = await d.getAll('projects');
      const trashed = await trashedIds(d);
      return docs
        .filter((doc) => typeof doc === 'object' && doc !== null && typeof doc.id === 'string' && !trashed.has(doc.id))
        .map(summaryOfDoc)
        .sort(newestFirst);
    },

    async create(doc) {
      checkSavable(doc);
      const hadLock = repo.holdsLock(doc.id);
      if (!(await acquire(doc.id, { ifAvailable: true }))) throw new ProjectLockedError(doc.id, 'create it');
      const at = now();
      try {
        const stored = await inTransaction(['projects', 'revisions'], async (tx) => {
          if (await tx.objectStore('projects').getKey(doc.id)) throw new Error(`A project with the id ${doc.id} exists already.`);
          const next: ProjectDoc = { ...doc, rev: 1 };
          await tx.objectStore('projects').put(next);
          await writeSnapshot(tx.objectStore('revisions'), next, 'Created', at);
          return next;
        });
        announceSaved(stored);
        return stored;
      } catch (error) {
        if (!hadLock) release(doc.id);
        throw error;
      }
    },

    async open(id, mode) {
      // The lock first, then the document: a hand-over's last save lands before we read.
      const hadLock = repo.holdsLock(id);
      const editing = mode === 'edit' && (await acquire(id, { ifAvailable: true }));
      try {
        const raw = await readDoc(id);
        if (!raw) throw new ProjectNotFoundError(id);
        const m = migrated(raw);
        if (!m.migrated || !editing) return { doc: m.doc, readOnly: !editing };
        // A migrated document is written back once, after a snapshot of the original (§5.5.3).
        const at = now();
        const doc = await inTransaction(['projects', 'revisions'], async (tx) => {
          const stored = await tx.objectStore('projects').get(id);
          if (!stored || stored.rev !== raw.rev) throw new Error('The project changed while it was being updated; open it again.');
          await writeSnapshot(tx.objectStore('revisions'), stored, `Before update to format ${CURRENT_DOC_VERSION}`, at);
          const next: ProjectDoc = { ...m.doc, rev: stored.rev + 1 };
          await tx.objectStore('projects').put(next);
          return next;
        });
        announceSaved(doc);
        return { doc, readOnly: false };
      } catch (error) {
        if (editing && !hadLock) release(id);
        throw error;
      }
    },

    async takeOver(id) {
      repo.cancelHandOver(id);
      await acquire(id, { steal: true });
      const at = now();
      try {
        const doc = await inTransaction(['projects', 'revisions'], async (tx) => {
          const stored = await tx.objectStore('projects').get(id);
          if (!stored) throw new ProjectNotFoundError(id);
          const m = migrated(stored);
          await writeSnapshot(tx.objectStore('revisions'), stored, 'Before take-over', at);
          // Bumping the rev makes every save the old holder still attempts a conflict, hence a copy (§5.5.2).
          const next: ProjectDoc = { ...m.doc, rev: stored.rev + 1 };
          await tx.objectStore('projects').put(next);
          return next;
        });
        post({ type: 'taken-over', id, from: tabId });
        announceSaved(doc);
        return { doc, readOnly: false as const };
      } catch (error) {
        release(id);
        throw error;
      }
    },

    async save(doc, newAssets, o) {
      checkSavable(doc);
      const at = now();
      const result = await inTransaction(['projects', 'assets', 'revisions', 'meta'], async (tx) => {
        const projects = tx.objectStore('projects');
        const stored = await projects.get(doc.id);
        const storedRev = stored?.rev ?? 0;
        if (storedRev > o.baseRev || (stored && isNewerVersion(stored.version))) {
          return { ok: false as const, conflict: { storedRev } };
        }
        // An edit of a project in "Recently deleted" (a tab that had it open, "Edit here instead", a journal
        // replay) takes it out again: new work is never purged with the deleted project (§5.5.5).
        const meta = tx.objectStore('meta');
        const untrashed = (await meta.getKey(TRASH_PREFIX + doc.id)) !== undefined;
        if (untrashed) await meta.delete(TRASH_PREFIX + doc.id);
        const rev = Math.max(storedRev, o.baseRev) + 1;
        if (!Number.isSafeInteger(rev) || rev > MAX_REV) throw new RangeError(`The revision counter of this project is exhausted (${rev}).`);
        const assets = tx.objectStore('assets');
        await putAssets(assets, newAssets, at);
        const next: ProjectDoc = { ...doc, rev };
        await projects.put(next);
        const missing: string[] = [];
        for (const key of collectAssetKeys(next)) {
          if (!newAssets.has(key) && (await assets.getKey(key)) === undefined) missing.push(key);
        }
        const revisions = tx.objectStore('revisions');
        if (snapshotDue(await newestSnapshot(revisions, doc.id), rev, at)) await writeSnapshot(revisions, next, AUTOSAVE_LABEL, at);
        return { ok: true as const, rev, next, missing, untrashed };
      });
      if (!result.ok) return result;
      announceSaved(result.next);
      if (result.untrashed) {
        const summary = summaryOfDoc(result.next);
        emit({ type: 'restored', id: doc.id, summary, remote: false });
        post({ type: 'restored', id: doc.id, summary, from: tabId });
      }
      return { ok: true, rev: result.rev, ...(result.missing.length > 0 ? { missingAssets: result.missing } : {}) };
    },

    async saveAsCopy(doc, newAssets) {
      checkSavable(doc);
      const id = newId();
      if (!isValidProjectId(id)) throw new TypeError(`newId produced an invalid project id ${JSON.stringify(id)}`);
      if (!(await acquire(id, { ifAvailable: true }))) throw new ProjectLockedError(id, 'copy it');
      const at = now();
      try {
        const copy = await inTransaction(['projects', 'assets', 'revisions'], async (tx) => {
          if (await tx.objectStore('projects').getKey(id)) throw new Error(`A project with the id ${id} exists already.`);
          await putAssets(tx.objectStore('assets'), newAssets, at);
          const next: ProjectDoc = { ...doc, id, rev: 1, createdAt: at.toISOString() };
          await tx.objectStore('projects').put(next);
          await writeSnapshot(tx.objectStore('revisions'), next, `Copy of ${doc.id}`, at);
          return next;
        });
        announceSaved(copy);
        return { id, rev: 1 as const };
      } catch (error) {
        release(id);
        throw error;
      }
    },

    async putAsset(projectId, bytes, mime) {
      if (!isValidProjectId(projectId)) throw new TypeError(`Invalid project id ${JSON.stringify(projectId)}`);
      const blob = bytes.type === mime ? bytes : new Blob([bytes], { type: mime });
      const key = assetKeyOf(projectId, await sha256Hex(blob));
      await repo.putAssetBlob(key, blob);
      const stored = await (await db()).get('assets', key);
      return refFor(key, stored?.blob ?? blob, mime);
    },

    async putAssetBlob(key, blob) {
      const sha = shaOfKey(key);
      if (!sha) throw new TypeError(`Not an asset key: ${JSON.stringify(key)}`);
      if ((await sha256Hex(blob)) !== sha) throw new Error(`The bytes of ${key} do not match its hash.`);
      await inTransaction(['assets'], (tx) => putAssets(tx.objectStore('assets'), new Map([[key, blob]]), now()));
    },

    async getAsset(ref: AssetRef) {
      const blob = await repo.getAssetByKey(ref.key);
      if (!blob) throw new AssetNotFoundError(ref.key);
      return blob;
    },

    async getAssetByKey(key) {
      return (await (await db()).get('assets', key))?.blob;
    },

    async exportFile(id) {
      const d = await db();
      const raw = await d.get('projects', id);
      if (!raw) throw new ProjectNotFoundError(id);
      const doc = migrated(raw).doc;
      const stored = await d.getAll('revisions', projectRange(id));
      const revisions: ProjectFileRevision[] = [];
      for (const r of stored) {
        try {
          revisions.push({ rev: r.rev, at: r.at, label: r.label, doc: migrated(r.doc).doc });
        } catch {
          // a damaged snapshot is left out; the project itself is what matters
        }
      }
      const keys = collectAssetKeys(doc);
      for (const r of revisions) collectAssetKeys(r.doc, keys);
      await expandAssetKeys(keys, loadStored(d));
      const assets = new Map<string, Blob>();
      for (const key of [...keys].sort()) {
        const asset = await d.get('assets', key);
        if (asset) assets.set(key, asset.blob);
      }
      return projectFileBlob(await buildProjectFile({ doc, assets, revisions, now: now() }));
    },

    async importFile(f) {
      const parsed = await parseProjectFile(f);
      const d = await db();
      const at = now();
      const existing = await d.get('projects', parsed.doc.id);
      if (existing) {
        let present = true;
        for (const key of parsed.assets.keys()) if ((await d.getKey('assets', key)) === undefined) present = false;
        let same = false;
        try {
          same = present && contentOf(migrated(existing).doc) === contentOf(parsed.doc);
        } catch {
          same = false;
        }
        if (same) return { id: existing.id, renamed: false, status: 'already-present', name: existing.name };
      }
      const renamed = existing !== undefined;
      const id = renamed ? newId() : parsed.doc.id;
      if (!isValidProjectId(id)) throw new TypeError(`newId produced an invalid project id ${JSON.stringify(id)}`);
      const name = renamed ? importedName(parsed.doc.name, at) : parsed.doc.name;
      // Revs continue after every rev in the file, so later autosave snapshots never collide with imported ones.
      const topRev = Math.max(1, parsed.doc.rev, ...parsed.revisions.map((r) => r.rev));
      const baseRev = parsed.migratedFrom !== null ? topRev + 1 : topRev;
      const doc: ProjectDoc = { ...parsed.doc, id, name, rev: baseRev };
      await inTransaction(['projects', 'assets', 'revisions'], async (tx) => {
        if (await tx.objectStore('projects').getKey(id)) throw new Error(`A project with the id ${id} exists already.`);
        await putAssets(tx.objectStore('assets'), parsed.assets, at);
        const revisions = tx.objectStore('revisions');
        for (const r of parsed.revisions) {
          await revisions.put({ projectId: id, rev: r.rev, at: r.at, label: r.label, doc: { ...r.doc, id } });
        }
        if (parsed.migratedFrom !== null) {
          await revisions.put({ projectId: id, rev: topRev, at: at.toISOString(), label: `Before update to format ${CURRENT_DOC_VERSION}`, doc: { ...parsed.original, id, rev: topRev } });
        }
        await tx.objectStore('projects').put(doc);
        await writeSnapshot(revisions, doc, 'Imported', at);
      });
      announceSaved(doc);
      return { id, renamed, status: renamed ? 'imported-as-copy' : 'imported', name };
    },

    async remove(id) {
      const mine = held.get(id)?.held() ?? false;
      if (!mine && !(await acquire(id, { ifAvailable: true }))) throw new ProjectLockedError(id, 'close it');
      try {
        await inTransaction(['projects', 'revisions', 'meta'], async (tx) => {
          await tx.objectStore('projects').delete(id);
          const revisions = tx.objectStore('revisions');
          for (const key of await revisions.getAllKeys(projectRange(id))) await revisions.delete(key);
          const meta = tx.objectStore('meta');
          await meta.delete(TRASH_PREFIX + id);
          // A tombstone for the folder mirror: what it last synced of this project, so that its folder copy is
          // moved to Backups/deleted even when the mirror starts after this delete (and never offered back).
          const base = (await meta.get(SYNC_PREFIX + id)) as { lastSyncedHash?: unknown } | undefined;
          if (base && typeof base.lastSyncedHash === 'string') await meta.put({ deletedAt: now().toISOString(), lastSyncedHash: base.lastSyncedHash }, GONE_PREFIX + id);
          await meta.delete(SYNC_PREFIX + id);
        });
      } finally {
        release(id);
      }
      emit({ type: 'removed', id, remote: false });
      post({ type: 'removed', id, from: tabId });
    },

    release(id) {
      repo.cancelHandOver(id);
      release(id);
    },

    holdsLock: (id) => held.get(id)?.held() ?? false,

    heldIds: () => [...held.keys()].filter((id) => held.get(id)?.held()),

    async requestHandOver(id, opts = {}) {
      if (closed) return { ok: false, reason: 'closed' };
      const readHeld = async (): Promise<HandOverResult> => {
        const raw = await readDoc(id);
        if (!raw) {
          release(id);
          throw new ProjectNotFoundError(id);
        }
        return { ok: true, doc: migrated(raw).doc };
      };
      if (await acquire(id, { ifAvailable: true })) return readHeld();

      repo.cancelHandOver(id);
      let released!: () => void;
      const answered = new Promise<'released'>((resolve) => (released = () => resolve('released')));
      const entry = { resolve: () => released(), late: false };
      waiting.set(id, entry);
      post({ type: 'release', id, from: tabId });

      let handle: unknown;
      let timedOut = false;
      const deadline = new Promise<'timeout'>((resolve) => {
        handle = timers.setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, opts.timeoutMs ?? handOverTimeoutMs);
      });
      const outcome = await Promise.race([answered, deadline]);

      if (outcome === 'released') {
        if (waiting.get(id) === entry) waiting.delete(id);
        // The holder let go. Should the lock manager still be handing it on, try again until the deadline.
        for (;;) {
          if (await acquire(id, { ifAvailable: true })) {
            timers.clearTimeout(handle);
            return readHeld();
          }
          if (timedOut) return { ok: false, reason: 'busy' };
          await Promise.race([deadline, new Promise<void>((resolve) => timers.setTimeout(resolve, HAND_OVER_RETRY_MS))]);
        }
      }
      timers.clearTimeout(handle);
      // No answer: the holder may simply be gone (its lock went with it).
      if (await acquire(id, { ifAvailable: true })) {
        if (waiting.get(id) === entry) waiting.delete(id);
        return readHeld();
      }
      // Keep listening: if the holder answers after all, take the lock then and tell the app.
      entry.late = true;
      void answered.then(async () => {
        if (waiting.get(id) !== entry) return;
        waiting.delete(id);
        if (!(await acquire(id, { ifAvailable: true }))) return;
        try {
          const r = await readHeld();
          if (r.ok) emit({ type: 'lock-acquired', id, doc: r.doc });
        } catch {
          release(id);
        }
      });
      return { ok: false, reason: 'timeout' };
    },

    cancelHandOver(id) {
      waiting.delete(id);
    },

    setFlushHandler(flush) {
      flushHandler = flush;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async snapshot(id, label) {
      const at = now();
      return inTransaction(['projects', 'revisions'], async (tx) => {
        const stored = await tx.objectStore('projects').get(id);
        if (!stored) return null;
        await writeSnapshot(tx.objectStore('revisions'), stored, label, at);
        return stored.rev;
      });
    },

    async listRevisions(id) {
      const all = await (await db()).getAll('revisions', projectRange(id));
      return all.map((r) => ({ rev: r.rev, at: r.at, label: r.label })).sort((a, b) => b.rev - a.rev);
    },

    async getRevision(id, rev) {
      return (await db()).get('revisions', [id, rev]);
    },

    async gcAssets(opts = {}) {
      const minAgeMs = opts.minAgeMs ?? ASSET_GC_MIN_AGE_MS;
      if (opts.skipWhileEditing) {
        // A long-lived tab may still name (in its undo history) an asset no stored document names: never collect
        // while another tab edits a project (§5.5.5). Without a way to ask, skip too — it only costs disk.
        if (!queryLocks) return { deleted: [], skipped: 'no-lock-query' };
        const snapshot = await queryLocks().catch(() => null);
        if (!snapshot) return { deleted: [], skipped: 'no-lock-query' };
        const mine = new Set(repo.heldIds().map(lockName));
        if ((snapshot.held ?? []).some((l) => typeof l.name === 'string' && l.name.startsWith(lockName('')) && !mine.has(l.name))) {
          return { deleted: [], skipped: 'editing-elsewhere' };
        }
      }
      const d = await db();
      // 1. References of every project and snapshot, then of the JSON assets they name (read outside a transaction).
      const referenced = new Set<string>();
      for (const doc of await d.getAll('projects')) collectAssetKeys(doc, referenced);
      for (const r of await d.getAll('revisions')) collectAssetKeys(r.doc, referenced);
      await expandAssetKeys(referenced, loadStored(d));
      // 2. One readwrite transaction: references again (a save may have landed meanwhile), then delete.
      const at = now();
      return inTransaction(['projects', 'assets', 'revisions'], async (tx) => {
        const again = new Set<string>();
        for (const doc of await tx.objectStore('projects').getAll()) collectAssetKeys(doc, again);
        for (const r of await tx.objectStore('revisions').getAll()) collectAssetKeys(r.doc, again);
        // A document that names a key the first pass did not see may name JSON assets that were not followed:
        // delete nothing this round rather than guess.
        for (const key of again) if (!referenced.has(key)) return { deleted: [] };
        const assets = tx.objectStore('assets');
        const stored: [string, StoredAsset][] = [];
        let cursor = await assets.openCursor();
        while (cursor) {
          stored.push([cursor.key, cursor.value]);
          cursor = await cursor.continue();
        }
        const deleted = selectUnreferenced(stored, referenced, at, minAgeMs);
        for (const key of deleted) await assets.delete(key);
        return { deleted };
      });
    },

    async getSetting(key) {
      return (await db()).get('settings', key);
    },

    async putSetting(key, value) {
      await (await db()).put('settings', value, key);
    },

    async getMeta(key) {
      return (await db()).get('meta', key);
    },

    async putMeta(key, value) {
      await (await db()).put('meta', value, key);
    },

    async deleteMeta(key) {
      await (await db()).delete('meta', key);
    },

    async storedProjects() {
      const d = await db();
      const trashed = await trashedIds(d);
      return (await d.getAll('projects'))
        .filter((doc) => typeof doc === 'object' && doc !== null && typeof doc.id === 'string')
        .map((doc) => ({ id: doc.id, rev: doc.rev, name: doc.name, trashed: trashed.has(doc.id) }));
    },

    async peek(id) {
      const raw = await readDoc(id);
      return raw ? migrated(raw).doc : undefined;
    },

    async trash(id) {
      const mine = held.get(id)?.held() ?? false;
      if (!mine && !(await acquire(id, { ifAvailable: true }))) throw new ProjectLockedError(id, 'close it');
      const at = now();
      try {
        // The lock is held while the entry is written: no other tab can open the project for editing meanwhile.
        await inTransaction(['projects', 'revisions', 'meta'], async (tx) => {
          const stored = await tx.objectStore('projects').get(id);
          if (!stored) throw new ProjectNotFoundError(id);
          await writeSnapshot(tx.objectStore('revisions'), stored, 'Before delete', at);
          await tx.objectStore('meta').put({ deletedAt: at.toISOString() }, TRASH_PREFIX + id);
        });
      } finally {
        if (!mine) release(id);
      }
      emit({ type: 'trashed', id, remote: false });
      post({ type: 'trashed', id, from: tabId });
    },

    async restoreFromTrash(id) {
      const summary = await inTransaction(['projects', 'meta'], async (tx) => {
        const stored = await tx.objectStore('projects').get(id);
        if (!stored) throw new ProjectNotFoundError(id);
        await tx.objectStore('meta').delete(TRASH_PREFIX + id);
        return summaryOfDoc(stored);
      });
      emit({ type: 'restored', id, summary, remote: false });
      post({ type: 'restored', id, summary, from: tabId });
      return summary;
    },

    async listTrash() {
      const d = await db();
      const range = IDBKeyRange.bound(TRASH_PREFIX, TRASH_PREFIX + '\uffff');
      const keys = await d.getAllKeys('meta', range);
      const values = await d.getAll('meta', range);
      const out: TrashEntry[] = [];
      for (let i = 0; i < keys.length; i++) {
        const id = String(keys[i]).slice(TRASH_PREFIX.length);
        const doc = await d.get('projects', id);
        if (!doc) continue; // purged elsewhere; the stale entry goes with the next remove
        const v = values[i] as { deletedAt?: unknown } | undefined;
        out.push({ summary: summaryOfDoc(doc), deletedAt: typeof v?.deletedAt === 'string' ? v.deletedAt : new Date(0).toISOString() });
      }
      return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : a.summary.id < b.summary.id ? -1 : 1));
    },

    async purgeTrash(opts = {}) {
      const keepMs = opts.keepMs ?? TRASH_KEEP_MS;
      const at = now().getTime();
      const d = await db();
      const range = IDBKeyRange.bound(TRASH_PREFIX, TRASH_PREFIX + '\uffff');
      const keys = await d.getAllKeys('meta', range);
      const values = await d.getAll('meta', range);
      const purged: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const id = String(keys[i]).slice(TRASH_PREFIX.length);
        const deletedAt = Date.parse(String((values[i] as { deletedAt?: unknown } | undefined)?.deletedAt));
        // A malformed date is never old enough: keeping costs little.
        if (!Number.isFinite(deletedAt) || at - deletedAt < keepMs) continue;
        try {
          await repo.remove(id);
          purged.push(id);
        } catch (error) {
          if ((error as { name?: unknown }).name !== 'ProjectLockedError') throw error;
        }
      }
      return purged;
    },

    async duplicate(id) {
      const d = await db();
      const raw = await d.get('projects', id);
      if (!raw) throw new ProjectNotFoundError(id);
      const source = migrated(raw).doc;
      const copyId = newId();
      if (!isValidProjectId(copyId)) throw new TypeError(`newId produced an invalid project id ${JSON.stringify(copyId)}`);
      const names = new Set((await d.getAll('projects')).map((p) => p.name));
      let name = `${source.name} (copy)`;
      for (let n = 2; names.has(name); n++) name = `${source.name} (copy ${n})`;
      const at = now();
      const copy: ProjectDoc = { ...source, id: copyId, name, rev: 1, createdAt: at.toISOString(), updatedAt: at.toISOString() };
      await inTransaction(['projects', 'revisions'], async (tx) => {
        if (await tx.objectStore('projects').getKey(copyId)) throw new Error(`A project with the id ${copyId} exists already.`);
        await tx.objectStore('projects').put(copy);
        await writeSnapshot(tx.objectStore('revisions'), copy, `Duplicate of ${id}`, at);
      });
      announceSaved(copy);
      return summaryOfDoc(copy);
    },

    async requestPersistence() {
      if (!storage?.persist) return null;
      try {
        if (storage.persisted && (await storage.persisted())) return true;
        return await storage.persist();
      } catch {
        return false;
      }
    },

    async estimate() {
      if (!storage?.estimate) return null;
      try {
        const e = await storage.estimate();
        return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
      } catch {
        return null;
      }
    },

    close() {
      if (closed === 'closed') return;
      const wasOpen = closed === null;
      closed = 'closed';
      for (const id of [...held.keys()]) release(id);
      waiting.clear();
      try {
        channel.onmessage = null;
        channel.close();
      } catch {
        // already closed
      }
      if (wasOpen) void dbPromise?.then((d) => d.close(), () => {});
    },
  };
  return repo;
}

/** §5.2.1: the frozen entry point. */
export const createProjectRepository: CreateProjectRepositoryFn = (o) => createPersistRepository(o);

/** True for the error `open` throws for an unknown id. */
export const isProjectNotFound = (e: unknown): e is ProjectNotFoundError =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ProjectNotFoundError';
