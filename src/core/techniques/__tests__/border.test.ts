import { describe, expect, it } from 'vitest';
import type { ChartGrid, Hand, Line, ResolvedGauge } from '../../../types';
import { resolveGauge } from '../../gauge';
import { renderFoundation, renderLine, renderLineWith } from '../../pattern/render';
import { abbreviationsFor } from '../../pattern/terminology';
import { borderSides, planBorder, renderBorderLines, spacingHint, validateBorder, writeBorder } from '../border';
import { buildPattern2DWith } from '../index';
import { validate2D } from '../validate2d';
import { chartOf, loadChartResult, settingsOf } from './fixtures';

const g9 = loadChartResult('g9').grid;
const sc = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
const c2c = resolveGauge({ cyc: 4, technique: 'c2c' });
const FINISH = 'Fasten off and weave in ends.';

/** The printed border of the G9 chart (G22), via buildPattern2D. */
function g22(hand: Hand, color: string, technique: 'sc_graphgan' | 'c2c' = 'sc_graphgan'): { text: string[]; lines: Line[]; errors: string[] } {
  const gauge = technique === 'c2c' ? c2c : sc;
  const hex = g9.palette.find((p) => p.code === color)!.hex;
  const { doc } = buildPattern2DWith({ chart: g9, settings: settingsOf({ technique, hand, border: { widthIn: 0.25, color: { hex } } }), gauge, terms: 'us', dialect: 'compact', title: 'G22' });
  const lines = doc.pieces[0].lines.filter((l) => l.kind === 'border');
  const text = [...renderBorderLines(lines, { terms: 'us', hand, technique, rows: g9.rows, cols: g9.cols }), doc.pieces[0].finish.text];
  return { text, lines, errors: doc.issues.filter((x) => x.severity === 'error').map((x) => x.message) };
}

