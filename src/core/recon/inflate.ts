// Track T3 — local thickness and inflation height of a silhouette (DESIGN.md §2.9.3, research 04 §5.1).
//
//   T(p) = √( d(p) · (2·R_loc(p) − d(p)) )
//
// d = the inside EDT (Step 0 `edt2d` of the background, i.e. `max(signedEdt2d(…, 'samples'), 0)`: the distance
// from an inside pixel center to the nearest outside pixel center), R_loc(p) = the radius of the largest inscribed
// disc that contains p ("paint ridge discs in increasing radius order"; painting with max is the same thing and
// needs no sort). T is exact for a disc (a hemisphere: d = R − ρ, R_loc = R ⇒ T = √(R² − ρ²)) and for a strip of
// constant width (a semicircular tube), which one Poisson constant cannot do (research 04 §5.1).
//
// Ridge pixels: an inside pixel q whose disc (radius d(q)) is not contained in the disc of one of its 8 neighbors
// n. Exact containment is d(n) ≥ d(q) + |n − q|; on a pixel grid the nearest outside pixel moves in steps, so the
// discs of a smooth outline's interior pixels miss containment by a fraction of a pixel and almost every pixel
// would count as a ridge (cost: the sum of their disc areas). A pixel counts as contained when
// d(n) ≥ d(q) + |n − q| − RIDGE_SLACK·|n − q|; what the slack drops is a sliver at most RIDGE_SLACK px wide at
// the far side of a disc that a larger neighboring disc covers otherwise (measured in the tests: the disc's
// hemisphere stays within 2%, the strip's profile stays a semicircle).
//
// The photo frame counts as outside (the mask is padded with one background pixel), as in align.ts.
import { edt2d } from '../kernel/geom/edt';

/** Fraction of a neighbor step by which a disc may miss containment and still not count as a ridge disc. */
export const RIDGE_SLACK = 0.35;

export interface LocalThickness {
  w: number;
  h: number;
  /** Inside EDT, world units (`spacing` per pixel); 0 outside. */
  d: Float32Array<ArrayBuffer>;
  /** Radius of the largest inscribed disc containing the pixel, world units; 0 outside. */
  R: Float32Array<ArrayBuffer>;
  /** Number of ridge pixels painted (diagnostics). */
  ridge: number;
}

function checkMask(mask: ArrayLike<number>, w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError(`mask size must be integers ≥ 1, got ${w} × ${h}`);
  if (mask.length !== w * h) throw new RangeError(`mask has ${mask.length} entries, expected ${w * h}`);
}

function checkSpacing(spacing: number): void {
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError(`spacing must be a finite number > 0, got ${spacing}`);
}

/**
 * The inside EDT `d` and the local thickness radius `R_loc` of a mask (1 = inside, row-major), in world units
 * (`spacing` = world units per pixel, default 1). Deterministic.
 */
