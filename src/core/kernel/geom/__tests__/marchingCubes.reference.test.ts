// marchingCubes.ts, the triangles and positions themselves. From the independent review of Step 0b; it shares
// no code with the kernel or with marchingCubes.test.ts.
//
// A reference mesher with its own bookkeeping (one cell at a time, vertices in a Map keyed by lattice edge, the
// padded lattice built explicitly) is compared with the kernel triangle for triangle; then the documented rules
// (clamp, zero rule, border, bounds, array types, determinism, float32 limits) are checked one by one.
import { triTable } from 'three/addons/objects/MarchingCubes.js';
import { describe, expect, it } from 'vitest';
import type { SdfVolume, Vec3 } from '../../../../types/geometry';
import { mulberry32 } from '../../prng';
import { type IndexedMesh, marchingCubes, marchingCubesSdf } from '../marchingCubes';
import { note } from './fields';

type Dims = [number, number, number];
type FieldArray = Float32Array | Float64Array | Int16Array | number[];

const CORNER: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const EDGE: [number, number][] = [
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

/** The documented value rules: NaN and −Infinity far outside, +Infinity deep inside, an exact zero just inside. */
function sanitize(raw: number, iso: number): number {
  const v = raw - iso;
  if (Number.isNaN(v) || v <= -1e30) return -1e30;
  if (v >= 1e30) return 1e30;
  return v === 0 ? 1e-6 : v;
}

function referenceMesh(field: ArrayLike<number>, dims: Dims, iso: number, origin: Vec3, voxel: Vec3, border: 'closed' | 'open'): IndexedMesh {
  const pad = border === 'closed' ? 1 : 0;
  const [nx, ny, nz] = dims;
  const size = [nx + 2 * pad, ny + 2 * pad, nz + 2 * pad];
  const value = (X: number, Y: number, Z: number): number => {
    const x = X - pad;
    const y = Y - pad;
    const z = Z - pad;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return -1e30;
    return sanitize(field[x + nx * (y + ny * z)], iso);
  };
  // World position of padded index 0: the documented "origin shifted by one voxel" of the closed border.
  const o = [origin[0] - pad * voxel[0], origin[1] - pad * voxel[1], origin[2] - pad * voxel[2]];
  const vertexOf = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let Z = 0; Z + 1 < size[2]; Z++) {
    for (let Y = 0; Y + 1 < size[1]; Y++) {
      for (let X = 0; X + 1 < size[0]; X++) {
        const d = CORNER.map((c) => value(X + c[0], Y + c[1], Z + c[2]));
        let cube = 0;
        for (let k = 0; k < 8; k++) if (d[k] < 0) cube |= 1 << k;
        for (let k = 16 * cube; triTable[k] !== -1; k++) {
          let [a, b] = EDGE[triTable[k]];
          if (CORNER[a][0] + CORNER[a][1] + CORNER[a][2] > CORNER[b][0] + CORNER[b][1] + CORNER[b][2]) [a, b] = [b, a];
          const axis = [0, 1, 2].find((i) => CORNER[a][i] !== CORNER[b][i]) as number;
          const lower = [X + CORNER[a][0], Y + CORNER[a][1], Z + CORNER[a][2]];
          const key = `${axis}:${lower.join(',')}`;
          let vertex = vertexOf.get(key);
          if (vertex === undefined) {
            const t = Math.min(0.99, Math.max(0.01, d[a] / (d[a] - d[b])));
            vertex = positions.length / 3;
            vertexOf.set(key, vertex);
            for (let i = 0; i < 3; i++) positions.push(o[i] + voxel[i] * (lower[i] + (i === axis ? t : 0)));
          }
          indices.push(vertex);
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Triangles as position triples, rotated so the smallest corner comes first (winding kept), sorted. */
function canonical(m: IndexedMesh): string[] {
  const corner = (v: number): string => `${m.positions[3 * v]} ${m.positions[3 * v + 1]} ${m.positions[3 * v + 2]}`;
  const keys: string[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const c = [corner(m.indices[t]), corner(m.indices[t + 1]), corner(m.indices[t + 2])];
    const first = c.indexOf([...c].sort()[0]);
    keys.push(`${c[first]} | ${c[(first + 1) % 3]} | ${c[(first + 2) % 3]}`);
  }
  return keys.sort();
}

function distinctPositions(m: IndexedMesh): number {
  const set = new Set<string>();
  for (let i = 0; i < m.positions.length; i += 3) set.add(`${m.positions[i]} ${m.positions[i + 1]} ${m.positions[i + 2]}`);
  return set.size;
}

function sameBytes(a: IndexedMesh, b: IndexedMesh): boolean {
  return Buffer.from(a.positions.buffer).equals(Buffer.from(b.positions.buffer)) && Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer));
}

function hostile(seed: number, maxDim: number): { field: FieldArray; dims: Dims; iso: number; origin: Vec3; voxel: Vec3 } {
  const rng = mulberry32(seed * 104729 + 7);
  const dim = (): number => 1 + Math.floor(rng() * maxDim);
  const dims: Dims = [dim(), dim(), dim()];
  const n = dims[0] * dims[1] * dims[2];
  const kind = seed % 7;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rng() * 2 - 1;
    if (kind === 0) values[i] = r;
    else if (kind === 1) values[i] = r < 0 ? -1 : 1;
    else if (kind === 2) values[i] = Math.round(r * 2);
    else if (kind === 3) values[i] = r * [1e-12, 1e-6, 1e-3, 1, 1e6, 1e12][Math.floor(rng() * 6)];
    else if (kind === 4) {
      const pick = rng();
      values[i] = pick < 0.08 ? NaN : pick < 0.16 ? Infinity : pick < 0.24 ? -Infinity : pick < 0.32 ? 0 : pick < 0.4 ? -0 : r;
    } else if (kind === 5) values[i] = Math.round(r * 300);
    else values[i] = r + 0.4;
  }
  const type = seed % 4;
  let field: FieldArray;
  if (kind === 5 && type === 1) field = Int16Array.from(values);
  else if (type === 0) field = Float32Array.from(values);
  else if (type === 2) field = Array.from(values);
  else field = values;
  const iso = seed % 5 === 0 ? 0.25 : seed % 11 === 0 ? -1 : 0;
  const plain = seed % 3 === 0;
  const origin: Vec3 = plain ? [0, 0, 0] : [rng() * 20 - 10, rng() * 20 - 10, rng() * 20 - 10];
  const voxel: Vec3 = plain ? [1, 1, 1] : [0.05 + rng() * 2, 0.05 + rng() * 2, 0.05 + rng() * 2];
  return { field, dims, iso, origin, voxel };
}

describe('marchingCubes against an independent reference mesher', () => {
  it('gives exactly the reference triangles and one vertex per crossed lattice edge (closed and open, 600 hostile fields)', () => {
    let triangles = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const h = hostile(seed, 8);
      for (const border of ['closed', 'open'] as const) {
        const ours = marchingCubes(h.field, h.dims, { iso: h.iso, origin: h.origin, voxel: h.voxel, border });
        const reference = referenceMesh(h.field, h.dims, h.iso, h.origin, h.voxel, border);
        if (ours.positions.length !== reference.positions.length || ours.indices.length !== reference.indices.length) {
          throw new Error(`seed ${seed} ${border}: ${ours.positions.length / 3} vertices / ${ours.indices.length / 3} triangles, reference ${reference.positions.length / 3} / ${reference.indices.length / 3}`);
        }
        // one vertex per lattice edge ⇒ no two vertices at the same place
        if (distinctPositions(ours) !== ours.positions.length / 3) throw new Error(`seed ${seed} ${border}: duplicate vertex positions`);
        const a = canonical(ours);
        const b = canonical(reference);
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) throw new Error(`seed ${seed} ${border}: triangle ${i} differs:\n  ours      ${a[i]}\n  reference ${b[i]}`);
        }
        triangles += a.length;
      }
    }
    expect(triangles).toBeGreaterThan(80_000);
  });

  it("'closed' is byte-identical to 'open' on the field padded with −Infinity (origin shifted by one voxel), hostile fields included", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const h = hostile(seed, 7);
      const [nx, ny, nz] = h.dims;
      const padded = new Float64Array((nx + 2) * (ny + 2) * (nz + 2)).fill(-Infinity);
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) padded[x + 1 + (nx + 2) * (y + 1 + (ny + 2) * (z + 1))] = h.field[x + nx * (y + ny * z)];
        }
      }
      const closed = marchingCubes(h.field, h.dims, { iso: h.iso, origin: h.origin, voxel: h.voxel });
      const open = marchingCubes(padded, [nx + 2, ny + 2, nz + 2], {
        iso: h.iso,
        origin: [h.origin[0] - h.voxel[0], h.origin[1] - h.voxel[1], h.origin[2] - h.voxel[2]],
        voxel: h.voxel,
        border: 'open',
      });
      if (!sameBytes(closed, open)) throw new Error(`seed ${seed}: closed and padded-open differ`);
    }
  });

  it('gives byte-identical buffers for the same values in any array type, on repeated and interleaved runs, and never writes the field', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const h = hostile(seed, 7);
      const options = { iso: h.iso, origin: h.origin, voxel: h.voxel };
      const first = marchingCubes(h.field, h.dims, options);
      // a frozen plain array: a write would throw (the test files are modules, so strict mode)
      const frozen = Object.freeze(Array.from(h.field));
      const before = Array.from(h.field);
      const copies: ArrayLike<number>[] = [frozen, Float64Array.from(h.field)];
      if (h.field instanceof Float32Array) copies.push(Float32Array.from(h.field));
      if (h.field instanceof Int16Array) copies.push(Int32Array.from(h.field), Float32Array.from(h.field));
      for (const copy of copies) {
        // another call in between must not leave state behind
        marchingCubes(Float32Array.of(1, -1, -1, 1, -1, 1, 1, -1), [2, 2, 2], { border: seed % 2 ? 'open' : 'closed' });
        if (!sameBytes(marchingCubes(copy, h.dims, options), first)) throw new Error(`seed ${seed}: a copy of the field gives other buffers`);
      }
      const after = Array.from(h.field);
      for (let i = 0; i < before.length; i++) if (!Object.is(before[i], after[i])) throw new Error(`seed ${seed}: field modified at ${i}`);
      expect(first.positions.buffer.byteLength).toBe(first.positions.byteLength);
      expect(first.indices.buffer.byteLength).toBe(first.indices.byteLength);
      expect(first.positions.buffer).toBeInstanceOf(ArrayBuffer);
    }
  });

  it('topology depends only on the signs: origin, voxel size and positive scaling of the field leave the index buffer alone', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const h = hostile(seed, 7);
      const base = marchingCubes(h.field, h.dims, { iso: h.iso });
      const moved = marchingCubes(h.field, h.dims, { iso: h.iso, origin: [123.5, -0.001, 7e3], voxel: [0.01, 3, 250] });
      expect(Buffer.from(moved.indices.buffer).equals(Buffer.from(base.indices.buffer))).toBe(true);
      const scaled = marchingCubes(
        Float64Array.from(h.field, (v) => v * 8),
        h.dims,
        { iso: h.iso * 8 },
      );
      // a power-of-two scale changes no rounding: the whole mesh is the same, bit for bit …
      // … except where the 1e-6 zero replacement (in field units) meets a value that scaled: skip fields with zeros.
      const hasZero = Array.from(h.field).some((v) => v - h.iso === 0);
      const hasHuge = Array.from(h.field).some((v) => Math.abs(v - h.iso) * 8 >= 1e30 && Number.isFinite(v));
      if (!hasZero && !hasHuge) expect(sameBytes(scaled, base)).toBe(true);
      else expect(Buffer.from(scaled.indices.buffer).equals(Buffer.from(base.indices.buffer))).toBe(true);
    }
  });
});

