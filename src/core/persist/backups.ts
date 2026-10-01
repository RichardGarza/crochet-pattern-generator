// Track T8 — the backup policy of the folder mirror (DESIGN.md §5.5.4 "Backups"): names, the change hash, which
// backups are kept (newest 20 + newest of each day for 30 days, never the newest one or one younger than 24 h,
// then a size cap pruned oldest first) and the free-space thresholds.
//
// Pure functions with no Node or DOM API: `scripts/project-folder.ts` (the Vite plugin) does the file work and
// calls these, and the unit tests drive them with plain data. Sizes are bytes; "GB" means 10^9 bytes, as the
// Finder counts them.
//
// Layout (next to the projects folder, `<parent>/Backups/`):
//   Backups/assets/<sha256>                       shared, content-addressed, written once (an APFS clone)
//   Backups/YYYY-MM-DD-HHMM[-N]/manifest.json     { hash, at, projects: [{ id, docSha256, assets, … }] }
//   Backups/YYYY-MM-DD-HHMM[-N]/projects/<id>/project.json
//   Backups/deleted/<id>-YYYYMMDD-HHMMSS/         projects deleted from the folder (never pruned)

export const GB = 1e9;
/** Retention: the newest backups always kept (§5.5.4). */
export const BACKUP_KEEP_LAST = 20;
/** Retention: the newest backup of each local day is kept for this many days. */
export const BACKUP_KEEP_DAILY_DAYS = 30;
/** Never delete a backup younger than this (routine restarts cannot rotate out real backups). */
export const BACKUP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** `CPG_BACKUP_CAP_GB` default: the logical size of `Backups/` (docs + shared assets). */
export const DEFAULT_BACKUP_CAP_GB = 2;
/** Below this much free space the console and the app warn. */
export const FREE_WARN_BYTES = 5 * GB;
/** Below this much free space backups are skipped (the mirror keeps working). */
export const FREE_STOP_BYTES = 2 * GB;

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `YYYY-MM-DD-HHMM` in local time: the folder name of a backup made at `at`. */
export function backupFolderName(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

const BACKUP_NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d{1,4}))?$/;

/** True for a backup folder name (`YYYY-MM-DD-HHMM`, optionally `-N` for a second backup in the same minute). */
export const isBackupFolderName = (name: string): boolean => parseBackupFolderName(name) !== null;

/** The local time a backup folder name stands for, or null when it is not one. */
export function parseBackupFolderName(name: string): Date | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const at = new Date(y, mo - 1, d, h, mi);
  // Reject impossible dates (2026-02-31 would roll over into March).
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return null;
  return at;
}

/** Orders backup folder names oldest first (the same minute: no suffix, then -2, -3, …). */
export function compareBackupNames(a: string, b: string): number {
  const ta = parseBackupFolderName(a)?.getTime() ?? 0;
  const tb = parseBackupFolderName(b)?.getTime() ?? 0;
  if (ta !== tb) return ta - tb;
  const sa = Number(BACKUP_NAME.exec(a)?.[6] ?? 1);
  const sb = Number(BACKUP_NAME.exec(b)?.[6] ?? 1);
  return sa - sb || (a < b ? -1 : a > b ? 1 : 0);
}

