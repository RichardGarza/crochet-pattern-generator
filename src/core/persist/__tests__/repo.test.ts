// core/persist/repo — the IndexedDB repository (DESIGN.md §5.5.1–5.5.3, §6.3 T8 acceptance).
import { describe, expect, it } from 'vitest';
import { isImplemented } from '../../stub';
import type { ProjectDoc } from '../../../types/project';
import { assetKeyOf, sha256Hex } from '../assets';
import { holdLock, lockName } from '../locks';
import {
  copyName,
  createProjectRepository,
  importedName,
  ProjectLockedError,
  ProjectNotFoundError,
  RepositoryClosedError,
  type RepositoryEvent,
} from '../repo';
import { DB_NAME } from '../idb';
import { blobOf, bytes, makeDoc, settle, waitFor, world } from './helpers';

const renamed = (doc: ProjectDoc, name: string): ProjectDoc => ({ ...doc, name });

function events(repo: { subscribe(l: (e: RepositoryEvent) => void): () => void }): RepositoryEvent[] {
  const log: RepositoryEvent[] = [];
  repo.subscribe((e) => log.push(e));
  return log;
}

describe('createProjectRepository', () => {
  it('is implemented and keeps the frozen signature', () => {
    expect(isImplemented(createProjectRepository)).toBe(true);
  });

  it('needs an IndexedDB and a lock manager where the platform has none', () => {
    expect(() => createProjectRepository({ idb: undefined, locks: undefined })).toThrow(/IndexedDB|lock manager/);
  });
});

describe('save and load (fake-indexeddb)', () => {
  it('round trip: create, open, save, open again gives the saved document', async () => {
    const w = world();
    const { repo } = w.tab();
    const doc = makeDoc('p1');
    const created = await repo.create(doc);
    expect(created).toEqual({ ...doc, rev: 1 });

    const opened = await repo.open('p1', 'edit');
    expect(opened).toEqual({ doc: created, readOnly: false });

    const edited = { ...renamed(created, 'Heart blanket'), updatedAt: '2026-10-01T12:01:00.000Z' };
    const r = await repo.save(edited, new Map(), { baseRev: 1 });
    expect(r).toEqual({ ok: true, rev: 2 });
    expect((await repo.open('p1', 'read')).doc).toEqual({ ...edited, rev: 2 });
    expect(await repo.list()).toEqual([{ id: 'p1', name: 'Heart blanket', mode: '2d', updatedAt: edited.updatedAt }]);
  });

  it('stores a 3D document with nested data exactly (structured clone, no JSON loss)', async () => {
    const { repo } = world().tab();
    const doc = makeDoc('toy', 'photos');
    await repo.create(doc);
    const back = (await repo.open('toy', 'read')).doc;
    expect(back).toEqual({ ...doc, rev: 1 });
  });

  it('open of an unknown id throws ProjectNotFoundError and holds no lock', async () => {
    const w = world();
    const { repo } = w.tab();
    await expect(repo.open('nope', 'edit')).rejects.toBeInstanceOf(ProjectNotFoundError);
    await settle();
    expect(w.locks.isHeld(lockName('nope'))).toBe(false);
  });

  it('create refuses an existing id and an invalid one', async () => {
    const { repo } = world().tab();
    await repo.create(makeDoc('p1'));
    repo.release('p1');
    await expect(repo.create(makeDoc('p1'))).rejects.toThrow(/exists already/);
    await expect(repo.create(makeDoc('a/b'))).rejects.toThrow(/Invalid project id/);
  });

  it('list sorts by last edit, newest first, with the Claude Design badge', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create({ ...makeDoc('a'), updatedAt: '2026-09-01T00:00:00.000Z' });
    await repo.create({ ...makeDoc('b', 'describe'), updatedAt: '2026-09-03T00:00:00.000Z', qa: { awaiting: { since: '2026-09-03T00:00:00.000Z' } } as ProjectDoc['qa'] });
    await repo.create({ ...makeDoc('c'), updatedAt: '2026-09-02T00:00:00.000Z' });
    const list = await repo.list();
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(list[0].awaitingClaudeDesign).toBe(true);
  });
});

