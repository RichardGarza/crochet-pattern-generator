import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue, Line, LineStart, Op } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import { renderCompactLine } from '../compact';
import { canonicalCompact, encodeOps, resetEncodeMemo } from '../encode';
import { consumed, produced } from '../ops';
import { validateLine, validateLines } from '../validateLine';
import { colored, dec, dec3, foldPlain, hdc, inc, inc3, inLoop, parseBody, placeRound, randomOps, rnd, row, sc, slst, spiralLines, structuredOps, tile, times } from './helpers';

beforeEach(() => {
  resetEncodeMemo();
});

const codes = (issues: Issue[]): string[] => issues.map((issue) => issue.code);

describe('G4 — research 07 §7.6 vectors 1–12 and 15–18', () => {
  interface Vector {
    id: number;
    prev: number | null;
    /** The line body as the vector writes it, or the ops when the vector names a layout. */
    body: string | Op[];
    stated: number;
    start?: LineStart;
    /** Expected issue codes; [] = ok. */
    expect: string[];
    /** "compresses to" / "encodes": the exact text of the encoded line. */
    encodes?: string;
    message?: string;
  }
  const vectors: Vector[] = [
    { id: 1, prev: null, body: '6 sc in MR', stated: 6, start: { k: 'mr', n: 6 }, expect: [] },
    { id: 2, prev: 6, body: 'inc in each st around', stated: 12, expect: [] },
    { id: 3, prev: 18, body: 'sc, inc, (2 sc, inc) x 5, sc', stated: 24, expect: [], encodes: '(sc, inc, sc) x 6' },
    { id: 4, prev: 12, body: 'sc, inc, sc, sc, sc, inc, sc, sc, sc, inc, sc, sc', stated: 15, expect: [], encodes: '(sc, inc, 2 sc) x 3' },
    { id: 5, prev: 8, body: '6 inc, sc, inc', stated: 15, expect: [] },
    { id: 6, prev: 15, body: 'sc, (inc, sc) x 2, (sc, inc) x 5', stated: 22, expect: [] },
    { id: 7, prev: 22, body: 'sc, inc, 2 sc, (inc, sc) x 2, (2 sc, inc) x 2, (2 sc, inc, sc) x 2', stated: 29, expect: [] },
    { id: 8, prev: 29, body: '2 sc, inc, sc, (2 sc, inc, 3 sc, inc) x 2, 2 sc, (sc, inc, sc) x 3', stated: 37, expect: [] },
    // 9, 10: the grouped layout of research 07 §6.6 (r groups of (g+1) sc + special, then k − r groups of g sc + special).
    { id: 9, prev: 37, body: placeRound(37, 30, 1), stated: 30, expect: [], encodes: '(4 sc, dec) x 2, (3 sc, dec) x 5' },
    { id: 10, prev: 15, body: placeRound(15, 22, 1), stated: 22, expect: [], encodes: 'sc, (sc, inc) x 7' },
    { id: 11, prev: 24, body: '(invdec, 2 sc) x 6', stated: 18, expect: [] },
    { id: 12, prev: 12, body: 'dec around', stated: 6, expect: [] },
    { id: 15, prev: 30, body: '(2 sc, inc, 2 sc) x 5, 2 sc, inc, sc, sl st', stated: 36, expect: [] },
    { id: 16, prev: 12, body: '(sc, inc) x 6', stated: 20, expect: ['E_PRODUCE'], message: '18 ≠ 20' },
    { id: 17, prev: 20, body: '(sc, inc) x 6', stated: 18, expect: ['E_CONSUME'], message: '12 ≠ 20' },
    // 18: "target 25 with inc(2)" from 10 sts: the most that inc(2) can make is 10 incs = 20.
    { id: 18, prev: 10, body: times(10, inc), stated: 25, expect: ['E_PRODUCE', 'E_INC_INFEASIBLE'] },
  ];

  for (const vector of vectors) {
    const what = vector.expect.length === 0 ? 'ok' : vector.expect.join(' + ');
    it(`vector ${vector.id}: ${typeof vector.body === 'string' ? vector.body : `${vector.prev} → ${vector.stated}`} — ${what}`, () => {
      const ops = typeof vector.body === 'string' ? parseBody(vector.body, vector.prev) : vector.body;
      const line: Line = { kind: 'rnd', n: vector.id, ops, prevCount: vector.prev, stated: vector.stated, start: vector.start };
      const issues = validateLine(line);
      expect(codes(issues)).toEqual(vector.expect);
      for (const issue of issues) expect(issue.severity).toBe('error');
      if (vector.message !== undefined) expect(issues[0].message).toContain(vector.message);
      if (vector.encodes !== undefined) expect(canonicalCompact(encodeOps(ops))).toBe(vector.encodes);
    });
  }

  it('vectors 1, 2, 5, 11, 12 print as research 07 writes them (11 with dec for invdec, §7.5)', () => {
    const print = (id: number): string => {
      const vector = vectors.find((v) => v.id === id);
      if (vector === undefined || typeof vector.body !== 'string') throw new Error(`no vector ${id}`);
      const line: Line = { kind: 'rnd', n: id, ops: parseBody(vector.body, vector.prev), prevCount: vector.prev, stated: vector.stated, start: vector.start };
      return renderCompactLine(line);
    };
    expect(print(1)).toBe('Rnd 1: 6 sc in MR (6)');
    expect(print(2)).toBe('Rnd 2: inc in each st around (12)');
    expect(print(5)).toBe('Rnd 5: 6 inc, sc, inc (15)');
    expect(print(11)).toBe('Rnd 11: (dec, 2 sc) x 6 (18)');
    expect(print(12)).toBe('Rnd 12: dec around (6)');
  });

  it('vector 18 becomes workable with inc3 (the 3D validator then raises W_FAN3, not the kernel)', () => {
    const ops = [...times(5, inc3), ...times(5, inc)];
    expect(validateLine(rnd(3, ops, 10))).toEqual([]);
    expect(produced(ops)).toBe(25);
  });
});

