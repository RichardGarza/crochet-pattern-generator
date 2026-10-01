import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../../types/geometry';
import {
  ciede2000,
  deltaE00Hex,
  deltaEOKr2,
  deltaEOKr2Hex,
  featureDistance,
  featureToHex,
  featureToOklab,
  hexToFeature,
  hexToLab,
  hexToLinearRgb,
  hexToOklab,
  imageToOklab,
  isHex,
  linearRgbToHex,
  linearRgbToLab,
  linearRgbToOklab,
  linearRgbToXyz,
  linearToSrgb,
  linearToSrgb8,
  oklabFeatures,
  oklabToFeature,
  oklabToHex,
  oklabToLinearRgb,
  parseHex,
  shadingRobustFeature,
  srgb8ToFeature,
  srgb8ToLab,
  srgb8ToLinear,
  srgb8ToOklab,
  srgbToLinear,
  toe,
  toeInv,
  toHex,
} from '../color';

/**
 * G1 — the 34 pairs of Sharma, Wu and Dalal, "The CIEDE2000 color-difference formula: implementation notes,
 * supplementary test data, and mathematical observations" (2005), Table 1: L1 a1 b1 | L2 a2 b2 | ΔE00.
 */
const SHARMA: [number, number, number, number, number, number, number][] = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

describe('sRGB transfer function', () => {
  it('decodes and encodes the reference points', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114048223255, 12);
    expect(linearToSrgb(0.21404114048223255)).toBeCloseTo(0.5, 12);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 12);
  });

  it('uses the linear segment below the knee', () => {
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 15);
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 15);
    expect(linearToSrgb(0.0031308)).toBeCloseTo(12.92 * 0.0031308, 15);
    expect(linearToSrgb(0.001)).toBeCloseTo(0.01292, 15);
  });

  it('round-trips every 8-bit value', () => {
    for (let v = 0; v < 256; v++) {
      expect(srgb8ToLinear(v)).toBe(srgbToLinear(v / 255));
      expect(linearToSrgb8(srgb8ToLinear(v))).toBe(v);
    }
  });

  it('clips out-of-range linear values to 0..255 and never returns −0', () => {
    expect(linearToSrgb8(-0.5)).toBe(0);
    expect(linearToSrgb8(1.7)).toBe(255);
    expect(Object.is(linearToSrgb8(-1e-9), 0)).toBe(true);
    expect(Object.is(linearToSrgb8(-0), 0)).toBe(true);
    // red through OKLab and back: the two zero channels are computed as tiny negatives
    const [L, a, b] = srgb8ToOklab(255, 0, 0);
    expect(oklabToLinearRgb(L, a, b).map(linearToSrgb8)).toEqual([255, 0, 0]);
    expect(Number.isNaN(linearToSrgb8(Number.NaN))).toBe(true);
  });

  it('computes channel values that are not in the table instead of returning undefined', () => {
    expect(srgb8ToLinear(127.5)).toBeCloseTo(srgbToLinear(0.5), 15);
    expect(srgb8ToLinear(127.5)).toBeGreaterThan(srgb8ToLinear(127));
    expect(srgb8ToLinear(127.5)).toBeLessThan(srgb8ToLinear(128));
    expect(srgb8ToLinear(256)).toBeCloseTo(srgbToLinear(256 / 255), 15);
    expect(srgb8ToLinear(-1)).toBeCloseTo(-1 / 255 / 12.92, 15);
    expect(Number.isNaN(srgb8ToLinear(Number.NaN))).toBe(true);
    // an averaged color (fractional channels) converts to finite numbers between its neighbors
    const mid = srgb8ToOklab(127.5, 127.5, 127.5);
    expect(mid.every(Number.isFinite)).toBe(true);
    expect(mid[0]).toBeGreaterThan(srgb8ToOklab(127, 127, 127)[0]);
    expect(mid[0]).toBeLessThan(srgb8ToOklab(128, 128, 128)[0]);
    expect(srgb8ToFeature(127.5, 127.5, 127.5).every(Number.isFinite)).toBe(true);
    expect(srgb8ToLab(127.5, 127.5, 127.5).every(Number.isFinite)).toBe(true);
  });
});

