// Track T4 — the pole rule, the fan clamp, starts and finishes (DESIGN.md §2.10.5 "Pole rule", §2.10.6).
//
// `clampPoles` is normative for every closed pole in both paths (Path B calls it too, §2.10.7 step 4). Counts
// here are always the CIRCULAR part of a round; an oval adds `2·S_k` afterwards (§2.10.2).
import { ceilTolerant, roundHalfUp } from '../gauge/round';
import type { LineStart, PieceFinish } from '../../types/pattern';

export type StartKind = 'mr' | 'chainOval' | 'chainRing';

export interface PoleOptions {
  start: StartKind;
  closedFarEnd: boolean;
  style: 'classic' | 'exact';
  /** Oval piece: the closed-end minimum is 6 and the last circular count is exactly 6. */
  oval?: boolean;
  /** Flattened pieces: the magic ring may hold 4–8 (§2.10.5, §2.10.9). */
  flattened?: boolean;
  /** Path B uses the exact ring range whatever the style (§2.10.5). */
  path?: 'A' | 'B';
}

/** Magic-ring count of the textbook: "6 sc in MR". */
export const CLASSIC_MR = 6;
/** Largest magic ring and largest gathered closing round (§2.10.6, E_START, E_CLOSE). */
export const MAX_MR = 8;
export const MAX_GATHER = 8;
/** Closed-end minimum: circular 5, oval circular part 6 (§2.10.5). */
export const CLOSE_MIN = 5;
/** Closed-end minimum of a flattened piece, whose ring may hold 4 (E_CLOSE: never < 4). */
export const FLAT_CLOSE_MIN = 4;
export const OVAL_CLOSE = 6;
/** Circular part of a chain oval's first round (§2.10.6: 3 sts at each end). */
export const CHAIN_OVAL_CIRC = 6;

