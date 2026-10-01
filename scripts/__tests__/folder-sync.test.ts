// The folder mirror end to end (DESIGN.md §5.5.4 "Sync"): the app's sync engine (src/core/persist/folderClient.ts)
// on a fake IndexedDB, talking HTTP to the real plugin routes on a temp folder. Saves are mirrored after 5 s with
// only the missing assets uploaded; start-up compares each project with its `sync:<id>` base — push, offer the
// folder version, keep both on a two-sided edit, offer to restore; deletes go to Backups/deleted; restores from
// backups never overwrite.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFolderApi, createFolderMirror, type FetchLike, type FolderMirror } from '../../src/core/persist/folderClient.ts';
import { SYNC_PREFIX } from '../../src/core/persist/repo.ts';
import { blobOf, makeDoc, settle, world, type Tab, type World } from '../../src/core/persist/__tests__/helpers.ts';
import { backupsDirFor, createFolderStore, folderRoutes, type FolderStore } from '../project-folder.ts';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Folder {
  projectsDir: string;
  backupsDir: string;
  store: FolderStore;
  url: string;
  /** Every request the server saw ("PUT /__projects/p1/doc"). */
  requests: string[];
}

async function folder(): Promise<Folder> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-sync-test-'));
  const projectsDir = path.join(root, 'projects');
  const backupsDir = backupsDirFor(projectsDir);
  const store = createFolderStore({ projectsDir, backupsDir, statfs: async () => 100e9, log: { info() {}, warn() {}, error() {} } });
  const routes = folderRoutes(store, { log: { info() {}, warn() {}, error() {} } });
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    routes(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { projectsDir, backupsDir, store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function mirrorFor(w: World, tab: Tab, f: Folder, ids = { n: 0 }): FolderMirror {
  const m = createFolderMirror({
    repo: tab.repo,
    api: createFolderApi({ base: f.url, fetch: ((url, init) => fetch(url, init as RequestInit)) as FetchLike }),
    locks: tab.locks,
    timers: w.timers,
    newId: () => `folder-copy-${++ids.n}`,
  });
  cleanups.push(() => m.dispose());
  return m;
}

/** Waits (real time) until the mirror's queued work has reached the server. */
async function idle(m: FolderMirror): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await settle(5);
    await new Promise((r) => setTimeout(r, 5));
    if (m.state().status !== 'syncing') return;
  }
}

const folderDoc = (f: Folder, id: string) => JSON.parse(fs.readFileSync(path.join(f.projectsDir, id, 'project.json'), 'utf8'));