describe('compare-and-swap (§5.5.2)', () => {
  it('a save with a stale baseRev is refused and changes nothing', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    const base = (await b.repo.open('p1', 'read')).doc;
    expect(await b.repo.save(renamed(base, 'From B'), new Map(), { baseRev: 1 })).toMatchObject({ ok: true, rev: 2 });

    const stale = renamed(base, 'From A');
    const asset = await blobOf(1, 2, 3);
    const key = assetKeyOf('p1', await sha256Hex(asset));
    expect(await a.repo.save(stale, new Map([[key, asset]]), { baseRev: 1 })).toEqual({ ok: false, conflict: { storedRev: 2 } });
    expect((await a.repo.open('p1', 'read')).doc.name).toBe('From B');
    // The whole transaction was refused: not even the asset was written.
    expect(await a.repo.getAssetByKey(key)).toBeUndefined();
  });

  it('saveAsCopy: new id, rev 1, shared assets, holds the copy lock; the original is untouched', async () => {
    const w = world();
    const { repo } = w.tab();
    const asset = await blobOf(9, 9, 9);
    const key = assetKeyOf('p1', await sha256Hex(asset));
    await repo.create(makeDoc('p1'));
    await repo.save(makeDoc('p1'), new Map([[key, asset]]), { baseRev: 1 });

    const copy = await repo.saveAsCopy({ ...makeDoc('p1'), name: copyName('Untitled chart', new Date('2026-10-01T14:05:00')) }, new Map([[key, asset]]));
    expect(copy).toEqual({ id: 'copy-1', rev: 1 });
    const stored = (await repo.open('copy-1', 'read')).doc;
    expect(stored.name).toBe('Untitled chart (copy, 14:05)');
    expect(stored.id).toBe('copy-1');
    expect(stored.rev).toBe(1);
    expect(repo.holdsLock('copy-1')).toBe(true);
    expect((await repo.open('p1', 'read')).doc.rev).toBe(2);
    expect(await repo.getAssetByKey(key)).toBeDefined();
  });

  it('a save of a document whose stored version is newer than this app is a conflict', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    // A newer app wrote version 2 (same rev).
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = w.idb.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ ...makeDoc('p1'), version: 2, rev: 1 });
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect(await repo.save(makeDoc('p1'), new Map(), { baseRev: 1 })).toEqual({ ok: false, conflict: { storedRev: 1 } });
  });

  it('a project deleted elsewhere is written again by a later save (never dropped)', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    repo.release('p1');
    await repo.remove('p1');
    expect(await repo.save(makeDoc('p1', 'picture', 'Kept'), new Map(), { baseRev: 1 })).toEqual({ ok: true, rev: 2 });
    expect((await repo.open('p1', 'read')).doc.name).toBe('Kept');
  });
});

