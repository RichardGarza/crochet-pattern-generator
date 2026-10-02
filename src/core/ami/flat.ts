// Track T4 — flat pieces (DESIGN.md §2.10.9): appliqués (single layer, not stuffed) and flattened tubes (thick
// `flat` parts: ears, wings, fins; s = 1).
//
// - Appliqué: circle → MR, then `n_k = 6k` for `K = max(1, round(D/(2h)))` rounds; oval → a chain oval (§2.10.6)
//   with `K = round(b/h)` rounds (the circular part grows by 6 a round, the sides stay S); rectangle → rows of sc
//   (`ch W+1`, H rows); other outlines → the nearest oval (the piece intro says so).
// - Flattened tube: from the tip (the end away from the attachment) to the base, rounds every h,
//   `n_k = 2·round(width(y_k)/w)` (even), `n₁ ∈ [4, 8]`; it ends open for sewing (its base is sewn on), pressed flat.
import type { Line, LineStart, Loop } from '../../types/pattern';
import type { Part } from '../../types/model';
import { roundHalfUp } from '../gauge/round';
import { flatLayout } from '../model/builder';
import { chainOvalStart, clampFan, magicRingStart } from './poles';
import type { PieceCounts } from './rounds';

/** Above this aspect an outline is an oval (§2.10.2's 1.15). */
const OVAL_ASPECT = 1.15;

export interface FlatShape {
  kind: 'circle' | 'oval' | 'rect' | 'tube';
  counts: PieceCounts;
  /** Rows of a rectangle (already as lines; `counts` holds their widths). */
  rows?: Line[];
  /** The outline was approximated (a teardrop, triangle or polygon appliqué drawn as an oval). */
  approximated?: boolean;
}

function shapeCounts(counts: number[], start: LineStart, o: { circ?: number[]; ovalS?: number[]; hEff: number }): PieceCounts {
  return {
    generator: 'pathA',
    counts,
    circ: o.circ ?? counts.slice(),
    ...(o.ovalS ? { ovalS: o.ovalS } : {}),
    ideal: [],
    raw: counts.slice(),
    sk: counts.map((_, i) => (i + 1) * o.hEff),
    loops: Array<Loop>(counts.length).fill('both'),
    N: counts.length,
    hEff: o.hEff,
    L: counts.length * o.hEff,
    start,
    closedEnd: false,
    finish: 'open',
    symmetric: false,
    dropped: 0,
    appended: 0,
  };
}

/**
 * The appliqué of a part (§2.10.9) from its outline: a `flat` part's own shape, any other part's two largest
 * extents (`e2 × e3`, an ellipse). `cell` is the unstuffed stitch (s = 1).
 */
export function appliqueShape(part: Part, extents: readonly [number, number, number], cell: { w: number; h: number }): FlatShape {
  const { w, h } = cell;
  const flat = part.type === 'flat' ? part.dims : undefined;
  if (flat?.shape === 'rect') {
    const W = Math.max(1, roundHalfUp(flat.w / w));
    const H = Math.max(1, roundHalfUp(flat.h / h));
    const rows: Line[] = [];
    for (let r = 1; r <= H; r++) {
      rows.push({
        kind: 'row',
        n: r,
        ...(r % 2 === 1 ? { side: 'RS' as const } : { side: 'WS' as const }),
        start: r === 1 ? { k: 'foundation', chains: W + 1, firstInto: 2 } : { k: 'turn', chains: 1 },
        ops: Array.from({ length: W }, () => ({ k: 'st' as const, st: 'sc' as const })),
        prevCount: r === 1 ? null : W,
        stated: W,
      });
    }
    return { kind: 'rect', counts: shapeCounts(Array<number>(H).fill(W), { k: 'foundation', chains: W + 1, firstInto: 2 }, { hEff: h }), rows };
  }
  const big = flat ? Math.max(flat.w, flat.h) : extents[2];
  const small = flat ? Math.min(flat.w, flat.h) : extents[1];
  const approximated = flat !== undefined && flat.shape !== 'circle' && flat.shape !== 'oval';
  if (big / Math.max(small, 1e-9) <= OVAL_ASPECT && !approximated) {
    const D = (big + small) / 2;
    const K = Math.max(1, roundHalfUp(D / (2 * h)));
    const counts = Array.from({ length: K }, (_, k) => 6 * (k + 1));
    return { kind: 'circle', counts: shapeCounts(counts, magicRingStart(6), { hEff: h }) };
  }
  const a = big / 2;
  const b = small / 2;
  const S = Math.max(1, roundHalfUp((2 * (a - b)) / w));
  const K = Math.max(1, roundHalfUp(b / h));
  const circ = Array.from({ length: K }, (_, k) => 6 * (k + 1));
  const counts = circ.map((c) => c + 2 * S);
  return {
    kind: 'oval',
    counts: shapeCounts(counts, chainOvalStart(S), { circ, ovalS: Array<number>(K).fill(S), hEff: h }),
    ...(approximated ? { approximated } : {}),
  };
}

/** Width of a closed polygon outline ([x, y, …]) at height y: the longest chord along x. */
export function outlineWidthAt(outline: ArrayLike<number>, y: number): number {
  const xs: number[] = [];
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = outline[2 * i];
    const y0 = outline[2 * i + 1];
    const x1 = outline[2 * ((i + 1) % n)];
    const y1 = outline[2 * ((i + 1) % n) + 1];
    if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
  }
  if (xs.length < 2) return 0;
  return Math.max(...xs) - Math.min(...xs);
}

/**
 * A flattened tube (§2.10.9) of a `flat` part, worked from its tip — `tip` = the local-Y end away from the
 * attachment — to its base, open for sewing. `cell` is the unstuffed stitch (s = 1).
 */
export function flattenedTube(part: Extract<Part, { type: 'flat' }>, tip: 'top' | 'bottom', cell: { w: number; h: number }): FlatShape {
  const { w, h } = cell;
  const layout = flatLayout(part.dims);
  const ys: number[] = [];
  for (let i = 1; i < layout.outline.length; i += 2) ys.push(layout.outline[i]);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const H = yMax - yMin;
  const K = Math.max(2, roundHalfUp(H / h));
  const step = H / K;
  const raw: number[] = [];
  for (let k = 1; k <= K; k++) {
    const y = tip === 'top' ? yMax - k * step : yMin + k * step;
    // the last round sits at the base edge: measure just inside it
    const yy = Math.min(yMax - 1e-6, Math.max(yMin + 1e-6, y));
    raw.push(2 * roundHalfUp(outlineWidthAt(layout.outline, yy) / w));
  }
  raw[0] = Math.min(8, Math.max(4, raw[0] % 2 === 0 ? raw[0] : raw[0] + 1));
  // even counts, never below 4, at most double or half of the round before
  const even = clampFan(raw.map((n) => Math.max(4, n))).map((n, i, arr) => (i === 0 || n % 2 === 0 ? n : Math.min(n + 1, 2 * arr[i - 1])));
  const counts = clampFan(even);
  return { kind: 'tube', counts: shapeCounts(counts, magicRingStart(counts[0]), { hEff: step }) };
}
