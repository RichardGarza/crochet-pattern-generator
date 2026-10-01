// Test helper: the count-level parts of the §2.13 rules (the line-level validators come with T4.2). Returns a
// list of violations, empty when the counts are valid.
import type { PieceCounts } from '../../rounds';
import { mrRange } from '../../poles';

export interface InvariantOptions {
  style: 'classic' | 'exact';
  flattened?: boolean;
}

export function countViolations(out: PieceCounts, o: InvariantOptions): string[] {
  const bad: string[] = [];
  const { counts, circ } = out;
  const S = out.ovalS;
  // E_SANITY (R15)
  if (counts.length === 0) bad.push('no rounds');
  if (counts.length >= 200) bad.push(`E_SANITY: ${counts.length} rounds`);
  if (counts.reduce((a, b) => a + b, 0) >= 20000) bad.push('E_SANITY: ≥ 20 000 sts');
  counts.forEach((c, i) => {
    if (!Number.isInteger(c) || c < 1) bad.push(`E_SANITY: round ${i + 1} has ${c}`);
  });
  if (circ.length !== counts.length) bad.push('circ and counts differ in length');
  if (S && S.length !== counts.length) bad.push('ovalS and counts differ in length');
  if (S) S.forEach((v, i) => i > 0 && Math.abs(v - S[i - 1]) > 1 && bad.push(`|ΔS| > 1 at round ${i + 1}`));
  // E_START (R2)
  const st = out.start;
  if (st.k === 'mr') {
    const [lo, hi] = out.generator === 'textbook' ? [6, 6] : mrRange({ style: o.style, flattened: o.flattened });
    if (st.n !== counts[0]) bad.push(`MR n ${st.n} ≠ round 1 ${counts[0]}`);
    if (counts[0] < lo || counts[0] > hi) bad.push(`E_START: MR ${counts[0]} outside ${lo}–${hi}`);
  } else if (st.k === 'chainOval') {
    if (!S) bad.push('chain oval without sides');
    else if (st.chains !== S[0] + 3 || counts[0] !== 2 * st.chains || circ[0] !== 6) bad.push(`E_START: chain oval ch ${st.chains}, round 1 ${counts[0]}`);
  }
  // round 1 of a magic ring or chain oval is worked into the ring, never in BLO/FLO
  if ((st.k === 'mr' || st.k === 'chainOval') && out.loops[0] !== 'both') bad.push(`round 1 in ${out.loops[0]}`);
  if (out.loops.length !== counts.length) bad.push('loops and counts differ in length');
  // a chain ring: round 1 is worked into its chains within the fan limits
  if (st.k === 'chainRing' && (counts[0] > 2 * st.chains || counts[0] < Math.ceil(st.chains / 2))) bad.push(`chain ring ${st.chains} → ${counts[0]}`);
  // the closed end shortens the piece by at most one round (R11: ≤ 1.5·hS at the tip)
  if (out.dropped > 1) bad.push(`${out.dropped} rounds dropped at the closed end`);
  // pole rule: no decrease while ideal_k < n₁ next to a closed start
  if ((st.k === 'mr' || st.k === 'chainOval') && out.ideal.length) {
    for (let k = 1; k < circ.length && out.ideal[k] < circ[0]; k++) {
      if (circ[k] < circ[k - 1]) bad.push(`decrease next to the closed start at round ${k + 1}`);
    }
  }
  // fan: circular part within 2 into one / 2 together; total counts feasible with inc3/dec3 (else E_*_INFEASIBLE)
  for (let k = 1; k < counts.length; k++) {
    if (circ[k] > 2 * circ[k - 1] || circ[k] < Math.ceil(circ[k - 1] / 2)) bad.push(`fan: ${circ[k - 1]} → ${circ[k]} at round ${k + 1}`);
    if (counts[k] > 3 * counts[k - 1] || 3 * counts[k] < counts[k - 1]) bad.push(`E_INFEASIBLE: ${counts[k - 1]} → ${counts[k]}`);
  }
  // E_CLOSE (R9)
  if (out.closedEnd) {
    const last = counts.length - 1;
    if (S) {
      if (circ[last] !== 6) bad.push(`oval closes with circular part ${circ[last]} ≠ 6`);
      if (S[last] >= 2 ? out.finish !== 'flattenSc' : out.finish !== 'gather' || counts[last] > 8) bad.push(`E_CLOSE: oval finish ${out.finish} with S ${S[last]}`);
    } else {
      if (counts[last] > 8 || counts[last] < 4) bad.push(`E_CLOSE: closes at ${counts[last]}`);
      if (out.finish !== 'gather') bad.push(`closed circular finish ${out.finish}`);
    }
  } else {
    if (out.finish !== 'open' && out.finish !== 'seamToStart') bad.push(`open piece with finish ${out.finish}`);
    // an open edge is never a near-point (a pole worked "open"); a part thinner than 4 sts is W_MIN_PART's business
    const edgeIdeal = out.ideal.length ? out.ideal[Math.min(counts.length, out.ideal.length) - 1] : counts[counts.length - 1];
    if (counts[counts.length - 1] < 4 && edgeIdeal >= 3.5) bad.push(`open edge of ${counts[counts.length - 1]} sts`);
  }
  return bad;
}

export const isPalindrome = (xs: readonly number[]) => xs.every((x, i) => x === xs[xs.length - 1 - i]);
