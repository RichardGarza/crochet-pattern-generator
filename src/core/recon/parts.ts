// Track T3 — part decomposition of a reconstructed volume (DESIGN.md §2.9.7 steps 1–3, 5).
//
//   1. body = the morphological opening of the volume with a ball of radius `openingFrac × height` (exact EDTs:
//      erode = inside samples farther than r from the outside, dilate = samples within r of the eroded set);
//   2. limbs = the 6-connected components of `volume − body` larger than 0.4% of the volume that stand out from the
//      body by at least `LIMB_MIN_DEPTH` × r (the deepest sample's distance from the opened body): the opening also
//      leaves shallow fillets in every concave corner, and a collar around a narrow neck, which are not limbs;
//      a residual component that touches two separate pieces of the opening (the neck between a head and a body that
//      the ball cannot pass) joins the body — the neck split (neck.ts) separates them again;
//   3. every inside sample gets a part: the body, a limb, or (small or shallow residuals) the part it touches most;
//   4. parents (§2.9.7 step 5): each part hangs from the earlier part (body, head, then limbs by decreasing volume)
//      it shares the largest interface with, so the result is one tree rooted at the body.
//
// Volumes are `Uint8Array` labels on the build lattice (x fastest, the `SdfVolume` / marching-cubes layout): 0 =
// outside, k = part k − 1.
import { edt3d, edtSquared3d } from '../kernel/geom/edt';

/** §2.9.7 step 1: limbs smaller than this fraction of the volume join the part they touch. */
export const LIMB_MIN_FRACTION = 0.004;
/** A residual component is a limb only if it reaches this far (× the opening radius) out of the opened body. */
export const LIMB_MIN_DEPTH = 0.1;
/** …and at least this many samples. */
export const LIMB_MIN_DEPTH_SAMPLES = 1.5;
/** At most this many parts (the model allows 60; labels are bytes). */
export const MAX_RECON_PARTS = 40;

export type Dims3 = readonly [number, number, number];

export interface PartRegion {
  /** Inside samples labeled with this part. */
  voxels: number;
  /** Index of the parent part, −1 for the root. */
  parent: number;
  kind: 'body' | 'head' | 'limb';
  /** Limbs: the deepest sample's distance from the opened body, in samples. */
  depth: number;
}

export interface Decomposition {
  dims: Dims3;
  /** 0 = outside, k = part k − 1. */
  label: Uint8Array<ArrayBuffer>;
  parts: PartRegion[];
  /** The opening radius, in samples. */
  radius: number;
  /** Inside samples in all. */
  inside: number;
}

/** 6-connected components of the samples where `member(i)` holds: per sample its component (−1 = not a member). */
export function components6(member: (i: number) => boolean, dims: Dims3): { labels: Int32Array<ArrayBuffer>; sizes: number[] } {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const labels = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(total);
  const sxy = nx * ny;
  for (let s = 0; s < total; s++) {
    if (labels[s] !== -1 || !member(s)) continue;
    const c = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = c;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / sxy);
      if (x > 0 && labels[i - 1] === -1 && member(i - 1)) (labels[i - 1] = c), (queue[tail++] = i - 1);
      if (x < nx - 1 && labels[i + 1] === -1 && member(i + 1)) (labels[i + 1] = c), (queue[tail++] = i + 1);
      if (y > 0 && labels[i - nx] === -1 && member(i - nx)) (labels[i - nx] = c), (queue[tail++] = i - nx);
      if (y < ny - 1 && labels[i + nx] === -1 && member(i + nx)) (labels[i + nx] = c), (queue[tail++] = i + nx);
      if (z > 0 && labels[i - sxy] === -1 && member(i - sxy)) (labels[i - sxy] = c), (queue[tail++] = i - sxy);
      if (z < nz - 1 && labels[i + sxy] === -1 && member(i + sxy)) (labels[i + sxy] = c), (queue[tail++] = i + sxy);
    }
    sizes.push(tail);
  }
  return { labels, sizes };
}

