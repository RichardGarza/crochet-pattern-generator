// core/persist/repo — the library operations of T8.2 (DESIGN.md §5.5.5, §5.7): delete into "Recently deleted"
// (`meta` entry `trash:<id>`, kept 30 days, purged with `remove`, never while another tab edits), restore,
// duplicate, the `meta` store of the folder mirror, and start-up asset GC that skips while another tab edits.
import { describe, expect, it } from 'vitest';
import { lockName } from '../locks';
import { SYNC_PREFIX, TRASH_KEEP_MS, TRASH_PREFIX, type RepositoryEvent } from '../repo';
import { blobOf, makeDoc, settle, world } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('Recently deleted', () => {
  it('delete moves a project out of the list into "Recently deleted"; restore brings it back unchanged', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const events: RepositoryEvent[] = [];
    b.repo.subscribe((e) => events.push(e));
    await a.repo.create(makeDoc('p1', 'picture', 'Heart'));
    await a.repo.create(makeDoc('p2', 'photos', 'Bear'));
    await a.repo.save(makeDoc('p1', 'picture', 'Heart'), new Map(), { baseRev: 1 });
    a.repo.release('p1');
    a.repo.release('p2');

    await a.repo.trash('p1');
    expect((await a.repo.list()).map((s) => s.id)).toEqual(['p2']);
    const trash = await a.repo.listTrash();
    expect(trash).toEqual([{ summary: expect.objectContaining({ id: 'p1', name: 'Heart' }), deletedAt: w.clock.now.toISOString() }]);
    // The document and its snapshots are kept; a "Before delete" snapshot was taken.
    expect((await a.repo.listRevisions('p1')).map((r) => [r.rev, r.label])).toEqual([
      [2, 'Before delete'],
      [1, 'Created'],
    ]);
    expect(await a.repo.getMeta(TRASH_PREFIX + 'p1')).toEqual({ deletedAt: w.clock.now.toISOString() });
    await settle();
    expect(events).toContainEqual({ type: 'trashed', id: 'p1', remote: true });

    const back = await a.repo.restoreFromTrash('p1');
    expect(back).toMatchObject({ id: 'p1', name: 'Heart' });
    expect((await a.repo.list()).map((s) => s.id).sort()).toEqual(['p1', 'p2']);
    expect(await a.repo.listTrash()).toEqual([]);
    await settle();
    expect(events).toContainEqual({ type: 'restored', id: 'p1', summary: back, remote: true });
    // Its lock is free again (delete held it only while writing the entry).
    expect(w.locks.isHeld(lockName('p1'))).toBe(false);
  });

  it('refuses to delete a project another tab is editing', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    await expect(b.repo.trash('p1')).rejects.toMatchObject({ name: 'ProjectLockedError' });
    expect(await b.repo.listTrash()).toEqual([]);
    await expect(b.repo.trash('nope')).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
  });

  it('purges after 30 days with remove (snapshots and meta entries go too), skipping a project another tab holds', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    for (const id of ['old', 'held', 'young']) {
      await a.repo.create(makeDoc(id));
      a.repo.release(id);
    }
    await a.repo.putMeta(SYNC_PREFIX + 'old', { lastSyncedRev: 1, lastSyncedHash: 'x' });
    await a.repo.trash('old');
    await a.repo.trash('held');
    w.clock.now = new Date(w.clock.now.getTime() + 20 * DAY);
    await a.repo.trash('young');
    w.clock.now = new Date(w.clock.now.getTime() + 11 * DAY);
    // Another tab opened the deleted project by its link meanwhile.
    await b.repo.open('held', 'edit');
    expect(await a.repo.purgeTrash()).toEqual(['old']);
    expect(await a.repo.peek('old')).toBeUndefined();
    expect(await a.repo.listRevisions('old')).toEqual([]);
    expect(await a.repo.getMeta(TRASH_PREFIX + 'old')).toBeUndefined();
    expect(await a.repo.getMeta(SYNC_PREFIX + 'old')).toBeUndefined();
    expect((await a.repo.listTrash()).map((t) => t.summary.id).sort()).toEqual(['held', 'young']);
    b.repo.release('held');
    expect(await a.repo.purgeTrash()).toEqual(['held']);
    expect(await a.repo.purgeTrash({ keepMs: 0 })).toEqual(['young']);
    expect(TRASH_KEEP_MS).toBe(30 * DAY);
  });

  it('a malformed deletedAt is never purged', async () => {
    const w = world();
    const a = w.tab();
    await a.repo.create(makeDoc('p1'));
    a.repo.release('p1');
    await a.repo.putMeta(TRASH_PREFIX + 'p1', { deletedAt: 'yesterday' });
    expect(await a.repo.purgeTrash({ keepMs: 0 })).toEqual([]);
    expect((await a.repo.listTrash()).map((t) => t.summary.id)).toEqual(['p1']);
  });
});

