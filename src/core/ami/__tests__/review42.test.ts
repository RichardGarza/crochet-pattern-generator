// Regression tests for the T4.2 review findings (docs/tracks/t4.md, T4.2 "Review").
import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../../test/timing';
import type { Line, Op } from '../../../types/pattern';
import { consumed, produced } from '../../pattern/ops';
import { validateLines } from '../../pattern/validateLine';
import { firstOvalLayout, placeOvalRound, placePiece } from '../place';
import { profileOf } from '../profiles';
import { validatePiece3d } from '../validate3d';
import { part } from './helpers/goldens';
import { buildPiece } from './helpers/pieces';
import { between, randomGauge, rng } from './helpers/random';

const cell = { wS: 0.2, hS: 0.2 };
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('finding 1: an end that cannot be cut at the round start takes another split', () => {
  it('the trimmed oval ellipsoid of the review (0.9·L) is placed and valid', () => {
    const p = part('ellipsoid', { rx: 0.59847, ry: 0.20594, rz: 0.54363 });
    const L = profileOf(p, { axis: 'z', start: 'top' })?.L as number;
    const b = buildPiece('r', p, { wS: 0.188, hS: 0.188, style: 'exact', axis: 'z', start: 'top', trimAt: 0.9 * L });
    expect(b.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('the direct repros', () => {
    for (const shape of [
      { counts: [6, 14, 14, 12, 5], circ: [6, 12, 10, 10, 5], ovalS: [0, 1, 2, 1, 0], start: { k: 'mr' as const, n: 6 } },
      { counts: [20, 26, 20, 17], circ: [6, 12, 6, 3], ovalS: [7, 7, 7, 7], start: { k: 'chainOval' as const, chains: 10 } },
    ]) {
      const lines = placePiece(shape);
      expect(lines.map((l) => l.stated)).toEqual(shape.counts);
      expect(validateLines(lines, { docKind: '3d' })).toEqual([]);
    }
  });

  it('random oval ellipsoids trimmed anywhere up to the 10%-buried limit, small circular parts included', { timeout: 120_000 }, () => {
    const rand = rng(31337);
    for (let i = 0; i < 800; i++) {
      const a = between(rand, 0.2, 2);
      const p = part('ellipsoid', { rx: a, ry: a / between(rand, 1.16, 4), rz: between(rand, 0.15, 2) });
      const g = randomGauge(rand);
      const L = profileOf(p, { axis: 'z', start: 'top' })?.L as number;
      if (L / g.hS > 150) continue;
      const trimAt = between(rand, 0.5, 1) * L;
      for (const style of ['exact', 'classic'] as const) {
        const b = buildPiece('o', p, { ...g, style, axis: 'z', start: 'top', ...(trimAt < L ? { trimAt } : {}) });
        expect(b.issues.filter((x) => x.severity === 'error'), JSON.stringify({ i, dims: p.dims, g, style, trimAt })).toEqual([]);
      }
    }
  });
});

describe('finding 2: an absurd nEnd is E_SANITY at once', () => {
  it('nEnd 1e9 does not expand', { ...PERF }, () => {
    const lines: Line[] = [
      { kind: 'rnd', n: 1, ops: Array.from({ length: 6 }, () => ({ k: 'st', st: 'sc' }) as Op), prevCount: null, stated: 6, start: { k: 'mr', n: 6 } },
      { kind: 'rnd', n: 2, nEnd: 1e9, ops: Array.from({ length: 6 }, () => ({ k: 'st', st: 'sc' }) as Op), prevCount: 6, stated: 6 },
    ];
    const t = Date.now();
    expect(codes(validatePiece3d({ id: 'p', lines, style: 'exact', cell }))).toContain('E_SANITY');
    expect(Date.now() - t).toBeLessThan(budget(1000));
  });

  it('a non-piece input is one E_SANITY, never a throw', () => {
    expect(codes(validatePiece3d(null as never))).toEqual(['E_SANITY']);
    expect(codes(validatePiece3d({ id: 'p' } as never))).toEqual(['E_SANITY']);
  });
});

describe('finding 3: E_FOLD compares what prints, not key order', () => {
  it('reordered keys and an explicit loop: both are the same round', () => {
    const unfolded = placePiece({ counts: [6, 12, 12, 12, 6], start: { k: 'mr', n: 6 } });
    const folded = [unfolded[0], unfolded[1], { ...unfolded[2], nEnd: 4 }, unfolded[4]];
    const rebuilt = unfolded.map(({ ops, ...rest }) => ({ ops: ops.map((o) => ({ ...o, loop: 'both' as const })), ...rest }));
    expect(codes(validatePiece3d({ id: 'p', lines: folded, unfolded: rebuilt, style: 'exact', cell, finish: 'gather' }))).toEqual([]);
  });
});

describe('findings 5–7: round 1 loops, |ΔS| = 2, side stitches from both ends, empty segments', () => {
  it('BLO on round 1 of a magic ring or chain oval throws', () => {
    expect(() => placePiece({ counts: [6, 12], loops: ['BLO', 'both'], start: { k: 'mr', n: 6 } })).toThrow(RangeError);
    expect(() => placePiece({ counts: [20], loops: ['FLO'], start: { k: 'chainOval', chains: 10 } })).toThrow(RangeError);
  });

  it('a side may also go 2 → 0', () => {
    const r = placeOvalRound(firstOvalLayout(2), { circ: 6, S: 0, changeIdx: 0, round: 2 });
    expect(consumed(r.ops)).toBe(10);
    expect(produced(r.ops)).toBe(6);
  });

  it('a magic-ring oval growing its sides from 0: each end makes one side stitch; no empty segments', () => {
    const r = placeOvalRound(firstOvalLayout(0), { circ: 6, S: 1, changeIdx: 0, round: 2 });
    expect(produced(r.ops)).toBe(8);
    const parts = r.segments.map((s, i) => r.ops.slice(s.at, r.segments[i + 1]?.at ?? r.ops.length));
    expect(parts.every((x) => x.length > 0)).toBe(true);
    expect(parts.filter((x) => x.some((o) => o.k === 'inc')).length).toBe(2);
  });
});

describe('finding 11: W_SINGLE_ST once per printed line', () => {
  it('a folded line with a single-stitch run warns once', () => {
    const ops: Op[] = [...Array.from({ length: 5 }, () => ({ k: 'st', st: 'sc' }) as Op), { k: 'st', st: 'sc', color: 'B' }];
    const lines: Line[] = [
      { kind: 'rnd', n: 1, ops: Array.from({ length: 6 }, () => ({ k: 'st', st: 'sc' }) as Op), prevCount: null, stated: 6, start: { k: 'mr', n: 6 } },
      { kind: 'rnd', n: 2, nEnd: 4, ops, prevCount: 6, stated: 6 },
    ];
    expect(codes(validatePiece3d({ id: 'p', lines, style: 'exact', cell })).filter((c) => c === 'W_SINGLE_ST')).toEqual(['W_SINGLE_ST']);
  });
});
