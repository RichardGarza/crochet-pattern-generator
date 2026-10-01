import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../kernel/prng';
import { CARRY_MAX, planStrands, readsRightToLeft, rowCueTexts, rowRuns } from '../strands';
import { chartOf, loadChartResult, randomChart } from './fixtures';

const codes = 'ABCDEFGH';
const code = (label: number): string => codes[label];

describe('reading order (DESIGN §2.7.2)', () => {
  it('RH: odd rows right → left, even rows left → right; LH mirrored', () => {
    expect([1, 2, 3, 4].map((k) => readsRightToLeft(k, 'right'))).toEqual([true, false, true, false]);
    expect([1, 2, 3, 4].map((k) => readsRightToLeft(k, 'left'))).toEqual([false, true, false, true]);
  });
  it('rowRuns: maximal runs, left to right', () => {
    expect(rowRuns(chartOf(['AABBBA']), 0)).toEqual([
      { label: 0, x0: 0, x1: 1 },
      { label: 1, x0: 2, x1: 4 },
      { label: 0, x0: 5, x1: 5 },
    ]);
  });
});

describe('carry vs bobbin (DESIGN §2.7.3)', () => {
  it('a color absent for ≤ 8 stitches is carried; for 9 it gets a second bobbin', () => {
    const carried = planStrands(chartOf([`A${'B'.repeat(CARRY_MAX)}A`]), { hand: 'right' });
    expect(carried.rows[0].segments.map((s) => [code(s.label), s.x0, s.x1, s.carried, s.bobbin, s.joined])).toEqual([
      ['A', 0, 9, 8, 1, false],
      ['B', 1, 8, 0, 1, true],
    ]);
    expect(rowCueTexts(carried.rows[0], code)).toEqual(['join B (bobbin 1)', 'carry A']);
    const split = planStrands(chartOf([`A${'B'.repeat(CARRY_MAX + 1)}A`]), { hand: 'right' });
    expect(split.rows[0].segments.map((s) => [code(s.label), s.bobbin, s.joined])).toEqual([
      ['A', 1, false],
      ['B', 1, true],
      ['A', 2, true],
    ]);
    expect(rowCueTexts(split.rows[0], code)).toEqual(['join B (bobbin 1)', 'join A (bobbin 2)']);
    expect(split.strandsPerColor).toEqual([2, 1]);
  });

  it('a run continues a strand of the row before when they overlap within 2 stitches', () => {
    // Worked from the bottom: Row 1 = 'BAAAAAAAAAAAAAA' (B at x 0), Row 2 = B at x 2 (reach 2: continues),
    // Row 3 = B at x 5 (3 away: a new strand; the old one ends, so its bobbin number 1 is free again).
    const plan = planStrands(chartOf(['AAAAABAAAAAAAAA', 'AABAAAAAAAAAAAA', 'BAAAAAAAAAAAAAA']), { hand: 'right' });
    const bOf = (k: number) => plan.rows[k - 1].segments.find((s) => s.label === 1)!;
    expect([bOf(1).bobbin, bOf(1).joined]).toEqual([1, true]);
    expect([bOf(2).bobbin, bOf(2).joined]).toEqual([1, false]);
    expect([bOf(3).bobbin, bOf(3).joined]).toEqual([1, true]);
    expect(bOf(3).strand).not.toBe(bOf(2).strand);
    expect(plan.strandsPerColor[1]).toBe(2);
    expect(plan.bobbinsPerColor[1]).toBe(1);
  });

  it('a strand continues at most once: a split region needs a new bobbin, a merge ends one', () => {
    // Row 1: one B area 0–9; Row 2: two B areas far apart (gap 10); Row 3: one again.
    const plan = planStrands(chartOf(['BBBBBBBBBBBBBBBBBBBBBB', 'BBBBBAAAAAAAAAAAABBBBB', 'BBBBBBBBBBBBBBBBBBBBBB']), { hand: 'right' });
    const row2 = plan.rows[1].segments.filter((s) => s.label === 1);
    expect(row2.map((s) => s.joined).sort()).toEqual([false, true]);
    const row3 = plan.rows[2].segments.filter((s) => s.label === 1);
    expect(row3).toHaveLength(1);
    expect(row3[0].joined).toBe(false);
    expect(plan.strandsPerColor[1]).toBe(2);
    expect(plan.bobbinsPerColor[1]).toBe(2);
  });

  it('a strand that ends frees its bobbin number for the next new strand of that color', () => {
    // B at the far left (Rows 1–2), nothing (Row 3), then B far right (Row 4): one bobbin, two strands.
    const plan = planStrands(chartOf(['AAAAAAAAAAAAB', 'AAAAAAAAAAAAA', 'BAAAAAAAAAAAA', 'BAAAAAAAAAAAA']), { hand: 'right' });
    expect(rowCueTexts(plan.rows[0], code)).toEqual(['join B (bobbin 1)']);
    expect(rowCueTexts(plan.rows[3], code)).toEqual(['join B (bobbin 1)']);
    expect([plan.strandsPerColor[1], plan.bobbinsPerColor[1]]).toEqual([2, 1]);
  });

  it('Row 1’s first segment is the foundation strand, not a join', () => {
    const plan = planStrands(chartOf(['ABBA']), { hand: 'left' });
    expect(plan.rows[0].segments[0]).toMatchObject({ label: 0, joined: false, bobbin: 1 });
  });

  it('the heart fixture: counts per color, max strands per row, cues in working order', () => {
    const grid = loadChartResult('heart').grid;
    const plan = planStrands(grid, { hand: 'right' });
    expect(plan.strandsPerColor.reduce((a, b) => a + b, 0)).toBe(plan.strands);
    expect(plan.maxPerRow).toBeLessThanOrEqual(9);
    // Every segment's runs are its color, and its gaps lie between them.
    for (const row of plan.rows) {
      for (const seg of row.segments) {
        for (const run of seg.runs) for (let x = run.x0; x <= run.x1; x++) expect(grid.labels[row.r * grid.cols + x]).toBe(seg.label);
        expect(seg.carried).toBe(seg.gaps.reduce((sum, g) => sum + g.x1 - g.x0 + 1, 0));
        for (const g of seg.gaps) expect(g.x1 - g.x0 + 1).toBeLessThanOrEqual(CARRY_MAX);
      }
    }
  });
});

