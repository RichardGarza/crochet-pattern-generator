import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../../types/geometry';
import { fnv1a64Hex } from '../../hash';
import { mulberry32 } from '../../prng';
import { type IndexedMesh, MC_T_MAX, MC_T_MIN, MC_ZERO_REPLACEMENT, marchingCubes, marchingCubesSdf } from '../marchingCubes';
import {
  countComponents,
  countNonManifoldVertices,
  countUsedVertices,
  countZeroAreaTriangles,
  edgeStats,
  eulerCharacteristic,
  meshBounds,
  minTriangleArea,
  signedVolume,
} from '../meshMeasures';
import { encodeSdfVolume } from '../sdfVolume';
import { HALF, HEAVY, sampleField, sphere, sphereVolume, teddy, torus, torusVolume, triangleKeys, twoSpheres } from './fields';

// ---- helpers ---------------------------------------------------------------------------------------------

function mesh(sample: ReturnType<typeof sampleField>, options: Parameters<typeof marchingCubes>[2] = {}): IndexedMesh {
  return marchingCubes(sample.field, sample.dims, { origin: sample.origin, voxel: sample.voxel, ...options });
}

/** Closed, consistently wound, one fan per vertex, every vertex used, no degenerate triangle, not inside out. */
function expectClosedSurface(m: IndexedMesh): void {
  const edges = edgeStats(m.indices);
  expect(edges.boundaryEdges).toBe(0);
  expect(edges.nonManifoldEdges).toBe(0);
  expect(edges.misorientedEdges).toBe(0);
  expect(countNonManifoldVertices(m.indices)).toBe(0);
  expect(countUsedVertices(m.indices)).toBe(m.positions.length / 3);
  expect(countZeroAreaTriangles(m)).toBe(0);
  let nonFinite = 0;
  for (let i = 0; i < m.positions.length; i++) if (!Number.isFinite(m.positions[i])) nonFinite++;
  expect(nonFinite).toBe(0);
  if (m.indices.length > 0) expect(signedVolume(m)).toBeGreaterThan(0);
}

// Bourke's numbering, which the three.js tables use.
const CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const EDGE_CORNERS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/**
 * Textbook marching cubes, one cell at a time, no vertex sharing: a triangle soup. It reads the three.js
 * tables directly and knows nothing about slices, edge maps or bit tricks.
 */
function referenceSoup(field: ArrayLike<number>, dims: readonly [number, number, number], iso: number, origin: Vec3, voxel: Vec3): IndexedMesh {
  const [nx, ny, nz] = dims;
  const value = (x: number, y: number, z: number): number => {
    let v = field[x + nx * (y + ny * z)] - iso;
    if (!(v > -1e30)) v = -1e30;
    else if (v > 1e30) v = 1e30;
    else if (v === 0) v = MC_ZERO_REPLACEMENT;
    return v;
  };
  const positions: number[] = [];
  for (let z = 0; z + 1 < nz; z++) {
    for (let y = 0; y + 1 < ny; y++) {
      for (let x = 0; x + 1 < nx; x++) {
        const d = CORNERS.map((c) => value(x + c[0], y + c[1], z + c[2]));
        let cube = 0;
        for (let k = 0; k < 8; k++) if (d[k] < 0) cube |= 1 << k;
        const edgeVertex = (e: number): Vec3 => {
          // Interpolate from the corner with the smaller coordinates, like the kernel does.
          let [a, b] = EDGE_CORNERS[e];
          if (CORNERS[a][0] + CORNERS[a][1] + CORNERS[a][2] > CORNERS[b][0] + CORNERS[b][1] + CORNERS[b][2]) [a, b] = [b, a];
          const t = Math.min(MC_T_MAX, Math.max(MC_T_MIN, d[a] / (d[a] - d[b])));
          const lattice = [x + CORNERS[a][0], y + CORNERS[a][1], z + CORNERS[a][2]];
          const axis = CORNERS[b].findIndex((c, i) => c !== CORNERS[a][i]);
          return [0, 1, 2].map((i) => origin[i] + voxel[i] * (i === axis ? lattice[i] + t : lattice[i])) as Vec3;
        };
        for (let k = 16 * cube; triTable[k] !== -1; k++) positions.push(...edgeVertex(triTable[k]));
      }
    }
  }
  const out = Float32Array.from(positions);
  return { positions: out, indices: Uint32Array.from({ length: out.length / 3 }, (_, i) => i) };
}

function randomField(seed: number, maxDim = 9): { field: Float32Array<ArrayBuffer>; dims: [number, number, number] } {
  const rng = mulberry32(seed);
  const dims: [number, number, number] = [1 + Math.floor(rng() * maxDim), 1 + Math.floor(rng() * maxDim), 1 + Math.floor(rng() * maxDim)];
  const field = new Float32Array(dims[0] * dims[1] * dims[2]);
  const kind = seed % 4;
  for (let i = 0; i < field.length; i++) {
    const r = rng() * 2 - 1;
    // noise · ±1 · small integers with many exact zeros · values within the clamp range of zero
    field[i] = kind === 0 ? r : kind === 1 ? Math.sign(r) : kind === 2 ? Math.round(r * 2) : r * 1e-3 * (rng() < 0.5 ? 1 : 1000);
  }
  return { field, dims };
}

