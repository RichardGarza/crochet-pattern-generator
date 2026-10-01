// Color math (DESIGN.md §2.4.1, D4). Step 0 kernel: pure, deterministic, no DOM.
//
// Colors are stored as sRGB hex `#rrggbb` (§0.1); math runs in linear sRGB, OKLab and CIELAB (D65).
//   - clustering / cleanup distance: Euclidean distance between cluster features (toe(L), 2a, 2b) = ΔEOKr2
//     (1 JND ≈ 0.02 ≈ ΔE00 2);
//   - yarn matching and every user-facing ΔE: CIEDE2000 (Sharma 2005).
// glTF and MTL colors are linear and must go through linearToSrgb / linearRgbToHex before they are stored.
import type { RgbaImage } from '../../types/geometry';
import type { Hex } from '../../types/model';

/**
 * Three color channels. Which space they are in is given by the name of the function that takes or returns
 * them; the compiler cannot tell the spaces apart, so mind the names: `ciede2000` takes CIELAB (L 0..100),
 * `deltaEOKr2` takes OKLab (L 0..1), `featureDistance` takes cluster features.
 */
export type Color3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------------
// sRGB transfer function and hex
// ---------------------------------------------------------------------------------------------------------

/** sRGB decode: an encoded channel in 0..1 → linear light in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB encode: linear light in 0..1 → an encoded channel in 0..1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

const SRGB8_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) SRGB8_TO_LINEAR[i] = srgbToLinear(i / 255);

/**
 * sRGB decode of a channel on the 0..255 scale. Whole values 0..255 come from a table; fractional values (an
 * average of pixels, say) and values outside the range are computed, so the result is never undefined.
 */
export function srgb8ToLinear(v: number): number {
  const fromTable = SRGB8_TO_LINEAR[v];
  return fromTable === undefined ? srgbToLinear(v / 255) : fromTable;
}

