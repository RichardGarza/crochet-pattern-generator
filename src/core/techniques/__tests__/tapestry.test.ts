import { describe, expect, it } from 'vitest';
import type { Hand, Line } from '../../../types';
import { roundHalfUp } from '../../gauge/round';
import { mulberry32 } from '../../kernel/prng';
import { notesFor } from '../../pattern/notes';
import { renderFoundation, renderLine } from '../../pattern/render';
import { roundLabels, roundShift, writeScTapestryRound } from '../scRound';
import { planTapestry, tapestryCueTexts, writeScTapestry } from '../tapestry';
import { inferRoundLean, rotationsOf, validate2D, validateDoc2D } from '../validate2d';
import { chartOf, loadChartResult, randomChart } from './fixtures';

const us = (line: Line): string => renderLine(line, { dialect: 'compact', terms: 'us', hand: 'right' });
const errors = <T extends { severity: string }>(xs: T[]): T[] => xs.filter((x) => x.severity === 'error');
const CODE = 'ABCDEFGH';
const code = (label: number): string => CODE[label];

describe('tapestry plan (DESIGN §2.7.4): join, carry, cut', () => {
  it('a color is joined at the start of the first line that needs it; every held color is carried', () => {
    // Lines in working order: A A A A / A B A A / A B C A
    const plan = planTapestry([Uint8Array.of(0, 0, 0, 0), Uint8Array.of(0, 1, 0, 0), Uint8Array.of(0, 1, 2, 0)], 3);
    expect(plan.lines.map((l) => tapestryCueTexts(l, code))).toEqual([[], ['join B', 'carry A, B'], ['join C', 'carry A, B, C']]);
    expect(plan.startsPerColor).toEqual([1, 1, 1]);
    // Carried stitches: line 2 A over 1, B over 3; line 3 A over 2, B over 3, C over 3.
    expect(plan.carriedPerColor).toEqual([3, 6, 3]);
  });

  it('a color absent from the next 2 lines is cut at the end of the line; absent from 1 it is carried through', () => {
    const seqs = [Uint8Array.of(0, 1), Uint8Array.of(0, 0), Uint8Array.of(0, 1), Uint8Array.of(0, 0), Uint8Array.of(0, 0), Uint8Array.of(1, 1)];
    const plan = planTapestry(seqs, 2);
    const cues = plan.lines.map((l) => tapestryCueTexts(l, code));
    expect(cues).toEqual([
      ['join B', 'carry A, B'],
      ['carry B'], // B is not used in line 2 but comes back in line 3: carried through the whole line
      ['carry A, B', 'cut B'], // absent from lines 4 and 5: cut at the end of line 3
      [],
      ['cut A'], // the only line left does not use A
      ['join B'], // B is joined again
    ]);
    expect(plan.startsPerColor).toEqual([1, 2]);
    // Line 2: B carried across 2 sts; line 6: A held, carried across 2 sts.
    expect(plan.carriedPerColor[1]).toBe(1 + 2 + 1);
  });

  it('the last line cuts nothing in the cues; the foundation color is not joined', () => {
    // B starts (foundation); A is joined, then cut since the only line left does not use it.
    const plan = planTapestry([Uint8Array.of(1, 0), Uint8Array.of(1, 1)], 2);
    expect(plan.lines.map((l) => tapestryCueTexts(l, code))).toEqual([['join A', 'carry B, A', 'cut A'], []]);
    const last = planTapestry([Uint8Array.of(0, 1), Uint8Array.of(0, 1)], 2);
    expect(last.lines.map((l) => tapestryCueTexts(l, code))).toEqual([['join B', 'carry A, B'], ['carry A, B']]);
  });
});