/** Calls `f(j)` for each 6-neighbor j of sample i inside the lattice. */
export function forNeighbors6(i: number, dims: Dims3, f: (j: number) => void): void {
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const x = i % nx;
  const y = Math.floor(i / nx) % ny;
  const z = Math.floor(i / sxy);
  if (x > 0) f(i - 1);
  if (x < nx - 1) f(i + 1);
  if (y > 0) f(i - nx);
  if (y < ny - 1) f(i + nx);
  if (z > 0) f(i - sxy);
  if (z < nz - 1) f(i + sxy);
}

/**
 * The morphological opening of `inside` (1 = inside) with a ball of radius `r` samples: the union of the balls of
 * radius r that fit inside (centers at least r + ½ from the nearest outside sample, i.e. r from the boundary
 * between samples). Also returns the eroded centers.
 */
export function openVolume(inside: Uint8Array, dims: Dims3, r: number): { opened: Uint8Array<ArrayBuffer>; eroded: Uint8Array<ArrayBuffer> } {
  const total = dims[0] * dims[1] * dims[2];
  const outside = new Uint8Array(total);
  for (let i = 0; i < total; i++) outside[i] = inside[i] ? 0 : 1;
  const dOut = edt3d(outside, dims);
  const eroded = new Uint8Array(total);
  let any = false;
  for (let i = 0; i < total; i++) {
    if (inside[i] && dOut[i] - 0.5 >= r) {
      eroded[i] = 1;
      any = true;
    }
  }
  const opened = new Uint8Array(total);
  if (!any) return { opened, eroded };
  const dE = edt3d(eroded, dims);
  for (let i = 0; i < total; i++) if (inside[i] && dE[i] <= r) opened[i] = 1;
  return { opened, eroded };
}

/** Distance (samples) from every sample to the nearest non-zero sample of `mask`, and that sample's index. */
export function edtNearest(mask: Uint8Array, dims: Dims3, nearest: Int32Array): Float32Array<ArrayBuffer> {
  const total = dims[0] * dims[1] * dims[2];
  const d = new Float32Array(total);
  for (let i = 0; i < total; i++) d[i] = mask[i] ? 0 : Infinity;
  edtSquared3d(d, dims, { nearest });
  for (let i = 0; i < total; i++) d[i] = Math.sqrt(d[i]);
  return d;
}

/** A deep piece must hold at least this fraction of its limb's deep samples to count as a limb of its own. */
export const DEPTH_SPLIT_MIN_SHARE = 0.15;

/**
 * Splits grown limbs (`grown[i]` = limb of sample i, −1 = none) whose samples deeper than half the limb's depth form
 * several 6-connected pieces, each ≥ 15% of those samples and ≥ ¼ of the minimum limb size: the limb keeps the
 * largest piece and every other piece becomes a new limb (appended); each sample goes to the nearest piece.
 * `sizes` and `depth` are updated.
 */
export function splitByDepth(grown: Int32Array, sizes: number[], depth: number[], dO: ArrayLike<number>, dims: Dims3, minLimb: number): void {
  const total = grown.length;
  const n0 = sizes.length;
  for (let c = 0; c < n0; c++) {
    if (sizes[c] < 2 * minLimb * 0.25 || sizes.length >= 250) continue;
    const tau = depth[c] / 2;
    const deep = components6((i) => grown[i] === c && dO[i] >= tau, dims);
    const deepTotal = deep.sizes.reduce((a, b) => a + b, 0);
    const big = deep.sizes.map((n, k) => [n, k]).filter(([n]) => n >= DEPTH_SPLIT_MIN_SHARE * deepTotal && n >= 0.25 * minLimb).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    if (big.length < 2) continue;
    // the nearest deep piece of every sample of the limb
    const seeds = new Uint8Array(total);
    const pieceOf = new Int32Array(total).fill(-1);
    for (let i = 0; i < total; i++) {
      const k = deep.labels[i];
      if (k < 0) continue;
      const rank = big.findIndex(([, kk]) => kk === k);
      if (rank < 0) continue;
      seeds[i] = 1;
      pieceOf[i] = rank;
    }
    const nearest = new Int32Array(total);
    edtNearest(seeds, dims, nearest);
    const ids = big.map((_, r) => (r === 0 ? c : sizes.length + r - 1));
    for (let r = 1; r < big.length; r++) {
      sizes.push(0);
      depth.push(0);
    }
    sizes[c] = 0;
    depth[c] = 0;
    for (let i = 0; i < total; i++) {
      if (grown[i] !== c) continue;
      const id = ids[pieceOf[nearest[i]]];
      grown[i] = id;
      sizes[id]++;
      if (dO[i] > depth[id]) depth[id] = dO[i];
    }
  }
}

