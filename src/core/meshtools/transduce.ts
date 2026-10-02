// Track T5 — Path B step 6, the transducer (DESIGN.md §2.10.7): an alignment of two rounds (dtw.ts) → the ops of the
// new round. Degree > 1 on the old row ⇒ `inc` / `inc3`, degree > 1 on the new row ⇒ `dec` / `dec3`, else `sc`.
//
// The path's D moves separate the groups; inside a group every move is H (one old stitch, 2–3 new: an increase) or
// every move is V (2–3 old stitches, one new: a decrease) — the coupler never lets an H touch a V (R6). Ops come out
// in working order: op m is worked into the old stitches of group m and makes its new stitches.
import type { Op } from '../../types/pattern';
import type { Alignment } from './dtw';

const SC: Op = { k: 'st', st: 'sc' };

/** The new round's ops from an alignment (consumes P = al.P, produces T = al.T). Throws on a corner (R6). */
export function transduce(al: Pick<Alignment, 'cells'>): Op[] {
  const c = al.cells;
  const m = c.length / 2;
  if (m === 0) throw new RangeError('empty alignment');
  const ops: Op[] = [];
  let g = 0; // first cell of the current group
  const emit = (from: number, to: number): void => {
    const size = to - from + 1;
    if (size === 1) {
      ops.push({ ...SC });
      return;
    }
    if (size > 3) throw new RangeError(`a group of ${size} stitches (fans are 2 or 3)`);
    const sameOld = c[2 * from] === c[2 * to];
    const sameNew = c[2 * from + 1] === c[2 * to + 1];
    if (sameOld === sameNew) throw new RangeError('a stitch in an increase and a decrease at once (R6)');
    ops.push(sameOld ? { k: 'inc', n: size as 2 | 3 } : { k: 'dec', n: size as 2 | 3 });
  };
  for (let t = 1; t < m; t++) {
    const di = c[2 * t] - c[2 * t - 2];
    const dj = c[2 * t + 1] - c[2 * t - 1];
    if (di === 1 && dj === 1) {
      emit(g, t - 1);
      g = t;
    } else if (!((di === 0 && dj === 1) || (di === 1 && dj === 0))) {
      throw new RangeError(`not a monotone path at cell ${t}`);
    } else if (t - g >= 2) {
      // three cells in one group: all moves must be the same kind
      const pdi = c[2 * t - 2] - c[2 * t - 4];
      if (pdi !== di) throw new RangeError('a stitch in an increase and a decrease at once (R6)');
    }
  }
  emit(g, m - 1);
  return ops;
}

/** Counts of each op kind (for reports and tests): sc, inc, inc3, dec, dec3. */
export function opTally(ops: readonly Op[]): { sc: number; inc: number; inc3: number; dec: number; dec3: number } {
  const t = { sc: 0, inc: 0, inc3: 0, dec: 0, dec3: 0 };
  for (const op of ops) {
    if (op.k === 'st') t.sc++;
    else if (op.k === 'inc') t[op.n === 3 ? 'inc3' : 'inc']++;
    else if (op.k === 'dec') t[op.n === 3 ? 'dec3' : 'dec']++;
  }
  return t;
}
