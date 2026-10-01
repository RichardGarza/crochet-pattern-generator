// Track T4 — placing increases and decreases (DESIGN.md §2.10.8, normative), BLO/FLO rounds and the jogless prep
// (§2.10.5), oval rounds placed per segment (§2.10.2, §2.10.6), and folding identical plain rounds (§2.13 E_FOLD).
//
// ```
// P → T in one round:  d = |T − P|
//   increase: inc3 sites n3 = max(0, d − P), inc sites = d − 2·n3, sites k = d − n3, plain = P − k
//   decrease: dec3 sites k3 = max(0, P − 2T), dec sites = d − 2·k3,  sites k = d − k3, plain = T − k
//   specials ordered by even interleave (inc3/dec3 spread among inc/dec)
// g = floor(plain / k), r = plain mod k
// base ops = [(g+1) sc, special] × r  ++  [g sc, special] × (k − r)
// changeIdx = 0 for the piece's first round with changes, +1 for each later round with changes
// changeIdx even ⇒ rotate base left by ceil(g/2) ops;  odd ⇒ no rotation
// ```
//
// Two overrides of the rotation choose the smallest extra left rotation that still satisfies R8 against the
// previous change round: the round before a BLO/FLO round must END with a plain sc (jogless prep: that sc becomes a
// sl st), and a shaped round of a joined-round section must START with a plain sc (§2.11.3). When no rotation
// qualifies the default stays; the jogless prep is then skipped and the round gets the jog note (W_JOG).
//
// Ovals. A round of an oval piece is a cycle of four arcs — end, side, end, side — and the round starts inside
// one of them (`OvalLayout`). The circular changes go into the two end arcs, the side change (|ΔS| ≤ 1) at the
// middle of each side; the §2.10.8 rule and its rotation act inside one arc. The arc that holds the start of the
// round is printed as two segments (its first stitches open the round, the rest close it), so a chain-oval piece
// prints `end | side | end | side | end` (G8: `inc, 7 sc, 3 inc, 7 sc, 2 inc`).
import type { Line, LineStart, Loop, Op } from '../../types/pattern';
import { CONS, consumed, opName, produced } from '../pattern/ops';

const sc = (): Op => ({ k: 'st', st: 'sc' });

/** An increase or decrease (inc, inc3, dec, dec3): a "change site" of §2.10.8 and §2.13 R7/R8. */
export function isSpecial(op: Op): boolean {
  return op.k === 'inc' || op.k === 'dec';
}

/** A plain single crochet in both loops (any color): what the jogless and joined-round overrides look for. */
export function isPlainSc(op: Op): boolean {
  return op.k === 'st' && op.st === 'sc' && op.into === undefined && (op.loop === undefined || op.loop === 'both');
}

/** `ops` rotated left by `m` ops (m taken modulo the length). Returns a new array. */
export function rotateLeft<T>(ops: readonly T[], m: number): T[] {
  const n = ops.length;
  if (n === 0) return [];
  const s = ((m % n) + n) % n;
  return [...ops.slice(s), ...ops.slice(0, s)];
}

// ---------------------------------------------------------------------------------------------------------------
// §2.10.8 base placement

export interface BasePlacement {
  /** The unrotated base ops. */
  base: Op[];
  /** Change sites (specials). 0 for a plain round. */
  k: number;
  /** Plain stitches per gap (`floor(plain / k)`); for a plain round, the number of stitches. */
  g: number;
  /** Gaps with g + 1 stitches. */
  r: number;
  /** inc3 / dec3 sites among the k. */
  big: number;
}

/** Can P stitches become T in one round (with inc3 / dec3)? P = 0 only makes 0. */
export function feasibleChange(P: number, T: number): boolean {
  if (P === 0) return T === 0;
  return T <= 3 * P && 3 * T >= P && T >= 1;
}

