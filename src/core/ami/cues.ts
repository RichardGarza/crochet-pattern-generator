// Track T4 — cues inside a piece (DESIGN.md §2.10.6), printed after the named round in this order:
//   0. the front marker (pieces that host eyes, features, patches or other pieces), after the reference round;
//   1. safety eyes, after round rA + 1 when the eyes go between Rnds rA and rA + 1;
//   2. stuffing (closed pieces): "Begin stuffing after Rnd {s}; stuff firmly as you go" with
//      s = max(first decrease round + 1, rA + 1) (firm/medium) — but never the closing round itself: a piece that
//      decreases only in its last two rounds is stuffed after the first of them —, "Stuff lightly before
//      closing" (light);
//   3. the closing round and its finish.
// E_EYE_ORDER (validate3d) checks that every eye cue precedes the stuffing cue and the closing round.
import type { Cue, Line } from '../../types/pattern';

/** Where a piece's seam lies, for the words of a cue: center back, or the underside (−Y, §2.10.2). */
export type SeamAt = 'back' | 'bottom';

/** "center front" for a piece whose seam is at center back; "the center top" for one whose seam is underneath. */
export function frontWords(seamAt: SeamAt): string {
  return seamAt === 'back' ? 'center front' : 'the center top';
}

/** "the marker at center back" / "the marker underneath". */
export function markerWords(seamAt: SeamAt): string {
  return seamAt === 'back' ? 'the marker at center back' : 'the marker underneath';
}

/**
 * Cue 0: "Place a second marker at center front, between sts {n/2} and {n/2 + 1} of Rnd {r_ref}, and leave it there;
 * later steps measure from it." (an odd round: "in st {(n+1)/2}").
 */
export function frontMarkerCue(n: number, rRef: number, seamAt: SeamAt): Cue {
  const where = n % 2 === 0 ? `between sts ${n / 2} and ${n / 2 + 1}` : `in st ${(n + 1) / 2}`;
  return { kind: 'note', text: `Place a second marker at ${frontWords(seamAt)}, ${where} of Rnd ${rRef}, and leave it there; later steps measure from it.` };
}

/**
 * Cue 1: "Insert the 10 mm safety eyes between Rnds 10 and 11: posts in the gaps after st 15 and after st 21 (6 sts
 * between, centered between sts 18 and 19). Fix the washers now." `gaps` are "after st g" numbers of round rA + 1.
 */
export function eyeCue(o: { sizeMm: number; rA: number; gaps: number[]; n: number; count?: number }): Cue {
  const gaps = [...o.gaps].sort((a, b) => a - b);
  const what = o.count === 1 ? `the ${o.sizeMm} mm safety eye` : `the ${o.sizeMm} mm safety eyes`;
  let text: string;
  if (gaps.length >= 2) {
    const [g1, g2] = [gaps[0], gaps[gaps.length - 1]];
    const between = g2 - g1;
    const mid2 = g1 + g2;
    const center = mid2 % 2 === 0 ? `centered between sts ${mid2 / 2} and ${mid2 / 2 + 1 > o.n ? 1 : mid2 / 2 + 1}` : `centered on st ${(mid2 + 1) / 2}`;
    text = `Insert ${what} between Rnds ${o.rA} and ${o.rA + 1}: posts in the gaps after st ${g1} and after st ${g2} (${between} sts between, ${center}). Fix the washers now.`;
  } else {
    text = `Insert ${what} between Rnds ${o.rA} and ${o.rA + 1}: post in the gap after st ${gaps[0]}. Fix the washer now.`;
  }
  return { kind: 'eyes', text };
}

/** Cue 2 for firm or medium stuffing. */
export function stuffFirmCue(s: number): Cue {
  return { kind: 'stuff', text: `Begin stuffing after Rnd ${s}; stuff firmly as you go.` };
}

/** Cue 2 for light stuffing. */
export function stuffLightCue(): Cue {
  return { kind: 'stuff', text: 'Stuff lightly before closing.' };
}

/** The first round (1-based) that decreases (a stated count below the round before), or 0. */
export function firstDecreaseRound(lines: readonly Line[]): number {
  for (const l of lines) if (l.prevCount !== null && l.stated < l.prevCount) return l.n;
  return 0;
}

/**
 * Where the stuffing cue goes (closed pieces): firm/medium `max(first decrease round + 1, rA + 1)` (rA + 1 = the
 * eye round, 0 without eyes), light: the round before the closing round (and not before the eyes); clamped to the
 * piece. `null` for `none`.
 */
export function stuffingRound(lines: readonly Line[], stuffing: 'firm' | 'medium' | 'light' | 'none', eyeRound: number): number | null {
  const last = lines.length;
  if (stuffing === 'none' || last === 0) return null;
  if (stuffing === 'light') return Math.min(last, Math.max(last - 1, eyeRound, 1));
  const dec = firstDecreaseRound(lines);
  // at least one round is worked after the stuffing starts (a small piece that decreases only in its last two
  // rounds is stuffed after its first decrease round), and never before the eyes
  const s = Math.min(Math.max(dec > 0 ? dec + 1 : last - 1, 1), Math.max(1, last - 1));
  return Math.min(last, Math.max(s, eyeRound));
}

/** Add a cue to a line, keeping the §2.10.6 order (front marker, eyes, stuffing, then anything else). */
export function addCue(line: Line, cue: Cue): void {
  const rank = (c: Cue) => (c.kind === 'note' && c.text.startsWith('Place a second marker') ? 0 : c.kind === 'eyes' ? 1 : c.kind === 'stuff' ? 2 : c.kind === 'color' ? -1 : 3);
  const cues = [...(line.cues ?? []), cue];
  cues.sort((a, b) => rank(a) - rank(b));
  line.cues = cues;
}
