// T3.2 — the separable visual hull, front-view rounding and the one-plane inflation (DESIGN.md §2.9.3, §6.3 T3).
import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../../kernel/geom/marchingCubes';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import { alignViews, alignedBounds, makeGrid, planeTables, type Alignment } from '../align';
import { frontRounding, inflatedVolume, inflationTable, projectionIoU, separableHull } from '../hull';
import { centered, renderSilhouette, sphere, TEDDY, type Ellipsoid } from './helpers/views';
import type { ViewLabel } from '../../../types/geometry';

const HEAVY = { timeout: 120_000 };

function align(solids: readonly Ellipsoid[], labels: readonly ViewLabel[], pxPerUnit: number): Alignment {
  return alignViews(labels.map((label) => ({ id: label, label, mask: renderSilhouette(solids, label, { w: 512, h: 512, pxPerUnit }), w: 512, h: 512 })));
}

const volumeOf = (field: Float32Array, grid: { N: number; origin: [number, number, number]; voxel: number }): number =>
  signedVolume(marchingCubes(field, [grid.N, grid.N, grid.N], { origin: grid.origin, voxel: grid.voxel }));

describe('separable hull (D12)', HEAVY, () => {
  it('three-view hull of a sphere r = 0.8 at N = 128: volume ratio 1.119 ± 0.01 (§6.3 T3)', () => {
    // The Step 0 set-up: the sphere spans 0.8/1.1 of each 512² view.
    const cam = 512 / 2.2;
    const a = align([sphere(0.8)], ['front', 'left', 'top'], cam);
    expect(a.issues).toEqual([]);
    const grid = makeGrid(alignedBounds(a), 128);
    const { planes } = planeTables(a, grid);
    const f = separableHull(planes, 128);
    // World units are object heights: the radius as the alignment sees it.
    const r = (0.8 * cam) / a.views[0].pxPerUnit;
    const ratio = volumeOf(f, grid) / ((4 / 3) * Math.PI * r ** 3);
    expect(Math.abs(ratio - 1.119)).toBeLessThanOrEqual(0.01);
    // Theory: the intersection of three cylinders of radius r has 8(2 − √2)·r³, i.e. 1.1188 × the sphere.
    expect(ratio).toBeGreaterThan(1.1);
  });

  it('is the broadcast minimum of the plane tables (brute force on a small lattice)', () => {
    const N = 9;
    const t = (seed: number): Float32Array => Float32Array.from({ length: N * N }, (_, k) => Math.sin(seed * 1.7 + k * 0.37) * 2);
    const XY = t(1);
    const ZY = t(2);
    const XZ = t(3);
    const f = separableHull({ XY, ZY, XZ }, N);
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          expect(f[x + N * (y + N * z)]).toBe(Math.min(XY[x + N * y], ZY[z + N * y], XZ[x + N * z]));
        }
      }
    }
    // A missing plane constrains nothing; no plane at all is +∞ everywhere.
    const two = separableHull({ XY, ZY }, N);
    expect(two[3 + N * (4 + N * 5)]).toBe(Math.min(XY[3 + N * 4], ZY[5 + N * 4]));
    expect(separableHull({}, 3).every((v) => v === Infinity)).toBe(true);
    expect(() => separableHull({ XY: new Float32Array(5) }, N)).toThrow(RangeError);
    expect(() => separableHull({}, 1)).toThrow(RangeError);
  });

  it('every reprojected silhouette of the hull matches its own view', () => {
    const a = align(centered(TEDDY), ['front', 'left', 'top'], 380);
    const grid = makeGrid(alignedBounds(a), 96);
    const tables = planeTables(a, grid);
    const f = separableHull(tables.planes, 96);
    for (const v of a.views) expect(projectionIoU(f, 96, v.convention.plane, tables.perView[v.id])).toBeGreaterThan(0.98);
  });
});

