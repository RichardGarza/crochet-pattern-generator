import { describe, expect, it } from 'vitest';
import type { ChartGrid, Issue, Line, PatternDoc } from '../../../types';
import { writeFlatRows, writeScGraphgan } from '../scFlat';
import { planStrands } from '../strands';
import { cueColors, validate2D, validateChart, validateDoc2D } from '../validate2d';
import { chartOf, loadChartResult } from './fixtures';

const g9 = loadChartResult('g9').grid;
const codes = (issues: Issue[]): string[] => issues.map((x) => x.code);
const errors = (issues: Issue[]): Issue[] => issues.filter((x) => x.severity === 'error');

function run(lines: Line[], chart: ChartGrid = g9, technique: 'sc_graphgan' | 'hdc_graphgan' | 'sc_tapestry' = 'sc_graphgan'): Issue[] {
  return validate2D({ chart, technique, hand: 'right', lines });
}

/** The G9 rows, fresh (callers change them). */
function g9Rows(): Line[] {
  return structuredClone(writeScGraphgan(g9, { hand: 'right' }).lines);
}

describe('2D validators fire on crafted bad input and stay silent on generated output (DESIGN §2.13)', () => {
  it('silent on G9 and the heart, both hands, folded or not', () => {
    for (const grid of [g9, loadChartResult('heart').grid]) {
      for (const hand of ['right', 'left'] as const) {
        for (const fold of [true, false]) {
          const { lines } = writeScGraphgan(grid, { hand, fold });
          expect(validate2D({ chart: grid, technique: 'sc_graphgan', hand, lines })).toEqual([]);
        }
      }
    }
  });

  it('E_RUN_SUM: a row 6 sts wide on a 5-wide chart, counts otherwise consistent', () => {
    const lines = g9Rows();
    // A sixth stitch everywhere, with every count and the foundation adjusted, so the line rules are satisfied.
    for (const line of lines) {
      line.ops.push({ k: 'st', st: 'sc', color: 'A' });
      line.stated = 6;
      if (line.prevCount !== null) line.prevCount = 6;
      line.cues = undefined;
    }
    lines[0].start = { k: 'foundation', chains: 7, firstInto: 2 };
    const issues = run(lines);
    expect(codes(issues)).toEqual(['E_RUN_SUM', 'E_RUN_SUM', 'E_RUN_SUM', 'E_FOUNDATION']);
    expect(issues[0].message).toBe('Row 1: its runs sum to 6 sts, but the chart is 5 wide (6 ≠ 5)');
    expect(issues[0].where).toEqual({ line: 1 });
  });

  it('E_RUN_SUM: a missing row, a repeated row, rows past the chart', () => {
    const missing = g9Rows();
    missing.splice(1, 1);
    missing[1].prevCount = 5;
    expect(codes(run(missing))).toContain('E_RUN_SUM');
    expect(run(missing).find((x) => x.code === 'E_RUN_SUM')?.message).toBe('Row 2 is missing: every row of the chart must be worked (0 ≠ 5)');
    const tail = g9Rows().slice(0, 2);
    expect(run(tail).map((x) => x.message)).toContain('Row 3 is missing: the chart has 3 rows (0 ≠ 5)');
    const extra = g9Rows();
    extra.push({ ...extra[2], n: 4, side: 'WS', arrow: '→' });
    expect(run(extra).map((x) => x.message)).toContain('the pattern has 4 rows but the chart only 3');
    const again = g9Rows();
    again.push({ ...again[2] });
    expect(run(again).map((x) => x.message)).toContain('Row 3 comes again after Row 3: the rows must cover the chart once, in order');
  });

  it('E_FOUNDATION: W + h_tc − c (sc W + 1 from the 2nd ch, hdc W + 2 from the 3rd)', () => {
    const shifted = g9Rows();
    shifted[0].start = { k: 'foundation', chains: 7, firstInto: 3 }; // works into 5 chains: the kernel is satisfied
    const issues = run(shifted);
    expect(codes(issues)).toEqual(['E_FOUNDATION']);
    expect(issues[0].message).toBe('Row 1: a 5-st sc chart needs ch 6 worked from the 2nd ch, not ch 7 from ch 3');
    // The kernel's single-line E_FOUNDATION is not reported twice.
    const short = g9Rows();
    short[0].start = { k: 'foundation', chains: 5, firstInto: 2 };
    expect(codes(run(short))).toEqual(['E_FOUNDATION']);
    // An hdc chart on an sc foundation.
    const hdc = structuredClone(writeFlatRows(g9, { hand: 'right', stitch: 'hdc' }).lines);
    expect(errors(run(hdc, g9, 'hdc_graphgan'))).toEqual([]);
    hdc[0].start = { k: 'foundation', chains: 6, firstInto: 2 };
    expect(codes(run(hdc, g9, 'hdc_graphgan'))).toEqual(['E_FOUNDATION']);
    // Row 1 without a foundation.
    const none = g9Rows();
    none[0].start = { k: 'turn', chains: 1 };
    none[0].prevCount = 5;
    expect(codes(run(none))).toContain('E_FOUNDATION');
  });

  it('E_COLOR: a stitch, a cue, a chart cell and a palette code', () => {
    const op = g9Rows();
    op[1].ops[2] = { k: 'st', st: 'sc', color: 'Z' };
    expect(codes(run(op))).toEqual(['E_COLOR']);
    const cue = g9Rows();
    cue[1].cues = [{ kind: 'color', text: 'join Q (bobbin 3)' }];
    expect(run(cue).map((x) => x.message)).toEqual(['Row 2: the cue “join Q (bobbin 3)” names color Q, which is not in the palette']);
    const carry = g9Rows();
    carry[1].cues = [{ kind: 'color', text: 'carry A, X' }];
    expect(codes(run(carry))).toEqual(['E_COLOR']);
    const cell: ChartGrid = { ...g9, labels: Uint8Array.from(g9.labels, (v, i) => (i === 7 ? 9 : v)) };
    const cellIssues = validateChart(cell);
    expect(cellIssues).toHaveLength(1);
    expect(cellIssues[0]).toMatchObject({ code: 'E_COLOR', where: { row: 1, col: 2 } });
    expect(cellIssues[0].message).toBe('1 chart cell has no palette color (first at row 2, column 3: label 9)');
    const dup: ChartGrid = { ...g9, palette: [g9.palette[0], { ...g9.palette[1], code: 'A' }] };
    expect(codes(validateChart(dup))).toEqual(['E_COLOR']);
    expect(cueColors('carry A, C')).toEqual(['A', 'C']);
    expect(cueColors('join B (bobbin 12)')).toEqual(['B']);
    expect(cueColors('change to B on the last yo')).toEqual([]);
    expect(cueColors('join  Z  (bobbin 1)')).toEqual(['Z']);
  });

  it('E_RUN_SUM: every row is its chart row in its own direction, with its side and arrow; E_FOUNDATION: the turning chain', () => {
    // Row 2 reversed and recolored, still 5 sts.
    const swapped = g9Rows();
    swapped[1].ops = [...swapped[1].ops].reverse().map((op) => ({ ...op, color: op.color === 'A' ? 'B' : 'A' }));
    expect(run(swapped).map((x) => [x.code, x.message])).toEqual([['E_RUN_SUM', 'Row 2: its runs are not chart row 2 read left to right (right-handed)']]);
    // Left-handed lines checked as a right-handed pattern: the mirrored rows are caught.
    const lh = writeScGraphgan(g9, { hand: 'left' }).lines;
    expect(codes(validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: lh }))).toContain('E_RUN_SUM');
    expect(validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'left', lines: lh })).toEqual([]);
    const side = g9Rows();
    side[1].side = 'RS';
    side[1].arrow = '←';
    expect(run(side).map((x) => x.message)).toEqual(['Row 2: it is a WS row read → (right-handed), not RS ←']);
    const chains = g9Rows();
    chains[2].start = { k: 'turn', chains: 3 };
    expect(run(chains).map((x) => [x.code, x.message])).toEqual([['E_FOUNDATION', 'Row 3: an sc row turns with ch 1 (does not count as a st), not ch 3']]);
  });

  it('E_SANITY: a chart round without side and arrow (it would print as an amigurumi round)', () => {
    const lines: Line[] = [
      { kind: 'rnd', n: 1, side: 'RS', arrow: '←', start: { k: 'chainRing', chains: 5 }, join: {}, ops: g9Rows()[0].ops, prevCount: null, stated: 5 },
      { kind: 'rnd', n: 2, start: { k: 'join' }, join: {}, ops: g9Rows()[1].ops, prevCount: 5, stated: 5 },
    ];
    const issues = validate2D({ chart: g9, technique: 'sc_tapestry_round', hand: 'right', lines });
    // (The round rules of T2.2 also report the rounds that are not the chart's; only the sanity finding matters here.)
    expect(issues.filter((x) => x.code === 'E_SANITY').map((x) => [x.code, x.message])).toEqual([['E_SANITY', 'Rnd 2: a round of a chart needs its side and reading arrow']]);
  });

  it('E_SANITY: the chart’s size, labels and palette', () => {
    expect(codes(validateChart({ ...g9, cols: 1001 }))).toEqual(['E_SANITY']);
    expect(codes(validateChart({ ...g9, rows: 0 }))).toEqual(['E_SANITY']);
    expect(codes(validateChart({ ...g9, cols: 2.5 }))).toEqual(['E_SANITY']);
    expect(codes(validateChart({ ...g9, labels: new Uint8Array(14) }))).toEqual(['E_SANITY']);
    expect(codes(validateChart({ ...g9, palette: [] }))).toEqual(['E_SANITY']);
    expect(codes(validate2D({ chart: { ...g9, rows: 2000 }, technique: 'sc_graphgan', hand: 'right', lines: g9Rows() }))).toEqual(['E_SANITY']);
    expect(validateChart({ cols: 1000, rows: 1, labels: new Uint8Array(1000), palette: g9.palette })).toEqual([]);
    const nullEntry = { ...g9, palette: [g9.palette[0], null] } as unknown as ChartGrid;
    expect(codes(validateChart(nullEntry))).toEqual(['E_SANITY']);
    expect(codes(validate2D({ chart: nullEntry, technique: 'sc_graphgan', hand: 'right', lines: g9Rows() }))).toEqual(['E_SANITY']);
    expect(() => writeScGraphgan(nullEntry, { hand: 'right' })).not.toThrow();
    expect(codes(validate2D(null as unknown as Parameters<typeof validate2D>[0]))).toEqual(['E_SANITY']);
  });

  it('E_FOLD: a fold over rows that differ, with a side, of a non-palindrome, or of Row 1', () => {
    const chart = chartOf(['AAAAA', 'AABAA', 'AABAA', 'AAAAA']);
    const ok = writeScGraphgan(chart, { hand: 'right' }).lines;
    expect(validate2D({ chart, technique: 'sc_graphgan', hand: 'right', lines: ok })).toEqual([]);
    const rows = structuredClone(writeScGraphgan(chart, { hand: 'right', fold: false }).lines);
    // Rows 3 and 4 differ (Row 4 is plain A): folding them is wrong.
    const bad: Line[] = [rows[0], rows[1], { ...rows[2], nEnd: 4, side: undefined, arrow: undefined }];
    const issues = run(bad, chart).filter((x) => x.code === 'E_FOLD');
    expect(issues.map((x) => x.message)).toEqual(['Rows 3–4: Row 4 of the chart is not this row']);
    const sided: Line[] = [rows[0], rows[1], { ...rows[2], nEnd: 3 }, rows[3]];
    expect(run(sided, chart)).toEqual([]); // nEnd = n is a plain line
    const sided2 = structuredClone(writeScGraphgan(chartOf(['AAAAA', 'AAAAA', 'AAAAA']), { hand: 'right', fold: false }).lines);
    const keptSide: Line[] = [sided2[0], { ...sided2[1], nEnd: 3 }];
    expect(run(keptSide, chartOf(['AAAAA', 'AAAAA', 'AAAAA'])).map((x) => x.message)).toEqual(['Rows 2–3: a fold covers both sides, so it has no side and no arrow']);
    const mirror = chartOf(['ABB', 'BBA', 'ABB']);
    const m = structuredClone(writeScGraphgan(mirror, { hand: 'right', fold: false, cues: false }).lines);
    const mFold: Line[] = [m[0], { ...m[1], nEnd: 3, side: undefined, arrow: undefined }];
    expect(run(mFold, mirror).filter((x) => x.code === 'E_FOLD').map((x) => x.message)).toEqual([
      'Rows 2–3: only a row that reads the same in both directions can be folded',
    ]);
    const first = structuredClone(writeScGraphgan(chartOf(['AAA', 'AAA']), { hand: 'right', fold: false }).lines);
    const fFold: Line[] = [{ ...first[0], nEnd: 2, side: undefined, arrow: undefined }];
    expect(codes(run(fFold, chartOf(['AAA', 'AAA'])))).toContain('E_SANITY'); // the kernel refuses a folded first line
  });

  it('E_FOLD also compares cues row by row', () => {
    const chart = chartOf(['AABAA', 'AABAA', 'AABAA', 'AAAAA']);
    const rows = structuredClone(writeScGraphgan(chart, { hand: 'right', fold: false }).lines);
    // Row 2 joins B; Rows 3–4 only carry A. A fold of 2–4 with Row 3's cues hides the join.
    const bad: Line[] = [rows[0], { ...rows[2], n: 2, nEnd: 4, side: undefined, arrow: undefined }];
    expect(run(bad, chart).filter((x) => x.code === 'E_FOLD').map((x) => x.message)).toEqual(['Rows 2–4: Row 2 has other cues (join B (bobbin 1) · carry A)']);
  });

  it('without strand cues (writer option), folds are judged by ops alone', () => {
    const chart = chartOf(['AABAA', 'AABAA', 'AABAA', 'AAAAA']);
    const lines = writeScGraphgan(chart, { hand: 'right', cues: false }).lines;
    expect(lines.map((line) => [line.n, line.nEnd ?? line.n])).toEqual([
      [1, 1],
      [2, 4],
    ]);
    expect(validate2D({ chart, technique: 'sc_graphgan', hand: 'right', lines })).toEqual([]);
  });

  it('W_ROW_COLORS (> 6 strands in a row) and W_LONG_CARRY (> 8)', () => {
    const chart = chartOf(['ABCDEFGA']);
    const issues = validate2D({ chart, technique: 'sc_graphgan', hand: 'right', lines: writeScGraphgan(chart, { hand: 'right' }).lines });
    expect(issues.map((x) => [x.code, x.severity])).toEqual([['W_ROW_COLORS', 'warn']]);
    expect(issues[0].message).toBe('Row 1: 7 strands are worked in this row (more than 6); consider merging small areas');
    const wide = chartOf([`A${'B'.repeat(10)}A`]);
    const plan = planStrands(wide, { hand: 'right', carryMax: 20 });
    const lines = writeScGraphgan(wide, { hand: 'right', plan }).lines;
    const long = validate2D({ chart: wide, technique: 'sc_graphgan', hand: 'right', lines, plan });
    expect(long.map((x) => x.code)).toEqual(['W_LONG_CARRY']);
    expect(long[0]).toMatchObject({ severity: 'warn', where: { line: 1, row: 0, col: 1 } });
    // Tapestry carries every color on purpose.
    expect(validate2D({ chart: wide, technique: 'sc_tapestry', hand: 'right', lines, plan }).map((x) => x.code)).toEqual([]);
  });

  it('the line rules of Step 0 run too (E_CONSUME, E_PRODUCE) with the piece id', () => {
    const lines = g9Rows();
    lines[2].stated = 4;
    const issues = validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines, piece: 'panel' });
    expect(codes(issues)).toEqual(['E_PRODUCE']);
    expect(issues[0].where).toEqual({ piece: 'panel', line: 3 });
  });

  it('never throws on garbage', () => {
    const garbage = [null, 7, 'row', { kind: 'row', n: 'x', ops: [{ k: 'st', st: 'tr' }] }, { kind: 'row', n: 2, ops: null }] as unknown as Line[];
    expect(() => validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: garbage })).not.toThrow();
    expect(codes(validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: garbage }))).toContain('E_SANITY');
    expect(() => validate2D({ chart: null as unknown as ChartGrid, technique: 'sc_graphgan', hand: 'right', lines: [] })).not.toThrow();
    expect(() => validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: null as unknown as Line[] })).not.toThrow();
  });

  it('validateDoc2D runs every piece of a 2D pattern; a 3D pattern has nothing to check here', () => {
    const lines = g9Rows();
    lines[1].ops[0] = { k: 'st', st: 'sc', color: 'Z' };
    const doc = {
      kind: '2d',
      hand: 'right',
      chart: { grid: g9, cell: { w: 0.3, h: 0.25 }, technique: 'sc_graphgan' },
      pieces: [{ id: 'panel', title: 'Panel', makeCount: 1, partIds: [], intro: [], lines, finish: { kind: 'open', tailIn: 6, text: '' } }],
    } as unknown as PatternDoc;
    expect(validateDoc2D(doc).map((x) => [x.code, x.where?.piece])).toEqual([['E_COLOR', 'panel']]);
    expect(validateDoc2D({ ...doc, kind: '3d' })).toEqual([]);
  });
});
