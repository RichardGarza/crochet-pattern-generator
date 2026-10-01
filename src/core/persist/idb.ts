// Track T8 — the IndexedDB database of DESIGN.md §5.5.1: name, version, stores, and how a connection is opened
// with the `blocking` / `blocked` handling of §5.5.2 ("Schema upgrades").
//
// `idb`'s own `openDB` always uses the global `indexedDB`; the repository takes an `IDBFactory` (fake-indexeddb
// in unit tests, `indexedDB` in the app), so `openDatabase` does what `openDB` does on the factory it is given.
// Everything else is `idb`'s promise wrapper (`wrap`), so the rest of core/persist uses the usual idb API.
import { wrap, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { ProjectDoc } from '../../types/project';

export const DB_NAME = 'crochet-pattern-generator';
export const DB_VERSION = 1;

/** One stored asset (§5.5.1): the blob and what the library needs without reading it. */
export interface StoredAsset {
  blob: Blob;
  mime: string;
  bytes: number;
  /** ISO time it was first stored; asset GC keeps anything younger than 7 days (§5.5.5). */
  createdAt: string;
}

/** One snapshot (§5.5.2): the document as it was at `rev`. Key `[projectId, rev]`. */
export interface StoredRevision {
  projectId: string;
  rev: number;
  at: string;
  label: string;
  doc: ProjectDoc;
}

export interface CpgDB extends DBSchema {
  projects: { key: string; value: ProjectDoc };
  assets: { key: string; value: StoredAsset };
  revisions: { key: [string, number]; value: StoredRevision };
  settings: { key: string; value: unknown };
  meta: { key: string; value: unknown };
}

export type CpgDatabase = IDBPDatabase<CpgDB>;
export type StoreName = StoreNames<CpgDB>;
export const STORE_NAMES: readonly StoreName[] = ['projects', 'assets', 'revisions', 'settings', 'meta'];

/** The schema of version 1. Later versions add their step here (`oldVersion < N`), never change an old one. */
export function upgradeSchema(
  db: IDBPDatabase<CpgDB>,
  oldVersion: number,
  _newVersion: number | null,
  _tx: IDBPTransaction<CpgDB, StoreName[], 'versionchange'>,
): void {
  if (oldVersion < 1) {
    db.createObjectStore('projects', { keyPath: 'id' });
    db.createObjectStore('assets');
    db.createObjectStore('revisions', { keyPath: ['projectId', 'rev'] });
    db.createObjectStore('settings');
    db.createObjectStore('meta');
  }
}

export interface OpenDatabaseOptions {
  factory: IDBFactory;
  name?: string;
  version?: number;
  /** This connection blocks a newer version opened elsewhere (`versionchange`): flush, then close it. */
  onBlocking?: (oldVersion: number, newVersion: number | null) => void;
  /** This open waits for older connections elsewhere to close. */
  onBlocked?: (currentVersion: number, blockedVersion: number | null) => void;
  /** The browser closed the connection abnormally (storage cleared, disk error). */
  onTerminated?: () => void;
}

/** Opens (and creates or upgrades) the database on `factory`: idb's `openDB` with the factory as a parameter. */
export function openDatabase(o: OpenDatabaseOptions): Promise<CpgDatabase> {
  const request = o.factory.open(o.name ?? DB_NAME, o.version ?? DB_VERSION);
  const opened = wrap(request) as unknown as Promise<CpgDatabase>;
  request.addEventListener('upgradeneeded', (event) => {
    const db = wrap(request.result) as unknown as IDBPDatabase<CpgDB>;
    const tx = wrap(request.transaction as IDBTransaction) as unknown as IDBPTransaction<CpgDB, StoreName[], 'versionchange'>;
    upgradeSchema(db, event.oldVersion, event.newVersion, tx);
  });
  if (o.onBlocked) {
    const onBlocked = o.onBlocked;
    request.addEventListener('blocked', (event) => onBlocked((event as IDBVersionChangeEvent).oldVersion, (event as IDBVersionChangeEvent).newVersion));
  }
  opened.then(
    (db) => {
      if (o.onTerminated) db.addEventListener('close', o.onTerminated);
      if (o.onBlocking) {
        const onBlocking = o.onBlocking;
        db.addEventListener('versionchange', (event) => onBlocking(event.oldVersion, event.newVersion));
      }
    },
    () => {},
  );
  return opened;
}

/** All revisions of one project: the key range `[id, -∞] … [id, +∞]`. */
export function projectRange(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound([projectId, -Infinity], [projectId, Infinity]);
}
