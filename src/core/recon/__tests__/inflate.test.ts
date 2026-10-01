// T3.2 — local thickness and the inflation height T = √(d·(2R − d)) (DESIGN.md §2.9.3, §6.3 T3).
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../kernel/prng';
import { edt2d } from '../../kernel/geom/edt';
import { downsampleMask, inflationFromThickness, inflationHeight, localThickness } from '../inflate';

const HEAVY = { timeout: 120_000 };

function disc(R: number): { mask: Uint8Array; n: number } {
  const n = Math.ceil(2 * R + 10);
  const c = n / 2;
  const mask = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= R * R) mask[x + n * y] = 1;
  return { mask, n };
}

/** R_loc by brute force: every inside pixel's inscribed disc (radius = its inside EDT) painted with max. */
function bruteR(mask: Uint8Array, w: number, h: number): Float32Array {
  const W = w + 2;
  const out = new Uint8Array(W * (h + 2)).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[x + w * y]) out[x + 1 + W * (y + 1)] = 0;
  const dp = edt2d(out, W, h + 2);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[x + w * y] = dp[x + 1 + W * (y + 1)];
  const R = new Float32Array(w * h);
  for (let q = 0; q < w * h; q++) {
    const r = d[q];
    if (!r) continue;
    const r2 = Math.round(r * r); // whole-number squared distances: rim pixels are decided exactly
    const qx = q % w;
    const qy = (q - qx) / w;
    for (let y = Math.max(0, qy - Math.floor(r)); y <= Math.min(h - 1, qy + r); y++) {
      for (let x = Math.max(0, qx - Math.floor(r)); x <= Math.min(w - 1, qx + r); x++) {
        const p = x + w * y;
        if (mask[p] && (x - qx) ** 2 + (y - qy) ** 2 <= r2 && R[p] < r) R[p] = r;
      }
    }
  }
  return R;
}

