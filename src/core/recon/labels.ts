// Track T3 — colors from photos (DESIGN.md §2.9.6): the joint palette of the photos, their label images, the
// per-vertex vote and the protected components.
//
//   Joint palette: the masked pixels of every view together, in the shading-robust feature of §2.4.1 (the top 2% of
//   OKLab L clipped first), pooled on a 0.004 lattice (exact colors stay exact), quantized for K = 1 … 8 (variance
//   split + weighted Lloyd); K = the smallest exact one, else 1 when one color explains everything (D(1) ≤ 0.025),
//   else the knee of D(K) (§2.4.3). Salience (§2.4.3, simplified): pooled colors ≥ ΔE00 20 from their center that
//   cover ≥ 2 connected pixels form a protected center of their own while the budget lasts. Centers are ordered by
//   population (label 0 = the main color); the palette color of a center is the mean OKLab of its pixels.
//   Label images: per view, Int8 on the mask grid, −1 outside the mask (`PhotoView.labelsKey`, codec §5.5.6).
//
//   Vote: among the views where a vertex is visible (its depth toward the camera within 2.5 voxels of the view's
//   first-hit depth map, scanned along the view axis on the build lattice) and lands inside the mask eroded by 2 px,
//   the view maximizing (n·c)² gives the label.
//
//   Protected components (§2.9.6): 4-connected same-label components of a label image that are salient, would be an
//   eye (≤ 0.6 in across, OKLab L < 0.25, §2.10.1 rule 1) or embroidery (circumference π·extent < 12·wS, rule 2), or
//   are smaller than 6 stitches (6·wS·hS). Their surrounding label is the most common label just outside them.
import type { RgbaImage, Vec3 } from '../../types/geometry';
import { ciede2000, linearToSrgb8, oklabToHex, oklabToLinearRgb, shadingRobustFeature, srgb8ToLinear, srgb8ToOklab, xyzToLab, linearRgbToXyz } from '../kernel/color';
import type { ReconGrid } from './align';
import { erode } from './masks';

/** §2.9.6: at most this many photo colors. */
export const MAX_PHOTO_COLORS = 8;
/** One color when the whole population is within this RMS feature distance of its mean. */
export const ONE_COLOR_D = 0.025;
/** Pooling lattice of the features (≈ 0.2 JND). */
export const POOL_STEP = 0.004;
/** §2.4.3 salience: ΔE00 from the assigned center. */
export const SALIENT_DE = 20;
/** §2.9.6: visibility tolerance, in voxels. */
export const VISIBLE_VOXELS = 2.5;
/** §2.9.6: the mask is eroded by this many pixels before labels are read. */
export const LABEL_ERODE_PX = 2;

export interface ColorView {
  id: string;
  /** The photo on the mask grid (same w, h as the mask). */
  image: RgbaImage;
  mask: ArrayLike<number>;
  w: number;
  h: number;
}

export interface PhotoPaletteResult {
  /** Label index → color (`ProjectDoc.threeD.photoPalette`). */
  colors: { hex: string; name: string }[];
  /** Per center: the salience guard made it. */
  salient: boolean[];
  /** Per view id: labels on the mask grid, −1 outside the mask. */
  labels: Record<string, Int8Array<ArrayBuffer>>;
  /** Per center: its pixels in all views. */
  population: number[];
  /** Per center: mean OKLab. */
  oklab: [number, number, number][];
}

// ------------------------------------------------------------------------------------------------ resampling

/**
 * The photo on a w × h grid: itself when it already is, else an area-weighted box filter in linear light when the
 * aspect ratios agree within 2%; null when they do not (a placeholder image, or a photo that is not the mask's).
 */
