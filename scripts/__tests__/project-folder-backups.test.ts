// Backups of the folder mirror (DESIGN.md §5.5.4), on real temp folders: change-only backups on the shared,
// content-addressed asset store; "two backups of an unchanged 100 MB asset set (only a doc changed) add < 1 MB of
// new files"; retention with the 24 h guard and the size cap; asset GC; the free-space thresholds with a stubbed
// statfs (the mirror keeps working when backups stop); Backups/deleted is never pruned; restore reads.
import { createHash, randomFillSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupsDirFor, createFolderStore, type Logger } from '../project-folder.ts';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function docJson(id: string, rev: number, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ schema: 'crochet-project', version: 1, id, rev, name: `Project ${id}`, mode: '3d', updatedAt: '2026-10-01T10:00:00.000Z', ...extra }));
}

function setup(o: { free?: number; cap?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-backup-test-'));
  temps.push(root);
  const projectsDir = path.join(root, 'projects');
  const backupsDir = backupsDirFor(projectsDir);
  const clock = { now: new Date(2026, 9, 1, 12, 0) };
  const disk = { free: o.free ?? 100e9 };
  const logs: string[] = [];
  const log: Logger = { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
  const store = createFolderStore({ projectsDir, backupsDir, now: () => new Date(clock.now), statfs: async () => disk.free, capBytes: o.cap ?? Infinity, log });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  async function* chunks(buf: Buffer): AsyncIterable<Buffer> {
    for (let i = 0; i < buf.length; i += 1 << 20) yield buf.subarray(i, i + (1 << 20));
  }
  const putAsset = async (id: string, bytes: Buffer): Promise<string> => {
    const h = sha(bytes);
    await store.writeAsset(id, h, chunks(bytes));
    return h;
  };
  return { root, projectsDir, backupsDir, clock, disk, logs, store, advance, putAsset };
}

/** Every file under `dir` with its size. */
function filesUnder(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, fs.statSync(p).size);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const backupNames = (backupsDir: string): string[] =>
  fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/.test(n)).sort() : [];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('backups', () => {
  it('backs up on start only when something changed; layout, manifest and shared assets', async () => {
    const t = setup();
    expect((await t.store.start()).status).toBe('empty'); // no projects: no backup
    expect(backupNames(t.backupsDir)).toEqual([]);

    await t.store.writeDoc('p1', docJson('p1', 1, { name: 'Bear' }), null);
    const a = await t.putAsset('p1', Buffer.from('photo bytes'));
    const first = await t.store.start();
    expect(first).toMatchObject({ status: 'created', name: '2026-10-01-1200', projects: 1, newAssets: 1 });
    const dir = path.join(t.backupsDir, '2026-10-01-1200');
    expect(fs.readFileSync(path.join(dir, 'projects', 'p1', 'project.json'))).toEqual(docJson('p1', 1, { name: 'Bear' }));
    expect(fs.readFileSync(path.join(t.backupsDir, 'assets', a), 'utf8')).toBe('photo bytes');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'cpg-backup', version: 1, projects: [{ id: 'p1', name: 'Bear', mode: '3d', rev: 1, docSha256: sha(docJson('p1', 1, { name: 'Bear' })), assets: [a] }] });
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);

    // Restart with nothing changed: skipped.
    t.advance(HOUR);
    expect(await t.store.start()).toMatchObject({ status: 'unchanged', newest: '2026-10-01-1200' });
    expect(backupNames(t.backupsDir)).toEqual(['2026-10-01-1200']);
    expect(t.logs.join('\n')).toContain('Backup skipped: nothing changed since 2026-10-01-1200');

    // A new asset name changes the hash (asset bytes are never read: the name is the hash).
    await t.putAsset('p1', Buffer.from('second photo'));
    expect((await t.store.backup()).status).toBe('created');
    // Two backups in the same minute get a suffix.
    await t.store.writeDoc('p1', docJson('p1', 2), undefined);
    expect(await t.store.backup()).toMatchObject({ status: 'created', name: '2026-10-01-1300-2' });

    // Restore reads: the list (newest first), a doc, a shared asset.
    const list = await t.store.listBackups();
    expect(list.backups.map((b) => b.name)).toEqual(['2026-10-01-1300-2', '2026-10-01-1300', '2026-10-01-1200']);
    expect(list.backups[2].projects[0]).toMatchObject({ id: 'p1', name: 'Bear', rev: 1 });
    expect(await t.store.readBackupDoc('2026-10-01-1200', 'p1')).toEqual(docJson('p1', 1, { name: 'Bear' }));
    expect(await t.store.readBackupDoc('2026-10-01-1200', 'nope')).toBeNull();
    await expect(t.store.readBackupDoc('../projects', 'p1')).rejects.toMatchObject({ status: 400 });
    expect(fs.readFileSync(t.store.backupAssetPath(a), 'utf8')).toBe('photo bytes');
  });

  it(
    'two backups of an unchanged 100 MB asset set (only a doc changed) add < 1 MB of new files',
    async () => {
      const t = setup();
      const hashes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const bytes = Buffer.alloc(25 * 1024 * 1024);
        randomFillSync(bytes);
        hashes.push(await t.putAsset('p1', bytes));
      }
      await t.store.writeDoc('p1', docJson('p1', 1), null);
      await t.store.writeDoc('p2', docJson('p2', 1), null);
      expect((await t.store.backup()).status).toBe('created');
      const before = filesUnder(t.backupsDir);
      const sharedBytes = [...before].filter(([p]) => p.includes(`${path.sep}assets${path.sep}`)).reduce((s, [, n]) => s + n, 0);
      expect(sharedBytes).toBe(100 * 1024 * 1024);

      // Only a doc changes, twice: two more backups.
      for (const rev of [2, 3]) {
        t.advance(10 * 60_000);
        await t.store.writeDoc('p1', docJson('p1', rev), undefined);
        const r = await t.store.backup();
        expect(r).toMatchObject({ status: 'created', newAssets: 0 });
      }
      const after = filesUnder(t.backupsDir);
      const added = [...after].filter(([p]) => !before.has(p)).reduce((s, [, n]) => s + n, 0);
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(1024 * 1024);
      expect(backupNames(t.backupsDir)).toHaveLength(3);
      // Every backup names the same four shared assets.
      for (const name of backupNames(t.backupsDir)) {
        const m = JSON.parse(fs.readFileSync(path.join(t.backupsDir, name, 'manifest.json'), 'utf8'));
        expect(m.projects.find((p: { id: string }) => p.id === 'p1').assets).toEqual([...hashes].sort());
      }
    },
    120_000,
  );

  it('retention: newest 20 + one per day for 30 days, the 24 h guard, and asset GC of what no kept backup names', async () => {
    const t = setup();
    // 45 days, one backup a day at noon, each with its own new asset (so every backup differs).
    t.clock.now = new Date(2026, 7, 1, 12, 0);
    const assetOf = new Map<string, string>();
    for (let day = 0; day < 45; day++) {
      const h = await t.putAsset('p1', Buffer.from(`day ${day}`));
      await t.store.writeDoc('p1', docJson('p1', day + 1), undefined);
      const r = await t.store.backup();
      expect(r.status).toBe('created');
      if (r.status === 'created') assetOf.set(r.name, h);
      t.advance(DAY);
    }
    const kept = backupNames(t.backupsDir);
    // Newest 20 (days 25–44) ∪ newest of each day up to 30 days old (days 14–44) = days 14–44.
    expect(kept).toHaveLength(31);
    expect(kept[0]).toBe('2026-08-15-1200');
    // Asset GC: every project-folder asset is still named by the newest backups (the project holds all 45),
    // so the shared store keeps them all.
    expect(fs.readdirSync(path.join(t.backupsDir, 'assets'))).toHaveLength(45);

    // Now the project drops its old assets (as the app's GC would): later backups no longer name them, and once
    // the backups that do are pruned, the shared store lets them go too.
    for (const [, h] of assetOf) fs.rmSync(path.join(t.projectsDir, 'p1', 'assets', h), { force: true });
    const keep = await t.putAsset('p1', Buffer.from('the only asset now'));
    // 31 more days of backups.
    for (let day = 0; day < 31; day++) {
      await t.store.writeDoc('p1', docJson('p1', 100 + day), undefined);
      expect((await t.store.backup()).status).toBe('created');
      t.advance(DAY);
    }
    const shared = fs.readdirSync(path.join(t.backupsDir, 'assets'));
    expect(shared).toEqual([keep]);
    expect(backupNames(t.backupsDir)).toHaveLength(31);

    // Many restarts within a day (each with a change): none of them is pruned while younger than 24 h.
    for (let i = 0; i < 40; i++) {
      await t.store.writeDoc('p1', docJson('p1', 500 + i), undefined);
      expect((await t.store.backup()).status).toBe('created');
      t.advance(10 * 60_000);
    }
    const names = backupNames(t.backupsDir);
    const young = names.filter((n) => t.clock.now.getTime() - new Date(Number(n.slice(0, 4)), Number(n.slice(5, 7)) - 1, Number(n.slice(8, 10)), Number(n.slice(11, 13)), Number(n.slice(13, 15))).getTime() < DAY);
    expect(young).toHaveLength(40);
  });

  it('the size cap prunes oldest first, never the newest or one younger than 24 h, and frees their assets', async () => {
    const t = setup({ cap: 3.5 * 1024 * 1024 });
    t.clock.now = new Date(2026, 8, 1, 12, 0);
    const assets: string[] = [];
    // Five backups, two days apart, each with its own 1 MiB asset (the project keeps only its newest asset).
    for (let i = 0; i < 5; i++) {
      for (const old of assets) fs.rmSync(path.join(t.projectsDir, 'p1', 'assets', old), { force: true });
      const bytes = Buffer.alloc(1024 * 1024, i + 1);
      assets.push(await t.putAsset('p1', bytes));
      await t.store.writeDoc('p1', docJson('p1', i + 1), undefined);
      expect((await t.store.backup()).status).toBe('created');
      t.advance(2 * DAY);
    }
    // Five 1 MiB assets > 3.5 MiB: the two oldest backups went, and their assets with them.
    const names = backupNames(t.backupsDir);
    expect(names).toEqual(['2026-09-05-1200', '2026-09-07-1200', '2026-09-09-1200']);
    expect(fs.readdirSync(path.join(t.backupsDir, 'assets')).sort()).toEqual(assets.slice(2).sort());

    // A cap of zero: only the guarded backups stay (the newest; nothing else is younger than 24 h).
    const tight = createFolderStore({ projectsDir: t.projectsDir, backupsDir: t.backupsDir, now: () => new Date(t.clock.now), statfs: async () => 100e9, capBytes: 0, log: { info() {}, warn() {}, error() {} } });
    await tight.prune();
    expect(backupNames(t.backupsDir)).toEqual(['2026-09-09-1200']);
    expect(fs.readdirSync(path.join(t.backupsDir, 'assets'))).toEqual([assets[4]]);
  });

  it('never prunes Backups/deleted, and keeps shared assets while a backup folder has no readable manifest', async () => {
    const t = setup({ cap: 0 });
    await t.store.writeDoc('p1', docJson('p1', 1), null);
    await t.putAsset('p1', Buffer.from('a'));
    await t.store.writeDoc('gone', docJson('gone', 1), null);
    await t.store.remove('gone');
    expect((await t.store.backup()).status).toBe('created');
    t.advance(3 * DAY);
    // A foreign folder with a backup's name but no manifest (copied in by hand, or a broken disk).
    fs.mkdirSync(path.join(t.backupsDir, '2026-01-01-0000'), { recursive: true });
    const orphan = path.join(t.backupsDir, 'assets', sha('orphan'));
    fs.writeFileSync(orphan, 'orphan');
    await t.store.writeDoc('p1', docJson('p1', 2), undefined);
    expect((await t.store.backup()).status).toBe('created');
    expect(fs.existsSync(orphan)).toBe(true); // GC skipped: the unreadable backup's assets are unknown
    expect(fs.readdirSync(path.join(t.backupsDir, 'deleted'))).toHaveLength(1);
    fs.rmSync(path.join(t.backupsDir, '2026-01-01-0000'), { recursive: true });
    await t.store.prune();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(path.join(t.backupsDir, 'deleted'))).toHaveLength(1);
  });

  it('free space (stubbed statfs): warns below 5 GB, skips the backup below 2 GB, and the mirror keeps working', async () => {
    const t = setup({ free: 3.2e9 });
    await t.store.writeDoc('p1', docJson('p1', 1), null);
    expect((await t.store.start()).status).toBe('created');
    expect(t.logs.join('\n')).toContain('warn [cpg folder] Only 3.2 GB free on this disk — backups stop below 2 GB.');
    const low = (await t.store.list()).status;
    expect(low).toMatchObject({ freeBytes: 3.2e9, level: 'low', message: 'Only 3.2 GB free on this disk — backups stop below 2 GB.' });

    t.disk.free = 1.5e9;
    t.advance(HOUR);
    await t.store.writeDoc('p1', docJson('p1', 2), undefined);
    const r = await t.store.start();
    expect(r).toMatchObject({ status: 'skipped-low-space', freeBytes: 1.5e9 });
    expect(t.logs.join('\n')).toMatch(/error \[cpg folder\] Only 1.5 GB free on this disk — backups are paused/);
    expect(backupNames(t.backupsDir)).toHaveLength(1);
    const critical = (await t.store.list()).status;
    expect(critical.level).toBe('critical');
    expect(critical.lastBackup).toMatchObject({ status: 'skipped-low-space' });
    // The mirror still saves.
    expect(await t.store.writeDoc('p1', docJson('p1', 3), undefined)).toMatchObject({ ok: true, written: true });
    expect(await t.putAsset('p1', Buffer.from('still works'))).toMatch(/^[0-9a-f]{64}$/);

    t.disk.free = 40e9;
    expect((await t.store.backup()).status).toBe('created');
    expect((await t.store.list()).status).toMatchObject({ level: 'ok', message: null });
  });

  it('a project deleted while the backup copies it: the backup completes and names only what it copied', async () => {
    const t = setup();
    await t.store.writeDoc('p1', docJson('p1', 1), null);
    const h = await t.putAsset('p1', Buffer.from('soon gone'));
    await t.store.writeDoc('p2', docJson('p2', 1), null);
    const keep = await t.putAsset('p2', Buffer.from('stays'));
    // Remove p1's asset between the scan and the copy (as a DELETE would).
    const real = fs.promises.copyFile;
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (String(src).endsWith(h)) fs.rmSync(String(src));
      return real(src, dst, mode);
    });
    let r;
    try {
      r = await t.store.backup();
    } finally {
      spy.mockRestore();
    }
    expect(r?.status).toBe('created');
    const name = backupNames(t.backupsDir)[0];
    const m = JSON.parse(fs.readFileSync(path.join(t.backupsDir, name, 'manifest.json'), 'utf8'));
    expect(m.projects.find((p: { id: string }) => p.id === 'p1').assets).toEqual([]);
    expect(m.projects.find((p: { id: string }) => p.id === 'p2').assets).toEqual([keep]);
  });

  it('shared-asset GC waits while another backup is being written', async () => {
    const t = setup({ cap: 0 });
    await t.store.writeDoc('p1', docJson('p1', 1), null);
    await t.store.backup();
    const orphan = path.join(t.backupsDir, 'assets', sha('copied by a backup in progress'));
    fs.writeFileSync(orphan, 'copied by a backup in progress');
    fs.mkdirSync(path.join(t.backupsDir, '.2026-10-01-1300.partial-abcd'));
    await t.store.prune();
    expect(fs.existsSync(orphan)).toBe(true);
    fs.rmSync(path.join(t.backupsDir, '.2026-10-01-1300.partial-abcd'), { recursive: true });
    await t.store.prune();
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('a failed backup leaves no partial folder and reports the failure', async () => {
    const t = setup();
    await t.store.writeDoc('p1', docJson('p1', 1), null);
    const h = await t.putAsset('p1', Buffer.from('x'));
    // The project lists an asset whose file vanishes under the backup (made unreadable).
    fs.chmodSync(path.join(t.projectsDir, 'p1', 'assets', h), 0o000);
    const r = await t.store.backup();
    fs.chmodSync(path.join(t.projectsDir, 'p1', 'assets', h), 0o644);
    expect(r.status).toBe('failed');
    expect(fs.readdirSync(t.backupsDir).filter((n) => n !== 'assets')).toEqual([]);
    expect((await t.store.backup()).status).toBe('created');
  });
});