/**
 * The §2.10.8 base layout of one round from P to T stitches. Throws `RangeError` when even inc3 / dec3 cannot
 * reach T (T > 3P or T < P/3; E_INC_INFEASIBLE / E_DEC_INFEASIBLE).
 */
export function basePlacement(P: number, T: number): BasePlacement {
  if (!(Number.isInteger(P) && Number.isInteger(T) && P >= 0 && T >= 0)) throw new RangeError(`basePlacement: counts must be whole numbers ≥ 0, got ${P} → ${T}`);
  if (T === P) return { base: Array.from({ length: P }, sc), k: 0, g: P, r: 0, big: 0 };
  const growing = T > P;
  const d = Math.abs(T - P);
  const big = growing ? Math.max(0, d - P) : Math.max(0, P - 2 * T);
  const small = d - 2 * big;
  const k = d - big;
  const plain = growing ? P - k : T - k;
  if (P === 0 || small < 0 || plain < 0 || k <= 0) throw new RangeError(`basePlacement: ${P} → ${T} sts is not possible in one round, even with ${growing ? 'inc3' : 'dec3'}`);
  const g = Math.floor(plain / k);
  const r = plain % k;
  const base: Op[] = [];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < (j < r ? g + 1 : g); i++) base.push(sc());
    // even interleave: site j is an inc3/dec3 when ⌊(j+1)·big/k⌋ steps up
    const isBig = Math.floor(((j + 1) * big) / k) - Math.floor((j * big) / k) === 1;
    base.push({ k: growing ? 'inc' : 'dec', n: isBig ? 3 : 2 });
  }
  return { base, k, g, r, big };
}

/** The default rotation of §2.10.8: ceil(g/2) ops when changeIdx is even, else 0 (0 for a plain round). */
export function defaultRotation(b: BasePlacement, changeIdx: number): number {
  if (b.k === 0 || changeIdx % 2 !== 0) return 0;
  return Math.ceil(b.g / 2);
}

// ---------------------------------------------------------------------------------------------------------------
// R7 / R8 metrics (shared with validate3d)

export interface ChangeSites {
  /** Stitches consumed. */
  P: number;
  /** Specials. */
  k: number;
  /** floor(plain ops / k); the number of ops when k = 0. */
  g: number;
  /** Site centers as fractions of the round: (stitches consumed before it + CONS/2) / P. */
  centers: number[];
}

/** The change sites of a list of ops (a whole round, or one oval segment), §2.13 R8. */
export function changeSites(ops: readonly Op[]): ChangeSites {
  const P = consumed(ops);
  const centers: number[] = [];
  let before = 0;
  let plain = 0;
  for (const op of ops) {
    const c = CONS[opName(op)];
    if (isSpecial(op)) centers.push(P > 0 ? (before + c / 2) / P : 0);
    else plain++;
    before += c;
  }
  const k = centers.length;
  return { P, k, g: k > 0 ? Math.floor(plain / k) : plain, centers };
}

/** R8's scope: equal k and g ≥ 1 in both (rounds made only of specials have g = 0 and are exempt). */
export function r8InScope(a: ChangeSites, b: ChangeSites): boolean {
  return a.k > 0 && a.k === b.k && a.g >= 1 && b.g >= 1;
}

/** The smallest circular distance (fraction of a round) between a site of `a` and a site of `b`. */
export function minCircularOffset(a: readonly number[], b: readonly number[]): number {
  let best = Infinity;
  for (const x of a) {
    for (const y of b) {
      const d = Math.abs(x - y) % 1;
      best = Math.min(best, d, 1 - d);
    }
  }
  return best;
}

/** R8 (W_STAGGER) holds between a change round and the change round before it. */
export function r8Ok(prev: ChangeSites | undefined, cur: ChangeSites): boolean {
  if (!prev || !r8InScope(prev, cur)) return true;
  return minCircularOffset(prev.centers, cur.centers) >= 1 / (4 * cur.k) - 1e-9;
}