describe('hex', () => {
  it('parses #rrggbb in either case', () => {
    expect(parseHex('#C8A27A')).toEqual([200, 162, 122]);
    expect(parseHex('#c8a27a')).toEqual([200, 162, 122]);
    expect(parseHex('#000000')).toEqual([0, 0, 0]);
    expect(parseHex('#ffffff')).toEqual([255, 255, 255]);
  });

  it('rejects everything that is not #rrggbb', () => {
    for (const bad of ['c8a27a', '#fff', '#c8a27', '#c8a27a00', '#gggggg', '', ' #c8a27a', 'red']) {
      expect(isHex(bad)).toBe(false);
      expect(() => parseHex(bad)).toThrow(/parseHex/);
    }
    expect(isHex(123)).toBe(false);
    expect(isHex(null)).toBe(false);
    expect(isHex('#C8A27A')).toBe(true);
    // isHex is a plain check, not a type guard: Hex is `string`, and a guard would narrow a rejected string
    // to `never` (this line would not compile).
    const css: string = 'red';
    if (!isHex(css)) expect(css.trim()).toBe('red');
  });

  it('formats lowercase #rrggbb, rounding and clipping', () => {
    expect(toHex(200, 162, 122)).toBe('#c8a27a');
    expect(toHex(0, 0, 0)).toBe('#000000');
    expect(toHex(255, 255, 255)).toBe('#ffffff');
    expect(toHex(1, 2, 3)).toBe('#010203');
    expect(toHex(-20, 300, 127.6)).toBe('#00ff80');
    expect(toHex(-0.2, 0.4, 254.6)).toBe('#0000ff');
  });

  it('refuses NaN instead of writing black', () => {
    expect(() => toHex(Number.NaN, 1, 2)).toThrow(/NaN/);
    expect(() => toHex(1, 2, Number.NaN)).toThrow(RangeError);
    expect(() => featureToHex(Number.NaN, 0, 0)).toThrow(/NaN/);
    expect(() => oklabToHex(0.5, Number.NaN, 0)).toThrow(/NaN/);
    expect(() => linearRgbToHex(0.5, 0.5, Number.NaN)).toThrow(/NaN/);
  });

  it('round-trips hex through linear RGB (glTF / MTL colors are linear)', () => {
    for (const hex of ['#c8a27a', '#f4ebdd', '#f2a7b5', '#222222', '#000000', '#ffffff', '#ff0000', '#0000ff']) {
      const [r, g, b] = hexToLinearRgb(hex);
      expect(linearRgbToHex(r, g, b)).toBe(hex);
    }
    // A linear mid-gray is much lighter than the sRGB code value 128.
    expect(linearRgbToHex(0.5, 0.5, 0.5)).toBe('#bcbcbc');
  });
});

describe('OKLab', () => {
  it('maps white, black and the primaries to the published values', () => {
    const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 4));
    close(linearRgbToOklab(1, 1, 1), [1, 0, 0]);
    close(linearRgbToOklab(0, 0, 0), [0, 0, 0]);
    close(srgb8ToOklab(255, 0, 0), [0.62796, 0.22486, 0.12585]);
    close(srgb8ToOklab(0, 255, 0), [0.86644, -0.23389, 0.1795]);
    close(srgb8ToOklab(0, 0, 255), [0.45201, -0.03246, -0.31153]);
    close(hexToOklab('#ff0000'), [0.62796, 0.22486, 0.12585]);
  });

  it('inverts to linear RGB', () => {
    for (const [r, g, b] of [
      [0.2, 0.5, 0.9],
      [1, 0, 0],
      [0.01, 0.02, 0.03],
      [0.7, 0.7, 0.7],
    ]) {
      const [L, a, bb] = linearRgbToOklab(r, g, b);
      const back = oklabToLinearRgb(L, a, bb);
      expect(back[0]).toBeCloseTo(r, 6);
      expect(back[1]).toBeCloseTo(g, 6);
      expect(back[2]).toBeCloseTo(b, 6);
    }
  });

  it('round-trips every hex of the §3.6 palette through OKLab', () => {
    for (const hex of ['#c8a27a', '#f4ebdd', '#f2a7b5', '#222222']) {
      const [L, a, b] = hexToOklab(hex);
      expect(oklabToHex(L, a, b)).toBe(hex);
    }
  });

  it('clips out-of-gamut colors when writing hex', () => {
    expect(oklabToHex(1.5, 0, 0)).toBe('#ffffff');
    expect(oklabToHex(-0.2, 0, 0)).toBe('#000000');
    expect(isHex(oklabToHex(0.7, 0.4, -0.4))).toBe(true);
  });
});