// ---- the documented rules, one at a time ---------------------------------------------------------------------

/** x of the single crossing on a 2×1×1 open… no cells there, so use a 2×2×2 lattice that is constant along y and z. */
function crossingX(a: number, b: number, iso = 0): number[] {
  const m = marchingCubes([a, b, a, b, a, b, a, b], [2, 2, 2], { iso, border: 'open' });
  const xs = new Set<number>();
  for (let i = 0; i < m.positions.length; i += 3) xs.add(m.positions[i]);
  return [...xs];
}

describe('clamp, zero rule and level', () => {
  it('t = (iso − f0)/(f1 − f0), clamped to [0.01, 0.99]', () => {
    expect(crossingX(1, -1)).toEqual([0.5]);
    expect(crossingX(1, -3)).toEqual([0.25]);
    expect(crossingX(-3, 1)).toEqual([0.75]);
    expect(crossingX(3, 1, 2)).toEqual([0.5]);
    expect(crossingX(1e-9, -1)).toEqual([Math.fround(0.01)]);
    expect(crossingX(-1, 1e-9)).toEqual([Math.fround(0.99)]);
    expect(crossingX(1, -1e-9)).toEqual([Math.fround(0.99)]);
    expect(crossingX(-1e-9, 1)).toEqual([Math.fround(0.01)]);
    // exactly on the clamp
    expect(crossingX(0.01, -0.99)).toEqual([Math.fround(0.01)]);
    expect(crossingX(0.99, -0.01)).toEqual([Math.fround(0.99)]);
  });

  it('a sample exactly at the level is inside (also −0, also at a non-zero level), and is replaced by 1e-6', () => {
    expect(crossingX(0, -1)).toEqual([Math.fround(0.01)]);
    expect(crossingX(-0, -1)).toEqual([Math.fround(0.01)]);
    expect(crossingX(-1, 0)).toEqual([Math.fround(0.99)]);
    expect(crossingX(2.5, 1, 2.5)).toEqual([Math.fround(0.01)]);
    expect(crossingX(0, 0)).toEqual([]);
    // 1e-6 is in field units: against a neighbor of −1e-6 the crossing is at 0.5 …
    expect(crossingX(0, -1e-6)).toEqual([0.5]);
    // … and against a neighbor much closer to zero than 1e-6 the vertex lands next to the OUTSIDE sample,
    // although the level set passes through the zero sample itself (the true crossing is at t = 0).
    // Observed behavior, a consequence of the spec's constant; harmless while |field| near the surface ≫ 1e-6.
    expect(crossingX(0, -1e-9)).toEqual([Math.fround(0.99)]);
  });

  it('±Infinity, NaN and values beyond ±1e30', () => {
    expect(crossingX(Infinity, -1)).toEqual([Math.fround(0.99)]);
    expect(crossingX(Infinity, -Infinity)).toEqual([0.5]);
    expect(crossingX(1, -Infinity)).toEqual([Math.fround(0.01)]);
    expect(crossingX(1, NaN)).toEqual([Math.fround(0.01)]);
    expect(crossingX(NaN, NaN)).toEqual([]);
    // Finite values beyond ±1e30 are treated like ±Infinity: the true crossing of (1e35, −1e31) is at 0.9999
    // (clamped 0.99); the kernel puts it at 0.5. Observed behavior; the public doc comment does not mention it.
    expect(crossingX(1e35, -1e31)).toEqual([0.5]);
  });

  it('marchingCubesSdf: the level is in inches, positive = inward, and it is exactly marchingCubes on the stored data', () => {
    const rng = mulberry32(99);
    for (let trial = 0; trial < 40; trial++) {
      const dims: Dims = [2 + Math.floor(rng() * 6), 2 + Math.floor(rng() * 6), 2 + Math.floor(rng() * 6)];
      const data = Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, () => Math.round((rng() * 2 - 1) * 600));
      const voxel = 0.03 + rng();
      const volume: SdfVolume = { data, dims, origin: [rng() * 4, -rng() * 4, rng()], voxel };
      for (const iso of [0, 0.37 * voxel, -1.2 * voxel]) {
        for (const border of ['closed', 'open'] as const) {
          const viaSdf = marchingCubesSdf(volume, { iso, border });
          const direct = marchingCubes(data, dims, { iso: (iso / voxel) * 256, origin: volume.origin, voxel, border });
          expect(sameBytes(viaSdf, direct)).toBe(true);
        }
      }
      // inside ⇔ stored value ≥ iso/voxel·256: a positive level can only remove inside samples
      const count = (iso: number): number => data.reduce((n, v) => n + (v >= (iso / voxel) * 256 ? 1 : 0), 0);
      expect(count(0.5 * voxel)).toBeLessThanOrEqual(count(0));
      expect(count(-0.5 * voxel)).toBeGreaterThanOrEqual(count(0));
    }
  });
});