/** W_STACKED's pair test: in R8's scope, both g ≥ 3, and some site within 1/P of a site of the previous round. */
export function stackedPair(prev: ChangeSites, cur: ChangeSites): boolean {
  if (!r8InScope(prev, cur) || prev.g < 3 || cur.g < 3) return false;
  return minCircularOffset(prev.centers, cur.centers) <= 1 / cur.P + 1e-9;
}

// ---------------------------------------------------------------------------------------------------------------
// One circular round

export interface RoundOverrides {
  /** The round before a BLO/FLO round: end with a plain sc (§2.10.5 jogless prep). */
  endPlain?: boolean;
  /** A shaped round in a joined-round section: start with a plain sc (§2.11.3). */
  startPlain?: boolean;
  /** The previous change round, for R8. */
  prevChange?: ChangeSites;
}

export interface PlacedRound {
  ops: Op[];
  base: BasePlacement;
  /** Left rotation applied to the base (default + override). */
  rotation: number;
  /** An override was asked for and no rotation satisfied it (the default stays). */
  overrideFailed: boolean;
}

/**
 * One circular round from P to T stitches (§2.10.8) with the default rotation for `changeIdx`, then the
 * overrides: the smallest extra left rotation m ≥ 1 whose result ends (or starts) with a plain sc and still
 * satisfies R8 against `prevChange`.
 */
export function placeCircular(P: number, T: number, changeIdx: number, o: RoundOverrides = {}): PlacedRound {
  const base = basePlacement(P, T);
  const rot = defaultRotation(base, changeIdx);
  const ops = rotateLeft(base.base, rot);
  const asked = o.endPlain === true || o.startPlain === true;
  const want = (x: readonly Op[]) =>
    x.length > 0 && (!o.endPlain || isPlainSc(x[x.length - 1])) && (!o.startPlain || isPlainSc(x[0]));
  // R8 against the previous change round; out of R8's scope (unequal k, g = 0, no previous round) it always holds
  const r8 = (x: readonly Op[]) => base.k === 0 || r8Ok(o.prevChange, changeSites(x));
  const defaultR8 = r8(ops);
  if ((!asked || want(ops)) && defaultR8) return { ops, base, rotation: rot, overrideFailed: false };
  // the overrides: the smallest extra left rotation that satisfies everything asked for and R8 (v1.5 third
  // override: a change round in R8's scope whose default rotation violates R8)
  for (let m = 1; m < ops.length; m++) {
    const cand = rotateLeft(ops, m);
    if ((!asked || want(cand)) && r8(cand)) return { ops: cand, base, rotation: (rot + m) % ops.length, overrideFailed: false };
  }
  // nothing satisfies both: a jogless / joined-round request keeps its own fallback (the jog note, "inc in same st
  // as join"), but the round is still staggered when some rotation can do that (else the default and W_STAGGER)
  if (!defaultR8 && !(asked && want(ops))) {
    for (let m = 1; m < ops.length; m++) {
      const cand = rotateLeft(ops, m);
      if (r8(cand)) return { ops: cand, base, rotation: (rot + m) % ops.length, overrideFailed: asked && !want(cand) };
    }
  }
  return { ops, base, rotation: rot, overrideFailed: asked && !want(ops) };
}

// ---------------------------------------------------------------------------------------------------------------
// Ovals

export interface OvalArc {
  kind: 'end' | 'side';
  /** Stitches of the round in this arc. */
  n: number;
}

/**
 * Where the stitches of one oval round lie: the four arcs in working order (end, side, end, side, starting with
 * the arc that holds the round's first stitch), and `tail` = how many stitches of `arcs[0]` are worked at the END
 * of the round (they come first along the arc; the other `n − tail` open the round).
 */
export interface OvalLayout {
  arcs: OvalArc[];
  tail: number;
}

/**
 * Layout of round 1: a chain oval with side S (`(S+1) sc, inc3, S sc, inc`: 1 st of end A, S, 3 sts of end B,
 * S, 2 sts of end A) or a 6-st magic ring of an oval piece (S = 0), laid out alike.
 */
