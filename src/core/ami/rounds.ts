// Track T4 — Path A: stitch counts from a profile (DESIGN.md §2.10.5, normative), the torus formula of §2.10.4,
// the BLO/FLO round of every corner, and `roundsForPart`, which picks the textbook or the generic path.
//
// ```ts
// const wS = w * s, hS = h * s;                    // the caller passes stuffedCell(gauge, stuffing)
// const N = Math.max(2, Math.round(L / hS)), hEff = L / N;
// const ks = closedFarEnd ? range(1, N - 1) : range(1, N);
// const ideal = ks.map(k => 2 * Math.PI * r(k * hEff) / wS);        // circular part (minor radius b for ovals)
// const round1 = (x) => style === 'exact' ? hysteresis(x, 0.75) : batchCounts(x, max(x) < 18 ? 4 : 6, 6);
// let n = symmetricProfile ? mirrorHalf(ideal, round1) : round1(ideal);
// n = clampPoles(n, ideal, { start, closedFarEnd, style, oval });
// n = clampFan(n);
// if (oval) n = n.map((c, i) => c + 2 * S[i]);
// ```
// Every rounding is `roundHalfUp` of core/gauge (Math.round's rule with ties decided as exact arithmetic would;
// s0b-gauge request 4).
import { roundHalfUp } from '../gauge/round';
import type { Loop, LineStart } from '../../types/pattern';
import type { Part } from '../../types/model';
import { textbookCounts } from './classic';
import { ovalSides } from './oval';
import {
  chainOvalStart,
  chainRingStart,
  clampFan,
  closedEndRule,
  closeTail,
  magicRingStart,
  startRule,
  type PoleOptions,
  type StartKind,
} from './poles';
import { isSymmetricProfile, profileOf, profileR, trimProfile, type Axis, type Pole, type Profile } from './profiles';

export type Style = 'classic' | 'exact';

/** §2.10.5 `hysteresis(x, band)`: n₁ = round(x₁); keep the previous count unless |x_k − prev| > band. */
export function hysteresis(x: readonly number[], band = 0.75): number[] {
  const out: number[] = [];
  for (const v of x) {
    const p = out.at(-1);
    out.push(p === undefined || Math.abs(v - p) > band ? roundHalfUp(v) : p);
  }
  return out;
}

/**
 * §2.10.5 `batchCounts(x, sym, p0 = 6)`: p starts at p0, the count "before" round 1; for each x_k choose among
 * {p − sym, p, p + sym} (only values ≥ sym) the nearest to x_k, ties keep p; the choice becomes p.
 */
export function batchCounts(x: readonly number[], sym: number, p0 = 6): number[] {
  const out: number[] = [];
  let p = p0;
  for (const v of x) {
    let best = p;
    for (const c of [p - sym, p + sym]) {
      if (c >= sym && Math.abs(c - v) < Math.abs(best - v)) best = c;
    }
    p = best;
    out.push(p);
  }
  return out;
}

/** §2.10.5 `mirrorHalf`: round the first ceil(m/2) values with `round1`, then `n[k] = n[m+1−k]`. */
export function mirrorHalf(x: readonly number[], round1: (x: readonly number[]) => number[]): number[] {
  const m = x.length;
  const half = round1(x.slice(0, Math.ceil(m / 2)));
  return mirrorList(half, m);
}

function mirrorList(half: readonly number[], m: number): number[] {
  const out = half.slice(0, Math.ceil(m / 2));
  for (let k = out.length; k < m; k++) out.push(out[m - 1 - k]);
  return out;
}

/**
 * The rounding of one list of ideals for a style (§2.10.5 `round1`). `p0` = the count "before" round 1: 6 for a
 * closed start, the chain count for a chain-ring start (§2.10.5 says 6 everywhere; from 6 a straight open tube of
 * 31 chains would batch `12 18 24 30 …` — see docs/tracks/t4.md).
 */
export function roundForStyle(style: Style, p0 = 6): (x: readonly number[]) => number[] {
  return (x) => (style === 'exact' ? hysteresis(x, 0.75) : batchCounts(x, Math.max(...x) < 18 ? 4 : 6, p0));
}

/** Round index (1-based) worked in BLO/FLO after a corner at `sc`: the first k with `s_k ≥ s_c + 0.5·hEff`. */
export function cornerRound(sc: number, hEff: number): number {
  return Math.max(1, Math.ceil((sc + 0.5 * hEff) / hEff - 1e-9));
}

export interface PathAOptions {
  wS: number;
  hS: number;
  style: Style;
  /** Flattened piece: magic ring 4–8 (exact). */
  flattened?: boolean;
}

/** Where a set of counts came from. */
export type Generator = 'pathA' | 'textbook' | 'torus';

