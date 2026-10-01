// core/persist/autosave — debounce, flush, compare-and-swap conflicts → exactly one copy, retries
// (DESIGN.md §5.5.2, §6.3 T8 acceptance), on a real projectStore and the fake-IndexedDB repository.
import { describe, expect, it } from 'vitest';
import { createProjectStore, type ProjectStore } from '../../../state/projectStore';
import { autosaveStatus, createAutosave, type ConflictInfo } from '../autosave';
import type { PersistRepository } from '../repo';
import { makeDoc, settle, world, type World } from './helpers';

async function setup(w: World = world(), o: { wrap?: (repo: PersistRepository) => PersistRepository } = {}) {
  const tab = w.tab();
  const repo = o.wrap ? o.wrap(tab.repo) : tab.repo;
  const store = createProjectStore({ now: () => new Date(w.clock.now) });
  const conflicts: ConflictInfo[] = [];
  const errors: unknown[] = [];
  let recovered = 0;
  const autosave = createAutosave({
    store,
    repo,
    timers: w.timers,
    now: () => new Date(w.clock.now),
    onConflict: (c) => conflicts.push(c),
    onError: (e) => errors.push(e),
    onRecovered: () => recovered++,
  });
  const created = await tab.repo.create(makeDoc('p1'));
  const opened = await repo.open('p1', 'edit');
  store.getState().open(opened.doc, { readOnly: opened.readOnly });
  return { w, tab, repo, store, autosave, conflicts, errors, recovered: () => recovered, created };
}

const rename = (store: ProjectStore, name: string) => store.getState().update('Rename project', (d) => void (d.name = name));

describe('autosave: debounce and flush', () => {
  it('saves 800 ms after the LAST change, not before', async () => {
    const { w, repo, store, autosave } = await setup();
    rename(store, 'a');
    await w.timers.advance(500);
    rename(store, 'ab');
    await w.timers.advance(799);
    expect((await repo.open('p1', 'read')).doc.name).toBe('Untitled chart');
    expect(store.getState().saveStatus).toBe('unsaved');
    expect(autosaveStatus(store.getState().saveStatus)).toBe('saving');
    await w.timers.advance(1);
    await autosave.flush(); // joins the save the timer started
    expect((await repo.open('p1', 'read')).doc).toMatchObject({ name: 'ab', rev: 2 });
    expect(store.getState().saveStatus).toBe('saved');
    expect(store.getState().baseRev).toBe(2);
  });

  it('flush saves at once and cancels the debounce; with nothing to save it does nothing', async () => {
    const { w, repo, store, autosave } = await setup();
    await autosave.flush();
    expect((await repo.open('p1', 'read')).doc.rev).toBe(1);
    rename(store, 'now');
    await autosave.flush();
    expect((await repo.open('p1', 'read')).doc).toMatchObject({ name: 'now', rev: 2 });
    expect(w.timers.pending()).toBe(0);
    expect(autosave.pending()).toBe(false);
  });

  it('changes made while a save runs are saved right after it', async () => {
    const { repo, store, autosave } = await setup();
    rename(store, 'first');
    const flushing = autosave.flush();
    rename(store, 'second'); // the first ticket is in flight
    await flushing;
    expect((await repo.open('p1', 'read')).doc).toMatchObject({ name: 'second', rev: 3 });
    expect(store.getState().saveStatus).toBe('saved');
  });

  it('new assets go out with the save and the store forgets them as unsaved', async () => {
    const { repo, store, autosave } = await setup();
    const ref = await store.getState().putAsset(new Uint8Array([1, 2, 3]), 'image/png');
    store.getState().update('Thumbnail', (d) => void (d.thumbnail = ref));
    await autosave.flush();
    expect(store.getState().unsavedAssetKeys.size).toBe(0);
    expect(await repo.getAssetByKey(ref.key)).toBeDefined();
  });

  it('an asset the database lost is stored again from the cache', async () => {
    const { w, repo, store, autosave } = await setup();
    const ref = await store.getState().putAsset(new Uint8Array([7, 7]), 'image/png');
    store.getState().update('Thumbnail', (d) => void (d.thumbnail = ref));
    await autosave.flush();
    // The asset disappears from the database (GC bug, cleared storage) while the tab still has it cached.
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const r = w.idb.open('crochet-pattern-generator');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction('assets', 'readwrite');
      tx.objectStore('assets').delete(ref.key);
      tx.oncomplete = () => resolve();
    });
    raw.close();
    rename(store, 'again');
    await autosave.flush();
    expect(await repo.getAssetByKey(ref.key)).toBeDefined();
  });

  it('does nothing for a project opened and never changed, and stops after dispose', async () => {
    const { w, store, autosave } = await setup();
    expect(w.timers.pending()).toBe(0);
    autosave.dispose();
    rename(store, 'after dispose');
    expect(w.timers.pending()).toBe(0);
  });
});