describe('assets (§5.5.1)', () => {
  it('putAsset is content-addressed: identical bytes are stored once under <projectId>/<sha256>', async () => {
    const w = world();
    const { repo } = w.tab();
    const sha = await sha256Hex(bytes(1, 2, 3));
    const a = await repo.putAsset('p1', new Blob([bytes(1, 2, 3)], { type: 'image/png' }), 'image/png');
    const b = await repo.putAsset('p1', new Blob([bytes(1, 2, 3)]), 'image/jpeg');
    expect(a).toEqual({ key: `p1/${sha}`, mime: 'image/png', bytes: 3, sha256: sha });
    // The second ref describes the blob stored first.
    expect(b).toEqual(a);
    expect(new Uint8Array(await (await repo.getAsset(a)).arrayBuffer())).toEqual(bytes(1, 2, 3));
    await expect(repo.getAsset({ ...a, key: `p1/${'0'.repeat(64)}` })).rejects.toThrow(/missing/);
  });

  it('assets are write-once: a save never replaces a stored asset', async () => {
    const w = world();
    const { repo } = w.tab();
    const blob = await blobOf(4, 5, 6);
    const key = assetKeyOf('p1', await sha256Hex(blob));
    await repo.create(makeDoc('p1'));
    await repo.save(makeDoc('p1'), new Map([[key, blob]]), { baseRev: 1 });
    w.clock.now = new Date('2026-10-02T12:00:00');
    await repo.save(makeDoc('p1'), new Map([[key, new Blob([bytes(4, 5, 6)], { type: 'image/webp' })]]), { baseRev: 2 });
    expect((await repo.getAssetByKey(key))?.type).toBe('image/png');
  });

  it('putAssetBlob checks the hash against the key', async () => {
    const { repo } = world().tab();
    await expect(repo.putAssetBlob(`p1/${'a'.repeat(64)}`, await blobOf(1))).rejects.toThrow(/do not match/);
    await expect(repo.putAssetBlob('nonsense', await blobOf(1))).rejects.toThrow(/Not an asset key/);
  });

  it('save reports assets the document names that the database lacks', async () => {
    const { repo } = world().tab();
    await repo.create(makeDoc('p1'));
    const ghost = `p1/${'b'.repeat(64)}`;
    const doc: ProjectDoc = { ...makeDoc('p1'), thumbnail: { key: ghost, mime: 'image/png', bytes: 3, sha256: 'b'.repeat(64) } };
    expect(await repo.save(doc, new Map(), { baseRev: 1 })).toEqual({ ok: true, rev: 2, missingAssets: [ghost] });
  });
});