describe('border (DESIGN §2.7.10)', () => {
  it('G22 RH, border B: Row 3 is RS and ends in B at the top left, so the round continues ("Do not turn")', () => {
    const { text, errors, lines } = g22('right', 'B');
    expect(text).toEqual([
      'Border (with B):',
      'Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top left corner); working down the row ends of the left side, 1 sc evenly spaced (about 1 sc per 3 row ends); 3 sc in the corner loop of the foundation ch (bottom left); sc in each free loop across to the last loop (3 sc); 3 sc in the last loop (bottom right corner); working up the row ends of the right side, 1 sc evenly spaced; 3 sc in the top right corner st; sc in each st across the top to the last st (3 sc); join with sl st in first sc. (20 sts)',
      FINISH,
    ]);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].stated).toBe(20);
  });

  it('G22 LH, border A: the mirror image (LH Row 3 ends in A at the top right)', () => {
    const { text, errors } = g22('left', 'A');
    expect(text[1]).toBe(
      'Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top right corner); working down the row ends of the right side, 1 sc evenly spaced (about 1 sc per 3 row ends); 3 sc in the corner loop of the foundation ch (bottom right); sc in each free loop across to the last loop (3 sc); 3 sc in the last loop (bottom left corner); working up the row ends of the left side, 1 sc evenly spaced; 3 sc in the top left corner st; sc in each st across the top to the last st (3 sc); join with sl st in first sc. (20 sts)',
    );
    expect(errors).toEqual([]);
  });

  it('G22 RH, border A: the join opening at the top right corner', () => {
    const { text, errors } = g22('right', 'A');
    expect(text[1]).toBe(
      'Rnd 1 (RS): Fasten off. With RS facing, join A with a sl st in the top right corner st; ch 1 (does not count), 3 sc in same st (corner); sc in each st across the top to the last st (3 sc); 3 sc in the top left corner st; working down the row ends of the left side, 1 sc evenly spaced (about 1 sc per 3 row ends); 3 sc in the corner loop of the foundation ch (bottom left); sc in each free loop across to the last loop (3 sc); 3 sc in the last loop (bottom right corner); working up the row ends of the right side, 1 sc evenly spaced; join with sl st in first sc. (20 sts)',
    );
    expect(errors).toEqual([]);
  });

  it('G22 C2C 5 × 3, RH, start BR: always a join at the top right tile, S_top 13, S_side 8, 46 sts', () => {
    const { text, errors, lines } = g22('right', 'A', 'c2c');
    expect(borderSides('c2c', 5, 3, c2c)).toEqual({ sTop: 13, sSide: 8 });
    expect(text[1]).toBe(
      'Rnd 1 (RS): Fasten off. With RS facing, join A with a sl st in the outer corner of the top right tile; ch 1 (does not count), 3 sc in same sp (corner); working along the tile edges across the top, 11 sc evenly spaced (about 11 sc per 5 tile edges); 3 sc in the outer corner of the top left tile; working down the left side, 6 sc evenly spaced (2 sc in each tile edge); 3 sc in the outer corner of the bottom left tile; working along the tile edges across the bottom, 11 sc evenly spaced; 3 sc in the outer corner of the bottom right tile; working up the right side, 6 sc evenly spaced; join with sl st in first sc. (46 sts)',
    );
    expect(lines[0].stated).toBe(46);
    expect(errors).toEqual([]);
    // Same color as the last tile: C2C still joins (its last tile is at the corner opposite the start).
    expect(g22('right', 'B', 'c2c').text[1]).toMatch(/^Rnd 1 \(RS\): Fasten off\. With RS facing, join B/);
  });

  it('G16: 135 × 200 sc, worsted, 1 in ⇒ 4 rounds of 612/620/628/636, 134.1 yd before buffer, 42.0 × 52.0 in', () => {
    const labels = new Uint8Array(135 * 200);
    for (let i = 0; i < labels.length; i++) labels[i] = Math.floor(i / 135) % 20 < 10 ? 0 : 1;
    const grid: ChartGrid = { cols: 135, rows: 200, labels, palette: chartOf(['AB']).palette };
    // Row 200 is the top chart row (label 0 = A) and WS: it ends at the top right; border A continues.
    const build = buildPattern2DWith({ chart: grid, settings: settingsOf({ border: { widthIn: 1, color: { hex: grid.palette[0].hex } } }), gauge: sc, terms: 'us', dialect: 'compact', title: 'G16' });
    const plan = build.border!;
    expect([plan.rounds, plan.sTop, plan.sSide]).toEqual([4, 135, 169]);
    expect(plan.counts).toEqual([612, 620, 628, 636]);
    expect(plan.counts.reduce((a, b) => a + b, 0)).toBe(2496);
    const a = build.yardage.materials.findIndex((m) => m.code === 'A');
    const extra = build.yardage.parts[a].extra;
    expect(extra).toBeCloseTo(4826.2, 0);
    expect(Math.round((extra / 36) * 10) / 10).toBe(134.1);
    expect(build.doc.finishedSize.wIn).toBeCloseTo(42.0, 1);
    expect(build.doc.finishedSize.hIn).toBeCloseTo(52.0, 1);
    const text = renderBorderLines(build.doc.pieces[0].lines, { terms: 'us', hand: 'right', technique: 'sc_graphgan', rows: 200, cols: 135 });
    expect(text[1]).toMatch(/^Rnd 1 \(RS\): Turn so the RS faces you; ch 1 \(does not count\), 3 sc in the last st made \(top right corner\); sc in each st across the top to the last st \(133 sc\);/);
    expect(text[1]).toContain('working down the row ends of the left side, 167 sc evenly spaced (about 5 sc per 6 row ends)');
    expect(text[2]).toBe('Rnds 2–4: Ch 1 (does not count), sc in same st as join and in each st around, working 3 sc in each corner center st; join with sl st in first sc. (620, 628, 636 sts)');
    expect(build.doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('the line model: Rnd 1 starts at the edge with inc3 corners; later rounds join and put inc3 in each corner center', () => {
    const plan = planBorder({ technique: 'sc_graphgan', hand: 'right', cols: 5, rows: 3, gauge: sc, widthIn: 0.75, color: 'B', lastColor: 'B' })!;
    const lines = writeBorder(plan);
    expect(lines.map((l) => [l.n, l.start?.k, l.prevCount, l.stated])).toEqual([
      [1, 'edge', null, 20],
      [2, 'join', 20, 28],
      [3, 'join', 28, 36],
    ]);
    expect(lines[0].ops.filter((op) => op.k === 'inc').length).toBe(4);
    expect(lines[1].ops.slice(0, 2)).toEqual([
      { k: 'st', st: 'sc', color: 'B' },
      { k: 'inc', n: 3, color: 'B' },
    ]);
    expect(lines[2].ops.slice(0, 3).map((op) => op.k)).toEqual(['st', 'st', 'inc']);
    // The kernel line rules hold (E_CONSUME on later rounds, Rnd 1 exempt).
    expect(validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: [...buildPattern2DWith({ chart: g9, settings: settingsOf(), gauge: sc, terms: 'us', dialect: 'compact', title: '' }).doc.pieces[0].lines, ...lines] }).filter((x) => x.severity === 'error')).toEqual([]);
    // renderLine prints a border line with the border sentences; renderFoundation prints its header; UK terms.
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Border (with B):');
    expect(renderLine(lines[1], { dialect: 'verbose', terms: 'uk', hand: 'right' })).toBe(
      'Rnd 2: Ch 1 (does not count), dc in same st as join and in each st around, working 3 dc in each corner center st; join with ss in first dc. (28 sts)',
    );
    expect(renderLineWith(lines[0], { dialect: 'compact', terms: 'us', hand: 'right' })).toMatch(/^Rnd 1 \(RS\): Do not turn; .* \(20 sts\)$/);
    const abbr = abbreviationsFor(lines, 'us').map((a) => a.abbr);
    expect(abbr).toEqual(expect.arrayContaining(['ch', 'RS', 'sc', 'sl st']));
    expect(abbr).not.toContain('inc3');
  });

  it('spacing hints: best a/b with b ≤ 6 within 4%', () => {
    expect(spacingHint(167, 200, 'row end')).toBe('about 5 sc per 6 row ends');
    expect(spacingHint(1, 3, 'row end')).toBe('about 1 sc per 3 row ends');
    expect(spacingHint(6, 3, 'tile edge')).toBe('2 sc in each tile edge');
    expect(spacingHint(11, 5, 'tile edge')).toBe('about 11 sc per 5 tile edges');
    expect(spacingHint(8, 8, 'row end')).toBe('1 sc in each row end');
    expect(spacingHint(7, 8, 'row end')).toBe('7 sc over 8 row ends');
  });

  it('no border for widthIn 0 or tapestry in the round; S ≥ 2 on a tiny panel', () => {
    expect(planBorder({ technique: 'sc_graphgan', hand: 'right', cols: 5, rows: 3, gauge: sc, widthIn: 0, color: 'A' })).toBeNull();
    expect(planBorder({ technique: 'sc_tapestry_round', hand: 'right', cols: 5, rows: 3, gauge: sc, widthIn: 1, color: 'A' })).toBeNull();
    const tiny = planBorder({ technique: 'sc_graphgan', hand: 'right', cols: 1, rows: 1, gauge: sc, widthIn: 0.25, color: 'A' })!;
    expect([tiny.sTop, tiny.sSide, tiny.counts[0]]).toEqual([2, 2, 12]);
    const grid = chartOf(['A']);
    const doc = buildPattern2DWith({ chart: grid, settings: settingsOf({ border: { widthIn: 0.25 } }), gauge: sc, terms: 'us', dialect: 'compact', title: '' }).doc;
    expect(doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
    expect(renderBorderLines(doc.pieces[0].lines, { terms: 'us', hand: 'right', rows: 1, cols: 1 })[1]).toBe(
      'Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top left corner); 3 sc in the corner loop of the foundation ch (bottom left); 3 sc in the last loop (bottom right corner); 3 sc in the top right corner st; join with sl st in first sc. (12 sts)',
    );
  });
});

