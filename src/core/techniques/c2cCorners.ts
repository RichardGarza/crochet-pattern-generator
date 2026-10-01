// Track T2 — the C2C start corner × hand transforms (DESIGN.md §2.7.6).
//
// A C2C tile is chiral, so a right-hander starting at another corner makes a ROTATED layout, not a mirrored
// one; only a change of hand mirrors it. The writer maps the chart into the frame where the algorithm starts
// bottom-right (right-handed), runs it there, and maps cells and arrows back:
//
//   | Hand | BR       | BL                 | TL          | TR                |
//   | RH   | identity | rotate 90° CCW     | rotate 180° | rotate 90° CW     |
//   | LH   | mirror horizontally, then the RH entry of the mirrored corner (BR ↔ BL, TR ↔ TL)          |
//
// Coordinates here are the C2C chart's: `(r, c)` with r = 0 the BOTTOM row and c = 0 the left column, seen from
// the RS (§2.7.6). `ChartGrid` stores row 0 at the top, so chart cell (r, c) is grid row `rows − 1 − r`.
import type { Hand, Line } from '../../types';

export type Corner = 'BR' | 'BL' | 'TR' | 'TL';
export type C2CArrow = NonNullable<Line['arrow']>;

export const CORNERS: readonly Corner[] = Object.freeze(['BR', 'BL', 'TR', 'TL'] as const);

/** The corner's words: `bottom-right`. */
export const CORNER_NAMES: Readonly<Record<Corner, string>> = Object.freeze({ BR: 'bottom-right', BL: 'bottom-left', TR: 'top-right', TL: 'top-left' });

/** The default start corner of a hand (§2.7.6): bottom-right for right-handers, bottom-left for left-handers. */
export function defaultCorner(hand: Hand): Corner {
  return hand === 'left' ? 'BL' : 'BR';
}

/** A corner value read leniently (`'BR'`, `'bottom-right'`, …); anything else is the hand's default. */
export function cornerOf(value: unknown, hand: Hand): Corner {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
  switch (text) {
    case 'br':
    case 'bottom-right':
      return 'BR';
    case 'bl':
    case 'bottom-left':
      return 'BL';
    case 'tr':
    case 'top-right':
      return 'TR';
    case 'tl':
    case 'top-left':
      return 'TL';
    default:
      return defaultCorner(hand);
  }
}

/** The corner seen in a mirror: BR ↔ BL, TR ↔ TL. */
export function mirrorCorner(corner: Corner): Corner {
  return corner === 'BR' ? 'BL' : corner === 'BL' ? 'BR' : corner === 'TR' ? 'TL' : 'TR';
}

/**
 * The frame of the C2C algorithm for a chart of `W × H` tiles started at `corner` by `hand`: its own size and the
 * maps between chart cells and frame cells. Directions map through the linear part of `fromFrame`.
 */
export interface C2CFrame {
  /** Width and height of the transformed chart (swapped by a quarter turn). */
  W: number;
  H: number;
  toFrame(r: number, c: number): [number, number];
  fromFrame(r: number, c: number): [number, number];
  /** A step `(dr, dc)` in the frame as a step on the chart. */
  stepFromFrame(dr: number, dc: number): [number, number];
}

type Map2 = { size: (W: number, H: number) => [number, number]; to: (r: number, c: number, W: number, H: number) => [number, number]; from: (r: number, c: number, W: number, H: number) => [number, number]; step: (dr: number, dc: number) => [number, number] };

// The right-handed transforms (original chart W × H → frame), each with its inverse.
const RH: Readonly<Record<Corner, Map2>> = Object.freeze({
  BR: { size: (W, H) => [W, H], to: (r, c) => [r, c], from: (r, c) => [r, c], step: (dr, dc) => [dr, dc] },
  // 90° CCW: the bottom-left corner goes to the bottom-right. (r, c) → (c, H − 1 − r); frame W' = H.
  BL: { size: (W, H) => [H, W], to: (r, c, _W, H) => [c, H - 1 - r], from: (r, c, _W, H) => [H - 1 - c, r], step: (dr, dc) => [-dc, dr] },
  // 180°: the top-left corner goes to the bottom-right.
  TL: { size: (W, H) => [W, H], to: (r, c, W, H) => [H - 1 - r, W - 1 - c], from: (r, c, W, H) => [H - 1 - r, W - 1 - c], step: (dr, dc) => [-dr, -dc] },
  // 90° CW: the top-right corner goes to the bottom-right. (r, c) → (W − 1 − c, r); frame W' = H.
  TR: { size: (W, H) => [H, W], to: (r, c, W) => [W - 1 - c, r], from: (r, c, W) => [c, W - 1 - r], step: (dr, dc) => [dc, -dr] },
});

/** The frame of §2.7.6's table: RH as listed; LH = mirror, then the RH entry of the mirrored corner. */
export function c2cFrame(W: number, H: number, hand: Hand, corner: Corner): C2CFrame {
  const left = hand === 'left';
  const t = RH[left ? mirrorCorner(corner) : corner];
  const [fw, fh] = t.size(W, H);
  // The mirror M: (r, c) → (r, W − 1 − c), its own inverse; steps (dr, dc) → (dr, −dc).
  const toFrame = (r: number, c: number): [number, number] => (left ? t.to(r, W - 1 - c, W, H) : t.to(r, c, W, H));
  const fromFrame = (r: number, c: number): [number, number] => {
    const [or, oc] = t.from(r, c, W, H);
    return left ? [or, W - 1 - oc] : [or, oc];
  };
  const stepFromFrame = (dr: number, dc: number): [number, number] => {
    const [sr, sc] = t.step(dr, dc);
    return left ? [sr, -sc] : [sr, sc];
  };
  return { W: fw, H: fh, toFrame, fromFrame, stepFromFrame };
}

/** The arrow of a diagonal step on the chart (r up, c right): (1, 1) ↗, (1, −1) ↖, (−1, 1) ↘, (−1, −1) ↙. */
export function arrowOfStep(dr: number, dc: number): C2CArrow {
  if (dr > 0) return dc > 0 ? '↗' : '↖';
  return dc > 0 ? '↘' : '↙';
}

/**
 * The arrows `[odd (RS), even (WS)]` of a hand and start corner: the frame's ↙ (−1, −1) and ↗ (1, 1) mapped back
 * to the chart. Equals `C2C_ARROWS` of notes.ts (tested).
 */
export function c2cArrows(hand: Hand, corner: Corner): [C2CArrow, C2CArrow] {
  const frame = c2cFrame(2, 2, hand, corner);
  const [r1, c1] = frame.stepFromFrame(-1, -1);
  const [r2, c2] = frame.stepFromFrame(1, 1);
  return [arrowOfStep(r1, c1), arrowOfStep(r2, c2)];
}

/** The start corner of a hand whose Row 1 runs `oddArrow` (each hand's four corners have four different odd arrows). */
export function cornerFromArrow(hand: Hand, oddArrow: string | undefined): Corner | undefined {
  for (const corner of CORNERS) if (c2cArrows(hand, corner)[0] === oddArrow) return corner;
  return undefined;
}
