// §2.10.8 placement (normative), the jogless prep and joined-round overrides, oval rounds per segment, folding.
import { describe, expect, it } from 'vitest';
import type { Line, Op } from '../../../types/pattern';
import { consumed, produced } from '../../pattern/ops';
import { compactItems, lineItems } from '../../pattern/compact';
import { validateLines } from '../../pattern/validateLine';
import {
  basePlacement,
  changeSites,
  defaultRotation,
  feasibleChange,
  firstOvalLayout,
  foldable,
  foldRounds,
  isPlainSc,
  layoutCirc,
  layoutS,
  minCircularOffset,
  placeCircular,
  placeOvalRound,
  placePiece,
  r8Ok,
  rotateLeft,
  stackedPair,
  type OvalLayout,
} from '../place';
import { parseOps } from './helpers/ops';
import { researchGrouped } from './helpers/spec';
import { between, rng } from './helpers/random';

const text = (ops: readonly Op[]) => compactItems(lineItems({ kind: 'rnd', ops: [...ops] }, { docKind: '3d' }));
const names = (ops: readonly Op[]) => ops.map((o) => (o.k === 'st' ? o.st : `${o.k}${o.k === 'tile' ? '' : o.n}`));

describe('basePlacement (§2.10.8)', () => {
  it('research 07 §6.6 grouped layouts (no rotation)', () => {
    for (const ex of researchGrouped()) {
      const b = basePlacement(ex.P, ex.T);
      expect(`${text(b.base)} (${ex.T})`).toBe(ex.text);
    }
  });

  it('k, g, r and the counts', () => {
    const b = basePlacement(18, 24);
    expect([b.k, b.g, b.r, b.big]).toEqual([6, 2, 0, 0]);
    expect(consumed(b.base)).toBe(18);
    expect(produced(b.base)).toBe(24);
    expect(basePlacement(24, 24)).toMatchObject({ k: 0, g: 24 });
  });

  it('inc3 / dec3 when T > 2P or T < P/2, spread evenly among inc / dec', () => {
    const up = basePlacement(4, 10); // d = 6: inc3 sites 2, inc 2, k 4, plain 0
    expect(names(up.base)).toEqual(['inc2', 'inc3', 'inc2', 'inc3']);
    expect(produced(up.base)).toBe(10);
    const down = basePlacement(9, 4); // dec3 1, dec 3
    expect(down.big).toBe(1);
    expect(consumed(down.base)).toBe(9);
    expect(produced(down.base)).toBe(4);
    const many = basePlacement(10, 25); // big 5 of k 10: every other site
    expect(names(many.base).filter((n) => n === 'inc3').length).toBe(5);
    expect(names(many.base).map((n) => (n === 'inc3' ? 'X' : n === 'inc2' ? 'i' : '.')).join('')).toBe('iXiXiXiXiX');
  });

  it('refuses what even inc3 / dec3 cannot do', () => {
    expect(() => basePlacement(4, 13)).toThrow(RangeError);
    expect(() => basePlacement(7, 2)).toThrow(RangeError);
    expect(() => basePlacement(0, 3)).toThrow(RangeError);
    expect(() => basePlacement(2.5, 3)).toThrow(RangeError);
    expect(feasibleChange(4, 12)).toBe(true);
    expect(feasibleChange(4, 13)).toBe(false);
    expect(feasibleChange(9, 3)).toBe(true);
    expect(feasibleChange(10, 3)).toBe(false);
    expect(feasibleChange(0, 0)).toBe(true);
  });

  it('every feasible P → T up to 60 produces T from P (exhaustive)', () => {
    for (let P = 1; P <= 60; P++) {
      for (let T = Math.ceil(P / 3); T <= 3 * P; T++) {
        const b = basePlacement(P, T);
        expect(consumed(b.base)).toBe(P);
        expect(produced(b.base)).toBe(T);
        for (let c = 0; c < 2; c++) {
          const r = placeCircular(P, T, c);
          expect(consumed(r.ops)).toBe(P);
          expect(produced(r.ops)).toBe(T);
        }
      }
    }
  });

  it('rotation: ceil(g/2) ops when changeIdx is even, none when odd', () => {
    const b = basePlacement(18, 24);
    expect(defaultRotation(b, 0)).toBe(1);
    expect(defaultRotation(b, 1)).toBe(0);
    expect(text(placeCircular(18, 24, 2).ops)).toBe('(sc, inc, sc) x 6');
    expect(text(placeCircular(18, 24, 3).ops)).toBe('(2 sc, inc) x 6');
    expect(defaultRotation(basePlacement(30, 30), 0)).toBe(0);
  });
});