export function firstOvalLayout(S1: number): OvalLayout {
  return { arcs: [{ kind: 'end', n: 3 }, { kind: 'side', n: S1 }, { kind: 'end', n: 3 }, { kind: 'side', n: S1 }], tail: 2 };
}

/** The arc holding the round's first stitch always has at least one stitch there (`n − tail ≥ 1`). */
function normalizeLayout(l: OvalLayout): OvalLayout {
  let arcs = l.arcs.map((a) => ({ ...a }));
  let tail = l.tail;
  if (!arcs.some((a) => a.n > 0)) return { arcs, tail: 0 };
  let guard = 0;
  while (arcs[0].n - tail <= 0 && guard++ < arcs.length + 1) {
    // arcs[0] lies wholly at the end of the round: the round starts with the next arc
    arcs = rotateLeft(arcs, 1);
    tail = 0;
  }
  return { arcs, tail };
}

/** Sides of a layout (their common S; the first side when they differ). */
export function layoutS(l: OvalLayout): number {
  return l.arcs.find((a) => a.kind === 'side')?.n ?? 0;
}

/** Circular part of a layout: the stitches of its two end arcs. */
export function layoutCirc(l: OvalLayout): number {
  return l.arcs.filter((a) => a.kind === 'end').reduce((s, a) => s + a.n, 0);
}

/** The side change at the middle of a side: `m sc, inc, rest` / `m sc, dec, rest`. */
function sidePlacement(P: number, T: number, changeIdx: number): Op[] {
  if (T === P) return Array.from({ length: P }, sc);
  if (T === P + 1 && P >= 1) {
    const m = Math.floor((P - 1) / 2);
    return [...Array.from({ length: m }, sc), { k: 'inc', n: 2 }, ...Array.from({ length: P - 1 - m }, sc)];
  }
  if (T === P - 1 && P >= 2) {
    const m = Math.floor((P - 2) / 2);
    return [...Array.from({ length: m }, sc), { k: 'dec', n: 2 }, ...Array.from({ length: P - 2 - m }, sc)];
  }
  return placeCircular(P, T, changeIdx).ops;
}

/** Index i such that `ops.slice(0, i)` consumes exactly `c` stitches, or −1. */
function cutAt(ops: readonly Op[], c: number): number {
  let used = 0;
  for (let i = 0; i <= ops.length; i++) {
    if (used === c) return i;
    if (i === ops.length || used > c) return -1;
    used += CONS[opName(ops[i])];
  }
  return -1;
}

/** Split T between two parts of P1 and P2 stitches, as close to proportional as feasible. */
function splitTarget(P1: number, P2: number, T: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  const want = P1 + P2 > 0 ? (T * P1) / (P1 + P2) : 0;
  for (let t1 = 0; t1 <= T; t1++) {
    if (!feasibleChange(P1, t1) || !feasibleChange(P2, T - t1)) continue;
    const score = Math.abs(t1 - want);
    if (score < bestScore - 1e-12) {
      best = [t1, T - t1];
      bestScore = score;
    }
  }
  return best;
}

export interface OvalRoundInput {
  /** Circular part of the round being placed. */
  circ: number;
  /** Straight side S of the round being placed. */
  S: number;
  changeIdx: number;
  /** 1-based round number (decides which end takes an odd stitch). */
  round: number;
  /** End with a plain sc inside the last segment (jogless prep). */
  endPlain?: boolean;
}

export interface PlacedOvalRound {
  ops: Op[];
  segments: NonNullable<Line['segments']>;
  next: OvalLayout;
  /** `endPlain` was asked for and the last segment holds no plain sc. */
  overrideFailed: boolean;
}