describe('one writer per project (fake locks, §5.5.2)', () => {
  it('a second tab opens read-only while the first holds the lock', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    expect((await a.repo.open('p1', 'edit')).readOnly).toBe(false);
    expect((await b.repo.open('p1', 'edit')).readOnly).toBe(true);
    expect(b.repo.holdsLock('p1')).toBe(false);
    a.repo.release('p1');
    await w.locks.flush();
    expect((await b.repo.open('p1', 'edit')).readOnly).toBe(false);
  });

  it('"Edit here instead": the holder flushes, lets go and goes read-only; the asker gets the latest doc', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const aEvents = events(a.repo);
    await a.repo.create(makeDoc('p1'));
    let flushed = false;
    a.repo.setFlushHandler(async () => {
      // The holder's pending save lands before it lets go.
      await a.repo.save(renamed(makeDoc('p1'), 'Saved by A on hand-over'), new Map(), { baseRev: 1 });
      flushed = true;
    });
    await b.repo.open('p1', 'edit');
    const r = await b.repo.requestHandOver('p1');
    expect(flushed).toBe(true);
    expect(r).toMatchObject({ ok: true, doc: { name: 'Saved by A on hand-over', rev: 2 } });
    expect(b.repo.holdsLock('p1')).toBe(true);
    expect(a.repo.holdsLock('p1')).toBe(false);
    expect(aEvents).toContainEqual({ type: 'hand-over-requested', id: 'p1' });
    expect(aEvents).toContainEqual({ type: 'lock-lost', id: 'p1', reason: 'handed-over' });
  });

  it('a hand-over of a project whose holder closed its tab succeeds at once', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    a.locks.close();
    const r = await b.repo.requestHandOver('p1');
    expect(r.ok).toBe(true);
    expect(w.timers.pending()).toBe(0);
  });

  it('an unresponsive holder: no answer within 5 s → timeout; Take over steals, bumps the rev, and the old holder’s save is a conflict', async () => {
    const w = world();
    // Tab A is frozen: its channel never delivers, and it never lets go.
    const deaf = w.tab({ name: 'deaf', channel: () => ({ postMessage() {}, onmessage: null, close() {} }) });
    const b = w.tab();
    const aEvents = events(deaf.repo);
    await deaf.repo.create(makeDoc('p1'));
    const pending = b.repo.requestHandOver('p1');
    await waitFor(() => w.timers.pending() === 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await w.timers.advance(4999);
    expect(settled).toBe(false);
    await w.timers.advance(1);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });

    const taken = await b.repo.takeOver('p1');
    expect(taken.readOnly).toBe(false);
    expect(taken.doc.rev).toBe(2);
    expect(b.repo.holdsLock('p1')).toBe(true);
    await waitFor(() => aEvents.some((e) => e.type === 'lock-lost'));
    expect(aEvents).toContainEqual({ type: 'lock-lost', id: 'p1', reason: 'stolen' });
    expect(deaf.repo.holdsLock('p1')).toBe(false);
    // Whatever the old holder still saves is refused (it becomes a copy in useAutosave).
    expect(await deaf.repo.save(renamed(makeDoc('p1'), 'late'), new Map(), { baseRev: 1 })).toEqual({ ok: false, conflict: { storedRev: 2 } });
    // The document as it was before the take-over is kept as a snapshot (rev 1, created with the project).
    expect((await b.repo.getRevision('p1', 1))?.doc).toEqual({ ...makeDoc('p1'), rev: 1 });
  });

  it('a hand-over that arrives after the timeout gives the lock to the asker (lock-acquired)', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const bEvents = events(b.repo);
    await a.repo.create(makeDoc('p1'));
    let release!: () => void;
    a.repo.setFlushHandler(() => new Promise<void>((r) => (release = r)));
    // A takes its time to flush (longer than 5 s, shorter than its own 4 s flush limit would allow: give it more).
    const pending = b.repo.requestHandOver('p1', { timeoutMs: 1000 });
    await waitFor(() => w.timers.pending() === 2); // B's 1 s wait and A's 4 s flush limit
    await w.timers.advance(1000);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    release();
    await waitFor(() => bEvents.some((e) => e.type === 'lock-acquired'));
    expect(b.repo.holdsLock('p1')).toBe(true);
    expect(bEvents.find((e) => e.type === 'lock-acquired')).toMatchObject({ id: 'p1', doc: { id: 'p1' } });
  });

  it('"released" that arrives before the lock is really free: the asker retries until the deadline', async () => {
    const w = world();
    const b = w.tab({ name: 'B' });
    await b.repo.create(makeDoc('p1'));
    b.repo.release('p1');
    await w.locks.flush();
    // A hand-made holder that answers too early and lets go 300 ms later.
    const early = await holdLock(w.locks.client('early'), lockName('p1'));
    const channel = w.hub.channel('cpg');
    channel.onmessage = (e) => {
      const m = e.data as { type: string; id: string; from: string };
      if (m.type === 'release') {
        channel.postMessage({ type: 'released', id: m.id, to: m.from });
        w.timers.setTimeout(() => early?.release(), 300);
      }
    };
    const pending = b.repo.requestHandOver('p1');
    await waitFor(() => w.timers.pending() >= 3); // deadline, A's 300 ms release, B's first retry
    await w.timers.advance(400);
    expect(await pending).toMatchObject({ ok: true });
  });

  it('"released" but another tab got the lock first: busy, once the deadline passes', async () => {
    const w = world();
    const b = w.tab({ name: 'B' });
    await b.repo.create(makeDoc('p1'));
    b.repo.release('p1');
    await w.locks.flush();
    await holdLock(w.locks.client('third'), lockName('p1'));
    const channel = w.hub.channel('cpg');
    channel.onmessage = (e) => {
      const m = e.data as { type: string; id: string; from: string };
      if (m.type === 'release') channel.postMessage({ type: 'released', id: m.id, to: m.from });
    };
    const pending = b.repo.requestHandOver('p1');
    await waitFor(() => w.timers.pending() >= 2);
    await w.timers.advance(5000);
    expect(await pending).toEqual({ ok: false, reason: 'busy' });
  });

  it('a holder whose flush hangs still lets go after its 4 s limit', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    a.repo.setFlushHandler(() => new Promise<void>(() => {}));
    const pending = b.repo.requestHandOver('p1');
    await waitFor(() => w.timers.pending() === 2);
    await w.timers.advance(4000);
    expect(await pending).toMatchObject({ ok: true });
  });

  it('remove refuses a project another tab is editing', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    await a.repo.create(makeDoc('p1'));
    await expect(b.repo.remove('p1')).rejects.toBeInstanceOf(ProjectLockedError);
    expect((await b.repo.open('p1', 'read')).doc.id).toBe('p1');
  });

  it('remove deletes the document and its snapshots, tells the other tabs, and frees the lock', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const bEvents = events(b.repo);
    await a.repo.create(makeDoc('p1'));
    await a.repo.remove('p1');
    expect(await a.repo.list()).toEqual([]);
    expect(await a.repo.listRevisions('p1')).toEqual([]);
    await w.hub.flush();
    expect(bEvents).toContainEqual({ type: 'removed', id: 'p1', remote: true });
    await w.locks.flush();
    expect(w.locks.isHeld(lockName('p1'))).toBe(false);
  });

  it('saves are announced to the other tabs with the library summary', async () => {
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const bEvents = events(b.repo);
    await a.repo.create(makeDoc('p1'));
    await w.hub.flush();
    expect(bEvents).toContainEqual({ type: 'saved', id: 'p1', rev: 1, remote: true, summary: expect.objectContaining({ id: 'p1', name: 'Untitled chart' }) });
  });

  it('ignores malformed channel messages', async () => {
    const w = world();
    const a = w.tab();
    const raw = w.hub.channel('cpg');
    await a.repo.create(makeDoc('p1'));
    for (const m of [null, 1, 'x', { type: 'release' }, { type: 'release', id: 'p1' }, { type: 'nope', id: 'p1', from: 'x' }, { type: 'saved', id: 'p1', from: 'x' }]) raw.postMessage(m);
    await w.hub.flush();
    await settle();
    expect(a.repo.holdsLock('p1')).toBe(true);
  });
});