describe('where the vertices are', () => {
  const bounds = (m: IndexedMesh): { min: number[]; max: number[] } => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], m.positions[i]);
      max[i % 3] = Math.max(max[i % 3], m.positions[i]);
    }
    return { min, max };
  };

  it('closed: at most 0.01 voxel beyond the lattice box (0.5 voxel where a border sample is ≥ 1e28 or +Infinity); open: inside the box', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const h = hostile(seed, 8);
      const hugeBorder = Array.from(h.field).some((v) => v - h.iso > 1e27);
      const reach = hugeBorder ? 0.5 : 0.01;
      const closed = marchingCubes(h.field, h.dims, { iso: h.iso, origin: h.origin, voxel: h.voxel });
      const open = marchingCubes(h.field, h.dims, { iso: h.iso, origin: h.origin, voxel: h.voxel, border: 'open' });
      for (const [m, slack] of [
        [closed, reach],
        [open, 0],
      ] as [IndexedMesh, number][]) {
        if (m.positions.length === 0) continue;
        const { min, max } = bounds(m);
        for (let a = 0; a < 3; a++) {
          const lo = h.origin[a] - slack * h.voxel[a];
          const hi = h.origin[a] + h.voxel[a] * (h.dims[a] - 1 + slack);
          const eps = 1e-5 * (Math.abs(lo) + Math.abs(hi) + h.voxel[a]);
          if (!(min[a] >= lo - eps && max[a] <= hi + eps)) {
            throw new Error(`seed ${seed}: axis ${a} spans ${min[a]} … ${max[a]}, allowed ${lo} … ${hi}`);
          }
        }
      }
    }
  });

  it('every vertex lies on a lattice line, between 0.01 and 0.99 of a lattice edge (default origin and voxel)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const h = hostile(seed, 8);
      const m = marchingCubes(h.field, h.dims, { iso: h.iso });
      for (let v = 0; v < m.positions.length; v += 3) {
        let moving = 0;
        for (let a = 0; a < 3; a++) {
          const x = m.positions[v + a];
          const frac = x - Math.floor(x);
          if (frac === 0) continue;
          moving++;
          if (!(frac >= 0.01 - 1e-6 && frac <= 0.99 + 1e-6)) throw new Error(`seed ${seed}: coordinate ${x} is closer than 0.01 to a lattice point`);
        }
        if (moving !== 1) throw new Error(`seed ${seed}: a vertex is not on exactly one lattice line`);
      }
    }
  });
});

