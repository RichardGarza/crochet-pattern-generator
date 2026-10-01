import { beforeEach, describe, expect, it } from 'vitest';
import type { Op } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import {
  EXACT_MAX_TOKENS,
  type EncodeOptions,
  FALLBACK_MAX_PERIOD,
  type Item,
  MEMO_CAPACITY,
  MEMO_MAX_TOKENS,
  canonicalCompact,
  encodeCost,
  encodeMemoStats,
  encodeOps,
  expand,
  resetEncodeMemo,
} from '../encode';
import { itemsConsumed, itemsOpCount, itemsProduced } from '../ops';
import {
  bruteForceCost,
  colored,
  count,
  dec,
  inc,
  inLoop,
  opTokens,
  parseBody,
  placeRound,
  plain,
  randomOps,
  referenceEncode,
  refText,
  runTokens,
  sameOpList,
  sc,
  slst,
  structuredOps,
  tile,
  times,
} from './helpers';

/** Parses a compact body, encodes it, and prints the canonical compact text. */
const reencode = (body: string, o?: EncodeOptions): string => canonicalCompact(encodeOps(parseBody(body), o));
const text = (ops: readonly Op[], o?: EncodeOptions): string => canonicalCompact(encodeOps(ops, o));

beforeEach(() => {
  resetEncodeMemo();
});

describe('encodeOps — goldens', () => {
  it('DESIGN §2.6.1 / research 07 §7.6 vector 4: sc inc sc sc sc inc sc sc sc inc sc sc → (sc, inc, 2 sc) x 3', () => {
    expect(reencode('sc, inc, sc, sc, sc, inc, sc, sc, sc, inc, sc, sc')).toBe('(sc, inc, 2 sc) x 3');
  });

  it('DESIGN §2.6.1 / research 07 §7.6 vector 3: sc, inc, (2 sc, inc) x 5, sc → (sc, inc, sc) x 6', () => {
    expect(reencode('sc, inc, (2 sc, inc) x 5, sc')).toBe('(sc, inc, sc) x 6');
  });

  it('DESIGN §2.6.1 / research 07 §7.6 vector 9: 37 → 30 grouped → (4 sc, dec) x 2, (3 sc, dec) x 5', () => {
    // research 07 §6.6: k = 7 decs, plain = 23, g = 3, r = 2: 2 groups of (4 sc, dec), then 5 of (3 sc, dec).
    const ops = [...times(2, ...times(4, sc), dec), ...times(5, ...times(3, sc), dec)];
    expect([count.used(ops), count.made(ops)]).toEqual([37, 30]);
    expect(text(ops)).toBe('(4 sc, dec) x 2, (3 sc, dec) x 5');
  });

  it('DESIGN §2.6.1 / research 07 §7.6 vector 10: 15 → 22 grouped → sc, (sc, inc) x 7', () => {
    // k = 7 incs, plain = 8, g = 1, r = 1: one group of (2 sc, inc), then 6 of (sc, inc).
    const ops = [...times(2, sc), inc, ...times(6, sc, inc)];
    expect([count.used(ops), count.made(ops)]).toEqual([15, 22]);
    expect(text(ops)).toBe('sc, (sc, inc) x 7');
  });

  it('research 07 §6.6: 29 → 37 grouped → (3 sc, inc) x 5, (2 sc, inc) x 3', () => {
    const ops = [...times(5, ...times(3, sc), inc), ...times(3, ...times(2, sc), inc)];
    expect([count.used(ops), count.made(ops)]).toEqual([29, 37]);
    expect(text(ops)).toBe('(3 sc, inc) x 5, (2 sc, inc) x 3');
  });

  it('DESIGN §2.10.5 (closed cylinder, Rnd 4): (sc, inc, sc) × 5, sc, inc, sl st → sc, (inc, 2 sc) x 5, inc, sl st', () => {
    expect(reencode('(sc, inc, sc) x 5, sc, inc, sl st')).toBe('sc, (inc, 2 sc) x 5, inc, sl st');
  });

  it('research 07 §6.9: the whole-round encoding of the oval Rnd 3 is (sc, inc, 8 sc, inc, sc, inc) x 2', () => {
    expect(reencode('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2')).toBe('(sc, inc, 8 sc, inc, sc, inc) x 2');
  });

  it('research 07 §7.4: sequences are folded before stitch runs (not sc, inc, 3 sc, inc, 3 sc, inc, 2 sc)', () => {
    const ops = parseBody('sc, inc, 3 sc, inc, 3 sc, inc, 2 sc');
    expect(text(ops)).toBe('(sc, inc, 2 sc) x 3');
  });

  it('DESIGN §2.10.8: the textbook sphere k = 6 encodes round by round as the golden text shows', () => {
    const counts = [6, 12, 18, 24, 30, 36, 36, 36, 36, 36, 36, 36, 30, 24, 18, 12, 6];
    const expected = [
      '6 inc', // printed "inc in each st around" by the renderer
      '(sc, inc) x 6',
      '(sc, inc, sc) x 6',
      '(3 sc, inc) x 6',
      '(2 sc, inc, 2 sc) x 6',
      ...Array.from({ length: 6 }, () => '36 sc'),
      '(4 sc, dec) x 6',
      '(sc, dec, 2 sc) x 6',
      '(2 sc, dec) x 6',
      '(dec, sc) x 6',
      '6 dec',
    ];
    let changeIdx = 0;
    const got: string[] = [];
    for (let i = 1; i < counts.length; i++) {
      got.push(text(placeRound(counts[i - 1], counts[i], changeIdx)));
      if (counts[i] !== counts[i - 1]) changeIdx++;
    }
    expect(got).toEqual(expected);
  });

  it('DESIGN §2.11.2: a periodic color round encodes as (3 sc A, 2 sc B) x 6 and (4 sc A, 2 sc B) x 6', () => {
    expect(text(times(6, ...times(3, colored(sc, 'A')), ...times(2, colored(sc, 'B'))))).toBe('(3 sc A, 2 sc B) x 6');
    expect(text(times(6, ...times(4, colored(sc, 'A')), ...times(2, colored(sc, 'B'))))).toBe('(4 sc A, 2 sc B) x 6');
  });
});