describe('schema upgrades: blocking and blocked (§5.5.2)', () => {
  it('a newer version elsewhere: this tab flushes, closes and says so; later calls fail clearly', async () => {
    const w = world();
    const old = w.tab();
    const log = events(old.repo);
    await old.repo.create(makeDoc('p1'));
    let flushed = false;
    old.repo.setFlushHandler(async () => {
      await old.repo.save(renamed(makeDoc('p1'), 'flushed before closing'), new Map(), { baseRev: 1 });
      flushed = true;
    });
    const newer = w.tab({ dbVersion: 2 });
    expect((await newer.repo.open('p1', 'read')).doc.name).toBe('flushed before closing');
    expect(flushed).toBe(true);
    expect(log.map((e) => e.type)).toEqual(expect.arrayContaining(['blocking', 'closed-for-upgrade']));
    expect(old.repo.isClosed()).toBe(true);
    expect(old.repo.holdsLock('p1')).toBe(false);
    await expect(old.repo.save(makeDoc('p1'), new Map(), { baseRev: 2 })).rejects.toBeInstanceOf(RepositoryClosedError);
  });

  it('an upgrade that waits for another tab reports blocked, then unblocked', async () => {
    const w = world();
    const stubborn = await new Promise<IDBDatabase>((resolve) => {
      const r = w.idb.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
    });
    const newer = w.tab({ dbVersion: 2 });
    const log = events(newer.repo);
    const listing = newer.repo.list();
    await waitFor(() => log.some((e) => e.type === 'blocked'));
    stubborn.close();
    await listing;
    expect(log.map((e) => e.type)).toEqual(['blocked', 'unblocked']);
  });
});