/** Union–find over small integer ids. */
class Dsu {
  private readonly p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(a: number): number {
    let r = a;
    while (this.p[r] !== r) r = this.p[r];
    while (this.p[a] !== r) {
      const next = this.p[a];
      this.p[a] = r;
      a = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** The sample counts each part shares with each other part across 6-neighbor faces (symmetric, parts × parts). */
export function interfaces(label: Uint8Array, dims: Dims3, parts: number): Float64Array<ArrayBuffer> {
  const [nx, ny, nz] = dims;
  const out = new Float64Array(parts * parts);
  const sxy = nx * ny;
  const total = nx * ny * nz;
  for (let i = 0; i < total; i++) {
    const a = label[i];
    if (a === 0) continue;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / sxy);
    const visit = (j: number): void => {
      const b = label[j];
      if (b !== 0 && b !== a) {
        out[(a - 1) * parts + (b - 1)] += 1;
        out[(b - 1) * parts + (a - 1)] += 1;
      }
    };
    if (x < nx - 1) visit(i + 1);
    if (y < ny - 1) visit(i + nx);
    if (z < nz - 1) visit(i + sxy);
  }
  return out;
}

/**
 * Re-labels every sample of part k that is not in k's largest 6-connected piece with the part that piece touches
 * most (pieces touching nothing join the root). Run after any operation that may split a part.
 */
export function keepConnected(label: Uint8Array, dims: Dims3, parts: number): void {
  for (let k = 1; k <= parts; k++) {
    const { labels, sizes } = components6((i) => label[i] === k, dims);
    if (sizes.length <= 1) continue;
    let main = 0;
    for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
    for (let c = 0; c < sizes.length; c++) {
      if (c === main) continue;
      const touch = new Map<number, number>();
      const members: number[] = [];
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== c) continue;
        members.push(i);
        forNeighbors6(i, dims, (j) => {
          const b = label[j];
          if (b !== 0 && b !== k) touch.set(b, (touch.get(b) ?? 0) + 1);
        });
      }
      let to = 1;
      let best = -1;
      for (const [b, n] of [...touch].sort((p, q) => p[0] - q[0])) {
        if (n > best) {
          best = n;
          to = b;
        }
      }
      for (const i of members) label[i] = to;
    }
  }
}

/**
 * Gives every sample of `pending` (inside samples with label 0) the label most of its 6-neighbors have, breadth first
 * from the labeled ones (ties → the lower label), so a fillet joins the part it touches; samples that no labeled
 * sample reaches join the root (label 1).
 */
export function growInto(label: Uint8Array, dims: Dims3, pending: number[]): void {
  let queue = pending;
  while (queue.length > 0) {
    const next: number[] = [];
    const assign: [number, number][] = [];
    for (const i of queue) {
      let best = 0;
      let bestCount = 0;
      const counts = new Map<number, number>();
      forNeighbors6(i, dims, (j) => {
        const b = label[j];
        if (b !== 0) counts.set(b, (counts.get(b) ?? 0) + 1);
      });
      for (const [b, n] of counts) if (n > bestCount || (n === bestCount && b < best)) (best = b), (bestCount = n);
      if (best > 0) assign.push([i, best]);
      else next.push(i);
    }
    if (assign.length === 0) {
      for (const i of next) label[i] = 1;
      return;
    }
    for (const [i, b] of assign) label[i] = b;
    queue = next;
  }
}

/** A limb that shares at least this fraction of its largest interface with a second part is a fillet between them. */
export const FILLET_SECOND_INTERFACE = 0.25;

/**
 * Dissolves limbs that sit between two parts (a collar left by the opening around a neck, once the neck split has
 * made the head a part of its own): their samples join the neighboring parts (`growInto`).
 */