export function imageOnMaskGrid(img: RgbaImage, w: number, h: number): RgbaImage | null {
  if (!img || !(img.w > 0 && img.h > 0) || img.data?.length !== img.w * img.h * 4) return null;
  if (img.w === w && img.h === h) return img;
  if (Math.abs(img.w / img.h / (w / h) - 1) > 0.02) return null;
  const xs = boxWeights(img.w, w);
  const ys = boxWeights(img.h, h);
  const out = new Uint8ClampedArray(w * h * 4);
  const acc = new Float64Array(4);
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      acc.fill(0);
      let W = 0;
      for (const [y, wy] of ys[Y]) {
        for (const [x, wx] of xs[X]) {
          const k = 4 * (x + img.w * y);
          const wt = wx * wy;
          acc[0] += wt * srgb8ToLinear(img.data[k]);
          acc[1] += wt * srgb8ToLinear(img.data[k + 1]);
          acc[2] += wt * srgb8ToLinear(img.data[k + 2]);
          acc[3] += wt * img.data[k + 3];
          W += wt;
        }
      }
      const o = 4 * (X + w * Y);
      out[o] = linearToSrgb8(acc[0] / W);
      out[o + 1] = linearToSrgb8(acc[1] / W);
      out[o + 2] = linearToSrgb8(acc[2] / W);
      out[o + 3] = Math.round(acc[3] / W);
    }
  }
  return { w, h, data: out };
}

