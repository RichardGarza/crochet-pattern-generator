import { describe, expect, it } from 'vitest';
import type { Line, LineStart, Op } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import {
  CONS,
  type Item,
  OP_NAMES,
  PROD,
  START_EXEMPT,
  US_COMPACT_NAMES,
  consumed,
  expand,
  isConsumeExempt,
  isOp,
  itemsConsumed,
  itemsOpCount,
  itemsProduced,
  lineConsumed,
  lineProduced,
  opName,
  produced,
  runText,
  startCapacity,
  tokenText,
} from '../ops';
import { colored, count, dc, dec, dec3, hdc, inc, inc3, inLoop, parseBody, randomOps, sc, slst, tile, times } from './helpers';

describe('CONS / PROD (research 03 §6.0, 07 §7.2)', () => {
  it('holds the table of research 07 §7.2 for every op of the frozen Op type', () => {
    expect(CONS).toEqual({ sc: 1, hdc: 1, dc: 1, slst: 1, inc: 1, inc3: 1, dec: 2, dec3: 3, tile: 1 });
    expect(PROD).toEqual({ sc: 1, hdc: 1, dc: 1, slst: 1, inc: 2, inc3: 3, dec: 1, dec3: 1, tile: 1 });
    expect([...OP_NAMES].sort()).toEqual(Object.keys(CONS).sort());
    expect(Object.keys(PROD).sort()).toEqual(Object.keys(CONS).sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONS)).toBe(true);
    expect(Object.isFrozen(PROD)).toBe(true);
    expect(Object.isFrozen(OP_NAMES)).toBe(true);
    expect(Object.isFrozen(START_EXEMPT)).toBe(true);
    expect(Object.isFrozen(US_COMPACT_NAMES)).toBe(true);
    expect(() => {
      (CONS as Record<string, number>).sc = 2;
    }).toThrow(TypeError);
  });

  it('names every op variant; loops, colors and `into` never change the name', () => {
    const cases: [Op, string][] = [
      [sc, 'sc'],
      [hdc, 'hdc'],
      [dc, 'dc'],
      [slst, 'slst'],
      [inc, 'inc'],
      [inc3, 'inc3'],
      [dec, 'dec'],
      [dec3, 'dec3'],
      [tile('A'), 'tile'],
      [{ k: 'st', st: 'sc', loop: 'BLO', color: 'B' }, 'sc'],
      [{ k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' }, 'dc'],
      [{ k: 'dec', n: 2, loop: 'BLO' }, 'dec'],
      [{ k: 'inc', n: 3, color: 'C', loop: 'both' }, 'inc3'],
    ];
    for (const [op, name] of cases) expect(opName(op)).toBe(name);
  });

  it('throws on something that is not an op', () => {
    expect(() => opName({ k: 'inc', n: 4 } as unknown as Op)).toThrow(TypeError);
    expect(() => opName({ k: 'st', st: 'tr' } as unknown as Op)).toThrow(TypeError);
    expect(() => opName({ k: 'mr', n: 6 } as unknown as Op)).toThrow(TypeError);
    expect(() => consumed([sc, { k: 'skip' } as unknown as Op])).toThrow(/not a stitch op/);
  });

  it('isOp accepts exactly the frozen Op type', () => {
    for (const op of [sc, hdc, dc, slst, inc, inc3, dec, dec3, tile('A')]) expect(isOp(op)).toBe(true);
    expect(isOp({ k: 'st', st: 'sc', loop: 'both', color: 'A', into: 'flo2below' })).toBe(true);
    expect(isOp({ k: 'st', st: 'sc', loop: undefined, color: undefined })).toBe(true);
    for (const bad of [
      null,
      undefined,
      'sc',
      {},
      { k: 'st' },
      { k: 'st', st: 'tr' },
      { k: 'st', st: 'sc', loop: 'TBL' },
      { k: 'st', st: 'sc', color: 3 },
      { k: 'st', st: 'sc', into: 'blo2below' },
      { k: 'inc' },
      { k: 'inc', n: 4 },
      { k: 'dec', n: '2' },
      { k: 'tile' },
      { k: 'mr', n: 6 },
    ]) {
      expect(isOp(bad)).toBe(false);
    }
  });
});

describe('consumed / produced', () => {
  it('sc 1→1, inc 1→2, dec 2→1, inc3 1→3, dec3 3→1, sl st 1→1 (research 07 §7.2)', () => {
    expect([consumed([sc]), produced([sc])]).toEqual([1, 1]);
    expect([consumed([inc]), produced([inc])]).toEqual([1, 2]);
    expect([consumed([dec]), produced([dec])]).toEqual([2, 1]);
    expect([consumed([inc3]), produced([inc3])]).toEqual([1, 3]);
    expect([consumed([dec3]), produced([dec3])]).toEqual([3, 1]);
    expect([consumed([slst]), produced([slst])]).toEqual([1, 1]);
    expect([consumed([]), produced([])]).toEqual([0, 0]);
  });

  it('BLO/FLO and colors change nothing (research 07 §7.2: "BLO changes shape, not counts")', () => {
    const ops = parseBody('(2 sc, inc, sc A, dec B) x 3, sl st');
    const loops = inLoop(ops, 'BLO');
    expect(consumed(loops)).toBe(consumed(ops));
    expect(produced(loops)).toBe(produced(ops));
  });

  it('the amigurumi rounds of research 07 §7.6 add up', () => {
    // [vector, prev, body, stated]
    const vectors: [number, number, string, number][] = [
      [3, 18, 'sc, inc, (2 sc, inc) x 5, sc', 24],
      [5, 8, '6 inc, sc, inc', 15],
      [6, 15, 'sc, (inc, sc) x 2, (sc, inc) x 5', 22],
      [7, 22, 'sc, inc, 2 sc, (inc, sc) x 2, (2 sc, inc) x 2, (2 sc, inc, sc) x 2', 29],
      [8, 29, '2 sc, inc, sc, (2 sc, inc, 3 sc, inc) x 2, 2 sc, (sc, inc, sc) x 3', 37],
      [11, 24, '(invdec, 2 sc) x 6', 18],
      [15, 30, '(2 sc, inc, 2 sc) x 5, 2 sc, inc, sc, sl st', 36],
    ];
    for (const [id, prev, body, stated] of vectors) {
      const ops = parseBody(body);
      expect([id, consumed(ops), produced(ops)]).toEqual([id, prev, stated]);
    }
  });

  it('agrees with an independent count on random ops', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const ops = randomOps(rng, Math.floor(rng() * 60), 12);
      expect(consumed(ops)).toBe(count.used(ops));
      expect(produced(ops)).toBe(count.made(ops));
    }
  });
});