/**
 * One oval round placed per segment (§2.10.8 "Oval rounds apply this placement per segment"): the circular
 * change split between the two end arcs (as evenly as the fan allows), the side change at the middle of each side,
 * the default rotation inside each arc. A side cannot grow from 0 sts or shrink to 0 alone: the end before it
 * makes the side's new stitches, or works the side's last stitches together with its own. The arc holding the
 * round start is cut there at an op boundary (a decrease never straddles the round start). When a choice cannot
 * be worked (no cut exists, the end's opening stitches cannot give the side its stitch), the next best end split
 * and then the end after the side are tried; `RangeError` only when nothing works.
 */
export function placeOvalRound(prevLayout: OvalLayout, x: OvalRoundInput): PlacedOvalRound {
  const prev = normalizeLayout(prevLayout);
  const ends = prev.arcs.flatMap((a, i) => (a.kind === 'end' ? [i] : []));
  if (ends.length !== 2) throw new RangeError('placeOvalRound: an oval layout has two end arcs');
  let lastError: unknown;
  for (const loose of [false, true]) {
    for (const policy of ['before', 'after'] as const) {
      const t = transfers(prev, x.S, policy);
      for (const split of endSplits(ends, t, x)) {
        try {
          return placeOvalWith(prev, x, t, ends, split, loose);
        } catch (e) {
          lastError = e;
        }
      }
    }
  }
  const why = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new RangeError(`placeOvalRound: ${prev.arcs.map((a) => a.n).join('/')} → circ ${x.circ}, S ${x.S} is not possible in one round${why}`);
}

interface Transfers {
  P: number[];
  T: number[];
  tail: number;
  donate: number[];
  gifts: { from: number; to: number; n: number }[];
}

/** Side targets and the stitches a side gets from (or gives to) the end next to it. */
function transfers(prev: OvalLayout, S: number, policy: 'before' | 'after'): Transfers {
  const m = prev.arcs.length;
  const P = prev.arcs.map((a) => a.n);
  const T = prev.arcs.map((a) => (a.kind === 'side' ? S : 0));
  let tail = prev.tail;
  const donate = Array<number>(m).fill(0);
  const gifts: { from: number; to: number; n: number }[] = [];
  const neighborOf = (i: number) => (i === 0 ? 1 : policy === 'after' && i + 1 < m ? i + 1 : i - 1);
  for (let i = 0; i < m; i++) {
    if (prev.arcs[i].kind !== 'side') continue;
    const j = neighborOf(i);
    if (P[i] === 0 && T[i] > 0) {
      donate[j] += T[i];
      gifts.push({ from: j, to: i, n: T[i] });
      T[i] = 0;
    } else if (P[i] > 0 && T[i] === 0) {
      // the side's last stitches are worked together with the end next to it
      P[j] += P[i];
      P[i] = 0;
      if (i === 0) tail = 0;
    }
  }
  return { P, T, tail, donate, gifts };
}

/** End splits of the circular target, best first: no inc3/dec3, balanced, fewest changes, odd stitch alternating. */
function endSplits(ends: number[], t: Transfers, x: OvalRoundInput): [number, number][] {
  const [ea, eb] = ends;
  const cands: { split: [number, number]; score: number }[] = [];
  for (let ta = 0; ta <= x.circ; ta++) {
    const tb = x.circ - ta;
    const A = ta + t.donate[ea];
    const B = tb + t.donate[eb];
    if (!feasibleChange(t.P[ea], A) || !feasibleChange(t.P[eb], B)) continue;
    const fan = (A > 2 * t.P[ea] || 2 * A < t.P[ea] ? 1 : 0) + (B > 2 * t.P[eb] || 2 * B < t.P[eb] ? 1 : 0);
    const tie = ta > tb ? (x.round % 2 === 1 ? 0 : 0.5) : ta < tb ? (x.round % 2 === 1 ? 0.5 : 0) : 0;
    const moves = Math.abs(A - t.P[ea]) + Math.abs(B - t.P[eb]);
    cands.push({ split: [ta, tb], score: fan * 1e6 + Math.abs(ta - tb) * 1e3 + moves + tie });
  }
  return cands.sort((a, b) => a.score - b.score).map((c) => c.split);
}

