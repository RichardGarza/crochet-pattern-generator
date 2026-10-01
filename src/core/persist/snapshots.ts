// Track T8 — snapshot policy (DESIGN.md §5.5.2): when an autosave also writes a snapshot, and which snapshots
// are kept. Pure functions; the repository applies them inside its save transaction.
//
//   - a snapshot every 20 revs or 5 minutes (and always before migrations, imports, take-overs and the other
//     operations that call `repo.snapshot`);
//   - keep the last 30, plus the newest one of each day for 30 days.

export const SNAPSHOT_EVERY_REVS = 20;
export const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
export const KEEP_LAST = 30;
export const KEEP_DAILY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SnapshotInfo {
  rev: number;
  at: string;
}

/** True when a save at `rev` should also write a snapshot, given the newest existing one (or none). */
export function snapshotDue(newest: SnapshotInfo | undefined, rev: number, now: Date): boolean {
  if (!newest) return true;
  if (rev - newest.rev >= SNAPSHOT_EVERY_REVS) return true;
  const at = Date.parse(newest.at);
  return !Number.isFinite(at) || now.getTime() - at >= SNAPSHOT_EVERY_MS;
}

/** The local calendar day of an ISO time (`YYYY-MM-DD`), or null for a malformed time. */
function dayOf(iso: string): string | null {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/**
 * The revs to keep: the `KEEP_LAST` highest revs, plus the newest snapshot of every day of the last
 * `KEEP_DAILY_DAYS` days. A snapshot with a malformed time is kept (it cannot be judged, and keeping one
 * costs little).
 */
export function revsToKeep(snapshots: readonly SnapshotInfo[], now: Date): Set<number> {
  const keep = new Set<number>();
  const byRev = [...snapshots].sort((a, b) => b.rev - a.rev);
  for (const s of byRev.slice(0, KEEP_LAST)) keep.add(s.rev);
  const newestOfDay = new Map<string, SnapshotInfo>();
  for (const s of byRev) {
    const at = Date.parse(s.at);
    const day = dayOf(s.at);
    if (!Number.isFinite(at) || day === null) {
      keep.add(s.rev);
      continue;
    }
    if (now.getTime() - at > KEEP_DAILY_DAYS * DAY_MS) continue;
    const best = newestOfDay.get(day);
    if (!best || at > Date.parse(best.at) || (at === Date.parse(best.at) && s.rev > best.rev)) newestOfDay.set(day, s);
  }
  for (const s of newestOfDay.values()) keep.add(s.rev);
  return keep;
}
