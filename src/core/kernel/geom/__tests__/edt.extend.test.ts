// extendSignedDistance3d — the narrow band → whole grid completion of §2.9.8 step 3 — measured against exact
// analytic signed distances. From the independent review of Step 0b, whose measurements of the first version
// (a single known sample per unknown one: up to 0.93 voxel too large, level sets beyond the band rippled by
// 0.1 voxel rms) led to the present one. Measurements are printed with GEOM_VERBOSE=1.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { edtSquared3d, extendSignedDistance3d } from '../edt';
import { marchingCubes } from '../marchingCubes';
import { HEAVY, note } from './fields';

type Dims = [number, number, number];
type Sdf = (x: number, y: number, z: number) => number;

// ---- exact signed distances (positive inside), in lattice units ---------------------------------------------

const sphere =
  (c: Dims, r: number): Sdf =>
  (x, y, z) =>
    r - Math.hypot(x - c[0], y - c[1], z - c[2]);

/** Exact box distance (Quilez), half extents h, optional rotation given by an orthonormal basis (rows). */
function box(c: Dims, h: Dims, basis?: [Dims, Dims, Dims]): Sdf {
  return (x, y, z) => {
    let px = x - c[0];
    let py = y - c[1];
    let pz = z - c[2];
    if (basis) {
      const a = basis[0][0] * px + basis[0][1] * py + basis[0][2] * pz;
      const b = basis[1][0] * px + basis[1][1] * py + basis[1][2] * pz;
      const d = basis[2][0] * px + basis[2][1] * py + basis[2][2] * pz;
      px = a;
      py = b;
      pz = d;
    }
    const qx = Math.abs(px) - h[0];
    const qy = Math.abs(py) - h[1];
    const qz = Math.abs(pz) - h[2];
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    const inside = Math.min(Math.max(qx, qy, qz), 0);
    return -(outside + inside);
  };
}

const torus =
  (c: Dims, R: number, r: number): Sdf =>
  (x, y, z) =>
    r - Math.hypot(Math.hypot(x - c[0], z - c[2]) - R, y - c[1]);

function capsule(a: Dims, b: Dims, r: number): Sdf {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  return (x, y, z) => {
    const t = Math.min(1, Math.max(0, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / len2));
    return r - Math.hypot(x - a[0] - t * ab[0], y - a[1] - t * ab[1], z - a[2] - t * ab[2]);
  };
}

/** A hollow sphere: inside is the shell R − t ≤ r ≤ R + t (non-convex, with a cavity). */
const shell =
  (c: Dims, R: number, t: number): Sdf =>
  (x, y, z) =>
    t - Math.abs(Math.hypot(x - c[0], y - c[1], z - c[2]) - R);

/** Half-space: inside where n·(p − o) ≤ 0 (n is normalized here). */
function halfSpace(o: Dims, n: Dims): Sdf {
  const len = Math.hypot(n[0], n[1], n[2]);
  const u = [n[0] / len, n[1] / len, n[2] / len];
  return (x, y, z) => -((x - o[0]) * u[0] + (y - o[1]) * u[1] + (z - o[2]) * u[2]);
}

/** Disjoint spheres: the exact distance to the union's surface. */
function spheres(list: { c: Dims; r: number }[]): Sdf {
  return (x, y, z) => {
    let inside = false;
    let best = Infinity;
    for (const s of list) {
      const d = s.r - Math.hypot(x - s.c[0], y - s.c[1], z - s.c[2]);
      if (d >= 0) inside = true;
      best = Math.min(best, Math.abs(d));
    }
    return inside ? best : -best;
  };
}

function rotation(ax: number, ay: number, az: number): [Dims, Dims, Dims] {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  // Rz·Ry·Rx, rows.
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

// ---- measuring -----------------------------------------------------------------------------------------------

interface Measured {
  far: number;
  /** Largest under- and over-estimate of the magnitude, and the mean absolute error, in voxels. */
  low: number;
  high: number;
  mean: number;
  /** Unknown samples that came back with the wrong sign or not finite. */
  signErrors: number;
  /** Known samples that were changed. */
  keptErrors: number;
  /** The same for √(transform seeded with d², per side): the literal reading of §2.9.8. */
  literalLow: number;
  literalMean: number;
}

function sample(f: Sdf, dims: Dims, spacing: Dims = [1, 1, 1]): Float64Array {
  const out = new Float64Array(dims[0] * dims[1] * dims[2]);
  let i = 0;
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) out[i++] = f(x * spacing[0], y * spacing[1], z * spacing[2]);
  return out;
}