// ---- float32 limits ------------------------------------------------------------------------------------------

function zeroAreaTriangles(m: IndexedMesh): number {
  const p = m.positions;
  let count = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    if (!(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 0)) count++;
  }
  return count;
}

describe('float32 positions: the lattice must leave room for the 0.01-voxel clamp', () => {
  // A field with many clamped crossings: small integers with exact zeros.
  const rng = mulberry32(5);
  const dims: Dims = [6, 6, 6];
  const field = Float32Array.from({ length: 216 }, () => Math.round((rng() * 2 - 1) * 2));

  it('no zero-area triangle and no coincident vertices up to |coordinate| / voxel = 2^17; beyond that the lattice is refused', () => {
    // (The review found the clamp rounded away from 2^18 on: 140 zero-area triangles and 87 coincident
    // vertices at an origin of 262 144 with voxel 1 — silently. The float32 spacing passes 0.01 at 2^17.)
    for (const origin of [0, 1e3, 1e5, 131072 - 7]) {
      const m = marchingCubes(field, dims, { origin: [origin, origin, origin] });
      expect({ zeroArea: zeroAreaTriangles(m), duplicates: m.positions.length / 3 - distinctPositions(m) }).toEqual({ zeroArea: 0, duplicates: 0 });
    }
    for (const origin of [131072, 262144, 1e6, 1e7, -1e7]) {
      expect(() => marchingCubes(field, dims, { origin: [origin, 0, 0] })).toThrow(RangeError);
      expect(() => marchingCubes(field, dims, { origin: [0, 0, origin] })).toThrow(RangeError);
    }
    // The same with a small voxel: only the ratio matters.
    expect(() => marchingCubes(field, dims, { origin: [300, 300, 300], voxel: 0.001 })).toThrow(RangeError);
    const fine = marchingCubes(field, dims, { origin: [100, 100, 100], voxel: 0.001 });
    expect(zeroAreaTriangles(fine)).toBe(0);
    expect(fine.positions.length / 3 - distinctPositions(fine)).toBe(0);
  });

  it('an origin or voxel that is finite as a double but does not fit float32 is refused too', () => {
    // (The review found ±Infinity positions for 1e39 and 1e38, and every vertex at the origin for 1e-46.)
    expect(() => marchingCubes(field, dims, { origin: [1e39, 0, 0] })).toThrow(RangeError);
    expect(() => marchingCubes(field, dims, { voxel: 1e38 })).toThrow(RangeError);
    expect(() => marchingCubes(field, dims, { voxel: 1e-46 })).toThrow(RangeError);
    expect(() => marchingCubes(field, dims, { voxel: [1, 1e-46, 1] })).toThrow(RangeError);
  });
});