// ---- the tables ------------------------------------------------------------------------------------------

describe('three.js marching-cubes tables', () => {
  it('use Bourke numbering: edge bits = edges whose corners differ, triangles use exactly those edges', () => {
    expect(edgeTable.length).toBe(256);
    expect(triTable.length).toBe(256 * 16);
    for (let cube = 0; cube < 256; cube++) {
      let crossed = 0;
      for (let e = 0; e < 12; e++) {
        const [a, b] = EDGE_CORNERS[e];
        if (((cube >> a) & 1) !== ((cube >> b) & 1)) crossed |= 1 << e;
      }
      expect(edgeTable[cube]).toBe(crossed);
      let used = 0;
      let k = 16 * cube;
      for (; triTable[k] !== -1; k++) used |= 1 << triTable[k];
      expect(used).toBe(crossed);
      // whole triangles, at most five, and a terminator inside the row
      expect((k - 16 * cube) % 3).toBe(0);
      expect(k - 16 * cube).toBeLessThanOrEqual(15);
    }
  });
});

// ---- acceptance: sphere, ellipsoid union, torus, two spheres ---------------------------------------------

describe('marchingCubes on analytic solids', HEAVY, () => {
  it.each([64, 128])('sphere r = 0.8 at N = %i: watertight, χ = 2, outward, no zero-area triangle, volume', (n) => {
    const m = mesh(sampleField(n, sphere(0.8)));
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(2);
    expect(countComponents(m.indices)).toBe(1);
    const ratio = signedVolume(m) / sphereVolume(0.8);
    // Measured: 0.99891 at N = 64, 0.99974 at N = 128 (chords of a convex surface: always slightly small).
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeGreaterThan(n === 128 ? 0.999 : 0.998);
    // Every vertex is on the sphere up to the linear-interpolation error and the 0.01-voxel clamp
    // (measured: 0.0082 voxel at N = 64, 0.0097 at N = 128).
    const voxel = (2 * HALF) / (n - 1);
    let worst = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      worst = Math.max(worst, Math.abs(Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]) - 0.8));
    }
    expect(worst).toBeLessThan(0.011 * voxel);
  });

  it('pins the vertex and triangle counts and the index buffers (any change to the mesher shows up here)', () => {
    const m64 = mesh(sampleField(64, sphere(0.8)));
    expect([m64.positions.length / 3, m64.indices.length / 3]).toEqual([9936, 19868]);
    const m128 = mesh(sampleField(128, sphere(0.8)));
    expect([m128.positions.length / 3, m128.indices.length / 3]).toEqual([40248, 80492]);
    // Hashes of the index buffers (integers only, §5.8): vertex numbering and triangle order are part of the
    // output, and nothing downstream may see them change unannounced.
    expect(fnv1a64Hex(m64.indices)).toBe('0903f5169c337ad4');
    expect(fnv1a64Hex(mesh(sampleField(64, teddy)).indices)).toBe('47a1e4af66b155af');
    expect(fnv1a64Hex(mesh(sampleField(64, torus(0.6, 0.25))).indices)).toBe('e84734e855c5f4df');
  });

  it('an off-center sphere that fits the lattice has the same quality', () => {
    const m = mesh(sampleField(64, sphere(0.61, [0.137, -0.211, 0.059])));
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(2);
    // Measured: 0.99805.
    expect(signedVolume(m) / sphereVolume(0.61)).toBeGreaterThan(0.997);
    expect(signedVolume(m) / sphereVolume(0.61)).toBeLessThan(1);
  });

  it('union of nine ellipsoids (teddy) at N = 64 and 128: watertight, χ = 2, one piece, consistent volume', () => {
    const m64 = mesh(sampleField(64, teddy));
    const m128 = mesh(sampleField(128, teddy));
    for (const m of [m64, m128]) {
      expectClosedSurface(m);
      expect(eulerCharacteristic(m.indices)).toBe(2);
      expect(countComponents(m.indices)).toBe(1);
    }
    // The two resolutions agree on the volume to 1% (measured: 0.31% apart).
    expect(Math.abs(signedVolume(m64) / signedVolume(m128) - 1)).toBeLessThan(0.01);
    // And the finer one agrees with a plain count of inside lattice points to 1% (measured: 0.04%).
    const s = sampleField(128, teddy);
    let inside = 0;
    for (let i = 0; i < s.field.length; i++) if (s.field[i] >= 0) inside++;
    expect(Math.abs(signedVolume(m128) / (inside * s.voxel ** 3) - 1)).toBeLessThan(0.01);
    expect([m64.positions.length / 3, m64.indices.length / 3]).toEqual([6646, 13288]);
    expect([m128.positions.length / 3, m128.indices.length / 3]).toEqual([27278, 54552]);
  });

  it('torus: χ = 0 (genus 1), watertight, right volume', () => {
    for (const n of [64, 128]) {
      const m = mesh(sampleField(n, torus(0.6, 0.25)));
      expectClosedSurface(m);
      expect(eulerCharacteristic(m.indices)).toBe(0);
      expect(countComponents(m.indices)).toBe(1);
      // Measured: 0.99619 at N = 64, 0.99906 at N = 128.
      expect(Math.abs(signedVolume(m) / torusVolume(0.6, 0.25) - 1)).toBeLessThan(n === 128 ? 0.002 : 0.006);
    }
  });

  it('two separate spheres: χ = 4, two pieces, watertight', () => {
    const m = mesh(sampleField(64, twoSpheres));
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(4);
    expect(countComponents(m.indices)).toBe(2);
    // Measured: 0.99328 (two small spheres on a coarse lattice).
    expect(Math.abs(signedVolume(m) / (sphereVolume(0.35) + sphereVolume(0.3)) - 1)).toBeLessThan(0.01);
  });
});