describe('R8 metrics', () => {
  it('G5 Rnds 3 → 4 sit exactly 1/(4k) apart (the tolerance of §2.13 keeps them in)', () => {
    const r3 = changeSites(placeCircular(12, 18, 1).ops);
    const r4 = changeSites(placeCircular(18, 24, 2).ops);
    expect(minCircularOffset(r3.centers, r4.centers)).toBeCloseTo(1 / 24, 12);
    expect(r8Ok(r3, r4)).toBe(true);
  });

  it('stacked increases (no rotation) fail R8 and are a stacked pair', () => {
    const a = changeSites(placeCircular(24, 30, 1).ops); // (3 sc, inc) x 6
    const b = changeSites(placeCircular(30, 36, 1).ops); // (4 sc, inc) x 6
    expect(r8Ok(a, b)).toBe(false);
    expect(stackedPair(a, b)).toBe(true);
  });

  it('out of scope: different k, or g = 0', () => {
    expect(r8Ok(changeSites(placeCircular(6, 12, 0).ops), changeSites(placeCircular(12, 18, 1).ops))).toBe(true);
    expect(r8Ok(changeSites(placeCircular(24, 30, 1).ops), changeSites(placeCircular(30, 34, 1).ops))).toBe(true);
    expect(r8Ok(undefined, changeSites(placeCircular(30, 34, 1).ops))).toBe(true);
  });

  it('site centers: (consumed before + CONS/2) / P', () => {
    expect(changeSites(parseOps('sc, dec, sc')).centers).toEqual([2 / 4]);
    expect(changeSites(parseOps('inc, 3 sc')).centers).toEqual([0.5 / 4]);
  });
});