/** For each target cell, the source cells it overlaps and the overlap length. */
function boxWeights(src: number, dst: number): [number, number][][] {
  const f = src / dst;
  const out: [number, number][][] = [];
  for (let i = 0; i < dst; i++) {
    const a = i * f;
    const b = (i + 1) * f;
    const cells: [number, number][] = [];
    for (let s = Math.floor(a); s < Math.min(src, Math.ceil(b)); s++) {
      const wgt = Math.min(b, s + 1) - Math.max(a, s);
      if (wgt > 1e-12) cells.push([s, wgt]);
    }
    out.push(cells);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the palette

interface Pool {
  /** Feature sums and OKLab sums per pooled point. */
  f: number[];
  lab: number[];
  n: number[];
}

/** Weighted SSE of a cluster of pooled points around its mean. */
function clusterStats(pool: Pool, members: number[]): { mean: [number, number, number]; sse: number; w: number } {
  let w = 0;
  const m = [0, 0, 0];
  for (const i of members) {
    w += pool.n[i];
    for (let k = 0; k < 3; k++) m[k] += pool.f[3 * i + k];
  }
  if (w === 0) return { mean: [0, 0, 0], sse: 0, w: 0 };
  for (let k = 0; k < 3; k++) m[k] /= w;
  let sse = 0;
  for (const i of members) {
    const n = pool.n[i];
    for (let k = 0; k < 3; k++) {
      const d = pool.f[3 * i + k] / n - m[k];
      sse += n * d * d;
    }
  }
  return { mean: m as [number, number, number], sse, w };
}

/** Splits a cluster along its principal axis (power iteration from [1, 1, 1]) at the SSE-optimal cut. */
function splitCluster(pool: Pool, members: number[]): [number[], number[]] | null {
  if (members.length < 2) return null;
  const { mean } = clusterStats(pool, members);
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const i of members) {
    const n = pool.n[i];
    const d = [0, 1, 2].map((k) => pool.f[3 * i + k] / n - mean[k]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[3 * r + c] += n * d[r] * d[c];
  }
  let v = [1, 1, 1];
  for (let it = 0; it < 30; it++) {
    const nv = [0, 1, 2].map((r) => C[3 * r] * v[0] + C[3 * r + 1] * v[1] + C[3 * r + 2] * v[2]);
    const len = Math.hypot(nv[0], nv[1], nv[2]);
    if (!(len > 0)) break;
    v = nv.map((x) => x / len);
  }
  const proj = members.map((i) => {
    const n = pool.n[i];
    return { i, t: v[0] * (pool.f[3 * i] / n) + v[1] * (pool.f[3 * i + 1] / n) + v[2] * (pool.f[3 * i + 2] / n) };
  });
  proj.sort((a, b) => a.t - b.t || a.i - b.i);
  // prefix sums of weight, weighted feature and weighted |feature|²
  const m = proj.length;
  const W = new Float64Array(m + 1);
  const S = new Float64Array(3 * (m + 1));
  const Q = new Float64Array(m + 1);
  for (let j = 0; j < m; j++) {
    const i = proj[j].i;
    const n = pool.n[i];
    W[j + 1] = W[j] + n;
    let q = 0;
    for (let k = 0; k < 3; k++) {
      S[3 * (j + 1) + k] = S[3 * j + k] + pool.f[3 * i + k];
      q += (pool.f[3 * i + k] / n) ** 2 * n;
    }
    Q[j + 1] = Q[j] + q;
  }
  const sseOf = (a: number, b: number): number => {
    const w = W[b] - W[a];
    if (w <= 0) return 0;
    let s2 = 0;
    for (let k = 0; k < 3; k++) s2 += (S[3 * b + k] - S[3 * a + k]) ** 2;
    return Q[b] - Q[a] - s2 / w;
  };
  let best = -1;
  let bestSse = Infinity;
  for (let j = 1; j < m; j++) {
    const s = sseOf(0, j) + sseOf(j, m);
    if (s < bestSse - 1e-15) {
      bestSse = s;
      best = j;
    }
  }
  if (best < 0) return null;
  return [proj.slice(0, best).map((p) => p.i), proj.slice(best).map((p) => p.i)];
}

/** Weighted Lloyd from the given centers (≤ 30 iterations): assignment per pooled point, centers, SSE. */
function lloyd(pool: Pool, centers: [number, number, number][]): { assign: Int32Array<ArrayBuffer>; centers: [number, number, number][]; sse: number } {
  const P = pool.n.length;
  const K = centers.length;
  const assign = new Int32Array(P);
  let c = centers.map((x) => [...x] as [number, number, number]);
  let prev = Infinity;
  let sse = 0;
  for (let it = 0; it < 30; it++) {
    sse = 0;
    for (let i = 0; i < P; i++) {
      const n = pool.n[i];
      const x = pool.f[3 * i] / n;
      const y = pool.f[3 * i + 1] / n;
      const z = pool.f[3 * i + 2] / n;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (x - c[k][0]) ** 2 + (y - c[k][1]) ** 2 + (z - c[k][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      assign[i] = best;
      sse += n * bd;
    }
    const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let i = 0; i < P; i++) {
      const s = sums[assign[i]];
      s[0] += pool.f[3 * i];
      s[1] += pool.f[3 * i + 1];
      s[2] += pool.f[3 * i + 2];
      s[3] += pool.n[i];
    }
    c = sums.map((s, k) => (s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : c[k]) as [number, number, number]);
    if (!(prev - sse > 1e-3 * sse)) break;
    prev = sse;
  }
  return { assign, centers: c, sse };
}

function labOf(oklab: readonly number[]): [number, number, number] {
  const [r, g, b] = oklabToLinearRgb(oklab[0], oklab[1], oklab[2]);
  const [x, y, z] = linearRgbToXyz(Math.max(0, r), Math.max(0, g), Math.max(0, b));
  return xyzToLab(x, y, z);
}

/**
 * The joint palette of the photos and their label images (§2.9.6). Views without a usable mask pixel contribute
 * nothing; with no masked pixel at all the palette is empty and every label image is −1.
 */
export function jointPalette(views: readonly ColorView[], o: { maxK?: number } = {}): PhotoPaletteResult {
  const maxK = Math.max(1, Math.min(MAX_PHOTO_COLORS, o.maxK ?? MAX_PHOTO_COLORS));
  // 1. OKLab of the masked pixels; the 98th percentile of L clips highlights
  const labs: Float32Array[] = [];
  const Ls: number[] = [];
  for (const v of views) {
    const lab = new Float32Array(v.w * v.h * 3);
    for (let k = 0; k < v.w * v.h; k++) {
      if (!v.mask[k]) continue;
      const [L, a, b] = srgb8ToOklab(v.image.data[4 * k], v.image.data[4 * k + 1], v.image.data[4 * k + 2]);
      lab[3 * k] = L;
      lab[3 * k + 1] = a;
      lab[3 * k + 2] = b;
      Ls.push(L);
    }
    labs.push(lab);
  }
  const empty = (): PhotoPaletteResult => ({
    colors: [],
    salient: [],
    labels: Object.fromEntries(views.map((v) => [v.id, new Int8Array(v.w * v.h).fill(-1)])),
    population: [],
    oklab: [],
  });
  if (Ls.length === 0) return empty();
  const sorted = Float64Array.from(Ls).sort();
  const clipL = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
  // 2. pooled shading-robust features
  const pool: Pool = { f: [], lab: [], n: [] };
  const key = new Map<string, number>();
  const poolOf: Int32Array[] = [];
  views.forEach((v, vi) => {
    const lab = labs[vi];
    const idx = new Int32Array(v.w * v.h).fill(-1);
    for (let k = 0; k < v.w * v.h; k++) {
      if (!v.mask[k]) continue;
      const L = Math.min(lab[3 * k], clipL);
      const f = shadingRobustFeature(L, lab[3 * k + 1], lab[3 * k + 2]);
      const kk = `${Math.round(f[0] / POOL_STEP)},${Math.round(f[1] / POOL_STEP)},${Math.round(f[2] / POOL_STEP)}`;
      let p = key.get(kk);
      if (p === undefined) {
        p = pool.n.length;
        key.set(kk, p);
        pool.f.push(0, 0, 0);
        pool.lab.push(0, 0, 0);
        pool.n.push(0);
      }
      pool.f[3 * p] += f[0];
      pool.f[3 * p + 1] += f[1];
      pool.f[3 * p + 2] += f[2];
      pool.lab[3 * p] += lab[3 * k];
      pool.lab[3 * p + 1] += lab[3 * k + 1];
      pool.lab[3 * p + 2] += lab[3 * k + 2];
      pool.n[p] += 1;
      idx[k] = p;
    }
    poolOf.push(idx);
  });
  const P = pool.n.length;
  const W = pool.n.reduce((a, b) => a + b, 0);
  // 3. nested variance splits → K = 1 … maxK, Lloyd each
  const clusters: number[][] = [Array.from({ length: P }, (_, i) => i)];
  const runs: { assign: Int32Array; centers: [number, number, number][]; D: number }[] = [];
  for (let K = 1; K <= Math.min(maxK, P); K++) {
    if (K > 1) {
      let worst = -1;
      let worstSse = -1;
      clusters.forEach((c, j) => {
        const s = clusterStats(pool, c).sse;
        if (c.length >= 2 && s > worstSse) {
          worstSse = s;
          worst = j;
        }
      });
      if (worst < 0) break;
      const halves = splitCluster(pool, clusters[worst]);
      if (!halves) break;
      clusters.splice(worst, 1, halves[0], halves[1]);
    }
    const r = lloyd(pool, clusters.map((c) => clusterStats(pool, c).mean));
    runs.push({ assign: r.assign, centers: r.centers, D: Math.sqrt(Math.max(0, r.sse) / W) });
  }
  // 4. K: exact first, then one color, then the knee
  let chosen = runs.findIndex((r) => r.D <= 1e-9);
  if (chosen < 0 && runs[0].D <= ONE_COLOR_D) chosen = 0;
  if (chosen < 0) {
    if (runs.length <= 2) chosen = runs.length - 1;
    else {
      const ds = runs.slice(1).map((r) => r.D);
      const dMax = Math.max(...ds);
      const dMin = Math.min(...ds);
      let best = -Infinity;
      for (let j = 0; j < ds.length; j++) {
        const xn = j / (ds.length - 1);
        const yn = dMax > dMin ? (ds[j] - dMin) / (dMax - dMin) : 0;
        const score = 1 - yn - xn;
        if (score > best + 1e-12) {
          best = score;
          chosen = j + 1;
        }
      }
    }
  }
  let assign = Int32Array.from(runs[chosen].assign);
  let K = runs[chosen].centers.length;
  const salient: boolean[] = new Array<boolean>(K).fill(false);
  // 5. salience: pooled colors far (ΔE00 ≥ 20) from their center's color, connected over ≥ 2 pixels
  const centerLab = (a: Int32Array, k: number): [number, number, number] => {
    const s = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < P; i++) {
      if (a[i] !== k) continue;
      s[0] += pool.lab[3 * i];
      s[1] += pool.lab[3 * i + 1];
      s[2] += pool.lab[3 * i + 2];
      n += pool.n[i];
    }
    return n > 0 ? [s[0] / n, s[1] / n, s[2] / n] : [0, 0, 0];
  };
  if (K < maxK) {
    const cl = Array.from({ length: K }, (_, k) => labOf(centerLab(assign, k)));
    const far: number[] = [];
    for (let i = 0; i < P; i++) {
      const plab = labOf([pool.lab[3 * i] / pool.n[i], pool.lab[3 * i + 1] / pool.n[i], pool.lab[3 * i + 2] / pool.n[i]]);
      if (ciede2000(plab, cl[assign[i]]) >= SALIENT_DE) far.push(i);
    }
    if (far.length > 0) {
      // groups of alike far colors (ΔE00 < 10), largest first
      const farLab = far.map((i) => labOf([pool.lab[3 * i] / pool.n[i], pool.lab[3 * i + 1] / pool.n[i], pool.lab[3 * i + 2] / pool.n[i]]));
      const group = new Int32Array(far.length).fill(-1);
      const groups: number[][] = [];
      const order = far.map((_, j) => j).sort((a, b) => pool.n[far[b]] - pool.n[far[a]] || a - b);
      for (const j of order) {
        if (group[j] >= 0) continue;
        const g = groups.length;
        groups.push([]);
        for (const j2 of order) if (group[j2] < 0 && ciede2000(farLab[j], farLab[j2]) < 10) (group[j2] = g), groups[g].push(far[j2]);
      }
      // a group must hold 2 pixels 4-connected in some view
      const inGroup = new Int32Array(P).fill(-1);
      groups.forEach((g, gi) => g.forEach((i) => (inGroup[i] = gi)));
      const connected = new Uint8Array(groups.length);
      views.forEach((v, vi) => {
        const idx = poolOf[vi];
        for (let k = 0; k < v.w * v.h; k++) {
          const p = idx[k];
          if (p < 0 || inGroup[p] < 0) continue;
          const x = k % v.w;
          if ((x + 1 < v.w && idx[k + 1] >= 0 && inGroup[idx[k + 1]] === inGroup[p]) || (k + v.w < v.w * v.h && idx[k + v.w] >= 0 && inGroup[idx[k + v.w]] === inGroup[p])) connected[inGroup[p]] = 1;
        }
      });
      const kept = groups
        .map((g, gi) => ({ gi, n: g.reduce((a, i) => a + pool.n[i], 0) }))
        .filter((g) => connected[g.gi])
        .sort((a, b) => b.n - a.n || a.gi - b.gi)
        .slice(0, maxK - K);
      if (kept.length > 0) {
        const centers = [...runs[chosen].centers];
        for (const g of kept) {
          const members = groups[g.gi];
          centers.push(clusterStats(pool, members).mean);
          salient.push(true);
        }
        const r = lloyd(pool, centers);
        // salient pools stay with their own center (their color is far from the big ones by construction)
        assign = Int32Array.from(r.assign);
        kept.forEach((g, j) => groups[g.gi].forEach((i) => (assign[i] = K + j)));
        K = centers.length;
      }
    }
  }
  // 6. order by population; colors = mean OKLab
  const pop = new Array<number>(K).fill(0);
  for (let i = 0; i < P; i++) pop[assign[i]] += pool.n[i];
  const order = Array.from({ length: K }, (_, k) => k)
    .filter((k) => pop[k] > 0)
    .sort((a, b) => pop[b] - pop[a] || a - b);
  const rank = new Int32Array(K).fill(-1);
  order.forEach((k, r) => (rank[k] = r));
  const oklab = order.map((k) => centerLab(assign, k));
  const labels: Record<string, Int8Array<ArrayBuffer>> = {};
  views.forEach((v, vi) => {
    const idx = poolOf[vi];
    const out = new Int8Array(v.w * v.h).fill(-1);
    for (let k = 0; k < out.length; k++) if (idx[k] >= 0) out[k] = rank[assign[idx[k]]];
    labels[v.id] = out;
  });
  const names = new Set<string>();
  const colors = oklab.map((c) => {
    const hex = oklabToHex(c[0], c[1], c[2]);
    let name = colorName(c);
    for (let n = 2; names.has(name); n++) name = `${colorName(c)} ${n}`;
    names.add(name);
    return { hex, name };
  });
  return { colors, salient: order.map((k) => salient[k] ?? false), labels, population: order.map((k) => pop[k]), oklab };
}

/** A plain color name for a crocheter ("dark brown", "cream", "red"), from OKLab lightness, chroma and hue. */
export function colorName(oklab: readonly number[]): string {
  const [L, a, b] = oklab;
  const C = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  if (C < 0.03) {
    if (L < 0.3) return 'black';
    if (L < 0.5) return 'dark gray';
    if (L < 0.75) return 'gray';
    if (L < 0.93) return 'light gray';
    return 'white';
  }
  let hue: string;
  if (h >= 345 || h < 40) hue = 'red';
  else if (h < 70) hue = 'orange';
  else if (h < 105) hue = 'yellow';
  else if (h < 165) hue = 'green';
  else if (h < 210) hue = 'teal';
  else if (h < 270) hue = 'blue';
  else if (h < 320) hue = 'purple';
  else hue = 'pink';
  // warm, weak colors are the yarn shop's browns and creams
  if ((hue === 'orange' || hue === 'red' || hue === 'yellow') && C < 0.12) {
    if (L > 0.85) return 'cream';
    if (L > 0.7) return 'tan';
    if (L < 0.4) return 'dark brown';
    return 'brown';
  }
  if (L < 0.35) return `dark ${hue}`;
  if (L > 0.85) return `light ${hue}`;
  return hue;
}

// ------------------------------------------------------------------------------------------------ geometry

/** The orientation of a label image (`orientMask` on labels + 1). */
export function orientLabels(labels: Int8Array, w: number, h: number, rot90: 0 | 1 | 2 | 3, mirror: boolean, orient: (m: Uint8Array, w: number, h: number, r: 0 | 1 | 2 | 3, mi: boolean) => { mask: Uint8Array; w: number; h: number }): { labels: Int8Array<ArrayBuffer>; w: number; h: number } {
  const shifted = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) shifted[i] = labels[i] + 1;
  const o = orient(shifted, w, h, rot90, mirror);
  const out = new Int8Array(o.mask.length);
  for (let i = 0; i < out.length; i++) out[i] = o.mask[i] - 1;
  return { labels: out, w: o.w, h: o.h };
}

/** The first-hit depth map of a lattice volume seen from one side of an axis (§2.9.6 visibility). */
export interface DepthMap {
  axis: 0 | 1 | 2;
  /** +1: camera on the + side. */
  sign: 1 | -1;
  /** The two other axes, in increasing order; the map is indexed [i + N·j] along them. */
  a: 0 | 1 | 2;
  b: 0 | 1 | 2;
  grid: ReconGrid;
  /** Per (i, j): sign × the world coordinate of the first surface crossing seen from the camera; NaN = none. */
  first: Float32Array<ArrayBuffer>;
}

/** Scans `field` (positive inside) along `axis` from the camera side for the first crossing of every line. */
export function firstHitDepth(field: ArrayLike<number>, grid: ReconGrid, axis: 0 | 1 | 2, sign: 1 | -1): DepthMap {
  const { N, origin, voxel } = grid;
  const others = ([0, 1, 2] as const).filter((k) => k !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  const [a, b] = others;
  const stride = [1, N, N * N];
  const first = new Float32Array(N * N).fill(Number.NaN);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const base = i * stride[a] + j * stride[b];
      let prev = -Infinity;
      for (let s = 0; s < N; s++) {
        const k = sign > 0 ? N - 1 - s : s;
        const v = field[base + k * stride[axis]];
        if (v >= 0) {
          // sub-voxel crossing between the previous (outside) sample and this one
          let pos = k;
          if (s > 0 && Number.isFinite(prev) && Number.isFinite(v) && v - prev > 0) {
            const t = -prev / (v - prev);
            const kPrev = sign > 0 ? k + 1 : k - 1;
            pos = kPrev + (k - kPrev) * t;
          }
          first[i + N * j] = sign * (origin[axis] + voxel * pos);
          break;
        }
        prev = v;
      }
    }
  }
  return { axis, sign, a, b, grid, first };
}

