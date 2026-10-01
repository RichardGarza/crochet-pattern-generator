import { describe, expect, it } from 'vitest';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import { remeshVolume } from '../remesh';
import { MAX_GRID_SIDE, voxelGridFor, voxelizeMesh, voxelizeMeshOnGrid } from '../voxelize';
import { bestOf, bruteDistance, ellipsoidF, HEAVY, meshOf, sphereF, uvSphere, windingNumber, type Implicit } from './helpers';
import { budget, PERF } from '../../../test/timing';
import type { Vec3 } from '../../../types/geometry';

// A blob with a convex and a concave region: a sphere with an ellipsoid lobe.
const blob: Implicit = (x, y, z) => Math.max(sphereF(0.8)(x, y, z), ellipsoidF([0.3, 0.6, 0.3], [0.6, 0.3, 0])(x, y, z));

describe('voxelGridFor', () => {
  it('puts N samples on the longest side, `margin` samples beyond the box, the box centered', () => {
    const g = voxelGridFor([-1, 0, 2], [1, 4, 3], 96, 2);
    expect(g.dims[1]).toBe(96);
    expect(g.voxel).toBeCloseTo(4 / 91, 12);
    // the box lies inside the lattice with at least `margin` samples on every side
    for (let a = 0; a < 3; a++) {
      const lo = [-1, 0, 2][a];
      const hi = [1, 4, 3][a];
      expect(lo - g.origin[a]).toBeGreaterThanOrEqual(2 * g.voxel - 1e-9);
      expect(g.origin[a] + (g.dims[a] - 1) * g.voxel - hi).toBeGreaterThanOrEqual(2 * g.voxel - 1e-9);
      // centered
      expect(g.origin[a] + ((g.dims[a] - 1) * g.voxel) / 2).toBeCloseTo((lo + hi) / 2, 12);
    }
  });

  it('refuses unusable sizes', () => {
    expect(() => voxelGridFor([0, 0, 0], [1, 1, 1], 6, 2)).toThrow(RangeError);
    expect(() => voxelGridFor([0, 0, 0], [1, 1, 1], MAX_GRID_SIDE + 1)).toThrow(RangeError);
    expect(() => voxelGridFor([0, 0, 0], [0, 0, 0], 32)).toThrow(RangeError);
    expect(() => voxelGridFor([0, 0, 0], [1, NaN, 1], 32)).toThrow(RangeError);
    expect(() => voxelGridFor([0, 0, 0], [1, 1, 1], 32.5)).toThrow(RangeError);
  });
});

describe('voxelizeMesh — acceptance (§6.3 T5)', HEAVY, () => {
  it('matches a brute-force closest-point SDF within 1 voxel on a 2k-triangle mesh', () => {
    const mesh = meshOf(blob, 22, 1.1);
    const tris = mesh.indices.length / 3;
    expect(tris).toBeGreaterThan(1800);
    expect(tris).toBeLessThan(2600);
    const N = 36;
    const v = voxelizeMesh(mesh, N);
    expect(v.stats.oddColumns).toBe(0);
    expect(Math.max(...v.dims)).toBe(N);
    let maxErr = 0;
    let signErrors = 0;
    let i = 0;
    for (let z = 0; z < v.dims[2]; z++) {
      for (let y = 0; y < v.dims[1]; y++) {
        for (let x = 0; x < v.dims[0]; x++, i++) {
          const p: Vec3 = [v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel];
          const d = bruteDistance(mesh, p);
          // Sign: the analytic solid where it is unambiguous, the winding number of the mesh near its surface.
          const a = blob(p[0], p[1], p[2]);
          const inside = Math.abs(a) > 0.1 ? a > 0 : windingNumber(mesh, p) > 0.5;
          const ref = inside ? d : -d;
          maxErr = Math.max(maxErr, Math.abs(v.field[i] - ref) / v.voxel);
          // A sample within 0.01 voxel of the surface has no meaningful side (both values are ~0 there).
          if (d > 0.01 * v.voxel && v.field[i] > 0 !== inside) signErrors++;
        }
      }
    }
    expect(signErrors).toBe(0);
    expect(maxErr).toBeLessThanOrEqual(1);
    // In practice it is far tighter (measured 0.20 voxel): the band is exact and the far field is bounded.
    expect(maxErr).toBeLessThan(0.5);
  });

  it('runs N = 96 on a 40k-triangle mesh within 400 ms', { ...PERF, retry: 2 }, () => {
    const mesh = uvSphere(1, 200, 101);
    expect(mesh.indices.length / 3).toBe(40_000);
    const ms = bestOf(3, () => voxelizeMesh(mesh, 96));
    expect(ms).toBeLessThan(budget(400));
  });

  it('runs N = 96 on a 40k-triangle marching-cubes mesh within 400 ms', { ...PERF, retry: 2 }, () => {
    const mesh = meshOf(blob, 90, 1.1);
    expect(mesh.indices.length / 3).toBeGreaterThan(38_000);
    const ms = bestOf(3, () => voxelizeMesh(mesh, 96));
    expect(ms).toBeLessThan(budget(400));
  });
});