/**
 * `band` and the errors are in units of the voxel size (for anisotropic grids the largest spacing).
 * `counted`, when given, limits the far samples that enter the statistics.
 */
function measure(exact: Float64Array, dims: Dims, band: number, spacing: Dims = [1, 1, 1], counted?: (i: number) => boolean): Measured {
  const unit = Math.max(...spacing);
  const n = exact.length;
  const input = Float64Array.from(exact, (d) => (Math.abs(d) <= band * unit ? d : d > 0 ? Infinity : -Infinity));
  const got = extendSignedDistance3d(Float64Array.from(input), dims, { spacing });
  const literal = new Float64Array(n);
  for (const side of [1, -1]) {
    const seeds = Float64Array.from(input, (d) => (Number.isFinite(d) && side * d >= 0 ? d * d : Infinity));
    edtSquared3d(seeds, dims, { spacing });
    for (let i = 0; i < n; i++) if (side * input[i] === Infinity) literal[i] = side * Math.sqrt(seeds[i]);
  }
  const m: Measured = { far: 0, low: 0, high: 0, mean: 0, signErrors: 0, keptErrors: 0, literalLow: 0, literalMean: 0 };
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(input[i])) {
      if (!Object.is(got[i], input[i])) m.keptErrors++;
      continue;
    }
    if (got[i] > 0 !== exact[i] > 0 || !Number.isFinite(got[i])) m.signErrors++;
    if (counted !== undefined && !counted(i)) continue;
    m.far++;
    const err = (Math.abs(got[i]) - Math.abs(exact[i])) / unit;
    m.low = Math.min(m.low, err);
    m.high = Math.max(m.high, err);
    m.mean += Math.abs(err);
    const lit = (Math.abs(literal[i]) - Math.abs(exact[i])) / unit;
    m.literalLow = Math.min(m.literalLow, lit);
    m.literalMean += Math.abs(lit);
  }
  m.mean /= m.far;
  m.literalMean /= m.far;
  return m;
}

function row(name: string, m: Measured): string {
  return `${name}: far ${m.far}; ${m.low.toFixed(3)} … +${m.high.toFixed(3)} (mean ${m.mean.toFixed(4)}); literal √ down to ${m.literalLow.toFixed(3)} (mean ${m.literalMean.toFixed(3)})`;
}

interface Shape {
  name: string;
  f: Sdf;
  /** Smooth everywhere: no edge or corner that the lattice edges cannot cross. */
  smooth: boolean;
}

function shapesAt(n: number): Shape[] {
  const c: Dims = [n * 0.49 + 0.3, n * 0.5 - 0.1, n * 0.51 + 0.2];
  const s = n / 96;
  return [
    { name: 'sphere', f: sphere(c, 34.9 * s), smooth: true },
    { name: 'box (axis-aligned)', f: box(c, [30.3 * s, 22.7 * s, 16.2 * s]), smooth: false },
    { name: 'box (rotated 17°/31°/8°)', f: box(c, [30.3 * s, 22.7 * s, 16.2 * s], rotation(0.3, 0.54, 0.14)), smooth: false },
    { name: 'torus', f: torus(c, 26.2 * s, 10.9 * s), smooth: true },
    { name: 'capsule (oblique)', f: capsule([n * 0.25, n * 0.3, n * 0.35], [n * 0.72, n * 0.66, n * 0.6], 13.1 * s), smooth: true },
    { name: 'hollow sphere (shell ±5.3)', f: shell(c, 30.2 * s, 5.3), smooth: true },
    {
      name: 'two spheres 3 voxels apart',
      f: spheres([
        { c: [n * 0.3, n * 0.5, n * 0.5], r: n * 0.19 },
        { c: [n * 0.3 + n * 0.19 + 3 + n * 0.22, n * 0.5, n * 0.5], r: n * 0.22 },
      ]),
      smooth: true,
    },
    { name: 'thin plate (1.4 voxels thick, tilted)', f: box(c, [30 * s, 0.7, 24 * s], rotation(0.2, 0.1, 0.25)), smooth: false },
  ];
}