/** The magic-ring count the pole rule allows: `[lo, hi]`, a single value for classic Path A. */
export function mrRange(o: Pick<PoleOptions, 'style' | 'flattened' | 'path'>): [number, number] {
  if (o.style === 'classic' && o.path !== 'B') return [CLASSIC_MR, CLASSIC_MR];
  return [o.flattened ? 4 : 5, MAX_MR];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Start half of the pole rule. Magic ring: n₁ = 6 (classic) or `clamp(round(ideal₁), 5, 8)` (exact, Path B;
 * `[4, 8]` flattened); then for k = 2, 3, … while `ideal_k < n₁`: `n_k = max(n_k, n_{k−1})` — a widening shape
 * never decreases next to its start. Chain oval: the circular part of round 1 is 6, then the same widening rule
 * (DESIGN only names the ring; applied to both so that no closed start ever decreases next to it). An oval piece
 * that starts on a magic ring (S₁ = 0) gets 6 as well: its closed end must finish at circular 6, and a symmetric
 * oval must mirror its start. Chain ring: no clamp.
 */
export function startRule(n: readonly number[], ideal: readonly number[], o: PoleOptions): number[] {
  const out = n.slice();
  if (out.length === 0 || o.start === 'chainRing') return out;
  if (o.start === 'mr' && !o.oval) {
    const [lo, hi] = mrRange(o);
    out[0] = lo === hi ? lo : clamp(roundHalfUp(ideal[0]), lo, hi);
  } else {
    // a chain oval, or an oval piece whose first round has no straight side yet (S₁ = 0, magic ring): the
    // circular part of an oval's pole is always 6, at the start as at the closed end
    out[0] = CHAIN_OVAL_CIRC;
  }
  const n1 = out[0];
  for (let k = 1; k < out.length && ideal[k] < n1; k++) out[k] = Math.max(out[k], out[k - 1]);
  return out;
}

/**
 * Closed-far-end half of the pole rule: walking backwards from the last round down to the round with the largest
 * count, `n_k = max(n_k, n_{k+1}, min)` (min 5, 4 for a flattened piece; 6 for an oval's circular part), never
 * past the peak; then a trailing round equal to its predecessor is dropped (the piece closes one round early).
 * Returns the counts and the number of rounds dropped.
 *
 * Only ONE round is dropped, and only one this rule raised: the prose says "the piece closes one round early;
 * R11 accepts the ≤ 1.5·hS loss at the tip", while a literal "drop trailing rounds equal to their predecessor"
 * would delete the whole straight tip of a long thin piece (a tail, a horn worked from its base) whose counts
 * were already equal before the rule.
 *
 * With `ideal`, the walk is also bounded the way the start rule is: it stops at the first round (from the end)
 * whose ideal is at least the closing count `n_last`. Without that bound, a closed piece whose widest round comes
 * before a waist (a snowman lathe: big ball, neck, small ball) would have its neck filled up to the small ball's
 * width. On every profile that only narrows after its peak (all of DESIGN's goldens) both readings agree.
 * See docs/tracks/t4.md, "Requests for integration".
 */
export function closedEndRule(
  n: readonly number[],
  o: Pick<PoleOptions, 'oval' | 'flattened'>,
  dropTrailing = true,
  ideal?: readonly number[],
): { n: number[]; dropped: number } {
  const out = n.slice();
  if (out.length === 0) return { n: out, dropped: 0 };
  const min = o.oval ? OVAL_CLOSE : o.flattened ? FLAT_CLOSE_MIN : CLOSE_MIN;
  let peak = 0;
  for (let k = 1; k < out.length; k++) if (out[k] >= out[peak]) peak = k;
  const last = out.length - 1;
  out[last] = Math.max(out[last], min);
  for (let k = last - 1; k > peak; k--) {
    if (ideal && !(ideal[k] < out[last])) break;
    out[k] = Math.max(out[k], out[k + 1], min);
  }
  let dropped = 0;
  if (dropTrailing && out.length >= 2 && out[last] === out[last - 1] && out[last] > n[last]) {
    out.pop();
    dropped = 1;
  }
  return { n: out, dropped };
}

/** The pole rule (§2.10.5): the start half, then (closed far end) the closed-end half, bounded by the ideals. */
export function clampPoles(n: readonly number[], ideal: readonly number[], o: PoleOptions): number[] {
  const started = startRule(n, ideal, o);
  return o.closedFarEnd ? closedEndRule(started, o, true, ideal).n : started;
}

/** `n_k ∈ [ceil(n_{k−1}/2), 2·n_{k−1}]`: no more than 2 sts into one or 2 together (§2.10.5, R3/R4). */
export function clampFan(n: readonly number[]): number[] {
  const out = n.slice();
  for (let k = 1; k < out.length; k++) out[k] = clamp(out[k], Math.ceil(out[k - 1] / 2), 2 * out[k - 1]);
  return out;
}

/**
 * Safety net after the fan clamp (not in DESIGN's pseudocode; see docs/tracks/t4.md): a closed far end must
 * finish at ≤ 8 (E_CLOSE), and an oval's circular part at exactly 6 (§2.10.5). Batched classic counts can lag
 * a steep closing cap (`… 24 18 12` when the ideal falls 7.5 per round), and the fan clamp can lift a last round.
 * The last circular count is lowered to the closing value when the fan allows it, else halving rounds are
 * appended. Returns the counts and the number of rounds appended.
 */
export function closeTail(n: readonly number[], o: Pick<PoleOptions, 'oval' | 'flattened'>): { n: number[]; appended: number } {
  const out = n.slice();
  let appended = 0;
  if (out.length === 0) return { n: out, appended };
  if (o.oval) {
    const last = out.length - 1;
    if (out[last] !== OVAL_CLOSE && (last === 0 ? out[last] < OVAL_CLOSE : Math.ceil(out[last - 1] / 2) <= OVAL_CLOSE)) {
      out[last] = OVAL_CLOSE;
    }
    while (out[out.length - 1] > OVAL_CLOSE) {
      out.push(Math.max(OVAL_CLOSE, Math.ceil(out[out.length - 1] / 2)));
      appended++;
    }
    return { n: out, appended };
  }
  while (out[out.length - 1] > MAX_GATHER) {
    out.push(Math.max(CLASSIC_MR, Math.ceil(out[out.length - 1] / 2)));
    appended++;
  }
  return { n: out, appended };
}

// ---------------------------------------------------------------------------------------------------------------
// Starts (§2.10.6)

/** "Rnd 1: n sc in MR (n)". */
export function magicRingStart(n1: number): LineStart {
  return { k: 'mr', n: n1 };
}

/** Chain oval with straight side S: ch `S + 3`; round 1 has `2N = 2S + 6` sts (§2.10.6). */
export function chainOvalStart(S1: number): LineStart {
  return { k: 'chainOval', chains: S1 + 3 };
}

/** Open start (a torus, a tube open at its start): a ring of `chains` chains. */
export function chainRingStart(chains: number): LineStart {
  return { k: 'chainRing', chains };
}

// ---------------------------------------------------------------------------------------------------------------
// Finishes and tails (§2.10.6)

/** The tail left when a closed end is gathered, inches. */
export const GATHER_TAIL_IN = 6;
/** A sewing tail is never shorter than this, inches. */
export const MIN_SEWING_TAIL_IN = 12;

export interface Tail {
  /** `max(12 in, 3 × seam + 6 in)` before printing. */
  exactIn: number;
  /** Printed: rounded up to the next 2 in. */
  in: number;
  /** Printed cm: the printed inches × 2.54, rounded to 5 cm. */
  cm: number;
}

/** cm of a printed length, rounded to 5 cm (§2.10.6). */
export function tailCm(inches: number): number {
  return roundHalfUp((inches * 2.54) / 5) * 5;
}

/**
 * The sewing tail of a seam: `T = max(12 in, 3 × seam + 6 in)` (a whipstitch uses 2.5–3× the seam length, plus
 * 6 in to handle and weave in), printed rounded up to the next 2 in.
 */
export function sewingTail(seamIn: number): Tail {
  if (!(seamIn >= 0) || !Number.isFinite(seamIn)) throw new RangeError(`sewingTail: the seam must be a length ≥ 0, got ${seamIn}`);
  const exactIn = Math.max(MIN_SEWING_TAIL_IN, 3 * seamIn + 6);
  const printed = ceilTolerant(exactIn / 2) * 2;
  return { exactIn, in: printed, cm: tailCm(printed) };
}

/** Seam of an open piece: its open-edge stitches × wS. */
export function openSeamIn(openSts: number, wS: number): number {
  return openSts * wS;
}

/** Seam of a closed sewn piece: `π·d`, d = its widest contact across (at least 4·wS). */
export function closedSeamIn(dIn: number, wS: number): number {
  return Math.PI * Math.max(dIn, 4 * wS);
}

export type FinishKind = 'gather' | 'open' | 'flattenSc';

export interface FinishInput {
  kind: FinishKind;
  /** Open edge stitches (open) — the seam is `openSts × wS`. */
  openSts?: number;
  wS: number;
  /** Straight side S of the last round of an oval (flattenSc): `S + 3` sts on each side. */
  S?: number;
  /** A closed piece that is sewn on: its seam (`closedSeamIn`); the tail grows by the sewing tail. */
  sewnSeamIn?: number;
}

/** The finish of a piece and its printed text (§2.10.6; US terms). */
export function pieceFinish(f: FinishInput): PieceFinish {
  switch (f.kind) {
    case 'open': {
      if (!(f.openSts !== undefined && f.openSts >= 1)) throw new RangeError('pieceFinish: an open finish needs its stitch count');
      const t = sewingTail(openSeamIn(f.openSts, f.wS));
      return { kind: 'open', tailIn: t.in, sewTailIn: t.in, text: `Fasten off, leaving a ${t.in}" (${t.cm} cm) tail for sewing.` };
    }
    case 'flattenSc': {
      if (!(f.S !== undefined && f.S >= 2)) throw new RangeError('pieceFinish: the closed-oval finish needs S ≥ 2');
      const side = f.S + 3;
      return {
        kind: 'flattenSc',
        tailIn: GATHER_TAIL_IN,
        text: `Flatten the opening so its two sides (${side} sts each) line up; working through both layers, sc across (${side} sc). Fasten off.`,
      };
    }
    case 'gather': {
      if (f.sewnSeamIn !== undefined) {
        const t = sewingTail(f.sewnSeamIn);
        const total = GATHER_TAIL_IN + t.in;
        return {
          kind: 'gather',
          tailIn: total,
          sewTailIn: t.in,
          text: `Fasten off, leaving a ${total}" tail; close with the Ultimate Finish and keep the rest of the tail to sew the piece on.`,
        };
      }
      return {
        kind: 'gather',
        tailIn: GATHER_TAIL_IN,
        text: `Fasten off, leaving a ${GATHER_TAIL_IN}" (${tailCm(GATHER_TAIL_IN)} cm) tail; close with the Ultimate Finish (thread the tail through the front loops of the last sts and pull tight).`,
      };
    }
  }
}
