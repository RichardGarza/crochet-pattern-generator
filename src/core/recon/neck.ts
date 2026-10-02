// Track T3 — the neck split (DESIGN.md §2.9.7 step 2, `ReconSettings.splitNeck`, the build panel's "Split head at
// the neck").
//
// The body part's 24 rings along its PCA axis (`ringProfile` of fit.ts, the same rings as the fit) on its outer
// surface samples (the part's samples with a 6-neighbor outside the volume, i.e. not the faces it shares with its
// limbs). An interior ring i is a neck when r_i < 0.75 × min(max(r_0 … r_{i−1}), max(r_{i+1} … r_23)) and the plane
// through the ring's middle, perpendicular to the axis, leaves ≥ 15% of the part's samples on each side; the
// deepest such ring (smallest r_i / that minimum) wins. The piece whose centroid is higher becomes the head,
// attached to the other.
import type { Vec3 } from '../../types/geometry';
import { FIT_RINGS, pcaFrame, ringProfile, type SurfaceSamples } from './fit';
import { finishParts, forNeighbors6, keepConnected, type Decomposition } from './parts';

/** §2.9.7 step 2: a ring narrower than this fraction of the larger rings on both sides is a neck. */
export const NECK_RATIO = 0.75;
/** §2.9.7 step 2: each side keeps at least this fraction of the part's volume. */
export const NECK_MIN_SIDE = 0.15;

export interface NeckCut {
  /** The ring of the cut (1 … 22). */
  ring: number;
  /** r_i / min(max before, max after). */
  ratio: number;
  /** The plane: points p with (p − origin)·axis = t, in lattice coordinates (samples). */
  origin: Vec3;
  axis: Vec3;
  t: number;
  /** Mean ring radii (samples), for diagnostics. */
  radii: number[];
  /** Fractions of the part's samples on the low (t < cut) and high side. */
  sides: [number, number];
}

/** The outer surface samples of part `k` (label k + 1) as unit-weight points in lattice coordinates. */
export function outerSurface(d: Decomposition, k: number): SurfaceSamples {
  const [nx, ny] = d.dims;
  const pts: number[] = [];
  const want = k + 1;
  for (let i = 0; i < d.label.length; i++) {
    if (d.label[i] !== want) continue;
    let outer = false;
    forNeighbors6(i, d.dims, (j) => {
      if (d.label[j] === 0) outer = true;
    });
    // a sample on the lattice border counts as outer too
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    if (outer || x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === d.dims[2] - 1) pts.push(x, y, z);
  }
  const p = Float64Array.from(pts);
  return { p, w: new Float64Array(pts.length / 3).fill(1), count: pts.length / 3, area: pts.length / 3, v: p };
}

/** The neck of part `k` (§2.9.7 step 2), or null when it has none. */
export function findNeck(d: Decomposition, k: number): NeckCut | null {
  const s = outerSurface(d, k);
  if (s.count < 3 * FIT_RINGS) return null;
  const f = pcaFrame(s);
  const axis = f.axes[0];
  const rp = ringProfile(s, f.centroid, axis, FIT_RINGS);
  const n = rp.n;
  const r = Array.from(rp.mean);
  // part samples per axial position, for the volume test
  const [nx, ny] = d.dims;
  const want = k + 1;
  const ts: number[] = [];
  for (let i = 0; i < d.label.length; i++) {
    if (d.label[i] !== want) continue;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    ts.push((x - f.centroid[0]) * axis[0] + (y - f.centroid[1]) * axis[1] + (z - f.centroid[2]) * axis[2]);
  }
  ts.sort((a, b) => a - b);
  const below = (t: number): number => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ts[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  let best: NeckCut | null = null;
  for (let i = 1; i < n - 1; i++) {
    if (!(rp.area[i] > 0)) continue;
    let before = 0;
    let after = 0;
    for (let j = 0; j < i; j++) before = Math.max(before, r[j]);
    for (let j = i + 1; j < n; j++) after = Math.max(after, r[j]);
    const ref = Math.min(before, after);
    if (!(ref > 0) || !(r[i] < NECK_RATIO * ref)) continue;
    const t = rp.t0 + (i + 0.5) * rp.dt;
    const lowFrac = below(t) / ts.length;
    if (lowFrac < NECK_MIN_SIDE || 1 - lowFrac < NECK_MIN_SIDE) continue;
    const ratio = r[i] / ref;
    if (!best || ratio < best.ratio) best = { ring: i, ratio, origin: f.centroid, axis, t, radii: r, sides: [lowFrac, 1 - lowFrac] };
  }
  return best;
}

/**
 * Cuts part `k` at the neck: the piece with the higher centroid (larger y) becomes a new part of kind `head`,
 * inserted right after `k`, attached to it; parents are recomputed (`finishParts`). Returns the decomposition
 * unchanged when the cut would leave a side empty.
 */
export function splitAtNeck(d: Decomposition, k: number, cut: NeckCut): Decomposition {
  const [nx, ny] = d.dims;
  const want = k + 1;
  const high: number[] = [];
  const low: number[] = [];
  let yHigh = 0;
  let yLow = 0;
  for (let i = 0; i < d.label.length; i++) {
    if (d.label[i] !== want) continue;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    const t = (x - cut.origin[0]) * cut.axis[0] + (y - cut.origin[1]) * cut.axis[1] + (z - cut.origin[2]) * cut.axis[2];
    if (t >= cut.t) {
      high.push(i);
      yHigh += y;
    } else {
      low.push(i);
      yLow += y;
    }
  }
  if (high.length === 0 || low.length === 0) return d;
  const headSide = yHigh / high.length >= yLow / low.length ? high : low;
  // labels after k shift by one to make room for the head at k + 1
  const n = d.parts.length;
  if (n >= 255) return d;
  const label = d.label;
  for (let i = 0; i < label.length; i++) if (label[i] > want) label[i] += 1;
  for (const i of headSide) label[i] = want + 1;
  const parts = [...d.parts.slice(0, k + 1), { voxels: headSide.length, parent: k, kind: 'head' as const, depth: 0 }, ...d.parts.slice(k + 1)];
  keepConnected(label, d.dims, parts.length);
  return finishParts({ ...d, label, parts });
}
