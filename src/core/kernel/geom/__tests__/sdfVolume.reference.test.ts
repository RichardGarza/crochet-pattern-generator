// sdfVolume.ts — encode / decode / sample of the stored part volume — against a naive trilinear implementation
// and the documented rules, one by one. From the independent review of Step 0b; it shares no code with the
// kernel or with sdfVolume.test.ts. Measurements are printed with GEOM_VERBOSE=1.
import { describe, expect, it } from 'vitest';
import type { SdfVolume, Vec3 } from '../../../../types/geometry';
import { mulberry32, type Rng } from '../../prng';
import { marchingCubesSdf } from '../marchingCubes';
import { signedVolume } from '../meshMeasures';
import { decodeSdfVolume, encodeSdfVolume, SDF_UNITS_PER_VOXEL, sampleSdfVolume } from '../sdfVolume';
import { note } from './fields';

type Dims = [number, number, number];

function randomVolume(rng: Rng, dims: Dims, origin: Vec3, voxel: number): SdfVolume {
  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor((rng() * 2 - 1) * 2000);
  return { data, dims, origin, voxel };
}

/** Textbook trilinear interpolation at lattice coordinates g inside the box, written with explicit weights. */
function naiveInside(volume: SdfVolume, g: Vec3): number {
  const [nx, ny, nz] = volume.dims;
  const at = (x: number, y: number, z: number): number =>
    volume.data[Math.min(x, nx - 1) + nx * (Math.min(y, ny - 1) + ny * Math.min(z, nz - 1))];
  const x0 = Math.min(Math.floor(g[0]), Math.max(nx - 2, 0));
  const y0 = Math.min(Math.floor(g[1]), Math.max(ny - 2, 0));
  const z0 = Math.min(Math.floor(g[2]), Math.max(nz - 2, 0));
  const tx = g[0] - x0;
  const ty = g[1] - y0;
  const tz = g[2] - z0;
  let sum = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty) * (k ? tz : 1 - tz);
        if (w !== 0) sum += w * at(x0 + i, y0 + j, z0 + k);
      }
    }
  }
  return (sum / 256) * volume.voxel;
}

/** The documented rule for any point: value at the nearest point of the lattice box minus the distance to it. */
function naive(volume: SdfVolume, p: Vec3): number {
  const g: Vec3 = [0, 0, 0];
  let gap2 = 0;
  for (let a = 0; a < 3; a++) {
    const raw = (p[a] - volume.origin[a]) / volume.voxel;
    const clamped = Math.min(Math.max(raw, 0), volume.dims[a] - 1);
    gap2 += (raw - clamped) ** 2;
    g[a] = clamped;
  }
  return naiveInside(volume, g) - Math.sqrt(gap2) * volume.voxel;
}

const DIMS: Dims[] = [
  [1, 1, 1],
  [2, 1, 1],
  [1, 3, 1],
  [1, 1, 4],
  [2, 2, 2],
  [5, 1, 3],
  [1, 4, 6],
  [4, 3, 5],
  [7, 6, 2],
];

