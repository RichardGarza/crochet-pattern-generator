import { beforeEach, describe, expect, it } from 'vitest';
import type { Line, LineStart, Op } from '../../../types';
import {
  chainOvalSide,
  compactBody,
  compactCount,
  compactEncodeMode,
  compactFoundation,
  compactItems,
  compactLabel,
  isJoinedHead,
  lineItems,
  renderCompactLine,
  sharedLoop,
} from '../compact';
import { mulberry32 } from '../../kernel/prng';
import { canonicalCompact, encodeOps, expand, resetEncodeMemo } from '../encode';
import { type CompactNames, consumed, displayOps } from '../ops';
import { validateLine } from '../validateLine';
import { colored, dc, dec, dec3, foldPlain, hdc, inc, inc3, inLoop, parseBody, placeRound, plain, rnd, row, sc, slst, spiralLines, tile, times } from './helpers';

beforeEach(() => {
  resetEncodeMemo();
});

const SPHERE_K6 = [6, 12, 18, 24, 30, 36, 36, 36, 36, 36, 36, 36, 30, 24, 18, 12, 6];

describe('amigurumi rounds (§2.10.8, §2.10.11)', () => {
  it('DESIGN §2.10.8 golden text: the textbook sphere, k = 6 — must match exactly', () => {
    const lines = foldPlain(spiralLines(SPHERE_K6));
    expect(lines.map((line) => renderCompactLine(line))).toEqual([
      'Rnd 1: 6 sc in MR (6)',
      'Rnd 2: inc in each st around (12)',
      'Rnd 3: (sc, inc) x 6 (18)',
      'Rnd 4: (sc, inc, sc) x 6 (24)',
      'Rnd 5: (3 sc, inc) x 6 (30)',
      'Rnd 6: (2 sc, inc, 2 sc) x 6 (36)',
      'Rnds 7–12 (6 rnds): sc in each st around (36)',
      'Rnd 13: (4 sc, dec) x 6 (30)',
      'Rnd 14: (sc, dec, 2 sc) x 6 (24)',
      'Rnd 15: (2 sc, dec) x 6 (18)',
      'Rnd 16: (dec, sc) x 6 (12)',
      'Rnd 17: dec around (6)',
    ]);
  });

  it('research 07 §6.6: the 13-round sphere with alternating phase', () => {
    const lines = foldPlain(spiralLines([6, 12, 18, 24, 30, 36, 36, 36, 30, 24, 18, 12, 6]));
    expect(lines.map((line) => renderCompactLine(line))).toEqual([
      'Rnd 1: 6 sc in MR (6)',
      'Rnd 2: inc in each st around (12)',
      'Rnd 3: (sc, inc) x 6 (18)',
      'Rnd 4: (sc, inc, sc) x 6 (24)',
      'Rnd 5: (3 sc, inc) x 6 (30)',
      'Rnd 6: (2 sc, inc, 2 sc) x 6 (36)',
      'Rnds 7–8 (2 rnds): sc in each st around (36)',
      'Rnd 9: (4 sc, dec) x 6 (30)',
      'Rnd 10: (sc, dec, 2 sc) x 6 (24)',
      'Rnd 11: (2 sc, dec) x 6 (18)',
      'Rnd 12: (dec, sc) x 6 (12)',
      'Rnd 13: dec around (6)',
    ]);
  });

  it('DESIGN §2.10.8: the staggered round sc, inc, (2 sc, inc) x 5, sc prints as (sc, inc, sc) x 6', () => {
    const staggered = parseBody('sc, inc, (2 sc, inc) x 5, sc');
    expect(staggered).toEqual(placeRound(18, 24, 2));
    expect(renderCompactLine(rnd(4, staggered, 18))).toBe('Rnd 4: (sc, inc, sc) x 6 (24)');
  });

  it('research 07 §6.3: Rnds 7–10 (4 rnds): sc in each st around (36)', () => {
    expect(renderCompactLine(rnd(7, times(36, sc), 36, { nEnd: 10 }))).toBe('Rnds 7–10 (4 rnds): sc in each st around (36)');
  });

  it('DESIGN §2.10.5 golden text: the closed cylinder ⌀1.5 × 2, Rnds 4–15 (jogless prep, BLO sc2tog)', () => {
    const lines: Line[] = [
      rnd(4, parseBody('(sc, inc, sc) x 5, sc, inc, sl st'), 18),
      rnd(5, inLoop(times(24, sc), 'BLO'), 24),
      rnd(6, times(24, sc), 24, { nEnd: 13 }),
      rnd(14, [...times(23, sc), slst], 24),
      rnd(15, inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'), 24),
    ];
    expect(lines.map((line) => renderCompactLine(line))).toEqual([
      'Rnd 4: sc, (inc, 2 sc) x 5, inc, sl st (24)',
      'Rnd 5: BLO sc in each st around (24)',
      'Rnds 6–13 (8 rnds): sc in each st around (24)',
      'Rnd 14: 23 sc, sl st (24)',
      'Rnd 15: BLO (2 sc, sc2tog) x 6 (18)',
    ]);
  });

  it('DESIGN §2.10.6: Rnd 1: 6 sc in MR (6), for any ring size', () => {
    expect(renderCompactLine(rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }))).toBe('Rnd 1: 6 sc in MR (6)');
    expect(renderCompactLine(rnd(1, times(8, sc), null, { start: { k: 'mr', n: 8 } }))).toBe('Rnd 1: 8 sc in MR (8)');
    expect(renderCompactLine(rnd(1, times(5, sc), null, { start: { k: 'mr', n: 5 }, colorHeader: 'B' }))).toBe('Rnd 1 (B): 5 sc in MR (5)');
  });

  it('DESIGN §2.11.2: spots — Rnd 1: 6 sc in MR (6); Rnd 2: inc in each st around (12)', () => {
    const lines = spiralLines([6, 12]);
    expect(lines.map((line) => renderCompactLine(line)).join('; ')).toBe('Rnd 1: 6 sc in MR (6); Rnd 2: inc in each st around (12)');
  });

  it('DESIGN §2.10.11: single-color rounds in multi-color pieces print "Rnd 9 (B): …"', () => {
    expect(renderCompactLine(rnd(9, times(36, sc), 36, { colorHeader: 'B' }))).toBe('Rnd 9 (B): sc in each st around (36)');
    // The header carries the color, also when the ops are tagged with it.
    expect(renderCompactLine(rnd(9, times(36, colored(sc, 'B')), 36, { colorHeader: 'B' }))).toBe('Rnd 9 (B): sc in each st around (36)');
    expect(renderCompactLine(rnd(9, times(6, colored(sc, 'B'), colored(inc, 'B')), 12, { colorHeader: 'B' }))).toBe('Rnd 9 (B): (sc, inc) x 6 (18)');
    expect(renderCompactLine(rnd(10, times(36, sc), 36, { colorHeader: 'B', nEnd: 12 }))).toBe('Rnds 10–12 (B, 3 rnds): sc in each st around (36)');
    // Ops tagged with the header color and untagged ops print alike, so they are one run, not "18 sc, 18 sc".
    expect(renderCompactLine(rnd(9, [...times(18, colored(sc, 'B')), ...times(18, sc)], 36, { colorHeader: 'B' }))).toBe('Rnd 9 (B): sc in each st around (36)');
    // Another color inside a headed round keeps its tag.
    expect(renderCompactLine(rnd(9, [...times(30, colored(sc, 'B')), ...times(6, colored(sc, 'A'))], 36, { colorHeader: 'B' }))).toBe('Rnd 9 (B): 30 sc, 6 sc A (36)');
  });

  it('DESIGN §2.10.11 / §2.11.2: multicolor rounds tag runs — (4 sc A, 2 sc B) x 6 (36), (3 sc A, 2 sc B) x 6 (30)', () => {
    const a = colored(sc, 'A');
    const b = colored(sc, 'B');
    expect(renderCompactLine(rnd(12, times(6, a, a, a, a, b, b), 36))).toBe('Rnd 12: (4 sc A, 2 sc B) x 6 (36)');
    expect(renderCompactLine(rnd(12, times(6, a, a, a, b, b), 30))).toBe('Rnd 12: (3 sc A, 2 sc B) x 6 (30)');
    // One color on every op but no header: the tag stays, so no whole-line phrase.
    expect(renderCompactLine(rnd(12, times(36, b), 36))).toBe('Rnd 12: 36 sc B (36)');
    expect(renderCompactLine(rnd(12, times(6, a, colored(inc, 'B')), 12))).toBe('Rnd 12: (sc A, inc B) x 6 (18)');
  });

  it('color cues print after the count (§2.10.11: "change to B on the last yo" on the round before)', () => {
    const line = rnd(8, times(36, sc), 36, { cues: [{ kind: 'color', text: 'change to B on the last yo' }, { kind: 'stuff', text: 'Begin stuffing after Rnd 8' }] });
    expect(renderCompactLine(line)).toBe('Rnd 8: sc in each st around (36) · change to B on the last yo');
  });

  it('whole-line phrases (§2.6.1 post-rules) for every op, and only when the line is one op', () => {
    expect(compactBody(rnd(2, times(6, inc), 6))).toBe('inc in each st around');
    expect(compactBody(rnd(2, times(6, dec), 12))).toBe('dec around');
    expect(compactBody(rnd(2, times(12, sc), 12))).toBe('sc in each st around');
    expect(compactBody(rnd(2, times(6, inc3), 6))).toBe('inc3 in each st around');
    expect(compactBody(rnd(2, times(4, { k: 'dec', n: 3 }), 12))).toBe('dec3 around');
    expect(compactBody(rnd(2, times(12, hdc), 12))).toBe('hdc in each st around');
    expect(compactBody(rnd(2, times(12, slst), 12))).toBe('sl st in each st around');
    expect(compactBody(rnd(2, inLoop(times(6, dec), 'BLO'), 12))).toBe('BLO sc2tog around');
    expect(compactBody(rnd(2, inLoop(times(6, inc), 'FLO'), 6))).toBe('FLO inc in each st around');
    expect(compactBody(rnd(2, [sc], 1))).toBe('sc in each st around');
    expect(compactBody(rnd(2, [...times(11, sc), inc], 12))).toBe('11 sc, inc');
  });

  it('N op = op in each of the next N sts, for every op (§2.10.11; research 07 §7.5: inc ×N = "N inc")', () => {
    // research 07 §7.6 vector 5 (AmiGo): 6 inc, sc, inc.
    expect(renderCompactLine(rnd(2, parseBody('6 inc, sc, inc'), 8))).toBe('Rnd 2: 6 inc, sc, inc (15)');
    expect(compactBody(rnd(3, parseBody('2 dec, 3 sc, 2 inc3, sl st'), 10))).toBe('2 dec, 3 sc, 2 inc3, sl st');
  });

  it('BLO/FLO: a prefix when every op shares the loop, a tag per run otherwise; dec is sc2tog in the loop', () => {
    const blo: Op = { k: 'st', st: 'sc', loop: 'BLO' };
    // §2.10.5 horn, Rnd 4 (19 → 17, changeIdx 2): "8 sc, dec, 7 sc, dec" rotated left by ceil(7/2) = 4 —
    // "written BLO (…, sc2tog) …".
    expect(inLoop(placeRound(19, 17, 2), 'BLO')).toEqual(inLoop(parseBody('4 sc, dec, 7 sc, dec, 4 sc'), 'BLO'));
    expect(renderCompactLine(rnd(4, inLoop(placeRound(19, 17, 2), 'BLO'), 19))).toBe('Rnd 4: BLO (4 sc, sc2tog, 3 sc) x 2, sc (17)');
    expect(compactBody(rnd(5, inLoop(parseBody('3 sc, dec, sc, inc, 2 sc'), 'BLO'), 9))).toBe('BLO 3 sc, sc2tog, sc, inc, 2 sc');
    expect(compactBody(rnd(5, inLoop(times(24, sc), 'FLO'), 24))).toBe('FLO sc in each st around');
    expect(compactBody(rnd(5, [...times(3, blo), ...times(2, sc)], 5))).toBe('3 sc BLO, 2 sc');
    expect(compactBody(rnd(5, [blo, { k: 'dec', n: 2, loop: 'BLO' }, sc], 4))).toBe('sc BLO, sc2tog BLO, sc');
    expect(compactBody(rnd(5, [blo, { k: 'st', st: 'sc', loop: 'FLO' }], 2))).toBe('sc BLO, sc FLO');
    expect(compactBody(rnd(5, times(24, { k: 'st', st: 'sc', loop: 'both' }), 24))).toBe('sc in each st around');
    expect(renderCompactLine(rnd(5, inLoop(times(24, sc), 'BLO'), 24, { colorHeader: 'B' }))).toBe('Rnd 5 (B): BLO sc in each st around (24)');
  });

  it('sharedLoop: BLO or FLO when every op shares it, else undefined', () => {
    expect(sharedLoop(inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'))).toBe('BLO');
    expect(sharedLoop(inLoop(times(3, inc), 'FLO'))).toBe('FLO');
    expect(sharedLoop([...inLoop(times(3, sc), 'BLO'), sc])).toBeUndefined();
    expect(sharedLoop([{ k: 'st', st: 'sc', loop: 'BLO' }, { k: 'st', st: 'sc', loop: 'FLO' }])).toBeUndefined();
    expect(sharedLoop([{ k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' }])).toBeUndefined(); // the mosaic long dc
    expect(sharedLoop(times(3, { k: 'st', st: 'sc', loop: 'both' }))).toBeUndefined();
    expect(sharedLoop([tile('A')])).toBeUndefined();
    expect(sharedLoop([])).toBeUndefined();
  });

  it('loop "both" prints as no loop, so it never splits a run ("18 sc, 18 sc") or a repeat', () => {
    const both: Op = { k: 'st', st: 'sc', loop: 'both' };
    expect(compactBody(rnd(5, [...times(18, sc), ...times(18, both)], 36))).toBe('sc in each st around');
    expect(compactBody(rnd(5, [...times(3, sc, inc), ...times(3, both, { k: 'inc', n: 2, loop: 'both' })], 12))).toBe('(sc, inc) x 6');
  });
});

describe('the printed text is the line: read back with the independent parser of the tests (R10)', () => {
  const alphabet: Op[] = [
    sc,
    inc,
    dec,
    slst,
    hdc,
    inc3,
    { k: 'dec', n: 3 },
    colored(sc, 'A'),
    colored(sc, 'B'),
    { k: 'st', st: 'sc', loop: 'BLO' },
    { k: 'dec', n: 2, loop: 'BLO' },
    colored(inc, 'A'),
    { k: 'st', st: 'sc', loop: 'both' },
    { k: 'st', st: 'dc', loop: 'FLO', color: 'B' },
    { k: 'st', st: 'dc', into: 'flo2below' },
    { k: 'st', st: 'dc', into: 'flo2below', loop: 'FLO' }, // prints as the one before: the loop is in its name
    { k: 'st', st: 'dc', into: 'flo2below', color: 'A' },
  ];

  /** Random ops: repeated blocks of a random part of the alphabet, or every third line a BLO / FLO round. */
  function randomLine(rng: () => number, i: number): Op[] {
    const pick = (size: number): Op => ({ ...alphabet[Math.floor(rng() * size)] });
    const size = 1 + Math.floor(rng() * alphabet.length);
    const length = 1 + Math.floor(rng() * (i % 10 === 0 ? 300 : 40));
    if (i % 3 === 0) {
      const loop = rng() < 0.5 ? 'BLO' : 'FLO';
      return inLoop(Array.from({ length }, () => pick(Math.min(size, 7))), loop); // a BLO / FLO round
    }
    const ops: Op[] = [];
    while (ops.length < length) {
      const block = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => pick(size));
      for (let r = 1 + Math.floor(rng() * 5); r > 0; r--) ops.push(...block.map((op) => ({ ...op })));
    }
    return ops.slice(0, length);
  }

  it('random rounds and rows with colors, header colors, loops, shared loops, long stitches and segments', { timeout: 60_000 }, () => {
    const rng = mulberry32(2024);
    for (let i = 0; i < 3000; i++) {
      const ops = randomLine(rng, i);
      const segments: Line['segments'] =
        i % 6 === 0 && ops.length > 3 ? [{ at: 0, kind: 'end' }, { at: Math.floor(ops.length / 3), kind: 'side' }, { at: Math.floor((2 * ops.length) / 3), kind: 'end' }] : undefined;
      const line: Line = { kind: i % 5 === 0 ? 'row' : 'rnd', n: 5, ops, prevCount: consumed(ops), stated: 1, colorHeader: i % 4 === 0 ? 'B' : undefined, segments };
      const body = compactBody(line, { docKind: i % 7 === 0 ? '2d' : '3d' });
      expect([body, parseBody(body, consumed(ops))]).toStrictEqual([body, displayOps(line)]);
    }
  });

  it('random joined rounds of an amigurumi pattern (§2.11.3): the head op, then the rest as lineItems encodes it', { timeout: 60_000 }, () => {
    const rng = mulberry32(2025);
    const joined = /^Ch 1 \(does not count\), (?:(BLO|FLO) )?(.+?) (?:in same st as join|over same st as join and next (?:st|2 sts))(?:, (.+))?; (?:join with sl st in first (?:sc|hdc|dc)\.|do not join — continue in a spiral\.)$/;
    for (let i = 0; i < 1500; i++) {
      const ops = randomLine(rng, i);
      const segments: Line['segments'] = i % 6 === 0 && ops.length > 3 ? [{ at: 0, kind: 'end' }, { at: 1, kind: 'side' }, { at: Math.floor(ops.length / 2), kind: 'end' }] : undefined;
      const line: Line = { kind: 'rnd', n: 9, ops, prevCount: consumed(ops), stated: 1, start: { k: 'join' }, join: i % 2 === 0 ? {} : undefined, colorHeader: i % 4 === 0 ? 'B' : undefined, segments };
      const body = compactBody(line);
      const match = joined.exec(body);
      expect(match, body).not.toBeNull();
      if (match === null) continue;
      const head = parseBody(match[2]);
      expect(head).toHaveLength(1);
      let read = [...head, ...(match[3] === undefined ? [] : parseBody(match[3]))];
      if (match[1] !== undefined) read = inLoop(read, match[1] as 'BLO' | 'FLO');
      expect([body, read]).toStrictEqual([body, displayOps(line)]);
      const items = lineItems(line);
      expect(match[3] ?? '').toBe(compactItems(items.slice(1), { hideLoop: match[1] !== undefined }));
    }
  });
});

describe('lineItems: the encoded form every renderer prints (§2.6.1)', () => {
  const ops = parseBody('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');

  it('rounds of an amigurumi pattern per op; rows, C2C rows and borders of a chart pattern per run', () => {
    expect(canonicalCompact(lineItems(rnd(2, ops, 8)))).toBe('(sc A, 2 sc B, sc A) x 2');
    expect(canonicalCompact(lineItems(row(2, ops, 8)))).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(canonicalCompact(lineItems({ kind: 'border', ops }))).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(canonicalCompact(lineItems({ kind: 'c2c', ops: parseBody('1 A, 2 B, 2 A, 2 B, 1 A') }))).toBe('1 A, 2 B, 2 A, 2 B, 1 A');
    // docKind overrides the default: a tapestry round is per run, a flat appliqué row in a 3D pattern per op.
    expect(canonicalCompact(lineItems(rnd(2, ops, 8), { docKind: '2d' }))).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(canonicalCompact(lineItems(row(2, ops, 8), { docKind: '3d' }))).toBe('(sc A, 2 sc B, sc A) x 2');
  });

  it('encodes the ops as printed (no loop "both", no header color) and passes Line.segments', () => {
    const headed = rnd(9, [...times(3, colored(sc, 'B'), { k: 'inc', n: 2, color: 'B', loop: 'both' })], 6, { colorHeader: 'B' });
    expect(plain(lineItems(headed))).toEqual([{ kind: 'rep', times: 3, inner: [{ kind: 'run', op: sc, n: 1 }, { kind: 'run', op: inc, n: 1 }] }]);
    const rnd3 = parseBody('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
    const segments: Line['segments'] = [
      { at: 0, kind: 'end' },
      { at: 2, kind: 'side' },
      { at: 9, kind: 'end' },
      { at: 15, kind: 'side' },
      { at: 22, kind: 'end' },
    ];
    expect(canonicalCompact(lineItems(rnd(3, rnd3, 26, { segments })))).toBe('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
    expect(expand(lineItems(rnd(3, rnd3, 26, { segments })))).toStrictEqual(rnd3);
  });

  it('a joined round of an amigurumi pattern: the op worked in the same st as the join, then the rest encoded on its own (§2.11.3)', () => {
    const ops = parseBody('(dec, sc) x 6');
    const line = rnd(16, ops, 18, { start: { k: 'join' }, join: {} });
    const items = lineItems(line);
    expect(isJoinedHead(line)).toBe(true);
    expect(canonicalCompact(items)).toBe('dec, (sc, dec) x 5, sc');
    expect(items[0]).toEqual({ kind: 'run', op: dec, n: 1 });
    expect(Object.isFrozen(items)).toBe(true);
    expect(expand(items)).toStrictEqual(ops);
    expect(compactBody(line)).toBe(`Ch 1 (does not count), dec over same st as join and next st, ${compactItems(items.slice(1))}; join with sl st in first sc.`);
    // A chart pattern's joined round is not split (`Ch 1, {runs}`), and neither is a spiral round.
    expect(isJoinedHead(line, { docKind: '2d' })).toBe(false);
    expect(canonicalCompact(lineItems(line, { docKind: '2d' }))).toBe(canonicalCompact(encodeOps(ops, { mode: 'runs' })));
    expect(canonicalCompact(lineItems(rnd(16, ops, 18)))).toBe('(dec, sc) x 6');
    expect(isJoinedHead(rnd(16, [], 18, { start: { k: 'join' } }))).toBe(false);
  });

  it('mosaic long stitches with and without loop "FLO" print alike, so they fold into one run (§2.7.8)', () => {
    const long: Op = { k: 'st', st: 'dc', into: 'flo2below' };
    const line = row(3, [sc, { ...long, loop: 'FLO' }, long, { ...long, loop: 'FLO' }, sc], 5, { side: 'RS', arrow: '←', start: { k: 'turn', chains: 1 } });
    expect(canonicalCompact(lineItems(line))).toBe('sc, 3 dc FLO 2 rows below, sc');
    expect(renderCompactLine(line)).toBe('Row 3 (RS) ←: Ch 1, turn. sc, 3 dc FLO 2 rows below, sc (5 sts)');
  });

  it('is what compactBody prints, and the same frozen result on every call (memo)', () => {
    const line = rnd(4, parseBody('sc, inc, (2 sc, inc) x 5, sc'), 18);
    expect(compactBody(line)).toBe(compactItems(lineItems(line)));
    expect(lineItems(line)).toBe(lineItems(line));
    expect(compactItems(lineItems({ kind: 'c2c', ops: [tile('A'), tile('B')] }))).toBe('1 A, 1 B');
  });
});

describe('ovals worked around a chain (§2.10.6, research 07 §6.9)', () => {
  const ovalRnd1 = (n: number): Line => rnd(1, [...times(n - 2, sc), inc3, ...times(n - 3, sc), inc], null, { start: { k: 'chainOval', chains: n } });

  it('research 07 §6.9: Ch 10. Rnd 1: sc in 2nd ch from hook, sc in next 7 ch, 3 sc in last ch; … (20)', () => {
    const line = ovalRnd1(10);
    expect(compactFoundation(line)).toBe('Ch 10.');
    expect(renderCompactLine(line)).toBe(
      'Rnd 1: sc in 2nd ch from hook, sc in next 7 ch, 3 sc in last ch; working along the other side of the chain, sc in next 7 ch, 2 sc in last ch (20)',
    );
  });

  it('DESIGN §2.10.6: "sc in next N−3 ch … (2N)" for other chains', () => {
    expect(renderCompactLine(ovalRnd1(6))).toBe(
      'Rnd 1: sc in 2nd ch from hook, sc in next 3 ch, 3 sc in last ch; working along the other side of the chain, sc in next 3 ch, 2 sc in last ch (12)',
    );
    expect(renderCompactLine(ovalRnd1(4))).toBe(
      'Rnd 1: sc in 2nd ch from hook, sc in next ch, 3 sc in last ch; working along the other side of the chain, sc in next ch, 2 sc in last ch (8)',
    );
    expect(renderCompactLine(ovalRnd1(3))).toBe('Rnd 1: sc in 2nd ch from hook, 3 sc in last ch; working along the other side of the chain, 2 sc in last ch (6)');
    expect(renderCompactLine({ ...ovalRnd1(8), colorHeader: 'C' })).toBe(
      'Rnd 1 (C): sc in 2nd ch from hook, sc in next 5 ch, 3 sc in last ch; working along the other side of the chain, sc in next 5 ch, 2 sc in last ch (16)',
    );
    expect(compactFoundation({ ...ovalRnd1(8), colorHeader: 'C' })).toBe('With C, ch 8.');
  });

  it('research 07 §6.9 / §7.6 vector 14: Rnd 3 keeps its segments', () => {
    const ops = parseBody('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
    const segments: Line['segments'] = [
      { at: 0, kind: 'end' },
      { at: 2, kind: 'side' },
      { at: 9, kind: 'end' },
      { at: 15, kind: 'side' },
      { at: 22, kind: 'end' },
    ];
    expect(renderCompactLine(rnd(3, ops, 26, { segments }))).toBe('Rnd 3: sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2 (32)');
    expect(renderCompactLine(rnd(3, ops, 26))).toBe('Rnd 3: (sc, inc, 8 sc, inc, sc, inc) x 2 (32)');
  });

  it('Rnd 2 keeps its segments; runs of inc print as "N inc" (research 07 §7.5), not "inc in next N sts" (07 §6.9)', () => {
    const ops = [inc, ...times(7, sc), ...times(3, inc), ...times(7, sc), ...times(2, inc)];
    const segments: Line['segments'] = [
      { at: 0, kind: 'end' },
      { at: 1, kind: 'side' },
      { at: 8, kind: 'end' },
      { at: 11, kind: 'side' },
      { at: 18, kind: 'end' },
    ];
    expect(renderCompactLine(rnd(2, ops, 20, { segments }))).toBe('Rnd 2: inc, 7 sc, 3 inc, 7 sc, 2 inc (26)');
  });

  it('segments stay visible: runs that meet at a boundary are not merged (§2.6.1 "encoded separately and joined")', () => {
    // Started at center back, in the middle of a side (§2.10.2): side | end | side | end | side, 28 → 32.
    const ops = parseBody('4 sc, 3 sc, inc, 2 sc, inc, 7 sc, 3 sc, inc, 2 sc, inc, 3 sc');
    const segments: Line['segments'] = [
      { at: 0, kind: 'side' },
      { at: 4, kind: 'end' },
      { at: 11, kind: 'side' },
      { at: 18, kind: 'end' },
      { at: 25, kind: 'side' },
    ];
    expect(renderCompactLine(rnd(5, ops, 28, { segments }))).toBe('Rnd 5: 4 sc, sc, (2 sc, inc) x 2, 7 sc, sc, (2 sc, inc) x 2, 3 sc (32)');
    expect(renderCompactLine(rnd(5, ops, 28))).toBe('Rnd 5: (7 sc, inc, 2 sc, inc, 3 sc) x 2 (32)');
  });

  it('a plain oval round with segments is still "sc in each st around"', () => {
    const segments: Line['segments'] = [
      { at: 0, kind: 'end' },
      { at: 3, kind: 'side' },
      { at: 10, kind: 'end' },
    ];
    expect(renderCompactLine(rnd(4, times(32, sc), 32, { segments }))).toBe('Rnd 4: sc in each st around (32)');
  });

  it('chainOvalSide: S of the canonical Rnd 1, or null (the sentence is printed only for that round)', () => {
    for (const n of [3, 4, 10, 15]) expect(chainOvalSide([...times(n - 2, sc), inc3, ...times(n - 3, sc), inc])).toBe(n - 3);
    expect(chainOvalSide([...times(8, sc), inc3, ...times(6, sc), inc])).toBeNull(); // sides differ
    expect(chainOvalSide([...times(8, sc), inc, ...times(7, sc), inc3])).toBeNull(); // ends swapped
    expect(chainOvalSide([...times(8, sc), inc3, ...times(7, sc), inc, sc])).toBeNull();
    expect(chainOvalSide([...times(8, colored(sc, 'B')), inc3, ...times(7, sc), inc])).toBeNull(); // a tag to print
    expect(chainOvalSide(inLoop([...times(8, sc), inc3, ...times(7, sc), inc], 'BLO'))).toBeNull();
    expect(chainOvalSide(times(17, sc))).toBeNull();
    expect(chainOvalSide([])).toBeNull();
  });

  it('a chain-oval line with other ops prints them as they are', () => {
    const line = rnd(1, [...times(8, hdc), inc3, ...times(7, hdc), inc], null, { start: { k: 'chainOval', chains: 10 } });
    expect(renderCompactLine(line)).toBe('Rnd 1: 8 hdc, inc3, 7 hdc, inc (20)');
  });

  it('a chain ring in a spiral piece (torus, §2.10.4)', () => {
    const line = rnd(1, times(24, sc), null, { start: { k: 'chainRing', chains: 24 } });
    expect(compactFoundation(line)).toBe('Ch 24; join with sl st in first ch to form a ring (do not twist).');
    expect(renderCompactLine(line)).toBe('Rnd 1: sc in each ch around (24)');
  });
});

describe('joined rounds in a spiral piece (§2.11.3 template)', () => {
  it('Rnd a (A): {ops}; join with sl st in first sc, changing to B. (n)', () => {
    const line = rnd(7, times(36, sc), 36, { colorHeader: 'A', join: { changeTo: 'B' } });
    expect(renderCompactLine(line)).toBe('Rnd 7 (A): sc in each st around; join with sl st in first sc, changing to B. (36)');
  });

  it('Rnd a+1 (B): Ch 1 (does not count), sc in same st as join, {ops of the rest of the round}; join … (n)', () => {
    const plainRound = rnd(8, times(36, sc), 36, { colorHeader: 'B', start: { k: 'join' }, join: { changeTo: 'A', drop: 'carry' } });
    expect(renderCompactLine(plainRound)).toBe('Rnd 8 (B): Ch 1 (does not count), sc in same st as join, 35 sc; join with sl st in first sc, changing to A. (36)');
    // A shaped joined round starts with a plain sc (§2.10.8 override); the rest is encoded on its own.
    const shaped = rnd(9, parseBody('(2 sc, inc, 2 sc) x 6'), 30, { colorHeader: 'A', start: { k: 'join' }, join: {} });
    expect(renderCompactLine(shaped)).toBe('Rnd 9 (A): Ch 1 (does not count), sc in same st as join, sc, (inc, 4 sc) x 5, inc, 2 sc; join with sl st in first sc. (36)');
  });

  it('Rnd b+1: Ch 1 (does not count), sc in same st as join, {ops}; do not join — continue in a spiral. (n)', () => {
    const line = rnd(11, times(36, sc), 36, { start: { k: 'join' } });
    expect(renderCompactLine(line)).toBe('Rnd 11: Ch 1 (does not count), sc in same st as join, 35 sc; do not join — continue in a spiral. (36)');
  });

  it('a round that cannot start with a plain sc (g = 0) opens with its first op, in the template form of Rnd a+1 (notes: §2.11.3 fallback)', () => {
    // §2.11.3 / §2.10.8 abbreviate this opening as "Ch 1, inc in same st as join, …"; the kernel keeps the
    // template's "Ch 1 (does not count), " so every joined round of an amigurumi pattern opens alike.
    const line = rnd(8, times(6, inc), 6, { start: { k: 'join' }, join: {} });
    expect(renderCompactLine(line)).toBe('Rnd 8: Ch 1 (does not count), inc in same st as join, 5 inc; join with sl st in first sc. (12)');
  });

  it('a decrease first is worked over the join st and the next one (a dec takes two sts, a dec3 three)', () => {
    const decs = rnd(17, times(6, dec), 12, { start: { k: 'join' }, join: {} });
    expect(validateLine(decs)).toEqual([]);
    expect(renderCompactLine(decs)).toBe('Rnd 17: Ch 1 (does not count), dec over same st as join and next st, 5 dec; join with sl st in first sc. (6)');
    const dec3s = rnd(18, times(4, dec3), 12, { start: { k: 'join' }, join: {} });
    expect(compactBody(dec3s)).toBe('Ch 1 (does not count), dec3 over same st as join and next 2 sts, 3 dec3; join with sl st in first sc.');
    const blo = rnd(19, inLoop(parseBody('(dec, sc) x 4'), 'BLO'), 12, { start: { k: 'join' }, join: {} });
    expect(compactBody(blo)).toBe('Ch 1 (does not count), BLO sc2tog over same st as join and next st, (sc, sc2tog) x 3, sc; join with sl st in first sc.');
  });

  it('segments keep their place when the first stitch is taken out', () => {
    const ops = [sc, ...times(3, sc, inc), ...times(7, sc), ...times(3, sc, inc)];
    const line = rnd(5, ops, 20, { start: { k: 'join' }, join: {}, segments: [{ at: 0, kind: 'side' }, { at: 1, kind: 'end' }, { at: 7, kind: 'side' }, { at: 14, kind: 'end' }] });
    expect(renderCompactLine(line)).toBe('Rnd 5: Ch 1 (does not count), sc in same st as join, (sc, inc) x 3, 7 sc, (sc, inc) x 3; join with sl st in first sc. (26)');
  });
});

describe('flat 2D rows (§2.7.2, §2.7.3)', () => {
  const turn: LineStart = { k: 'turn', chains: 1 };

  it('DESIGN §2.7.2: Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B', () => {
    const line = row(11, parseBody('4 sc A, 3 sc B, 33 sc A'), 40, { side: 'RS', arrow: '←', start: turn, cues: [{ kind: 'color', text: 'carry B' }] });
    expect(renderCompactLine(line)).toBe('Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B');
  });

  it('DESIGN §2.7.3 golden (G9, W = 5), right- and left-handed', () => {
    const row1 = row(1, parseBody('2 sc A, sc B, 2 sc A'), null, { side: 'RS', arrow: '←', start: { k: 'foundation', chains: 6, firstInto: 2 } });
    const row2 = row(2, parseBody('sc A, 3 sc B, sc A'), 5, { side: 'WS', arrow: '→', start: turn });
    const row3 = row(3, parseBody('4 sc A, sc B'), 5, { side: 'RS', arrow: '←', start: turn });
    const row3Left = row(3, parseBody('sc B, 4 sc A'), 5, { side: 'RS', arrow: '→', start: turn });
    expect(compactFoundation(row1)).toBe('Foundation: With A, ch 6.');
    expect([row1, row2, row3].map((line) => renderCompactLine(line))).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts)',
      'Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts)',
      'Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)',
    ]);
    expect(`LH ${renderCompactLine(row3Left)}`).toBe('LH Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)');
  });

  it('DESIGN §2.7.3 template: … ({W} sts)[ · join B (bobbin 2)][ · carry B]', () => {
    const line = row(4, parseBody('2 sc A, 3 sc B'), 5, {
      side: 'WS',
      arrow: '→',
      start: turn,
      cues: [{ kind: 'color', text: 'join B (bobbin 2)' }, { kind: 'note', text: 'not on this line' }, { kind: 'color', text: 'carry B' }],
    });
    expect(renderCompactLine(line)).toBe('Row 4 (WS) →: Ch 1, turn. 2 sc A, 3 sc B (5 sts) · join B (bobbin 2) · carry B');
  });

  it('a row prints its runs in the order given, one token per run, singles as "sc B" (§2.7.2)', () => {
    const ops = parseBody('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(compactBody(row(5, ops, 8, { start: turn }))).toBe('Ch 1, turn. sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(compactBody(row(5, times(40, colored(sc, 'A')), 40, { start: turn }))).toBe('Ch 1, turn. 40 sc A');
    expect(compactBody(row(5, times(10, ...times(2, colored(sc, 'A')), ...times(2, colored(sc, 'B'))), 40, { start: turn }))).toBe('Ch 1, turn. (2 sc A, 2 sc B) x 10');
  });

  it('DESIGN §2.7.7 (hdc): Starting in 3rd ch from hook … / Ch 2 (does not count as a st), turn. …', () => {
    const a = colored(hdc, 'A');
    const b = colored(hdc, 'B');
    const row1 = row(1, [a, a, b, a, a], null, { side: 'RS', arrow: '←', start: { k: 'foundation', chains: 7, firstInto: 3 } });
    const row2 = row(2, [a, b, b, b, a], 5, { side: 'WS', arrow: '→', start: { k: 'turn', chains: 2 } });
    expect(compactFoundation(row1)).toBe('Foundation: With A, ch 7.');
    expect(renderCompactLine(row1)).toBe('Row 1 (RS) ←: Starting in 3rd ch from hook, 2 hdc A, hdc B, 2 hdc A (5 sts)');
    expect(renderCompactLine(row2)).toBe('Row 2 (WS) →: Ch 2 (does not count as a st), turn. hdc A, 3 hdc B, hdc A (5 sts)');
  });

  it('rows without color tags read "sc in each st across" / "sc in each ch across" (§2.6.1 post-rules)', () => {
    const first = row(1, times(5, sc), null, { start: { k: 'foundation', chains: 6, firstInto: 2 } });
    expect(compactFoundation(first)).toBe('Foundation: Ch 6.');
    expect(renderCompactLine(first)).toBe('Row 1: Starting in 2nd ch from hook, sc in each ch across (5 sts)');
    expect(renderCompactLine(row(2, times(5, sc), 5, { start: turn }))).toBe('Row 2: Ch 1, turn. sc in each st across (5 sts)');
    // An appliqué rectangle inside an amigurumi pattern (§2.10.9) prints bare counts.
    expect(compactFoundation(first, { docKind: '3d' })).toBe('Ch 6.');
    expect(renderCompactLine(row(2, times(5, sc), 5, { start: turn }), { docKind: '3d' })).toBe('Row 2: Ch 1, turn. sc in each st across (5)');
    expect(renderCompactLine(row(3, times(5, sc), 5, { start: turn, nEnd: 6 }), { docKind: '3d' })).toBe('Rows 3–6 (4 rows): Ch 1, turn. sc in each st across (5)');
  });

  it('mosaic rows (§2.7.8): runs of "N sc BLO" and "N dc FLO 2 rows below"', () => {
    const blo: Op = { k: 'st', st: 'sc', loop: 'BLO' };
    const long: Op = { k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' };
    const ops = [sc, ...times(3, blo), long, ...times(2, blo), ...times(2, long), blo, sc];
    expect(compactItems(encodeOps(ops, { mode: 'runs' }))).toBe('sc, 3 sc BLO, dc FLO 2 rows below, 2 sc BLO, 2 dc FLO 2 rows below, sc BLO, sc');
    expect(renderCompactLine(row(5, ops, 11, { side: 'RS', arrow: '←', colorHeader: 'B' }))).toBe(
      'Row 5 (B, RS) ←: sc, 3 sc BLO, dc FLO 2 rows below, 2 sc BLO, 2 dc FLO 2 rows below, sc BLO, sc (11 sts)',
    );
  });

  it('counts are singular for one stitch', () => {
    expect(compactCount(row(1, [colored(sc, 'A')], null))).toBe('(1 st)');
    expect(compactCount(row(1, times(2, colored(sc, 'A')), null))).toBe('(2 sts)');
  });
});

describe('tapestry in joined rounds (§2.7.5)', () => {
  const runs = parseBody('3 sc A, 2 sc B, 35 sc A');
  const o = { docKind: '2d' } as const;

  it('Foundation: With A, ch {C}; join with sl st in first ch to form a ring (do not twist).', () => {
    const line = rnd(1, runs, null, { start: { k: 'chainRing', chains: 40 }, join: {} });
    expect(compactFoundation(line, o)).toBe('Foundation: With A, ch 40; join with sl st in first ch to form a ring (do not twist).');
  });

  it('Rnd 1: Ch 1 (does not count as a st), {runs}; join with sl st in first sc. ({C} sts) · carry B', () => {
    const line = rnd(1, runs, null, { start: { k: 'chainRing', chains: 40 }, join: {}, cues: [{ kind: 'color', text: 'carry B' }] });
    expect(renderCompactLine(line, o)).toBe('Rnd 1: Ch 1 (does not count as a st), 3 sc A, 2 sc B, 35 sc A; join with sl st in first sc. (40 sts) · carry B');
  });

  it('Rnd k: Ch 1, {runs}; join with sl st in first sc. ({C} sts)', () => {
    const line = rnd(2, runs, 40, { start: { k: 'join' }, join: {} });
    expect(renderCompactLine(line, o)).toBe('Rnd 2: Ch 1, 3 sc A, 2 sc B, 35 sc A; join with sl st in first sc. (40 sts)');
  });

  it('turned rounds: Rnd k (RS|WS): Ch 1, turn. {runs}; join with sl st in first sc. ({C} sts)', () => {
    const line = rnd(2, runs, 40, { side: 'WS', start: { k: 'turn', chains: 1 }, join: {} });
    expect(renderCompactLine(line, o)).toBe('Rnd 2 (WS): Ch 1, turn. 3 sc A, 2 sc B, 35 sc A; join with sl st in first sc. (40 sts)');
  });

  it("uses run tokens in a '2d' pattern, op tokens in a '3d' one", () => {
    const line = rnd(2, parseBody('sc A, 2 sc B, 2 sc A, 2 sc B, sc A'), 8);
    expect(compactEncodeMode(line)).toBe('ops');
    expect(compactEncodeMode(line, o)).toBe('runs');
    expect(compactEncodeMode(row(2, [], 8))).toBe('runs');
    expect(compactEncodeMode(row(2, [], 8), { docKind: '3d' })).toBe('ops');
    expect(compactBody(line, o)).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(compactBody(line)).toBe('(sc A, 2 sc B, sc A) x 2');
  });
});

describe('C2C rows (§2.7.6)', () => {
  const c2c = (n: number, arrow: Line['arrow'], start: 'first' | 'inc' | 'dec', end: 'first' | 'inc' | 'dec', tiles: string, prev: number | null): Line => {
    const ops = parseBody(tiles);
    return { kind: 'c2c', n, side: n % 2 === 1 ? 'RS' : 'WS', arrow, start: { k: 'c2c', start, end }, ops, prevCount: prev, stated: ops.length };
  };

  it('DESIGN §2.7.6 golden 5 × 3, RH start bottom-right', () => {
    const lines = [
      c2c(1, '↙', 'first', 'first', '1 A', null),
      c2c(2, '↗', 'inc', 'inc', '2 A', 1),
      c2c(3, '↙', 'inc', 'inc', '1 A, 2 B', 2),
      c2c(4, '↗', 'inc', 'dec', '1 A, 1 B, 1 A', 3),
      c2c(5, '↙', 'dec', 'inc', '1 A, 1 B, 1 A', 3),
      c2c(6, '↗', 'dec', 'dec', '2 A', 3),
      c2c(7, '↙', 'dec', 'dec', '1 B', 2),
    ];
    expect(lines.map((line) => renderCompactLine(line))).toEqual([
      '↙ Row 1 (RS) [first tile]: 1 A (1 tile)',
      '↗ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)',
      '↙ Row 3 (RS) [inc beg · inc end]: 1 A, 2 B (3 tiles)',
      '↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)',
      '↙ Row 5 (RS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)',
      '↗ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)',
      '↙ Row 7 (RS) [dec beg · dec end]: 1 B (1 tile)',
    ]);
  });

  it('DESIGN §2.7.6 golden 5 × 3, RH start bottom-left (chart rotated 90° CCW)', () => {
    const lines = [
      c2c(1, '↖', 'first', 'first', '1 A', null),
      c2c(2, '↘', 'inc', 'inc', '2 A', 1),
      c2c(3, '↖', 'inc', 'inc', '3 B', 2),
      c2c(4, '↘', 'dec', 'inc', '1 A, 1 B, 1 A', 3),
      c2c(5, '↖', 'inc', 'dec', '1 A, 1 B, 1 A', 3),
      c2c(6, '↘', 'dec', 'dec', '2 A', 3),
      c2c(7, '↖', 'dec', 'dec', '1 A', 2),
    ];
    expect(lines.map((line) => renderCompactLine(line))).toEqual([
      '↖ Row 1 (RS) [first tile]: 1 A (1 tile)',
      '↘ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)',
      '↖ Row 3 (RS) [inc beg · inc end]: 3 B (3 tiles)',
      '↘ Row 4 (WS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)',
      '↖ Row 5 (RS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)',
      '↘ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)',
      '↖ Row 7 (RS) [dec beg · dec end]: 1 A (1 tile)',
    ]);
  });

  it('runs always print a count, and a periodic row folds', () => {
    const line = c2c(10, '↗', 'inc', 'inc', '(1 A, 1 B) x 5', 9);
    expect(renderCompactLine(line)).toBe('↗ Row 10 (WS) [inc beg · inc end]: (1 A, 1 B) x 5 (10 tiles)');
    expect(renderCompactLine(c2c(60, '↗', 'inc', 'dec', '60 A', 60))).toBe('↗ Row 60 (WS) [inc beg · dec end]: 60 A (60 tiles)');
  });
});

describe('borders and options', () => {
  it('a border round prints generically (T2 writes the sentences of §2.7.10)', () => {
    // G22: c1 = 20 = 2·5 + 2·3 + 4; four 3-sc corners.
    const ops = [inc3, sc, inc3, ...times(3, sc), inc3, sc, inc3, ...times(3, sc)];
    const line: Line = { kind: 'border', n: 1, side: 'RS', start: { k: 'edge' }, ops, prevCount: null, stated: 20, join: {} };
    expect(renderCompactLine(line)).toBe('Rnd 1 (RS): (inc3, sc, inc3, 3 sc) x 2; join with sl st in first sc. (20 sts)');
  });

  it('names: the UK table of T2 replaces the US words everywhere', () => {
    const names = { sc: 'dc', hdc: 'htr', dc: 'tr', slst: 'ss', sc2tog: 'dc2tog' };
    expect(renderCompactLine(rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }), { names })).toBe('Rnd 1: 6 dc in MR (6)');
    expect(renderCompactLine(rnd(3, parseBody('(sc, inc) x 6'), 12), { names })).toBe('Rnd 3: (dc, inc) x 6 (18)');
    expect(renderCompactLine(rnd(14, [...times(23, sc), slst], 24), { names })).toBe('Rnd 14: 23 dc, ss (24)');
    expect(renderCompactLine(rnd(15, inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'), 24), { names })).toBe('Rnd 15: BLO (2 dc, dc2tog) x 6 (18)');
    expect(renderCompactLine(rnd(7, times(36, sc), 36, { join: {} }), { names })).toBe('Rnd 7: dc in each st around; join with ss in first dc. (36)');
    expect(renderCompactLine(rnd(2, [dc, dc, hdc], 3), { names })).toBe('Rnd 2: 2 tr, htr (3)');
    const oval = rnd(1, [...times(8, sc), inc3, ...times(7, sc), inc], null, { start: { k: 'chainOval', chains: 10 } });
    expect(renderCompactLine(oval, { names })).toBe(
      'Rnd 1: dc in 2nd ch from hook, dc in next 7 ch, 3 dc in last ch; working along the other side of the chain, dc in next 7 ch, 2 dc in last ch (20)',
    );
  });

  it('names: a word left out, or not a string, keeps the US word', () => {
    const holes = { sc: undefined, slst: 'ss', dec: 7 } as unknown as Partial<CompactNames>;
    expect(renderCompactLine(rnd(7, times(18, sc, dec), 54, { join: {} }), { names: holes })).toBe('Rnd 7: (sc, dec) x 18; join with ss in first sc. (36)');
  });

  it('a round joined into another stitch names it; inc and dec are made of sc', () => {
    expect(compactBody(rnd(2, times(12, hdc), 12, { join: {} }))).toBe('hdc in each st around; join with sl st in first hdc.');
    expect(compactBody(rnd(2, times(6, inc), 6, { join: {} }))).toBe('inc in each st around; join with sl st in first sc.');
  });

  it('compactLabel: every part in its place', () => {
    const base = rnd(3, [sc], 1);
    expect(compactLabel(base)).toBe('Rnd 3');
    expect(compactLabel({ ...base, side: 'WS' })).toBe('Rnd 3 (WS)');
    expect(compactLabel({ ...base, colorHeader: 'B', side: 'RS', arrow: '←' })).toBe('Rnd 3 (B, RS) ←');
    expect(compactLabel({ ...base, nEnd: 5 })).toBe('Rnds 3–5 (3 rnds)');
    expect(compactLabel({ ...base, nEnd: 3 })).toBe('Rnd 3');
    expect(compactLabel({ ...base, kind: 'row', arrow: '→' })).toBe('Row 3 →');
    expect(compactLabel({ ...base, kind: 'row', nEnd: 8 })).toBe('Rows 3–8 (6 rows)');
    expect(compactLabel({ ...base, kind: 'border', side: 'RS' })).toBe('Rnd 3 (RS)');
    expect(compactLabel({ ...base, kind: 'c2c', arrow: '↘', side: 'WS', start: { k: 'c2c', start: 'dec', end: 'inc' } })).toBe('↘ Row 3 (WS) [dec beg · inc end]');
  });

  it('ordinals in "Starting in Nth ch from hook"', () => {
    const body = (firstInto: number): string => compactBody(row(1, [colored(dc, 'A')], null, { start: { k: 'foundation', chains: 30, firstInto } }));
    expect(body(1)).toBe('Starting in 1st ch from hook, dc A');
    expect(body(2)).toBe('Starting in 2nd ch from hook, dc A');
    expect(body(3)).toBe('Starting in 3rd ch from hook, dc A');
    expect(body(4)).toBe('Starting in 4th ch from hook, dc A');
    expect(body(11)).toBe('Starting in 11th ch from hook, dc A');
    expect(body(12)).toBe('Starting in 12th ch from hook, dc A');
    expect(body(13)).toBe('Starting in 13th ch from hook, dc A');
    expect(body(21)).toBe('Starting in 21st ch from hook, dc A');
    expect(body(22)).toBe('Starting in 22nd ch from hook, dc A');
  });

  it('lines without a chain start have no foundation sentence', () => {
    expect(compactFoundation(rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }))).toBeNull();
    expect(compactFoundation(rnd(2, times(6, inc), 6))).toBeNull();
    expect(compactFoundation(row(2, [sc], 1, { start: { k: 'turn', chains: 1 } }))).toBeNull();
  });

  it('is deterministic: the same line gives the same text, call after call and after a reset', () => {
    const lines = foldPlain(spiralLines(SPHERE_K6));
    const first = lines.map((line) => renderCompactLine(line));
    expect(lines.map((line) => renderCompactLine(line))).toEqual(first);
    resetEncodeMemo();
    expect([...lines].reverse().map((line) => renderCompactLine(line)).reverse()).toEqual(first);
  });

  it('does not change the line it prints', () => {
    const line = rnd(4, parseBody('sc, inc, (2 sc, inc) x 5, sc'), 18, { segments: [{ at: 0, kind: 'end' }], cues: [{ kind: 'color', text: 'carry B' }] });
    const before = JSON.stringify(line);
    renderCompactLine(line);
    compactFoundation(line);
    expect(JSON.stringify(line)).toBe(before);
    expect(dec).toEqual({ k: 'dec', n: 2 });
  });
});