describe('toe and cluster features (D4)', () => {
  it('fixes 0 and 1 and matches the closed form', () => {
    expect(toe(0)).toBeCloseTo(0, 12);
    expect(toe(1)).toBeCloseTo(1, 12);
    expect(toe(0.5)).toBeCloseTo(0.42114056260896976, 12);
    const k1 = 0.206;
    const k2 = 0.03;
    const k3 = (1 + k1) / (1 + k2);
    for (const x of [0.1, 0.25, 0.5, 0.8]) {
      expect(toe(x)).toBeCloseTo(0.5 * (k3 * x - k1 + Math.sqrt((k3 * x - k1) ** 2 + 4 * k2 * k3 * x)), 14);
    }
  });

  it('is increasing and inverted by toeInv', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      const t = toe(x);
      expect(t).toBeGreaterThan(prev);
      prev = t;
      expect(toeInv(t)).toBeCloseTo(x, 12);
    }
  });

  it('builds f = (toe(L), 2a, 2b)', () => {
    expect(oklabToFeature(0.5, 0.1, -0.2)).toEqual([toe(0.5), 0.2, -0.4]);
    const [L, a, b] = srgb8ToOklab(200, 162, 122);
    expect(srgb8ToFeature(200, 162, 122)).toEqual([toe(L), 2 * a, 2 * b]);
    expect(hexToFeature('#c8a27a')).toEqual(srgb8ToFeature(200, 162, 122));
    const back = featureToOklab(toe(L), 2 * a, 2 * b);
    expect(back[0]).toBeCloseTo(L, 12);
    expect(back[1]).toBeCloseTo(a, 12);
    expect(back[2]).toBeCloseTo(b, 12);
  });

  it('turns a feature (a cluster mean) back into its hex', () => {
    for (const hex of ['#c8a27a', '#f4ebdd', '#f2a7b5', '#222222', '#3366cc']) {
      const [f0, f1, f2] = hexToFeature(hex);
      expect(featureToHex(f0, f1, f2)).toBe(hex);
    }
  });

  it('feature distance is ΔEOKr2', () => {
    const p = hexToOklab('#c8a27a');
    const q = hexToOklab('#f4ebdd');
    const viaFeatures = featureDistance(hexToFeature('#c8a27a'), hexToFeature('#f4ebdd'));
    expect(deltaEOKr2(p, q)).toBeCloseTo(viaFeatures, 14);
    expect(deltaEOKr2Hex('#c8a27a', '#f4ebdd')).toBeCloseTo(viaFeatures, 14);
    expect(deltaEOKr2Hex('#C8A27A', '#F4EBDD')).toBeCloseTo(0.25962360075825736, 10);
    expect(deltaEOKr2Hex('#c8a27a', '#c8a27a')).toBe(0);
    expect(deltaEOKr2Hex('#000000', '#ffffff')).toBeCloseTo(1, 6);
    expect(featureDistance(new Float32Array([0, 3, 0]), [4, 0, 0])).toBe(5);
  });

  it('agrees with the rule of thumb "1 JND ≈ 0.02 ≈ ΔE00 2"', () => {
    const ok = deltaEOKr2Hex('#808080', '#858585');
    const e00 = deltaE00Hex('#808080', '#858585');
    expect(ok).toBeGreaterThan(0.015);
    expect(ok).toBeLessThan(0.025);
    expect(e00).toBeGreaterThan(1.5);
    expect(e00).toBeLessThan(2.5);
  });

  it('builds the shading-robust feature f′ = (0.35·L, a / max(L, 0.25), b / max(L, 0.25))', () => {
    const lit = shadingRobustFeature(0.8, 0.1, -0.05);
    expect(lit[0]).toBeCloseTo(0.28, 12);
    expect(lit[1]).toBeCloseTo(0.125, 12);
    expect(lit[2]).toBeCloseTo(-0.0625, 12);
    const dark = shadingRobustFeature(0.1, 0.05, 0.02);
    expect(dark[0]).toBeCloseTo(0.035, 12);
    expect(dark[1]).toBeCloseTo(0.2, 12);
    expect(dark[2]).toBeCloseTo(0.08, 12);
    // A shaded and a lit sample of one surface (same chroma direction, L halved) stay close in f′.
    const a = shadingRobustFeature(0.8, 0.08, 0.04);
    const b = shadingRobustFeature(0.4, 0.04, 0.02);
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-12);
    expect(Math.abs(a[2] - b[2])).toBeLessThan(1e-12);
  });
});