describe('autosave: compare-and-swap conflicts (§5.5.2)', () => {
  it('a stale save becomes ONE copy; the tab is rebound to it; 10 more edits go to the copy', async () => {
    const w = world();
    const { repo, store, autosave, conflicts } = await setup(w);
    // Another tab saves a newer version (here: through its own repository on the same database).
    const other = w.tab();
    const theirs = (await other.repo.open('p1', 'read')).doc;
    await other.repo.save({ ...theirs, name: 'Saved by the other tab' }, new Map(), { baseRev: 1 });

    rename(store, 'Mine');
    w.clock.now = new Date('2026-10-01T14:05:00');
    await autosave.flush();
    expect(conflicts).toEqual([{ originalId: 'p1', originalName: 'Mine', copyId: 'copy-1', copyName: 'Mine (copy, 14:05)', storedRev: 2 }]);
    expect(store.getState().doc).toMatchObject({ id: 'copy-1', name: 'Mine (copy, 14:05)', rev: 1 });
    expect(store.getState().baseRev).toBe(1);
    expect(store.getState().readOnly).toBe(false);
    expect(repo.holdsLock('copy-1')).toBe(true);
    expect(repo.holdsLock('p1')).toBe(false);

    for (let i = 1; i <= 10; i++) {
      store.getState().update('Edit', (d) => void (d.gauge = { ...d.gauge, scPer4in: 10 + i } as typeof d.gauge));
      await w.timers.advance(800);
      await autosave.flush();
    }
    const list = await repo.list();
    expect(list.map((s) => s.id).sort()).toEqual(['copy-1', 'p1']);
    expect(conflicts).toHaveLength(1);
    // The original holds the other tab's version, untouched.
    expect((await repo.open('p1', 'read')).doc).toMatchObject({ name: 'Saved by the other tab', rev: 2 });
    // The copy has all ten edits.
    expect((await repo.open('copy-1', 'read')).doc).toMatchObject({ name: 'Mine (copy, 14:05)', rev: 11, gauge: { scPer4in: 20 } });
    // The original reopens read-only from a tab where another tab holds it.
    await other.repo.open('p1', 'edit');
    expect((await repo.open('p1', 'edit')).readOnly).toBe(true);
  });

  it('the copy shares the original’s assets (no new bytes) and keeps the history', async () => {
    const w = world();
    const { store, autosave, repo } = await setup(w);
    const ref = await store.getState().putAsset(new Uint8Array([5, 6]), 'image/png');
    store.getState().update('Thumbnail', (d) => void (d.thumbnail = ref));
    await autosave.flush();
    await w.tab().repo.save({ ...(await repo.open('p1', 'read')).doc, name: 'theirs' }, new Map(), { baseRev: 2 });
    rename(store, 'mine');
    await autosave.flush();
    const copy = (await repo.open('copy-1', 'read')).doc;
    expect(copy.thumbnail).toEqual(ref);
    expect(ref.key.startsWith('p1/')).toBe(true);
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Thumbnail', 'Rename project']);
  });

  it('a take-over: the old holder (read-only now) saves its pending edit as a copy', async () => {
    const w = world();
    const { store, autosave, conflicts, repo } = await setup(w);
    rename(store, 'pending in the old tab');
    const taker = w.tab();
    await taker.repo.takeOver('p1');
    await settle();
    // The old tab's lock was stolen; the session would set it read-only. Its save still runs.
    store.getState().setReadOnly(true);
    await autosave.flush();
    expect(conflicts).toHaveLength(1);
    expect(store.getState().doc?.id).toBe('copy-1');
    expect(store.getState().readOnly).toBe(false);
    expect((await repo.open('copy-1', 'read')).doc.name).toBe('pending in the old tab (copy, 12:00)');
    expect((await repo.open('p1', 'read')).doc.name).toBe('Untitled chart');
  });
});

describe('autosave: failures', () => {
  it('a failed save keeps the changes, shows error, retries with backoff, and recovers', async () => {
    const w = world();
    let failing = 2;
    const flaky = (repo: PersistRepository): PersistRepository => ({
      ...repo,
      save: async (...args) => {
        if (failing-- > 0) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return repo.save(...args);
      },
    });
    const { store, autosave, errors, recovered, tab } = await setup(w, { wrap: flaky });
    rename(store, 'precious');
    await autosave.flush();
    expect(store.getState().saveStatus).toBe('error');
    expect(store.getState().doc?.name).toBe('precious');
    expect(autosave.failures()).toBe(1);
    expect(errors).toHaveLength(1);
    await w.timers.advance(999);
    expect(errors).toHaveLength(1);
    await w.timers.advance(1); // retry after 1 s fails again
    expect(errors).toHaveLength(2);
    await w.timers.advance(2000); // retry after 2 s succeeds
    await autosave.flush();
    expect(store.getState().saveStatus).toBe('saved');
    expect(recovered()).toBe(1);
    expect(autosave.failures()).toBe(0);
    expect((await tab.repo.open('p1', 'read')).doc.name).toBe('precious');
  });

  it('autosaveStatus maps the store status onto the four chip states', () => {
    expect(autosaveStatus('saved')).toBe('saved');
    expect(autosaveStatus('unsaved')).toBe('saving');
    expect(autosaveStatus('saving')).toBe('saving');
    expect(autosaveStatus('error')).toBe('error');
    expect(autosaveStatus('read-only')).toBe('read-only');
  });
});
