// The signed transforms of edt.ts: the definition, the numeric claims of the `measureTo` doc comment, and what
// each convention does to the spec's callers (§2.9.3: hull from per-view fields sampled into an N×N table,
// inflation T = √(d·(2R − d)), marching cubes at level 0). From the independent review of Step 0b — its
// measurements are why the default is 'samples'. They are printed with GEOM_VERBOSE=1.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { signedEdt1d, signedEdt2d, signedEdt3d } from '../edt';
import { marchingCubes } from '../marchingCubes';
import { signedVolume } from '../meshMeasures';
import { HEAVY, note } from './fields';

type Dims = [number, number, number];

/** Distance in samples from each sample to the nearest sample of the other kind, by trying every pair. */
function bruteOther(mask: ArrayLike<number>, dims: Dims): Float64Array {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const out = new Float64Array(n).fill(Infinity);
  for (let p = 0; p < n; p++) {
    const px = p % nx;
    const py = ((p - px) / nx) % ny;
    const pz = (p - px - nx * py) / (nx * ny);
    const inside = mask[p] !== 0;
    let best = Infinity;
    for (let q = 0; q < n; q++) {
      if ((mask[q] !== 0) === inside) continue;
      const qx = q % nx;
      const qy = ((q - qx) / nx) % ny;
      const qz = (q - qx - nx * qy) / (nx * ny);
      const d2 = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
      if (d2 < best) best = d2;
    }
    out[p] = Math.sqrt(best);
  }
  return out;
}

describe('signedEdt*: the definition', HEAVY, () => {
  it('1D/2D/3D, both conventions, every density, 1-wide axes: equals ±spacing·(distance to the other kind − half)', () => {
    const rng = mulberry32(0xb101);
    const sizes = [1, 1, 2, 3, 5, 8, 13, 40];
    let samples = 0;
    for (let trial = 0; trial < 260; trial++) {
      let dims: Dims;
      do {
        dims = [sizes[Math.floor(rng() * 8)], sizes[Math.floor(rng() * 8)], sizes[Math.floor(rng() * 8)]];
      } while (dims[0] * dims[1] * dims[2] > 1100);
      const n = dims[0] * dims[1] * dims[2];
      const kind = trial % 6;
      const density = kind === 0 ? 0 : kind === 1 ? 1 : kind === 2 ? 0.03 : kind === 3 ? 0.97 : rng();
      const mask = Uint8Array.from({ length: n }, () => (rng() < density ? 1 + Math.floor(rng() * 255) : 0));
      const before = Uint8Array.from(mask);
      const other = bruteOther(mask, dims);
      const spacing = [1, 0.25, 0.0043, 3.7][trial % 4];
      for (const measureTo of ['boundary', 'samples'] as const) {
        const half = measureTo === 'boundary' ? 0.5 : 0;
        const want = Float32Array.from(other, (d, i) => (mask[i] !== 0 ? spacing * (d - half) : -spacing * (d - half)));
        expect(signedEdt3d(mask, dims, { spacing, measureTo })).toEqual(want);
        if (dims[2] === 1) expect(signedEdt2d(mask, dims[0], dims[1], { spacing, measureTo })).toEqual(want);
        if (dims[2] === 1 && dims[1] === 1) expect(signedEdt1d(mask, { spacing, measureTo })).toEqual(want);
      }
      // The default is 'samples'.
      expect(signedEdt3d(mask, dims, { spacing })).toEqual(signedEdt3d(mask, dims, { spacing, measureTo: 'samples' }));
      expect(mask).toEqual(before);
      samples += n;
    }
    expect(samples).toBeGreaterThan(40000);
  });

  it('never NaN, never 0; the sign is the mask; all inside → +Infinity, empty → −Infinity', () => {
    const rng = mulberry32(0xb102);
    for (let trial = 0; trial < 100; trial++) {
      const w = 1 + Math.floor(rng() * 20);
      const h = 1 + Math.floor(rng() * 20);
      const mask = Uint8Array.from({ length: w * h }, () => (rng() < 0.5 ? 1 : 0));
      for (const measureTo of ['boundary', 'samples'] as const) {
        const sd = signedEdt2d(mask, w, h, { measureTo, spacing: 0.01 });
        for (let i = 0; i < sd.length; i++) {
          expect(Number.isNaN(sd[i])).toBe(false);
          expect(sd[i] > 0).toBe(mask[i] !== 0);
          expect(sd[i] < 0).toBe(mask[i] === 0);
        }
      }
    }
    expect(Array.from(signedEdt3d(new Uint8Array(12).fill(3), [3, 2, 2]))).toEqual(Array(12).fill(Infinity));
    expect(Array.from(signedEdt3d(new Uint8Array(12), [3, 2, 2]))).toEqual(Array(12).fill(-Infinity));
  });
});