describe('E_BORDER fires on crafted bad input', () => {
  const base = (): Line[] => structuredClone(writeBorder(planBorder({ technique: 'sc_graphgan', hand: 'right', cols: 5, rows: 3, gauge: sc, widthIn: 0.75, color: 'B', lastColor: 'B' })!));
  const run = (lines: Line[], o: { gauge?: ResolvedGauge; widthIn?: number; hand?: Hand; technique?: 'sc_graphgan' | 'c2c' } = {}): string[] =>
    validateBorder({ chart: g9, technique: o.technique ?? 'sc_graphgan', hand: o.hand ?? 'right', lines, lastColor: 'B', gauge: o.gauge ?? sc, border: { widthIn: o.widthIn ?? 0.75, color: 'B' } }).map((x) => x.message);

  it('silent on the writer’s rounds', () => {
    expect(run(base())).toEqual([]);
  });

  it('a wrong per-side count, a wrong total, a wrong increase, a missing corner', () => {
    const side = base();
    side[0].ops.splice(5, 0, { k: 'st', st: 'sc', color: 'B' });
    side[0].stated = 21;
    expect(run(side).some((m) => m.startsWith('opposite sides of Rnd 1 must match'))).toBe(true);
    const total = base();
    total[1].stated = 27;
    expect(run(total)).toContain('Rnd 2: each round adds 8 sts (20 → 28), not 20 → 27');
    const moved = base();
    const at = moved[1].ops.findIndex((op) => op.k === 'inc');
    [moved[1].ops[at], moved[1].ops[at + 1]] = [moved[1].ops[at + 1], moved[1].ops[at]];
    expect(run(moved)).toContain('Rnd 2: 3 sc (inc3) go in each of the 4 corner center sts of Rnd 1 and 1 sc in every other st');
    const corner = base();
    corner[0].ops = corner[0].ops.map((op) => (op.k === 'inc' ? op : op)).slice(0);
    corner[0].ops[corner[0].ops.findLastIndex((op) => op.k === 'inc')] = { k: 'st', st: 'sc', color: 'B' };
    expect(run(corner).some((m) => m.startsWith('Rnd 1 is 3 sc in each of the four corners'))).toBe(true);
  });

  it('a wrong opening: the wrong corner, a continued round in another color, a continued C2C border', () => {
    const wrongCorner = base();
    wrongCorner[0].arrow = '↗';
    expect(run(wrongCorner).some((m) => m.includes('a continued Rnd 1 opens there'))).toBe(true);
    const otherColor = base();
    expect(validateBorder({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines: otherColor, lastColor: 'A' }).map((x) => x.message)).toContain(
      'Rnd 1 continues from the last stitch (A) in another color (B): fasten off and join instead',
    );
    expect(run(base(), { technique: 'c2c', gauge: c2c }).some((m) => m.includes('cannot continue from the last stitch'))).toBe(true);
    const joinedWrong = base();
    joinedWrong[0].cues = [{ kind: 'color', text: 'join B' }];
    expect(run(joinedWrong)).toContain('a joined border starts at the top right corner (right-handed), not the top left');
  });

  it('S_side and the round count against §2.7.10 when the gauge is known', () => {
    const lines = base();
    expect(run(lines, { widthIn: 1 })).toContain('a 1 in border is 4 rounds (round(1 / 0.25)), not 3');
    const hdc = resolveGauge({ cyc: 4, technique: 'hdc_graphgan' });
    expect(run(lines, { gauge: hdc }).some((m) => m.startsWith('S_side = round(3 · h / w_sc)'))).toBe(true);
    expect(run(lines, { widthIn: 0 }).some((m) => m.startsWith('this piece has no border'))).toBe(true);
  });

  it('validate2D reports E_BORDER for any flat technique and C2C', () => {
    const doc = buildPattern2DWith({ chart: g9, settings: settingsOf({ border: { widthIn: 0.5 } }), gauge: sc, terms: 'us', dialect: 'compact', title: '' }).doc;
    const lines = structuredClone(doc.pieces[0].lines);
    lines[lines.length - 1].stated += 1;
    expect(validate2D({ chart: g9, technique: 'sc_graphgan', hand: 'right', lines }).map((x) => x.code)).toContain('E_BORDER');
  });
});
