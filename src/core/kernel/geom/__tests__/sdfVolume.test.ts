import { describe, expect, it } from 'vitest';
import type { SdfVolume, Vec3 } from '../../../../types/geometry';
import { mulberry32 } from '../../prng';
import { decodeSdfVolume, encodeSdfVolume, SDF_UNITS_PER_VOXEL, sampleSdfVolume } from '../sdfVolume';

/** A volume whose samples are the linear function a·x + b·y + c·z + d of the world position (inches). */
function linearVolume(dims: [number, number, number], origin: Vec3, voxel: number, g: Vec3, d: number): { volume: SdfVolume; f: (p: Vec3) => number } {
  const f = (p: Vec3): number => g[0] * p[0] + g[1] * p[1] + g[2] * p[2] + d;
  const field = new Float64Array(dims[0] * dims[1] * dims[2]);
  let i = 0;
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) field[i++] = f([origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z]);
    }
  }
  return { volume: encodeSdfVolume(field, dims, origin, voxel), f };
}

describe('encodeSdfVolume / decodeSdfVolume', () => {
  it('stores voxel/256 units in an Int16Array and copies dims and origin', () => {
    expect(SDF_UNITS_PER_VOXEL).toBe(256);
    const dims: [number, number, number] = [2, 2, 1];
    const origin: Vec3 = [1, 2, 3];
    // voxel = 0.5 in: one voxel of distance is 256 units, so 0.5 in → 256, 0.125 in → 64, −0.25 in → −128.
    const volume = encodeSdfVolume([0.5, 0.125, -0.25, 0], dims, origin, 0.5);
    expect(volume.data).toBeInstanceOf(Int16Array);
    expect(Array.from(volume.data)).toEqual([256, 64, -128, 0]);
    expect(volume.dims).toEqual([2, 2, 1]);
    expect(volume.origin).toEqual([1, 2, 3]);
    expect(volume.voxel).toBe(0.5);
    expect(volume.dims).not.toBe(dims);
    expect(volume.origin).not.toBe(origin);
    expect(Array.from(decodeSdfVolume(volume))).toEqual([0.5, 0.125, -0.25, 0]);
  });

  it('round-trips within 1/512 voxel, and keeps the side of every sample', () => {
    const rng = mulberry32(5);
    const voxel = 0.0625;
    const field = Float32Array.from({ length: 4 * 5 * 6 }, (_, i) => {
      const r = rng() * 2 - 1;
      // real distances, values within a hair of 0, and exact zeros
      return i % 5 === 0 ? r * 1e-6 : i % 7 === 0 ? 0 : r * 3;
    });
    const volume = encodeSdfVolume(field, [4, 5, 6], [0, 0, 0], voxel);
    const back = decodeSdfVolume(volume);
    let worst = 0;
    let flipped = 0;
    for (let i = 0; i < field.length; i++) {
      worst = Math.max(worst, Math.abs(back[i] - field[i]));
      // The marching-cubes rule: a sample is inside when it is ≥ the level (0).
      if (field[i] >= 0 !== volume.data[i] >= 0) flipped++;
    }
    // Rounding is at most half a unit; a tiny negative value moves a whole unit, to −1.
    expect(worst).toBeLessThanOrEqual(voxel / SDF_UNITS_PER_VOXEL);
    expect(flipped).toBe(0);
    expect(Array.from(encodeSdfVolume([-1e-9, 1e-9, -0, 0], [4, 1, 1], [0, 0, 0], 1).data)).toEqual([-1, 0, 0, 0]);
  });

  it('saturates at ±127.996 voxels and rejects NaN', () => {
    const v = encodeSdfVolume([1000, -1000, Infinity, -Infinity, 127.99, -128], [6, 1, 1], [0, 0, 0], 1);
    expect(Array.from(v.data)).toEqual([32767, -32768, 32767, -32768, 32765, -32768]);
    expect(() => encodeSdfVolume([0, NaN], [2, 1, 1], [0, 0, 0], 1)).toThrow(RangeError);
  });

  it('rejects malformed grids', () => {
    expect(() => encodeSdfVolume([0, 0, 0], [2, 1, 1], [0, 0, 0], 1)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0, 0], [2, 0, 1] as never, [0, 0, 0], 1)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0, 0], [2, 1, 1], [0, 0, 0], 0)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0, 0], [2, 1, 1], [0, 0, 0], -1)).toThrow(RangeError);
    expect(() => decodeSdfVolume({ data: new Int16Array(3), dims: [2, 1, 1], origin: [0, 0, 0], voxel: 1 })).toThrow(RangeError);
  });
});

