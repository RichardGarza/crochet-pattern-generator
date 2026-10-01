import { describe, expect, it } from 'vitest';
import type { Line, Op } from '../../../types';
import { inferDocKind, renderFoundation, renderLine, renderLineExtras, renderLineWith } from '../render';
import { toTerms } from '../terminology';
import { colored, dec, inc, inLoop, parseBody, rnd, row, sc, tile, times } from './helpers';

const us = { dialect: 'compact', terms: 'us', hand: 'right' } as const;
const uk = { dialect: 'compact', terms: 'uk', hand: 'right' } as const;
const vus = { dialect: 'verbose', terms: 'us', hand: 'right' } as const;
const vuk = { dialect: 'verbose', terms: 'uk', hand: 'right' } as const;

const turn = { k: 'turn', chains: 1 } as const;

describe('DESIGN §2.7.2 — the four renderings of Row 11', () => {
  const ops = parseBody('4 sc A, 3 sc B, 33 sc A');
  it('compact: Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B', () => {
    const line = row(11, ops, 40, { side: 'RS', arrow: '←', start: turn, cues: [{ kind: 'color', text: 'carry B' }] });
    expect(renderLine(line, us)).toBe('Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B');
  });
  it('US verbose: … With A, sc in first 4 sts; change to B, sc in next 3 sts; change to A, sc in last 33 sts. (40 sc)', () => {
    const line = row(11, ops, 40, { side: 'RS', arrow: '←', start: turn });
    expect(renderLine(line, vus)).toBe('Row 11 (RS): Ch 1, turn. With A, sc in first 4 sts; change to B, sc in next 3 sts; change to A, sc in last 33 sts. (40 sc)');
  });
  it('UK verbose: the same through the terminology table (sc → dc)', () => {
    const line = row(11, ops, 40, { side: 'RS', arrow: '←', start: turn });
    expect(renderLine(line, vuk)).toBe('Row 11 (RS): Ch 1, turn. With A, dc in first 4 sts; change to B, dc in next 3 sts; change to A, dc in last 33 sts. (40 dc)');
    expect(renderLine(line, uk)).toBe('Row 11 (RS) ←: Ch 1, turn. 4 dc A, 3 dc B, 33 dc A (40 sts)');
  });
});