describe('folder mirror sync', () => {
  it('mirrors a save after 5 s, uploads only the assets the folder lacks, and records sync:<id>', async () => {
    const f = await folder();
    const w = world();
    const tab = w.tab();
    const m = mirrorFor(w, tab, f);
    const doc = makeDoc('p1', 'picture', 'Heart');
    await tab.repo.create(doc);
    const ref = await tab.repo.putAsset('p1', await blobOf(1, 2, 3), 'image/png');
    await tab.repo.save({ ...doc, thumbnail: ref }, new Map(), { baseRev: 1 });
    await w.timers.advance(4999);
    expect(fs.existsSync(path.join(f.projectsDir, 'p1'))).toBe(false); // debounced
    await w.timers.advance(1);
    await idle(m);
    await waitUntil(() => fs.existsSync(path.join(f.projectsDir, 'p1', 'project.json')));
    expect(folderDoc(f, 'p1')).toMatchObject({ id: 'p1', rev: 2, name: 'Heart', thumbnail: ref });
    const assetSha = ref.key.split('/')[1];
    expect(fs.readdirSync(path.join(f.projectsDir, 'p1', 'assets'))).toEqual([assetSha]);
    // The sync base is written once the server answered (just after the file appeared).
    let base: unknown;
    for (let i = 0; i < 200 && base === undefined; i++) {
      base = await tab.repo.getMeta(SYNC_PREFIX + 'p1');
      if (base === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    expect(base).toEqual({ lastSyncedRev: 2, lastSyncedHash: sha(fs.readFileSync(path.join(f.projectsDir, 'p1', 'project.json'))) });

    // The next save: the asset is not uploaded again.
    f.requests.length = 0;
    await tab.repo.save({ ...doc, thumbnail: ref, name: 'Heart 2' }, new Map(), { baseRev: 2 });
    await w.timers.advance(5000);
    await idle(m);
    await waitUntil(() => folderDoc(f, 'p1').name === 'Heart 2');
    expect(f.requests.filter((r) => r.startsWith('PUT'))).toEqual(['PUT /__projects/p1/doc']);
  });

  it('start-up: local newer ⇒ push; folder changed ⇒ offer the folder version; folder only ⇒ offer restore', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    for (const id of ['newer', 'changed', 'same']) {
      await a.repo.create(makeDoc(id, 'picture', id));
      a.repo.release(id);
    }
    await m.reconcile();
    expect(fs.readdirSync(f.projectsDir).sort()).toEqual(['changed', 'newer', 'same']);

    // This browser changes "newer"; the folder's "changed" is edited elsewhere; a project only the folder has.
    await a.repo.open('newer', 'edit');
    await a.repo.save(makeDoc('newer', 'picture', 'newer v2'), new Map(), { baseRev: 1 });
    a.repo.release('newer');
    const edited = { ...folderDoc(f, 'changed'), name: 'changed in the folder', rev: 5 };
    fs.writeFileSync(path.join(f.projectsDir, 'changed', 'project.json'), JSON.stringify(edited));
    const elsewhere = { ...makeDoc('elsewhere', 'photos', 'From the other browser'), rev: 3 };
    await f.store.writeDoc('elsewhere', Buffer.from(JSON.stringify(elsewhere)), null);

    const m2 = mirrorFor(w, a, f); // "the next start"
    m.dispose();
    await m2.reconcile();
    expect(folderDoc(f, 'newer').name).toBe('newer v2');
    expect(m2.state().changedInFolder.map((p) => p.id)).toEqual(['changed']);
    expect(m2.state().restorable.map((p) => [p.id, p.name])).toEqual([['elsewhere', 'From the other browser']]);
    expect(m2.state().folder?.folder).toBe(f.projectsDir);
    expect((await a.repo.peek('changed'))?.name).toBe('changed'); // nothing loaded without asking

    // Load the folder version: the browser's copy is snapshotted first.
    await m2.loadFolderVersion('changed');
    expect((await a.repo.peek('changed'))?.name).toBe('changed in the folder');
    // The browser's version is kept as a snapshot (rev 1 had one already: "Created").
    expect((await a.repo.getRevision('changed', 1))?.doc.name).toBe('changed');
    expect((await a.repo.peek('changed'))?.rev).toBe(2);
    expect(m2.state().changedInFolder).toEqual([]);
    expect(a.repo.holdsLock('changed')).toBe(false);

    // Restore the folder-only project: same id, its sync base recorded (no push back needed).
    const outcome = await m2.restoreFromFolder('elsewhere');
    expect(outcome).toMatchObject({ id: 'elsewhere', status: 'imported', name: 'From the other browser' });
    expect(m2.state().restorable).toEqual([]);
    f.requests.length = 0;
    await m2.reconcile();
    expect(f.requests.filter((r) => r.startsWith('PUT'))).toEqual([]);
    expect(m2.state().changedInFolder).toEqual([]);
  });

  it('a two-sided edit keeps both: the folder copy becomes "<name> (from folder)", this browser’s version goes to the folder', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const ids = { n: 0 };
    const m = mirrorFor(w, a, f, ids);
    const doc = makeDoc('p1', 'picture', 'Bear');
    await a.repo.create(doc);
    const ref = await a.repo.putAsset('p1', await blobOf(4, 5, 6), 'image/png');
    await a.repo.save({ ...doc, thumbnail: ref }, new Map(), { baseRev: 1 });
    a.repo.release('p1');
    await m.reconcile();
    // Both sides change.
    await a.repo.open('p1', 'edit');
    await a.repo.save({ ...doc, thumbnail: ref, name: 'Bear (browser edit)' }, new Map(), { baseRev: 2 });
    a.repo.release('p1');
    fs.writeFileSync(path.join(f.projectsDir, 'p1', 'project.json'), JSON.stringify({ ...folderDoc(f, 'p1'), name: 'Bear (folder edit)', rev: 9 }));

    const m2 = mirrorFor(w, a, f, ids);
    m.dispose();
    await m2.reconcile();
    expect(m2.state().keptBoth).toEqual([{ id: 'p1', name: 'Bear (browser edit)', copyId: 'folder-copy-1', copyName: 'Bear (folder edit) (from folder)' }]);
    expect((await a.repo.peek('p1'))?.name).toBe('Bear (browser edit)');
    const copy = await a.repo.peek('folder-copy-1');
    expect(copy).toMatchObject({ name: 'Bear (folder edit) (from folder)', thumbnail: ref });
    expect(await a.repo.getAssetByKey(ref.key)).toBeDefined();
    expect(folderDoc(f, 'p1').name).toBe('Bear (browser edit)');
    // The copy is mirrored too, after the debounce.
    await w.timers.advance(5000);
    await idle(m2);
    await waitUntil(() => fs.existsSync(path.join(f.projectsDir, 'folder-copy-1', 'project.json')));
    expect(folderDoc(f, 'folder-copy-1').name).toBe('Bear (folder edit) (from folder)');
    // A save after a conflict found by a push (no start-up needed) also keeps both.
    fs.writeFileSync(path.join(f.projectsDir, 'p1', 'project.json'), JSON.stringify({ ...folderDoc(f, 'p1'), name: 'Bear (folder again)' }));
    await a.repo.open('p1', 'edit');
    await a.repo.save({ ...doc, thumbnail: ref, name: 'Bear (browser again)' }, new Map(), { baseRev: 3 });
    await m2.push('p1');
    expect(m2.state().keptBoth.map((k) => k.copyName)).toContain('Bear (folder again) (from folder)');
    expect(folderDoc(f, 'p1').name).toBe('Bear (browser again)');
  });

  it('a first sync where the folder already holds the same content adopts it (no copy)', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    const doc = makeDoc('p1', 'picture', 'Same');
    await a.repo.create(doc);
    // The folder has the same document, written with other key order and another rev (a reset browser).
    const stored = (await a.repo.peek('p1'))!;
    const reordered = Object.fromEntries(Object.entries({ ...stored, rev: 7 }).reverse());
    await f.store.writeDoc('p1', Buffer.from(JSON.stringify(reordered)), null);
    await m.reconcile();
    expect(m.state().keptBoth).toEqual([]);
    expect((await a.repo.storedProjects()).map((p) => p.id)).toEqual(['p1']);
    expect(await a.repo.getMeta(SYNC_PREFIX + 'p1')).toMatchObject({ lastSyncedRev: 1 });
  });

  it('two tabs pushing the same project one after the other never make a false two-sided copy', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const b = w.tab();
    const ma = mirrorFor(w, a, f);
    const mb = mirrorFor(w, b, f);
    await a.repo.create(makeDoc('p1', 'picture', 'v1'));
    await ma.reconcile();
    for (let rev = 1; rev <= 5; rev++) {
      await a.repo.save(makeDoc('p1', 'picture', `v${rev + 1}`), new Map(), { baseRev: rev });
      // Both tabs' mirrors try at once (b's start-up reconcile, a's debounced push).
      await Promise.all([ma.push('p1'), mb.reconcile()]);
    }
    expect(ma.state().keptBoth).toEqual([]);
    expect(mb.state().keptBoth).toEqual([]);
    expect(folderDoc(f, 'p1').name).toBe('v6');
    expect((await a.repo.storedProjects()).map((p) => p.id)).toEqual(['p1']);
  });

  it('deleting for good moves the folder copy to Backups/deleted; a trashed project stays mirrored', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    await a.repo.create(makeDoc('p1'));
    a.repo.release('p1');
    await m.reconcile();
    await a.repo.trash('p1');
    await m.reconcile();
    expect(fs.existsSync(path.join(f.projectsDir, 'p1'))).toBe(true);
    expect(m.state().restorable).toEqual([]); // still in this browser (Recently deleted)
    await a.repo.remove('p1');
    await waitUntil(() => !fs.existsSync(path.join(f.projectsDir, 'p1')));
    const deleted = fs.readdirSync(path.join(f.backupsDir, 'deleted'));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^p1-\d{8}-\d{6}$/);
    await m.reconcile();
    expect(m.state().restorable).toEqual([]); // a deleted project never comes back as a restore offer
  });

  it('restores from a backup without overwriting (an existing id becomes an "(imported …)" copy)', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    const doc = makeDoc('p1', 'picture', 'Scarf');
    await a.repo.create(doc);
    const ref = await a.repo.putAsset('p1', await blobOf(8, 8), 'image/png');
    await a.repo.save({ ...doc, thumbnail: ref }, new Map(), { baseRev: 1 });
    await m.reconcile();
    expect((await f.store.backup()).status).toBe('created');
    const { backups } = await m.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].projects.map((p) => [p.id, p.name])).toEqual([['p1', 'Scarf']]);

    // Identical to what this browser has: "already in your library".
    expect(await m.restoreFromBackup(backups[0].name, 'p1')).toMatchObject({ id: 'p1', status: 'already-present' });
    // After a change here, the backup comes back as a copy, never over the project.
    await a.repo.save({ ...doc, thumbnail: ref, name: 'Scarf, longer' }, new Map(), { baseRev: 2 });
    const again = await m.restoreFromBackup(backups[0].name, 'p1');
    expect(again).toMatchObject({ status: 'imported-as-copy', name: 'Scarf (imported 2026-10-01)' });
    expect((await a.repo.peek('p1'))?.name).toBe('Scarf, longer');
    expect((await a.repo.peek(again.id))?.thumbnail).toEqual(ref);
    // Into a fresh browser: the same id.
    const fresh = world();
    const t = fresh.tab();
    const mf = mirrorFor(fresh, t, f);
    const r = await mf.restoreFromBackup(backups[0].name, 'p1');
    expect(r).toMatchObject({ id: 'p1', status: 'imported' });
    expect(await t.repo.getAssetByKey(ref.key)).toBeDefined();
  });

  it('a folder copy saved by a newer app version is never overwritten or loaded; restoring it explains', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    await a.repo.create(makeDoc('p1', 'picture', 'Mine'));
    await m.reconcile();
    // Another, newer app wrote version 99 into the folder; this browser edits too.
    const newer = { ...folderDoc(f, 'p1'), version: 99, name: 'From the future' };
    fs.writeFileSync(path.join(f.projectsDir, 'p1', 'project.json'), JSON.stringify(newer));
    await a.repo.save(makeDoc('p1', 'picture', 'Mine, edited'), new Map(), { baseRev: 1 });
    await expect(m.push('p1')).rejects.toThrow(/newer version of the app/);
    expect(folderDoc(f, 'p1')).toMatchObject({ version: 99, name: 'From the future' });
    expect((await a.repo.peek('p1'))?.name).toBe('Mine, edited');
    // Only in the folder: restoring it says why it cannot.
    await f.store.writeDoc('future', Buffer.from(JSON.stringify({ ...makeDoc('future'), version: 99 })), null);
    await expect(m.restoreFromFolder('future')).rejects.toThrow(/newer version of the app/);
    expect(await a.repo.peek('future')).toBeUndefined();
  });

  it('a project deleted for good while no mirror ran is moved away at the next start, never offered back', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    await a.repo.create(makeDoc('gone', 'picture', 'Deleted scarf'));
    await a.repo.create(makeDoc('edited-elsewhere', 'picture', 'Shared'));
    a.repo.release('gone');
    a.repo.release('edited-elsewhere');
    await m.reconcile();
    m.dispose(); // the mirror is not running (the probe has not answered yet)
    await a.repo.remove('gone');
    await a.repo.remove('edited-elsewhere');
    // Another browser changed this one in the folder meanwhile: it must be offered, not moved away.
    fs.writeFileSync(path.join(f.projectsDir, 'edited-elsewhere', 'project.json'), JSON.stringify({ ...folderDoc(f, 'edited-elsewhere'), name: 'Shared, edited elsewhere' }));
    const m2 = mirrorFor(w, a, f);
    await m2.reconcile();
    expect(fs.existsSync(path.join(f.projectsDir, 'gone'))).toBe(false);
    expect(fs.readdirSync(path.join(f.backupsDir, 'deleted')).some((n) => n.startsWith('gone-'))).toBe(true);
    expect(m2.state().restorable.map((p) => p.id)).toEqual(['edited-elsewhere']);
    expect(await a.repo.getMeta('gone:gone')).toBeUndefined();
  });

  it('one bad folder doc does not stop the reconcile of the others; the folder losing a project gets it back', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    await a.repo.create(makeDoc('aaa', 'picture', 'Future'));
    await a.repo.create(makeDoc('lost', 'picture', 'Lost'));
    await m.reconcile();
    fs.writeFileSync(path.join(f.projectsDir, 'aaa', 'project.json'), JSON.stringify({ ...folderDoc(f, 'aaa'), version: 99 }));
    await a.repo.save(makeDoc('aaa', 'picture', 'Future, edited'), new Map(), { baseRev: 1 });
    fs.rmSync(path.join(f.projectsDir, 'lost'), { recursive: true }); // removed from the folder by hand
    await f.store.writeDoc('zzz', Buffer.from(JSON.stringify({ ...makeDoc('zzz', 'picture', 'Other browser'), rev: 2 })), null);
    await a.repo.create(makeDoc('mmm', 'picture', 'Never pushed'));
    await expect(m.reconcile()).rejects.toThrow(/Future, edited.*newer version of the app/);
    expect(m.state().status).toBe('error');
    expect(m.state().restorable.map((p) => p.id)).toEqual(['zzz']);
    expect(folderDoc(f, 'mmm').name).toBe('Never pushed');
    expect(folderDoc(f, 'lost').name).toBe('Lost');
    expect(folderDoc(f, 'aaa').version).toBe(99);
  });

  it('a project id the folder cannot hold is not mirrored, and says so', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    const m = mirrorFor(w, a, f);
    await a.repo.create(makeDoc('odd:id'));
    expect(await m.push('odd:id')).toBe('unsupported');
    expect(m.state().unsupported).toEqual(['odd:id']);
    expect(fs.existsSync(f.projectsDir) ? fs.readdirSync(f.projectsDir) : []).toEqual([]);
  });

  it('a server that stopped answering sets the error state; the next push recovers', async () => {
    const f = await folder();
    const w = world();
    const a = w.tab();
    let down = true;
    const m = createFolderMirror({
      repo: a.repo,
      api: createFolderApi({
        base: f.url,
        fetch: (async (url: string, init?: RequestInit) => {
          if (down) throw new TypeError('Failed to fetch');
          return fetch(url, init);
        }) as unknown as FetchLike,
      }),
      timers: w.timers,
    });
    cleanups.push(() => m.dispose());
    await a.repo.create(makeDoc('p1'));
    await expect(m.push('p1')).rejects.toThrow('Failed to fetch');
    expect(m.state()).toMatchObject({ status: 'error', lastError: 'Failed to fetch' });
    down = false;
    expect(await m.push('p1')).toBe('pushed');
    expect(m.state()).toMatchObject({ status: 'idle', lastError: null });
  });
});

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil: never');
}
