// core/persist/backups — the backup policy of §5.5.4: names, change hash, retention (newest 20 + one per day for
// 30 days, never the newest or one younger than 24 h), the size cap pruned oldest first, asset GC, free space.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_KEEP_LAST,
  GB,
  backupCapBytes,
  backupFolderName,
  changeHashText,
  compareBackupNames,
  deletedFolderName,
  formatGB,
  freeSpaceLevel,
  freeSpaceMessage,
  isBackupFolderName,
  logicalBytes,
  nextBackupFolderName,
  parseBackupFolderName,
  planRetention,
  unreferencedAssets,
  type BackupInfo,
} from '../backups';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function backup(at: Date, o: { own?: number; assets?: string[] } = {}): BackupInfo {
  return { name: backupFolderName(at), at, ownBytes: o.own ?? 1000, assets: o.assets ?? [] };
}

describe('names', () => {
  it('formats and parses YYYY-MM-DD-HHMM[-N] in local time', () => {
    const at = new Date(2026, 9, 1, 9, 5, 59);
    expect(backupFolderName(at)).toBe('2026-10-01-0905');
    expect(parseBackupFolderName('2026-10-01-0905')).toEqual(new Date(2026, 9, 1, 9, 5));
    expect(parseBackupFolderName('2026-10-01-0905-3')).toEqual(new Date(2026, 9, 1, 9, 5));
    for (const bad of ['2026-02-31-1200', '2026-10-01-2460', '2026-10-01', 'deleted', 'assets', '.2026-10-01-0905.partial-ab', '2026-10-01-0905-']) {
      expect(isBackupFolderName(bad), bad).toBe(false);
    }
    expect(nextBackupFolderName(at, [])).toBe('2026-10-01-0905');
    expect(nextBackupFolderName(at, ['2026-10-01-0905', '2026-10-01-0905-2'])).toBe('2026-10-01-0905-3');
    expect(['2026-10-01-0905-2', '2026-10-02-0000', '2026-10-01-0905', '2026-09-30-2359'].sort(compareBackupNames)).toEqual([
      '2026-09-30-2359',
      '2026-10-01-0905',
      '2026-10-01-0905-2',
      '2026-10-02-0000',
    ]);
    expect(deletedFolderName('p1', new Date(2026, 9, 1, 14, 5, 9))).toBe('p1-20261001-140509');
  });

  it('the change hash text depends on ids, doc hashes and asset NAMES only, not on order', () => {
    const a = changeHashText([
      { id: 'b', docSha256: 'd2', assets: ['y', 'x'] },
      { id: 'a', docSha256: 'd1', assets: [] },
    ]);
    const b = changeHashText([
      { id: 'a', docSha256: 'd1', assets: [] },
      { id: 'b', docSha256: 'd2', assets: ['x', 'y'] },
    ]);
    expect(a).toBe(b);
    expect(changeHashText([{ id: 'a', docSha256: 'd1', assets: [] }])).not.toBe(changeHashText([{ id: 'a', docSha256: 'd9', assets: [] }]));
    expect(changeHashText([{ id: 'a', docSha256: 'd1', assets: [] }])).not.toBe(changeHashText([{ id: 'a', docSha256: 'd1', assets: ['z'] }]));
  });
});