// ---- memory --------------------------------------------------------------------------------------------------

describe('"two z-slices are held at a time"', () => {
  it('while meshing a 4 × 4 × 100 000 lattice the kernel holds no buffer that grows with the depth', () => {
    // The field is a Proxy, so it costs no memory itself and can look at the process half way through the run.
    // A mesher that kept one edge-vertex map for the whole lattice would hold 3 × 4 × 1.6 million bytes = 19 MB.
    const dims: Dims = [4, 4, 100_000];
    const length = 16 * 100_000;
    let reads = 0;
    let midRun = -1;
    const field = new Proxy({} as ArrayLike<number>, {
      get(_target, property): number {
        if (property === 'length') return length;
        if (++reads === length / 2) midRun = process.memoryUsage().arrayBuffers;
        return -1;
      },
    });
    const before = process.memoryUsage().arrayBuffers;
    const m = marchingCubes(field, dims);
    expect(m.indices.length).toBe(0);
    expect(reads).toBe(length);
    expect(midRun).toBeGreaterThan(-1);
    // (Garbage of earlier tests may be collected during the run, so the difference can be negative; a
    // depth-proportional map would add 19 MB.)
    note(`array buffers of the process: ${(before / 2 ** 20).toFixed(1)} MB before, ${(midRun / 2 ** 20).toFixed(1)} MB half way through a 4×4×100000 run`);
    expect(midRun - before).toBeLessThan(1 << 20);
  });
});