describe('validateLine stays silent on every golden line', () => {
  it('DESIGN §2.10.8: the textbook sphere, unfolded and folded', () => {
    const lines = spiralLines([6, 12, 18, 24, 30, 36, 36, 36, 36, 36, 36, 36, 30, 24, 18, 12, 6]);
    expect(lines.length).toBe(17);
    expect(validateLines(lines)).toEqual([]);
    const folded = foldPlain(lines);
    expect(folded.length).toBe(12);
    expect(validateLines(folded)).toEqual([]);
  });

  it('DESIGN §2.10.5: the closed cylinder 6 12 18 24 | 24 ×10 | 18 12 6 with BLO rounds 5 and 15 and jogless prep', () => {
    const lines: Line[] = [
      rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }),
      rnd(2, placeRound(6, 12, 0), 6),
      rnd(3, placeRound(12, 18, 1), 12),
      rnd(4, parseBody('(sc, inc, sc) x 5, sc, inc, sl st'), 18),
      rnd(5, inLoop(times(24, sc), 'BLO'), 24),
      rnd(6, times(24, sc), 24, { nEnd: 13 }),
      rnd(14, [...times(23, sc), slst], 24),
      rnd(15, inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'), 24),
      rnd(16, placeRound(18, 12, 4), 18),
      rnd(17, placeRound(12, 6, 5), 12),
    ];
    expect(lines.map((line) => line.stated)).toEqual([6, 12, 18, 24, 24, 24, 24, 18, 12, 6]);
    expect(validateLines(lines)).toEqual([]);
  });

  it('research 07 §6.9 (G8 lines): the oval on ch 10 — Rnd 1 (20), Rnd 2 (26), Rnd 3 (32)', () => {
    const lines: Line[] = [
      rnd(1, [...times(8, sc), inc3, ...times(7, sc), inc], null, { start: { k: 'chainOval', chains: 10 } }),
      rnd(2, [inc, ...times(7, sc), ...times(3, inc), ...times(7, sc), ...times(2, inc)], 20, {
        segments: [{ at: 0, kind: 'end' }, { at: 1, kind: 'side' }, { at: 8, kind: 'end' }, { at: 11, kind: 'side' }, { at: 18, kind: 'end' }],
      }),
      rnd(3, parseBody('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2'), 26, {
        segments: [{ at: 0, kind: 'end' }, { at: 2, kind: 'side' }, { at: 9, kind: 'end' }, { at: 15, kind: 'side' }, { at: 22, kind: 'end' }],
      }),
    ];
    expect(lines.map((line) => [consumed(line.ops), line.stated])).toEqual([[17, 20], [20, 26], [26, 32]]);
    expect(validateLines(lines)).toEqual([]);
  });

  it('DESIGN §2.7.3 (G9 lines): the flat graph W = 5, RH and LH', () => {
    const turn: LineStart = { k: 'turn', chains: 1 };
    const lines: Line[] = [
      row(1, parseBody('2 sc A, sc B, 2 sc A'), null, { side: 'RS', arrow: '←', start: { k: 'foundation', chains: 6, firstInto: 2 } }),
      row(2, parseBody('sc A, 3 sc B, sc A'), 5, { side: 'WS', arrow: '→', start: turn }),
      row(3, parseBody('4 sc A, sc B'), 5, { side: 'RS', arrow: '←', start: turn }),
    ];
    expect(validateLines(lines, { palette: ['A', 'B'] })).toEqual([]);
    expect(validateLine(row(3, parseBody('sc B, 4 sc A'), 5, { side: 'RS', arrow: '→', start: turn }), { prev: lines[1], palette: ['A', 'B'] })).toEqual([]);
  });

  it('DESIGN §2.7.6 (G10 lines): C2C 5 × 3, RH start bottom-right and bottom-left', () => {
    type End = 'first' | 'inc' | 'dec';
    const build = (rows: [End, End, string][]): Line[] => {
      const lines: Line[] = [];
      for (const [start, end, tiles] of rows) {
        const ops = parseBody(tiles);
        const prev = lines.length > 0 ? lines[lines.length - 1].stated : null;
        lines.push({ kind: 'c2c', n: lines.length + 1, start: { k: 'c2c', start, end }, ops, prevCount: prev, stated: ops.length });
      }
      return lines;
    };
    const bottomRight = build([
      ['first', 'first', '1 A'],
      ['inc', 'inc', '2 A'],
      ['inc', 'inc', '1 A, 2 B'],
      ['inc', 'dec', '1 A, 1 B, 1 A'],
      ['dec', 'inc', '1 A, 1 B, 1 A'],
      ['dec', 'dec', '2 A'],
      ['dec', 'dec', '1 B'],
    ]);
    const bottomLeft = build([
      ['first', 'first', '1 A'],
      ['inc', 'inc', '2 A'],
      ['inc', 'inc', '3 B'],
      ['dec', 'inc', '1 A, 1 B, 1 A'],
      ['inc', 'dec', '1 A, 1 B, 1 A'],
      ['dec', 'dec', '2 A'],
      ['dec', 'dec', '1 A'],
    ]);
    expect(bottomRight.map((line) => line.stated)).toEqual([1, 2, 3, 3, 3, 2, 1]);
    expect(validateLines(bottomRight, { palette: ['A', 'B'] })).toEqual([]);
    expect(validateLines(bottomLeft, { palette: ['A', 'B'] })).toEqual([]);
  });

  it('research 07 §4.3 (vector 20 shape): C2C 100 × 60 — 159 rows, rows 61–100 hold 60 tiles, row 101 has 59', () => {
    const W = 100;
    const H = 60;
    const lines: Line[] = [];
    for (let n = 1; n <= W + H - 1; n++) {
      const tiles = Math.min(n - 1, W - 1) - Math.max(0, n - H) + 1;
      const odd = n % 2 === 1;
      const [startInc, endInc] = odd ? [n <= H, n <= W] : [n <= W, n <= H];
      const start: LineStart = n === 1 ? { k: 'c2c', start: 'first', end: 'first' } : { k: 'c2c', start: startInc ? 'inc' : 'dec', end: endInc ? 'inc' : 'dec' };
      lines.push({ kind: 'c2c', n, start, ops: times(tiles, tile('A')), prevCount: n === 1 ? null : lines[n - 2].stated, stated: tiles });
    }
    expect(lines.length).toBe(159);
    expect(lines.slice(60, 100).every((line) => line.stated === 60)).toBe(true);
    expect(lines[100].stated).toBe(59);
    expect(validateLines(lines)).toEqual([]);
  });

  it('DESIGN §2.7.5: tapestry in joined rounds, plain and turned', () => {
    const runs = parseBody('3 sc A, 2 sc B, 35 sc A');
    const lines: Line[] = [
      rnd(1, runs, null, { start: { k: 'chainRing', chains: 40 }, join: {} }),
      rnd(2, runs, 40, { start: { k: 'join' }, join: {} }),
      rnd(3, runs, 40, { side: 'WS', start: { k: 'turn', chains: 1 }, join: {} }),
    ];
    expect(validateLines(lines, { docKind: '2d', palette: new Set(['A', 'B']) })).toEqual([]);
  });

  it('DESIGN §2.11.3: joined rounds inside a spiral piece — the sl st and ch 1 are not counted', () => {
    const lines: Line[] = [
      rnd(6, times(36, sc), 36, { colorHeader: 'A' }),
      rnd(7, times(36, sc), 36, { colorHeader: 'A', join: { changeTo: 'B' } }),
      rnd(8, times(36, sc), 36, { colorHeader: 'B', start: { k: 'join' }, join: { changeTo: 'A', drop: 'carry' } }),
      rnd(9, placeRound(36, 42, 0), 36, { start: { k: 'join' } }),
    ];
    expect(lines[3].ops[0]).toEqual(sc); // a shaped joined round starts with a plain sc (§2.10.8)
    expect(validateLines(lines, { palette: ['A', 'B'] })).toEqual([]);
  });

  it('DESIGN §2.7.10: border rounds — Rnd 1 on the panel edge, later rounds joined, +8 each', () => {
    // G22: W = 5, S_side = 3 → c1 = 20; Rnd 2 = 28 with an inc3 in each corner center stitch.
    const rnd1: Line = { kind: 'border', n: 1, start: { k: 'edge' }, ops: [inc3, sc, inc3, ...times(3, sc), inc3, sc, inc3, ...times(3, sc)], prevCount: null, stated: 20, join: {} };
    const corner = [sc, inc3, sc];
    const rnd2: Line = { kind: 'border', n: 2, start: { k: 'join' }, ops: [...corner, sc, ...corner, ...times(3, sc), ...corner, sc, ...corner, ...times(3, sc)], prevCount: 20, stated: 28, join: {} };
    expect([consumed(rnd2.ops), produced(rnd2.ops)]).toEqual([20, 28]);
    const lastRow = row(3, parseBody('4 sc A, sc B'), 5, { start: { k: 'turn', chains: 1 } });
    expect(validateLines([lastRow, rnd1, rnd2])).toEqual([]);
  });

  it('a flat appliqué (§2.10.9) and an hdc graph (§2.7.7)', () => {
    const rows: Line[] = [
      row(1, times(5, sc), null, { start: { k: 'foundation', chains: 6, firstInto: 2 } }),
      row(2, times(5, sc), 5, { start: { k: 'turn', chains: 1 }, nEnd: 4 }),
      row(1, times(5, colored(hdc, 'A')), null, { start: { k: 'foundation', chains: 7, firstInto: 3 } }),
      row(2, times(5, colored(hdc, 'A')), 5, { start: { k: 'turn', chains: 2 } }),
    ];
    expect(validateLines(rows.slice(0, 2), { docKind: '3d' })).toEqual([]);
    expect(validateLines(rows.slice(2))).toEqual([]);
  });
});