describe('sc_tapestry writer (§2.7.4)', () => {
  it('G9 chart: the §2.7.3 rows, tapestry cues listing the carried colors', () => {
    const { lines } = writeScTapestry(loadChartResult('g9').grid, { hand: 'right' });
    expect(lines.map(us)).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B · carry A, B',
      'Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts) · carry A, B',
      'Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts) · carry A, B',
    ]);
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Foundation: With A, ch 6.');
    expect(renderLine(lines[0], { dialect: 'verbose', terms: 'uk', hand: 'right' })).toBe(
      'Row 1 (RS) ←: With A, dc in 2nd ch from hook and in next ch; change to B, dc in next ch; change to A, dc in last 2 ch. (5 dc) · join B · carry A, B',
    );
  });

  it('every line lists exactly the colors carried in it (a held color with a stitch of another color)', () => {
    const rng = mulberry32(11);
    for (let t = 0; t < 40; t++) {
      const grid = randomChart(rng, 1 + Math.floor(rng() * 20), 1 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 4));
      for (const hand of ['right', 'left'] as Hand[]) {
        const { rows, plan } = writeScTapestry(grid, { hand, fold: false });
        rows.forEach((row, k) => {
          const carry = (row.cues ?? []).map((c) => c.text).find((x) => x.startsWith('carry '));
          const listed = carry === undefined ? [] : carry.slice(6).split(', ');
          const used = new Set(row.ops.map((op) => op.color));
          const held = plan.lines[k].held.map((l) => grid.palette[l].code);
          const want = held.filter((c) => !(used.size === 1 && used.has(c)));
          expect(new Set(listed)).toEqual(new Set(held.length >= 2 ? want : []));
          // Every color worked in the row is held.
          for (const c of used) expect(held).toContain(c);
        });
        expect(errors(validate2D({ chart: grid, technique: 'sc_tapestry', hand, lines: writeScTapestry(grid, { hand }).lines }))).toEqual([]);
      }
    }
  });

  it('E_FOLD compares tapestry cues; cue parsing reads join / carry / cut', () => {
    const grid = chartOf(['AAA', 'ABA', 'AAA', 'AAA', 'AAA']);
    const rows = structuredClone(writeScTapestry(grid, { hand: 'right', fold: false }).rows);
    // Rows 3–5 fold only if their cues match; Row 4 (after B) carries B… Row 4's cue differs from Row 5's.
    const bad: Line[] = [rows[0], rows[1], rows[2], { ...rows[3], nEnd: 5, side: undefined, arrow: undefined }];
    expect(validate2D({ chart: grid, technique: 'sc_tapestry', hand: 'right', lines: bad }).map((x) => x.code)).toContain('E_FOLD');
    const cut = structuredClone(rows);
    cut[1].cues = [{ kind: 'color', text: 'cut Q' }];
    expect(validate2D({ chart: grid, technique: 'sc_tapestry', hand: 'right', lines: cut }).map((x) => x.code)).toContain('E_COLOR');
  });
});

