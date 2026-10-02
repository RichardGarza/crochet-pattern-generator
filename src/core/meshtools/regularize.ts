// Track T5 — Path B step 7, readability (DESIGN.md §2.10.7 step 7): when the rounds are nearly circles about one axis
// (radial residual < 10% around the PCA axis), the DTW positions are replaced by the §2.10.8 placement with the same
// counts, so a near-round mesh part reads like a Path A piece ("(2 sc, inc) x 6").
//
// `placeRound` is the normative §2.10.8 base placement with the even/odd change-round rotation, written from the spec
// (T4 owns Path A's copy with the oval and R8 overrides; Path B rounds are circular and never joined, so only the base
// rule applies here).
import type { Vec3 } from '../../types/geometry';
import type { Op } from '../../types/pattern';

/** §2.10.7 step 7: regularize when the pooled radial residual is below this fraction. */
export const REGULARIZE_RESIDUAL = 0.1;

const sc = (): Op => ({ k: 'st', st: 'sc' });

/**
 * §2.10.8: the ops of one round P → T. inc3 / dec3 only where inc / dec cannot reach T; specials spread by even
 * interleave; `[(g+1) sc, special] × r ++ [g sc, special] × (k − r)`; rotated left by ⌈g/2⌉ ops when `changeIdx` is
 * even (the piece's first round with changes has changeIdx 0).
 */
export function placeRound(P: number, T: number, changeIdx: number): Op[] {
  if (!Number.isInteger(P) || !Number.isInteger(T) || P < 1 || T < 1) throw new RangeError(`counts must be integers ≥ 1, got ${P} → ${T}`);
  if (T > 3 * P || P > 3 * T) throw new RangeError(`${P} → ${T} needs more than inc3 / dec3`);
  if (P === T) return Array.from({ length: P }, sc);
  const d = Math.abs(T - P);
  const inc = T > P;
  const three = inc ? Math.max(0, d - P) : Math.max(0, P - 2 * T);
  const k = d - three;
  const plain = (inc ? P : T) - k;
  const special = (s: number): Op => {
    const is3 = Math.floor(((s + 1) * three) / k) > Math.floor((s * three) / k);
    return inc ? { k: 'inc', n: is3 ? 3 : 2 } : { k: 'dec', n: is3 ? 3 : 2 };
  };
  const g = Math.floor(plain / k);
  const r = plain % k;
  const base: Op[] = [];
  for (let s = 0; s < k; s++) {
    const run = s < r ? g + 1 : g;
    for (let q = 0; q < run; q++) base.push(sc());
    base.push(special(s));
  }
  if (changeIdx % 2 !== 0) return base;
  const m = Math.ceil(g / 2) % base.length;
  return base.slice(m).concat(base.slice(0, m));
}

export interface RadialFit {
  /** A point on the axis and its unit direction. */
  point: Vec3;
  axis: Vec3;
  /** Pooled RMS of (ρ − ρ̄_k)/ρ̄_k over every sample, ρ = distance from the axis. */
  residual: number;
  /** Per round: mean ρ and its relative RMS deviation. */
  perRound: { radius: number; residual: number }[];
}

/** Principal eigenvector of a symmetric 3×3 matrix (power iteration from a fixed start; deterministic). */
function principal(c: number[][]): { v: Vec3; lambda: number } {
  // Start near the largest diagonal direction so a dominant axis is found in a few steps.
  const dIdx = c[0][0] >= c[1][1] && c[0][0] >= c[2][2] ? 0 : c[1][1] >= c[2][2] ? 1 : 2;
  let v: Vec3 = [0.1, 0.1, 0.1];
  v[dIdx] += 1;
  let lambda = 0;
  for (let it = 0; it < 200; it++) {
    const w: Vec3 = [
      c[0][0] * v[0] + c[0][1] * v[1] + c[0][2] * v[2],
      c[1][0] * v[0] + c[1][1] * v[1] + c[1][2] * v[2],
      c[2][0] * v[0] + c[2][1] * v[1] + c[2][2] * v[2],
    ];
    const n = Math.hypot(w[0], w[1], w[2]);
    if (!(n > 0)) break;
    const nv: Vec3 = [w[0] / n, w[1] / n, w[2] / n];
    const delta = Math.hypot(nv[0] - v[0], nv[1] - v[1], nv[2] - v[2]);
    v = nv;
    lambda = n;
    if (delta < 1e-12) break;
  }
  const n = Math.hypot(v[0], v[1], v[2]);
  return { v: [v[0] / n, v[1] / n, v[2] / n], lambda };
}

/**
 * The axis through the round centers (their principal direction; when the centers barely spread — fewer than two
 * rounds, or within `minSpread` — the mean round normal through their mean) and the radial residual of the stitch
 * samples about it.
 */
export function radialFit(rounds: readonly { samples: ArrayLike<number>; center: Vec3; normal: Vec3 }[], minSpread = 1e-6): RadialFit {
  if (rounds.length === 0) throw new RangeError('no rounds');
  const m = rounds.length;
  const c: Vec3 = [0, 0, 0];
  for (const r of rounds) for (let a = 0; a < 3; a++) c[a] += r.center[a] / m;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const r of rounds) {
    const d = [r.center[0] - c[0], r.center[1] - c[1], r.center[2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += d[a] * d[b];
  }
  let axis: Vec3;
  const pc = principal(cov);
  if (m >= 2 && pc.lambda > minSpread) {
    axis = pc.v;
  } else {
    const n: Vec3 = [0, 0, 0];
    for (const r of rounds) for (let a = 0; a < 3; a++) n[a] += r.normal[a];
    const len = Math.hypot(n[0], n[1], n[2]);
    axis = len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 1, 0];
  }
  const perRound: { radius: number; residual: number }[] = [];
  let sum = 0;
  let count = 0;
  for (const r of rounds) {
    const s = r.samples;
    const n = s.length / 3;
    const rho = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const d = [s[3 * i] - c[0], s[3 * i + 1] - c[1], s[3 * i + 2] - c[2]];
      const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      rho[i] = Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]);
      mean += rho[i] / n;
    }
    let ss = 0;
    for (let i = 0; i < n; i++) ss += mean > 0 ? ((rho[i] - mean) / mean) ** 2 : 0;
    perRound.push({ radius: mean, residual: n > 0 ? Math.sqrt(ss / n) : 0 });
    sum += ss;
    count += n;
  }
  return { point: c, axis, residual: count > 0 ? Math.sqrt(sum / count) : 0, perRound };
}