describe('encodeOps — short-circuits and structure', () => {
  it('an empty line is an empty list; one op is one run; a uniform line is one run', () => {
    expect(encodeOps([])).toEqual([]);
    expect(plain(encodeOps([sc]))).toEqual([{ kind: 'run', op: sc, n: 1 }]);
    expect(plain(encodeOps(times(36, sc)))).toEqual([{ kind: 'run', op: sc, n: 36 }]);
    expect(plain(encodeOps(times(500, inc), { mode: 'runs' }))).toEqual([{ kind: 'run', op: inc, n: 500 }]);
    expect(encodeMemoStats().size).toBe(0); // none of these needed the search
  });

  it('returns items in the shape of §2.6.1', () => {
    expect(plain(encodeOps(parseBody('sc, (inc, 2 sc) x 5, inc, sl st')))).toEqual([
      { kind: 'run', op: sc, n: 1 },
      { kind: 'rep', times: 5, inner: [{ kind: 'run', op: inc, n: 1 }, { kind: 'run', op: sc, n: 2 }] },
      { kind: 'run', op: inc, n: 1 },
      { kind: 'run', op: slst, n: 1 },
    ]);
  });

  it('keys tokens by op, loop and color: a BLO sc is not an sc, an sc A is not an sc B', () => {
    const blo: Op = { k: 'st', st: 'sc', loop: 'BLO' };
    expect(text([sc, blo, sc, blo])).toBe('(sc, sc BLO) x 2');
    expect(text([colored(sc, 'A'), colored(sc, 'B'), colored(sc, 'A'), colored(sc, 'B'), colored(sc, 'A')])).toBe('(sc A, sc B) x 2, sc A');
    expect(text(inLoop(parseBody('(2 sc, dec) x 6'), 'BLO'))).toBe('(2 sc BLO, sc2tog BLO) x 6');
    expect(text([{ k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' }, { k: 'st', st: 'dc', loop: 'FLO' }])).toBe('dc FLO 2 rows below, dc FLO');
  });

  it('a field set to undefined is the same op as the field left out', () => {
    const a: Op = { k: 'st', st: 'sc', color: undefined, loop: undefined };
    expect(plain(encodeOps([a, sc, a]))).toEqual([{ kind: 'run', op: sc, n: 3 }]);
    expect(expand(encodeOps([a, sc, inc]))).toEqual([a, sc, inc]);
  });

  it("keeps `loop: 'both'` apart from no loop, so expand returns each op as it was given", () => {
    const both: Op = { k: 'st', st: 'sc', loop: 'both' };
    const ops = [sc, both, both, sc];
    const items = encodeOps(ops);
    expect(expand(items)).toStrictEqual(ops);
    expect(items.length).toBe(3);
  });

  it('never drops a field it does not know (a future Op field survives the round trip)', () => {
    const post = { k: 'st', st: 'sc', post: 'front' } as unknown as Op;
    const nested = { k: 'st', st: 'sc', meta: { tags: ['a', 'b'] } } as unknown as Op;
    const ops = [sc, post, post, sc, nested, post];
    const items = encodeOps(ops);
    expect(expand(items)).toEqual(ops);
    expect(items.length).toBe(5); // sc, 2 × post, sc, nested, post
    expect(expand(encodeOps(ops, { mode: 'runs' }))).toEqual(ops);
  });

  it('throws on an element that is not an object', () => {
    expect(() => encodeOps([sc, null as unknown as Op])).toThrow(TypeError);
    expect(() => encodeOps(['sc' as unknown as Op])).toThrow(TypeError);
  });

  it('refuses a field outside the frozen type that JSON cannot carry, rather than return another op', () => {
    // An unknown field is keyed by its canonical JSON, which would turn NaN into null, a Date into a string, -0
    // into 0 and a typed array into a plain one: expand would then not give the op back.
    const withField = (value: unknown): Op => ({ k: 'st', st: 'sc', extra: value }) as unknown as Op;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const holes = new Array<number>(2);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0, new Date(0), () => 1, Symbol('s'), 1n, new Uint8Array(2), new Map(), cycle, holes, [1, undefined]]) {
      expect(() => encodeOps([sc, withField(value)])).toThrow(TypeError);
    }
    for (const value of [null, true, 0, 'x', [1, 'a', null], { a: [{ b: 2 }] }]) {
      const ops = [sc, withField(value), withField(value)];
      expect(expand(encodeOps(ops))).toStrictEqual(ops);
    }
  });

  it('encodeCost: 1 per run, inner + 1 per repeat (research 07 §7.4)', () => {
    expect(encodeCost(encodeOps(parseBody('(sc, inc, sc) x 6')))).toBe(4);
    expect(encodeCost(encodeOps(parseBody('(4 sc, dec) x 2, (3 sc, dec) x 5')))).toBe(6);
    expect(encodeCost(encodeOps(times(36, sc)))).toBe(1);
    expect(encodeCost([])).toBe(0);
  });
});

describe('encodeOps — better(a, b): lower cost → fewer top-level items → shorter text → lexicographic', () => {
  it('1. lower cost wins: (sc, inc, sc) x 6 (4) over sc, inc, (2 sc, inc) x 5, sc (6)', () => {
    const items = encodeOps(parseBody('sc, inc, (2 sc, inc) x 5, sc'));
    expect(encodeCost(items)).toBe(4);
    expect(canonicalCompact(items)).toBe('(sc, inc, sc) x 6');
  });

  it('2. fewer top-level items wins at equal cost (research 07 §7.4)', () => {
    // "(4 sc, dec) x 2, (3 sc, dec) x 5" beats "4 sc, dec, sc, (3 sc, dec) x 6" (equal cost 6).
    const a = parseBody('(4 sc, dec) x 2, (3 sc, dec) x 5');
    const b = parseBody('4 sc, dec, sc, (3 sc, dec) x 6');
    expect(b).toEqual(a);
    const items = encodeOps(b);
    expect([encodeCost(items), items.length]).toEqual([6, 2]);
    expect(canonicalCompact(items)).toBe('(4 sc, dec) x 2, (3 sc, dec) x 5');
  });

  it('3. the shorter text wins at equal cost and equal top-level items, before the alphabet is asked', () => {
    // Two encodings of the same 14 ops, both cost 5 with 3 top-level items:
    //   "sc, (sc, inc) x 2, 9 sc"   23 characters
    //   "2 sc, (inc, sc) x 2, 8 sc" 25 characters (and it would win lexicographically: "2" < "s")
    const a = parseBody('sc, (sc, inc) x 2, 9 sc');
    expect(parseBody('2 sc, (inc, sc) x 2, 8 sc')).toEqual(a);
    expect(text(a)).toBe('sc, (sc, inc) x 2, 9 sc');
  });

  it('4. the lexicographically smaller text wins a full tie ("(" sorts before letters and digits)', () => {
    expect(parseBody('sc, (inc, sc) x 3')).toEqual(parseBody('(sc, inc) x 3, sc'));
    expect(reencode('sc, (inc, sc) x 3')).toBe('(sc, inc) x 3, sc');
    expect(parseBody('sc, (sc, inc) x 2, 2 sc')).toEqual(parseBody('2 sc, (inc, sc) x 2, sc'));
    expect(reencode('sc, (sc, inc) x 2, 2 sc')).toBe('2 sc, (inc, sc) x 2, sc');
    // research 07 §7.6 vector 6 is AmiGo's "sc, (inc, sc) x 2, (sc, inc) x 5"; the same ops and the same cost
    // (7) can be written with "(" first.
    expect(reencode('sc, (inc, sc) x 2, (sc, inc) x 5')).toBe('(sc, inc) x 2, sc, (sc, inc) x 5');
  });

  it('agrees with the definition of §2.6.1 transcribed literally, on thousands of random lines', { timeout: 60_000 }, () => {
    const rng = mulberry32(20261001);
    let reps = 0;
    for (let i = 0; i < 4000; i++) {
      const alphabet = 2 + Math.floor(rng() * 3);
      const length = 1 + Math.floor(rng() * 14);
      const ops = i % 2 === 0 ? randomOps(rng, length, alphabet) : structuredOps(rng, length, alphabet);
      const reference = referenceEncode(opTokens(ops));
      const items = encodeOps(ops);
      expect(canonicalCompact(items)).toBe(refText(reference.items));
      expect(encodeCost(items)).toBe(reference.cost);
      if (items.some((item) => item.kind === 'rep')) reps++;
    }
    expect(reps).toBeGreaterThan(800); // the sample really exercises repeats
  });

  it('agrees with the literal definition on longer structured lines (up to 40 tokens) and in run mode', { timeout: 60_000 }, () => {
    const rng = mulberry32(77);
    for (let i = 0; i < 150; i++) {
      const ops = structuredOps(rng, 15 + Math.floor(rng() * 26), 2 + Math.floor(rng() * 4));
      const byOp = referenceEncode(opTokens(ops));
      expect(text(ops)).toBe(refText(byOp.items));
      const byRun = referenceEncode(runTokens(ops));
      expect(text(ops, { mode: 'runs' })).toBe(refText(byRun.items));
    }
  });

  it('is as short as a brute-force search over every encoding (≤ 12 tokens)', { timeout: 60_000 }, () => {
    const rng = mulberry32(4242);
    for (let i = 0; i < 2500; i++) {
      const alphabet = 2 + Math.floor(rng() * 3);
      const length = 1 + Math.floor(rng() * 12);
      const ops = i % 3 === 0 ? structuredOps(rng, length, alphabet) : randomOps(rng, length, alphabet);
      expect(encodeCost(encodeOps(ops))).toBe(bruteForceCost(opTokens(ops).map((token) => token.key)));
      expect(encodeCost(encodeOps(ops, { mode: 'runs' }))).toBe(bruteForceCost(runTokens(ops).map((token) => token.key)));
    }
  });

  it('never writes ( ) x 1, never nests brackets, never leaves two runs of one op side by side', { timeout: 60_000 }, () => {
    const rng = mulberry32(99);
    /** The first rule an encoding breaks, or null. */
    const violation = (items: readonly Item[]): string | null => {
      let previous: Item | undefined;
      for (const item of items) {
        if (item.kind === 'rep') {
          if (item.times < 2) return '( ) x 1';
          if (item.inner.length < 2) return 'a repeat of a single run';
          if (item.inner.some((inner) => inner.kind !== 'run')) return 'nested brackets';
        } else {
          if (item.n < 1) return 'an empty run';
          if (previous !== undefined && previous.kind === 'run' && previous.op === item.op) return 'two runs of one op side by side';
        }
        previous = item;
      }
      return null;
    };
    for (let i = 0; i < 1500; i++) {
      const ops = structuredOps(rng, 1 + Math.floor(rng() * 150), 2 + Math.floor(rng() * 5));
      expect(violation(encodeOps(ops))).toBeNull();
      expect(violation(encodeOps(ops, { mode: 'runs' }))).toBeNull();
    }
    expect(violation([{ kind: 'rep', times: 1, inner: [] }])).toBe('( ) x 1');
  });
});

describe('expand(encodeOps(ops)) deep-equals ops (R10)', () => {
  it('for every amigurumi vector of research 07 §7.6', () => {
    const bodies = [
      '6 sc in MR',
      'sc, inc, (2 sc, inc) x 5, sc',
      'sc, inc, sc, sc, sc, inc, sc, sc, sc, inc, sc, sc',
      '6 inc, sc, inc',
      'sc, (inc, sc) x 2, (sc, inc) x 5',
      'sc, inc, 2 sc, (inc, sc) x 2, (2 sc, inc) x 2, (2 sc, inc, sc) x 2',
      '2 sc, inc, sc, (2 sc, inc, 3 sc, inc) x 2, 2 sc, (sc, inc, sc) x 3',
      '(4 sc, dec) x 2, (3 sc, dec) x 5',
      '2 sc, inc, (sc, inc) x 6',
      '(invdec, 2 sc) x 6',
      '6 dec',
      'sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2',
      '(2 sc, inc, 2 sc) x 5, 2 sc, inc, sc, sl st',
      '(sc, inc) x 6',
    ];
    for (const body of bodies) {
      const ops = parseBody(body);
      for (const mode of ['ops', 'runs'] as const) {
        const items = encodeOps(ops, { mode });
        expect(expand(items)).toStrictEqual(ops);
        expect(itemsOpCount(items)).toBe(ops.length);
        expect(itemsConsumed(items)).toBe(count.used(ops));
        expect(itemsProduced(items)).toBe(count.made(ops));
        // The encoder is never longer than the line as the vector writes it.
        expect(encodeCost(items)).toBeLessThanOrEqual(mode === 'ops' ? referenceEncode(opTokens(ops)).cost : ops.length);
      }
    }
  });

  it('for thousands of random lines, in both modes, with segments, across the 120-token limit', { timeout: 60_000 }, () => {
    const rng = mulberry32(31337);
    let long = 0;
    let checked = 0;
    for (let i = 0; i < 6000; i++) {
      const length = i % 10 === 0 ? 100 + Math.floor(rng() * 400) : Math.floor(rng() * 140);
      const alphabet = 1 + Math.floor(rng() * 16);
      const ops = i % 2 === 0 ? randomOps(rng, length, alphabet) : structuredOps(rng, length, alphabet);
      if (ops.length > EXACT_MAX_TOKENS) long++;
      const segments = i % 4 === 0 ? Array.from({ length: 1 + Math.floor(rng() * 5) }, () => ({ at: Math.floor(rng() * (ops.length + 2)) })) : undefined;
      for (const mode of ['ops', 'runs'] as const) {
        const items = encodeOps(ops, { mode, segments });
        const back = expand(items);
        if (!sameOpList(back, ops)) expect(back).toStrictEqual(ops);
        if (itemsConsumed(items) !== count.used(ops) || itemsProduced(items) !== count.made(ops)) {
          expect([itemsConsumed(items), itemsProduced(items)]).toEqual([count.used(ops), count.made(ops)]);
        }
        checked++;
      }
    }
    expect(checked).toBe(12000);
    expect(long).toBeGreaterThan(600);
  });
});

describe("encodeOps — mode 'runs' (2D rows: one token per run)", () => {
  it('writes a row as its color runs (§2.7.2)', () => {
    const rowOps = [...times(4, colored(sc, 'A')), ...times(3, colored(sc, 'B')), ...times(33, colored(sc, 'A'))];
    expect(text(rowOps, { mode: 'runs' })).toBe('4 sc A, 3 sc B, 33 sc A');
    expect(text(parseBody('2 sc A, sc B, 2 sc A'), { mode: 'runs' })).toBe('2 sc A, sc B, 2 sc A');
  });

  it('folds a periodic row', () => {
    const rowOps = times(10, ...times(2, colored(sc, 'A')), ...times(2, colored(sc, 'B')));
    expect(text(rowOps, { mode: 'runs' })).toBe('(2 sc A, 2 sc B) x 10');
    expect(text([...times(5, colored(sc, 'C')), ...rowOps], { mode: 'runs' })).toBe('5 sc C, (2 sc A, 2 sc B) x 10');
  });

  it('never cuts a run: a repeat is made of whole runs', () => {
    const rowOps = parseBody('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(text(rowOps, { mode: 'runs' })).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(text(rowOps, { mode: 'ops' })).toBe('(sc A, 2 sc B, sc A) x 2');
    // The staggered round of §2.10.8 cannot become (sc, inc, sc) x 6 here: that would cut the runs of 2 sc.
    expect(text(parseBody('sc, inc, (2 sc, inc) x 5, sc'), { mode: 'runs' })).toBe('sc, (inc, 2 sc) x 5, inc, sc');
  });

  it('C2C tiles always print their count (§2.7.6)', () => {
    expect(text([tile('A'), tile('B'), tile('A')], { mode: 'runs' })).toBe('1 A, 1 B, 1 A');
    expect(text([tile('A'), tile('B'), tile('B')], { mode: 'runs' })).toBe('1 A, 2 B');
    expect(text(times(5, tile('A'), tile('B')), { mode: 'runs' })).toBe('(1 A, 1 B) x 5');
  });

  it("is the mode only when asked: anything but 'runs' means 'ops' (the line-level choice is compact.ts lineItems)", () => {
    const ops = parseBody('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(text(ops)).toBe('(sc A, 2 sc B, sc A) x 2');
    expect(text(ops, { mode: 'ops' })).toBe('(sc A, 2 sc B, sc A) x 2');
    expect(text(ops, { mode: 'runs' })).toBe('sc A, 2 sc B, 2 sc A, 2 sc B, sc A');
    expect(text(ops, { mode: 'other' as unknown as EncodeOptions['mode'] })).toBe('(sc A, 2 sc B, sc A) x 2');
  });
});

describe('encodeOps — segments (research 07 §6.9, §7.6 vector 14)', () => {
  // Oval on ch 10, Rnd 3 (26 → 32): end | side | end | side | end.
  const rnd3 = parseBody('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
  const segments = [{ at: 0 }, { at: 2 }, { at: 9 }, { at: 15 }, { at: 22 }];

  it('vector 14: sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2 with segments renders unchanged', () => {
    expect(text(rnd3, { segments })).toBe('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
    expect(text(rnd3)).toBe('(sc, inc, 8 sc, inc, sc, inc) x 2');
    expect(expand(encodeOps(rnd3, { segments }))).toStrictEqual(rnd3);
  });

  it('research 07 §6.9 Rnd 2 keeps its five segments', () => {
    const rnd2 = [inc, ...times(7, sc), ...times(3, inc), ...times(7, sc), ...times(2, inc)];
    expect(text(rnd2, { segments: [{ at: 0 }, { at: 1 }, { at: 8 }, { at: 11 }, { at: 18 }] })).toBe('inc, 7 sc, 3 inc, 7 sc, 2 inc');
    expect(text(rnd2)).toBe('(inc, 7 sc, 2 inc) x 2');
  });

  it('no repeat crosses a boundary', () => {
    const ops = times(6, sc, inc);
    expect(text(ops)).toBe('(sc, inc) x 6');
    expect(text(ops, { segments: [{ at: 4 }] })).toBe('(sc, inc) x 2, (sc, inc) x 4');
    expect(text(ops, { segments: [{ at: 3 }] })).toBe('sc, inc, sc, (inc, sc) x 4, inc');
  });

  it('a line of one op is one run whatever its segments (§2.6.1 short-circuit): a plain oval round is one run', () => {
    expect(plain(encodeOps(times(32, sc), { segments }))).toEqual([{ kind: 'run', op: sc, n: 32 }]);
    expect(plain(encodeOps(times(500, sc), { segments: [{ at: 7 }, { at: 300 }] }))).toEqual([{ kind: 'run', op: sc, n: 500 }]);
    expect(plain(encodeOps(times(9, colored(sc, 'A')), { mode: 'runs', segments: [{ at: 4 }] }))).toEqual([{ kind: 'run', op: colored(sc, 'A'), n: 9 }]);
  });

  it('otherwise segments are encoded separately and joined: no run crosses a boundary either (§2.6.1, research 07 §6.9)', () => {
    // An oval side of 7 sc, then an end segment that starts with sc: the side still reads "7 sc".
    expect(text(parseBody('7 sc, 3 sc, inc, 2 sc, inc'), { segments: [{ at: 0 }, { at: 7 }] })).toBe('7 sc, sc, (2 sc, inc) x 2');
    expect(text(parseBody('7 sc, 3 sc, inc, 2 sc, inc'))).toBe('8 sc, (2 sc, inc) x 2');
    expect(text(parseBody('2 sc, inc, 3 sc, inc, 4 sc'), { segments: [{ at: 4 }] })).toBe('2 sc, inc, sc, 2 sc, inc, 4 sc');
    expect(text(parseBody('5 sc A, 3 sc B'), { mode: 'runs', segments: [{ at: 2 }, { at: 6 }] })).toBe('2 sc A, 3 sc A, sc B, 2 sc B');
  });

  it('ignores cuts that are outside the line, repeated or out of order', () => {
    const ops = times(6, sc, inc);
    expect(text(ops, { segments: [{ at: 0 }, { at: 12 }, { at: -3 }, { at: 99 }, { at: 1.5 }] })).toBe('(sc, inc) x 6');
    expect(text(ops, { segments: [{ at: 8 }, { at: 4 }, { at: 4 }] })).toBe('(sc, inc) x 2, (sc, inc) x 2, (sc, inc) x 2');
  });

  it('ignores malformed segment entries (validateLine reports them as E_SANITY)', () => {
    const ops = times(6, sc, inc);
    const junk = [null, 'x', { at: '4' }, { at: Number.NaN }, { at: 4 }] as unknown as EncodeOptions['segments'];
    expect(text(ops, { segments: junk })).toBe('(sc, inc) x 2, (sc, inc) x 4');
    expect(text(ops, { segments: 'x' as unknown as EncodeOptions['segments'] })).toBe('(sc, inc) x 6');
  });

  it('the 120-token limit applies per segment', () => {
    const half = times(50, sc, inc, sc); // 150 tokens: the fallback when alone
    expect(text(half)).toBe('sc, (inc, 2 sc) x 49, inc, sc');
    expect(text([...half, ...half], { segments: [{ at: 150 }] })).toBe('sc, (inc, 2 sc) x 49, inc, sc, sc, (inc, 2 sc) x 49, inc, sc');
    const short = times(30, sc, inc, sc); // 90 tokens: exact
    expect(text([...short, ...short], { segments: [{ at: 90 }] })).toBe('(sc, inc, sc) x 30, (sc, inc, sc) x 30');
  });
});

describe('encodeOps — linear fallback above 120 tokens (§2.6.1, D8)', () => {
  it('uses the exact search up to 120 tokens and the fallback from 121', () => {
    expect(EXACT_MAX_TOKENS).toBe(120);
    expect(FALLBACK_MAX_PERIOD).toBe(8);
    expect(text(times(40, sc, inc, sc))).toBe('(sc, inc, sc) x 40'); // 120 tokens: exact
    // 123 tokens: runs = sc, inc, (2 sc, inc) × 40, sc. Not periodic as a whole; scanning from the left, the
    // first run starts no repeat, the second starts (inc, 2 sc) × 40.
    expect(text(times(41, sc, inc, sc))).toBe('sc, (inc, 2 sc) x 40, inc, sc');
    expect(text(times(41, sc, inc, sc), { exactMaxTokens: 200 })).toBe('(sc, inc, sc) x 41');
    expect(text(times(40, sc, inc, sc), { exactMaxTokens: 119 })).toBe('sc, (inc, 2 sc) x 39, inc, sc');
  });

  it('counts tokens in the line\'s mode: 300 stitches in 6 runs are searched exactly in run mode', () => {
    const ops = [...times(3, ...times(60, colored(sc, 'A')), ...times(40, colored(sc, 'B')))];
    expect(text(ops, { mode: 'runs' })).toBe('(60 sc A, 40 sc B) x 3');
    expect(text(ops, { mode: 'ops' })).toBe('(60 sc A, 40 sc B) x 3'); // fallback: the run list is periodic
  });

  it('emits (runs) x k when the whole run list is periodic', () => {
    expect(text(times(30, ...times(4, sc), inc))).toBe('(4 sc, inc) x 30'); // 150 op tokens
    const rowOps = times(70, ...times(2, colored(sc, 'A')), ...times(2, colored(sc, 'B')));
    expect(text(rowOps, { mode: 'runs' })).toBe('(2 sc A, 2 sc B) x 70'); // 140 run tokens
  });

  it('otherwise scans left to right and takes the block of p ≤ 8 runs that covers the most; ties → smaller p', () => {
    const a = colored(sc, 'A');
    const b = colored(sc, 'B');
    const c = colored(sc, 'C');
    // p = 2 covers 140 runs and so does p = 4: the smaller block wins.
    const stripes = [...times(5, c), ...times(70, ...times(2, a), ...times(2, b))];
    expect(text(stripes, { mode: 'runs' })).toBe('5 sc C, (2 sc A, 2 sc B) x 70');
    // From the second run on, p = 2 covers 4 runs (sc A, sc B twice) but p = 5 covers 150.
    const motif = [...times(3, c), ...times(30, a, b, a, b, ...times(2, c))];
    expect(text(motif, { mode: 'runs' })).toBe('3 sc C, (sc A, sc B, sc A, sc B, 2 sc C) x 30');
    // A repeat in the middle, then the rest run by run.
    const tail = [...times(60, a, b), ...times(3, c), a, ...times(2, b)];
    expect(text(tail, { mode: 'runs' })).toBe('(sc A, sc B) x 60, 3 sc C, sc A, 2 sc B');
  });

  it('does not look for blocks longer than 8 runs (the exact search would find them)', () => {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const block9 = letters.map((color) => colored(sc, color));
    const block8 = block9.slice(0, 8);
    const lead = [...times(2, colored(sc, 'Z'))];
    const nine = [...lead, ...times(14, ...block9)]; // 1 + 126 runs
    const fallback = encodeOps(nine, { mode: 'runs' });
    expect(fallback.every((item) => item.kind === 'run')).toBe(true);
    expect(fallback.length).toBe(127);
    expect(expand(fallback)).toStrictEqual(nine);
    expect(text(nine, { mode: 'runs', exactMaxTokens: 1000 })).toBe('2 sc Z, (sc A, sc B, sc C, sc D, sc E, sc F, sc G, sc H, sc I) x 14');
    const eight = [...lead, ...times(16, ...block8)]; // 1 + 128 runs
    expect(text(eight, { mode: 'runs' })).toBe('2 sc Z, (sc A, sc B, sc C, sc D, sc E, sc F, sc G, sc H) x 16');
  });

  it('keeps one bracket level and round-trips', { timeout: 60_000 }, () => {
    const rng = mulberry32(5150);
    for (let i = 0; i < 300; i++) {
      const ops = structuredOps(rng, 121 + Math.floor(rng() * 500), 2 + Math.floor(rng() * 6));
      for (const mode of ['ops', 'runs'] as const) {
        const items = encodeOps(ops, { mode, exactMaxTokens: 0 }); // always the fallback
        for (const item of items) if (item.kind === 'rep') for (const inner of item.inner) expect(inner.kind).toBe('run');
        const back = expand(items);
        if (!sameOpList(back, ops)) expect(back).toStrictEqual(ops);
      }
    }
  });
});

describe('encodeOps — memo (§2.6.1: LRU of 4 096 entries)', () => {
  const line = (i: number): Op[] => {
    // A distinct, non-uniform line per i: the base-3 digits of i as sc / inc / dec, then a fixed tail.
    const ops: Op[] = [];
    for (let x = i, d = 0; d < 9; d++, x = Math.floor(x / 3)) ops.push([sc, inc, dec][x % 3]);
    return [...ops, sc, inc];
  };

  it('encodes identical lines once and returns the same frozen result', () => {
    const ops = parseBody('sc, inc, (2 sc, inc) x 5, sc');
    const first = encodeOps(ops);
    const again = encodeOps(parseBody('sc, inc, (2 sc, inc) x 5, sc'));
    expect(again).toBe(first);
    expect(encodeMemoStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
    // Same ops, another mode: its own entry.
    expect(encodeOps(ops, { mode: 'runs' })).not.toBe(first);
    expect(encodeMemoStats()).toMatchObject({ size: 2, hits: 1, misses: 2 });
  });

  it('keeps the exact search and the fallback apart for the same tokens', () => {
    const ops = times(41, sc, inc, sc);
    expect(text(ops)).toBe('sc, (inc, 2 sc) x 40, inc, sc');
    expect(text(ops, { exactMaxTokens: 500 })).toBe('(sc, inc, sc) x 41');
    expect(text(ops)).toBe('sc, (inc, 2 sc) x 40, inc, sc');
    expect(encodeMemoStats()).toMatchObject({ size: 2, hits: 1 });
  });

  it('holds at most 4 096 entries and drops the least recently used', { timeout: 60_000 }, () => {
    expect(MEMO_CAPACITY).toBe(4096);
    for (let i = 0; i < MEMO_CAPACITY; i++) encodeOps(line(i));
    expect(encodeMemoStats()).toMatchObject({ size: MEMO_CAPACITY, hits: 0, misses: MEMO_CAPACITY });
    encodeOps(line(0)); // line 0 is now the most recently used
    expect(encodeMemoStats().hits).toBe(1);
    for (let i = MEMO_CAPACITY; i < MEMO_CAPACITY + 10; i++) encodeOps(line(i)); // drops lines 1–10
    expect(encodeMemoStats().size).toBe(MEMO_CAPACITY);
    encodeOps(line(0));
    expect(encodeMemoStats().hits).toBe(2); // still there
    encodeOps(line(1));
    expect(encodeMemoStats().hits).toBe(2); // gone: encoded again
    expect(encodeMemoStats().misses).toBe(MEMO_CAPACITY + 11);
  });

  it('results are frozen all the way down', () => {
    const items = encodeOps(parseBody('sc A, (inc, 2 sc) x 5, inc, sl st'));
    expect(Object.isFrozen(items)).toBe(true);
    for (const item of items) {
      expect(Object.isFrozen(item)).toBe(true);
      if (item.kind === 'rep') {
        expect(Object.isFrozen(item.inner)).toBe(true);
        for (const inner of item.inner) expect(Object.isFrozen(inner)).toBe(true);
      } else {
        expect(Object.isFrozen(item.op)).toBe(true);
      }
    }
    expect(() => {
      (items as Item[]).push({ kind: 'run', op: sc, n: 1 });
    }).toThrow(TypeError);
    expect(() => {
      (items[0] as { n: number }).n = 9;
    }).toThrow(TypeError);
    expect(Object.isFrozen(encodeOps(times(4, sc)))).toBe(true);
    expect(Object.isFrozen(encodeOps(times(6, sc, inc), { segments: [{ at: 4 }] }))).toBe(true);
    expect(Object.isFrozen(encodeOps([]))).toBe(true);
  });

  it("does not freeze or keep the caller's ops", () => {
    const mine: Op = { k: 'st', st: 'sc', color: 'A' };
    const items = encodeOps([mine, inc, mine]);
    expect(Object.isFrozen(mine)).toBe(false);
    mine.color = 'B';
    expect(expand(items)).toEqual([{ k: 'st', st: 'sc', color: 'A' }, inc, { k: 'st', st: 'sc', color: 'A' }]);
  });

  it('resetEncodeMemo empties the memo and the vocabulary', () => {
    encodeOps(line(1));
    encodeOps(line(2));
    expect(encodeMemoStats()).toEqual({ size: 2, tokens: 22, hits: 0, misses: 2, vocabulary: 3 });
    resetEncodeMemo();
    expect(encodeMemoStats()).toEqual({ size: 0, tokens: 0, hits: 0, misses: 0, vocabulary: 0 });
  });

  it('also holds at most MEMO_MAX_TOKENS token integers, dropping the least recently used entries', { timeout: 60_000 }, () => {
    expect(MEMO_MAX_TOKENS).toBe(1 << 20);
    // Five distinct periodic lines of 250 000 op tokens each (the fallback folds each into one repeat).
    const long = (g: number): Op[] => {
      const ops: Op[] = [];
      while (ops.length < 250_000) ops.push(...times(g, sc), { ...inc });
      return ops.slice(0, 250_000);
    };
    const lines = [2, 3, 4, 5, 6].map(long);
    for (const ops of lines.slice(0, 4)) encodeOps(ops);
    expect(encodeMemoStats()).toMatchObject({ size: 4, tokens: 1_000_000 });
    encodeOps(lines[0]); // the first line becomes the most recently used
    expect(encodeMemoStats()).toMatchObject({ size: 4, hits: 1 });
    encodeOps(lines[4]); // 1 250 000 tokens would be too many: the oldest entry (the second line) goes
    expect(encodeMemoStats()).toMatchObject({ size: 4, tokens: 1_000_000, hits: 1 });
    encodeOps(lines[0]);
    expect(encodeMemoStats().hits).toBe(2);
    encodeOps(lines[1]);
    expect(encodeMemoStats()).toMatchObject({ hits: 2, misses: 6 });
  });

  it('does not keep a line longer than MEMO_MAX_TOKENS at all', { timeout: 60_000 }, () => {
    // Run tokens are (op, count) pairs: 524 289 runs are 1 048 578 token integers.
    const ops: Op[] = [];
    for (let r = 0; ops.length < 524_289; r++) ops.push(r % 3 === 2 ? { ...dec } : r % 3 === 1 ? { ...inc } : { ...sc });
    const items = encodeOps(ops, { mode: 'runs' });
    expect(encodeMemoStats()).toMatchObject({ size: 0, tokens: 0, misses: 1 });
    expect(encodeOps(ops, { mode: 'runs' })).toEqual(items);
    expect(encodeMemoStats()).toMatchObject({ size: 0, hits: 0, misses: 2 });
  });
});

describe('encodeOps — determinism (§5.8)', () => {
  it('gives the same encoding whatever was encoded before, with or without the memo', { timeout: 60_000 }, () => {
    const rng = mulberry32(8675309);
    const lines: Op[][] = [];
    for (let i = 0; i < 400; i++) lines.push(structuredOps(rng, 1 + Math.floor(rng() * 200), 2 + Math.floor(rng() * 8)));
    const render = (ops: Op[]): string => `${text(ops)} | ${text(ops, { mode: 'runs' })} | ${JSON.stringify(encodeOps(ops))}`;

    const forward = lines.map(render);
    const cached = lines.map(render);
    expect(cached).toEqual(forward);

    resetEncodeMemo();
    const backward = [...lines].reverse().map(render).reverse();
    expect(backward).toEqual(forward);

    const cold = lines.map((ops) => {
      resetEncodeMemo();
      return render(ops);
    });
    expect(cold).toEqual(forward);
  });
});