describe('invariants on random charts', () => {
  it('every cell belongs to one segment; strands continue from the row before; bobbin numbers are the lowest free; joins = strands', { timeout: 60_000 }, () => {
    const rng = mulberry32(77);
    for (let t = 0; t < 200; t++) {
      const grid = randomChart(rng, 1 + Math.floor(rng() * 50), 1 + Math.floor(rng() * 20), 1 + Math.floor(rng() * 7));
      for (const hand of ['right', 'left'] as const) {
        const plan = planStrands(grid, { hand });
        let joins = 0;
        const seen = grid.palette.map(() => 0);
        const maxBobbin = grid.palette.map(() => 0);
        let previous = new Set<number>();
        for (const row of plan.rows) {
          const covered = new Array<number>(grid.cols).fill(0);
          const numbers = new Set<string>();
          const strandsHere = new Set<number>();
          for (const seg of row.segments) {
            for (const run of seg.runs) for (let x = run.x0; x <= run.x1; x++) covered[x]++;
            const key = `${seg.label}:${seg.bobbin}`;
            expect(numbers.has(key)).toBe(false); // one strand per bobbin number and color in a row
            numbers.add(key);
            expect(strandsHere.has(seg.strand)).toBe(false);
            strandsHere.add(seg.strand);
            if (!seg.joined && !(row.k === 1 && seg === row.segments[0])) expect(previous.has(seg.strand)).toBe(true);
            if (seg.joined || (row.k === 1 && seg === row.segments[0])) seen[seg.label]++;
            if (seg.joined) joins++;
            maxBobbin[seg.label] = Math.max(maxBobbin[seg.label], seg.bobbin);
          }
          // A new strand takes the lowest free number.
          for (const seg of row.segments) {
            if (!seg.joined) continue;
            for (let b = 1; b < seg.bobbin; b++) expect(numbers.has(`${seg.label}:${b}`)).toBe(true);
          }
          expect(covered.every((c) => c === 1)).toBe(true);
          // Working order: by where each segment starts in the row's direction.
          const starts = row.segments.map((s) => (row.rightToLeft ? -s.x1 : s.x0));
          expect([...starts].sort((a, b) => a - b)).toEqual(starts);
          previous = strandsHere;
        }
        expect(joins + 1).toBe(plan.strands);
        expect(maxBobbin).toEqual(plan.bobbinsPerColor);
        expect(seen).toEqual(plan.strandsPerColor);
      }
    }
  });
});