describe('voxelizeMesh — behavior', HEAVY, () => {
  it('a sphere: exact distance near the surface, right sign everywhere, and it meshes back to the same solid', () => {
    const mesh = uvSphere(1, 96, 48);
    const v = voxelizeMesh(mesh, 64);
    let worst = 0;
    let i = 0;
    for (let z = 0; z < v.dims[2]; z++) {
      for (let y = 0; y < v.dims[1]; y++) {
        for (let x = 0; x < v.dims[0]; x++, i++) {
          const r = Math.hypot(v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel);
          // the UV sphere is inscribed: its surface lies within ~0.002 of the unit sphere
          worst = Math.max(worst, Math.abs(v.field[i] - (1 - r)));
        }
      }
    }
    expect(worst / v.voxel).toBeLessThan(0.3);
    const back = remeshVolume(v);
    expect(signedVolume(back) / signedVolume(mesh)).toBeCloseTo(1, 2);
  });

  it('is deterministic (byte-identical fields)', () => {
    const mesh = meshOf(blob, 40, 1.1);
    const a = voxelizeMesh(mesh, 48);
    const b = voxelizeMesh(mesh, 48);
    expect(Buffer.compare(Buffer.from(a.field.buffer), Buffer.from(b.field.buffer))).toBe(0);
  });

  it('signs a marching-cubes mesh voxelized on the lattice it came from (vertices on lattice lines)', () => {
    const n = 33;
    const half = 1.1;
    const mesh = meshOf(blob, n, half);
    const voxel = (2 * half) / (n - 1);
    const v = voxelizeMeshOnGrid(mesh, { dims: [n, n, n], origin: [-half, -half, -half], voxel });
    expect(v.stats.oddColumns).toBe(0);
    let wrong = 0;
    let i = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++, i++) {
          const a = blob(-half + x * voxel, -half + y * voxel, -half + z * voxel);
          if (Math.abs(a) > 0.02 && a > 0 !== v.field[i] > 0) wrong++;
        }
      }
    }
    expect(wrong).toBe(0);
  });

  it('is independent of the mesh orientation (an inside-out mesh voxelizes the same)', () => {
    const mesh = meshOf(blob, 30, 1.1);
    const flipped = new Uint32Array(mesh.indices);
    for (let t = 0; t < flipped.length; t += 3) [flipped[t + 1], flipped[t + 2]] = [flipped[t + 2], flipped[t + 1]];
    const a = voxelizeMesh(mesh, 40);
    const b = voxelizeMesh({ positions: mesh.positions, indices: flipped }, 40);
    expect(Buffer.compare(Buffer.from(a.field.buffer), Buffer.from(b.field.buffer))).toBe(0);
  });

  it('reports an open mesh instead of failing (odd columns)', () => {
    const mesh = uvSphere(1, 24, 12);
    // drop the triangles facing +z: a hole that rays along +z go through
    const kept: number[] = [];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const cz = (mesh.positions[3 * mesh.indices[t] + 2] + mesh.positions[3 * mesh.indices[t + 1] + 2] + mesh.positions[3 * mesh.indices[t + 2] + 2]) / 3;
      if (cz < 0.8) kept.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
    }
    const open = new Uint32Array(kept);
    const v = voxelizeMesh({ positions: mesh.positions, indices: open }, 32);
    expect(v.stats.oddColumns).toBeGreaterThan(0);
    expect(v.field.every((f) => Number.isFinite(f))).toBe(true);
  });

  it('skips degenerate triangles and unused vertices', () => {
    const mesh = uvSphere(1, 24, 12);
    const positions = new Float32Array([...mesh.positions, 50, 50, 50]); // an unused far vertex
    const indices = new Uint32Array([...mesh.indices, 0, 0, 1]);
    const v = voxelizeMesh({ positions, indices }, 32);
    expect(v.stats.triangles).toBe(mesh.indices.length / 3);
    expect(Math.max(...v.dims)).toBe(32);
    expect(v.origin[0]).toBeGreaterThan(-1.2);
  });

  it('refuses malformed meshes', () => {
    const ok = uvSphere(1, 8, 4);
    expect(() => voxelizeMesh({ positions: ok.positions, indices: new Uint32Array(0) })).toThrow(RangeError);
    expect(() => voxelizeMesh({ positions: ok.positions, indices: new Uint32Array([0, 1, 9999]) })).toThrow(RangeError);
    expect(() => voxelizeMesh({ positions: new Float32Array([0, 0, NaN, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) })).toThrow(RangeError);
    expect(() => voxelizeMesh({ positions: new Float32Array(10), indices: new Uint32Array([0, 1, 2]) })).toThrow(RangeError);
    expect(() => voxelizeMesh(ok, 96, { band: 0.5 })).toThrow(RangeError);
  });
});