export function localThickness(mask: ArrayLike<number>, w: number, h: number, o: { spacing?: number } = {}): LocalThickness {
  checkMask(mask, w, h);
  const spacing = o.spacing ?? 1;
  checkSpacing(spacing);
  // Padded background mask: 1 = outside (the seeds of the inside distance), the frame included.
  const W = w + 2;
  const H = h + 2;
  const outside = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[x + w * y] !== 0) outside[x + 1 + W * (y + 1)] = 0;
  const dp = edt2d(outside, W, H); // pixels; 0 outside; finite (the frame is outside)

  const R = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) R[i] = dp[i];
  const STEP = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  let ridge = 0;
  // Paints R ← max(R, r) over the inside pixels p = q + (dx, dy) with rIn² < dx² + dy² ≤ r² (rIn ≤ 0: the whole
  // disc) and, when `cap`, dx·ux + dy·uy ≤ c0. Iterates along the axis on which the cap is thin.
  const paint = (x: number, y: number, r: number, rIn: number, cap: boolean, ux: number, uy: number, c0: number): void => {
    const r2 = r * r;
    const in2 = rIn > 0 ? rIn * rIn : -1;
    const n = Math.floor(r);
    const byRows = !cap || Math.abs(uy) >= Math.abs(ux);
    // t: offset along the iterated axis, s: along the other one; (us, ut) = the cap normal in (s, t).
    const us = byRows ? ux : uy;
    const ut = byRows ? uy : ux;
    const tLo = byRows ? Math.max(-n, 1 - y) : Math.max(-n, 1 - x);
    const tHi = byRows ? Math.min(n, h - y) : Math.min(n, w - x);
    const sLimLo = byRows ? 1 - x : 1 - y;
    const sLimHi = byRows ? w - x : h - y;
    for (let t = tLo; t <= tHi; t++) {
      let sMin = sLimLo;
      let sMax = sLimHi;
      if (cap) {
        const room = c0 - t * ut;
        if (us > 0) sMax = Math.min(sMax, Math.floor(room / us));
        else if (us < 0) sMin = Math.max(sMin, Math.ceil(room / us));
        else if (room < 0) continue;
        if (sMin > sMax) continue;
      }
      const outer = Math.floor(Math.sqrt(r2 - t * t));
      const inner = in2 - t * t;
      const hole = inner >= 0 ? Math.floor(Math.sqrt(inner)) : -1; // |s| ≤ hole lies inside the inner circle
      for (let side = 0; side < 2; side++) {
        let a = side === 0 ? -outer : hole + 1;
        let b = side === 0 ? -hole - 1 : outer;
        if (hole < 0) {
          if (side === 1) break;
          b = outer;
        }
        if (a < sMin) a = sMin;
        if (b > sMax) b = sMax;
        if (byRows) {
          const row = W * (y + t) + x;
          for (let s = a; s <= b; s++) {
            const p = row + s;
            if (dp[p] !== 0 && R[p] < r) R[p] = r;
          }
        } else {
          const col = x + t + W * y;
          for (let s = a; s <= b; s++) {
            const p = col + W * s;
            if (dp[p] !== 0 && R[p] < r) R[p] = r;
          }
        }
      }
    }
  };
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const q = x + W * y;
      const r = dp[q];
      if (r === 0) continue;
      let k = 0;
      while (k < 8 && dp[q + DX[k] + W * DY[k]] < r + STEP[k] * (1 - RIDGE_SLACK)) k++;
      if (k === 8) {
        ridge++;
        paint(x, y, r, -1, false, 0, 0, 0);
      } else {
        // Contained (up to the slack) in the disc of the neighbor n = q + step·u, whose radius is larger: a pixel
        // p of this disc that n's disc misses lies on the outer ring (|p − q| > r − slack·step) and on the far
        // side, (p − q)·u < s·step − (1 − s)·(r − s·step) (from |p − n| > r + (1 − s)·step). Paint only that cap.
        const st = STEP[k];
        const c0 = RIDGE_SLACK * st - (1 - RIDGE_SLACK) * (r - RIDGE_SLACK * st) + 1e-6;
        paint(x, y, r, r - RIDGE_SLACK * st, true, DX[k] / st, DY[k] / st, c0);
      }
    }
  }
  const d = new Float32Array(w * h);
  const Rw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = x + 1 + W * (y + 1);
      d[x + w * y] = dp[p] * spacing;
      Rw[x + w * y] = R[p] * spacing;
    }
  }
  return { w, h, d, R: Rw, ridge };
}

/** `T = √(d·(2R − d))` per pixel (world units); 0 outside. */
export function inflationFromThickness(lt: Pick<LocalThickness, 'd' | 'R'>): Float32Array<ArrayBuffer> {
  const { d, R } = lt;
  const T = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const di = d[i];
    if (di > 0) T[i] = Math.sqrt(di * Math.max(2 * R[i] - di, di));
  }
  return T;
}

/** The inflation height T of a mask (§2.9.3), world units (`spacing` per pixel). */
export function inflationHeight(mask: ArrayLike<number>, w: number, h: number, o: { spacing?: number } = {}): Float32Array<ArrayBuffer> {
  return inflationFromThickness(localThickness(mask, w, h, o));
}