describe('snapshots (§5.5.2)', () => {
  it('creation snapshots rev 1; autosaves snapshot every 20 revs', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    for (let rev = 1; rev <= 25; rev++) await repo.save(makeDoc('p1'), new Map(), { baseRev: rev });
    expect((await repo.listRevisions('p1')).map((r) => [r.rev, r.label])).toEqual([
      [21, 'Autosave'],
      [1, 'Created'],
    ]);
  });

  it('and every 5 minutes', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    w.clock.now = new Date('2026-10-01T12:04:59');
    await repo.save(makeDoc('p1'), new Map(), { baseRev: 1 });
    w.clock.now = new Date('2026-10-01T12:05:00');
    await repo.save(makeDoc('p1'), new Map(), { baseRev: 2 });
    expect((await repo.listRevisions('p1')).map((r) => r.rev)).toEqual([3, 1]);
  });

  it('a named snapshot relabels an autosave snapshot of the same rev, never a named one', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    w.clock.now = new Date('2026-10-01T12:10:00');
    await repo.save(makeDoc('p1'), new Map(), { baseRev: 1 });
    expect(await repo.snapshot('p1', 'Before rebuild')).toBe(2);
    expect(await repo.snapshot('p1', 'Before cut')).toBe(2);
    expect((await repo.listRevisions('p1')).map((r) => r.label)).toEqual(['Before rebuild', 'Created']);
  });

  it('snapshot(label) keeps the stored document under its rev', async () => {
    const { repo } = world().tab();
    await repo.create(makeDoc('p1'));
    await repo.save(renamed(makeDoc('p1'), 'two'), new Map(), { baseRev: 1 });
    expect(await repo.snapshot('p1', 'Before cut')).toBe(2);
    expect(await repo.snapshot('nope', 'x')).toBeNull();
    const r = await repo.getRevision('p1', 2);
    expect(r).toMatchObject({ label: 'Before cut', rev: 2, doc: { name: 'two' } });
  });

  it('retention: the last 30 plus the newest of each day for 30 days', async () => {
    const w = world();
    const { repo } = w.tab();
    await repo.create(makeDoc('p1'));
    // 60 days of work, one snapshot every 6 hours (each save 5+ minutes after the last snapshot).
    const start = new Date('2026-08-02T00:30:00').getTime();
    for (let i = 0; i < 240; i++) {
      w.clock.now = new Date(start + i * 6 * 3600_000);
      await repo.save(makeDoc('p1'), new Map(), { baseRev: i + 1 });
    }
    const revs = await repo.listRevisions('p1');
    const now = w.clock.now.getTime();
    const last30 = revs.slice(0, 30);
    expect(last30.map((r) => r.rev)).toEqual(Array.from({ length: 30 }, (_, i) => 241 - i));
    // Beyond the last 30: one per day, and none older than 30 days.
    const older = revs.slice(30);
    const days = older.map((r) => new Date(r.at).toDateString());
    expect(new Set(days).size).toBe(days.length);
    for (const r of older) expect(now - Date.parse(r.at)).toBeLessThanOrEqual(30 * 24 * 3600_000);
    expect(older.length).toBeGreaterThanOrEqual(20);
  }, 60_000);
});