describe('overrides of the rotation', () => {
  it('jogless prep: a round already ending in a plain sc keeps its rotation (cylinder Rnd 4)', () => {
    const r = placeCircular(18, 24, 2, { endPlain: true });
    expect(r.overrideFailed).toBe(false);
    expect(r.rotation).toBe(1);
    expect(isPlainSc(r.ops.at(-1) as Op)).toBe(true);
  });

  it('jogless prep: the smallest extra left rotation that ends in a plain sc (horn Rnd 3)', () => {
    const r = placeCircular(13, 19, 1, { endPlain: true });
    expect(r.rotation).toBe(1);
    expect(text(r.ops)).toBe('(sc, inc) x 6, sc');
  });

  it('jogless prep must still satisfy R8 against the previous change round', () => {
    const prev = changeSites(placeCircular(24, 30, 0).ops); // (sc, inc, 2 sc)… sites at 1.5/24 + j/6
    const plain = placeCircular(30, 36, 1, { endPlain: true, prevChange: prev });
    expect(isPlainSc(plain.ops.at(-1) as Op)).toBe(true);
    expect(r8Ok(prev, changeSites(plain.ops))).toBe(true);
  });

  it('no rotation qualifies: inc in each st around (the default stays, overrideFailed)', () => {
    const r = placeCircular(6, 12, 0, { endPlain: true });
    expect(r.overrideFailed).toBe(true);
    expect(text(r.ops)).toBe('6 inc');
  });

  it('joined rounds: a shaped round starts with a plain sc (§2.11.3)', () => {
    const r = placeCircular(12, 18, 0, { startPlain: true }); // default (inc, sc) x 6 → (sc, inc) x 6
    expect(isPlainSc(r.ops[0])).toBe(true);
    expect(text(r.ops)).toBe('(sc, inc) x 6');
    expect(placeCircular(6, 12, 0, { startPlain: true }).overrideFailed).toBe(true);
  });

  it('rotateLeft', () => {
    expect(rotateLeft([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1]);
    expect(rotateLeft([1, 2, 3, 4], 5)).toEqual([2, 3, 4, 1]);
    expect(rotateLeft([1, 2, 3, 4], -1)).toEqual([4, 1, 2, 3]);
    expect(rotateLeft([], 3)).toEqual([]);
  });
});

describe('oval rounds per segment (§2.10.2, §2.10.8)', () => {
  const total = (l: OvalLayout) => l.arcs.reduce((s, a) => s + a.n, 0);

  it('the chain-oval layout: 1 + S + 3 + S + 2 sts, ends 3 + 3', () => {
    const l = firstOvalLayout(7);
    expect(total(l)).toBe(20);
    expect(layoutCirc(l)).toBe(6);
    expect(layoutS(l)).toBe(7);
  });

  it('G8 Rnds 2 and 3 with their segments', () => {
    const r2 = placeOvalRound(firstOvalLayout(7), { circ: 12, S: 7, changeIdx: 0, round: 2 });
    expect(r2.segments).toEqual([
      { at: 0, kind: 'end' },
      { at: 1, kind: 'side' },
      { at: 8, kind: 'end' },
      { at: 11, kind: 'side' },
      { at: 18, kind: 'end' },
    ]);
    expect(produced(r2.ops)).toBe(26);
    const r3 = placeOvalRound(r2.next, { circ: 18, S: 7, changeIdx: 1, round: 3 });
    expect(compactItems(lineItems({ kind: 'rnd', ops: r3.ops, segments: r3.segments }, { docKind: '3d' }))).toBe('sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2');
    expect(layoutCirc(r3.next)).toBe(18);
    expect(layoutS(r3.next)).toBe(7);
  });

  it('a side change sits at the middle of each side', () => {
    const r = placeOvalRound(firstOvalLayout(7), { circ: 6, S: 8, changeIdx: 1, round: 2 });
    const sides = r.segments.flatMap((s, i) => (s.kind === 'side' ? [r.ops.slice(s.at, r.segments[i + 1]?.at ?? r.ops.length)] : []));
    expect(sides.map(text)).toEqual(['3 sc, inc, 3 sc', '3 sc, inc, 3 sc']);
    const d = placeOvalRound(firstOvalLayout(7), { circ: 6, S: 6, changeIdx: 1, round: 2 });
    const dsides = d.segments.flatMap((s, i) => (s.kind === 'side' ? [d.ops.slice(s.at, d.segments[i + 1]?.at ?? d.ops.length)] : []));
    expect(dsides.map(text)).toEqual(['2 sc, dec, 3 sc', '2 sc, dec, 3 sc']);
  });

  it('a magic-ring oval grows its sides from 0 (the ends make the new side stitches) and shrinks them back to 0', () => {
    let layout = firstOvalLayout(0);
    const plan = [
      { circ: 12, S: 1 },
      { circ: 18, S: 2 },
      { circ: 18, S: 1 },
      { circ: 12, S: 0 },
      { circ: 6, S: 0 },
    ];
    let prev = 6;
    plan.forEach((x, i) => {
      const r = placeOvalRound(layout, { ...x, changeIdx: i, round: i + 2 });
      expect(consumed(r.ops), JSON.stringify({ x, layout })).toBe(prev);
      expect(produced(r.ops)).toBe(x.circ + 2 * x.S);
      expect(layoutCirc(r.next)).toBe(x.circ);
      expect(r.next.arcs.filter((a) => a.kind === 'side').map((a) => a.n)).toEqual([x.S, x.S]);
      prev = produced(r.ops);
      layout = r.next;
    });
  });

  it('a decrease that would straddle the round start is never made (the arc is rotated or split)', () => {
    // end A: 1 st opens the round, 3 close it; 4 → 2 is two decs
    const layout: OvalLayout = { arcs: [{ kind: 'end', n: 4 }, { kind: 'side', n: 2 }, { kind: 'end', n: 4 }, { kind: 'side', n: 2 }], tail: 3 };
    const r = placeOvalRound(layout, { circ: 4, S: 2, changeIdx: 0, round: 5 });
    expect(consumed(r.ops)).toBe(12);
    expect(produced(r.ops)).toBe(8);
    const first = r.ops.slice(0, r.segments[1].at);
    const last = r.ops.slice(r.segments[r.segments.length - 1].at);
    expect(consumed(first)).toBe(1);
    expect(consumed(last)).toBe(3);
  });

  it('jogless prep rotates inside the last segment only', () => {
    const r = placeOvalRound(firstOvalLayout(5), { circ: 12, S: 5, changeIdx: 0, round: 2, endPlain: true });
    // the last segment (end A's closing part) is `2 inc`: no plain sc, so the trick is skipped
    expect(r.overrideFailed).toBe(true);
    const r2 = placeOvalRound(r.next, { circ: 16, S: 5, changeIdx: 1, round: 3, endPlain: true });
    expect(r2.overrideFailed).toBe(false);
    expect(isPlainSc(r2.ops.at(-1) as Op)).toBe(true);
  });

  it('random oval rounds conserve stitches and keep the sides at S (2000 rounds)', () => {
    const rand = rng(4242);
    for (let t = 0; t < 200; t++) {
      const S0 = Math.floor(between(rand, 0, 6));
      let layout = firstOvalLayout(S0);
      let c = 6;
      let S = S0;
      let prev = 6 + 2 * S0;
      for (let k = 2; k <= 11; k++) {
        const nc = Math.max(6, Math.min(2 * c, Math.max(Math.ceil(c / 2), c + Math.round(between(rand, -6, 7)))));
        const nS = Math.max(0, S + Math.round(between(rand, -1, 1)));
        const r = placeOvalRound(layout, { circ: nc, S: nS, changeIdx: k, round: k, endPlain: rand() < 0.3 });
        expect(consumed(r.ops)).toBe(prev);
        expect(produced(r.ops)).toBe(nc + 2 * nS);
        expect(layoutCirc(r.next)).toBe(nc);
        expect(r.next.arcs.filter((a) => a.kind === 'side').map((a) => a.n)).toEqual([nS, nS]);
        expect(r.segments.every((s, i) => i === 0 || s.at >= r.segments[i - 1].at)).toBe(true);
        layout = r.next;
        c = nc;
        S = nS;
        prev = nc + 2 * nS;
      }
    }
  });
});

describe('placePiece', () => {
  it('a magic ring that does not match round 1, or a start that cannot begin a piece, throws', () => {
    expect(() => placePiece({ counts: [6, 12], start: { k: 'mr', n: 5 } })).toThrow(RangeError);
    expect(() => placePiece({ counts: [18], start: { k: 'chainOval', chains: 10 } })).toThrow(RangeError);
    expect(() => placePiece({ counts: [6], start: { k: 'turn', chains: 1 } })).toThrow(RangeError);
    expect(placePiece({ counts: [], start: { k: 'mr', n: 6 } })).toEqual([]);
  });

  it('a chain-ring start works its first round into the chains (torus-like open start)', () => {
    const lines = placePiece({ counts: [24, 30, 30], start: { k: 'chainRing', chains: 24 } });
    expect(lines[0].ops.length).toBe(24);
    expect(validateLines(lines, { docKind: '3d' })).toEqual([]);
    const grow = placePiece({ counts: [30, 30], start: { k: 'chainRing', chains: 24 } });
    expect(consumed(grow[0].ops)).toBe(24);
    expect(validateLines(grow, { docKind: '3d' })).toEqual([]);
  });

  it('BLO/FLO: every op of the round carries the loop; the jogless sl st keeps its color', () => {
    const lines = placePiece({ counts: [6, 12, 18, 18, 12], loops: ['both', 'both', 'both', 'BLO', 'FLO'], start: { k: 'mr', n: 6 } });
    expect(lines[3].ops.every((o) => o.k !== 'tile' && o.loop === 'BLO')).toBe(true);
    expect(lines[4].ops.every((o) => o.k !== 'tile' && o.loop === 'FLO')).toBe(true);
    expect(lines[2].ops.at(-1)).toEqual({ k: 'st', st: 'slst' });
    // a FLO round after a BLO round: a new transition, so the BLO round ends with the jogless sl st too
    expect(lines[3].ops.at(-1)).toEqual({ k: 'st', st: 'slst', loop: 'BLO' });
    expect(validateLines(lines, { docKind: '3d' })).toEqual([]);
  });

  it('a BLO round after a BLO round needs no new prep', () => {
    const lines = placePiece({ counts: [6, 12, 12, 12, 12], loops: ['both', 'both', 'BLO', 'BLO', 'both'], start: { k: 'mr', n: 6 } });
    expect(lines[1].ops.at(-1)?.k).toBe('inc'); // inc in each st around cannot take the trick
    expect(lines[1].cues?.[0].kind).toBe('note');
    expect(lines[2].ops.at(-1)).toEqual({ k: 'st', st: 'sc', loop: 'BLO' });
    expect(lines[2].cues).toBeUndefined();
  });

  it('spiral: false (joined sections) leaves the rounds alone', () => {
    const lines = placePiece({ counts: [6, 12, 18, 18], loops: ['both', 'both', 'both', 'BLO'], start: { k: 'mr', n: 6 } }, { spiral: false });
    expect(lines[2].ops.some((o) => o.k === 'st' && o.st === 'slst')).toBe(false);
    expect(lines[2].cues).toBeUndefined();
  });

  it('changeIdx counts only rounds with changes (plain rounds in between do not flip the phase)', () => {
    const a = placePiece({ counts: [6, 12, 18, 24], start: { k: 'mr', n: 6 } });
    const b = placePiece({ counts: [6, 12, 18, 18, 18, 24], start: { k: 'mr', n: 6 } });
    expect(b[5].ops).toEqual(a[3].ops);
  });
});

describe('folding (E_FOLD is checked by the validator)', () => {
  const plain = (n: number, extra: Partial<Line> = {}): Line => ({ kind: 'rnd', n, ops: Array.from({ length: 12 }, () => ({ k: 'st', st: 'sc' }) as Op), prevCount: 12, stated: 12, ...extra });

  it('folds identical plain rounds only', () => {
    expect(foldRounds([plain(3), plain(4), plain(5)])).toEqual([{ ...plain(3), nEnd: 5 }]);
    expect(foldRounds([plain(3), plain(4, { colorHeader: 'B' }), plain(5)]).length).toBe(3);
    expect(foldRounds([plain(3), plain(4, { cues: [{ kind: 'stuff', text: 'Stuff.' }] }), plain(5)]).length).toBe(3);
    expect(foldRounds([plain(3), plain(4, { notes: ['x'] })]).length).toBe(2);
    expect(foldRounds([plain(3), plain(5)]).length).toBe(2); // not consecutive
    const blo = plain(4, { ops: plain(4).ops.map((o) => ({ ...o, loop: 'BLO' as const })) });
    expect(foldRounds([plain(3), blo]).length).toBe(2);
    expect(foldable(plain(3, { prevCount: 10, stated: 12 }), plain(4))).toBe(false);
  });
});