/**
 * `loose`: the last resort when no choice can be cut exactly at the round start (a 2-st end going to 1 next to a
 * tiny open edge): cut at the nearest op boundary instead, so the round starts one stitch earlier or later within
 * that end — the round is still worked stitch by stitch in order, only the end's bookkeeping moves by a stitch.
 */
function placeOvalWith(prev: OvalLayout, x: OvalRoundInput, t: Transfers, ends: number[], split: [number, number], loose: boolean): PlacedOvalRound {
  const m = prev.arcs.length;
  const P = t.P;
  const T = t.T.slice();
  T[ends[0]] = split[0] + t.donate[ends[0]];
  T[ends[1]] = split[1] + t.donate[ends[1]];

  // place every arc in its angular order (for arcs[0]: its closing stitches first, then its opening ones)
  const arcOps: Op[][] = prev.arcs.map((a, i) => (a.kind === 'side' ? sidePlacement(P[i], T[i], x.changeIdx) : placeCircular(P[i], T[i], x.changeIdx).ops));
  let headOps: Op[];
  let tailOps: Op[];
  const t0 = Math.min(t.tail, P[0]);
  if (t0 <= 0) {
    headOps = arcOps[0];
    tailOps = [];
  } else {
    const ops0 = arcOps[0];
    let cut = -1;
    let rotated = ops0;
    for (let r = 0; r < Math.max(1, ops0.length) && cut < 0; r++) {
      rotated = rotateLeft(ops0, r);
      cut = cutAt(rotated, t0);
    }
    if (cut >= 0) {
      tailOps = rotated.slice(0, cut);
      headOps = rotated.slice(cut);
    } else {
      // every op of the arc is a decrease that would straddle the round start: place the two parts apart
      const parts = splitTarget(t0, P[0] - t0, T[0]);
      if (parts) {
        tailOps = placeCircular(t0, parts[0], x.changeIdx).ops;
        headOps = placeCircular(P[0] - t0, parts[1], x.changeIdx).ops;
      } else if (loose) {
        // the op boundary whose consumption is nearest the tail (none when the arc is a single op)
        let best = 0;
        let used = 0;
        for (let i = 1; i < ops0.length; i++) {
          used += consumed([ops0[i - 1]]);
          if (best === 0 || Math.abs(used - t0) < Math.abs(consumed(ops0.slice(0, best)) - t0)) best = i;
        }
        tailOps = ops0.slice(0, best);
        headOps = ops0.slice(best);
      } else {
        throw new RangeError(`cannot split ${P[0]} → ${T[0]} at the round start`);
      }
    }
  }
  // a stitch arcs[0] gives the side after it is one of its opening stitches
  for (const g of t.gifts) if (g.from === 0 && produced(headOps) < g.n) throw new RangeError('the opening stitches cannot make the side');

  // jogless prep: rotate inside the last non-empty segment until it ends with a plain sc
  let overrideFailed = false;
  if (x.endPlain) {
    const parts: Op[][] = [headOps, ...arcOps.slice(1), tailOps];
    let at = parts.length - 1;
    while (at > 0 && parts[at].length === 0) at--;
    let last = parts[at];
    let ok = last.length > 0 && isPlainSc(last[last.length - 1]);
    for (let r = 1; !ok && r < last.length; r++) {
      const cand = rotateLeft(last, r);
      if (isPlainSc(cand[cand.length - 1])) {
        last = cand;
        ok = true;
      }
    }
    if (at === 0) headOps = last;
    else if (at === parts.length - 1) tailOps = last;
    else arcOps[at] = last;
    overrideFailed = !ok;
  }

  // the round, its segments (empty ones left out) and the next layout
  const ops: Op[] = [];
  const segments: NonNullable<Line['segments']> = [];
  const push = (kind: 'end' | 'side', part: readonly Op[]) => {
    if (part.length === 0) return;
    segments.push({ at: ops.length, kind });
    ops.push(...part);
  };
  push(prev.arcs[0].kind, headOps);
  for (let i = 1; i < m; i++) push(prev.arcs[i].kind, arcOps[i]);
  push(prev.arcs[0].kind, tailOps);

  const made = arcOps.map((a, i) => (i === 0 ? produced(headOps) + produced(tailOps) : produced(a)));
  for (const g of t.gifts) {
    made[g.from] -= g.n;
    made[g.to] += g.n;
  }
  const next = normalizeLayout({ arcs: prev.arcs.map((a, i) => ({ kind: a.kind, n: made[i] })), tail: produced(tailOps) });
  return { ops, segments, next, overrideFailed };
}