// ---- the numeric claims of the `measureTo` doc comment ----------------------------------------------------

interface ErrorStats {
  low: number;
  high: number;
  /** Mean signed error of the MAGNITUDE (positive = "farther from the outline than the truth") within one pixel of the outline. */
  nearBias: number;
  /** The same more than five pixels away from the outline. */
  farBias: number;
}

function errorStats(sd: Float32Array, truth: (x: number, y: number) => number, w: number, h: number): ErrorStats {
  let low = Infinity;
  let high = -Infinity;
  let sum = 0;
  let near = 0;
  let farSum = 0;
  let far = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = truth(x, y);
      const err = Math.abs(sd[x + w * y]) - Math.abs(t);
      if (err < low) low = err;
      if (err > high) high = err;
      if (Math.abs(t) < 1) {
        sum += err;
        near++;
      } else if (Math.abs(t) > 5) {
        farSum += err;
        far++;
      }
    }
  }
  return { low, high, nearBias: sum / near, farBias: far > 0 ? farSum / far : 0 };
}

describe("signedEdt2d: 'boundary' vs 'samples' against the true distance to the outline", HEAVY, () => {
  it('discs of radius 8 … 120 px at random centers: error range and bias next to the outline', () => {
    const rng = mulberry32(0xb103);
    const n = 256;
    let bLow = Infinity;
    let bHigh = -Infinity;
    let sLow = Infinity;
    let sHigh = -Infinity;
    let bBiasMin = Infinity;
    let bBiasMax = -Infinity;
    let sBiasMin = Infinity;
    let sBiasMax = -Infinity;
    let bFarMin = Infinity;
    let bFarMax = -Infinity;
    let sFarMin = Infinity;
    let sFarMax = -Infinity;
    let over = 0;
    for (let trial = 0; trial < 60; trial++) {
      const R = 8 + 112 * rng();
      const cx = 126 + 4 * rng();
      const cy = 126 + 4 * rng();
      const mask = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[x + n * y] = Math.hypot(x - cx, y - cy) < R ? 1 : 0;
      const truth = (x: number, y: number): number => R - Math.hypot(x - cx, y - cy);
      const b = errorStats(signedEdt2d(mask, n, n, { measureTo: 'boundary' }), truth, n, n);
      const s = errorStats(signedEdt2d(mask, n, n, { measureTo: 'samples' }), truth, n, n);
      bLow = Math.min(bLow, b.low);
      bHigh = Math.max(bHigh, b.high);
      sLow = Math.min(sLow, s.low);
      sHigh = Math.max(sHigh, s.high);
      bBiasMin = Math.min(bBiasMin, b.nearBias);
      bBiasMax = Math.max(bBiasMax, b.nearBias);
      sBiasMin = Math.min(sBiasMin, s.nearBias);
      sBiasMax = Math.max(sBiasMax, s.nearBias);
      bFarMin = Math.min(bFarMin, b.farBias);
      bFarMax = Math.max(bFarMax, b.farBias);
      sFarMin = Math.min(sFarMin, s.farBias);
      sFarMax = Math.max(sFarMax, s.farBias);
      if (b.high >= 0.5 || b.low <= -0.5) over++;
    }
    note(
      `discs R 8…120: boundary error ${bLow.toFixed(3)} … ${bHigh.toFixed(3)} (bias within 1 px of the outline ${bBiasMin.toFixed(3)} … ${bBiasMax.toFixed(3)}, more than 5 px away ${bFarMin.toFixed(3)} … ${bFarMax.toFixed(3)}); ` +
        `samples error ${sLow.toFixed(3)} … ${sHigh.toFixed(3)} (bias near ${sBiasMin.toFixed(3)} … ${sBiasMax.toFixed(3)}, far ${sFarMin.toFixed(3)} … ${sFarMax.toFixed(3)}); ${over}/60 discs leave ±0.5`,
    );
    // 'samples' is never too small (a segment between an inside and an outside center crosses the outline).
    expect(sLow).toBeGreaterThan(-1e-5);
    // Claimed: 'boundary' within ±0.5, 'samples' 0 … 1. Outside a convex outline the nearest inside center can
    // be a little more than one pixel behind the outline, so allow the curvature term.
    expect(bLow).toBeGreaterThan(-0.5 - 1e-5);
    expect(bHigh).toBeLessThan(0.6);
    expect(sHigh).toBeLessThan(1.1);
    // Claimed: no bias next to the outline for 'boundary', about half a pixel for 'samples'.
    expect(Math.abs(bBiasMin)).toBeLessThan(0.1);
    expect(Math.abs(bBiasMax)).toBeLessThan(0.1);
    expect(sBiasMin).toBeGreaterThan(0.4);
    // More than a few pixels from a curved or slanted outline 'boundary' is about a quarter of a pixel SHORT,
    // and 'samples' about a quarter of a pixel long — neither is unbiased there.
    expect(bFarMax).toBeLessThan(-0.15);
    expect(sFarMin).toBeGreaterThan(0.1);
    expect(sFarMax).toBeLessThan(-bFarMin);
  });

  it('straight outlines at every angle: the bias of both conventions next to the outline', () => {
    const rng = mulberry32(0xb104);
    const n = 160;
    const rows: string[] = [];
    let worstBoundaryBias = 0;
    let worstBoundaryFar = 0;
    for (const deg of [0, 2, 5, 10, 20, 26.565, 30, 40, 45]) {
      const nxv = Math.cos((deg * Math.PI) / 180);
      const nyv = Math.sin((deg * Math.PI) / 180);
      let bNear = 0;
      let sNear = 0;
      let bFar = 0;
      let sFar = 0;
      let count = 0;
      let countFar = 0;
      for (let rep = 0; rep < 12; rep++) {
        const c = nxv * 80 + nyv * 80 + rng(); // the line passes near the middle, at a random sub-pixel offset
        const mask = new Uint8Array(n * n);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[x + n * y] = nxv * x + nyv * y - c >= 0 ? 1 : 0;
        const b = signedEdt2d(mask, n, n, { measureTo: 'boundary' });
        const s = signedEdt2d(mask, n, n, { measureTo: 'samples' });
        // Stay away from the image frame (the frame is not a boundary, but far rows see fewer candidates).
        for (let y = 40; y < n - 40; y++) {
          for (let x = 40; x < n - 40; x++) {
            const t = nxv * x + nyv * y - c;
            const eb = Math.abs(b[x + n * y]) - Math.abs(t);
            const es = Math.abs(s[x + n * y]) - Math.abs(t);
            if (Math.abs(t) < 1) {
              bNear += eb;
              sNear += es;
              count++;
            } else if (Math.abs(t) > 10 && Math.abs(t) < 30) {
              bFar += eb;
              sFar += es;
              countFar++;
            }
          }
        }
      }
      rows.push(
        `${deg}°: near boundary ${(bNear / count).toFixed(3)} samples ${(sNear / count).toFixed(3)} | 10–30 px away boundary ${(bFar / countFar).toFixed(3)} samples ${(sFar / countFar).toFixed(3)}`,
      );
      worstBoundaryBias = Math.max(worstBoundaryBias, Math.abs(bNear / count));
      worstBoundaryFar = Math.max(worstBoundaryFar, Math.abs(bFar / countFar));
    }
    note(`mean error of |sd| (px) for straight outlines:\n  ${rows.join('\n  ')}`);
    // Next to the outline 'boundary' is unbiased at 0° and within ~0.11 px at 45°, as the doc comment says.
    expect(worstBoundaryBias).toBeLessThan(0.15);
    // 10–30 px away from a slanted outline it is up to a third of a pixel short (the nearest sample of the
    // other kind can then be chosen along a long stretch of the outline, and lies just behind it).
    expect(worstBoundaryFar).toBeGreaterThan(0.3);
    expect(worstBoundaryFar).toBeLessThan(0.5);
  });

  it('small or sharply curved shapes: the ±spacing/2 claim does not hold (a 1-pixel "disc")', () => {
    // Disc of radius 0.7 around (0.45, 0.45) + (20, 20): one pixel center inside.
    const n = 41;
    const cx = 20.45;
    const cy = 20.45;
    const R = 0.7;
    const mask = new Uint8Array(n * n);
    let count = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (Math.hypot(x - cx, y - cy) < R) {
          mask[x + n * y] = 1;
          count++;
        }
      }
    }
    expect(count).toBe(1);
    const e = errorStats(signedEdt2d(mask, n, n, { measureTo: 'boundary' }), (x, y) => R - Math.hypot(x - cx, y - cy), n, n);
    note(`1-pixel disc (R = 0.7 px): boundary error ${e.low.toFixed(3)} … ${e.high.toFixed(3)} px`);
    // Not a defect of the transform (the mask simply does not resolve the shape): the error ranges of the doc
    // comment are for outlines that do not curve within a pixel or two.
    expect(e.high).toBeGreaterThan(0.5);
  });
});

