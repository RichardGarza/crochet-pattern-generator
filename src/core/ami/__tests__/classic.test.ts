// The textbook generator (DESIGN.md §2.10.5 "Classic sphere and capsule").
import { describe, expect, it } from 'vitest';
import { sphereSizing } from '../../gauge';
import { textbookCounts, textbookK } from '../classic';
import { rng, between } from './helpers/random';

describe('textbook counts', () => {
  it('k = max(1, round(2πr / 6wS))', () => {
    expect(textbookK(0.01, 0.2)).toBe(1);
    expect(textbookK((36 * 0.2) / (2 * Math.PI), 0.2)).toBe(6);
    // a tie (k = 2.5 on paper) rounds up
    expect(textbookK((15 * 0.2) / (2 * Math.PI), 0.2)).toBe(3);
  });

  it('closed sphere: rise, wall = round(3k·w/h) − 2k, fall; T + 1 = round(A/hS)', () => {
    const t = textbookCounts({ kind: 'sphere', r: 1.146, wS: 0.2, hS: 0.2 });
    expect(t.k).toBe(6);
    expect(t.wall).toBe(6);
    expect(t.counts).toHaveLength(17);
    expect(t.T).toBe(17);
    expect(t.closedEnd).toBe(true);
  });

  it('k = 1: one round of 6 and its plain rounds', () => {
    const t = textbookCounts({ kind: 'sphere', r: 0.1, wS: 0.2, hS: 0.2 });
    expect(t.k).toBe(1);
    // A/hS = 3k·w/h = 3 ⇒ T = max(1, 3 − 1) = 2 ⇒ wall 1
    expect(t.counts).toEqual([6, 6]);
  });

  it('agrees with the gauge kernel’s sphere sizing (§2.2.6) for k ≥ 2 on 2000 random balls', () => {
    const rand = rng(11);
    for (let i = 0; i < 2000; i++) {
      const w = between(rand, 0.1, 0.5);
      const cell = { w, h: w / between(rand, 0.9, 1.15) };
      const stretch = rand() < 0.5 ? 1 : 1.05;
      const D = between(rand, 0.5, 12);
      const s = sphereSizing(D, cell, stretch);
      const t = textbookCounts({ kind: 'sphere', r: D / 2, wS: cell.w * stretch, hS: cell.h * stretch });
      if (t.k < 2) continue;
      expect(t.k).toBe(s.k);
      expect(t.wall).toBe(s.plainRounds);
      expect(t.counts.length).toBe(s.rounds);
      expect(t.counts.reduce((a, b) => a + b, 0)).toBe(s.stitches);
    }
  });

  it('closed capsule: the straight part adds plain rounds', () => {
    const t = textbookCounts({ kind: 'capsule', r: 0.5, length: 3, wS: 0.2, hS: 0.2 });
    // k = round(π/1.2) = 3, r_eff = 0.573, A = 2 + 1.8 = 3.8, T = 18, wall = 13
    expect(t.k).toBe(3);
    expect(t.wall).toBe(13);
    expect(t.counts).toEqual([6, 12, 18, ...Array<number>(13).fill(18), 12, 6]);
  });

  it('open: increase phase, plain rounds up to R_end = round(s_end/hS), no decrease; R_end < k stops the rise', () => {
    const cup = textbookCounts({ kind: 'sphere', r: 1.146, wS: 0.2, hS: 0.2, open: {} });
    // s_end = π·r_eff/2 = 1.8 ⇒ R_end = 9
    expect(cup.rEnd).toBe(9);
    expect(cup.counts).toEqual([6, 12, 18, 24, 30, 36, 36, 36, 36]);
    const short = textbookCounts({ kind: 'sphere', r: 1.146, wS: 0.2, hS: 0.2, open: { sCut: 0.61 } });
    expect(short.counts).toEqual([6, 12, 18]);
    const tiny = textbookCounts({ kind: 'sphere', r: 1.146, wS: 0.2, hS: 0.2, open: { sCut: 0.01 } });
    expect(tiny.counts).toEqual([6]);
    expect(cup.closedEnd).toBe(false);
  });

  it('rejects broken input', () => {
    expect(() => textbookCounts({ kind: 'sphere', r: 0, wS: 0.2, hS: 0.2 })).toThrow(RangeError);
    expect(() => textbookCounts({ kind: 'sphere', r: 1, wS: Number.NaN, hS: 0.2 })).toThrow(RangeError);
  });
});