// ---------------------------------------------------------------------------------------------------------------
// A whole piece

export interface PieceShape {
  /** Stated count of every round (circular part + 2·S for ovals). */
  counts: readonly number[];
  /** Circular part of every round (ovals). */
  circ?: readonly number[];
  /** Straight side of every round (ovals). */
  ovalS?: readonly number[];
  /** BLO/FLO per round (`'both'` or absent = both loops). */
  loops?: readonly Loop[];
  start: LineStart;
}

export interface PlaceOptions {
  /** Spiral piece: the round before each BLO/FLO round gets the jogless prep (default true). */
  spiral?: boolean;
}

/** Where the jogless trick could not be used: the text says so (§2.10.5 "print the jog note instead"). */
export function jogNote(loop: 'BLO' | 'FLO', nextRound: number): string {
  return `Rnd ${nextRound} is worked in ${loop === 'BLO' ? 'back' : 'front'} loops only; a small jog shows at center back where it begins.`;
}

const changed = (ops: readonly Op[]) => ops.some(isSpecial);

/**
 * The unfolded rounds of a piece from its counts (§2.10.5–§2.10.8, §2.10.6 starts): round 1 from the start, every
 * later round placed by §2.10.8 (per segment for ovals), BLO/FLO on every op of a corner round with the jogless
 * prep before it, and the jog note where the prep cannot be used. Throws `RangeError` on counts that cannot be
 * worked (a start that does not match round 1, a change beyond inc3/dec3).
 */