// ---- what each convention does to the spec's callers -------------------------------------------------------

/** Bilinear sample of a pixel-center field at pixel coordinates (u, v), clamped to the image. */
function bilinear(f: Float32Array, w: number, h: number, u: number, v: number): number {
  const uc = Math.min(Math.max(u, 0), w - 1);
  const vc = Math.min(Math.max(v, 0), h - 1);
  const x0 = Math.min(Math.floor(uc), w - 2);
  const y0 = Math.min(Math.floor(vc), h - 2);
  const tx = uc - x0;
  const ty = vc - y0;
  const a = f[x0 + w * y0] * (1 - tx) + f[x0 + 1 + w * y0] * tx;
  const b = f[x0 + w * (y0 + 1)] * (1 - tx) + f[x0 + 1 + w * (y0 + 1)] * tx;
  return a * (1 - ty) + b * ty;
}

describe('both conventions in the callers of §2.9.3', HEAVY, () => {
  it('three-view hull of a sphere r = 0.8 (masks 512 px, N = 128): volume ratio against 8(2 − √2)/(4π/3) = 1.1187 (T3: 1.119 ± 0.01)', () => {
    const HALF = 1.1;
    const P = 512;
    const px = (2 * HALF) / P;
    const r = 0.8;
    const mask = new Uint8Array(P * P);
    for (let j = 0; j < P; j++) {
      for (let i = 0; i < P; i++) {
        const x = -HALF + (i + 0.5) * px;
        const y = -HALF + (j + 0.5) * px;
        mask[i + P * j] = x * x + y * y < r * r ? 1 : 0;
      }
    }
    const ideal = (8 * (2 - Math.SQRT2)) / ((4 / 3) * Math.PI);
    const results: Record<string, number> = {};
    for (const N of [64, 128]) {
      const voxel = (2 * HALF) / (N - 1);
      for (const measureTo of ['boundary', 'samples', 'analytic'] as const) {
        // The N×N table of one view (all three views of a sphere are the same disc).
        const table = new Float32Array(N * N);
        const sd = measureTo === 'analytic' ? undefined : signedEdt2d(mask, P, P, { spacing: px, measureTo });
        for (let b = 0; b < N; b++) {
          for (let a = 0; a < N; a++) {
            const x = -HALF + a * voxel;
            const y = -HALF + b * voxel;
            table[a + N * b] = sd === undefined ? r - Math.hypot(x, y) : bilinear(sd, P, P, (x + HALF) / px - 0.5, (y + HALF) / px - 0.5);
          }
        }
        const f = new Float32Array(N * N * N);
        let i = 0;
        for (let z = 0; z < N; z++) {
          for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) f[i++] = Math.min(table[x + N * y], table[x + N * z], table[z + N * y]);
          }
        }
        const mesh = marchingCubes(f, [N, N, N], { origin: [-HALF, -HALF, -HALF], voxel });
        results[`${measureTo}@${N}`] = signedVolume(mesh) / ((4 / 3) * Math.PI * r ** 3);
      }
    }
    note(
      `sphere hull volume ratio (ideal ${ideal.toFixed(4)}): ` +
        Object.entries(results)
          .map(([k, v]) => `${k} ${v.toFixed(4)}`)
          .join(', '),
    );
    // Both conventions meet T3's acceptance without any correction by the caller, as closely as the exact
    // distance field of the disc does on the same lattice (measured at N = 128: boundary 1.1184, samples
    // 1.1186, analytic 1.1185; ideal 1.1188).
    expect(Math.abs(results['samples@128'] - 1.119)).toBeLessThan(0.01);
    expect(Math.abs(results['boundary@128'] - 1.119)).toBeLessThan(0.01);
    expect(Math.abs(results['samples@128'] - results['analytic@128'])).toBeLessThan(1e-3);
    expect(Math.abs(results['boundary@128'] - results['analytic@128'])).toBeLessThan(1e-3);
  });

  it('inflation of a disc, T = √(d·(2R − d)) with d = the inside part of the signed field: volume against the hemisphere (T3: ±2%)', () => {
    const rows: string[] = [];
    let worstBoundary = 0;
    let lastBoundary = 0;
    const samples: number[] = [];
    for (const R of [10.3, 25.7, 60.2, 120.4]) {
      const n = Math.ceil(2 * R) + 12;
      const cx = n / 2 + 0.31;
      const cy = n / 2 - 0.17;
      const mask = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[x + n * y] = Math.hypot(x - cx, y - cy) < R ? 1 : 0;
      const hemisphere = (2 / 3) * Math.PI * R ** 3;
      const ratio: Record<string, number> = {};
      for (const measureTo of ['boundary', 'samples'] as const) {
        const sd = signedEdt2d(mask, n, n, { measureTo });
        // For a disc the largest inscribed disc containing any pixel is the disc itself: R_loc = max d.
        let rLoc = 0;
        for (let i = 0; i < sd.length; i++) if (sd[i] > rLoc) rLoc = sd[i];
        let volume = 0;
        for (let i = 0; i < sd.length; i++) {
          const d = sd[i];
          if (d > 0) volume += Math.sqrt(Math.max(0, d * (2 * rLoc - d)));
        }
        ratio[measureTo] = volume / hemisphere;
      }
      rows.push(`R = ${R}: boundary ${ratio.boundary.toFixed(4)}, samples ${ratio.samples.toFixed(4)}`);
      worstBoundary = Math.max(worstBoundary, Math.abs(ratio.boundary - 1));
      lastBoundary = ratio.boundary;
      samples.push(ratio.samples);
      // 'samples' is the closer one at every radius.
      expect(Math.abs(ratio.samples - 1)).toBeLessThan(Math.abs(ratio.boundary - 1));
    }
    note(`inflated disc volume / hemisphere volume:\n  ${rows.join('\n  ')}`);
    // Measured, R = 10.3 / 25.7 / 60.2 / 120.4 px: 'samples' (the default) 1.050 / 1.019 / 1.0075 / 1.003, too
    // large by about 0.4/R — T3's "±2%" (§6.3) holds from a radius of about 25 px; 'boundary' 0.935 / 0.968 /
    // 0.985 / 0.991, too small by about 1.1/R — ±2% only from about 45 px.
    expect(samples[0]).toBeGreaterThan(1.02);
    for (const ratio of samples.slice(1)) {
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(1.02);
    }
    expect(worstBoundary).toBeGreaterThan(0.02);
    expect(worstBoundary).toBeLessThan(0.08);
    expect(lastBoundary).toBeGreaterThan(0.98);
    expect(lastBoundary).toBeLessThan(1);
  });

  it("marching cubes on the transform's own grid gives the SAME mesh for both conventions (crossed edges always hold ±half or ±1 spacing)", () => {
    const n = 40;
    const dims: Dims = [n, n, n];
    const mask = new Uint8Array(n * n * n);
    for (let i = 0; i < mask.length; i++) {
      const x = i % n;
      const y = Math.floor(i / n) % n;
      const z = Math.floor(i / (n * n));
      mask[i] = Math.hypot(x - 19.3, y - 20.1, z - 19.6) < 14.2 || Math.hypot(x - 30.2, y - 9.7, z - 12.1) < 6.3 ? 1 : 0;
    }
    const a = marchingCubes(signedEdt3d(mask, dims, { spacing: 0.37, measureTo: 'boundary' }), dims, { voxel: 0.37 });
    const b = marchingCubes(signedEdt3d(mask, dims, { spacing: 0.37, measureTo: 'samples' }), dims, { voxel: 0.37 });
    expect(a.indices).toEqual(b.indices);
    expect(a.positions).toEqual(b.positions);
    // …and every vertex sits exactly halfway between two samples: a signed transform of a mask carries no
    // sub-voxel information, whatever the convention.
    let offGrid = 0;
    for (let v = 0; v < a.positions.length; v++) {
      const g = a.positions[v] / 0.37;
      if (Math.abs(g * 2 - Math.round(g * 2)) > 1e-4) offGrid++;
    }
    expect(offGrid).toBe(0);
  });

  it("a strip of even width: 'boundary' gives a ridge half a pixel lower than the half-width (odd widths are exact)", () => {
    const profile = (w: number, measureTo: 'boundary' | 'samples'): number[] => {
      const line = Uint8Array.from({ length: w + 4 }, (_, i) => (i >= 2 && i < w + 2 ? 1 : 0));
      return Array.from(signedEdt1d(line, { measureTo })).slice(2, w + 2);
    };
    expect(profile(4, 'boundary')).toEqual([0.5, 1.5, 1.5, 0.5]); // half-width 2
    expect(profile(5, 'boundary')).toEqual([0.5, 1.5, 2.5, 1.5, 0.5]); // half-width 2.5
    expect(profile(4, 'samples')).toEqual([1, 2, 2, 1]);
    expect(profile(5, 'samples')).toEqual([1, 2, 3, 2, 1]);
  });
});