/** The first free folder name for a backup at `at`, given the names that exist. */
export function nextBackupFolderName(at: Date, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = backupFolderName(at);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `<id>-YYYYMMDD-HHMMSS`: where `DELETE /__projects/<id>` moves a project (`Backups/deleted/`). */
export function deletedFolderName(id: string, at: Date): string {
  return `${id}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** One project as the change hash and the manifest see it. */
export interface BackupProjectEntry {
  id: string;
  docSha256: string;
  /** The asset file names (sha256) in the project's `assets/` folder. */
  assets: readonly string[];
}

/**
 * The text whose sha256 is the change hash (§5.5.4): the sorted (project id, doc sha256, sorted asset names).
 * Asset bytes are never read — their names are their hashes — so the check stays fast for large projects.
 */
export function changeHashText(projects: readonly BackupProjectEntry[]): string {
  const rows = projects
    .map((p) => [p.id, p.docSha256, [...p.assets].sort()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(rows);
}

/** What retention needs to know of one backup. */
export interface BackupInfo {
  name: string;
  at: Date;
  /** Bytes of its own files (manifest and project docs). */
  ownBytes: number;
  /** The shared assets it names. */
  assets: readonly string[];
}

export interface RetentionOptions {
  now: Date;
  /** Logical size cap of `Backups/` (docs + shared assets); Infinity = none. */
  capBytes: number;
  /** Size of each shared asset (missing = 0). */
  assetBytes: ReadonlyMap<string, number>;
  keepLast?: number;
  keepDailyDays?: number;
  minAgeMs?: number;
}

export interface RetentionPlan {
  /** Backup names to keep, oldest first. */
  keep: string[];
  /** Backup names to delete, oldest first. */
  drop: string[];
  /** Logical size of the kept backups. */
  keptBytes: number;
  /** True when the guards kept the size above the cap. */
  overCap: boolean;
}

/** The local calendar day of a time. */
const dayKey = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** Logical size of a set of backups: their own files plus every shared asset they name, once. */
export function logicalBytes(backups: readonly BackupInfo[], assetBytes: ReadonlyMap<string, number>): number {
  const assets = new Set<string>();
  let total = 0;
  for (const b of backups) {
    total += b.ownBytes;
    for (const a of b.assets) assets.add(a);
  }
  for (const a of assets) total += assetBytes.get(a) ?? 0;
  return total;
}

/**
 * Retention (§5.5.4): keep the newest `keepLast`, plus the newest backup of each local day for `keepDailyDays`;
 * the newest backup and every backup younger than `minAgeMs` are never deleted. Then, while the logical size
 * is above the cap, the oldest backup the guards allow goes — even one the first rule kept.
 */
export function planRetention(backups: readonly BackupInfo[], o: RetentionOptions): RetentionPlan {
  const keepLast = o.keepLast ?? BACKUP_KEEP_LAST;
  const keepDailyDays = o.keepDailyDays ?? BACKUP_KEEP_DAILY_DAYS;
  const minAgeMs = o.minAgeMs ?? BACKUP_MIN_AGE_MS;
  const sorted = [...backups].sort((a, b) => compareBackupNames(a.name, b.name));
  const newestFirst = [...sorted].reverse();
  const now = o.now.getTime();

  const guarded = new Set<string>();
  if (newestFirst[0]) guarded.add(newestFirst[0].name);
  for (const b of sorted) if (now - b.at.getTime() < minAgeMs) guarded.add(b.name);

  const keep = new Set<string>(guarded);
  for (const b of newestFirst.slice(0, keepLast)) keep.add(b.name);
  const seenDays = new Set<string>();
  for (const b of newestFirst) {
    if (now - b.at.getTime() > keepDailyDays * DAY_MS) continue;
    const day = dayKey(b.at);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    keep.add(b.name);
  }

  let kept = sorted.filter((b) => keep.has(b.name));
  let size = logicalBytes(kept, o.assetBytes);
  // The size cap, oldest first within the guards.
  for (const b of sorted) {
    if (size <= o.capBytes) break;
    if (!keep.has(b.name) || guarded.has(b.name)) continue;
    keep.delete(b.name);
    kept = kept.filter((k) => k.name !== b.name);
    size = logicalBytes(kept, o.assetBytes);
  }
  return {
    keep: sorted.filter((b) => keep.has(b.name)).map((b) => b.name),
    drop: sorted.filter((b) => !keep.has(b.name)).map((b) => b.name),
    keptBytes: size,
    overCap: size > o.capBytes,
  };
}

/** The shared assets no kept backup names (deleted after retention). */
export function unreferencedAssets(stored: Iterable<string>, kept: readonly BackupInfo[]): string[] {
  const named = new Set<string>();
  for (const b of kept) for (const a of b.assets) named.add(a);
  return [...stored].filter((a) => !named.has(a)).sort();
}

/** `CPG_BACKUP_CAP_GB` → bytes (default 2 GB; an invalid value falls back to the default). */
export function backupCapBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BACKUP_CAP_GB * GB;
  const gb = Number(value);
  return Number.isFinite(gb) && gb > 0 ? gb * GB : DEFAULT_BACKUP_CAP_GB * GB;
}

export type FreeSpaceLevel = 'ok' | 'low' | 'critical';

/** `ok` (≥ 5 GB), `low` (warn), `critical` (< 2 GB: backups stop). */
export function freeSpaceLevel(freeBytes: number): FreeSpaceLevel {
  if (freeBytes < FREE_STOP_BYTES) return 'critical';
  if (freeBytes < FREE_WARN_BYTES) return 'low';
  return 'ok';
}

/** "3.2 GB", "2 GB", "41 GB" (rounded down: one decimal below 10 GB, none above). */
export function formatGB(bytes: number): string {
  const gb = Math.max(0, bytes) / GB;
  const shown = gb < 10 ? Math.floor(gb * 10 + 1e-9) / 10 : Math.floor(gb);
  return `${Number.isInteger(shown) ? String(shown) : shown.toFixed(1)} GB`;
}

/** The warning for a free-space level, or null when there is plenty. */
export function freeSpaceMessage(freeBytes: number): string | null {
  switch (freeSpaceLevel(freeBytes)) {
    case 'ok':
      return null;
    case 'low':
      return `Only ${formatGB(freeBytes)} free on this disk — backups stop below ${formatGB(FREE_STOP_BYTES)}.`;
    case 'critical':
      return `Only ${formatGB(freeBytes)} free on this disk — backups are paused until more than ${formatGB(FREE_STOP_BYTES)} is free. Projects are still saved and copied to the folder.`;
  }
}
