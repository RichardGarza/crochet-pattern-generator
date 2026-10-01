// The acceptance list of Step 0b, checked with independent tools (from its independent review): sphere and
// union of ellipsoids at N = 64 and 128 watertight, χ = 2, no zero-area triangle, positive volume, volume within
// 1% of the true volume at N = 128; torus χ = 0; two spheres χ = 4; Taubin within 2%; manifold-3d: 1 part,
// genus 0.
//
// Nothing from meshMeasures.ts is used. The true volume of the nine-ellipsoid "teddy" is integrated here (the
// kernel's own test compares the mesh with a count of the very samples it was made from).
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../manifold';
import { type IndexedMesh, marchingCubes } from '../marchingCubes';
import { taubinSmooth } from '../taubin';
import { note, TEDDY_PARTS } from './fields';

const HALF = 1.1;

function sample(n: number, f: (x: number, y: number, z: number) => number): IndexedMesh {
  const field = new Float32Array(n * n * n);
  const voxel = (2 * HALF) / (n - 1);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = f(-HALF + voxel * x, -HALF + voxel * y, -HALF + voxel * z);
  return marchingCubes(field, [n, n, n], { origin: [-HALF, -HALF, -HALF], voxel });
}

const sphereAt =
  (r: number, cx = 0, cy = 0, cz = 0) =>
  (x: number, y: number, z: number): number =>
    r - Math.hypot(x - cx, y - cy, z - cz);
const torus =
  (R: number, r: number) =>
  (x: number, y: number, z: number): number =>
    r - Math.hypot(Math.hypot(x, z) - R, y);
const teddy = (x: number, y: number, z: number): number => {
  let best = -Infinity;
  for (const { c, r } of TEDDY_PARTS) {
    const scale = Math.min(r[0], r[1], r[2]);
    best = Math.max(best, scale * (1 - Math.hypot((x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2])));
  }
  return best;
};

/**
 * Volume of the union of the teddy's ellipsoids: along every z-line the union of the nine chords is exact, and
 * the (x, y) plane is integrated by the midpoint rule on a 2400² grid (error ≈ 1e-5 of the volume).
 */
function teddyVolume(): number {
  const n = 2400;
  const h = (2 * HALF) / n;
  let volume = 0;
  const lo = new Float64Array(TEDDY_PARTS.length);
  const hi = new Float64Array(TEDDY_PARTS.length);
  for (let j = 0; j < n; j++) {
    const y = -HALF + (j + 0.5) * h;
    for (let i = 0; i < n; i++) {
      const x = -HALF + (i + 0.5) * h;
      let chords = 0;
      for (const { c, r } of TEDDY_PARTS) {
        const rest = 1 - ((x - c[0]) / r[0]) ** 2 - ((y - c[1]) / r[1]) ** 2;
        if (rest <= 0) continue;
        const half = r[2] * Math.sqrt(rest);
        lo[chords] = c[2] - half;
        hi[chords] = c[2] + half;
        chords++;
      }
      if (chords === 0) continue;
      // length of the union of the chords (at most nine: an insertion sort by lower end)
      for (let a = 1; a < chords; a++) {
        const l = lo[a];
        const u = hi[a];
        let b = a - 1;
        while (b >= 0 && lo[b] > l) {
          lo[b + 1] = lo[b];
          hi[b + 1] = hi[b];
          b--;
        }
        lo[b + 1] = l;
        hi[b + 1] = u;
      }
      let length = 0;
      let end = -Infinity;
      for (let a = 0; a < chords; a++) {
        if (hi[a] <= end) continue;
        length += hi[a] - Math.max(lo[a], end);
        end = hi[a];
      }
      volume += length * h * h;
    }
  }
  return volume;
}

interface Facts {
  vertices: number;
  triangles: number;
  boundary: number;
  nonManifold: number;
  misoriented: number;
  chi: number;
  pieces: number;
  zeroArea: number;
  unused: number;
  volume: number;
}