describe('sampleSdfVolume', () => {
  it('agrees with a naive trilinear implementation: random points, lattice points, faces, edges, corners, dims of 1', () => {
    const rng = mulberry32(0xb301);
    let worst = 0;
    let checked = 0;
    for (const dims of DIMS) {
      for (const voxel of [1, 0.125, 0.0173, 3.3]) {
        const origin: Vec3 = [(rng() - 0.5) * 20, (rng() - 0.5) * 20, (rng() - 0.5) * 20];
        const volume = randomVolume(rng, dims, origin, voxel);
        const pick = (n: number): number => {
          const r = rng();
          // lattice coordinate: exact lattice points (incl. both ends), cell middles, anything in the box, or outside
          if (r < 0.25) return Math.floor(rng() * n);
          if (r < 0.35) return n - 1;
          if (r < 0.45) return 0;
          if (r < 0.75) return rng() * (n - 1);
          return -3 + rng() * (n + 5);
        };
        for (let trial = 0; trial < 400; trial++) {
          const g: Vec3 = [pick(dims[0]), pick(dims[1]), pick(dims[2])];
          const p: Vec3 = [origin[0] + voxel * g[0], origin[1] + voxel * g[1], origin[2] + voxel * g[2]];
          const got = sampleSdfVolume(volume, p);
          const want = naive(volume, p);
          worst = Math.max(worst, Math.abs(got - want) / voxel);
          checked++;
        }
      }
    }
    note(`sampleSdfVolume vs naive trilinear: worst difference ${worst.toExponential(2)} voxel over ${checked} points`);
    expect(worst).toBeLessThan(1e-9);
  });

  it('returns exactly the stored sample at every lattice point (voxel a power of two), also on the upper faces', () => {
    const rng = mulberry32(0xb302);
    for (const dims of DIMS) {
      const origin: Vec3 = [4, -8, 0.5];
      const voxel = 0.25;
      const volume = randomVolume(rng, dims, origin, voxel);
      let i = 0;
      for (let z = 0; z < dims[2]; z++) {
        for (let y = 0; y < dims[1]; y++) {
          for (let x = 0; x < dims[0]; x++) {
            expect(sampleSdfVolume(volume, [origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z])).toBe((volume.data[i++] * voxel) / 256);
          }
        }
      }
    }
  });

  it('is continuous across cell faces and across the faces of the lattice box, and 1-Lipschitz outside the box', () => {
    const rng = mulberry32(0xb303);
    const dims: Dims = [5, 4, 6];
    const origin: Vec3 = [1, 2, 3];
    const voxel = 0.5;
    // A field with slope ≤ 1 (a real distance field), so that Lipschitz-ness can be checked.
    const field = new Float64Array(120);
    let i = 0;
    for (let z = 0; z < 6; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) field[i++] = 0.6 - voxel * Math.hypot(x - 2.2, y - 1.4, z - 2.7);
    const volume = encodeSdfVolume(field, dims, origin, voxel);
    const eps = 1e-7;
    let worstJump = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const axis = Math.floor(rng() * 3);
      // A point exactly on a lattice plane of `axis` (inner planes and both box faces), anywhere on the others.
      const g: Vec3 = [-1 + rng() * 6, -1 + rng() * 5, -1 + rng() * 7];
      g[axis] = Math.floor(rng() * dims[axis]);
      const p: Vec3 = [origin[0] + voxel * g[0], origin[1] + voxel * g[1], origin[2] + voxel * g[2]];
      const below: Vec3 = [p[0], p[1], p[2]];
      const above: Vec3 = [p[0], p[1], p[2]];
      below[axis] -= eps;
      above[axis] += eps;
      const here = sampleSdfVolume(volume, p);
      worstJump = Math.max(worstJump, Math.abs(sampleSdfVolume(volume, below) - here), Math.abs(sampleSdfVolume(volume, above) - here));
    }
    // Slope of a trilinear patch of this field is at most ~1 (+ rounding), so a step of 1e-7 moves the value by ~1e-7.
    note(`sampleSdfVolume: largest jump over a step of 1e-7 in across lattice planes ${worstJump.toExponential(2)} in`);
    expect(worstJump).toBeLessThan(4e-7);
    // Outside the box: |f(a) − f(b)| ≤ |a − b| for points whose nearest box point is the same corner, and the
    // value falls by exactly the distance along the outward direction.
    const corner: Vec3 = [origin[0] + voxel * 4, origin[1] + voxel * 3, origin[2] + voxel * 5];
    const atCorner = sampleSdfVolume(volume, corner);
    for (let trial = 0; trial < 200; trial++) {
      const d: Vec3 = [rng() * 3, rng() * 3, rng() * 3];
      const p: Vec3 = [corner[0] + d[0], corner[1] + d[1], corner[2] + d[2]];
      expect(sampleSdfVolume(volume, p)).toBeCloseTo(atCorner - Math.hypot(d[0], d[1], d[2]), 10);
    }
  });

  it('NaN and infinite points', () => {
    const volume = encodeSdfVolume([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2], [0, 0, 0], 1);
    expect(sampleSdfVolume(volume, [NaN, 0, 0])).toBeNaN();
    expect(sampleSdfVolume(volume, [0, NaN, 0])).toBeNaN();
    expect(sampleSdfVolume(volume, [0, 0, NaN])).toBeNaN();
    expect(sampleSdfVolume(volume, [Infinity, 0, 0])).toBe(-Infinity);
    expect(sampleSdfVolume(volume, [0, -Infinity, 0])).toBe(-Infinity);
    expect(sampleSdfVolume(volume, [Infinity, NaN, 0])).toBeNaN();
    // Huge finite coordinates do not overflow to NaN.
    expect(sampleSdfVolume(volume, [1e200, -1e200, 1e200])).toBe(-Infinity);
    expect(sampleSdfVolume(volume, [1e150, 0, 0])).toBeCloseTo(-1e150, -140);
  });

  it('agrees with marchingCubesSdf about where the samples are: the mesh vertices lie on the sampled zero level', () => {
    const n = 24;
    const voxel = 0.11;
    const origin: Vec3 = [-3.2, 5.1, 0.7];
    const c: Vec3 = [origin[0] + voxel * 11.3, origin[1] + voxel * 12.1, origin[2] + voxel * 10.8];
    const r = voxel * 8.2;
    const field = new Float64Array(n * n * n);
    let i = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) field[i++] = r - Math.hypot(origin[0] + voxel * x - c[0], origin[1] + voxel * y - c[1], origin[2] + voxel * z - c[2]);
      }
    }
    const volume = encodeSdfVolume(field, [n, n, n], origin, voxel);
    const mesh = marchingCubesSdf(volume);
    let worst = 0;
    let worstRadius = 0;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const p: Vec3 = [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
      worst = Math.max(worst, Math.abs(sampleSdfVolume(volume, p)));
      worstRadius = Math.max(worstRadius, Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - r));
    }
    note(
      `marchingCubesSdf vertices: |sampleSdfVolume| ≤ ${(worst / voxel).toExponential(2)} voxel, |radius error| ≤ ${(worstRadius / voxel).toExponential(2)} voxel; volume ratio ${(signedVolume(mesh) / ((4 / 3) * Math.PI * r ** 3)).toFixed(4)}`,
    );
    // Vertices sit on lattice edges, where trilinear = linear: only float32 positions and the 0.01 clamp remain.
    expect(worst / voxel).toBeLessThan(0.02);
    // A half-voxel misplacement of the samples (cell-centered reading of `origin`) would show up here as ~0.5.
    expect(worstRadius / voxel).toBeLessThan(0.05);
  });
});