describe('expand', () => {
  const items: Item[] = [
    { kind: 'run', op: sc, n: 2 },
    { kind: 'rep', inner: [{ kind: 'run', op: inc, n: 1 }, { kind: 'run', op: colored(sc, 'B'), n: 2 }], times: 3 },
    { kind: 'run', op: slst, n: 1 },
  ];

  it('writes runs and repeats out in order', () => {
    expect(expand(items)).toEqual(parseBody('2 sc, (inc, 2 sc B) x 3, sl st'));
    expect(expand([])).toEqual([]);
  });

  it('returns fresh ops that the caller may change', () => {
    const out = expand(items);
    expect(out[0]).not.toBe(sc);
    expect(out[0]).not.toBe(out[1]);
    (out[0] as { color?: string }).color = 'Z';
    expect(sc).toEqual({ k: 'st', st: 'sc' });
    expect(out[1]).toEqual({ k: 'st', st: 'sc' });
  });

  it('expands nested repeats (the encoder never makes them, the type allows them)', () => {
    const nested: Item[] = [{ kind: 'rep', times: 2, inner: [{ kind: 'rep', times: 2, inner: [{ kind: 'run', op: sc, n: 1 }, { kind: 'run', op: inc, n: 1 }] }, { kind: 'run', op: dec, n: 1 }] }];
    expect(expand(nested)).toEqual(parseBody('sc, inc, sc, inc, dec, sc, inc, sc, inc, dec'));
  });

  it('rejects counts that are not whole numbers', () => {
    expect(() => expand([{ kind: 'run', op: sc, n: 1.5 }])).toThrow(RangeError);
    expect(() => expand([{ kind: 'run', op: sc, n: -1 }])).toThrow(RangeError);
    expect(() => expand([{ kind: 'rep', inner: [], times: Number.NaN }])).toThrow(RangeError);
    expect(expand([{ kind: 'run', op: sc, n: 0 }])).toEqual([]);
  });

  it('itemsConsumed / itemsProduced / itemsOpCount equal the counts of the expanded ops', () => {
    const ops = expand(items);
    expect(itemsConsumed(items)).toBe(consumed(ops));
    expect(itemsProduced(items)).toBe(produced(ops));
    expect(itemsOpCount(items)).toBe(ops.length);
    expect([itemsConsumed([]), itemsProduced([]), itemsOpCount([])]).toEqual([0, 0, 0]);
  });
});