describe('extendSignedDistance3d on analytic shapes', HEAVY, () => {
  it('N = 96, band ±2, eight shapes: sign kept, known samples untouched, error ranges', () => {
    const n = 96;
    const dims: Dims = [n, n, n];
    const rows: string[] = [];
    for (const { name, f, smooth } of shapesAt(n)) {
      const m = measure(sample(f, dims), dims, 2);
      rows.push(row(name, m));
      expect(m.signErrors).toBe(0);
      expect(m.keptErrors).toBe(0);
      // The literal reading is short by almost the band width, on every shape.
      expect(m.literalLow).toBeLessThan(-1.8);
      expect(m.literalMean).toBeGreaterThan(1.3);
      // Too small only by the straight-line zero between two samples of a curved surface.
      expect(m.low).toBeGreaterThan(-0.03);
      if (smooth) {
        expect(m.high).toBeLessThan(0.25);
        expect(m.mean).toBeLessThan(0.02);
      } else {
        // Next to a sharp edge the bound through a known sample is the better one, and stays below one voxel.
        expect(m.high).toBeLessThan(0.9);
        expect(m.mean).toBeLessThan(0.08);
      }
    }
    note(`extendSignedDistance3d, N = 96, band ±2 (errors of |value| in voxels):\n  ${rows.join('\n  ')}`);
  });

  it('band widths 1 and 3 at N = 48', () => {
    const n = 48;
    const dims: Dims = [n, n, n];
    const rows: string[] = [];
    for (const band of [1, 3]) {
      for (const { name, f, smooth } of shapesAt(n)) {
        const m = measure(sample(f, dims), dims, band);
        if (m.far === 0) continue;
        rows.push(row(`band ±${band} ${name}`, m));
        expect(m.signErrors).toBe(0);
        expect(m.keptErrors).toBe(0);
        expect(m.low).toBeGreaterThan(-0.06);
        expect(m.high).toBeLessThan(smooth ? 0.35 : 0.95);
      }
    }
    note(`extendSignedDistance3d, N = 48, band widths:\n  ${rows.join('\n  ')}`);
  });

  it('tilted planes whose nearest surface point lies inside the grid: within a tenth of a voxel at every tilt', () => {
    // (A single known sample per unknown one was up to 0.89 voxel too large at a tilt of 0.01: the squared
    // transform prefers a deeper band sample a few columns to the side.)
    const rng = mulberry32(0xb201);
    const n = 64;
    const dims: Dims = [n, n, n];
    const rows: string[] = [];
    for (const tilt of [0, 0.01, 0.02, 0.05, 0.2, 1]) {
      const normal: Dims = [tilt * (0.5 + rng()), 1, tilt * (0.5 + rng()) * 0.7];
      const len = Math.hypot(normal[0], normal[1], normal[2]);
      const u: Dims = [normal[0] / len, normal[1] / len, normal[2] / len];
      const o: Dims = [n / 2, n / 2 + rng(), n / 2];
      const exact = sample(halfSpace(o, normal), dims);
      // The foot point of sample i is p + sdf·u (u points out of the solid). Count the sample only when the
      // foot is at least 8 voxels inside the grid: there the band is complete around it, as it is for a
      // closed mesh inside its grid. (Where the surface leaves the grid the result is, correctly, the
      // distance to the part of the surface that the grid holds — tens of voxels more.)
      const counted = (i: number): boolean => {
        const x = i % n;
        const y = Math.floor(i / n) % n;
        const z = Math.floor(i / (n * n));
        const fx = x + exact[i] * u[0];
        const fy = y + exact[i] * u[1];
        const fz = z + exact[i] * u[2];
        return fx > 8 && fx < n - 9 && fy > 8 && fy < n - 9 && fz > 8 && fz < n - 9;
      };
      const m = measure(exact, dims, 2, [1, 1, 1], counted);
      expect(m.signErrors).toBe(0);
      expect(m.far).toBeGreaterThan(50000);
      rows.push(row(`tilt ${tilt}`, m));
      expect(m.low).toBeGreaterThan(-1e-4);
      expect(m.high).toBeLessThan(0.12);
      expect(m.mean).toBeLessThan(0.02);
    }
    note(`extendSignedDistance3d on half-spaces, N = 64, band ±2 (voxels):\n  ${rows.join('\n  ')}`);
  });

  it('level sets of the completed field beyond the band (what a sculpt stroke or a level offset of more than the band width meshes)', () => {
    // (With a single known sample per unknown one the review measured, for the sphere at ±6 voxels: vertices up
    // to 0.46 voxel off the true level set, 0.09–0.10 rms.)
    const n = 64;
    const dims: Dims = [n, n, n];
    const rows: string[] = [];
    const shapes = shapesAt(n);
    for (const { name, f, smooth } of [shapes[0], shapes[2]]) {
      const exact = sample(f, dims);
      const completed = extendSignedDistance3d(
        Float64Array.from(exact, (d) => (Math.abs(d) <= 2 ? d : d > 0 ? Infinity : -Infinity)),
        dims,
      );
      for (const iso of [-6, 6]) {
        const stats = (field: Float64Array): { max: number; rms: number; vertices: number } => {
          const mesh = marchingCubes(field, dims, { iso });
          let max = 0;
          let sum2 = 0;
          for (let v = 0; v < mesh.positions.length; v += 3) {
            // How far the vertex is from the true level set (the exact field has slope 1).
            const err = Math.abs(f(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]) - iso);
            if (err > max) max = err;
            sum2 += err * err;
          }
          return { max, rms: Math.sqrt(sum2 / (mesh.positions.length / 3)), vertices: mesh.positions.length / 3 };
        };
        const a = stats(completed);
        const b = stats(exact);
        rows.push(
          `${name}, level ${iso > 0 ? '+' : ''}${iso} voxels: completed field max ${a.max.toFixed(3)} rms ${a.rms.toFixed(3)} (${a.vertices} vertices); exact field max ${b.max.toFixed(3)} rms ${b.rms.toFixed(3)}`,
        );
        expect(a.vertices).toBeGreaterThan(1000);
        if (smooth) {
          expect(a.max).toBeLessThan(0.2);
          expect(a.rms).toBeLessThan(0.03);
        } else {
          expect(a.max).toBeLessThan(0.9);
          expect(a.rms).toBeLessThan(0.15);
        }
      }
    }
    note(`distance of marching-cubes vertices from the true level set (voxels):\n  ${rows.join('\n  ')}`);
  });

  it('anisotropic spacing and non-cubic grids', () => {
    const rows: string[] = [];
    const cases: { dims: Dims; spacing: Dims }[] = [
      { dims: [96, 40, 23], spacing: [1, 1, 1] },
      { dims: [40, 64, 80], spacing: [1, 0.5, 0.25] },
      { dims: [64, 64, 64], spacing: [0.02, 0.02, 0.02] },
      { dims: [48, 48, 48], spacing: [3, 1, 2] },
    ];
    for (const { dims, spacing } of cases) {
      const size: Dims = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]];
      const c: Dims = [size[0] * 0.48, size[1] * 0.52, size[2] * 0.5];
      const r = 0.36 * Math.min(...size);
      const shapes: Shape[] = [
        { name: 'sphere', f: sphere(c, r), smooth: true },
        { name: 'rotated box', f: box(c, [r, r * 0.7, r * 0.5], rotation(0.4, 0.2, 0.3)), smooth: false },
      ];
      for (const { name, f, smooth } of shapes) {
        const m = measure(sample(f, dims, spacing), dims, 2, spacing);
        rows.push(row(`${dims.join('×')} spacing ${spacing.join('/')} ${name} (unit = largest spacing)`, m));
        expect(m.signErrors).toBe(0);
        expect(m.keptErrors).toBe(0);
        expect(m.low).toBeGreaterThan(-0.06);
        expect(m.high).toBeLessThan(smooth ? 0.35 : 0.9);
      }
    }
    note(`extendSignedDistance3d, anisotropic / non-cubic:\n  ${rows.join('\n  ')}`);
  });
});