describe('encodeSdfVolume / decodeSdfVolume', () => {
  it('keeps the side of every sample under "≥ 0 is inside": tiny values, denormals, −0, random', () => {
    const rng = mulberry32(0xb304);
    for (const voxel of [1, 0.0173, 1e-3, 250]) {
      const values = [0, -0, 5e-324, -5e-324, 1e-300, -1e-300, 1e-12, -1e-12, (0.49 * voxel) / 256, (-0.49 * voxel) / 256, (0.5 * voxel) / 256, (-0.5 * voxel) / 256];
      for (let k = 0; k < 2000; k++) values.push((rng() * 2 - 1) * voxel * 10 ** (-12 + 14 * rng()));
      const volume = encodeSdfVolume(values, [values.length, 1, 1], [0, 0, 0], voxel);
      for (let i = 0; i < values.length; i++) {
        expect(volume.data[i] >= 0).toBe(values[i] >= 0);
        // Never more than one stored unit away (half a unit except for the negatives that would round to 0).
        const units = (values[i] * 256) / voxel;
        if (Math.abs(units) < 32000) expect(Math.abs(volume.data[i] - units)).toBeLessThanOrEqual(units < 0 && units > -0.5 ? 1 : 0.5 + 1e-9);
      }
    }
  });

  it('rounding at exact halves and at the Int16 limits; non-finite input', () => {
    const units = (list: number[]): number[] => Array.from(encodeSdfVolume(list.map((u) => u / 256), [list.length, 1, 1], [0, 0, 0], 1).data);
    // Halves round away from zero, on both sides. (The review found Math.round's −1.5 → −1, −2.5 → −2.)
    expect(units([0.5, -0.5, 1.5, -1.5, 2.5, -2.5])).toEqual([1, -1, 2, -2, 3, -3]);
    expect(units([0.5, 1.5, 2.5])).toEqual([1, 2, 3]);
    expect(units([-0.5, -0.25, -1e-9])).toEqual([-1, -1, -1]);
    expect(units([0.25, 0.4999, 1e-9, 0, -0])).toEqual([0, 0, 0, 0, 0]);
    // Saturation: 32767 is the largest, −32768 the smallest.
    expect(units([32766.4, 32767, 32767.4, 32767.5, 32768, 1e9, Infinity])).toEqual([32766, 32767, 32767, 32767, 32767, 32767, 32767]);
    expect(units([-32767.4, -32768, -32768.5, -32769, -1e9, -Infinity])).toEqual([-32767, -32768, -32768, -32768, -32768, -32768]);
    expect(() => encodeSdfVolume([NaN], [1, 1, 1], [0, 0, 0], 1)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0], [1, 1, 1], [0, 0, 0], NaN)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0], [1, 1, 1], [0, 0, 0], Infinity)).toThrow(RangeError);
  });

  it('a field and its negative are stored as negatives of each other, except within half a unit of 0 (the side wins)', () => {
    const rng = mulberry32(0xb305);
    const values = [1.5 / 256, 2.5 / 256, 77.5 / 256, 0.3 / 256];
    for (let k = 0; k < 500; k++) values.push(rng() * 4);
    const a = encodeSdfVolume(values, [values.length, 1, 1], [0, 0, 0], 1).data;
    const b = encodeSdfVolume(
      values.map((v) => -v),
      [values.length, 1, 1],
      [0, 0, 0],
      1,
    ).data;
    expect(Array.from(a.subarray(0, 4))).toEqual([2, 3, 78, 0]);
    expect(Array.from(b.subarray(0, 4))).toEqual([-2, -3, -78, -1]);
    for (let i = 0; i < values.length; i++) expect(b[i]).toBe(a[i] === 0 ? -1 : -a[i]);
  });

  it('decode → encode gives the stored integers back, for every Int16 value and several voxel sizes', () => {
    const all = new Int16Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = i - 32768;
    for (const voxel of [1, 0.0173, 1 / 3, 1e-3, 7.7, 1e-6, 1e6]) {
      const volume: SdfVolume = { data: all, dims: [65536, 1, 1], origin: [0, 0, 0], voxel };
      const back = encodeSdfVolume(decodeSdfVolume(volume), [65536, 1, 1], [0, 0, 0], voxel);
      expect(back.data).toEqual(all);
    }
  });

  it('copies its inputs: later changes to dims, origin or the field do not reach the volume', () => {
    const dims: Dims = [2, 1, 1];
    const origin: Vec3 = [1, 2, 3];
    const field = Float32Array.of(0.5, -0.5);
    const volume = encodeSdfVolume(field, dims, origin, 1);
    dims[0] = 9;
    origin[0] = 9;
    field[0] = 9;
    expect(volume.dims).toEqual([2, 1, 1]);
    expect(volume.origin).toEqual([1, 2, 3]);
    expect(Array.from(volume.data)).toEqual([128, -128]);
    expect(volume.data.buffer).toBeInstanceOf(ArrayBuffer);
    expect(SDF_UNITS_PER_VOXEL).toBe(256);
  });

  it('validates the origin too: three finite numbers', () => {
    // (The review found a NaN origin stored without complaint; every later sample of the volume was NaN.)
    expect(() => encodeSdfVolume([0.5, 0.25], [2, 1, 1], [NaN, 0, 0], 1)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0.5, 0.25], [2, 1, 1], [0, Infinity, 0], 1)).toThrow(RangeError);
    expect(() => encodeSdfVolume([0.5, 0.25], [2, 1, 1], [0, 0] as never, 1)).toThrow(RangeError);
    expect(() => decodeSdfVolume({ data: new Int16Array(2), dims: [2, 1, 1], origin: [0, NaN, 0], voxel: 1 })).toThrow(RangeError);
  });
});