/** The first-hit depth under a world point (bilinear over the lines that hit), NaN when none near. */
export function depthAt(m: DepthMap, p: Readonly<Vec3>): number {
  const { N, origin, voxel } = m.grid;
  const x = (p[m.a] - origin[m.a]) / voxel;
  const y = (p[m.b] - origin[m.b]) / voxel;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  let acc = 0;
  let W = 0;
  let best = Number.NaN;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const I = i + di;
      const J = j + dj;
      if (I < 0 || J < 0 || I >= N || J >= N) continue;
      const d = m.first[I + N * J];
      if (Number.isNaN(d)) continue;
      const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
      acc += w * d;
      W += w;
      if (!(d <= best)) best = Number.isNaN(best) ? d : Math.max(best, d);
    }
  }
  return W > 1e-9 ? acc / W : best;
}

/** One view of the vote. */
export interface VoteView {
  id: string;
  /** Labels on the (oriented) mask grid, −1 = none. */
  labels: Int8Array;
  /** The mask eroded by 2 px (oriented). */
  eroded: Uint8Array;
  w: number;
  h: number;
  /** Object-frame point → continuous pixel. */
  toPixel: (p: Readonly<Vec3>) => [number, number];
  /** Unit vector toward the camera, object frame. */
  cam: Vec3;
  depth: DepthMap;
  /** Optional per-pixel flags: the pixel is in a protected component. */
  protectedPx?: Uint8Array;
}