// ---- determinism -----------------------------------------------------------------------------------------

describe('marchingCubes determinism', () => {
  it('gives byte-identical buffers on repeated runs and for a copy of the field', () => {
    const s = sampleField(48, teddy);
    const a = mesh(s);
    const b = mesh(s);
    const c = marchingCubes(Float32Array.from(s.field), s.dims, { origin: s.origin, voxel: s.voxel });
    for (const other of [b, c]) {
      expect(Buffer.from(other.positions.buffer).equals(Buffer.from(a.positions.buffer))).toBe(true);
      expect(Buffer.from(other.indices.buffer).equals(Buffer.from(a.indices.buffer))).toBe(true);
    }
  });

  it('does not modify the field and returns exact-length ArrayBuffer-backed buffers', () => {
    const s = sampleField(24, sphere(0.8));
    const before = Float32Array.from(s.field);
    const m = mesh(s);
    expect(s.field).toEqual(before);
    expect(m.positions).toBeInstanceOf(Float32Array);
    expect(m.indices).toBeInstanceOf(Uint32Array);
    expect(m.positions.buffer.byteLength).toBe(m.positions.byteLength);
    expect(m.indices.buffer.byteLength).toBe(m.indices.byteLength);
    expect(m.positions.length % 3).toBe(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('accepts any numeric array type and gives the same mesh for the same values', () => {
    const s = sampleField(20, (x, y, z) => Math.round(40 * sphere(0.8)(x, y, z)));
    const reference = marchingCubes(s.field, s.dims);
    for (const copy of [Float64Array.from(s.field), Int16Array.from(s.field), Int32Array.from(s.field), Array.from(s.field)]) {
      const m = marchingCubes(copy, s.dims);
      expect(m.indices).toEqual(reference.indices);
      expect(m.positions).toEqual(reference.positions);
    }
  });
});

// ---- against a textbook implementation -------------------------------------------------------------------

describe('marchingCubes against a per-cell reference', () => {
  it('produces exactly the triangles of textbook marching cubes (open border), on smooth and random fields', () => {
    const cases: { field: ArrayLike<number>; dims: [number, number, number]; iso: number; origin: Vec3; voxel: Vec3 }[] = [];
    const s = sampleField(14, teddy);
    cases.push({ field: s.field, dims: s.dims, iso: 0, origin: s.origin, voxel: [s.voxel, s.voxel, s.voxel] });
    cases.push({ field: s.field, dims: s.dims, iso: 0.03, origin: [3, -2, 0.5], voxel: [0.5, 0.25, 2] });
    for (let seed = 1; seed <= 60; seed++) {
      const r = randomField(seed, 7);
      cases.push({ field: r.field, dims: r.dims, iso: seed % 5 === 0 ? 0.25 : 0, origin: [0, 0, 0], voxel: [1, 1, 1] });
    }
    for (const c of cases) {
      const ours = marchingCubes(c.field, c.dims, { iso: c.iso, origin: c.origin, voxel: c.voxel, border: 'open' });
      const reference = referenceSoup(c.field, c.dims, c.iso, c.origin, c.voxel);
      expect(triangleKeys(ours)).toEqual(triangleKeys(reference));
    }
  });
});

// ---- the clamp and exact zeros ---------------------------------------------------------------------------

describe('marchingCubes clamp and zero rule', () => {
  it('a sample exactly at the level is inside, and the vertex stays 0.01 voxel away from it', () => {
    // f = x − 3 on a 6×2×2 lattice: the samples at x = 3 are exactly 0.
    const dims: [number, number, number] = [6, 2, 2];
    const field = new Float32Array(24);
    for (let i = 0; i < 24; i++) field[i] = (i % 6) - 3;
    const m = marchingCubes(field, dims, { border: 'open' });
    expect(m.positions.length / 3).toBe(4);
    for (let i = 0; i < m.positions.length; i += 3) expect(m.positions[i]).toBe(Math.fround(2 + MC_T_MAX));
    // The same plane seen from the other side: f = 3 − x, zero samples inside again.
    const flipped = marchingCubes(
      field.map((v) => -v),
      dims,
      { border: 'open' },
    );
    for (let i = 0; i < flipped.positions.length; i += 3) expect(flipped.positions[i]).toBe(Math.fround(3 + MC_T_MIN));
  });

  it('a field of exact zeros is all inside', () => {
    const zeros = new Float32Array(27);
    expect(marchingCubes(zeros, [3, 3, 3], { border: 'open' }).indices.length).toBe(0);
    const closed = marchingCubes(zeros, [3, 3, 3]);
    expectClosedSurface(closed);
    expect(eulerCharacteristic(closed.indices)).toBe(2);
  });

  it('keeps every vertex at least 0.01 voxel from the lattice points and makes no zero-area triangle', () => {
    // Integer-valued and near-zero fields put the surface exactly on, or within 1e-6 of, lattice points.
    let smallest = Infinity;
    for (let seed = 2; seed <= 400; seed += 4) {
      for (const s of [seed, seed + 1]) {
        const { field, dims } = randomField(s, 8);
        const m = marchingCubes(field, dims);
        expect(countZeroAreaTriangles(m)).toBe(0);
        if (m.indices.length > 0) smallest = Math.min(smallest, minTriangleArea(m));
        let tooClose = 0;
        for (let i = 0; i < m.positions.length; i++) {
          const frac = m.positions[i] - Math.floor(m.positions[i]);
          // On a lattice line (frac 0 for the two fixed coordinates) or clamped away from the lattice points.
          if (frac !== 0 && !(frac > MC_T_MIN - 1e-6 && frac < MC_T_MAX + 1e-6)) tooClose++;
        }
        expect(tooClose).toBe(0);
      }
    }
    // The smallest possible triangle cuts a corner at t = 0.01 on three edges: area √3/2 · 0.01².
    expect(smallest).toBeGreaterThan(0.999 * (Math.sqrt(3) / 2) * MC_T_MIN ** 2);
    expect(smallest).toBeLessThan(1.001 * (Math.sqrt(3) / 2) * MC_T_MIN ** 2);
  });

  it('interpolates linearly between the clamps', () => {
    // One inside sample between two outside ones along x: values −1, 3, −3 → crossings at t = 0.25 and 0.5.
    const dims: [number, number, number] = [3, 1, 1];
    const m = marchingCubes(Float32Array.of(-1, 3, -3), dims);
    const xs = new Set<number>();
    for (let i = 0; i < m.positions.length; i += 3) {
      if (m.positions[i + 1] === 0 && m.positions[i + 2] === 0) xs.add(m.positions[i]);
    }
    expect([...xs].sort()).toEqual([0.25, 1.5]);
  });
});

// ---- placement, units, level -----------------------------------------------------------------------------

describe('marchingCubes placement and level', () => {
  it('places sample (x, y, z) at origin + voxel·(x, y, z), per axis', () => {
    const s = sampleField(20, sphere(0.8));
    const unit = marchingCubes(s.field, s.dims);
    const origin: Vec3 = [10, -4, 2.5];
    const voxel: Vec3 = [0.5, 2, 0.125];
    const placed = marchingCubes(s.field, s.dims, { origin, voxel });
    expect(placed.indices).toEqual(unit.indices);
    let worst = 0;
    for (let i = 0; i < unit.positions.length; i++) {
      worst = Math.max(worst, Math.abs(placed.positions[i] - (origin[i % 3] + voxel[i % 3] * unit.positions[i])));
    }
    // Both sides were rounded to float32 once, at different magnitudes.
    expect(worst).toBeLessThan(4e-6);
    // An isotropic `voxel` number is the same as three equal entries.
    expect(marchingCubes(s.field, s.dims, { voxel: 0.5 })).toEqual(marchingCubes(s.field, s.dims, { voxel: [0.5, 0.5, 0.5] }));
    // A mesh in world units has the world volume.
    expect(signedVolume(placed) / signedVolume(unit)).toBeCloseTo(0.5 * 2 * 0.125, 6);
  });

  it('meshes the level `iso`: a positive level shrinks a distance field, a negative one grows it', () => {
    const s = sampleField(64, sphere(0.8));
    const smaller = mesh(s, { iso: 0.1 });
    const larger = mesh(s, { iso: -0.15 });
    expectClosedSurface(smaller);
    expectClosedSurface(larger);
    expect(Math.abs(signedVolume(smaller) / sphereVolume(0.7) - 1)).toBeLessThan(0.003);
    expect(Math.abs(signedVolume(larger) / sphereVolume(0.95) - 1)).toBeLessThan(0.003);
  });

  it('non-cubic grids work (the merge grid of §2.9.8 is N = 96 on its longest side only)', () => {
    const dims: [number, number, number] = [40, 17, 9];
    const field = new Float32Array(dims[0] * dims[1] * dims[2]);
    let i = 0;
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          field[i++] = 1 - Math.sqrt(((x - 19.3) / 16) ** 2 + ((y - 8.1) / 6) ** 2 + ((z - 4.2) / 3) ** 2);
        }
      }
    }
    const m = marchingCubes(field, dims);
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(2);
    // Coarse on purpose (the smallest radius is 3 voxels): flat triangles cut the volume by 2.6%.
    const ratio = signedVolume(m) / ((4 / 3) * Math.PI * 16 * 6 * 3);
    expect(ratio).toBeGreaterThan(0.96);
    expect(ratio).toBeLessThan(1);
  });
});

