// T3.2 — volume clean-up, meshing, Taubin, decimation and validation (DESIGN.md §2.9.5, §6.3 T3).
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { marchingCubes } from '../../kernel/geom/marchingCubes';
import { countComponents, countZeroAreaTriangles, edgeStats, eulerCharacteristic, isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { alignViews, alignedBounds, makeGrid, planeTables, type ReconGrid } from '../align';
import { frontRounding, inflationTable, separableHull } from '../hull';
import { cleanVolume, meshField, thinSamples, validateMesh, MERGE_TOUCHING_FRACTION } from '../mesh';
import { compactMesh, decimate, meanEdgeLength } from '../simplify';
import { centered, renderSilhouette, sphere, TEDDY, type Ellipsoid } from './helpers/views';
import type { Vec3, ViewLabel } from '../../../types/geometry';

const HEAVY = { timeout: 120_000 };

/** An analytic field on an N³ lattice over [−h, h]³: positive inside. */
function field(N: number, f: (p: Vec3) => number, h = 1.1): { field: Float32Array; grid: ReconGrid } {
  const voxel = (2 * h) / (N - 1);
  const out = new Float32Array(N ** 3);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[x + N * (y + N * z)] = f([-h + voxel * x, -h + voxel * y, -h + voxel * z]);
  return { field: out, grid: { N, origin: [-h, -h, -h], voxel } };
}

const ball = (c: Vec3, r: number) => (p: Vec3) => r - Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);

/** The rounded multi-view volume of `solids` at N (the build's volume before clean-up). */
function roundedHull(solids: readonly Ellipsoid[], labels: readonly ViewLabel[], N: number): { field: Float32Array; grid: ReconGrid } {
  const a = alignViews(labels.map((label) => ({ id: label, label, mask: renderSilhouette(solids, label, { w: 512, h: 512, pxPerUnit: 380 }), w: 512, h: 512 })));
  const grid = makeGrid(alignedBounds(a), N);
  const { planes } = planeTables(a, grid);
  const f = separableHull(planes, N);
  frontRounding(f, grid, inflationTable(a.views, grid, 'XY') as Float32Array);
  return { field: f, grid };
}

describe('cleanVolume (§2.9.5 step 1)', HEAVY, () => {
  it('keeps the largest 6-connected component and fills enclosed cavities', () => {
    const { field: f, grid } = field(48, (p) => Math.max(ball([-0.4, 0, 0], 0.4)(p), ball([0.6, 0, 0], 0.2)(p)));
    // A cavity inside the big ball.
    for (let i = 0; i < f.length; i++) {
      const x = i % 48;
      const y = Math.floor(i / 48) % 48;
      const z = Math.floor(i / 48 / 48);
      const p: Vec3 = [-1.1 + grid.voxel * x, -1.1 + grid.voxel * y, -1.1 + grid.voxel * z];
      if (Math.hypot(p[0] + 0.4, p[1], p[2]) < 0.15) f[i] = -0.1;
    }
    const before = marchingCubes(f, [48, 48, 48], { origin: grid.origin, voxel: grid.voxel });
    expect(countComponents(before.indices)).toBe(3); // two balls + the cavity's inner wall
    const report = cleanVolume(f, 48, grid.voxel);
    expect(report.components).toBe(2);
    expect(report.removed).toBeGreaterThan(0);
    expect(report.filled).toBeGreaterThan(0);
    const after = marchingCubes(f, [48, 48, 48], { origin: grid.origin, voxel: grid.voxel });
    expect(countComponents(after.indices)).toBe(1);
    expect(eulerCharacteristic(after.indices)).toBe(2);
    // Nothing became an exact zero (MC would read it as inside).
    for (const v of f) expect(v).not.toBe(0);
  });

  it('"Merge touching parts" joins two balls under two voxels apart; without it the smaller one is dropped', () => {
    // N = 128 (voxel 0.0173): the gap −0.02 … 0.01 holds two outside samples; the closing radius is 2 voxels.
    const N = 128;
    const make = () => field(N, (p) => Math.max(ball([-0.35, 0, 0], 0.33)(p), ball([0.31, 0, 0], 0.3)(p)));
    const a = make();
    const plain = cleanVolume(a.field, N, a.grid.voxel);
    expect(plain.removed).toBeGreaterThan(0);
    const b = make();
    const merged = cleanVolume(b.field, N, b.grid.voxel, { mergeTouching: true });
    expect(merged.closed).toBeGreaterThan(0);
    expect(merged.removed).toBe(0);
    const mesh = marchingCubes(b.field, [N, N, N], { origin: b.grid.origin, voxel: b.grid.voxel });
    expect(countComponents(mesh.indices)).toBe(1);
    expect(MERGE_TOUCHING_FRACTION * 127).toBeCloseTo(2, 9);
  });

  it('reports an empty volume and rejects a wrong size', () => {
    const f = new Float32Array(8 ** 3).fill(-1);
    expect(cleanVolume(f, 8, 0.1).inside).toBe(0);
    expect(() => cleanVolume(new Float32Array(7), 8, 0.1)).toThrow(RangeError);
    expect(() => cleanVolume(f, 8, 0)).toThrow(RangeError);
  });
});