export function dissolveFillets(d: Decomposition): Decomposition {
  const n = d.parts.length;
  const shared = interfaces(d.label, d.dims, n);
  const drop = new Set<number>();
  for (let k = 0; k < n; k++) {
    if (d.parts[k].kind !== 'limb') continue;
    const row = Array.from(shared.subarray(k * n, k * n + n)).filter((_, j) => j !== k && !drop.has(j)).sort((a, b) => b - a);
    if (row.length >= 2 && row[0] > 0 && row[1] >= FILLET_SECOND_INTERFACE * row[0]) drop.add(k);
  }
  if (drop.size === 0) return d;
  const pending: number[] = [];
  for (let i = 0; i < d.label.length; i++) {
    if (d.label[i] > 0 && drop.has(d.label[i] - 1)) {
      d.label[i] = 0;
      pending.push(i);
    }
  }
  // grow without the root fallback swallowing whole pieces: pending samples only take labels of kept parts
  growInto(d.label, d.dims, pending);
  return finishParts(d);
}

/** A merged pair splits when the middle of its x profile holds less than this fraction of each side's peak. */
export const PAIR_VALLEY = 0.5;
/** …and each side holds at least this fraction of the limb. */
export const PAIR_MIN_SIDE = 0.3;

/** A limb reaching the lowest part of the model splits as a pair when it is this much wider than tall or deep. */
export const PAIR_WIDE = 1.5;
/** "The lowest part": the lowest 15% of the inside samples' height (§2.9.7 step 6's leg rule). */
export const PAIR_LOW = 0.15;

/**
 * Splits limbs that are two mirror twins merged across the symmetry plane x = `plane`, the side x < plane becoming a
 * new limb, when each side holds ≥ 30% of the limb (and ≥ `o.minLimb` samples) and either
 *   - its sample count per x column dips around the plane below half of each side's peak (legs that touch), or
 *   - it is attached to the root, reaches the lowest 15% of the model's height and is ≥ 1.5× wider (x) than its
 *     height or depth: legs merged by the visual hull's phantom volume, which a top view cannot open when the head
 *     hangs over them (§2.9.7 step 1 calls merged legs a known miss; this catches the common one). Only when a photo
 *     shows the width (`o.widthSeen`, default true): a side photo's width is the inflation's guess.
 */
export function splitMergedPairs(d: Decomposition, plane: number, o: { widthSeen?: boolean; minLimb?: number } = {}): Decomposition {
  const [nx, ny] = d.dims;
  let parts = d.parts.slice();
  const label = d.label;
  const n0 = parts.length;
  let ylo = ny;
  let yhi = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === 0) continue;
    const y = Math.floor(i / nx) % ny;
    if (y < ylo) ylo = y;
    if (y > yhi) yhi = y;
  }
  const lowLimit = ylo + PAIR_LOW * (yhi - ylo + 1);
  for (let k = 0; k < n0; k++) {
    if (parts[k].kind !== 'limb' || parts.length >= MAX_RECON_PARTS) continue;
    const prof = new Float64Array(nx);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < label.length; i++) {
      if (label[i] !== k + 1) continue;
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      prof[x]++;
      const q = [x, y, z];
      for (let a = 0; a < 3; a++) {
        if (q[a] < lo[a]) lo[a] = q[a];
        if (q[a] > hi[a]) hi[a] = q[a];
      }
    }
    const ext = [0, 1, 2].map((a) => hi[a] - lo[a] + 1);
    const c = Math.floor(plane);
    let left = 0;
    let right = 0;
    let peakL = 0;
    let peakR = 0;
    for (let x = 0; x < nx; x++) {
      if (x < plane) {
        left += prof[x];
        peakL = Math.max(peakL, prof[x]);
      } else {
        right += prof[x];
        peakR = Math.max(peakR, prof[x]);
      }
    }
    const total = left + right;
    if (!(total > 0) || left < PAIR_MIN_SIDE * total || right < PAIR_MIN_SIDE * total) continue;
    const valley = Math.min(prof[Math.max(0, c)], prof[Math.min(nx - 1, c + 1)]);
    const dip = valley < PAIR_VALLEY * Math.min(peakL, peakR);
    const lowWide = o.widthSeen !== false && parts[k].parent === 0 && lo[1] <= lowLimit && ext[0] >= PAIR_WIDE * Math.min(ext[1], ext[2]);
    if (!dip && !lowWide) continue;
    if (o.minLimb !== undefined && Math.min(left, right) < o.minLimb) continue;
    const id = parts.length + 1;
    for (let i = 0; i < label.length; i++) if (label[i] === k + 1 && i % nx < plane) label[i] = id;
    parts = [...parts, { ...parts[k], voxels: 0 }];
  }
  if (parts.length === n0) return d;
  return finishParts({ ...d, parts });
}