// ---- the border ------------------------------------------------------------------------------------------

describe('marchingCubes at the border of the lattice', () => {
  it("'closed' (default) caps the solid at the lattice box: still watertight, χ = 2", () => {
    // A sphere of radius 1.3 does not fit in [−1.1, 1.1]³: it is cut by all six faces of the box.
    const s = sampleField(40, sphere(1.3));
    const m = mesh(s);
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(2);
    expect(countComponents(m.indices)).toBe(1);
    // The caps lie 0.01 voxel beyond the outermost samples.
    const { min, max } = meshBounds(m.positions);
    for (let a = 0; a < 3; a++) {
      expect(min[a]).toBeCloseTo(-HALF - MC_T_MIN * s.voxel, 6);
      expect(max[a]).toBeCloseTo(HALF + MC_T_MIN * s.voxel, 6);
    }
    // Volume: the sphere minus six caps of height 1.3 − 1.1 (they do not overlap: 2·1.1² > 1.3²).
    const cap = (Math.PI * 0.2 ** 2 * (3 * 1.3 - 0.2)) / 3;
    const clipped = sphereVolume(1.3) - 6 * cap;
    // Measured: 0.99988.
    expect(Math.abs(signedVolume(m) / clipped - 1)).toBeLessThan(0.005);
  });

  it("'open' leaves a hole where the inside reaches the box; every boundary vertex is on the box", () => {
    const s = sampleField(40, sphere(1.3));
    const m = mesh(s, { border: 'open' });
    const edges = edgeStats(m.indices);
    expect(edges.boundaryEdges).toBeGreaterThan(0);
    expect(edges.nonManifoldEdges).toBe(0);
    expect(edges.misorientedEdges).toBe(0);
    expect(countNonManifoldVertices(m.indices)).toBe(0);
    expect(countZeroAreaTriangles(m)).toBe(0);
    // Six round holes in a sphere: χ = 2 − 6.
    expect(eulerCharacteristic(m.indices)).toBe(-4);
    // Collect the vertices of boundary edges and check that each lies on a face of the box.
    const uses = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e];
        const b = m.indices[t + ((e + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    let boundaryVertices = 0;
    let offBox = 0;
    for (const [key, count] of uses) {
      if (count !== 1) continue;
      for (const v of key.split(',').map(Number)) {
        boundaryVertices++;
        if (![0, 1, 2].some((a) => Math.abs(Math.abs(m.positions[3 * v + a]) - HALF) < 1e-6)) offBox++;
      }
    }
    expect(boundaryVertices).toBe(2 * edges.boundaryEdges);
    expect(offBox).toBe(0);
    // Nothing leaves the lattice box in open mode.
    const { min, max } = meshBounds(m.positions);
    for (let a = 0; a < 3; a++) {
      expect(min[a]).toBeGreaterThanOrEqual(-HALF - 1e-6);
      expect(max[a]).toBeLessThanOrEqual(HALF + 1e-6);
    }
  });

  it('both modes give the same mesh when every border sample is outside', () => {
    const s = sampleField(32, teddy);
    const closed = mesh(s);
    const open = mesh(s, { border: 'open' });
    expect(triangleKeys(open)).toEqual(triangleKeys(closed));
    expect(open.indices).toEqual(closed.indices);
    expect(open.positions).toEqual(closed.positions);
  });

  it("'closed' is exactly 'open' on the field padded with one layer of far-outside samples", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { field, dims } = randomField(seed, 6);
      const [nx, ny, nz] = dims;
      const padded = new Float32Array((nx + 2) * (ny + 2) * (nz + 2)).fill(-Infinity);
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) padded[x + 1 + (nx + 2) * (y + 1 + (ny + 2) * (z + 1))] = field[x + nx * (y + ny * z)];
        }
      }
      const origin: Vec3 = [1.5, -2, 0.25];
      const voxel: Vec3 = [0.5, 0.25, 1];
      const closed = marchingCubes(field, dims, { origin, voxel });
      const open = marchingCubes(padded, [nx + 2, ny + 2, nz + 2], {
        origin: [origin[0] - voxel[0], origin[1] - voxel[1], origin[2] - voxel[2]],
        voxel,
        border: 'open',
      });
      expect(open.indices).toEqual(closed.indices);
      expect(open.positions).toEqual(closed.positions);
    }
  });

  it('an all-inside field: a closed box with the border closed, nothing with it open', () => {
    const dims: [number, number, number] = [5, 4, 3];
    const field = new Float32Array(60).fill(2);
    expect(marchingCubes(field, dims, { border: 'open' })).toEqual({ positions: new Float32Array(0), indices: new Uint32Array(0) });
    const box = marchingCubes(field, dims);
    expectClosedSurface(box);
    expect(eulerCharacteristic(box.indices)).toBe(2);
    // The box spans −0.01 … n − 1 + 0.01 on each axis, with corners cut at 0.01.
    const { min, max } = meshBounds(box.positions);
    expect(min.map((v) => Math.fround(v))).toEqual([-0.01, -0.01, -0.01].map((v) => Math.fround(v)));
    expect(max.map((v) => Math.fround(v))).toEqual([4.01, 3.01, 2.01].map((v) => Math.fround(v)));
    expect(signedVolume(box)).toBeCloseTo(4.02 * 3.02 * 2.02, 2);
  });

  it('an all-outside field and a lattice without cells give an empty mesh', () => {
    const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
    expect(marchingCubes(new Float32Array(27).fill(-1), [3, 3, 3])).toEqual(empty);
    expect(marchingCubes(new Float32Array(27).fill(-1), [3, 3, 3], { border: 'open' })).toEqual(empty);
    // One layer of samples has no cells of its own: empty when open, a thin closed slab when closed.
    const layer = new Float32Array(16).fill(1);
    expect(marchingCubes(layer, [4, 4, 1], { border: 'open' })).toEqual(empty);
    const slab = marchingCubes(layer, [4, 4, 1]);
    expectClosedSurface(slab);
    // A single inside sample becomes an octahedron of half-width 0.01 around it.
    const dot = marchingCubes(Float32Array.of(1), [1, 1, 1], { origin: [5, 6, 7] });
    expectClosedSurface(dot);
    expect(dot.positions.length / 3).toBe(6);
    expect(dot.indices.length / 3).toBe(8);
    // (float32 positions near 5…7 carry the 0.01 offsets to about four digits)
    expect(signedVolume(dot) / ((4 / 3) * 0.01 ** 3)).toBeCloseTo(1, 3);
  });
});