describe('thin features (§2.9.5 step 5, "crochet flat")', () => {
  it('flags slabs two samples thick and not three', () => {
    const N = 20;
    const slab = (t: number): Float32Array => {
      const f = new Float32Array(N ** 3).fill(-1);
      for (let z = 8; z < 8 + t; z++) for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) f[x + N * (y + N * z)] = 1;
      return f;
    };
    const two = thinSamples(slab(2), N);
    expect(two.count).toBe(2 * 12 * 12);
    const three = thinSamples(slab(3), N);
    // Only the rim of a three-sample slab (its edges are cut square) — never its faces.
    expect(three.count).toBeLessThan(0.3 * 3 * 12 * 12);
    expect(three.mask[10 + N * (10 + N * 8)]).toBe(0);
  });
});

describe('meshing and validation (§2.9.5 steps 2–5)', HEAVY, () => {
  for (const N of [64, 128]) {
    it(`the rounded teddy and sphere hulls at N = ${N}: watertight, χ = 2, no zero-area triangle, 1 part, genus 0`, async () => {
      for (const [solids, labels] of [
        [centered(TEDDY), ['front', 'left', 'top', 'back']],
        [[sphere(0.5)], ['front', 'left', 'top']],
      ] as [Ellipsoid[], ViewLabel[]][]) {
        const { field: f, grid } = roundedHull(solids, labels, N);
        cleanVolume(f, N, grid.voxel);
        const mesh = meshField(f, grid);
        const e = edgeStats(mesh.indices);
        expect(e.boundaryEdges).toBe(0);
        expect(e.nonManifoldEdges).toBe(0);
        expect(e.misorientedEdges).toBe(0);
        expect(eulerCharacteristic(mesh.indices)).toBe(2);
        expect(countZeroAreaTriangles(mesh)).toBe(0);
        const report = await manifoldReport(mesh);
        expect(report).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
        expect(report.volume).toBeGreaterThan(0);
        const checked = await validateMesh(mesh);
        expect(checked).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
        expect(checked.mesh).toBe(mesh);
      }
    });
  }

  it('Taubin keeps the volume within 2% (teddy, sphere; N = 64 and 128)', () => {
    for (const N of [64, 128]) {
      for (const [solids, labels] of [
        [centered(TEDDY), ['front', 'left', 'top']],
        [[sphere(0.5)], ['front', 'left', 'top']],
      ] as [Ellipsoid[], ViewLabel[]][]) {
        const { field: f, grid } = roundedHull(solids, labels, N);
        cleanVolume(f, N, grid.voxel);
        const raw = meshField(f, grid, { taubinPairs: 0 });
        const smooth = meshField(f, grid);
        expect(Math.abs(signedVolume(smooth) / signedVolume(raw) - 1)).toBeLessThan(0.02);
        expect(smooth.indices).toEqual(raw.indices);
      }
    }
  });

  it('validateMesh keeps the largest of several parts', async () => {
    const { field: f, grid } = field(48, (p) => Math.max(ball([-0.4, 0, 0], 0.4)(p), ball([0.6, 0, 0], 0.2)(p)));
    const mesh = meshField(f, grid);
    const checked = await validateMesh(mesh);
    expect(checked.status).toBe('NoError');
    expect(checked.parts).toBe(2);
    expect(countComponents(checked.mesh.indices)).toBe(1);
    expect(checked.volume).toBeCloseTo((4 / 3) * Math.PI * 0.4 ** 3, 1);
    expect((await validateMesh({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) })).status).not.toBe('NoError');
  });
});

describe('decimation (§2.9.5 step 4)', HEAVY, () => {
  it('reduces at most 3× toward the target edge and stays watertight, genus 0', async () => {
    const { field: f, grid } = field(96, ball([0, 0, 0], 0.8));
    const mesh = meshField(f, grid);
    const edge = meanEdgeLength(mesh);
    const half = await decimate(mesh, edge * 1.3, { maxError: 0.5 * grid.voxel });
    expect(half.skipped).toBeUndefined();
    expect(half.after).toBeLessThan(half.before * 0.75);
    expect(half.after).toBeGreaterThanOrEqual(Math.floor(half.before / 3) - 2);
    expect(isWatertight(half.mesh.indices)).toBe(true);
    expect(await manifoldReport(half.mesh)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    expect(Math.abs(signedVolume(half.mesh) / signedVolume(mesh) - 1)).toBeLessThan(0.01);
    const far = await decimate(mesh, edge * 10, { maxError: 0.5 * grid.voxel });
    expect(far.after).toBeGreaterThanOrEqual(Math.floor(far.before / 3) - 2);
    expect(await decimate(mesh, edge * 0.9)).toMatchObject({ skipped: 'dense-enough', after: mesh.indices.length / 3 });
    await expect(decimate(mesh, 0)).rejects.toThrow(RangeError);
  });

  it('compactMesh drops unused vertices in first-use order', () => {
    const m = compactMesh(new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 0, 1, 0]), new Uint32Array([3, 0, 2]));
    expect([...m.indices]).toEqual([0, 1, 2]);
    expect([...m.positions]).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 0]);
  });
});