/** The mask eroded by `LABEL_ERODE_PX` (the frame is not background). */
export function erodedMask(mask: ArrayLike<number>, w: number, h: number): Uint8Array<ArrayBuffer> {
  return erode(mask, w, h, LABEL_ERODE_PX);
}

export interface VoteResult {
  /** Per vertex: the photo label, −1 = unseen. */
  label: Int16Array<ArrayBuffer>;
  /** Per vertex: the view that gave it (index into the views), −1 = unseen. */
  view: Int8Array<ArrayBuffer>;
  /** Per vertex: its label came from a protected component. */
  protectedV: Uint8Array<ArrayBuffer>;
}

/** Area-weighted vertex normals (unit; outward for a positively oriented closed mesh). */
export function vertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array<ArrayBuffer> {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t];
    const b = 3 * indices[t + 1];
    const c = 3 * indices[t + 2];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v] += nx;
      n[v + 1] += ny;
      n[v + 2] += nz;
    }
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]);
    if (l > 0) {
      n[v] /= l;
      n[v + 1] /= l;
      n[v + 2] /= l;
    }
  }
  return n;
}

/** §2.9.6 per-vertex vote. `tol` = the visibility tolerance in world units (2.5 voxels). */
export function voteVertices(positions: ArrayLike<number>, normals: ArrayLike<number>, views: readonly VoteView[], tol: number): VoteResult {
  const nv = Math.floor(positions.length / 3);
  const label = new Int16Array(nv).fill(-1);
  const view = new Int8Array(nv).fill(-1);
  const protectedV = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const p: Vec3 = [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
    const n: Vec3 = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]];
    let best = -1;
    let bestScore = -1;
    let bestLabel = -1;
    let bestProt = 0;
    views.forEach((vw, k) => {
      const first = depthAt(vw.depth, p);
      if (Number.isNaN(first)) return;
      const d = vw.depth.sign * p[vw.depth.axis];
      if (d < first - tol) return;
      const [px, py] = vw.toPixel(p);
      const x = Math.floor(px);
      const y = Math.floor(py);
      if (x < 0 || y < 0 || x >= vw.w || y >= vw.h) return;
      const i = x + vw.w * y;
      if (!vw.eroded[i] || vw.labels[i] < 0) return;
      const c = n[0] * vw.cam[0] + n[1] * vw.cam[1] + n[2] * vw.cam[2];
      const score = c * c;
      if (score > bestScore + 1e-12) {
        bestScore = score;
        best = k;
        bestLabel = vw.labels[i];
        bestProt = vw.protectedPx?.[i] ?? 0;
      }
    });
    if (best >= 0) {
      label[v] = bestLabel;
      view[v] = best;
      protectedV[v] = bestProt;
    }
  }
  return { label, view, protectedV };
}

