// Track T8 — the unload journal: the last line of defence for an edit made just before the page goes away.
//
// An IndexedDB save needs several turns of the event loop, and a page that is being closed or reloaded may be
// gone before it lands (measured in Chromium: an edit made within the 800 ms debounce was lost on about half of
// the immediate reloads). `localStorage` writes are synchronous, so on `beforeunload` / `pagehide` the session
// writes the unsaved document there (`writeJournal`), and the next start replays it (`recoverJournal`) through
// the same compare-and-swap rules as any save: onto the project when nothing changed it since, as a copy
// otherwise, and not at all when the save had landed after all. Assets are not journaled (blobs cannot be
// read synchronously); a document naming an asset that never reached IndexedDB is reported by the next save.
import { checkDoc } from '../../core/persist/fileFormat';
import { migrateDoc } from '../../core/persist/migrations';
import { copyName, isProjectNotFound, sameContent, type PersistRepository } from '../../core/persist/repo';
import type { ProjectDoc } from '../../types/project';

export const JOURNAL_PREFIX = 'cpg.unsaved.';

/** What the journal needs of `localStorage`. */
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

interface Entry {
  v: 1;
  baseRev: number;
  at: string;
  doc: ProjectDoc;
}

/** The page's `localStorage`, or null where there is none or it refuses access. */
export function browserJournalStorage(): JournalStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Writes the unsaved document synchronously. False when it could not be written (quota, private mode). */
export function writeJournal(storage: JournalStorage | null, doc: ProjectDoc, baseRev: number, now: Date): boolean {
  if (!storage) return false;
  try {
    const entry: Entry = { v: 1, baseRev, at: now.toISOString(), doc };
    storage.setItem(JOURNAL_PREFIX + doc.id, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export function clearJournal(storage: JournalStorage | null, id: string): void {
  try {
    storage?.removeItem(JOURNAL_PREFIX + id);
  } catch {
    // nothing to clear
  }
}

export interface Recovery {
  id: string;
  name: string;
  /** `restored`: written onto the project; `copied`: the project had changed, so a copy; `already-saved`: nothing to do. */
  outcome: 'restored' | 'copied' | 'already-saved';
  copyId?: string;
}

/**
 * Replays every journal entry. An entry is removed once handled; one that fails stays for the next start.
 * A damaged entry is removed (it cannot ever be replayed).
 */
export async function recoverJournal(storage: JournalStorage | null, repo: PersistRepository, now: () => Date): Promise<Recovery[]> {
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(JOURNAL_PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  const out: Recovery[] = [];
  for (const key of keys) {
    let entry: Entry;
    try {
      entry = JSON.parse(storage.getItem(key) ?? 'null') as Entry;
      if (entry?.v !== 1 || !Number.isSafeInteger(entry.baseRev)) throw new Error('not an entry');
      entry.doc = checkDoc(migrateDoc(entry.doc).doc);
    } catch {
      clearJournal(storage, key.slice(JOURNAL_PREFIX.length));
      continue;
    }
    try {
      out.push(await replay(repo, entry, now));
      storage.removeItem(key);
    } catch {
      // kept for the next start
    }
  }
  return out;
}

async function replay(repo: PersistRepository, entry: Entry, now: () => Date): Promise<Recovery> {
  const { doc, baseRev } = entry;
  let stored: ProjectDoc | null = null;
  try {
    stored = (await repo.open(doc.id, 'read')).doc;
  } catch (error) {
    if (!isProjectNotFound(error)) throw error;
  }
  if (stored && sameContent(stored, doc)) return { id: doc.id, name: doc.name, outcome: 'already-saved' };
  const mine = repo.holdsLock(doc.id);
  if (!stored || stored.rev <= baseRev) {
    // Nothing newer was stored: the journal is the latest. Write it if no other tab is editing the project.
    const editable = mine || !stored || !(await repo.open(doc.id, 'edit')).readOnly;
    if (editable) {
      try {
        const r = await repo.save({ ...doc, rev: baseRev }, new Map(), { baseRev });
        if (r.ok) return { id: doc.id, name: doc.name, outcome: 'restored' };
      } finally {
        if (!mine) repo.release(doc.id);
      }
    }
  }
  // Something newer was stored meanwhile, or another tab is editing: never overwrite — keep it as a copy.
  const name = copyName(doc.name, now());
  const copy = await repo.saveAsCopy({ ...doc, name }, new Map());
  repo.release(copy.id);
  return { id: doc.id, name, outcome: 'copied', copyId: copy.id };
}
