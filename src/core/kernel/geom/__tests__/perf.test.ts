import { describe, expect, it } from 'vitest';
import { edt3d, signedEdt2d, signedEdt3d } from '../edt';
import { marchingCubes } from '../marchingCubes';
import { taubinSmooth } from '../taubin';
import { sampleField, sphere } from './fields';

// Timing tests (§6.1 rule 5: generous bounds, retried twice). The design budget on an Apple M3 Pro is
// marching cubes 91 ms and Taubin ×10 33 ms at N = 128 (§2.9.8); measured on that machine: 20 ms, 14 ms,
// and 50 ms for the 3D distance transform (docs/tracks/s0b-geom.md). The bounds leave room for a loaded or
// slower machine; the best of a few runs is taken so that one garbage collection does not fail the test.

function best(runs: number, fn: () => void): number {
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('geometry kernel timing at N = 128', () => {
  const s = sampleField(128, sphere(0.8));
  const mesh = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
  const mask = Uint8Array.from(s.field, (v) => (v >= 0 ? 1 : 0));

  it('marching cubes on the sphere: under 300 ms (budget 91 ms)', { retry: 2 }, () => {
    expect(best(3, () => marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel }))).toBeLessThan(300);
  });

  it('Taubin, 10 pairs, on that mesh (40 248 vertices): under 150 ms (budget 33 ms for 21 k vertices)', { retry: 2 }, () => {
    const positions = Float32Array.from(mesh.positions);
    expect(best(3, () => taubinSmooth(positions, mesh.indices))).toBeLessThan(150);
  });

  it('3D distance transform of the sphere mask: under 500 ms; signed: under 1 s', { retry: 2 }, () => {
    expect(best(2, () => edt3d(mask, s.dims))).toBeLessThan(500);
    expect(best(2, () => signedEdt3d(mask, s.dims))).toBeLessThan(1000);
  });

  it('signed 2D transform of a 512² mask: under 150 ms (research measured 21 ms)', { retry: 2 }, () => {
    const disc = new Uint8Array(512 * 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) disc[x + 512 * y] = Math.hypot(x - 256, y - 250) < 180 ? 1 : 0;
    expect(best(3, () => signedEdt2d(disc, 512, 512))).toBeLessThan(150);
  });
});
