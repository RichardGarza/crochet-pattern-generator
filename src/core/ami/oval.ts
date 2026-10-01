// Track T4 — oval pieces: the straight side S_k of every round (DESIGN.md §2.10.2, §2.10.5, §2.10.6).
//
// Sprint T4.1 holds the count-level part (S_k and the chain-oval start); segment placement and the closed-oval
// text belong to later sprints.
import { roundHalfUp } from '../gauge/round';
import { ovalHalfDiff, type Profile } from './profiles';

/**
 * `S_k = round(2(a_k − b_k)/wS)` at each round's arc position `s_k`, clamped so `|S_k − S_{k−1}| ≤ 1` (walking
 * from round 1, whose S is unclamped). With `symmetric`, the first `ceil(m/2)` values are computed and mirrored,
 * as `mirrorHalf` does for the counts, so a symmetric profile always gets symmetric sides. A circular piece gets
 * all zeros.
 */
export function ovalSides(p: Profile, sk: readonly number[], wS: number, symmetric = false): number[] {
  const raw = sk.map((s) => Math.max(0, roundHalfUp((2 * ovalHalfDiff(p, s)) / wS)));
  const m = raw.length;
  const upto = symmetric ? Math.ceil(m / 2) : m;
  const out: number[] = [];
  for (let k = 0; k < upto; k++) out.push(k === 0 ? raw[0] : Math.min(out[k - 1] + 1, Math.max(out[k - 1] - 1, raw[k])));
  for (let k = upto; k < m; k++) out.push(out[m - 1 - k]);
  return out;
}