export function placePiece(shape: PieceShape, o: PlaceOptions = {}): Line[] {
  const { counts, start } = shape;
  const spiral = o.spiral ?? true;
  const n = counts.length;
  if (n === 0) return [];
  const loops = Array.from({ length: n }, (_, i) => shape.loops?.[i] ?? 'both');
  if ((start.k === 'mr' || start.k === 'chainOval') && loops[0] !== 'both') {
    throw new RangeError(`placePiece: round 1 of a ${start.k === 'mr' ? 'magic ring' : 'chain oval'} is never worked in ${loops[0]} (§2.10.5)`);
  }
  const oval = shape.ovalS !== undefined && shape.circ !== undefined && start.k !== 'chainRing';
  const lines: Line[] = [];
  let changeIdx = 0;
  let prevChange: ChangeSites | undefined;
  let layout: OvalLayout | undefined;

  // round 1
  let ops1: Op[];
  if (start.k === 'mr') {
    if (start.n !== counts[0]) throw new RangeError(`placePiece: a magic ring of ${start.n} cannot start a round of ${counts[0]}`);
    ops1 = Array.from({ length: start.n }, sc);
    if (oval) layout = firstOvalLayout(0);
  } else if (start.k === 'chainOval') {
    const S = start.chains - 3;
    if (S < 0 || counts[0] !== 2 * start.chains) throw new RangeError(`placePiece: a chain oval of ch ${start.chains} makes ${2 * start.chains} sts, not ${counts[0]}`);
    ops1 = [...Array.from({ length: S + 1 }, sc), { k: 'inc', n: 3 }, ...Array.from({ length: S }, sc), { k: 'inc', n: 2 }];
    layout = firstOvalLayout(S);
  } else if (start.k === 'chainRing') {
    const placed = placeCircular(start.chains, counts[0], changeIdx);
    ops1 = placed.ops;
    if (changed(ops1)) {
      prevChange = changeSites(ops1);
      changeIdx++;
    }
  } else {
    throw new RangeError(`placePiece: a piece cannot start with '${start.k}'`);
  }
  lines.push({ kind: 'rnd', n: 1, start: { ...start }, ops: ops1, prevCount: null, stated: counts[0] });

  for (let i = 1; i < n; i++) {
    const P = counts[i - 1];
    const T = counts[i];
    const endPlain = spiral && i + 1 < n && loops[i + 1] !== 'both' && loops[i + 1] !== loops[i];
    let ops: Op[];
    let segments: Line['segments'];
    let failed = false;
    if (oval && layout) {
      const r = placeOvalRound(layout, { circ: (shape.circ as readonly number[])[i], S: (shape.ovalS as readonly number[])[i], changeIdx, round: i + 1, endPlain });
      ops = r.ops;
      segments = r.segments;
      layout = r.next;
      failed = r.overrideFailed;
    } else {
      const r = placeCircular(P, T, changeIdx, { endPlain, prevChange });
      ops = r.ops;
      failed = r.overrideFailed;
    }
    if (changed(ops)) {
      prevChange = changeSites(ops);
      changeIdx++;
    }
    // segment hints keep the shaping of an oval readable; a round without changes prints as one run
    const hinted = segments !== undefined && changed(ops);
    lines.push({ kind: 'rnd', n: i + 1, ops, prevCount: P, stated: T, ...(hinted ? { segments } : {}) });
    if (endPlain && !failed) {
      // jogless prep: the last sc becomes a sl st (counts unchanged)
      const last = ops[ops.length - 1];
      ops[ops.length - 1] = last.k === 'st' && last.color !== undefined ? { k: 'st', st: 'slst', color: last.color } : { k: 'st', st: 'slst' };
    }
  }
  // loops, and the jog note where the prep was not possible
  for (let i = 0; i < n; i++) {
    const loop = loops[i];
    if (loop === 'BLO' || loop === 'FLO') {
      lines[i].ops = lines[i].ops.map((op) => (op.k === 'tile' ? op : { ...op, loop }));
      if (spiral && i > 0 && loops[i - 1] !== loop) {
        const before = lines[i - 1];
        const lastOp = before.ops[before.ops.length - 1];
        if (!(lastOp && lastOp.k === 'st' && lastOp.st === 'slst')) {
          before.cues = [...(before.cues ?? []), { kind: 'note', text: jogNote(loop, i + 1) }];
        }
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Folding (E_FOLD)

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Two rounds that may share one `Rnds a–b` line: identical ops (colors, loops), header, segments, notes; plain. */
export function foldable(a: Line, b: Line): boolean {
  return (
    a.kind === 'rnd' &&
    b.kind === 'rnd' &&
    a.start === undefined &&
    b.start === undefined &&
    a.join === undefined &&
    b.join === undefined &&
    a.prevCount === a.stated &&
    b.prevCount === b.stated &&
    a.stated === b.stated &&
    (a.cues ?? []).length === 0 &&
    (b.cues ?? []).length === 0 &&
    (a.notes ?? []).length === 0 &&
    (b.notes ?? []).length === 0 &&
    a.colorHeader === b.colorHeader &&
    sameJson(a.ops, b.ops) &&
    sameJson(a.segments ?? null, b.segments ?? null) &&
    (b.n === (a.nEnd ?? a.n) + 1)
  );
}

/** Consecutive identical plain rounds folded into one line `Rnds a–b (k rnds)` (§2.10.11). */
export function foldRounds(lines: readonly Line[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && foldable(last, line)) {
      out[out.length - 1] = { ...last, nEnd: line.nEnd ?? line.n };
      continue;
    }
    out.push(line);
  }
  return out;
}