describe('E_CONSUME', () => {
  it('fires when the ops work into more or fewer stitches than the previous count', () => {
    const tooFew = validateLine(rnd(3, parseBody('(sc, inc) x 5'), 12, { stated: 15 }));
    expect(codes(tooFew)).toEqual(['E_CONSUME']);
    expect(tooFew[0].message).toBe('Rnd 3: works into 10 sts but the previous count is 12 (10 ≠ 12)');
    expect(codes(validateLine(rnd(3, parseBody('(sc, inc) x 7'), 12, { stated: 21 })))).toEqual(['E_CONSUME']);
    expect(codes(validateLine(rnd(13, parseBody('(4 sc, dec) x 6'), 35)))).toEqual(['E_CONSUME']);
    expect(codes(validateLine(row(4, parseBody('2 sc A, 2 sc B'), 5, { start: { k: 'turn', chains: 1 } })))).toEqual(['E_CONSUME']);
  });

  it('a decrease uses two stitches, a dec3 three, a sl st one (research 07 §7.2)', () => {
    expect(validateLine(rnd(9, [dec, dec3, slst, sc], 7))).toEqual([]);
    expect(codes(validateLine(rnd(9, [dec, dec3, slst, sc], 4)))).toEqual(['E_CONSUME']);
  });

  it('needs a previous count on every line that does not start a piece', () => {
    const issues = validateLine(rnd(3, parseBody('(sc, inc) x 6'), null));
    expect(codes(issues)).toEqual(['E_CONSUME']);
    expect(issues[0].message).toContain('no previous count');
    expect(codes(validateLine(row(2, times(5, sc), null, { start: { k: 'turn', chains: 1 } })))).toEqual(['E_CONSUME']);
    expect(codes(validateLine(rnd(8, times(36, sc), null, { start: { k: 'join' }, join: {} })))).toEqual(['E_CONSUME']);
  });

  it('checks a line against the line before it when that is given', () => {
    const before = rnd(2, times(6, inc), 6);
    const after = rnd(3, parseBody('(sc, inc) x 6'), 12);
    expect(validateLine(after, { prev: before })).toEqual([]);
    const wrongPrev = rnd(3, parseBody('(sc, inc) x 9'), 18);
    const issues = validateLine(wrongPrev, { prev: before });
    expect(codes(issues)).toEqual(['E_CONSUME']);
    expect(issues[0].message).toBe('Rnd 3: expects 18 sts before it, but Rnd 2 ends with 12');
    // After a folded line the count is that of its last round.
    const folded = rnd(7, times(36, sc), 36, { nEnd: 12 });
    expect(validateLine(rnd(13, parseBody('(4 sc, dec) x 6'), 36), { prev: folded })).toEqual([]);
    expect(validateLine(after, { prev: null })).toEqual([]);
  });

  it('validateLines chains the lines of a piece and reports in line order', () => {
    const lines = spiralLines([6, 12, 18, 24]);
    lines[2] = rnd(3, parseBody('(sc, inc) x 5, 2 sc'), 12, { stated: 18 }); // makes 17, states 18
    const issues = validateLines(lines, { piece: 'head' });
    expect(codes(issues)).toEqual(['E_PRODUCE']);
    expect(issues[0].where).toEqual({ piece: 'head', line: 3 });
    lines[3] = rnd(4, placeRound(20, 26, 2), 20); // sound on its own, but Rnd 3 states 18
    expect(codes(validateLines(lines))).toEqual(['E_PRODUCE', 'E_CONSUME']);
    expect(validateLines([])).toEqual([]);
  });

  it('a folded line must leave the count unchanged (research 07 §6.3: AmiGo "rows 2-3: (sc, inc, 2sc)*3")', () => {
    const issues = validateLine(rnd(2, parseBody('(sc, inc, 2 sc) x 3'), 12, { nEnd: 3 }));
    expect(codes(issues)).toEqual(['E_CONSUME']);
    expect(issues[0].message).toContain('Rnds 2–3');
    expect(issues[0].message).toContain('12 ≠ 15');
    expect(validateLine(rnd(7, times(36, sc), 36, { nEnd: 12 }))).toEqual([]);
    expect(validateLine(rnd(7, parseBody('(inc, dec) x 12'), 36, { nEnd: 9 }))).toEqual([]);
  });

  it('C2C rows consume ch-3 spaces: tiles − [inc beg] + [dec end] (research 07 §4.3)', () => {
    const c2c = (start: 'inc' | 'dec', end: 'inc' | 'dec', tiles: number, prev: number): Line => ({
      kind: 'c2c',
      n: 4,
      start: { k: 'c2c', start, end },
      ops: times(tiles, tile('A')),
      prevCount: prev,
      stated: tiles,
    });
    expect(validateLine(c2c('inc', 'inc', 4, 3))).toEqual([]);
    expect(validateLine(c2c('inc', 'dec', 3, 3))).toEqual([]);
    expect(validateLine(c2c('dec', 'inc', 3, 3))).toEqual([]);
    expect(validateLine(c2c('dec', 'dec', 2, 3))).toEqual([]);
    // The wrong tag for the tile count: an increase row cannot keep the count.
    const issues = validateLine(c2c('inc', 'inc', 3, 3));
    expect(codes(issues)).toEqual(['E_CONSUME']);
    expect(issues[0].message).toBe('Row 4: works into 2 ch-3 sps but the previous count is 3 (2 ≠ 3)');
    expect(codes(validateLine(c2c('dec', 'dec', 3, 3)))).toEqual(['E_CONSUME']);
  });
});