describe('front-view rounding (D13)', HEAVY, () => {
  it('rounds the three-view hull of a sphere back to the sphere (volume within 3%)', () => {
    const cam = 512 / 2.2;
    const a = align([sphere(0.8)], ['front', 'left', 'top'], cam);
    const grid = makeGrid(alignedBounds(a), 128);
    const { planes } = planeTables(a, grid);
    const f = separableHull(planes, 128);
    const hullVolume = volumeOf(f, grid);
    const T = inflationTable(a.views, grid, 'XY') as Float32Array;
    expect(T).not.toBeNull();
    const { zc } = frontRounding(f, grid, T);
    const r = (0.8 * cam) / a.views[0].pxPerUnit;
    const ratio = volumeOf(f, grid) / ((4 / 3) * Math.PI * r ** 3);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.03);
    expect(volumeOf(f, grid)).toBeLessThan(hullVolume);
    // The sphere is centered: every occupied ray has z_c ≈ 0.
    const center = 64 + 128 * 64;
    expect(Math.abs(zc[center])).toBeLessThan(0.5 * grid.voxel);
  });

  it('centers the depth bound on the hull’s own z-interval (an object off the z = 0 plane)', () => {
    // A teddy-like pair of spheres offset along z: the hull's z-interval per ray comes from the side view, and
    // z_c must be its midpoint (sub-voxel), whatever the front view says.
    const s = [sphere(0.4, [0, 0, 0.3]), sphere(0.25, [0, 0.3, -0.2])];
    const a = align(s, ['front', 'left'], 380);
    const grid = makeGrid(alignedBounds(a), 64);
    const { planes } = planeTables(a, grid);
    const f = separableHull(planes, 64);
    const T = inflationTable(a.views, grid, 'XY') as Float32Array;
    const { zc } = frontRounding(f, grid, T);
    const i = 32 + 64 * 32;
    let lo = Infinity;
    let hi = -Infinity;
    for (let z = 0; z < 64; z++) {
      const wz = grid.origin[2] + grid.voxel * z;
      if (planes.ZY![z + 64 * 32] > 0) {
        lo = Math.min(lo, wz);
        hi = Math.max(hi, wz);
      }
    }
    expect(Math.abs(zc[i] - (lo + hi) / 2)).toBeLessThan(grid.voxel);
  });

  it('keeps the depth of an object deeper than its front silhouette is wide (stretch), and is the plain formula otherwise', () => {
    // A fish seen head-on: 0.4 wide, 0.9 tall, 2 long. The plain formula would cut it to about its width.
    const fish: Ellipsoid[] = [{ c: [0, 0, 0], r: [0.2, 0.45, 1.0] }];
    const a = align(fish, ['front', 'left', 'top'], 200);
    const grid = makeGrid(alignedBounds(a), 96);
    const { planes } = planeTables(a, grid);
    const hull = separableHull(planes, 96);
    const T = inflationTable(a.views, grid, 'XY') as Float32Array;
    const stretched = Float32Array.from(hull);
    const { stretch } = frontRounding(stretched, grid, T);
    expect(stretch).toBeGreaterThan(4);
    expect(stretch).toBeLessThan(6);
    const plain = Float32Array.from(hull);
    expect(frontRounding(plain, grid, T, 1, { preserveDepth: false }).stretch).toBe(1);
    const depthOf = (f: Float32Array): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < f.length; k++) {
        if (f[k] < 0) continue;
        const z = Math.floor(k / (96 * 96));
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      return (hi - lo) * grid.voxel;
    };
    const r = 1 / a.views[0].pxPerUnit; // world units per mask px; the fish is 2 × 200 px long → 400 px
    expect(Math.abs(depthOf(stretched) / (400 * r) - 1)).toBeLessThan(0.05);
    expect(depthOf(plain) / (400 * r)).toBeLessThan(0.35);
    // The sphere and the teddy are not deeper than wide: stretch 1 (up to the sampling of T and the hull).
    for (const solids of [[sphere(0.5)], centered(TEDDY)]) {
      const b = align(solids, ['front', 'left', 'top'], 380);
      const g = makeGrid(alignedBounds(b), 64);
      const tb = planeTables(b, g);
      expect(frontRounding(separableHull(tb.planes, 64), g, inflationTable(b.views, g, 'XY') as Float32Array).stretch).toBeLessThan(1.02);
    }
  });

  it('only lowers the field, leaves empty rays alone, and validates its input', () => {
    const a = align(centered(TEDDY), ['front', 'left', 'top'], 380);
    const grid = makeGrid(alignedBounds(a), 64);
    const { planes } = planeTables(a, grid);
    const hull = separableHull(planes, 64);
    const f = Float32Array.from(hull);
    const T = inflationTable(a.views, grid, 'XY') as Float32Array;
    const { zc } = frontRounding(f, grid, T);
    let emptyRays = 0;
    for (let k = 0; k < f.length; k++) expect(f[k]).toBeLessThanOrEqual(hull[k]);
    for (let i = 0; i < 64 * 64; i++) {
      if (!Number.isNaN(zc[i])) continue;
      emptyRays++;
      for (let z = 0; z < 64; z++) expect(f[i + 64 * 64 * z]).toBe(hull[i + 64 * 64 * z]);
    }
    expect(emptyRays).toBeGreaterThan(0);
    expect(() => frontRounding(f, grid, T, 0)).toThrow(RangeError);
    expect(() => frontRounding(f.subarray(1), grid, T)).toThrow(RangeError);
    expect(() => frontRounding(f, grid, T.subarray(1))).toThrow(RangeError);
  });

  it('takes T from the front ∪ back views only (no XY view: null)', () => {
    const a = align(centered(TEDDY), ['left', 'top'], 380);
    const grid = makeGrid({ min: [-0.6, -0.6, -0.6], max: [0.6, 0.6, 0.6] }, 32);
    expect(inflationTable(a.views, grid, 'XY')).toBeNull();
    expect(inflationTable(a.views, grid, 'ZY')).not.toBeNull();
  });
});

