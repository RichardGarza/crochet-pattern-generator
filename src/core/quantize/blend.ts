// Anti-aliasing centers in flat art and mixed cells (track T1 decision, docs/tracks/t1.md "T1.2 decisions").
// Pure, no DOM.
//
// A logo drawn in two colors carries a 1–2 px ring of blended pixels along every edge. At source resolution the
// quantizer sees those blends as a third (fourth…) color, and auto-K's knee keeps them (D(2) is always the top
// of the normalized curve, so the knee is never K = 2). A center is an anti-aliasing blend when
//   - its color lies between two other centers — within ΔEOKr2 0.05 of a mix of them, 5–95% of the way, mixed
//     in linear light (optical mixing, resampling) or in sRGB (how most renderers anti-alias) — and
//   - at least half of its pixels have both of those centers within 2 px (a 5 × 5 window).
// Such centers are removed one at a time (the most edge-bound first). Protected centers (hand edits, salient
// details) are never removed. Photos are never passed here.
// `isMixOf` is the same color test for one color; the salience guard uses it so that cells straddling an edge
// (a box average of two regions) are not mistaken for small details.
import { linearRgbToOklab, linearToSrgb, oklabToFeature, srgbToLinear, type Color3 } from '../kernel/color';
import { NO_LABEL } from '../image2d/labels';

export const BLEND_MAX_DE = 0.05;
export const BLEND_MIN_T = 0.05;
export const BLEND_MIN_EDGE_SHARE = 0.5;
const RADIUS = 2;

const featureOfLin = (c: Color3): Color3 => {
  const [L, a, b] = linearRgbToOklab(c[0], c[1], c[2]);
  return oklabToFeature(L, a, b);
};
const dist = (p: Color3, q: Color3): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const toSrgb = (c: Color3): Color3 => [linearToSrgb(Math.max(0, c[0])), linearToSrgb(Math.max(0, c[1])), linearToSrgb(Math.max(0, c[2]))];
const fromSrgb = (c: Color3): Color3 => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];

/**
 * How well `c` is explained as a mix of `a` and `b` (all linear RGB): the smallest ΔEOKr2 between c and a
 * mix 5–95% of the way, mixed in linear light or in sRGB; Infinity when c projects outside that range.
 */
export function mixDistance(c: Color3, a: Color3, b: Color3): number {
  const fc = featureOfLin(c);
  let best = Infinity;
  for (const space of [0, 1]) {
    const A = space === 0 ? a : toSrgb(a);
    const B = space === 0 ? b : toSrgb(b);
    const C = space === 0 ? c : toSrgb(c);
    const AB: Color3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const len2 = AB[0] ** 2 + AB[1] ** 2 + AB[2] ** 2;
    if (!(len2 > 0)) continue;
    const t = ((C[0] - A[0]) * AB[0] + (C[1] - A[1]) * AB[1] + (C[2] - A[2]) * AB[2]) / len2;
    if (t < BLEND_MIN_T || t > 1 - BLEND_MIN_T) continue;
    const M: Color3 = [A[0] + t * AB[0], A[1] + t * AB[1], A[2] + t * AB[2]];
    best = Math.min(best, dist(fc, featureOfLin(space === 0 ? M : fromSrgb(M))));
  }
  return best;
}

/** True when `c` is a mix of two of `centers` (see mixDistance; `skip` = a center to leave out, e.g. c's own). */
export function isMixOf(c: Color3, centers: readonly Color3[], skip = -1): boolean {
  return bestPair(c, centers, (k) => k !== skip) !== undefined;
}

function bestPair(c: Color3, lin: readonly Color3[], usable: (k: number) => boolean): { a: number; b: number; de: number } | undefined {
  let best: { a: number; b: number; de: number } | undefined;
  for (let a = 0; a < lin.length; a++) {
    if (!usable(a)) continue;
    for (let b = a + 1; b < lin.length; b++) {
      if (!usable(b)) continue;
      const de = mixDistance(c, lin[a], lin[b]);
      if (de < BLEND_MAX_DE && (best === undefined || de < best.de)) best = { a, b, de };
    }
  }
  return best;
}

/** Share of the given pixels that have both labels a and b within the window. */
function edgeShare(labels: Uint8Array, w: number, h: number, pixels: readonly number[], a: number, b: number): number {
  if (pixels.length === 0) return 0;
  let on = 0;
  for (const i of pixels) {
    const x = i % w;
    const y = (i - x) / w;
    let hasA = false;
    let hasB = false;
    for (let dy = -RADIUS; dy <= RADIUS && !(hasA && hasB); dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const l = labels[yy * w + xx];
        if (l === a) hasA = true;
        else if (l === b) hasB = true;
      }
    }
    if (hasA && hasB) on++;
  }
  return on / pixels.length;
}

/**
 * Finds and removes anti-aliasing centers from a flat-art pixel label image (labels < lin.length, NO_LABEL =
 * none). `lin` = the centers' linear RGB. Relabels `labels` in place (a removed center's pixels go to the nearer
 * end) and returns the removed centers in removal order.
 */
export function removeBlendCenters(labels: Uint8Array, w: number, h: number, lin: readonly Color3[], isProtected: (k: number) => boolean): number[] {
  const k = lin.length;
  const pixels: number[][] = lin.map(() => []);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== NO_LABEL && labels[i] < k) pixels[labels[i]].push(i);
  const alive = pixels.map((p) => p.length > 0);
  const removed: number[] = [];
  // A center's share only changes when a neighbor's pixels are relabeled; recomputing all is cheap enough as
  // the pixel lists are short for blends and the pair test fails fast for real colors.
  for (;;) {
    let pick: { c: number; a: number; b: number; share: number } | undefined;
    for (let c = 0; c < k; c++) {
      if (!alive[c] || isProtected(c)) continue;
      const pair = bestPair(lin[c], lin, (q) => q !== c && alive[q]);
      if (pair === undefined) continue;
      const share = edgeShare(labels, w, h, pixels[c], pair.a, pair.b);
      if (share >= BLEND_MIN_EDGE_SHARE && (pick === undefined || share > pick.share)) pick = { c, a: pair.a, b: pair.b, share };
    }
    if (pick === undefined) break;
    const { c, a, b } = pick;
    const fc = featureOfLin(lin[c]);
    const to = dist(fc, featureOfLin(lin[a])) <= dist(fc, featureOfLin(lin[b])) ? a : b;
    for (const i of pixels[c]) labels[i] = to;
    for (const i of pixels[c]) pixels[to].push(i);
    pixels[c] = [];
    alive[c] = false;
    removed.push(c);
  }
  return removed;
}