describe('extendSignedDistance3d: contract details', () => {
  it('known zeros of either sign stay bit-identical and both sides measure from them; known samples are never rewritten', () => {
    const line = extendSignedDistance3d(Float64Array.of(Infinity, Infinity, -0, -Infinity, -Infinity), [5, 1, 1]);
    expect(Array.from(line)).toEqual([2, 1, -0, -1, -2]);
    expect(Object.is(line[2], -0)).toBe(true);
    const rng = mulberry32(0xb203);
    for (const make of [(n: number) => new Float32Array(n), (n: number) => new Float64Array(n)]) {
      const dims: Dims = [9, 7, 5];
      const sdf = make(315);
      for (let i = 0; i < 315; i++) {
        const r = rng();
        sdf[i] = r < 0.25 ? (rng() - 0.5) * 3 : r < 0.3 ? 0 : r < 0.35 ? -0 : rng() < 0.5 ? Infinity : -Infinity;
      }
      const before = sdf.slice();
      extendSignedDistance3d(sdf, dims, { spacing: [0.5, 1, 2] });
      for (let i = 0; i < 315; i++) {
        if (Number.isFinite(before[i])) expect(Object.is(sdf[i], before[i])).toBe(true);
        else {
          expect(Number.isFinite(sdf[i])).toBe(true);
          expect(sdf[i] > 0).toBe(before[i] > 0);
        }
      }
    }
  });

  it('an all-unknown grid is returned unchanged; NaN is rejected', () => {
    const unknown = Float64Array.of(Infinity, -Infinity, Infinity, -Infinity);
    expect(Array.from(extendSignedDistance3d(unknown, [2, 2, 1]))).toEqual([Infinity, -Infinity, Infinity, -Infinity]);
    expect(() => extendSignedDistance3d(Float64Array.of(1, NaN), [2, 1, 1])).toThrow(RangeError);
  });

  it('known values beyond the float32 range of the work array make no NaN', () => {
    // (The review found the squares of 1e25 and 1e20 overflowing the Float32Array of costs: the transform saw no
    // seed, and the unknown samples became NaN.)
    const big64 = extendSignedDistance3d(Float64Array.of(1e25, Infinity, -1, -Infinity), [4, 1, 1]);
    const big32 = extendSignedDistance3d(Float32Array.of(1e20, Infinity, -1, -Infinity), [4, 1, 1]);
    expect(Array.from(big64)).toEqual([1e25, 2, -1, -2]);
    expect(Array.from(big32)).toEqual([Math.fround(1e20), 2, -1, -2]);
  });

  it('a known sample bounds unknown samples of the other side too, so a band with a gap is still filled sensibly', () => {
    // An inside sample marked unknown right next to a known outside sample (−0.3: the surface is 0.3 away from
    // that neighbor, so less than 1 away from the unknown sample). The only inside seed is 9 samples away.
    // (Using only seeds of the own side, as the first version did, gave 9.4.)
    const sdf = new Float64Array(12).fill(-Infinity);
    sdf[0] = 0.4; // the only known inside sample
    for (let x = 1; x <= 9; x++) sdf[x] = Infinity;
    sdf[10] = -0.3;
    sdf[11] = -1.3;
    extendSignedDistance3d(sdf, [12, 1, 1]);
    expect(sdf[9]).toBeCloseTo(1.3, 6);
    expect(sdf[1]).toBeCloseTo(1.4, 6);
    // Halfway, the two bounds meet: min(4 + 0.4 + 1, 5 + 0.3 + 1) around x = 5.
    expect(sdf[5]).toBeCloseTo(5.3, 6);
    expect(sdf[4]).toBeCloseTo(4.4, 6);
  });
});