describe('one-plane inflation (§2.9.3 single image)', HEAVY, () => {
  it('a single disc photo with κ = 1 inflates to a sphere (volume within 3%)', () => {
    const cam = 380;
    const a = align([sphere(0.5)], ['front'], cam);
    expect(a.issues.map((i) => i.code)).toEqual(['E_VIEWS']);
    const bounds = alignedBounds(a);
    bounds.min[2] = -0.55;
    bounds.max[2] = 0.55;
    const grid = makeGrid(bounds, 128);
    const { planes } = planeTables(a, grid);
    const T = inflationTable(a.views, grid, 'XY') as Float32Array;
    const f = inflatedVolume(planes.XY!, T, grid, 'XY', 1);
    const r = (0.5 * cam) / a.views[0].pxPerUnit;
    const ratio = volumeOf(f, grid) / ((4 / 3) * Math.PI * r ** 3);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.03);
    // κ scales the depth only: κ = 0.5 halves the volume (within the rim's discretization).
    const half = inflatedVolume(planes.XY!, T, grid, 'XY', 0.5);
    expect(volumeOf(half, grid) / volumeOf(f, grid)).toBeCloseTo(0.5, 1);
  });

  it('inflates along X for the ZY plane (left + right photos) and is symmetric about the photo plane', () => {
    const a = align(centered(TEDDY), ['left', 'right'], 380);
    const bounds = alignedBounds(a);
    bounds.min[0] = -0.4;
    bounds.max[0] = 0.4;
    const grid = makeGrid(bounds, 64);
    const { planes } = planeTables(a, grid);
    const T = inflationTable(a.views, grid, 'ZY') as Float32Array;
    const f = inflatedVolume(planes.ZY!, T, grid, 'ZY', 0.9);
    // Symmetric in x about x = 0: the grid is centered on 0 along x, so sample x ↔ N − 1 − x.
    expect(Math.abs(grid.origin[0] + grid.voxel * 63 + grid.origin[0])).toBeLessThan(1e-9);
    for (let k = 0; k < 2000; k++) {
      const x = k % 64;
      const y = (k * 7) % 64;
      const z = (k * 13) % 64;
      expect(f[x + 64 * (y + 64 * z)]).toBeCloseTo(f[63 - x + 64 * (y + 64 * z)], 5);
    }
  });
});