describe('research 07 §7.5 — the rendering dialects (amigurumi rounds)', () => {
  const r = (ops: Op[], stated: number, extra: Partial<Line> = {}): Line => rnd(5, ops, stated, extra);

  it('sc ×1 / ×N, inc ×1 / ×N', () => {
    expect(renderLine(r([sc, ...times(3, sc), inc], 6), vus)).toBe('Rnd 5: Sc in next 4 sts, 2 sc in next st. (6 sts)');
    expect(renderLine(r([...times(4, inc), sc], 9), vus)).toBe('Rnd 5: 2 sc in each of next 4 sts, sc in next st. (9 sts)');
    expect(renderLine(r([...times(4, inc), sc], 9), vuk)).toBe('Rnd 5: 2 dc in each of next 4 sts, dc in next st. (9 sts)');
  });

  it('dec: invdec or sc2tog (US), dc2tog (UK) — never tr2tog (vector 22)', () => {
    const line = r([...times(2, sc), dec, ...times(2, sc), dec], 6);
    expect(renderLine(line, vus)).toBe('Rnd 5: [Sc in next 2 sts, invdec] 2 times. (6 sts)');
    expect(renderLine(line, { ...vus, decMethod: 'sc2tog' })).toBe('Rnd 5: [Sc in next 2 sts, sc2tog] 2 times. (6 sts)');
    expect(renderLine(line, { ...vuk, decMethod: 'sc2tog' })).toBe('Rnd 5: [Dc in next 2 sts, dc2tog] 2 times. (6 sts)');
    expect(renderLine(line, us)).toBe('Rnd 5: (2 sc, dec) x 2 (6)');
    expect(renderLine(line, uk)).toBe('Rnd 5: (2 dc, dec) x 2 (6)');
    const blo = r(inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'), 18);
    expect(renderLine(blo, us)).toBe('Rnd 5: BLO (2 sc, sc2tog) x 6 (18)');
    expect(renderLine(blo, uk)).toBe('Rnd 5: BLO (2 dc, dc2tog) x 6 (18)');
    expect(renderLine(blo, vuk)).toBe('Rnd 5: Working in back loops only, [dc in next 2 sts, dc2tog] 6 times. (18 sts)');
    for (const text of [renderLine(blo, uk), renderLine(blo, vuk), renderLine(line, { ...vuk, decMethod: 'sc2tog' })]) expect(text).not.toContain('tr2tog');
  });

  it('BLO sc ×N in a mixed round: sc in back loop only of next N sts', () => {
    const ops = [...inLoop(times(3, sc), 'BLO'), ...times(2, sc)];
    expect(renderLine(r(ops, 5), us)).toBe('Rnd 5: 3 sc BLO, 2 sc (5)');
    expect(renderLine(r(ops, 5), vus)).toBe('Rnd 5: Sc in back loop only of next 3 sts, sc in next 2 sts. (5 sts)');
  });

  it('repeat [A, B] n times and the count (18 sts): research 07 §0 “Rnd 3: [Sc in next st, 2 sc in next st] 6 times. (18 sts)”', () => {
    const line = rnd(3, times(6, sc, inc), 18, { prevCount: 12 });
    expect(renderLine(line, us)).toBe('Rnd 3: (sc, inc) x 6 (18)');
    expect(renderLine(line, vus)).toBe('Rnd 3: [Sc in next st, 2 sc in next st] 6 times. (18 sts)');
  });

  it('colors: with A, sc in next 4 sts', () => {
    const ops = parseBody('(4 sc A, 2 sc B) x 6');
    expect(renderLine(r(ops, 36), us)).toBe('Rnd 5: (4 sc A, 2 sc B) x 6 (36)');
    expect(renderLine(r(ops, 36), vus)).toBe('Rnd 5: [With A, sc in next 4 sts; with B, sc in next 2 sts] 6 times. (36 sts)');
    const header = r([...times(30, sc), ...times(6, colored(sc, 'A'))].map((op, i) => (i < 30 ? { ...op, color: 'B' } : op)), 36, { colorHeader: 'B' });
    expect(renderLine(header, us)).toBe('Rnd 5 (B): 30 sc, 6 sc A (36)');
    expect(renderLine(header, vus)).toBe('Rnd 5 (B): Sc in next 30 sts; change to A, sc in next 6 sts. (36 sts)');
  });

  it('whole-round phrases: sc in each st around, 2 sc in each st around, invdec around', () => {
    expect(renderLine(r(times(36, sc), 36), vus)).toBe('Rnd 5: Sc in each st around. (36 sts)');
    expect(renderLine(r(times(6, inc), 12), vus)).toBe('Rnd 5: 2 sc in each st around. (12 sts)');
    expect(renderLine(r(times(6, dec), 6), vus)).toBe('Rnd 5: Invdec around. (6 sts)');
    expect(renderLine(r(times(6, dec), 6), { ...vus, decMethod: 'sc2tog' })).toBe('Rnd 5: Sc2tog around. (6 sts)');
    expect(renderLine(r(times(6, dec), 6), us)).toBe('Rnd 5: dec around (6)');
  });

  it('the magic ring: 6 sc in MR', () => {
    const line = rnd(1, times(6, sc), 6, { start: { k: 'mr', n: 6 }, prevCount: null });
    expect(renderLine(line, us)).toBe('Rnd 1: 6 sc in MR (6)');
    expect(renderLine(line, uk)).toBe('Rnd 1: 6 dc in MR (6)');
    expect(renderLine(line, vus)).toBe('Rnd 1: 6 sc in MR. (6 sts)');
    expect(renderLine(line, vuk)).toBe('Rnd 1: 6 dc in MR. (6 sts)');
  });

  it('a joined round (§2.11.3): Ch 1 (does not count), sc in same st as join, …; join with sl st in first sc', () => {
    const line = rnd(9, times(6, sc, inc), 18, { colorHeader: 'B', start: { k: 'join' }, join: { changeTo: 'A' } });
    expect(renderLine(line, us)).toBe('Rnd 9 (B): Ch 1 (does not count), sc in same st as join, (inc, sc) x 5, inc; join with sl st in first sc, changing to A. (18)');
    expect(renderLine(line, vus)).toBe(
      'Rnd 9 (B): Ch 1 (does not count), sc in same st as join, [2 sc in next st, sc in next st] 5 times, 2 sc in next st; join with sl st in first sc, changing to A. (18 sts)',
    );
    expect(renderLine(line, vuk)).toBe(
      'Rnd 9 (B): Ch 1 (does not count), dc in same st as join, [2 dc in next st, dc in next st] 5 times, 2 dc in next st; join with ss in first dc, changing to A. (18 sts)',
    );
    const decFirst = rnd(10, times(6, dec), 6, { start: { k: 'join' }, join: {} });
    expect(renderLine(decFirst, vus)).toBe('Rnd 10: Ch 1 (does not count), invdec over same st as join and next st, invdec 5 times; join with sl st in first sc. (6 sts)');
    const spiral = rnd(11, times(6, sc), 6, { start: { k: 'join' } });
    expect(renderLine(spiral, vus)).toBe('Rnd 11: Ch 1 (does not count), sc in same st as join, sc in next 5 sts; do not join — continue in a spiral. (6 sts)');
  });

  it('a chain oval (§2.10.6) in both dialects and terms', () => {
    const ops = [...times(8, sc), { k: 'inc', n: 3 } as Op, ...times(7, sc), inc];
    const line = rnd(1, ops, 20, { start: { k: 'chainOval', chains: 10 }, prevCount: null });
    const sentence = 'sc in 2nd ch from hook, sc in next 7 ch, 3 sc in last ch; working along the other side of the chain, sc in next 7 ch, 2 sc in last ch';
    expect(renderLine(line, us)).toBe(`Rnd 1: ${sentence} (20)`);
    expect(renderLine(line, vus)).toBe(`Rnd 1: S${sentence.slice(1)}. (20 sts)`);
    expect(renderLine(line, uk)).toBe(`Rnd 1: ${sentence.replace(/\bsc\b/g, 'dc')} (20)`);
    expect(renderFoundation(line, { terms: 'us' })).toBe('Ch 10.');
  });
});

describe('chart lines (2D)', () => {
  it('a tapestry round (§2.7.5), compact and verbose', () => {
    const first = rnd(1, parseBody('4 sc A, 3 sc B, 33 sc A'), 40, {
      prevCount: null,
      side: 'RS',
      arrow: '←',
      start: { k: 'chainRing', chains: 40 },
      join: {},
      cues: [{ kind: 'color', text: 'carry B' }],
    });
    expect(inferDocKind(first)).toBe('2d');
    expect(renderFoundation(first, { terms: 'us' })).toBe('Foundation: With A, ch 40; join with sl st in first ch to form a ring (do not twist).');
    expect(renderFoundation(first, { terms: 'uk' })).toBe('Foundation: With A, ch 40; join with ss in first ch to form a ring (do not twist).');
    expect(renderLine(first, us)).toBe('Rnd 1 (RS) ←: Ch 1 (does not count as a st), 4 sc A, 3 sc B, 33 sc A; join with sl st in first sc. (40 sts) · carry B');
    expect(renderLine(first, vus)).toBe(
      'Rnd 1 (RS): Ch 1 (does not count as a st), with A, sc in first 4 ch; change to B, sc in next 3 ch; change to A, sc in last 33 ch; join with sl st in first sc. (40 sc) · carry B',
    );
    const next = rnd(2, parseBody('40 sc A'), 40, { side: 'RS', arrow: '←', start: { k: 'join' }, join: {} });
    expect(renderLine(next, us)).toBe('Rnd 2 (RS) ←: Ch 1, 40 sc A; join with sl st in first sc. (40 sts)');
    expect(renderLine(next, vus)).toBe('Rnd 2 (RS): Ch 1, with A, sc in each st around; join with sl st in first sc. (40 sc)');
  });

  it('a C2C row: the label keeps its arrow and tags; verbose spells out the tiles', () => {
    const line: Line = {
      kind: 'c2c',
      n: 4,
      side: 'WS',
      arrow: '↗',
      start: { k: 'c2c', start: 'inc', end: 'dec' },
      ops: [tile('A'), tile('B'), tile('A')],
      prevCount: 3,
      stated: 3,
    };
    expect(renderLine(line, us)).toBe('↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)');
    expect(renderLine(line, vus)).toBe(
      '↗ Row 4 (WS) [inc beg · dec end]: With A, ch 6, dc in 4th ch from hook and in next 2 ch; change to B, (sl st, ch 3, 3 dc) in next ch-3 sp; change to A, (sl st, ch 3, 3 dc) in next ch-3 sp; sl st in last ch-3 sp, turn. (3 tiles)',
    );
    expect(renderLine(line, vuk)).toContain('ch 6, tr in 4th ch from hook and in next 2 ch; change to B, (ss, ch 3, 3 tr) in next ch-3 sp');
    const decBeg: Line = { ...line, n: 6, start: { k: 'c2c', start: 'dec', end: 'inc' }, ops: [tile('A'), tile('A')], prevCount: 3, stated: 2 };
    expect(renderLine(decBeg, vus)).toBe('↗ Row 6 (WS) [dec beg · inc end]: With A, sl st in next 3 dc and in ch-3 sp, ch 3, 3 dc in same sp, (sl st, ch 3, 3 dc) in next ch-3 sp. (2 tiles)');
  });

  it('a mosaic row (§2.7.8) reads its long stitches', () => {
    const blo: Op = { k: 'st', st: 'sc', loop: 'BLO' };
    const long: Op = { k: 'st', st: 'dc', into: 'flo2below' };
    const line = row(5, [sc, ...times(3, blo), long, ...times(2, long), blo, sc], 9, { side: 'RS', arrow: '←', colorHeader: 'B' });
    expect(renderLine(line, us)).toBe('Row 5 (B, RS) ←: sc, 3 sc BLO, 3 dc FLO 2 rows below, sc BLO, sc (9 sts)');
    expect(renderLine(line, vus)).toBe(
      'Row 5 (B, RS): Sc in first st, sc in back loop only of next 3 sts, dc in front loop of each of next 3 sts 2 rows below, sc in back loop only of next st, sc in last st. (9 sts)',
    );
    expect(renderLine(line, uk)).toBe('Row 5 (B, RS) ←: dc, 3 dc BLO, 3 tr FLO 2 rows below, dc BLO, dc (9 sts)');
  });
});

describe('options, kinds and extras', () => {
  it('inferDocKind: rounds with a side or arrow are chart rounds; other rounds amigurumi; rows, C2C and borders charts', () => {
    expect(inferDocKind({ kind: 'rnd' })).toBe('3d');
    expect(inferDocKind({ kind: 'rnd', side: 'RS' })).toBe('2d');
    expect(inferDocKind({ kind: 'rnd', arrow: '→' })).toBe('2d');
    expect(inferDocKind({ kind: 'row' })).toBe('2d');
    expect(inferDocKind({ kind: 'c2c' })).toBe('2d');
    expect(inferDocKind({ kind: 'border' })).toBe('2d');
    const flat = row(2, times(5, sc), 5, { start: turn });
    expect(renderLineWith(flat, { ...us, docKind: '3d' })).toBe('Row 2: Ch 1, turn. sc in each st across (5)');
    expect(renderLineWith(flat, { ...vus, docKind: '3d' })).toBe('Row 2: Ch 1, turn. Sc in each st across. (5 sts)');
    expect(renderLine(flat, vus)).toBe('Row 2: Ch 1, turn. Sc in each st across. (5 sc)');
  });

  it('the hand never changes the text: lines are written for one hand by their writer', () => {
    const lines: Line[] = [
      row(11, parseBody('4 sc A, 3 sc B, 33 sc A'), 40, { side: 'RS', arrow: '←', start: turn }),
      rnd(3, times(6, sc, inc), 18),
    ];
    for (const line of lines) {
      for (const base of [us, uk, vus, vuk]) expect(renderLine(line, { ...base, hand: 'left' })).toBe(renderLine(line, base));
    }
  });

  it('cues and notes: color cues on the line (UK through the converter), the rest as sentences', () => {
    const line = rnd(8, times(36, sc), 36, {
      cues: [
        { kind: 'color', text: 'change to B on the last yo' },
        { kind: 'eyes', text: 'Place safety eyes between Rnds 8 and 9, 6 sts apart.' },
        { kind: 'stuff', text: 'Stuff firmly.' },
      ],
      notes: ['Work the next sc in the back loop only.'],
    });
    expect(renderLine(line, us)).toBe('Rnd 8: sc in each st around (36) · change to B on the last yo');
    expect(renderLine(line, uk)).toBe('Rnd 8: dc in each st around (36) · change to B on the last yoh');
    expect(renderLine(line, vuk)).toBe('Rnd 8: Dc in each st around. (36 sts) · change to B on the last yoh');
    expect(renderLineExtras(line, { terms: 'us' })).toEqual(['Place safety eyes between Rnds 8 and 9, 6 sts apart.', 'Stuff firmly.', 'Work the next sc in the back loop only.']);
    expect(renderLineExtras(line, { terms: 'uk' })[2]).toBe('Work the next dc in the back loop only.');
  });

  it('a folded range keeps its label and count in every dialect', () => {
    const line = rnd(7, times(36, sc), 36, { nEnd: 12, prevCount: 36 });
    expect(renderLine(line, us)).toBe('Rnds 7–12 (6 rnds): sc in each st around (36)');
    expect(renderLine(line, vus)).toBe('Rnds 7–12 (6 rnds): Sc in each st around. (36 sts)');
  });

  it('research 07 §1.3: the one-pass converter changes each US term once (vector 22)', () => {
    expect(toTerms('sc2tog', 'uk')).toBe('dc2tog');
    expect(toTerms('sc2tog', 'us')).toBe('sc2tog');
    expect(toTerms('Row 2: Ch 3 (counts as dc), dc in next st, sc2tog, hdc in next 2 sts, sl st in last st. Gauge: 16 sc = 4".', 'uk')).toBe(
      'Row 2: Ch 3 (counts as tr), tr in next st, dc2tog, htr in next 2 sts, ss in last st. Tension: 16 dc = 4".',
    );
  });
});