describe('E_CONSUME exemptions (§2.13: MR, foundation, chain-oval, chain-ring and border edge lines)', () => {
  const ovalOps = [...times(8, sc), inc3, ...times(7, sc), inc];
  const starts: [string, Line][] = [
    ['magic ring', rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } })],
    ['foundation', row(1, times(5, colored(sc, 'A')), null, { start: { k: 'foundation', chains: 6, firstInto: 2 } })],
    ['chain oval', rnd(1, ovalOps, null, { start: { k: 'chainOval', chains: 10 } })],
    ['chain ring', rnd(1, times(40, colored(sc, 'A')), null, { start: { k: 'chainRing', chains: 40 }, join: {} })],
    ['border edge', { kind: 'border', n: 1, start: { k: 'edge' }, ops: times(4, inc3, sc), prevCount: null, stated: 16, join: {} }],
    ['first C2C tile', { kind: 'c2c', n: 1, start: { k: 'c2c', start: 'first', end: 'first' }, ops: [tile('A')], prevCount: null, stated: 1 }],
  ];

  for (const [name, line] of starts) {
    it(`${name}: no previous count is needed, and a previous count is not compared`, () => {
      expect(validateLine(line)).toEqual([]);
      expect(validateLine({ ...line, prevCount: 999 })).toEqual([]);
      expect(validateLine(line, { prev: rnd(9, times(7, sc), 7) })).toEqual([]);
    });

    it(`${name}: E_PRODUCE still applies`, () => {
      expect(codes(validateLine({ ...line, stated: line.stated + 1 }))).toEqual(['E_PRODUCE']);
    });
  }

  it('the same ops without the start are not exempt', () => {
    expect(codes(validateLine(rnd(1, times(6, sc), null)))).toEqual(['E_CONSUME']);
    expect(codes(validateLine({ kind: 'c2c', n: 2, start: { k: 'c2c', start: 'inc', end: 'inc' }, ops: [tile('A'), tile('A')], prevCount: null, stated: 2 }))).toEqual([
      'E_CONSUME',
    ]);
  });
});