describe('per-pixel image features', () => {
  const img: RgbaImage = {
    w: 2,
    h: 2,
    data: new Uint8ClampedArray([200, 162, 122, 255, 0, 0, 0, 255, 255, 255, 255, 0, 34, 34, 34, 128]),
  };

  it('imageToOklab matches the scalar conversion and ignores alpha', () => {
    const lab = imageToOklab(img);
    expect(lab).toBeInstanceOf(Float32Array);
    expect(lab.length).toBe(12);
    const px = [
      [200, 162, 122],
      [0, 0, 0],
      [255, 255, 255],
      [34, 34, 34],
    ];
    px.forEach(([r, g, b], i) => {
      const want = srgb8ToOklab(r, g, b);
      for (let c = 0; c < 3; c++) expect(lab[3 * i + c]).toBeCloseTo(want[c], 6);
    });
  });

  it('oklabFeatures matches srgb8ToFeature', () => {
    const f = oklabFeatures(img);
    expect(f.length).toBe(12);
    const want = srgb8ToFeature(200, 162, 122);
    for (let c = 0; c < 3; c++) expect(f[c]).toBeCloseTo(want[c], 6);
    const white = srgb8ToFeature(255, 255, 255);
    for (let c = 0; c < 3; c++) expect(f[6 + c]).toBeCloseTo(white[c], 6);
  });
});