describe('retention', () => {
  const now = new Date(2026, 9, 1, 12, 0);

  it('keeps the newest 20 plus the newest of each day for 30 days', () => {
    // One backup every 6 hours for 60 days: 240 backups.
    const all: BackupInfo[] = [];
    for (let i = 0; i < 240; i++) all.push(backup(new Date(now.getTime() - (i * 6 + 30) * HOUR)));
    const plan = planRetention(all, { now, capBytes: Infinity, assetBytes: new Map() });
    const newest20 = [...all].slice(0, BACKUP_KEEP_LAST).map((b) => b.name);
    for (const name of newest20) expect(plan.keep).toContain(name);
    // Days within 30 days: exactly one kept per day beyond the newest 20 (the newest of that day).
    const byDay = new Map<string, string[]>();
    for (const name of plan.keep) {
      const day = name.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), name]);
    }
    for (const b of all) {
      const age = now.getTime() - b.at.getTime();
      if (newest20.includes(b.name)) continue;
      const day = b.name.slice(0, 10);
      const newestOfDay = all.filter((x) => x.name.slice(0, 10) === day).sort((x, y) => y.at.getTime() - x.at.getTime())[0];
      expect(plan.keep.includes(b.name), b.name).toBe(age <= 30 * DAY && newestOfDay.name === b.name);
    }
    expect(plan.drop.length + plan.keep.length).toBe(240);
    expect(plan.keep.length).toBeLessThan(60);
  });

  it('never deletes the newest backup or one younger than 24 h, even beyond the newest 20', () => {
    const all: BackupInfo[] = [];
    // 50 backups in the last 10 hours (routine agent restarts would make many): all are younger than 24 h.
    for (let i = 0; i < 50; i++) all.push(backup(new Date(now.getTime() - i * 12 * 60_000)));
    // And one very old one: the only backup of its day, older than 30 days.
    all.push(backup(new Date(now.getTime() - 90 * DAY)));
    const plan = planRetention(all, { now, capBytes: Infinity, assetBytes: new Map() });
    expect(plan.keep).toHaveLength(50);
    expect(plan.drop).toEqual([backupFolderName(new Date(now.getTime() - 90 * DAY))]);
    // A single old backup is the newest: kept.
    const lone = [backup(new Date(now.getTime() - 400 * DAY))];
    expect(planRetention(lone, { now, capBytes: 0, assetBytes: new Map() }).keep).toEqual([lone[0].name]);
  });

  it('applies the size cap oldest first, within the guards, counting shared assets once', () => {
    const assetBytes = new Map([
      ['a', 400],
      ['b', 400],
      ['c', 400],
      ['shared', 1000],
    ]);
    const old1 = backup(new Date(now.getTime() - 5 * DAY), { own: 100, assets: ['a', 'shared'] });
    const old2 = backup(new Date(now.getTime() - 4 * DAY), { own: 100, assets: ['b', 'shared'] });
    const old3 = backup(new Date(now.getTime() - 3 * DAY), { own: 100, assets: ['c', 'shared'] });
    const recent = backup(new Date(now.getTime() - 2 * HOUR), { own: 100, assets: ['shared'] });
    const all = [old3, recent, old1, old2];
    expect(logicalBytes(all, assetBytes)).toBe(400 + 2200);
    // Cap 1900: drop old1 (→ 2100), then old2 (→ 1600).
    const plan = planRetention(all, { now, capBytes: 1900, assetBytes });
    expect(plan.drop).toEqual([old1.name, old2.name]);
    expect(plan.keep).toEqual([old3.name, recent.name]);
    expect(plan.keptBytes).toBe(1600);
    expect(plan.overCap).toBe(false);
    // A cap no backup can meet: everything but the guarded ones goes, and the plan says it is over the cap.
    const tight = planRetention(all, { now, capBytes: 10, assetBytes });
    expect(tight.keep).toEqual([recent.name]);
    expect(tight.overCap).toBe(true);
  });

  it('asset GC deletes only shared assets no kept backup names', () => {
    const kept = [backup(now, { assets: ['a', 'b'] }), backup(new Date(now.getTime() - DAY), { assets: ['b', 'c'] })];
    expect(unreferencedAssets(['a', 'b', 'c', 'd', 'e'], kept)).toEqual(['d', 'e']);
    expect(unreferencedAssets(['a'], [])).toEqual(['a']);
  });
});

describe('cap and free space', () => {
  it('reads CPG_BACKUP_CAP_GB (default 2)', () => {
    expect(backupCapBytes(undefined)).toBe(2 * GB);
    expect(backupCapBytes('')).toBe(2 * GB);
    expect(backupCapBytes('0.5')).toBe(0.5 * GB);
    expect(backupCapBytes('-1')).toBe(2 * GB);
    expect(backupCapBytes('lots')).toBe(2 * GB);
  });

  it('warns below 5 GB and stops backups below 2 GB', () => {
    expect(freeSpaceLevel(34 * GB)).toBe('ok');
    expect(freeSpaceLevel(5 * GB)).toBe('ok');
    expect(freeSpaceLevel(5 * GB - 1)).toBe('low');
    expect(freeSpaceLevel(2 * GB)).toBe('low');
    expect(freeSpaceLevel(2 * GB - 1)).toBe('critical');
    expect(freeSpaceMessage(34 * GB)).toBeNull();
    expect(freeSpaceMessage(3.25 * GB)).toBe('Only 3.2 GB free on this disk — backups stop below 2 GB.');
    expect(freeSpaceMessage(1.5 * GB)).toMatch(/^Only 1.5 GB free on this disk — backups are paused/);
    expect(formatGB(34.9 * GB)).toBe('34 GB');
    expect(formatGB(0)).toBe('0 GB');
  });
});