describe('E_PRODUCE', () => {
  it('fires when the stated count is not what the ops make', () => {
    const issues = validateLine(rnd(3, parseBody('(sc, inc) x 6'), 12, { stated: 19 }));
    expect(codes(issues)).toEqual(['E_PRODUCE']);
    expect(issues[0].message).toBe('Rnd 3: makes 18 but states 19 (18 ≠ 19)');
    expect(codes(validateLine(rnd(13, parseBody('(4 sc, dec) x 6'), 36, { stated: 36 })))).toEqual(['E_PRODUCE']);
    expect(codes(validateLine(row(2, parseBody('3 sc A, 2 sc B'), 5, { start: { k: 'turn', chains: 1 }, stated: 6 })))).toEqual(['E_PRODUCE']);
    expect(codes(validateLine(rnd(7, times(36, sc), 36, { nEnd: 12, stated: 35 })))).toEqual(['E_PRODUCE']);
  });

  it('reports both rules when both are broken', () => {
    expect(codes(validateLine(rnd(3, parseBody('(sc, inc) x 6'), 13, { stated: 19 })))).toEqual(['E_CONSUME', 'E_PRODUCE']);
  });

  it('an inc makes two, an inc3 three, a dec one (research 07 §7.2)', () => {
    expect(validateLine(rnd(9, [inc, inc3, dec, sc], 5, { stated: 7 }))).toEqual([]);
  });
});

