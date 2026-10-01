// Test helper: a piece end to end for the T4.2 tests — counts (T4.1) → rounds placed (§2.10.8) → folded →
// printed through T2's renderLine (docKind '3d') → validated (§2.13) — and the T4.2 golden file built from it.
import type { Issue } from '../../../../types/issues';
import type { Line } from '../../../../types/pattern';
import type { Part } from '../../../../types/model';
import { foldRounds, placePiece } from '../../place';
import { profileOf, trimProfile, type Profile } from '../../profiles';
import { roundsForPart, type PieceCounts, type RoundsForPartOptions } from '../../rounds';
import { pieceText } from '../../text3d';
import { validatePiece3d } from '../../validate3d';
import { goldenCases, part, worsted } from './goldens';

export interface BuiltPiece {
  counts: PieceCounts;
  profile: Profile | null;
  unfolded: Line[];
  lines: Line[];
  text: string[];
  issues: Issue[];
}

/** The profile `roundsForPart` worked (for W_SIZE), or null on the textbook / torus paths. */
export function workedProfile(p: Part, o: RoundsForPartOptions, c: PieceCounts): Profile | null {
  if (c.generator !== 'pathA') return null;
  let prof = profileOf(p, { axis: o.axis, start: o.start, openFar: o.openFar && o.trimAt === undefined });
  if (prof && o.trimAt !== undefined) {
    if (o.trimAt < prof.L - 1e-9) prof = trimProfile(prof, o.trimAt);
    else if (o.openFar) prof = profileOf(p, { axis: o.axis, start: o.start, openFar: true });
  }
  return prof;
}

/** The lines of a set of counts (unfolded and folded), their text and their issues. */
export function buildFromCounts(id: string, c: PieceCounts, cell: { wS: number; hS: number }, style: 'classic' | 'exact', extra: { profile?: Profile | null; textbookR?: number } = {}): BuiltPiece {
  const unfolded = placePiece({ counts: c.counts, circ: c.circ, ovalS: c.ovalS, loops: c.loops, start: c.start });
  const lines = foldRounds(unfolded);
  const text = pieceText(lines, { dialect: 'compact', terms: 'us', hand: 'right' });
  const issues = validatePiece3d({
    id,
    lines,
    unfolded,
    finish: c.finish === 'seamToStart' ? undefined : c.finish,
    counts: c,
    profile: extra.profile ?? null,
    ...(extra.textbookR !== undefined ? { textbookR: extra.textbookR } : {}),
    style,
    cell,
  });
  return { counts: c, profile: extra.profile ?? null, unfolded, lines, text, issues };
}

export function buildPiece(id: string, p: Part, o: RoundsForPartOptions): BuiltPiece {
  const c = roundsForPart(p, o);
  if (!c) throw new Error(`${id}: no counts`);
  const textbookR = c.generator === 'textbook' && (p.type === 'sphere' || p.type === 'capsule') ? p.dims.r : undefined;
  return buildFromCounts(id, c, { wS: o.wS, hS: o.hS }, o.style, { profile: workedProfile(p, o, c), ...(textbookR !== undefined ? { textbookR } : {}) });
}

/** G8: the chain oval of ch 10 (S = 7), Rnds 1–3 with circular parts 6, 12, 18 (§2.13 G8, research 07 §6.9). */
export function g8Counts(chains: number, rounds: number): PieceCounts {
  const S = chains - 3;
  const circ = Array.from({ length: rounds }, (_, i) => 6 * (i + 1));
  const ovalS = Array<number>(rounds).fill(S);
  return {
    generator: 'pathA',
    counts: circ.map((c) => c + 2 * S),
    circ,
    ovalS,
    ideal: [],
    raw: circ.slice(),
    sk: [],
    loops: Array(rounds).fill('both'),
    N: rounds,
    hEff: 0.2,
    L: rounds * 0.2,
    start: { k: 'chainOval', chains },
    closedEnd: false,
    finish: 'open',
    symmetric: false,
    dropped: 0,
    appended: 0,
  };
}

/** The teddy muzzle (fixture dims; §2.10.1: axis Z, worked from its front tip, light, 54% buried → open). */
export const MUZZLE = part('ellipsoid', { rx: 1, ry: 0.75, rz: 0.6 });

export interface TextCase {
  id: string;
  build: () => BuiltPiece;
}

export function textCases(): TextCase[] {
  const out: TextCase[] = goldenCases().map((c) => ({ id: c.id, build: () => buildPiece(c.id, c.part, c.opts) }));
  out.push({ id: 'G8-oval-ch10', build: () => buildFromCounts('G8-oval-ch10', g8Counts(10, 3), { wS: 0.2, hS: 0.2 }, 'exact') });
  const light = worsted('light');
  const L = profileOf(MUZZLE, { axis: 'z', start: 'top' })?.L as number;
  for (const style of ['classic', 'exact'] as const) {
    out.push({ id: `teddy-muzzle-${style}-closed`, build: () => buildPiece('muzzle', MUZZLE, { ...light, style, axis: 'z', start: 'top' }) });
    out.push({ id: `teddy-muzzle-${style}-trimmed-46pct`, build: () => buildPiece('muzzle', MUZZLE, { ...light, style, axis: 'z', start: 'top', trimAt: 0.46 * L }) });
  }
  return out;
}

const issueKey = (i: Issue) => `${i.code}${i.where?.line !== undefined ? `@${i.where.line}` : ''}`;

export function generateTextGoldens(): Record<string, { text: string[]; issues: string[] }> {
  const file: Record<string, { text: string[]; issues: string[] }> = {};
  for (const c of textCases()) {
    const b = c.build();
    file[c.id] = { text: b.text, issues: b.issues.map(issueKey) };
  }
  return file;
}

export const stringifyTextGoldens = (f: ReturnType<typeof generateTextGoldens>) => JSON.stringify(f, null, 2) + '\n';