describe('CIELAB (D65)', () => {
  it('maps white to (100, 0, 0) and black to (0, 0, 0)', () => {
    const white = srgb8ToLab(255, 255, 255);
    expect(white[0]).toBeCloseTo(100, 10);
    expect(white[1]).toBeCloseTo(0, 10);
    expect(white[2]).toBeCloseTo(0, 10);
    const black = srgb8ToLab(0, 0, 0);
    for (const v of black) expect(v).toBeCloseTo(0, 10);
  });

  it('keeps grays neutral', () => {
    for (const v of [16, 64, 128, 200, 250]) {
      const [L, a, b] = srgb8ToLab(v, v, v);
      expect(L).toBeGreaterThan(0);
      expect(Math.abs(a)).toBeLessThan(1e-9);
      expect(Math.abs(b)).toBeLessThan(1e-9);
    }
  });

  it('matches known sRGB colors', () => {
    const red = hexToLab('#ff0000');
    expect(red[0]).toBeCloseTo(53.2371, 3);
    expect(red[1]).toBeCloseTo(80.0901, 3);
    expect(red[2]).toBeCloseTo(67.2033, 3);
    expect(srgb8ToLab(128, 128, 128)[0]).toBeCloseTo(53.585, 3);
    const viaLinear = linearRgbToLab(1, 0, 0);
    for (let c = 0; c < 3; c++) expect(viaLinear[c]).toBeCloseTo(red[c], 12);
  });

  it('uses the linear segment for very dark colors (values checked against culori)', () => {
    const cases: [number[], number[]][] = [
      [[1, 1, 1], [0.274175, 0, 0]],
      [[5, 5, 5], [1.370874, 0, 0]],
      [[10, 10, 10], [2.741748, 0, 0]],
      [[20, 20, 20], [6.318928, 0, 0]],
      [[10, 0, 0], [0.583003, 2.614686, 0.92127]],
      [[0, 0, 20], [0.456178, 3.205667, -8.722409]],
      [[0, 12, 0], [2.375058, -4.85184, 3.46825]],
      [[3, 2, 1], [0.586857, 0.122377, 0.470587]],
    ];
    for (const [[r, g, b], want] of cases) {
      const got = srgb8ToLab(r, g, b);
      for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], 5);
    }
    // Below Y = 216/24389, L* is linear in Y with slope 24389/27; a gray's Y is its linear channel value.
    for (const v of [1, 4, 9, 15, 22]) {
      expect(srgb8ToLab(v, v, v)[0]).toBeCloseTo((24389 / 27) * srgbToLinear(v / 255), 9);
    }
    // ...and the two branches meet: L* is increasing across the whole gray ramp.
    let previous = -1;
    for (let v = 0; v < 256; v++) {
      const L = srgb8ToLab(v, v, v)[0];
      expect(L).toBeGreaterThan(previous);
      previous = L;
    }
    expect(deltaE00Hex('#010101', '#0a0a0a')).toBeCloseTo(1.4310522262, 8);
    expect(deltaE00Hex('#000000', '#0a0000')).toBeCloseTo(3.7090084728, 8);
  });

  it('uses the D65 white of sRGB', () => {
    const [x, y, z] = linearRgbToXyz(1, 1, 1);
    expect(x).toBeCloseTo(0.3127 / 0.329, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo((1 - 0.3127 - 0.329) / 0.329, 12);
  });
});

describe('CIEDE2000', () => {
  it('has all 34 Sharma pairs', () => {
    expect(SHARMA.length).toBe(34);
  });

  it.each(SHARMA.map((row, i) => [i + 1, ...row] as const))(
    'G1 Sharma pair %i: (%f, %f, %f) vs (%f, %f, %f) → %f',
    (_n, L1, a1, b1, L2, a2, b2, expected) => {
      expect(Math.abs(ciede2000([L1, a1, b1], [L2, a2, b2]) - expected)).toBeLessThan(1e-4);
      // The formula is symmetric.
      expect(Math.abs(ciede2000([L2, a2, b2], [L1, a1, b1]) - expected)).toBeLessThan(1e-4);
    },
  );

  it('matches the smoke pairs of §2.4.1', () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
    expect(ciede2000([50, 2.5, 0], [61, -5, 29])).toBeCloseTo(22.8977, 4);
  });

  it('is zero for identical colors and accepts typed arrays', () => {
    expect(ciede2000([50, 10, -10], [50, 10, -10])).toBe(0);
    expect(ciede2000(new Float64Array([50, 2.5, 0]), new Float64Array([73, 25, -18]))).toBeCloseTo(27.1492, 4);
  });

  it('compares hex colors', () => {
    expect(deltaE00Hex('#c8a27a', '#c8a27a')).toBe(0);
    expect(deltaE00Hex('#000000', '#ffffff')).toBeCloseTo(100, 6);
    expect(deltaE00Hex('#C8A27A', '#F4EBDD')).toBeCloseTo(20.447245554804862, 8);
    expect(deltaE00Hex('#F4EBDD', '#C8A27A')).toBeCloseTo(20.447245554804862, 8);
  });
});
