// Test helper: DESIGN.md §2.10.5's counts pseudocode and pole rule, transcribed literally (full-list mirrorHalf →
// clampPoles with the unbounded closed-end walk → clampFan → + 2·S), so tests can show where `pathACounts`
// agrees with it (every golden; every single-bulge profile) and where it deliberately does not (docs/tracks/t4.md).
import { roundHalfUp } from '../../../gauge/round';
import { ovalSides } from '../../oval';
import { isSymmetricProfile, profileR, type Profile } from '../../profiles';

const round = roundHalfUp;

function hysteresis(x: number[], band: number): number[] {
  const out: number[] = [];
  for (const v of x) {
    const p = out.at(-1);
    out.push(p === undefined || Math.abs(v - p) > band ? round(v) : p);
  }
  return out;
}

function batchCounts(x: number[], sym: number, p0 = 6): number[] {
  const out: number[] = [];
  let p = p0;
  for (const v of x) {
    p = [p - sym, p, p + sym].filter((c) => c >= sym).reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), p);
    out.push(p);
  }
  return out;
}

function mirrorHalf(x: number[], round1: (x: number[]) => number[]): number[] {
  const m = x.length;
  const n = round1(x.slice(0, Math.ceil(m / 2)));
  for (let k = n.length; k < m; k++) n.push(n[m - 1 - k]);
  return n;
}

/** Rounds the literal "drop trailing rounds equal to their predecessor" removed, and how many the rule had not raised. */
export const literalDrops = { dropped: 0, unraised: 0 };

function clampPoles(n0: number[], ideal: number[], o: { start: 'mr' | 'chainOval' | 'chainRing'; closedFarEnd: boolean; style: string; oval: boolean }): number[] {
  const n = n0.slice();
  if (o.start === 'mr') {
    n[0] = o.style === 'classic' ? 6 : Math.min(8, Math.max(5, round(ideal[0])));
    for (let k = 1; k < n.length && ideal[k] < n[0]; k++) n[k] = Math.max(n[k], n[k - 1]);
  } else if (o.start === 'chainOval') n[0] = 6;
  if (o.closedFarEnd) {
    const min = o.oval ? 6 : 5;
    let peak = 0;
    for (let k = 1; k < n.length; k++) if (n[k] >= n[peak]) peak = k;
    const before = n.slice();
    for (let k = n.length - 1; k >= peak; k--) n[k] = Math.max(n[k], k + 1 < n.length ? n[k + 1] : min, min);
    literalDrops.dropped = 0;
    literalDrops.unraised = 0;
    while (n.length >= 2 && n[n.length - 1] === n[n.length - 2]) {
      if (n[n.length - 1] === before[n.length - 1]) literalDrops.unraised++;
      n.pop();
      literalDrops.dropped++;
    }
  }
  return n;
}

function clampFan(n0: number[]): number[] {
  const n = n0.slice();
  for (let k = 1; k < n.length; k++) n[k] = Math.min(2 * n[k - 1], Math.max(Math.ceil(n[k - 1] / 2), n[k]));
  return n;
}

export function literalCounts(p: Profile, wS: number, hS: number, style: 'classic' | 'exact'): { counts: number[]; circ: number[] } {
  const L = p.L;
  const N = Math.max(2, round(L / hS));
  const hEff = L / N;
  const closedFarEnd = p.closedEnd;
  const ks = Array.from({ length: closedFarEnd ? N - 1 : N }, (_, i) => i + 1);
  const ideal = ks.map((k) => (2 * Math.PI * profileR(p, k * hEff)) / wS);
  const round1 = (x: number[]) => (style === 'exact' ? hysteresis(x, 0.75) : batchCounts(x, Math.max(...x) < 18 ? 4 : 6, 6));
  const symmetric = isSymmetricProfile(p);
  let n = symmetric ? mirrorHalf(ideal, round1) : round1(ideal);
  const S = p.oval ? ovalSides(p, ks.map((k) => k * hEff), wS, symmetric) : undefined;
  const start = !p.closedStart ? 'chainRing' : S && S[0] >= 1 ? 'chainOval' : 'mr';
  n = clampPoles(n, ideal, { start, closedFarEnd, style, oval: !!p.oval });
  n = clampFan(n);
  return { circ: n, counts: S ? n.map((c, i) => c + 2 * S[i]) : n };
}