describe('duplicate', () => {
  it('copies a stored project under a new id and a free "(copy)" name, sharing its assets', async () => {
    const w = world();
    const a = w.tab();
    const doc = makeDoc('p1', 'picture', 'Heart');
    await a.repo.create(doc);
    const ref = await a.repo.putAsset('p1', await blobOf(1, 2, 3), 'image/png');
    const s = await a.repo.save({ ...doc, rev: 1, thumbnail: ref }, new Map(), { baseRev: 1 });
    expect(s.ok).toBe(true);
    a.repo.release('p1');

    const copy = await a.repo.duplicate('p1');
    expect(copy).toMatchObject({ id: 'copy-1', name: 'Heart (copy)', mode: '2d', thumbnail: ref });
    const stored = await a.repo.peek('copy-1');
    expect(stored).toMatchObject({ id: 'copy-1', rev: 1, name: 'Heart (copy)', createdAt: w.clock.now.toISOString(), thumbnail: ref });
    expect(await a.repo.getAssetByKey(ref.key)).toBeDefined();
    expect((await a.repo.duplicate('p1')).name).toBe('Heart (copy 2)');
    // Not held: the library does not open it.
    expect(a.repo.holdsLock('copy-1')).toBe(false);
    await expect(a.repo.duplicate('nope')).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
  });
});

describe('meta store and stored projects', () => {
  it('reads, writes and deletes meta entries; storedProjects lists trashed ones too', async () => {
    const w = world();
    const a = w.tab();
    await a.repo.create(makeDoc('p1', 'picture', 'One'));
    await a.repo.create(makeDoc('p2', 'picture', 'Two'));
    a.repo.release('p2');
    await a.repo.trash('p2');
    await a.repo.putMeta('sync:p1', { lastSyncedRev: 3, lastSyncedHash: 'abc' });
    expect(await a.repo.getMeta('sync:p1')).toEqual({ lastSyncedRev: 3, lastSyncedHash: 'abc' });
    await a.repo.deleteMeta('sync:p1');
    expect(await a.repo.getMeta('sync:p1')).toBeUndefined();
    expect((await a.repo.storedProjects()).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'p1', rev: 1, name: 'One', trashed: false },
      { id: 'p2', rev: 1, name: 'Two', trashed: true },
    ]);
  });
});

describe('start-up asset GC', () => {
  it('skips the round while another tab holds a project lock, and runs once none does', async () => {
    const w = world();
    const a = w.tab({ queryLocks: async () => w.locks.query() });
    const b = w.tab({ queryLocks: async () => w.locks.query() });
    await a.repo.create(makeDoc('p1'));
    await a.repo.putAsset('p1', await blobOf(9, 9, 9), 'image/png'); // never referenced
    w.clock.now = new Date(w.clock.now.getTime() + 8 * DAY);
    // b starts while a edits p1: skipped.
    expect(await b.repo.gcAssets({ skipWhileEditing: true })).toEqual({ deleted: [], skipped: 'editing-elsewhere' });
    // Its own lock does not count.
    a.repo.release('p1');
    await b.repo.open('p1', 'edit');
    const r = await b.repo.gcAssets({ skipWhileEditing: true });
    expect(r.skipped).toBeUndefined();
    expect(r.deleted).toHaveLength(1);
  });

  it('skips when the lock manager cannot be asked; a direct call (no option) still collects', async () => {
    const w = world();
    const a = w.tab(); // the fake lock client has no query()
    await a.repo.create(makeDoc('p1'));
    await a.repo.putAsset('p1', await blobOf(7), 'image/png');
    w.clock.now = new Date(w.clock.now.getTime() + 8 * DAY);
    expect(await a.repo.gcAssets({ skipWhileEditing: true })).toEqual({ deleted: [], skipped: 'no-lock-query' });
    expect((await a.repo.gcAssets()).deleted).toHaveLength(1);
  });
});