describe('the stored volume in the flow of §2.9.7 step 3 (crop to bbox + 2 voxels)', () => {
  it('cropping a field and moving the origin by voxel·(lower corner) keeps samples, values and the mesh where they were', () => {
    // A recon-like grid: N = 48 samples over [−1.1, 1.1]³, a capsule-like blob away from the middle.
    const n = 48;
    const voxel = 2.2 / (n - 1);
    const origin: Vec3 = [-1.1, -1.1, -1.1];
    const f = (x: number, y: number, z: number): number => 0.21 - Math.hypot(x - 0.31, Math.max(0, Math.abs(y + 0.2) - 0.25), z - 0.12);
    const field = new Float32Array(n * n * n);
    const lo = [n, n, n];
    const hi = [-1, -1, -1];
    let i = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++, i++) {
          field[i] = f(origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z);
          if (field[i] >= 0) {
            const at = [x, y, z];
            for (let a = 0; a < 3; a++) {
              lo[a] = Math.min(lo[a], at[a]);
              hi[a] = Math.max(hi[a], at[a]);
            }
          }
        }
      }
    }
    // bbox of the inside samples + 2 voxels on every side.
    const c0 = lo.map((v) => v - 2);
    const dims: Dims = [hi[0] - lo[0] + 5, hi[1] - lo[1] + 5, hi[2] - lo[2] + 5];
    const cropped = new Float32Array(dims[0] * dims[1] * dims[2]);
    let k = 0;
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) cropped[k++] = field[c0[0] + x + n * (c0[1] + y + n * (c0[2] + z))];
      }
    }
    const cropOrigin: Vec3 = [origin[0] + voxel * c0[0], origin[1] + voxel * c0[1], origin[2] + voxel * c0[2]];
    const whole = encodeSdfVolume(field, [n, n, n], origin, voxel);
    const part = encodeSdfVolume(cropped, dims, cropOrigin, voxel);
    expect(part.data.length).toBeLessThan(whole.data.length / 4);
    // Same mesh (the crop holds the whole surface with a margin): same triangles, positions equal to float32 rounding.
    const a = marchingCubesSdf(whole);
    const b = marchingCubesSdf(part);
    expect(b.indices.length).toBe(a.indices.length);
    expect(b.positions.length).toBe(a.positions.length);
    expect(Math.abs(signedVolume(a) - signedVolume(b))).toBeLessThan(1e-6);
    // Same values at arbitrary points inside the crop; outside it the crop gives a lower bound that is negative.
    const rng = mulberry32(0xb305);
    let worstInside = 0;
    let tooHigh = 0;
    let positiveOutside = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const p: Vec3 = [-1.1 + 2.2 * rng(), -1.1 + 2.2 * rng(), -1.1 + 2.2 * rng()];
      const inCrop = p.every((v, axis) => v >= cropOrigin[axis] && v <= cropOrigin[axis] + voxel * (dims[axis] - 1));
      const fromWhole = sampleSdfVolume(whole, p);
      const fromPart = sampleSdfVolume(part, p);
      if (inCrop) worstInside = Math.max(worstInside, Math.abs(fromWhole - fromPart));
      else {
        if (fromPart >= 0) positiveOutside++;
        // The extrapolation must not claim to be closer to the part than the true field (exact distance outside).
        if (fromPart > f(p[0], p[1], p[2]) + 0.02 * voxel) tooHigh++;
      }
    }
    note(`crop ${dims.join('×')} of ${n}³: largest difference inside the crop ${(worstInside / voxel).toExponential(2)} voxel`);
    expect(worstInside / voxel).toBeLessThan(1e-9);
    expect(positiveOutside).toBe(0);
    expect(tooHigh).toBe(0);
  });
});