export interface PieceCounts {
  generator: Generator;
  /** Stated count of every round (circular part + 2·S_k for an oval). */
  counts: number[];
  /** Circular part of every round (= `counts` for a circular piece). */
  circ: number[];
  /** Straight side of every round (oval pieces only). */
  ovalS?: number[];
  /**
   * Ideal circular count of every profile round k = 1 … m before rounding (Path A; empty otherwise). Indexed like
   * `counts` from round 1; it can be longer (rounds dropped at a closed end) or shorter (rounds appended).
   */
  ideal: number[];
  /** Circular counts as rounded (`round1`, mirrored for a symmetric profile), before the pole rule; indexed as `ideal`. */
  raw: number[];
  /** Arc position `k·hEff` of every profile round (Path A; empty otherwise); indexed as `ideal`. */
  sk: number[];
  loops: Loop[];
  /** Rounds the profile length holds (`max(2, round(L/hS))`), and the row pitch used. */
  N: number;
  hEff: number;
  /** Profile length after trimming (Path A; the textbook's A or s_end). */
  L: number;
  start: LineStart;
  closedEnd: boolean;
  finish: 'gather' | 'flattenSc' | 'open' | 'seamToStart';
  symmetric: boolean;
  /** Rounds dropped by the closed-end rule (the piece closed early; W_SIZE allows 1.5·hS per pole). */
  dropped: number;
  /** Rounds added by `closeTail` (never for exact counts; see docs/tracks/t4.md). */
  appended: number;
}

/**
 * Path A counts of a profile (§2.10.5), with the pole rule, the fan clamp, the oval sides and the BLO/FLO rounds.
 *
 * A symmetric profile runs the round1 → start rule → fan pipeline on its first ceil(m/2) rounds and mirrors the
 * result, so its counts are always symmetric (the property test of §2.10.5); the far pole is then the mirror of
 * the start and keeps a start plateau (`5 5 …`) instead of dropping the trailing duplicate. For every golden this
 * equals the literal order (`mirrorHalf` → `clampPoles` → `clampFan`), which `__tests__` checks.
 */
export function pathACounts(p: Profile, o: PathAOptions): PieceCounts {
  const { wS, hS, style } = o;
  if (!(wS > 0 && hS > 0)) throw new RangeError(`pathACounts: wS and hS must be > 0, got ${wS}, ${hS}`);
  const L = p.L;
  const N = Math.max(2, roundHalfUp(L / hS));
  const hEff = L / N;
  const closedFarEnd = p.closedEnd;
  const m = closedFarEnd ? N - 1 : N;
  const sk = Array.from({ length: m }, (_, i) => (i + 1) * hEff);
  const ideal = sk.map((s) => (2 * Math.PI * profileR(p, s)) / wS);
  // Mirroring pairs round k with round m + 1 − k, i.e. s_k with L − s_k only when both poles are closed (m = N − 1).
  const symmetric = p.closedStart && closedFarEnd && isSymmetricProfile(p);
  const oval = p.oval !== undefined;
  let S = oval ? ovalSides(p, sk, wS, symmetric) : undefined;
  const startKind: StartKind = !p.closedStart ? 'chainRing' : oval && S && S[0] >= 1 ? 'chainOval' : 'mr';
  const po: PoleOptions = { start: startKind, closedFarEnd, style, oval, flattened: o.flattened, path: 'A' };
  const ringChains = Math.max(1, roundHalfUp((2 * Math.PI * profileR(p, 0)) / wS));
  const round1 = roundForStyle(style, startKind === 'chainRing' ? ringChains : 6);

  let circ: number[];
  let dropped = 0;
  const raw = symmetric ? mirrorHalf(ideal, round1) : round1(ideal);
  if (symmetric) {
    const h = Math.ceil(m / 2);
    const half = clampFan(startRule(raw.slice(0, h), ideal.slice(0, h), po));
    circ = mirrorList(half, m);
    if (closedFarEnd) circ = closedEndRule(circ, po, false, ideal).n;
  } else {
    circ = startRule(raw, ideal, po);
    if (closedFarEnd) {
      const r = closedEndRule(circ, po, true, ideal);
      circ = r.n;
      dropped = r.dropped;
    }
    circ = clampFan(circ);
  }
  let appended = 0;
  if (closedFarEnd) {
    const t = closeTail(circ, po);
    circ = t.n;
    appended = t.appended;
  }
  if (S) {
    S = S.slice(0, circ.length);
    while (S.length < circ.length) S.push(S[S.length - 1] ?? 0);
  }
  const counts = S ? circ.map((c, i) => c + 2 * (S as number[])[i]) : circ.slice();

  const loops: Loop[] = Array<Loop>(counts.length).fill('both');
  for (const c of p.corners) {
    // round 1 of a magic ring or chain oval is worked into the ring / chain, never in back or front loops
    const k = Math.max(cornerRound(c.s, hEff), startKind === 'chainRing' ? 1 : 2);
    if (k <= counts.length && loops[k - 1] === 'both') loops[k - 1] = c.kind === 'convex' ? 'BLO' : 'FLO';
  }

  const start: LineStart =
    startKind === 'chainRing'
      ? chainRingStart(ringChains)
      : startKind === 'chainOval'
        ? chainOvalStart((S as number[])[0])
        : magicRingStart(circ[0]);
  const lastS = S ? S[S.length - 1] : 0;
  const finish = closedFarEnd ? (lastS >= 2 ? 'flattenSc' : 'gather') : 'open';
  return {
    generator: 'pathA',
    counts,
    circ,
    ...(S ? { ovalS: S } : {}),
    ideal,
    raw,
    sk,
    loops,
    N,
    hEff,
    L,
    start,
    closedEnd: closedFarEnd,
    finish,
    symmetric,
    dropped,
    appended,
  };
}

