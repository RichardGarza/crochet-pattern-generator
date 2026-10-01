import { describe, expect, it } from 'vitest';
import { isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { mulberry32 } from '../../kernel/prng';
import { coloredRemesh, NearestVertexIndex, remeshVolume, transferLabels } from '../remesh';
import { voxelizeMesh } from '../voxelize';
import { HEAVY, meshOf, sphereF, uvSphere } from './helpers';

function bruteNearest(pts: ArrayLike<number>, x: number, y: number, z: number, keep?: (i: number) => boolean): number {
  let best = Infinity;
  let k = -1;
  for (let i = 0; i < pts.length / 3; i++) {
    if (keep && !keep(i)) continue;
    const d = (pts[3 * i] - x) ** 2 + (pts[3 * i + 1] - y) ** 2 + (pts[3 * i + 2] - z) ** 2;
    if (d < best) {
      best = d;
      k = i;
    }
  }
  return k;
}

describe('NearestVertexIndex', () => {
  it('agrees with brute force on random clouds, including far queries', () => {
    const rnd = mulberry32(7);
    for (let trial = 0; trial < 5; trial++) {
      const n = 50 + trial * 400;
      const pts = new Float64Array(3 * n);
      for (let i = 0; i < pts.length; i++) pts[i] = rnd() * 2 - 1;
      const index = new NearestVertexIndex(pts);
      for (let q = 0; q < 300; q++) {
        const s = q % 3 === 0 ? 20 : 1.5;
        const x = (rnd() * 2 - 1) * s;
        const y = (rnd() * 2 - 1) * s;
        const z = (rnd() * 2 - 1) * s;
        expect(index.nearest(x, y, z)).toBe(bruteNearest(pts, x, y, z));
      }
    }
  });

  it('breaks ties toward the lowest index and honors the filter', () => {
    const pts = [1, 0, 0, -1, 0, 0, 0, 1, 0, 1, 0, 0];
    const index = new NearestVertexIndex(pts);
    expect(index.nearest(0, 0, 0)).toBe(0); // 0, 1, 2 at distance 1 (3 duplicates 0)
    expect(index.nearest(1, 0, 0)).toBe(0); // 0 and 3 coincide
    const odd = new NearestVertexIndex(pts, (i) => i % 2 === 1);
    expect(odd.nearest(1, 0, 0)).toBe(3);
    expect(odd.size).toBe(2);
  });

  it('handles empty sets, coincident points and non-finite input', () => {
    expect(new NearestVertexIndex([]).nearest(0, 0, 0)).toBe(-1);
    const same = new NearestVertexIndex(new Array(300).fill(0.5));
    expect(same.nearest(9, 9, 9)).toBe(0);
    const withNaN = new NearestVertexIndex([NaN, 0, 0, 2, 2, 2]);
    expect(withNaN.size).toBe(1);
    expect(withNaN.nearest(0, 0, 0)).toBe(1);
    expect(withNaN.nearest(NaN, 0, 0)).toBe(-1);
  });
});

describe('remesh helpers', HEAVY, () => {
  it('remeshVolume gives a closed mesh of the volume; coloredRemesh carries labels by nearest vertex', () => {
    const src = uvSphere(1, 64, 32);
    const labels = new Uint8Array(src.positions.length / 3);
    for (let v = 0; v < labels.length; v++) labels[v] = src.positions[3 * v + 1] > 0 ? 2 : 5; // top / bottom
    const vol = voxelizeMesh(src, 48);
    const m = remeshVolume(vol);
    expect(isWatertight(m.indices)).toBe(true);
    expect(signedVolume(m)).toBeGreaterThan(0);
    const c = coloredRemesh(vol, { ...src, labels });
    expect(c.labels.length).toBe(c.positions.length / 3);
    let wrong = 0;
    for (let v = 0; v < c.labels.length; v++) {
      const y = c.positions[3 * v + 1];
      if (Math.abs(y) > 0.1 && c.labels[v] !== (y > 0 ? 2 : 5)) wrong++;
    }
    expect(wrong).toBe(0);
    expect(coloredRemesh(vol, undefined).labels.every((l) => l === 255)).toBe(true);
  });

  it('transferLabels carries partId when the source has it', () => {
    const a = meshOf(sphereF(0.5, [-0.6, 0, 0]), 24, 1.2);
    const n = a.positions.length / 3;
    const partId = new Uint8Array(n).map((_, v) => (a.positions[3 * v] < -0.6 ? 1 : 0));
    const out = transferLabels(a.positions, { ...a, labels: new Uint8Array(n).fill(4), partId });
    expect(Array.from(out.partId ?? [])).toEqual(Array.from(partId));
    expect(out.labels.every((l) => l === 4)).toBe(true);
    expect(transferLabels(a.positions, { ...a, labels: new Uint8Array(n) }).partId).toBeUndefined();
  });
});
