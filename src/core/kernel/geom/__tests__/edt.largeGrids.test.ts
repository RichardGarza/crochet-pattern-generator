// edt.ts at the sizes the app uses (512² masks, 64³ … 128³ volumes): spot checks against brute force at
// randomly chosen samples, consistency between the entry points, and determinism. From the independent review
// of Step 0b; it shares no code with the kernel or with edt.test.ts.
import { describe, expect, it } from 'vitest';
import { mulberry32, type Rng } from '../../prng';
import { edt2d, edt3d, edtSquared2d, edtSquared3d, extendSignedDistance3d, signedEdt2d, signedEdt3d } from '../edt';

/** Blobs, thin lines, single pixels and holes: a mask with structure at every scale. */
function blobMask2d(rng: Rng, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let k = 0; k < 14; k++) {
    const cx = rng() * w;
    const cy = rng() * h;
    const rx = 2 + rng() * 90;
    const ry = 2 + rng() * 90;
    const value = k % 5 === 4 ? 0 : 1; // every fifth blob is a hole
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(h, cy + ry); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(w, cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1) mask[x + w * y] = value;
      }
    }
  }
  for (let k = 0; k < 40; k++) mask[Math.floor(rng() * w * h)] ^= 1; // isolated pixels
  for (let x = 0; x < w; x++) mask[x + w * Math.floor(h * 0.37)] = x % 97 < 90 ? 1 : 0; // a thin, broken line
  return mask;
}