describe('asset GC (§5.5.5)', () => {
  it('deletes only assets no project and no snapshot names, and only after 7 days', async () => {
    const w = world();
    const { repo } = w.tab();
    const put = async (...v: number[]) => repo.putAsset('p1', await blobOf(...v), 'image/png');
    const inDoc = await put(1);
    const inSnapshot = await put(2);
    const inRevisionJson = await put(3);
    const bareKey = await put(4);
    const orphanOld = await put(5);
    // A model revision asset (JSON) whose meshAssets name another asset.
    const snapshotJson = await repo.putAsset(
      'p1',
      new Blob([JSON.stringify({ format: 'crochet-model-revision', version: 1, model: {}, meshAssets: { m: inRevisionJson } })], { type: 'application/json' }),
      'application/json',
    );

    // The snapshot (rev 1) names inSnapshot; the current doc (rev 2) does not.
    await repo.create({ ...makeDoc('p1'), thumbnail: inSnapshot });
    const current: ProjectDoc = {
      ...makeDoc('p1', 'photos'),
      thumbnail: inDoc,
      threeD: {
        ...makeDoc('p1', 'photos').threeD!,
        revisions: [{ rev: 1, at: '2026-10-01T12:00:00Z', source: 'seed', label: 'Seed', asset: snapshotJson }],
        views: [{ id: 'v1', view: 'front', imageKey: bareKey.key } as never],
      },
    };
    await repo.save(current, new Map(), { baseRev: 1 });

    w.clock.now = new Date('2026-10-05T12:00:00');
    const orphanNew = await put(6);
    expect((await repo.gcAssets()).deleted).toEqual([]); // nothing is 7 days old yet

    w.clock.now = new Date('2026-10-09T12:00:01');
    const { deleted } = await repo.gcAssets();
    expect(deleted).toEqual([orphanOld.key]);
    for (const kept of [inDoc, inSnapshot, inRevisionJson, bareKey, snapshotJson, orphanNew]) {
      expect(await repo.getAssetByKey(kept.key), kept.key).toBeDefined();
    }
    expect(await repo.getAssetByKey(orphanOld.key)).toBeUndefined();
  });

  it('assets of the original stay while a conflict copy names them', async () => {
    const w = world();
    const { repo } = w.tab();
    const a = await repo.putAsset('p1', await blobOf(7), 'image/png');
    await repo.create({ ...makeDoc('p1'), thumbnail: a });
    await repo.saveAsCopy({ ...makeDoc('p1'), thumbnail: a }, new Map());
    repo.release('p1');
    await repo.remove('p1');
    w.clock.now = new Date('2026-12-01T00:00:00');
    expect((await repo.gcAssets()).deleted).toEqual([]);
  });
});