describe('E_INC_INFEASIBLE / E_DEC_INFEASIBLE (§2.13 R3, R4)', () => {
  const grow = (before: number, after: number, ops: Op[]): string[] => codes(validateLine({ kind: 'rnd', n: 5, ops, prevCount: before, stated: after }));

  it('T > 2P needs inc3; T > 3P cannot be worked at all', () => {
    expect(grow(10, 20, times(10, inc))).toEqual([]); // T = 2P
    expect(grow(10, 21, [...times(9, inc), inc3])).toEqual([]); // T = 2P + 1 with one inc3
    expect(grow(10, 21, times(10, inc))).toEqual(['E_PRODUCE', 'E_INC_INFEASIBLE']);
    expect(grow(10, 30, times(10, inc3))).toEqual([]); // T = 3P
    expect(grow(10, 31, times(10, inc3))).toEqual(['E_PRODUCE', 'E_INC_INFEASIBLE']);
  });

  it('T < P/2 needs dec3; T < P/3 cannot be worked at all', () => {
    expect(grow(12, 6, times(6, dec))).toEqual([]); // T = P/2
    expect(grow(13, 6, [...times(5, dec), dec3])).toEqual([]); // 2T < P with one dec3
    expect(grow(13, 6, times(6, dec))).toEqual(['E_CONSUME', 'E_DEC_INFEASIBLE']);
    expect(grow(12, 4, times(4, dec3))).toEqual([]); // T = P/3
    expect(grow(13, 4, times(4, dec3))).toEqual(['E_CONSUME', 'E_DEC_INFEASIBLE']);
  });

  it('does not apply to lines that start a piece or to C2C tiles', () => {
    expect(validateLine(rnd(1, times(8, sc), null, { start: { k: 'mr', n: 8 }, prevCount: 2 }))).toEqual([]);
    const second: Line = { kind: 'c2c', n: 2, start: { k: 'c2c', start: 'inc', end: 'inc' }, ops: times(2, tile('A')), prevCount: 1, stated: 2 };
    expect(validateLine(second)).toEqual([]);
  });
});