describe('sampleSdfVolume', () => {
  it('returns the stored samples at the lattice points: sample (x, y, z) is at origin + voxel·(x, y, z)', () => {
    const rng = mulberry32(6);
    const dims: [number, number, number] = [4, 3, 5];
    const origin: Vec3 = [-1.5, 0.25, 7];
    const voxel = 0.125;
    const field = Float32Array.from({ length: 60 }, () => (rng() * 2 - 1) * 2);
    const volume = encodeSdfVolume(field, dims, origin, voxel);
    const decoded = decodeSdfVolume(volume);
    let i = 0;
    for (let z = 0; z < 5; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
          expect(sampleSdfVolume(volume, [origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z])).toBeCloseTo(decoded[i++], 12);
        }
      }
    }
  });

  it('interpolates trilinearly: a linear field is reproduced everywhere inside the lattice box', () => {
    const dims: [number, number, number] = [5, 4, 6];
    const origin: Vec3 = [2, -1, 0.5];
    const voxel = 0.25;
    const { volume, f } = linearVolume(dims, origin, voxel, [0.3, -0.5, 0.2], 0.1);
    const rng = mulberry32(8);
    let worst = 0;
    for (let trial = 0; trial < 500; trial++) {
      const p: Vec3 = [origin[0] + voxel * 4 * rng(), origin[1] + voxel * 3 * rng(), origin[2] + voxel * 5 * rng()];
      worst = Math.max(worst, Math.abs(sampleSdfVolume(volume, p) - f(p)));
    }
    // Only the Int16 rounding of the eight samples remains: half a unit.
    expect(worst).toBeLessThanOrEqual((0.5 * voxel) / SDF_UNITS_PER_VOXEL + 1e-12);
    // The middle of a cell is the mean of its eight corners.
    const cell = encodeSdfVolume([1, 2, 3, 4, 5, 6, 7, 16], [2, 2, 2], [0, 0, 0], 1);
    expect(sampleSdfVolume(cell, [0.5, 0.5, 0.5])).toBe(44 / 8);
    expect(sampleSdfVolume(cell, [1, 1, 1])).toBe(16);
    expect(sampleSdfVolume(cell, [0.5, 0, 0])).toBe(1.5);
    expect(sampleSdfVolume(cell, [1, 0.25, 1])).toBe(6 + 0.25 * 10);
  });

  it('outside the box: the value at the nearest point of the box minus the distance to it', () => {
    const dims: [number, number, number] = [3, 3, 3];
    const origin: Vec3 = [10, 10, 10];
    const voxel = 0.5;
    // Lattice box: [10, 11]³. A constant field of −0.25 in.
    const volume = encodeSdfVolume(new Float32Array(27).fill(-0.25), dims, origin, voxel);
    expect(sampleSdfVolume(volume, [10.5, 10.5, 10.5])).toBe(-0.25);
    expect(sampleSdfVolume(volume, [12, 10.5, 10.5])).toBe(-1.25); // 1 in beyond the +x face
    expect(sampleSdfVolume(volume, [9, 10.5, 10.5])).toBe(-1.25);
    expect(sampleSdfVolume(volume, [14, 14, 10.5])).toBeCloseTo(-0.25 - Math.hypot(3, 3), 12); // beyond an edge
    expect(sampleSdfVolume(volume, [8, 8, 9])).toBeCloseTo(-0.25 - 3, 12); // beyond a corner: √(4 + 4 + 1)
    // Continuous across the faces of the box.
    expect(sampleSdfVolume(volume, [11 + 1e-9, 10.2, 10.7])).toBeCloseTo(sampleSdfVolume(volume, [11, 10.2, 10.7]), 8);
    // An inside value near the border is not carried outward: it falls off with distance.
    const solid = encodeSdfVolume(new Float32Array(27).fill(0.5), dims, origin, voxel);
    expect(sampleSdfVolume(solid, [11.25, 10.5, 10.5])).toBe(0.25);
    expect(sampleSdfVolume(solid, [12, 10.5, 10.5])).toBe(-0.5);
  });

  it('handles lattices that are one sample thick, and NaN points', () => {
    const line = encodeSdfVolume([1, 2, 4], [3, 1, 1], [0, 0, 0], 1);
    expect(sampleSdfVolume(line, [0.5, 0, 0])).toBe(1.5);
    expect(sampleSdfVolume(line, [1.75, 0, 0])).toBe(3.5);
    expect(sampleSdfVolume(line, [2, 0, 0])).toBe(4);
    expect(sampleSdfVolume(line, [1, 3, 4])).toBe(2 - 5);
    const dot = encodeSdfVolume([0.75], [1, 1, 1], [5, 5, 5], 2);
    expect(sampleSdfVolume(dot, [5, 5, 5])).toBe(0.75);
    expect(sampleSdfVolume(dot, [5, 8, 9])).toBe(0.75 - 5);
    expect(sampleSdfVolume(line, [NaN, 0, 0])).toBeNaN();
  });

  it('rejects a malformed volume like decodeSdfVolume does, instead of answering with a plausible distance', () => {
    // (The second review found a voxel of −1 giving a finite 0.366, dims [0, 2, 2] giving −1, and dims that do
    // not match the data reading past the end: a broken stored sdf: asset would flip inside and outside.)
    const good = encodeSdfVolume(new Float32Array(8).fill(0.5), [2, 2, 2], [0, 0, 0], 1);
    expect(sampleSdfVolume(good, [0.5, 0.5, 0.5])).toBe(0.5);
    const broken: SdfVolume[] = [
      { ...good, voxel: -1 },
      { ...good, voxel: 0 },
      { ...good, voxel: NaN },
      { ...good, voxel: Infinity },
      { ...good, dims: [0, 2, 2] },
      { ...good, dims: [3, 3, 3] },
      { ...good, dims: [2, 2, 1.5] as never },
      { ...good, origin: [0, NaN, 0] },
      { ...good, data: new Int16Array(7) },
    ];
    for (const volume of broken) {
      expect(() => decodeSdfVolume(volume)).toThrow(RangeError);
      expect(() => sampleSdfVolume(volume, [0.5, 0.5, 0.5])).toThrow(RangeError);
    }
  });
});
