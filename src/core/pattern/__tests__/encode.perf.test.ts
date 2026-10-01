// Encoder budgets (DESIGN.md §5.8, §2.6.1). Timing tests retry twice and use the spec's generous bounds
// (§6.1 rule 5); the numbers measured on the development machine are in docs/tracks/s0b-pattern.md.
import { describe, expect, it } from 'vitest';
import type { Op } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import { EXACT_MAX_TOKENS, encodeOps, expand, resetEncodeMemo } from '../encode';
import { colored, dec, inc, sc, times } from './helpers';

const rng = mulberry32(120);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];

/** Lines of `n` op tokens in the shapes that stress the search: random, periodic, nearly periodic, tie-heavy. */
function shapes(n: number): (() => Op[])[] {
  const fill = (make: (i: number) => Op): Op[] => Array.from({ length: n }, (_, i) => ({ ...make(i) }));
  return [
    () => fill(() => pick([sc, inc, dec])),
    () => fill(() => pick([sc, inc])),
    () => {
      // A staggered amigurumi round: (g sc, inc) repeated, rotated.
      const g = 2 + Math.floor(rng() * 6);
      const shift = Math.floor(rng() * g);
      return fill((i) => ((i + shift) % (g + 1) === g ? inc : sc));
    },
    () => fill((i) => (i % 2 === 1 ? inc : sc)),
    () => {
      const defect = Math.floor(rng() * n);
      return fill((i) => (i === defect ? dec : i % 2 === 1 ? inc : sc));
    },
    () => fill((i) => colored(sc, `C${i}`)),
    () => fill((i) => (i % 11 === 10 ? dec : i % 2 === 1 ? inc : sc)),
    () => fill((i) => (i === 0 ? sc : i === n - 1 ? dec : i % 3 === 1 ? inc : sc)),
  ];
}

function timeEach(n: number, rounds: number, exactMaxTokens: number): number[] {
  const elapsed: number[] = [];
  for (const make of shapes(n)) {
    for (let r = 0; r < rounds; r++) {
      const ops = make();
      resetEncodeMemo(); // every line is searched, none is served from the memo
      const start = performance.now();
      const items = encodeOps(ops, { exactMaxTokens });
      elapsed.push(performance.now() - start);
      if (r === 0) expect(expand(items)).toEqual(ops);
    }
  }
  return elapsed.sort((a, b) => a - b);
}

describe('encoder budgets (§5.8)', () => {
  it('exact search: ≤ 5 ms per line at 120 tokens', { retry: 2, timeout: 60_000 }, () => {
    timeEach(EXACT_MAX_TOKENS, 5, EXACT_MAX_TOKENS); // warm-up
    const elapsed = timeEach(EXACT_MAX_TOKENS, 25, EXACT_MAX_TOKENS);
    const p90 = elapsed[Math.floor(elapsed.length * 0.9)];
    const mean = elapsed.reduce((sum, ms) => sum + ms, 0) / elapsed.length;
    expect(p90).toBeLessThanOrEqual(5);
    expect(mean).toBeLessThanOrEqual(5);
  });

  it('the exact search stays quadratic: 1 000 tokens well under 250 ms per line', { retry: 2, timeout: 60_000 }, () => {
    const elapsed = timeEach(1000, 2, 1000);
    expect(elapsed[elapsed.length - 1]).toBeLessThanOrEqual(250);
  });

  it('200 rows × 240 run tokens (fallback + memo): ≤ 2 s in total', { retry: 2, timeout: 60_000 }, () => {
    const colors = ['A', 'B', 'C', 'D', 'E', 'F'];
    const rows: Op[][] = [];
    for (let r = 0; r < 200; r++) {
      if (r % 4 === 3) {
        rows.push(rows[r - 3].map((op) => ({ ...op }))); // a row that repeats an earlier one: served by the memo
        continue;
      }
      const ops: Op[] = [];
      let last = '';
      for (let run = 0; run < 240; run++) {
        let color = pick(colors);
        while (color === last) color = pick(colors);
        last = color;
        ops.push(...times(1 + Math.floor(rng() * 6), colored(sc, color)));
      }
      rows.push(ops);
    }
    resetEncodeMemo();
    const start = performance.now();
    const encoded = rows.map((ops) => encodeOps(ops, { mode: 'runs' }));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThanOrEqual(2000);
    // The rows really had 240 run tokens each, went through the fallback, and survive the round trip.
    for (let r = 0; r < rows.length; r += 37) {
      let runs = 0;
      for (const item of encoded[r]) runs += item.kind === 'run' ? 1 : item.inner.length * item.times;
      expect(runs).toBe(240);
      expect(expand(encoded[r])).toEqual(rows[r]);
    }
    expect(encoded[3]).toBe(encoded[0]); // memo hit: the very same frozen result
  });
});