/**
 * Full torus (§2.10.4): chain ring at the hole `n₀ = round(2π(R − r)/wS)`, `K = round(2πr/hS)` rounds,
 * `n_k = round(2π(R − r·cos(2πk/K))/wS)` for k = 0 … K − 1 (round 1 is worked into the chain ring), the last
 * round seamed to the first. The fan clamp still applies.
 */
export function torusCounts(R: number, r: number, wS: number, hS: number): PieceCounts {
  if (!(R > 0 && r > 0 && wS > 0 && hS > 0)) throw new RangeError(`torusCounts: R, r, wS, hS must be > 0`);
  const K = Math.max(3, roundHalfUp((2 * Math.PI * r) / hS));
  const n0 = Math.max(1, roundHalfUp((2 * Math.PI * Math.max(0, R - r)) / wS));
  const raw = Array.from({ length: K }, (_, k) => Math.max(1, roundHalfUp((2 * Math.PI * (R - r * Math.cos((2 * Math.PI * k) / K))) / wS)));
  const counts = clampFan(raw);
  return {
    generator: 'torus',
    counts,
    circ: counts.slice(),
    ideal: [],
    raw,
    sk: [],
    loops: Array<Loop>(K).fill('both'),
    N: K,
    hEff: (2 * Math.PI * r) / K,
    L: 2 * Math.PI * r,
    start: chainRingStart(n0),
    closedEnd: false,
    finish: 'seamToStart',
    symmetric: true,
    dropped: 0,
    appended: 0,
  };
}

export interface RoundsForPartOptions {
  wS: number;
  hS: number;
  /** `part.crochet.style`, else the settings' style. */
  style: Style;
  axis?: Axis;
  start?: Pole;
  /** Trimmed at this arc position (§2.10.3): the far end is open. */
  trimAt?: number;
  /** Untrimmed piece with `attach.openEnd` at its far end. */
  openFar?: boolean;
  flattened?: boolean;
}

/**
 * Counts for one part: the textbook generator for a classic sphere or capsule (closed when untrimmed with both
 * ends closed, else the open form), the torus formula for a full torus, else Path A on the part's profile.
 * Returns `null` for parts without a revolved profile (`flat`, `mesh`).
 */
export function roundsForPart(part: Part, o: RoundsForPartOptions): PieceCounts | null {
  const { wS, hS, style } = o;
  if (part.type === 'torus' && (part.dims.arcDeg ?? 360) >= 360) return torusCounts(part.dims.R, part.dims.r, wS, hS);
  if (o.trimAt !== undefined && !(o.trimAt > 1e-9 && Number.isFinite(o.trimAt))) throw new RangeError(`roundsForPart: trimAt must be a length > 0, got ${o.trimAt}`);
  if (style === 'classic' && (part.type === 'sphere' || part.type === 'capsule')) {
    const { r } = part.dims;
    const length = part.type === 'capsule' ? part.dims.length : 2 * r;
    if (!(Number.isFinite(r) && r > 0 && Number.isFinite(length))) throw new RangeError(`roundsForPart: a ${part.type} needs a finite r > 0 and length, got ${JSON.stringify(part.dims)}`);
    // a cut at or past the far pole is no cut (as trimProfile reads it)
    const trimmed = o.trimAt !== undefined && o.trimAt < Math.PI * r + Math.max(0, length - 2 * r) - 1e-9;
    const open = trimmed ? { sCut: o.trimAt as number } : o.openFar ? {} : undefined;
    const tb = textbookCounts({
      kind: part.type,
      r: part.dims.r,
      ...(part.type === 'capsule' ? { length: part.dims.length } : {}),
      wS,
      hS,
      ...(open ? { open } : {}),
    });
    return {
      generator: 'textbook',
      counts: tb.counts,
      circ: tb.counts.slice(),
      ideal: [],
      raw: tb.counts.slice(),
      sk: [],
      loops: Array<Loop>(tb.counts.length).fill('both'),
      N: tb.counts.length + (tb.closedEnd ? 1 : 0),
      hEff: hS,
      L: tb.closedEnd ? (tb.A as number) : (tb.sEnd as number),
      start: magicRingStart(6),
      closedEnd: tb.closedEnd,
      finish: tb.closedEnd ? 'gather' : 'open',
      symmetric: tb.closedEnd,
      dropped: 0,
      appended: 0,
    };
  }
  let p = profileOf(part, { axis: o.axis, start: o.start, openFar: o.openFar && o.trimAt === undefined });
  if (!p) return null;
  if (o.trimAt !== undefined) {
    if (o.trimAt < p.L - 1e-9) p = trimProfile(p, o.trimAt);
    else if (o.openFar) p = profileOf(part, { axis: o.axis, start: o.start, openFar: true }) as Profile;
  }
  return pathACounts(p, { wS, hS, style, flattened: o.flattened });
}
