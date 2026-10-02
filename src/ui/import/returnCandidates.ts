// Track T7.4 — the projects Start → "Import from Claude Design" may hand a result to (§3.7.7). The library's
// summaries (appStore, frozen S0) give every project's id, name, last change and "waiting for Claude Design" badge:
// enough for the tag rule and the "only waiting project" rule. The seed rule needs each project's stored `qa`
// (seed part ids, `generatedAt`), which only the repository can read without opening the project; until a frozen
// reader exists (integration request in docs/tracks/t7.md) `setReturnDetailsReader` is how one is plugged in.
import type { ReturnCandidate } from '../../core/importer/returnPath';
import type { ProjectSummary } from '../../types/project';
import type { QaState } from '../../types/qa';

/** What the seed rule needs of one project, read without opening it. */
export type ReturnDetails = Pick<QaState, 'generatedAt' | 'awaiting'> & { seedPartIds?: string[] };

export type ReturnDetailsReader = (ids: readonly string[]) => Promise<Record<string, ReturnDetails | undefined>>;

let reader: ReturnDetailsReader | null = null;

/** Plugs in how other projects' `qa` is read (null: summaries only). */
export function setReturnDetailsReader(next: ReturnDetailsReader | null): void {
  reader = next;
}

/** The library's 3D projects as return candidates (summaries only). */
export function candidatesFromLibrary(library: readonly ProjectSummary[] | null, exclude?: string): ReturnCandidate[] {
  return (library ?? []).filter((s) => s.mode === '3d' && s.id !== exclude).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt, awaiting: !!s.awaitingClaudeDesign }));
}

/** The candidates with whatever the details reader knows (seed ids, prompt time); never rejects. */
export async function withDetails(list: readonly ReturnCandidate[]): Promise<ReturnCandidate[]> {
  if (!reader || list.length === 0) return [...list];
  let details: Record<string, ReturnDetails | undefined>;
  try {
    details = await reader(list.map((c) => c.id));
  } catch {
    return [...list];
  }
  return list.map((c) => {
    const d = Object.hasOwn(details, c.id) ? details[c.id] : undefined;
    if (!d) return c;
    return {
      ...c,
      awaiting: c.awaiting || !!d.awaiting,
      ...(d.awaiting?.since ? { awaitingSince: d.awaiting.since } : {}),
      ...(d.generatedAt ? { generatedAt: d.generatedAt } : {}),
      ...(d.seedPartIds ? { seedPartIds: d.seedPartIds } : {}),
    };
  });
}