// ---- hostile input ---------------------------------------------------------------------------------------

describe('marchingCubes on arbitrary fields', HEAVY, () => {
  it('is a closed, oriented 2-manifold for every random field (closed border)', () => {
    let triangles = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { field, dims } = randomField(seed);
      const m = marchingCubes(field, dims);
      expectClosedSurface(m);
      // Each connected piece of a closed orientable surface has an even Euler characteristic ≤ 2.
      expect(Math.abs(eulerCharacteristic(m.indices) % 2)).toBe(0);
      expect(eulerCharacteristic(m.indices)).toBeLessThanOrEqual(2 * countComponents(m.indices));
      triangles += m.indices.length / 3;
    }
    expect(triangles).toBeGreaterThan(20000);
  });

  it('with an open border: no non-manifold edge or vertex, consistent winding, every vertex used', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { field, dims } = randomField(seed);
      const m = marchingCubes(field, dims, { border: 'open' });
      const edges = edgeStats(m.indices);
      expect(edges.nonManifoldEdges).toBe(0);
      expect(edges.misorientedEdges).toBe(0);
      expect(countNonManifoldVertices(m.indices)).toBe(0);
      expect(countUsedVertices(m.indices)).toBe(m.positions.length / 3);
      expect(countZeroAreaTriangles(m)).toBe(0);
    }
  });

  it('is watertight for every inside/outside pattern of two cells that share a face (all 3 × 4096)', () => {
    // A mesh edge lies in one cell or on the face between two cells, so this covers every edge the mesher
    // can ever produce. (All 3 × 2^18 patterns of the four cells around a lattice edge were checked the same
    // way when this kernel was written: 0 defects.)
    for (const dims of [
      [3, 2, 2],
      [2, 3, 2],
      [2, 2, 3],
    ] as [number, number, number][]) {
      const field = new Float32Array(12);
      for (let bits = 0; bits < 4096; bits++) {
        for (let i = 0; i < 12; i++) field[i] = (bits >> i) & 1 ? 1 : -1;
        const m = marchingCubes(field, dims);
        const edges = edgeStats(m.indices);
        if (edges.boundaryEdges + edges.nonManifoldEdges + edges.misorientedEdges !== 0 || countNonManifoldVertices(m.indices) !== 0) {
          throw new Error(`pattern ${bits} on ${dims.join('×')} is not a closed manifold: ${JSON.stringify(edges)}`);
        }
      }
    }
  });

  it('is watertight around a lattice edge for a seeded sample of the 2^18 four-cell patterns', () => {
    const rng = mulberry32(20261001);
    for (const dims of [
      [3, 3, 2],
      [3, 2, 3],
      [2, 3, 3],
    ] as [number, number, number][]) {
      const field = new Float32Array(18);
      for (let trial = 0; trial < 3000; trial++) {
        const bits = Math.floor(rng() * (1 << 18));
        for (let i = 0; i < 18; i++) field[i] = (bits >> i) & 1 ? 1 : -1;
        const m = marchingCubes(field, dims);
        const edges = edgeStats(m.indices);
        if (edges.boundaryEdges + edges.nonManifoldEdges + edges.misorientedEdges !== 0 || countNonManifoldVertices(m.indices) !== 0) {
          throw new Error(`pattern ${bits} on ${dims.join('×')} is not a closed manifold: ${JSON.stringify(edges)}`);
        }
      }
    }
  });

  it('on every checkerboard face of every cell pattern the surface cuts off the OUTSIDE corners', () => {
    // So the inside is connected across a face diagonal (and the outside is not): inside voxels that share an
    // edge end up in one piece, outside voxels are connected through faces only.
    let checkerboardFaces = 0;
    const field = new Float32Array(8);
    for (let cube = 0; cube < 256; cube++) {
      // Sample (x, y, z) of the 2×2×2 lattice is inside when its bit is clear.
      const inside = (x: number, y: number, z: number): boolean => ((cube >> (x + 2 * y + 4 * z)) & 1) === 0;
      for (let i = 0; i < 8; i++) field[i] = (cube >> i) & 1 ? -1 : 1;
      const m = marchingCubes(field, [2, 2, 2], { border: 'open' });
      for (let axis = 0; axis < 3; axis++) {
        for (const side of [0, 1]) {
          const u = (axis + 1) % 3;
          const v = (axis + 2) % 3;
          const corner = (a: number, b: number): boolean => {
            const c = [0, 0, 0];
            c[axis] = side;
            c[u] = a;
            c[v] = b;
            return inside(c[0], c[1], c[2]);
          };
          if (!(corner(0, 0) === corner(1, 1) && corner(1, 0) === corner(0, 1) && corner(0, 0) !== corner(1, 0))) continue;
          checkerboardFaces++;
          // Triangle edges that lie in this face: both ends have coordinate `side` along `axis`.
          let segments = 0;
          for (let k = 0; k < m.indices.length; k += 3) {
            for (let e = 0; e < 3; e++) {
              const p = 3 * m.indices[k + e];
              const q = 3 * m.indices[k + ((e + 1) % 3)];
              if (m.positions[p + axis] !== side || m.positions[q + axis] !== side) continue;
              segments++;
              // The two crossed lattice edges meet in one corner of the face: the corner the segment cuts off.
              const a = m.positions[p + u] === 0.5 ? m.positions[q + u] : m.positions[p + u];
              const b = m.positions[p + v] === 0.5 ? m.positions[q + v] : m.positions[p + v];
              expect(corner(a, b)).toBe(false);
            }
          }
          expect(segments).toBe(2);
        }
      }
    }
    expect(checkerboardFaces).toBeGreaterThan(100);
  });

  it('on a checkerboard face the inside corners are joined (the tables never leave a crack there)', () => {
    // 2×2×2 samples, inside on one diagonal of the bottom face only: one piece when the diagonal is joined.
    const joined = marchingCubes(Float32Array.of(1, -1, -1, 1, -1, -1, -1, -1), [2, 2, 2]);
    expectClosedSurface(joined);
    expect(countComponents(joined.indices)).toBe(1);
    // Inside on a body diagonal: nothing joins them, two pieces.
    const apart = marchingCubes(Float32Array.of(1, -1, -1, -1, -1, -1, -1, 1), [2, 2, 2]);
    expectClosedSurface(apart);
    expect(countComponents(apart.indices)).toBe(2);
  });

  it('treats +Infinity as deep inside, −Infinity as far outside and NaN as outside; never emits a NaN', () => {
    const s = sampleField(24, sphere(0.8));
    const plain = mesh(s);
    // Saturating the far field changes nothing: only the samples next to the surface matter.
    const saturated = Float32Array.from(s.field, (v) => (v > 0.3 ? Infinity : v < -0.3 ? -Infinity : v));
    expect(marchingCubes(saturated, s.dims, { origin: s.origin, voxel: s.voxel })).toEqual(plain);
    // An all-infinite sign field still gives a closed surface, with vertices at the edge midpoints.
    const signs = Float32Array.from(s.field, (v) => (v >= 0 ? Infinity : -Infinity));
    const blocky = marchingCubes(signs, s.dims);
    expectClosedSurface(blocky);
    expect(eulerCharacteristic(blocky.indices)).toBe(2);
    let offMidpoint = 0;
    for (let i = 0; i < blocky.positions.length; i++) if ((blocky.positions[i] * 2) % 1 !== 0) offMidpoint++;
    expect(offMidpoint).toBe(0);
    // NaN samples are holes in the data: outside.
    const holed = Float32Array.from(s.field);
    const center = 12 + 24 * (12 + 24 * 12);
    holed[center] = NaN;
    const withHole = marchingCubes(holed, s.dims);
    expectClosedSurface(withHole);
    expect(countComponents(withHole.indices)).toBe(2);
    expect(marchingCubes(new Float32Array(8).fill(NaN), [2, 2, 2]).indices.length).toBe(0);
  });

  it('rejects malformed input', () => {
    const f = new Float32Array(8);
    expect(() => marchingCubes(f, [2, 2, 3])).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 0] as never)).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2.5, 2])).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 4] as never)).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2, 1] as never)).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { origin: [0, 0] as never })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { voxel: 0 })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { voxel: [1, -1, 1] })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { voxel: NaN })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { origin: [0, Infinity, 0] })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { iso: NaN })).toThrow(RangeError);
    expect(() => marchingCubes(f, [2, 2, 2], { border: 'padded' as never })).toThrow(RangeError);
  });

  it('meshes a long thin lattice (two slices in memory at a time; marchingCubes.reference.test.ts measures that)', () => {
    // 6×6×4000 samples with a tube along z; the buffers that are not output are 8×8 slices.
    const dims: [number, number, number] = [6, 6, 4000];
    const field = new Float32Array(36 * 4000);
    for (let i = 0; i < field.length; i++) {
      const x = i % 6;
      const y = Math.floor(i / 6) % 6;
      field[i] = 1.7 - Math.hypot(x - 2.5, y - 2.5);
    }
    const m = marchingCubes(field, dims);
    expectClosedSurface(m);
    expect(eulerCharacteristic(m.indices)).toBe(2);
    expect(meshBounds(m.positions).max[2]).toBeCloseTo(3999.01, 2);
  });
});