describe('line starts (§2.13: MR, foundation, chain-oval, chain-ring and border edge lines are exempt)', () => {
  const line = (start: LineStart | undefined): Pick<Line, 'start'> => ({ start });

  it('marks the starts of a first line as exempt, and no other', () => {
    expect(START_EXEMPT).toEqual({ mr: true, foundation: true, chainOval: true, chainRing: true, edge: true, turn: false, join: false, c2c: false });
    expect(isConsumeExempt(line({ k: 'mr', n: 6 }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'foundation', chains: 6, firstInto: 2 }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'chainOval', chains: 10 }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'chainRing', chains: 40 }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'edge' }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'turn', chains: 1 }))).toBe(false);
    expect(isConsumeExempt(line({ k: 'join' }))).toBe(false);
    expect(isConsumeExempt(line(undefined))).toBe(false);
  });

  it('exempts only the first tile of a C2C piece', () => {
    expect(isConsumeExempt(line({ k: 'c2c', start: 'first', end: 'first' }))).toBe(true);
    expect(isConsumeExempt(line({ k: 'c2c', start: 'inc', end: 'inc' }))).toBe(false);
    expect(isConsumeExempt(line({ k: 'c2c', start: 'dec', end: 'dec' }))).toBe(false);
  });

  it('startCapacity: what a first line works into', () => {
    expect(startCapacity({ k: 'mr', n: 6 })).toBe(6);
    // sc graph of W = 5: ch W + 1, first sc in the 2nd ch (§2.7.3); hdc: ch W + 2, 3rd ch (§2.7.7).
    expect(startCapacity({ k: 'foundation', chains: 6, firstInto: 2 })).toBe(5);
    expect(startCapacity({ k: 'foundation', chains: 7, firstInto: 3 })).toBe(5);
    // research 07 §6.9 / §7.6 vector 13: ch 10 → 17 loops.
    expect(startCapacity({ k: 'chainOval', chains: 10 })).toBe(17);
    for (const n of [6, 10, 15]) expect(startCapacity({ k: 'chainOval', chains: n })).toBe(2 * n - 3);
    expect(startCapacity({ k: 'chainRing', chains: 40 })).toBe(40);
    expect(startCapacity({ k: 'edge' })).toBeNull();
    expect(startCapacity({ k: 'turn', chains: 1 })).toBeNull();
    expect(startCapacity({ k: 'join' })).toBeNull();
    expect(startCapacity({ k: 'c2c', start: 'inc', end: 'dec' })).toBeNull();
    expect(startCapacity(undefined)).toBeNull();
  });

  it('the chain-oval round of research 07 §6.9 uses 2N − 3 loops and makes 2N stitches (N = 6, 10, 15)', () => {
    for (const n of [6, 10, 15]) {
      // sc in 2nd ch, sc in next N−3 ch, 3 sc in last ch; other side: sc in next N−3 ch, 2 sc in last ch
      const ops = [...times(n - 2, sc), inc3, ...times(n - 3, sc), inc];
      expect(consumed(ops)).toBe(startCapacity({ k: 'chainOval', chains: n }));
      expect(produced(ops)).toBe(2 * n);
    }
  });
});

describe('lineConsumed / lineProduced', () => {
  it('is the sum over the ops for rows and rounds; chains and joins are not stitches (§2.11.3)', () => {
    const ops = parseBody('(sc, inc) x 6');
    for (const start of [undefined, { k: 'turn', chains: 1 }, { k: 'join' }, { k: 'mr', n: 12 }] as (LineStart | undefined)[]) {
      expect(lineConsumed({ ops, start })).toBe(12);
      expect(lineProduced({ ops })).toBe(18);
    }
  });

  it('C2C 5 × 3 (§2.7.6 golden): every row works into all the ch-3 spaces of the row before', () => {
    // [tiles, beg, end] for rows 1–7, RH start bottom-right, then RH start bottom-left.
    const goldens: [number, 'first' | 'inc' | 'dec', 'first' | 'inc' | 'dec'][][] = [
      [[1, 'first', 'first'], [2, 'inc', 'inc'], [3, 'inc', 'inc'], [3, 'inc', 'dec'], [3, 'dec', 'inc'], [2, 'dec', 'dec'], [1, 'dec', 'dec']],
      [[1, 'first', 'first'], [2, 'inc', 'inc'], [3, 'inc', 'inc'], [3, 'dec', 'inc'], [3, 'inc', 'dec'], [2, 'dec', 'dec'], [1, 'dec', 'dec']],
    ];
    for (const rows of goldens) {
      for (let r = 1; r < rows.length; r++) {
        const [tiles, start, end] = rows[r];
        const used = lineConsumed({ ops: times(tiles, tile('A')), start: { k: 'c2c', start, end } });
        expect([r + 1, used]).toEqual([r + 1, rows[r - 1][0]]);
        expect(lineProduced({ ops: times(tiles, tile('A')) })).toBe(tiles);
      }
    }
  });

  it('C2C W × H (research 07 §4.3): tiles(n) = tiles(n − 1) + [inc beg] − [dec end] for every rectangle', () => {
    for (const [W, H] of [[4, 4], [5, 3], [3, 5], [10, 7], [7, 10], [1, 5], [5, 1], [100, 60]]) {
      const tiles = (n: number): number => Math.min(n - 1, W - 1) - Math.max(0, n - H) + 1;
      for (let n = 2; n <= W + H - 1; n++) {
        const odd = n % 2 === 1;
        const blInc = n <= W;
        const rtInc = n <= H;
        const [startInc, endInc] = odd ? [rtInc, blInc] : [blInc, rtInc];
        const start: LineStart = { k: 'c2c', start: startInc ? 'inc' : 'dec', end: endInc ? 'inc' : 'dec' };
        expect(lineConsumed({ ops: times(tiles(n), tile('A')), start })).toBe(tiles(n - 1));
      }
    }
  });
});