/** Linear light → the nearest 8-bit sRGB channel value, clipped to 0..255 (NaN stays NaN). */
export function linearToSrgb8(c: number): number {
  const v = Math.round(linearToSrgb(c) * 255);
  return v <= 0 ? 0 : v >= 255 ? 255 : v; // `<= 0` also turns −0 into 0
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** True for `#rrggbb` (the only form the model stores, §3.5.1). */
export function isHex(value: unknown): boolean {
  return typeof value === 'string' && HEX_RE.test(value);
}

/** `#rrggbb` → 8-bit sRGB channels. Throws on anything else. */
export function parseHex(hex: Hex): Color3 {
  if (!isHex(hex)) throw new Error(`parseHex: expected #rrggbb, got ${JSON.stringify(hex)}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clampByte = (v: number): number => {
  const r = Math.round(v);
  return r <= 0 ? 0 : r >= 255 ? 255 : r;
};

/**
 * 8-bit sRGB channels (rounded and clipped to 0..255) → lowercase `#rrggbb`. Throws on NaN: a color that is
 * not a number is a bug upstream, and writing it as black would hide it.
 */
export function toHex(r8: number, g8: number, b8: number): Hex {
  if (Number.isNaN(r8) || Number.isNaN(g8) || Number.isNaN(b8)) {
    throw new RangeError(`toHex: a channel is NaN (${r8}, ${g8}, ${b8})`);
  }
  const n = (clampByte(r8) << 16) | (clampByte(g8) << 8) | clampByte(b8);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** `#rrggbb` → linear sRGB in 0..1. */
export function hexToLinearRgb(hex: Hex): Color3 {
  const [r, g, b] = parseHex(hex);
  return [SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]];
}

/** Linear sRGB (e.g. a glTF baseColorFactor or an MTL Kd) → `#rrggbb`, clipped to the sRGB gamut. */
export function linearRgbToHex(r: number, g: number, b: number): Hex {
  return toHex(linearToSrgb8(r), linearToSrgb8(g), linearToSrgb8(b));
}

// ---------------------------------------------------------------------------------------------------------
// OKLab (Ottosson; CSS Color 4 matrices)
// ---------------------------------------------------------------------------------------------------------

/** Linear sRGB → OKLab (L in 0..1 for in-gamut colors). */
export function linearRgbToOklab(r: number, g: number, b: number): Color3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB (not clipped: out-of-gamut colors give channels outside 0..1). */
export function oklabToLinearRgb(L: number, a: number, b: number): Color3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** sRGB on the 0..255 scale (whole or fractional values) → OKLab. */
export function srgb8ToOklab(r8: number, g8: number, b8: number): Color3 {
  return linearRgbToOklab(srgb8ToLinear(r8), srgb8ToLinear(g8), srgb8ToLinear(b8));
}

export function hexToOklab(hex: Hex): Color3 {
  const [r, g, b] = parseHex(hex);
  return srgb8ToOklab(r, g, b);
}

/** OKLab → `#rrggbb`; out-of-gamut colors are clipped per channel. */
export function oklabToHex(L: number, a: number, b: number): Hex {
  const [r, g, bl] = oklabToLinearRgb(L, a, b);
  return linearRgbToHex(r, g, bl);
}

// ---------------------------------------------------------------------------------------------------------
// Toe, cluster features and ΔEOKr2 (D4)
// ---------------------------------------------------------------------------------------------------------

const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);

/** Ottosson's lightness toe: OKLab L → Lr, which tracks CIELAB L* more closely. */
export function toe(x: number): number {
  const t = K3 * x - K1;
  return 0.5 * (t + Math.sqrt(t * t + 4 * K2 * K3 * x));
}

/** Inverse of toe. */
export function toeInv(x: number): number {
  return (x * x + K1 * x) / (K3 * (x + K2));
}

/** The cluster feature of D4: f = (toe(L), 2a, 2b). Euclidean distance between features is ΔEOKr2. */
export function oklabToFeature(L: number, a: number, b: number): Color3 {
  return [toe(L), 2 * a, 2 * b];
}

/** Inverse of oklabToFeature: a feature (for example a cluster mean) back to OKLab. */
export function featureToOklab(f0: number, f1: number, f2: number): Color3 {
  return [toeInv(f0), f1 / 2, f2 / 2];
}

export function srgb8ToFeature(r8: number, g8: number, b8: number): Color3 {
  const [L, a, b] = srgb8ToOklab(r8, g8, b8);
  return [toe(L), 2 * a, 2 * b];
}

export function hexToFeature(hex: Hex): Color3 {
  const [r, g, b] = parseHex(hex);
  return srgb8ToFeature(r, g, b);
}

/** A feature (for example a cluster mean) → `#rrggbb`, clipped to the sRGB gamut. */
export function featureToHex(f0: number, f1: number, f2: number): Hex {
  return oklabToHex(toeInv(f0), f1 / 2, f2 / 2);
}

/** Euclidean distance between two 3-vectors — ΔEOKr2 when both are cluster features. */
export function featureDistance(p: ArrayLike<number>, q: ArrayLike<number>): number {
  const d0 = p[0] - q[0];
  const d1 = p[1] - q[1];
  const d2 = p[2] - q[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

/** ΔEOKr2 between two OKLab colors. */
export function deltaEOKr2(lab1: ArrayLike<number>, lab2: ArrayLike<number>): number {
  const dL = toe(lab1[0]) - toe(lab2[0]);
  const da = 2 * (lab1[1] - lab2[1]);
  const db = 2 * (lab1[2] - lab2[2]);
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** ΔEOKr2 between two `#rrggbb` colors. */
export function deltaEOKr2Hex(hex1: Hex, hex2: Hex): number {
  return deltaEOKr2(hexToOklab(hex1), hexToOklab(hex2));
}

/**
 * The shading-robust feature for photos of 3D objects (§2.4.1, [06 §9.4]):
 * f' = (0.35·L, a / max(L, 0.25), b / max(L, 0.25)). The caller clips the top 2% of L first (that needs the
 * whole population, so it is not done here).
 */
export function shadingRobustFeature(L: number, a: number, b: number): Color3 {
  const d = Math.max(L, 0.25);
  return [0.35 * L, a / d, b / d];
}

/**
 * OKLab of every pixel of an image: a Float32Array of w·h·3 values (L, a, b), row-major. Alpha is ignored
 * (§2.3.2 handles transparency before colors are compared).
 */
export function imageToOklab(img: RgbaImage): Float32Array {
  const n = img.w * img.h;
  const out = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 4, o += 3) {
    const r = SRGB8_TO_LINEAR[d[p]];
    const g = SRGB8_TO_LINEAR[d[p + 1]];
    const b = SRGB8_TO_LINEAR[d[p + 2]];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  }
  return out;
}

/**
 * The cluster feature (toe(L), 2a, 2b) of every pixel of an image: a Float32Array of w·h·3 values, row-major.
 * Alpha is ignored.
 */
export function oklabFeatures(img: RgbaImage): Float32Array {
  const out = imageToOklab(img);
  for (let o = 0; o < out.length; o += 3) {
    out[o] = toe(out[o]);
    out[o + 1] *= 2;
    out[o + 2] *= 2;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// CIELAB (D65) and CIEDE2000
// ---------------------------------------------------------------------------------------------------------

// Linear sRGB → CIE XYZ, D65 (the exact rational matrix of CSS Color 4), and its white point, so that sRGB
// white is exactly L* = 100, a* = b* = 0.
const XN = 0.3127 / 0.329;
const ZN = (1 - 0.3127 - 0.329) / 0.329;

export function linearRgbToXyz(r: number, g: number, b: number): Color3 {
  return [
    (506752 / 1228815) * r + (87881 / 245763) * g + (12673 / 70218) * b,
    (87098 / 409605) * r + (175762 / 245763) * g + (12673 / 175545) * b,
    (7918 / 409605) * r + (87881 / 737289) * g + (1001167 / 1053270) * b,
  ];
}

const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;
const labF = (t: number): number => (t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);

/** CIE XYZ (D65, Y of white = 1) → CIELAB. */
export function xyzToLab(x: number, y: number, z: number): Color3 {
  const fx = labF(x / XN);
  const fy = labF(y);
  const fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Linear sRGB → CIELAB (D65). */
export function linearRgbToLab(r: number, g: number, b: number): Color3 {
  const [x, y, z] = linearRgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** sRGB on the 0..255 scale (whole or fractional values) → CIELAB (D65). */
export function srgb8ToLab(r8: number, g8: number, b8: number): Color3 {
  return linearRgbToLab(srgb8ToLinear(r8), srgb8ToLinear(g8), srgb8ToLinear(b8));
}

export function hexToLab(hex: Hex): Color3 {
  const [r, g, b] = parseHex(hex);
  return srgb8ToLab(r, g, b);
}

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

/** Hue angle in degrees, 0 ≤ h < 360; 0 when both arguments are 0. */
function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/**
 * CIEDE2000 color difference between two CIELAB colors (Sharma, Wu and Dalal 2005), with kL = kC = kH = 1.
 * Checked against all 34 of Sharma's published pairs to 1e-4.
 */
export function ciede2000(lab1: ArrayLike<number>, lab2: ArrayLike<number>): number {
  const L1 = lab1[0];
  const a1 = lab1[1];
  const b1 = lab1[2];
  const L2 = lab2[0];
  const a2 = lab2[1];
  const b2 = lab2[2];

  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const cBar7 = cBar ** 7;
  const G = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const chromaProduct = C1p * C2p;
  let dhp = 0;
  if (chromaProduct !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp / 2) * DEG);

  const LBarP = (L1 + L2) / 2;
  const CBarP = (C1p + C2p) / 2;
  let hBarP = h1p + h2p;
  if (chromaProduct !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
    else hBarP = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const CBarP7 = CBarP ** 7;
  const RC = 2 * Math.sqrt(CBarP7 / (CBarP7 + POW25_7));
  const dL50 = (LBarP - 50) ** 2;
  const SL = 1 + (0.015 * dL50) / Math.sqrt(20 + dL50);
  const SC = 1 + 0.045 * CBarP;
  const SH = 1 + 0.015 * CBarP * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** CIEDE2000 between two `#rrggbb` colors — the ΔE00 shown to the user and used for yarn matching. */
export function deltaE00Hex(hex1: Hex, hex2: Hex): number {
  return ciede2000(hexToLab(hex1), hexToLab(hex2));
}