// ---- SdfVolume -------------------------------------------------------------------------------------------

describe('marchingCubesSdf', HEAVY, () => {
  it('meshes a stored Int16 volume in inches, with the topology of the float field it was encoded from', () => {
    const s = sampleField(48, teddy);
    // Pretend the scene is in inches with a 0.1 in voxel and some origin.
    const voxel = 0.1;
    const origin: Vec3 = [-2.4, 0, -2.4];
    const inches = Float32Array.from(s.field, (v) => (v / s.voxel) * voxel);
    const volume = encodeSdfVolume(inches, s.dims, origin, voxel);
    expect(volume.data).toBeInstanceOf(Int16Array);
    const fromFloat = marchingCubes(inches, s.dims, { origin, voxel });
    const fromVolume = marchingCubesSdf(volume);
    expectClosedSurface(fromVolume);
    // Same inside/outside samples ⇒ same triangles; positions move by the quantization only. A vertex can
    // slide along an edge that is nearly tangent to the surface (both end values close to 0), so the bound on
    // single vertices is loose; the mean and the enclosed volume show how little the surface moves.
    expect(fromVolume.indices).toEqual(fromFloat.indices);
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < fromFloat.positions.length; i++) {
      const d = Math.abs(fromVolume.positions[i] - fromFloat.positions[i]);
      worst = Math.max(worst, d);
      sum += d;
    }
    expect(worst).toBeLessThan(0.1 * voxel);
    expect(sum / fromFloat.positions.length).toBeLessThan(0.001 * voxel);
    expect(Math.abs(signedVolume(fromVolume) / signedVolume(fromFloat) - 1)).toBeLessThan(1e-4);
    const { min, max } = meshBounds(fromVolume.positions);
    expect(min[1]).toBeGreaterThan(0);
    expect(max[1]).toBeLessThan(47 * voxel);
  });

  it('takes the level in inches and the border option', () => {
    const s = sampleField(40, sphere(0.8));
    const voxel = 0.25;
    const scale = voxel / s.voxel;
    const volume = encodeSdfVolume(
      Float32Array.from(s.field, (v) => v * scale),
      s.dims,
      [0, 0, 0],
      voxel,
    );
    const r = 0.8 * scale;
    expect(Math.abs(signedVolume(marchingCubesSdf(volume)) / sphereVolume(r) - 1)).toBeLessThan(0.005);
    expect(Math.abs(signedVolume(marchingCubesSdf(volume, { iso: 0.5 })) / sphereVolume(r - 0.5) - 1)).toBeLessThan(0.005);
    expect(Math.abs(signedVolume(marchingCubesSdf(volume, { iso: -0.5 })) / sphereVolume(r + 0.5) - 1)).toBeLessThan(0.005);
    expect(marchingCubesSdf(volume, { border: 'open' })).toEqual(marchingCubesSdf(volume));
    expect(() => marchingCubesSdf({ ...volume, voxel: 0 })).toThrow(RangeError);
  });
});