// ------------------------------------------------------------------------------------------------ protection

export interface Protection {
  /** Per pixel: 1 in a protected component. */
  protectedPx: Uint8Array<ArrayBuffer>;
  /** Per pixel of a protected component: the most common label just outside it (−1 = none). */
  surround: Int8Array<ArrayBuffer>;
  /** The protected components found: label, area (px), max extent (px). */
  components: { label: number; area: number; extent: number }[];
}

/**
 * §2.9.6 protected components of a label image. `pxPerIn` = pixels per inch at the model's size; `wS`, `hS` = the
 * stitch size (inches); `salient` and `oklab` per label.
 */
export function protectedComponents(labels: Int8Array, w: number, h: number, o: { pxPerIn: number; wS: number; hS: number; salient: readonly boolean[]; oklab: readonly (readonly number[])[] }): Protection {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const protectedPx = new Uint8Array(n);
  const surround = new Int8Array(n).fill(-1);
  const components: Protection['components'] = [];
  const queue = new Int32Array(n);
  const minArea = 6 * o.wS * o.hS * o.pxPerIn * o.pxPerIn;
  for (let s = 0; s < n; s++) {
    if (labels[s] < 0 || comp[s] >= 0) continue;
    const L = labels[s];
    const c = s;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = c;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    const around = new Map<number, number>();
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0) continue;
        if (labels[j] === L) {
          if (comp[j] < 0) {
            comp[j] = c;
            queue[tail++] = j;
          }
        } else if (labels[j] >= 0) around.set(labels[j], (around.get(labels[j]) ?? 0) + 1);
      }
    }
    const area = tail;
    const extentPx = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const extentIn = extentPx / o.pxPerIn;
    const lab = o.oklab[L] ?? [1, 0, 0];
    const eye = extentIn <= 0.6 && lab[0] < 0.25;
    const embroidery = Math.PI * extentIn < 12 * o.wS;
    const small = area < minArea;
    if (!(o.salient[L] || eye || embroidery || small)) continue;
    let sur = -1;
    let best = -1;
    for (const [l, k] of [...around].sort((a, b) => a[0] - b[0])) if (k > best) (best = k), (sur = l);
    for (let q = 0; q < tail; q++) {
      protectedPx[queue[q]] = 1;
      surround[queue[q]] = sur;
    }
    components.push({ label: L, area, extent: extentPx });
  }
  return { protectedPx, surround, components };
}
