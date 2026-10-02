// Track T7 — which project a result imported from Start → "Import from Claude Design" belongs to (DESIGN.md §3.7.7,
// "Which project receives the result"). Pure: the caller lists the projects it knows.
//
//   1. the result's `x-cpg.project` (`ImportResult.cpgTag`) names a project of the library ⇒ offered pre-selected;
//   2. otherwise, among projects waiting for a result or that produced a prompt in the last 30 days, the one whose
//      stored seed has ≥ 60% of its part ids in the result (the highest share; ties → the most recent) ⇒ offered
//      pre-selected;
//   3. otherwise, when exactly one project is waiting, it is offered, NOT pre-selected.
// "New project" is always offered by the caller. At most one project is offered.
import type { ImportResult } from '../../types/importer';

/** "≥ 60% of its part ids" (§3.7.7). */
export const RETURN_SEED_SHARE = 0.6;
/** "produced a prompt in the last 30 days" (§3.7.7). */
export const RETURN_PROMPT_DAYS = 30;

export interface ReturnCandidate {
  id: string;
  name: string;
  /** Last change (ISO): the tie-break when nothing more recent is known. */
  updatedAt: string;
  /** `qa.awaiting` is set. */
  awaiting: boolean;
  /** `qa.awaiting.since` (ISO), when known. */
  awaitingSince?: string;
  /** `qa.generatedAt` (ISO), when known. */
  generatedAt?: string;
  /** The part ids of `qa.seed`, when the project's seed could be read. */
  seedPartIds?: readonly string[];
}

export interface ReturnOffer {
  id: string;
  name: string;
  /** Why it is offered: the tag, the seed's part ids, or the only project that waits. */
  reason: 'tag' | 'seed-ids' | 'only-waiting';
  /** Pre-selected in the "Import into" choice (rules 1 and 2). */
  preselected: boolean;
  /** Rule 2: the share of the seed's part ids found in the result (0–1). */
  share?: number;
}

const time = (iso: string | undefined): number => {
  const t = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
};

/** The share (0–1) of `seedIds` present in `resultIds`; 0 for an empty seed. Duplicates count once. */
export function seedShare(seedIds: readonly string[], resultIds: ReadonlySet<string>): number {
  const seed = new Set(seedIds);
  if (seed.size === 0) return 0;
  let hit = 0;
  for (const id of seed) if (resultIds.has(id)) hit++;
  return hit / seed.size;
}

/**
 * §3.7.7: the project a returning result is offered to, or null. `exclude` is the project the import runs in (a
 * fresh project made by the Start card: it is "New project", never an offer).
 */
export function matchReturnProject(
  result: Pick<ImportResult, 'ok' | 'model' | 'cpgTag'>,
  candidates: readonly ReturnCandidate[],
  o: { now: Date; exclude?: string } = { now: new Date() },
): ReturnOffer | null {
  if (!result.ok || !result.model) return null;
  const list = candidates.filter((c) => c.id !== o.exclude);
  // 1. the tag
  const tagged = result.cpgTag?.project;
  if (typeof tagged === 'string') {
    const hit = list.find((c) => c.id === tagged);
    if (hit) return { id: hit.id, name: hit.name, reason: 'tag', preselected: true };
  }
  // 2. the seed's part ids
  const ids = new Set(result.model.parts.map((p) => p.id));
  const since = o.now.getTime() - RETURN_PROMPT_DAYS * 86_400_000;
  let best: { c: ReturnCandidate; share: number; at: number } | null = null;
  for (const c of list) {
    const recent = time(c.generatedAt) >= since;
    if (!c.awaiting && !recent) continue;
    if (!c.seedPartIds || c.seedPartIds.length === 0) continue;
    const share = seedShare(c.seedPartIds, ids);
    if (share < RETURN_SEED_SHARE) continue;
    const at = Math.max(time(c.generatedAt), time(c.awaitingSince), time(c.updatedAt));
    // the highest share; equal shares → the most recent; then the id (deterministic)
    const better = !best || share > best.share || (share === best.share && (at > best.at || (at === best.at && c.id < best.c.id)));
    if (better) best = { c, share, at };
  }
  if (best) return { id: best.c.id, name: best.c.name, reason: 'seed-ids', preselected: true, share: best.share };
  // 3. the only project that waits
  const waiting = list.filter((c) => c.awaiting);
  if (waiting.length === 1) return { id: waiting[0].id, name: waiting[0].name, reason: 'only-waiting', preselected: false };
  return null;
}