describe('sc_tapestry_round writer (§2.7.5)', () => {
  const tube = chartOf(['ABCDEF', 'AABBCC', 'ABCDEF', 'AAAAAA', 'BBBBBB', 'ABCDEF', 'AABBCC', 'ABCDEF']);

  it('ring foundation, joined rounds, every round RS ← (RH) / → (LH), carried colors', () => {
    const g = chartOf(['AB', 'AA']);
    const { lines } = writeScTapestryRound(g, { hand: 'right' });
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Foundation: With A, ch 2; join with sl st in first ch to form a ring (do not twist).');
    expect(lines.map(us)).toEqual([
      'Rnd 1 (RS) ←: Ch 1 (does not count as a st), 2 sc A; join with sl st in first sc. (2 sts)',
      'Rnd 2 (RS) ←: Ch 1, sc B, sc A; join with sl st in first sc. (2 sts) · join B · carry B, A',
    ]);
    expect(writeScTapestryRound(g, { hand: 'left' }).lines.map((l) => `${l.side} ${l.arrow}`)).toEqual(['RS →', 'RS →']);
  });

  it('preskew: round k is shifted by round(0.5·(k − 1)) sts in the working direction; every E_* stays green', () => {
    for (const hand of ['right', 'left'] as Hand[]) {
      const plain = writeScTapestryRound(tube, { hand, roundLean: { mode: 'note', stPerRnd: 0.5 }, fold: false });
      const skew = writeScTapestryRound(tube, { hand, roundLean: { mode: 'preskew', stPerRnd: 0.5 }, fold: false });
      for (let k = 1; k <= tube.rows; k++) {
        const s = roundHalfUp(0.5 * (k - 1));
        expect(roundShift(k, { mode: 'preskew', stPerRnd: 0.5 })).toBe(s);
        const a = plain.rounds[k - 1].ops;
        const b = skew.rounds[k - 1].ops;
        // b[i] = a[i − s]: the stitch at working position i takes the color the unskewed round has s sts earlier.
        for (let i = 0; i < a.length; i++) expect(b[i]).toEqual(a[(i - s + a.length) % a.length]);
        expect(skew.rounds[k - 1].side).toBe('RS');
      }
      const lines = writeScTapestryRound(tube, { hand, roundLean: { mode: 'preskew', stPerRnd: 0.5 } }).lines;
      expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand, lines, roundLean: { mode: 'preskew', stPerRnd: 0.5 } })).toEqual([]);
      // Validated as if not pre-skewed, the shifted rounds are not their chart rows.
      expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand, lines, roundLean: { mode: 'note', stPerRnd: 0.5 } }).map((x) => x.code)).toContain('E_RUN_SUM');
      // Without the setting (validateDoc2D on an exported doc) the shift is read from the rounds.
      expect(inferRoundLean(tube, hand, lines).mode).toBe('preskew');
      expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand, lines })).toEqual([]);
    }
  });

  it('preskew with a calibrated rate (0.3, −0.5) and many rounds; random charts stay green', () => {
    const rng = mulberry32(5);
    for (let t = 0; t < 30; t++) {
      const grid = randomChart(rng, 3 + Math.floor(rng() * 30), 2 + Math.floor(rng() * 40), 1 + Math.floor(rng() * 4));
      for (const stPerRnd of [0.5, 0.3, -0.5, 1.25]) {
        for (const hand of ['right', 'left'] as Hand[]) {
          const lean = { mode: 'preskew' as const, stPerRnd };
          const { lines } = writeScTapestryRound(grid, { hand, roundLean: lean });
          const found = validate2D({ chart: grid, technique: 'sc_tapestry_round', hand, lines, roundLean: lean }).filter((x) => x.severity === 'error');
          if (found.length > 0) console.log(grid.cols, grid.rows, stPerRnd, hand, found.slice(0, 2));
          expect(found).toEqual([]);
          expect(validate2D({ chart: grid, technique: 'sc_tapestry_round', hand, lines }).filter((x) => x.severity === 'error')).toEqual([]);
        }
      }
    }
  });

  it('turn: from Rnd 2 every round is turned; even rounds are WS and read in the opposite direction', () => {
    const lean = { mode: 'turn' as const, stPerRnd: 0.5 };
    const { lines } = writeScTapestryRound(tube, { hand: 'right', roundLean: lean });
    expect(lines).toHaveLength(tube.rows); // turned rounds are never folded
    expect(lines.map((l) => `${l.side} ${l.arrow} ${l.start?.k}`)).toEqual(['RS ← chainRing', 'WS → turn', 'RS ← turn', 'WS → turn', 'RS ← turn', 'WS → turn', 'RS ← turn', 'WS → turn']);
    expect(us(lines[1])).toBe('Rnd 2 (WS) →: Ch 1, turn. 2 sc A, 2 sc B, 2 sc C; join with sl st in first sc. (6 sts) · carry A, B, C, D, E, F');
    // WS rounds read left → right (RH): chart row "AABBCC" from the left.
    expect(Array.from(roundLabels(tube, 2, 'right', lean))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(Array.from(roundLabels(tube, 3, 'right', lean))).toEqual([5, 4, 3, 2, 1, 0]);
    expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand: 'right', lines, roundLean: lean })).toEqual([]);
    expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand: 'right', lines })).toEqual([]);
    expect(inferRoundLean(tube, 'right', lines).mode).toBe('turn');
  });

  it('note: the Notes print the expected drift round(0.5·(R − 1)) and its direction', () => {
    expect(notesFor('tapestry-round', { terms: 'us', hand: 'right', roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 8 }).join(' ')).toContain(
      'expect the design to shift about 4 sts to the right between Rnd 1 and Rnd 8',
    );
    expect(notesFor('tapestry-round', { terms: 'us', hand: 'left', roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 61 }).join(' ')).toContain('about 30 sts to the left between Rnd 1 and Rnd 61');
  });

  it('identical rounds fold keeping side and arrow; E_FOLD fires on a fold over different rounds', () => {
    const grid = chartOf(['AB', 'AB', 'AB', 'AA']);
    const { lines } = writeScTapestryRound(grid, { hand: 'right' });
    expect(lines.map(us)).toEqual([
      'Rnd 1 (RS) ←: Ch 1 (does not count as a st), 2 sc A; join with sl st in first sc. (2 sts)',
      'Rnd 2 (RS) ←: Ch 1, sc B, sc A; join with sl st in first sc. (2 sts) · join B · carry B, A',
      'Rnds 3–4 (RS, 2 rnds) ←: Ch 1, sc B, sc A; join with sl st in first sc. (2 sts) · carry B, A',
    ]);
    expect(validate2D({ chart: grid, technique: 'sc_tapestry_round', hand: 'right', lines })).toEqual([]);
    const grid2 = chartOf(['BA', 'AB', 'AB', 'AA']);
    const bad: Line[] = [...lines.slice(0, 2), { ...lines[2] }];
    // (With the lean given: on a 2-st tube, BA is AB shifted by one, so an inferred pre-skew could explain it.)
    expect(validate2D({ chart: grid2, technique: 'sc_tapestry_round', hand: 'right', lines: bad, roundLean: { mode: 'note', stPerRnd: 0.5 } }).map((x) => x.message)).toContain('Rnds 3–4: Rnd 4 of the chart is not this round');
  });

  it('E_FOUNDATION and E_RUN_SUM on crafted rounds', () => {
    const { lines } = writeScTapestryRound(tube, { hand: 'right', fold: false });
    const ring = structuredClone(lines);
    ring[0].start = { k: 'chainRing', chains: 7 };
    const codes = validate2D({ chart: tube, technique: 'sc_tapestry_round', hand: 'right', lines: ring, roundLean: { mode: 'note', stPerRnd: 0.5 } }).map((x) => x.code);
    expect(codes).toContain('E_FOUNDATION');
    const missing = structuredClone(lines).filter((l) => l.n !== 5);
    missing[4].prevCount = 6;
    expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand: 'right', lines: missing, roundLean: { mode: 'note', stPerRnd: 0.5 } }).map((x) => x.message)).toContain(
      'Rnd 5 is missing: every row of the chart must be worked (0 ≠ 6)',
    );
    const side = structuredClone(lines);
    side[2].side = 'WS';
    expect(validate2D({ chart: tube, technique: 'sc_tapestry_round', hand: 'right', lines: side, roundLean: { mode: 'note', stPerRnd: 0.5 } }).map((x) => x.code)).toContain('E_RUN_SUM');
  });

  it('rotationsOf finds every shift (KMP), including periodic rows', () => {
    expect(rotationsOf([0, 1, 2, 3], [3, 0, 1, 2])).toEqual([1]);
    expect(rotationsOf([0, 1, 0, 1], [1, 0, 1, 0])).toEqual([1, 3]);
    expect(rotationsOf([0, 0, 0], [0, 0, 0])).toEqual([0, 1, 2]);
    expect(rotationsOf([0, 1], [1, 1])).toEqual([]);
  });

  it('validateDoc2D: a built tube with preskew passes without the settings', () => {
    const { lines } = writeScTapestryRound(tube, { hand: 'left', roundLean: { mode: 'preskew', stPerRnd: 0.5 } });
    const doc = {
      kind: '2d',
      hand: 'left',
      materials: [],
      chart: { grid: tube, cell: { w: 0.3, h: 0.3 }, technique: 'sc_tapestry_round' },
      pieces: [{ id: 'panel', title: 'Tube', makeCount: 1, partIds: [], intro: [], lines, finish: { kind: 'open', tailIn: 6, text: '' } }],
    } as never;
    expect(validateDoc2D(doc)).toEqual([]);
  });
});