function facts(m: IndexedMesh): Facts {
  const V = m.positions.length / 3;
  const p = m.positions;
  const directed = new Map<number, number>();
  const used = new Uint8Array(V);
  const parent = Int32Array.from({ length: V }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  let zeroArea = 0;
  let six = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const key = tri[e] * V + tri[(e + 1) % 3];
      directed.set(key, (directed.get(key) ?? 0) + 1);
      used[tri[e]] = 1;
      parent[find(tri[e])] = find(tri[(e + 1) % 3]);
    }
    const [a, b, c] = tri.map((v) => 3 * v);
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    if (!(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 0)) zeroArea++;
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  let edges = 0;
  let boundary = 0;
  let nonManifold = 0;
  let misoriented = 0;
  for (const [key, forward] of directed) {
    const q = key % V;
    const from = (key - q) / V;
    const backward = directed.get(q * V + from) ?? 0;
    if (backward > 0 && from > q) continue;
    edges++;
    if (forward + backward === 1) boundary++;
    else if (forward + backward > 2) nonManifold++;
    else if (backward !== 1) misoriented++;
  }
  let usedCount = 0;
  let pieces = 0;
  for (let v = 0; v < V; v++) {
    usedCount += used[v];
    if (used[v] && find(v) === v) pieces++;
  }
  return {
    vertices: V,
    triangles: m.indices.length / 3,
    boundary,
    nonManifold,
    misoriented,
    chi: usedCount - edges + m.indices.length / 3,
    pieces,
    zeroArea,
    unused: V - usedCount,
    volume: six / 6,
  };
}

const CLEAN = { boundary: 0, nonManifold: 0, misoriented: 0, zeroArea: 0, unused: 0 };
const sphereVolume = (r: number): number => (4 / 3) * Math.PI * r ** 3;

describe('the acceptance list, with independent checks', () => {
  it.each([64, 128])('sphere r = 0.8 at N = %i', async (n) => {
    const m = sample(n, sphereAt(0.8));
    const f = facts(m);
    expect(f).toMatchObject({ ...CLEAN, chi: 2, pieces: 1 });
    expect(f.volume).toBeGreaterThan(0);
    const ratio = f.volume / sphereVolume(0.8);
    note(`sphere N = ${n}: ${f.vertices} vertices, ${f.triangles} triangles, volume ${ratio.toFixed(5)} × analytic`);
    expect(Math.abs(ratio - 1)).toBeLessThan(n === 128 ? 0.01 : 0.02);
    expect(await manifoldReport(m)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    taubinSmooth(m.positions, m.indices);
    const smooth = facts(m);
    expect(smooth).toMatchObject({ ...CLEAN, chi: 2, pieces: 1 });
    expect(Math.abs(smooth.volume / f.volume - 1)).toBeLessThan(0.02);
    expect(await manifoldReport(m)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
  });

  it('union of nine ellipsoids at N = 64 and 128: within 1% of the integrated volume at N = 128', async () => {
    const truth = teddyVolume();
    for (const n of [64, 128]) {
      const m = sample(n, teddy);
      const f = facts(m);
      expect(f).toMatchObject({ ...CLEAN, chi: 2, pieces: 1 });
      expect(f.volume).toBeGreaterThan(0);
      const ratio = f.volume / truth;
      note(`teddy N = ${n}: ${f.vertices} vertices, ${f.triangles} triangles, volume ${ratio.toFixed(5)} × integrated (${truth.toFixed(6)})`);
      expect(Math.abs(ratio - 1)).toBeLessThan(n === 128 ? 0.01 : 0.02);
      expect(await manifoldReport(m)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
      taubinSmooth(m.positions, m.indices);
      expect(Math.abs(facts(m).volume / f.volume - 1)).toBeLessThan(0.02);
      expect(await manifoldReport(m)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    }
  });

  it('torus: χ = 0, genus 1; two spheres: χ = 4, 2 parts', async () => {
    for (const n of [64, 128]) {
      const m = sample(n, torus(0.6, 0.25));
      const f = facts(m);
      expect(f).toMatchObject({ ...CLEAN, chi: 0, pieces: 1 });
      expect(Math.abs(f.volume / (2 * Math.PI ** 2 * 0.6 * 0.25 ** 2) - 1)).toBeLessThan(0.01);
      expect(await manifoldReport(m)).toMatchObject({ status: 'NoError', parts: 1, genus: 1 });
    }
    const two = sample(64, (x, y, z) => Math.max(sphereAt(0.35, -0.5)(x, y, z), sphereAt(0.3, 0.5, 0.1)(x, y, z)));
    const f = facts(two);
    expect(f).toMatchObject({ ...CLEAN, chi: 4, pieces: 2 });
    expect(Math.abs(f.volume / (sphereVolume(0.35) + sphereVolume(0.3)) - 1)).toBeLessThan(0.01);
    expect(await manifoldReport(two)).toMatchObject({ status: 'NoError', parts: 2, genus: 0 });
  });
});