describe('inflation height', HEAVY, () => {
  it.each([25, 30, 60, 120])('gives a hemisphere for a disc of radius %i px (volume within 2 percent)', (R) => {
    const { mask, n } = disc(R);
    const T = inflationHeight(mask, n, n);
    let v = 0;
    for (const t of T) v += t;
    expect(Math.abs(v / ((2 / 3) * Math.PI * R ** 3) - 1)).toBeLessThan(0.02);
    // The profile through the center is the hemisphere's (within a pixel, away from the rim, where the half pixel
    // of the 'samples' convention is magnified by the slope).
    const c = Math.floor(n / 2);
    for (let x = 0; x < n; x++) {
      const rho = Math.abs(x + 0.5 - n / 2);
      if (rho < 0.9 * R) expect(Math.abs(T[x + n * c] - Math.sqrt(R * R - rho * rho))).toBeLessThan(1.2);
    }
  });

  it.each([20, 21, 40, 60])('gives a semicircle across a strip %i px wide', (W) => {
    const w = 400;
    const h = W + 20;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 10 + W; y++) for (let x = 10; x < w - 10; x++) mask[x + w * y] = 1;
    const lt = localThickness(mask, w, h);
    const T = inflationFromThickness(lt);
    // Away from the ends, R_loc is the same over the whole cross-section (the ridge disc covers it) …
    const a = lt.R[200 + w * (10 + Math.floor(W / 2))];
    expect(Math.abs(a - W / 2)).toBeLessThanOrEqual(1);
    // … and T is the semicircle of radius a around the strip's middle.
    for (let x = 100; x <= 300; x += 50) {
      for (let y = 10; y < 10 + W; y++) {
        expect(lt.R[x + w * y]).toBe(a);
        const d = lt.d[x + w * y];
        // d = a − |s − c'| with c' the sample whose d is largest: the profile is exactly √(a² − (a − d)²).
        expect(T[x + w * y]).toBeCloseTo(Math.sqrt(a * a - (a - d) ** 2), 5);
      }
    }
    // The cross-section's area is the half disc of radius a (within the pixel sampling of a circle).
    let area = 0;
    for (let y = 0; y < h; y++) area += T[200 + w * y];
    expect(Math.abs(area / ((Math.PI * a * a) / 2) - 1)).toBeLessThan(0.06);
  });

  it('R_loc equals the brute-force largest inscribed disc on random blobs (exact)', () => {
    const rnd = mulberry32(12345);
    for (let t = 0; t < 8; t++) {
      const w = 110;
      const h = 90;
      const mask = new Uint8Array(w * h);
      const blobs = Array.from({ length: 4 }, () => [15 + rnd() * 80, 15 + rnd() * 60, 5 + rnd() * 25, 5 + rnd() * 20]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) for (const [cx, cy, rx, ry] of blobs) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) mask[x + w * y] = 1;
      }
      const lt = localThickness(mask, w, h);
      const ref = bruteR(mask, w, h);
      let diff = 0;
      for (let p = 0; p < w * h; p++) diff = Math.max(diff, Math.abs(ref[p] - lt.R[p]));
      expect(diff).toBe(0);
      expect(lt.ridge).toBeLessThan(mask.reduce((s, v) => s + v, 0) / 5);
    }
  });

  it('R_loc equals the brute force on adversarial masks (pixel, lines, checkerboard, ring, frame-cut, ellipse)', () => {
    const masks: { mask: Uint8Array; w: number; h: number }[] = [];
    const make = (w: number, h: number, f: (x: number, y: number) => boolean): void => {
      const mask = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f(x, y)) mask[x + w * y] = 1;
      masks.push({ mask, w, h });
    };
    make(9, 9, (x, y) => x === 4 && y === 4);
    make(40, 40, (x, y) => x === y);
    make(40, 40, (x, y) => Math.abs(x - y) <= 1);
    make(60, 30, (x, y) => Math.abs(y - 15 - 0.3 * (x - 30)) <= 1.5);
    make(30, 30, (x, y) => (x + y) % 2 === 0);
    make(70, 70, (x, y) => Math.hypot(x - 35, y - 35) <= 30 && Math.hypot(x - 35, y - 35) >= 18);
    make(50, 40, (x, y) => y < 25 && !(x > 20 && x < 26 && y < 10));
    make(90, 40, (x, y) => ((x - 45) / 40) ** 2 + ((y - 20) / 15) ** 2 <= 1);
    make(25, 25, () => true);
    for (const { mask, w, h } of masks) {
      const lt = localThickness(mask, w, h);
      const ref = bruteR(mask, w, h);
      for (let p = 0; p < w * h; p++) expect(lt.R[p]).toBe(ref[p]);
    }
  });

  it('downsampleMask keeps blocks that are at least half inside', () => {
    const m = new Uint8Array(5 * 3);
    m[0] = m[1] = m[5] = 1; // the first 2 × 2 block: 3 of 4
    m[4] = 1; // the last column's block (1 × 2 pixels): 1 of 2
    const d = downsampleMask(m, 5, 3, 2);
    expect([d.w, d.h]).toEqual([3, 2]);
    expect([...d.mask]).toEqual([1, 0, 1, 0, 0, 0]);
    expect(downsampleMask(m, 5, 3, 1).mask).toEqual(Uint8Array.from(m));
    expect(() => downsampleMask(m, 5, 3, 0)).toThrow(RangeError);
  });

  it('scales with the spacing, treats the frame as outside, and is 0 outside the mask', () => {
    const { mask, n } = disc(30);
    const a = localThickness(mask, n, n);
    const b = localThickness(mask, n, n, { spacing: 0.25 });
    for (let i = 0; i < a.d.length; i += 17) {
      expect(b.d[i]).toBeCloseTo(0.25 * a.d[i], 5);
      expect(b.R[i]).toBeCloseTo(0.25 * a.R[i], 5);
    }
    const T = inflationFromThickness(a);
    for (let i = 0; i < T.length; i++) if (!mask[i]) expect(T[i]).toBe(0);
    // A full mask: finite, the frame is the outline (a 9 px strip across a 9 × 40 image).
    const full = localThickness(new Uint8Array(9 * 40).fill(1), 9, 40);
    expect(Math.max(...full.d)).toBe(5);
    expect(Math.max(...full.R)).toBe(5);
    expect(localThickness(new Uint8Array(12), 4, 3).R.every((v) => v === 0)).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => localThickness(new Uint8Array(5), 2, 2)).toThrow(RangeError);
    expect(() => localThickness(new Uint8Array(4), 2, 2, { spacing: 0 })).toThrow(RangeError);
    expect(() => localThickness(new Uint8Array(0), 0, 0)).toThrow(RangeError);
  });
});