describe('E_COLOR', () => {
  const line = rnd(12, times(6, ...times(4, colored(sc, 'A')), ...times(2, colored(sc, 'B'))), 36);

  it('is checked only when a palette is given', () => {
    expect(validateLine(line)).toEqual([]);
    expect(validateLine(line, { palette: ['A', 'B'] })).toEqual([]);
    expect(validateLine(line, { palette: new Set(['A', 'B', 'C']) })).toEqual([]);
  });

  it('reports each unknown color code once: on ops, in the header, in the change of a joined round', () => {
    const issues = validateLine(line, { palette: ['A'] });
    expect(codes(issues)).toEqual(['E_COLOR']);
    expect(issues[0].message).toBe('Rnd 12: color "B" is not in the palette');
    expect(codes(validateLine(rnd(9, times(36, sc), 36, { colorHeader: 'D' }), { palette: ['A', 'B'] }))).toEqual(['E_COLOR']);
    expect(codes(validateLine(rnd(9, times(36, sc), 36, { colorHeader: 'A', join: { changeTo: 'Z' } }), { palette: ['A', 'B'] }))).toEqual(['E_COLOR']);
    expect(codes(validateLine({ kind: 'c2c', n: 1, start: { k: 'c2c', start: 'first', end: 'first' }, ops: [tile('Q')], prevCount: null, stated: 1 }, { palette: ['A'] }))).toEqual([
      'E_COLOR',
    ]);
    expect(codes(validateLine(line, { palette: [] }))).toEqual(['E_COLOR', 'E_COLOR']);
  });
});

describe('E_SANITY', () => {
  const good = rnd(3, parseBody('(sc, inc) x 6'), 12);
  const broken = (change: Partial<Record<keyof Line, unknown>>): Issue[] => validateLine({ ...good, ...change } as Line);

  it('numbers must be whole and ≥ 1', () => {
    for (const change of [
      { n: 0 },
      { n: 1.5 },
      { n: Number.NaN },
      { nEnd: 3 },
      { nEnd: 2 },
      { nEnd: 4.5 },
      { stated: 0 },
      { stated: -18 },
      { stated: 18.5 },
      { stated: Number.NaN },
      { stated: '18' },
      { prevCount: 0 },
      { prevCount: 11.5 },
      { prevCount: Number.POSITIVE_INFINITY },
    ]) {
      const issues = broken(change);
      expect([change, codes(issues)]).toEqual([change, ['E_SANITY']]);
    }
  });

  it('ops must be stitches of the frozen Op type', () => {
    expect(codes(broken({ ops: [sc, { k: 'skip', n: 2 }] }))).toEqual(['E_SANITY']);
    expect(codes(broken({ ops: [sc, { k: 'inc', n: 4 }] }))).toEqual(['E_SANITY']);
    expect(codes(broken({ ops: [null] }))).toEqual(['E_SANITY']);
    expect(codes(broken({ ops: 'sc, inc' }))).toEqual(['E_SANITY']);
    expect(broken({ ops: [sc, { k: 'mr', n: 6 }] })[0].message).toBe('Rnd 3: op 2 is not a stitch of the pattern language: {"k":"mr","n":6}');
    expect(codes(broken({ kind: 'round' }))).toEqual(['E_SANITY']);
  });

  it('a start must have possible numbers', () => {
    const starts: unknown[] = [
      { k: 'mr', n: 0 },
      { k: 'mr', n: 5.5 },
      { k: 'foundation', chains: 6, firstInto: 0 },
      { k: 'foundation', chains: 6, firstInto: 7 },
      { k: 'foundation', chains: 0, firstInto: 1 },
      { k: 'turn', chains: 0 },
      { k: 'chainRing', chains: -4 },
      { k: 'chainOval', chains: 2 },
      { k: 'c2c', start: 'inc', end: 'up' },
      { k: 'ring' },
    ];
    for (const start of starts) expect([start, codes(broken({ start }))]).toEqual([start, ['E_SANITY']]);
    expect(broken({ start: { k: 'foundation', chains: 6, firstInto: 2 }, prevCount: null })).toEqual([]);
  });

  it('segments must be increasing op indexes inside the line', () => {
    expect(broken({ segments: [{ at: 0, kind: 'end' }, { at: 4, kind: 'side' }, { at: 11, kind: 'end' }] })).toEqual([]);
    for (const segments of [
      [{ at: 0, kind: 'end' }, { at: 12, kind: 'side' }],
      [{ at: 4, kind: 'end' }, { at: 4, kind: 'side' }],
      [{ at: 6, kind: 'end' }, { at: 2, kind: 'side' }],
      [{ at: -1, kind: 'end' }],
      [{ at: 2.5, kind: 'end' }],
    ]) {
      expect(codes(broken({ segments }))).toEqual(['E_SANITY']);
    }
  });

  it('reports every problem, and nothing but E_SANITY', () => {
    const issues = broken({ n: 0, stated: 0, ops: [{ k: 'x' }] });
    expect(codes(issues)).toEqual(['E_SANITY', 'E_SANITY', 'E_SANITY']);
  });
});