describe('.crochet.json export and import (§5.5.3)', () => {
  async function richProject(w: ReturnType<typeof world>) {
    const { repo } = w.tab();
    const photo = await repo.putAsset('p1', await blobOf(10, 20, 30, 40), 'image/jpeg');
    const doc: ProjectDoc = {
      ...makeDoc('p1'),
      name: 'Heart blanket',
      sources: [{ id: 's1', asset: photo, name: 'heart.jpg', w: 2, h: 2, addedAt: '2026-10-01T11:00:00.000Z' }],
      thumbnail: photo,
    };
    await repo.create(doc);
    await repo.save({ ...doc, updatedAt: '2026-10-01T12:30:00.000Z' }, new Map(), { baseRev: 1 });
    return { repo, doc: (await repo.open('p1', 'read')).doc, photo };
  }

  it('round trip into a fresh database yields an identical document, its assets and its snapshots', async () => {
    const { repo, doc, photo } = await richProject(world());
    const file = await repo.exportFile('p1');
    expect(file.type).toBe('application/json');

    const other = world().tab();
    const r = await other.repo.importFile(file);
    expect(r).toEqual({ id: 'p1', renamed: false, status: 'imported', name: 'Heart blanket' });
    const back = (await other.repo.open('p1', 'read')).doc;
    expect(back).toEqual(doc);
    expect(new Uint8Array(await (await other.repo.getAsset(photo)).arrayBuffer())).toEqual(bytes(10, 20, 30, 40));
    expect((await other.repo.listRevisions('p1')).map((x) => x.label)).toContain('Created');
    // Exporting the imported project gives the same project and assets again.
    const again = JSON.parse(await (await other.repo.exportFile('p1')).text());
    const first = JSON.parse(await file.text());
    expect(again.project).toEqual(first.project);
    expect(again.assets).toEqual(first.assets);
  });

  it('import never overwrites: same id and same content → already in the library', async () => {
    const { repo, doc } = await richProject(world());
    const file = await repo.exportFile('p1');
    expect(await repo.importFile(file)).toEqual({ id: 'p1', renamed: false, status: 'already-present', name: 'Heart blanket' });
    expect((await repo.open('p1', 'read')).doc).toEqual(doc);
    expect((await repo.list()).length).toBe(1);
  });

  it('import never overwrites: same id, other content → a new project "(imported <date>)"', async () => {
    const w = world();
    const { repo, doc } = await richProject(w);
    const file = await repo.exportFile('p1');
    const edited = { ...doc, name: 'Edited since', updatedAt: '2026-10-01T13:00:00.000Z' };
    await repo.save(edited, new Map(), { baseRev: doc.rev });
    const r = await repo.importFile(file);
    expect(r).toEqual({ id: 'copy-1', renamed: true, status: 'imported-as-copy', name: importedName('Heart blanket', w.clock.now) });
    expect(r.name).toBe('Heart blanket (imported 2026-10-01)');
    expect((await repo.open('p1', 'read')).doc.name).toBe('Edited since');
    const imported = (await repo.open('copy-1', 'read')).doc;
    expect(imported).toEqual({ ...doc, id: 'copy-1', name: r.name, rev: doc.rev });
    // Its snapshots belong to the new id.
    for (const info of await repo.listRevisions('copy-1')) expect((await repo.getRevision('copy-1', info.rev))?.doc.id).toBe('copy-1');
  });

  it('import refuses damaged files and changes nothing', async () => {
    const { repo } = await richProject(world());
    const text = await (await repo.exportFile('p1')).text();
    const json = JSON.parse(text);
    const key = Object.keys(json.assets)[0];
    const tampered = structuredClone(json);
    tampered.assets[key].base64 = btoa('evil');
    const target = world().tab().repo;
    await expect(target.importFile(new Blob([JSON.stringify(tampered)]))).rejects.toMatchObject({ code: 'hash-mismatch' });
    await expect(target.importFile(new Blob(['{nope']))).rejects.toMatchObject({ code: 'not-json' });
    await expect(target.importFile(new Blob([JSON.stringify({ ...json, version: 2 })]))).rejects.toMatchObject({ code: 'newer-version' });
    await expect(target.importFile(new Blob([JSON.stringify({ ...json, project: { ...json.project, version: 7 } })]))).rejects.toMatchObject({ code: 'newer-version' });
    await expect(target.importFile(new Blob([JSON.stringify({ ...json, project: { ...json.project, id: 'a/b' } })]))).rejects.toMatchObject({ code: 'invalid' });
    expect(await target.list()).toEqual([]);
  });

  it('exportFile of an unknown project throws', async () => {
    await expect(world().tab().repo.exportFile('nope')).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('settings and storage', () => {
  it('settings round trip', async () => {
    const { repo } = world().tab();
    expect(await repo.getSetting('prefs')).toBeUndefined();
    await repo.putSetting('prefs', { units: 'cm' });
    expect(await repo.getSetting('prefs')).toEqual({ units: 'cm' });
  });

  it('requestPersistence asks navigator.storage once it is not persisted yet', async () => {
    const calls: string[] = [];
    const w = world();
    const { repo } = w.tab({
      storage: {
        persisted: async () => (calls.push('persisted'), false),
        persist: async () => (calls.push('persist'), true),
        estimate: async () => ({ usage: 10, quota: 100 }),
      },
    });
    expect(await repo.requestPersistence()).toBe(true);
    expect(calls).toEqual(['persisted', 'persist']);
    expect(await repo.estimate()).toEqual({ usage: 10, quota: 100 });
    expect(await w.tab({ storage: null }).repo.requestPersistence()).toBeNull();
  });
});
