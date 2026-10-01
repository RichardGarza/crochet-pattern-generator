import { describe, expect, it } from 'vitest';
import { sampleSdfVolume } from '../../kernel/geom/sdfVolume';
import { mulberry32 } from '../../kernel/prng';
import { checkVolume, cloneVolume, hasInside, insideSampleVolume, padVolume, sampleVolume, volumeFromSdf, volumeToSdf, type FieldVolume } from '../volume';

function sphereVolume(n: number): FieldVolume {
  const half = 1.3;
  const voxel = (2 * half) / (n - 1);
  const field = new Float32Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = 1 - Math.hypot(-half + x * voxel, -half + y * voxel, -half + z * voxel);
  return { field, dims: [n, n, n], origin: [-half, -half, -half], voxel };
}

describe('working volume helpers', () => {
  it('sampleVolume agrees with the Step 0 sampleSdfVolume (inside the box and beyond it)', () => {
    const v = sphereVolume(21);
    const stored = volumeToSdf(v);
    const back = volumeFromSdf(stored);
    const rnd = mulberry32(3);
    for (let k = 0; k < 500; k++) {
      const p: [number, number, number] = [(rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2];
      expect(sampleVolume(back, ...p)).toBeCloseTo(sampleSdfVolume(stored, p), 5);
      expect(sampleVolume(v, ...p)).toBeCloseTo(sampleSdfVolume(stored, p), 2);
    }
    expect(sampleVolume(v, 0, 0, 0)).toBeCloseTo(1, 1);
    expect(Number.isNaN(sampleVolume(v, NaN, 0, 0))).toBe(true);
  });

  it('padVolume keeps every old sample and the surface, and adds room', () => {
    const v = sphereVolume(15);
    const p = padVolume(v, 3);
    expect(p.dims).toEqual([21, 21, 21]);
    for (let z = 0; z < 15; z++) for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) expect(p.field[x + 3 + 21 * (y + 3 + 21 * (z + 3))]).toBe(v.field[x + 15 * (y + 15 * z)]);
    expect(p.origin[0]).toBeCloseTo(v.origin[0] - 3 * v.voxel, 12);
    expect(p.field[0]).toBeLessThan(v.field[0]);
    expect(insideSampleVolume(p)).toBe(insideSampleVolume(v));
    expect(padVolume(v, 0).field).not.toBe(v.field);
    expect(() => padVolume(v, -1)).toThrow(RangeError);
  });

  it('checks, clones and tests volumes', () => {
    const v = sphereVolume(9);
    expect(() => checkVolume(v)).not.toThrow();
    expect(() => checkVolume({ ...v, dims: [9, 9, 8] })).toThrow(RangeError);
    expect(() => checkVolume({ ...v, voxel: 0 })).toThrow(RangeError);
    expect(() => checkVolume({ ...v, origin: [0, NaN, 0] })).toThrow(RangeError);
    const c = cloneVolume(v);
    c.field[0] = 5;
    expect(v.field[0]).not.toBe(5);
    expect(hasInside(v)).toBe(true);
    expect(hasInside({ ...v, field: new Float32Array(v.field.length).fill(-1) })).toBe(false);
  });
});