describe('E_ROUNDTRIP can never fire on encoder output', () => {
  it('sound random lines of every kind validate clean; a wrong count is the only issue', () => {
    const rng = mulberry32(1234567);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(rng() * (i % 20 === 0 ? 400 : 60));
      const ops = i % 2 === 0 ? randomOps(rng, length, 14) : structuredOps(rng, length, 2 + Math.floor(rng() * 12));
      const used = consumed(ops);
      const made = produced(ops);
      const kind: Line['kind'] = i % 3 === 0 ? 'row' : 'rnd';
      const segments = i % 5 === 0 && ops.length > 4 ? [{ at: 0, kind: 'end' as const }, { at: Math.floor(ops.length / 2), kind: 'side' as const }] : undefined;
      const line: Line = { kind, n: 1 + (i % 50), ops, prevCount: used, stated: made, segments };
      const issues = validateLine(line).filter((issue) => issue.code !== 'E_INC_INFEASIBLE' && issue.code !== 'E_DEC_INFEASIBLE');
      expect(issues).toEqual([]);
      expect(codes(validateLine(line, { docKind: kind === 'row' ? '3d' : '2d' })).includes('E_ROUNDTRIP')).toBe(false);
      const wrong = codes(validateLine({ ...line, stated: made + 1 }));
      expect(wrong.includes('E_PRODUCE')).toBe(true);
      expect(wrong.includes('E_ROUNDTRIP')).toBe(false);
      checked++;
    }
    expect(checked).toBe(3000);
  });
});

describe('issues', () => {
  it('are frozen, carry severity error, and say where', () => {
    const issues = validateLine(rnd(3, parseBody('(sc, inc) x 6'), 13, { stated: 19 }), { piece: 'body' });
    expect(issues.length).toBe(2);
    for (const issue of issues) {
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.where)).toBe(true);
      expect(issue.severity).toBe('error');
      expect(issue.where).toEqual({ piece: 'body', line: 3 });
      expect(issue.message.startsWith('Rnd 3: ')).toBe(true);
      expect(() => {
        (issue as { code: string }).code = 'W_X';
      }).toThrow(TypeError);
    }
    expect(validateLine(rnd(3, parseBody('(sc, inc) x 6'), 13))[0].where).toEqual({ line: 3 });
  });

  it('the returned array belongs to the caller', () => {
    const issues = validateLine(rnd(3, parseBody('(sc, inc) x 6'), 13));
    issues.push({ code: 'W_TEST', severity: 'warn', message: 'mine' });
    expect(issues.length).toBe(2);
    expect(validateLine(rnd(3, parseBody('(sc, inc) x 6'), 12))).toEqual([]);
  });

  it('name rows, rounds and folded ranges in their messages', () => {
    expect(validateLine(row(4, times(5, sc), 6, { start: { k: 'turn', chains: 1 } }))[0].message.startsWith('Row 4: ')).toBe(true);
    expect(validateLine(rnd(7, times(36, sc), 35, { nEnd: 12 }))[0].message.startsWith('Rnds 7–12: ')).toBe(true);
    const border: Line = { kind: 'border', n: 2, start: { k: 'join' }, ops: times(20, sc), prevCount: 21, stated: 20, join: {} };
    expect(validateLine(border)[0].message.startsWith('Rnd 2: ')).toBe(true);
  });

  it('does not change the line it checks', () => {
    const line = rnd(4, parseBody('sc, inc, (2 sc, inc) x 5, sc'), 18, { segments: [{ at: 0, kind: 'end' }, { at: 9, kind: 'side' }] });
    const before = JSON.stringify(line);
    validateLine(line, { palette: ['A'], piece: 'p' });
    expect(JSON.stringify(line)).toBe(before);
  });
});