/**
 * Decomposes the inside samples (`field ≥ 0`) of an N-lattice volume into a body and limbs (§2.9.7 step 1).
 * `openingFrac` × the height of the inside samples is the opening radius.
 */
export function decompose(field: ArrayLike<number>, dims: Dims3, o: { openingFrac: number; minLimbFraction?: number; minDepth?: number }): Decomposition {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const inside = new Uint8Array(total);
  let count = 0;
  let ylo = ny;
  let yhi = -1;
  for (let i = 0; i < total; i++) {
    if (field[i] >= 0) {
      inside[i] = 1;
      count++;
      const y = Math.floor(i / nx) % ny;
      if (y < ylo) ylo = y;
      if (y > yhi) yhi = y;
    }
  }
  const label = new Uint8Array(total);
  if (count === 0) return { dims, label, parts: [], radius: 0, inside: 0 };
  const radius = Math.max(1, o.openingFrac * (yhi - ylo + 1));
  const minLimb = (o.minLimbFraction ?? LIMB_MIN_FRACTION) * count;
  const minDepth = Math.max(LIMB_MIN_DEPTH_SAMPLES, (o.minDepth ?? LIMB_MIN_DEPTH) * radius);
  const single = (): Decomposition => {
    for (let i = 0; i < total; i++) if (inside[i]) label[i] = 1;
    return { dims, label, parts: [{ voxels: count, parent: -1, kind: 'body', depth: 0 }], radius, inside: count };
  };

  const { opened } = openVolume(inside, dims, radius);
  const oc = components6((i) => opened[i] === 1, dims);
  if (oc.sizes.length === 0) return single(); // nothing as thick as the ball: one part
  const rc = components6((i) => inside[i] === 1 && opened[i] === 0, dims);
  const nO = oc.sizes.length;
  const nR = rc.sizes.length;

  // which opened pieces each residual component touches
  const touches: Set<number>[] = Array.from({ length: nR }, () => new Set<number>());
  for (let i = 0; i < total; i++) {
    const r = rc.labels[i];
    if (r < 0) continue;
    forNeighbors6(i, dims, (j) => {
      const c = oc.labels[j];
      if (c >= 0) touches[r].add(c);
    });
  }
  // bridges: residuals touching ≥ 2 opened pieces merge them
  const dsu = new Dsu(nO);
  const bridge = new Uint8Array(nR);
  for (let r = 0; r < nR; r++) {
    if (touches[r].size < 2) continue;
    bridge[r] = 1;
    const [first, ...rest] = [...touches[r]];
    for (const c of rest) dsu.union(first, c);
  }
  // the body: the group of opened pieces holding the most samples (with its bridges)
  const groupSize = new Map<number, number>();
  for (let c = 0; c < nO; c++) groupSize.set(dsu.find(c), (groupSize.get(dsu.find(c)) ?? 0) + oc.sizes[c]);
  for (let r = 0; r < nR; r++) if (bridge[r]) groupSize.set(dsu.find([...touches[r]][0]), (groupSize.get(dsu.find([...touches[r]][0])) ?? 0) + rc.sizes[r]);
  let bodyGroup = -1;
  for (const [g, n] of [...groupSize].sort((a, b) => a[0] - b[0])) if (bodyGroup < 0 || n > (groupSize.get(bodyGroup) ?? 0)) bodyGroup = g;

  // limb cores: residual samples at least `minDepth` from the opened body, as 6-connected pieces. A thin shell
  // (fillets in concave corners, the rims of the hull's edges) connects the limbs of a reconstruction; the cores
  // do not reach into it.
  const dO = edt3d(opened, dims);
  const notBridge = (i: number): boolean => {
    const r = rc.labels[i];
    return r >= 0 && !(bridge[r] && dsu.find([...touches[r]][0]) === bodyGroup);
  };
  const cc = components6((i) => notBridge(i) && dO[i] >= minDepth, dims);
  // each core grows back over the residual samples within `minDepth` of it (the limb's root, down to the body)
  const coreMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (cc.labels[i] >= 0) coreMask[i] = 1;
  const nearest = new Int32Array(total);
  const dC = edtNearest(coreMask, dims, nearest);
  const grown = new Int32Array(total).fill(-1);
  const sizes: number[] = new Array<number>(cc.sizes.length).fill(0);
  const depth: number[] = new Array<number>(cc.sizes.length).fill(0);
  for (let i = 0; i < total; i++) {
    if (!notBridge(i)) continue;
    if (cc.labels[i] >= 0 || dC[i] <= minDepth + 0.5) {
      const c = cc.labels[i] >= 0 ? cc.labels[i] : cc.labels[nearest[i]];
      if (c < 0) continue;
      grown[i] = c;
      sizes[c]++;
      if (dO[i] > depth[c]) depth[c] = dO[i];
    }
  }
  // a limb whose deeper half falls apart into separate pieces is several limbs merged near the body (legs joined by
  // the phantom web of a visual hull): split it, each sample going to the nearest deep piece
  splitByDepth(grown, sizes, depth, dO, dims, minLimb);
  const limbs: number[] = [];
  for (let c = 0; c < sizes.length; c++) if (sizes[c] >= minLimb) limbs.push(c);
  limbs.sort((a, b) => sizes[b] - sizes[a] || a - b);
  limbs.length = Math.min(limbs.length, MAX_RECON_PARTS - 1);
  const limbIndex = new Int32Array(sizes.length).fill(-1);
  limbs.forEach((c, k) => (limbIndex[c] = k));

  // labels: body = 1, limb k = k + 2; everything else is decided by contact below
  const pending: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!inside[i]) continue;
    const c = oc.labels[i];
    if (c >= 0) {
      if (dsu.find(c) === bodyGroup) label[i] = 1;
      else pending.push(i);
      continue;
    }
    const g = grown[i];
    if (g >= 0 && limbIndex[g] >= 0) label[i] = limbIndex[g] + 2;
    else if (!notBridge(i)) label[i] = 1;
    else pending.push(i);
  }
  growInto(label, dims, pending);
  const nParts = limbs.length + 1;
  keepConnected(label, dims, nParts);
  const parts: PartRegion[] = [{ voxels: 0, parent: -1, kind: 'body', depth: 0 }, ...limbs.map((c) => ({ voxels: 0, parent: 0, kind: 'limb' as const, depth: depth[c] }))];
  return finishParts({ dims, label, parts, radius, inside: count });
}