describe('transforms at application sizes', () => {
  it('512² mask: edt2d and both signed conventions equal brute force at 500 random pixels', () => {
    const rng = mulberry32(0xb401);
    const w = 512;
    const h = 512;
    const mask = blobMask2d(rng, w, h);
    const plain = edt2d(mask, w, h);
    const boundary = signedEdt2d(mask, w, h, { spacing: 0.0043, measureTo: 'boundary' });
    const samples = signedEdt2d(mask, w, h);
    const inside: number[] = [];
    const outside: number[] = [];
    for (let i = 0; i < mask.length; i++) (mask[i] ? inside : outside).push(i);
    expect(inside.length).toBeGreaterThan(1000);
    expect(outside.length).toBeGreaterThan(1000);
    for (let trial = 0; trial < 500; trial++) {
      const p = Math.floor(rng() * w * h);
      const px = p % w;
      const py = (p - px) / w;
      const nearest = (list: number[]): number => {
        let best = Infinity;
        for (const q of list) {
          const qx = q % w;
          const d2 = (px - qx) ** 2 + (py - (q - qx) / w) ** 2;
          if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
      };
      const toInside = nearest(inside);
      const toOutside = nearest(outside);
      expect(plain[p]).toBe(Math.fround(toInside));
      expect(samples[p]).toBe(Math.fround(mask[p] ? toOutside : -toInside));
      expect(boundary[p]).toBe(Math.fround(mask[p] ? 0.0043 * (toOutside - 0.5) : -0.0043 * (toInside - 0.5)));
    }
  });

  it("'samples' is the textbook difference of two plain transforms; 'boundary' is it moved by half a spacing toward 0", () => {
    const rng = mulberry32(0xb402);
    const w = 200;
    const h = 150;
    const mask = blobMask2d(rng, w, h);
    const inverted = Uint8Array.from(mask, (m) => (m ? 0 : 1));
    const dIn = edt2d(inverted, w, h, { spacing: 0.3 }); // distance to the nearest outside pixel
    const dOut = edt2d(mask, w, h, { spacing: 0.3 }); // distance to the nearest inside pixel
    const samples = signedEdt2d(mask, w, h, { spacing: 0.3, measureTo: 'samples' });
    const boundary = signedEdt2d(mask, w, h, { spacing: 0.3, measureTo: 'boundary' });
    for (let i = 0; i < mask.length; i++) {
      expect(samples[i]).toBe(Math.fround(dIn[i] - dOut[i]));
      expect(boundary[i]).toBeCloseTo(samples[i] - Math.sign(samples[i]) * 0.15, 5);
    }
  });

  it('64×80×48 volume: edt3d and signedEdt3d equal brute force at 300 random voxels', () => {
    const rng = mulberry32(0xb403);
    const dims: [number, number, number] = [64, 80, 48];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;
    const mask = new Uint8Array(n);
    for (let k = 0; k < 9; k++) {
      const c = [rng() * nx, rng() * ny, rng() * nz];
      const r = 3 + rng() * 18;
      const value = k % 4 === 3 ? 0 : 1;
      for (let i = 0; i < n; i++) {
        const x = i % nx;
        const y = Math.floor(i / nx) % ny;
        const z = Math.floor(i / (nx * ny));
        if (Math.hypot(x - c[0], y - c[1], z - c[2]) < r) mask[i] = value;
      }
    }
    const plain = edt3d(mask, dims, { spacing: 0.02 });
    const signed = signedEdt3d(mask, dims, { measureTo: 'boundary' });
    const inside: number[] = [];
    const outside: number[] = [];
    for (let i = 0; i < n; i++) (mask[i] ? inside : outside).push(i);
    for (let trial = 0; trial < 300; trial++) {
      const p = Math.floor(rng() * n);
      const px = p % nx;
      const py = Math.floor(p / nx) % ny;
      const pz = Math.floor(p / (nx * ny));
      const nearest = (list: number[]): number => {
        let best = Infinity;
        for (const q of list) {
          const d2 = (px - (q % nx)) ** 2 + (py - (Math.floor(q / nx) % ny)) ** 2 + (pz - Math.floor(q / (nx * ny))) ** 2;
          if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
      };
      const toInside = nearest(inside);
      expect(plain[p]).toBe(Math.fround(0.02 * toInside));
      expect(signed[p]).toBe(Math.fround(mask[p] ? nearest(outside) - 0.5 : -(toInside - 0.5)));
    }
  });

  it('seeded transform on a 300×200 grid with real costs: 300 random samples against brute force, and `nearest`', () => {
    const rng = mulberry32(0xb404);
    const w = 300;
    const h = 200;
    const seeds = new Float64Array(w * h).fill(Infinity);
    const list: number[] = [];
    for (let k = 0; k < 900; k++) {
      const q = Math.floor(rng() * w * h);
      seeds[q] = rng() * 400 - 50;
      list.push(q);
    }
    const sp: [number, number] = [0.7, 1.9];
    const v = Float64Array.from(seeds);
    const nearest = new Int32Array(w * h);
    edtSquared2d(v, w, h, { spacing: sp, nearest });
    for (let trial = 0; trial < 300; trial++) {
      const p = Math.floor(rng() * w * h);
      const px = p % w;
      const py = (p - px) / w;
      let best = Infinity;
      for (const q of list) {
        const qx = q % w;
        const c = ((px - qx) * sp[0]) ** 2 + ((py - (q - qx) / w) * sp[1]) ** 2 + seeds[q];
        if (c < best) best = c;
      }
      expect(Math.abs(v[p] - best)).toBeLessThan(1e-9);
      const q = nearest[p];
      const qx = q % w;
      expect(Math.abs(((px - qx) * sp[0]) ** 2 + ((py - (q - qx) / w) * sp[1]) ** 2 + seeds[q] - best)).toBeLessThan(1e-9);
    }
  });

  it('determinism: the same input gives byte-identical output, whatever the input array type and however often it runs', () => {
    const rng = mulberry32(0xb405);
    const dims: [number, number, number] = [40, 33, 27];
    const n = dims[0] * dims[1] * dims[2];
    const mask8 = Uint8Array.from({ length: n }, () => (rng() < 0.4 ? 1 : 0));
    const maskF = Float64Array.from(mask8);
    const maskA = Array.from(mask8);
    const bytes = (a: Float32Array | Float64Array | Int32Array): Uint8Array => new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
    const first = bytes(signedEdt3d(mask8, dims, { spacing: 0.0173 }));
    for (const m of [mask8, maskF, maskA, mask8]) expect(bytes(signedEdt3d(m, dims, { spacing: 0.0173 }))).toEqual(first);
    const plain = bytes(edt3d(mask8, dims, { spacing: [1, 2, 3] }));
    for (const m of [maskF, maskA]) expect(bytes(edt3d(m, dims, { spacing: [1, 2, 3] }))).toEqual(plain);
    // Seeded transform with many exact ties, and the far-field completion.
    const seeds = Float32Array.from({ length: n }, () => (rng() < 0.05 ? Math.floor(rng() * 3) : Infinity));
    const runSeeded = (): [Uint8Array, Uint8Array] => {
      const v = Float32Array.from(seeds);
      const who = new Int32Array(n);
      edtSquared3d(v, dims, { nearest: who });
      return [bytes(v), bytes(who)];
    };
    const [v1, w1] = runSeeded();
    const [v2, w2] = runSeeded();
    expect(v2).toEqual(v1);
    expect(w2).toEqual(w1);
    const band = Float32Array.from({ length: n }, (_, i) => {
      const d = 9.3 - Math.hypot((i % 40) - 19.4, (Math.floor(i / 40) % 33) - 16.2, Math.floor(i / 1320) - 13.1);
      return Math.abs(d) <= 2 ? d : d > 0 ? Infinity : -Infinity;
    });
    const e1 = bytes(extendSignedDistance3d(Float32Array.from(band), dims));
    const e2 = bytes(extendSignedDistance3d(Float32Array.from(band), dims));
    expect(e2).toEqual(e1);
  });
});