describe('compact names (§2.10.11, research 07 §7.5)', () => {
  it('names one op: stitch, loop, color', () => {
    expect(tokenText(sc)).toBe('sc');
    expect(tokenText(hdc)).toBe('hdc');
    expect(tokenText(dc)).toBe('dc');
    expect(tokenText(slst)).toBe('sl st');
    expect(tokenText(inc)).toBe('inc');
    expect(tokenText(inc3)).toBe('inc3');
    expect(tokenText(dec)).toBe('dec');
    expect(tokenText(dec3)).toBe('dec3');
    expect(tokenText(colored(sc, 'A'))).toBe('sc A');
    expect(tokenText({ k: 'st', st: 'sc', loop: 'BLO' })).toBe('sc BLO');
    expect(tokenText({ k: 'st', st: 'sc', loop: 'FLO', color: 'B' })).toBe('sc FLO B');
    expect(tokenText({ k: 'st', st: 'sc', loop: 'both' })).toBe('sc');
    expect(tokenText(tile('C'))).toBe('C');
  });

  it('a decrease through one loop is an sc2tog, never an invisible decrease (§2.10.5)', () => {
    expect(tokenText({ k: 'dec', n: 2, loop: 'BLO' })).toBe('sc2tog BLO');
    expect(tokenText({ k: 'dec', n: 3, loop: 'FLO' })).toBe('sc3tog FLO');
    expect(tokenText({ k: 'dec', n: 2, loop: 'BLO' }, { hideLoop: true })).toBe('sc2tog');
    expect(tokenText({ k: 'dec', n: 2, loop: 'both' })).toBe('dec');
  });

  it('the mosaic long stitch reads "dc FLO 2 rows below" (§2.7.8)', () => {
    expect(tokenText({ k: 'st', st: 'dc', into: 'flo2below' })).toBe('dc FLO 2 rows below');
    expect(tokenText({ k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' })).toBe('dc FLO 2 rows below');
    expect(runText({ k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' }, 3, { hideLoop: true })).toBe('3 dc FLO 2 rows below');
  });

  it('hides the loop or one color on request, and takes other names', () => {
    const op: Op = { k: 'st', st: 'sc', loop: 'BLO', color: 'B' };
    expect(tokenText(op, { hideLoop: true })).toBe('sc B');
    expect(tokenText(op, { hideColor: 'B' })).toBe('sc BLO');
    expect(tokenText(op, { hideColor: 'A' })).toBe('sc BLO B');
    const uk = { ...US_COMPACT_NAMES, sc: 'dc', slst: 'ss', sc2tog: 'dc2tog' };
    expect(tokenText(sc, { names: uk })).toBe('dc');
    expect(tokenText(slst, { names: uk })).toBe('ss');
    expect(tokenText({ k: 'dec', n: 2, loop: 'BLO' }, { names: uk })).toBe('dc2tog BLO');
  });

  it('runText: "N op" = op in each of the next N sts; one op prints bare; tiles always print a count (§2.7.6)', () => {
    expect(runText(sc, 1)).toBe('sc');
    expect(runText(sc, 4)).toBe('4 sc');
    expect(runText(colored(sc, 'B'), 3)).toBe('3 sc B');
    expect(runText(colored(sc, 'B'), 1)).toBe('sc B');
    expect(runText(inc, 6)).toBe('6 inc');
    expect(runText(slst, 1)).toBe('sl st');
    expect(runText(tile('A'), 1)).toBe('1 A');
    expect(runText(tile('B'), 2)).toBe('2 B');
  });
});