/**
 * Recounts the samples of every part, drops parts left without samples (re-indexing the labels) and sets each
 * part's parent: the earlier part with the largest interface (the root keeps −1; no interface → the root).
 */
export function finishParts(d: Decomposition): Decomposition {
  const { label, dims } = d;
  const n = d.parts.length;
  const counts = new Float64Array(n);
  for (let i = 0; i < label.length; i++) if (label[i] > 0) counts[label[i] - 1]++;
  const keep: number[] = [];
  for (let k = 0; k < n; k++) if (counts[k] > 0 || k === 0) keep.push(k);
  const remap = new Uint8Array(n + 1);
  keep.forEach((k, j) => (remap[k + 1] = j + 1));
  if (keep.length !== n) for (let i = 0; i < label.length; i++) label[i] = remap[label[i]];
  const parts = keep.map((k) => ({ ...d.parts[k], voxels: counts[k] }));
  const m = parts.length;
  const shared = interfaces(label, dims, m);
  for (let k = 0; k < m; k++) {
    if (k === 0) {
      parts[k].parent = -1;
      continue;
    }
    let best = 0;
    let bestN = -1;
    for (let j = 0; j < k; j++) {
      const s = shared[k * m + j];
      if (s > bestN) {
        bestN = s;
        best = j;
      }
    }
    parts[k].parent = best;
  }
  return { ...d, parts };
}
