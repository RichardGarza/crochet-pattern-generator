// The piece-level 3D validators of §2.13: each rule fires on a crafted piece, stays silent on a sound one, has one
// code and one severity, and never repeats a kernel finding.
import { describe, expect, it } from 'vitest';
import type { Issue } from '../../../types/issues';
import type { Line, Op } from '../../../types/pattern';
import { foldRounds, placePiece } from '../place';
import { foldIssues, validate3d, validatePiece3d, type Piece3dInput } from '../validate3d';
import { buildPiece } from './helpers/pieces';
import { goldenCases } from './helpers/goldens';
import { parseOps } from './helpers/ops';

const cell = { wS: 0.2, hS: 0.2 };
const sc = (n: number, extra: Partial<Op> = {}): Op[] => Array.from({ length: n }, () => ({ k: 'st', st: 'sc', ...extra }) as Op);
const rnd = (n: number, ops: Op[], prev: number | null, extra: Partial<Line> = {}): Line => ({
  kind: 'rnd',
  n,
  ops,
  prevCount: prev,
  stated: ops.reduce((s, o) => s + (o.k === 'inc' ? o.n : 1), 0),
  ...extra,
});
const mr = (n: number): Line => rnd(1, sc(n), null, { start: { k: 'mr', n } });
const check = (lines: Line[], extra: Partial<Piece3dInput> = {}) => validatePiece3d({ id: 'p', lines, style: 'exact', cell, ...extra });
const codes = (issues: Issue[]) => issues.map((i) => i.code);
const sphere = () => placePiece({ counts: [6, 12, 18, 24, 24, 18, 12, 6], start: { k: 'mr', n: 6 } });

describe('validatePiece3d', () => {
  it('a sound piece has no issue; every issue is frozen, carries the piece, and its severity is its prefix', () => {
    expect(check(sphere(), { finish: 'gather' })).toEqual([]);
    const bad = check([mr(9), rnd(2, parseOps('sc, inc3, 7 sc'), 9)], { finish: 'gather' });
    expect(bad.length).toBeGreaterThan(0);
    for (const i of bad) {
      expect(Object.isFrozen(i)).toBe(true);
      expect(i.where?.piece).toBe('p');
      expect(i.severity).toBe(i.code.startsWith('E_') ? 'error' : i.code.startsWith('W_') ? 'warn' : 'info');
    }
  });

  it('includes the kernel’s line issues once, and stops at E_SANITY', () => {
    const lines = [mr(6), rnd(2, sc(12), 6)]; // consumes 12 of 6
    expect(codes(check(lines))).toEqual(['E_CONSUME']);
    const garbage = [{ ...mr(6), n: -1 }] as Line[];
    expect(codes(check(garbage))).toEqual(['E_SANITY']);
  });

  it('never throws', () => {
    expect(() => check([{ kind: 'rnd', n: 1, ops: null } as unknown as Line])).not.toThrow();
    expect(() => validatePiece3d({ id: 'p', lines: [], style: 'exact', cell })).not.toThrow();
  });

  it('validate3d concatenates pieces', () => {
    expect(validate3d([{ id: 'a', lines: sphere(), style: 'exact', cell }, { id: 'b', lines: [mr(9)], style: 'exact', cell }]).map((i) => `${i.where?.piece}:${i.code}`)).toEqual(['b:E_START']);
  });
});

describe('E_START (the parts the kernel leaves to T4)', () => {
  it('magic ring size by style: classic 6, exact 5–8, flattened 4–8, oval 6', () => {
    const piece = (n: number) => [mr(n), rnd(2, sc(n), n)];
    expect(codes(check(piece(5), { style: 'classic' }))).toEqual(['E_START']);
    expect(codes(check(piece(6), { style: 'classic' }))).toEqual([]);
    expect(codes(check(piece(5)))).toEqual([]);
    expect(codes(check(piece(9)))).toEqual(['E_START']);
    expect(codes(check(piece(4)))).toEqual(['E_START', 'W_MIN_PART']);
    expect(codes(check(piece(4), { flattened: true }))).toEqual(['W_MIN_PART']);
    const b = buildPiece('box', goldenCases().find((c) => c.id === 'G19-box-closed-oval')!.part, { wS: 0.2, hS: 0.2, style: 'exact' });
    expect(codes(check([mr(7)], { counts: { ...b.counts, start: { k: 'mr', n: 7 } } }))).toEqual(['E_START']);
  });

  it('chain oval: n₁ = 2·chains with S ≥ 1', () => {
    const ok = placePiece({ counts: [20], start: { k: 'chainOval', chains: 10 } });
    expect(codes(check(ok))).toEqual([]);
    const ch3 = rnd(1, parseOps('sc, inc3, inc'), null, { start: { k: 'chainOval', chains: 3 } });
    expect(codes(check([ch3]))).toEqual(['E_START']);
  });

  it('the pole rule: no decrease while ideal_k < n₁', () => {
    const c = buildPiece('s', goldenCases()[0].part, goldenCases()[0].opts).counts;
    const counts = { ...c, generator: 'pathA' as const, circ: [6, 5, 6], ideal: [5.2, 4.9, 6.4] };
    const lines = placePiece({ counts: [6, 5, 6], start: { k: 'mr', n: 6 } });
    expect(codes(check(lines, { counts }))).toEqual(['E_START']);
  });

  it('a first line the kernel already flagged gets no second E_START', () => {
    const wrong = rnd(1, [...sc(4), { k: 'inc', n: 2 }], null, { start: { k: 'mr', n: 5 } });
    expect(codes(check([wrong])).filter((c) => c === 'E_START')).toEqual(['E_START']);
  });
});

describe('E_CLOSE / W_CLOSE (R9)', () => {
  it('gathered ends: 4–8, 7–8 warn', () => {
    const at = (n: number) => [mr(Math.min(8, Math.max(5, n))), rnd(2, sc(Math.min(8, Math.max(5, n))), Math.min(8, Math.max(5, n)))];
    expect(codes(check(placePiece({ counts: [6, 12, 6], start: { k: 'mr', n: 6 } }), { finish: 'gather' }))).toEqual([]);
    expect(codes(check(at(8), { finish: 'gather' }))).toEqual(['W_CLOSE']);
    expect(codes(check(placePiece({ counts: [6, 12, 18, 12], start: { k: 'mr', n: 6 } }), { finish: 'gather' }))).toEqual(['E_CLOSE']);
    expect(codes(check(placePiece({ counts: [6, 9, 3], start: { k: 'mr', n: 6 } }), { finish: 'gather' }))).toContain('E_CLOSE');
    expect(codes(check(placePiece({ counts: [6, 12, 4], start: { k: 'mr', n: 6 } }), { finish: 'gather' }))).not.toContain('E_CLOSE');
    expect(codes(check(placePiece({ counts: [6, 12, 18, 12], start: { k: 'mr', n: 6 } }), { finish: 'open' }))).toEqual([]);
  });

  it('closed-oval finish: 2S + 6 with S ≥ 2', () => {
    const box = buildPiece('box', goldenCases().find((c) => c.id === 'G19-box-closed-oval')!.part, { wS: 0.2, hS: 0.2, style: 'exact' });
    expect(codes(box.issues)).toEqual([]);
    expect(codes(check(placePiece({ counts: [6, 12, 9], start: { k: 'mr', n: 6 } }), { finish: 'flattenSc' }))).toEqual(['E_CLOSE']);
    expect(codes(check(placePiece({ counts: [6, 12, 8], start: { k: 'mr', n: 6 } }), { finish: 'flattenSc' }))).toEqual(['E_CLOSE']); // S = 1
    expect(codes(check(placePiece({ counts: [6, 12, 10], start: { k: 'mr', n: 6 } }), { finish: 'flattenSc' }))).toEqual([]);
  });
});

describe('E_SPIRAL_CHAIN', () => {
  it('a spiral round that starts with a turning chain; joined rounds are exempt', () => {
    const lines = sphere();
    lines[2] = { ...lines[2], start: { k: 'turn', chains: 1 } };
    expect(codes(check(lines))).toContain('E_SPIRAL_CHAIN');
    const joined = sphere();
    joined[2] = { ...joined[2], start: { k: 'join' }, join: {} };
    expect(codes(check(joined))).not.toContain('E_SPIRAL_CHAIN');
  });
});

describe('E_FOLD', () => {
  it('a fold of identical rounds passes; folding different rounds or changing counts fails', () => {
    const unfolded = placePiece({ counts: [6, 12, 12, 12, 12, 6], start: { k: 'mr', n: 6 } });
    const folded = foldRounds(unfolded);
    expect(folded.length).toBe(4);
    expect(foldIssues(unfolded, folded)).toEqual([]);
    expect(codes(check(folded, { unfolded }))).toEqual([]);
    // a hand-made fold over a round with a stuffing cue
    const cued = unfolded.map((l) => (l.n === 4 ? { ...l, cues: [{ kind: 'stuff' as const, text: 'Begin stuffing.' }] } : l));
    const bad = [cued[0], cued[1], { ...cued[2], nEnd: 5 }, cued[5]];
    expect(codes(check(bad, { unfolded: cued }))).toEqual(['E_FOLD']);
    // a fold that skips a round
    expect(foldIssues(unfolded, [unfolded[0], unfolded[1], unfolded[3], unfolded[4], unfolded[5]]).length).toBeGreaterThan(0);
    // printed rounds that stop early
    expect(foldIssues(unfolded, unfolded.slice(0, 4)).length).toBeGreaterThan(0);
  });
});

describe('colors: E_COLOR_SEQ, W_ROUND_COLORS, W_SINGLE_ST (R12)', () => {
  const ring = mr(6);
  it('a whole-round change needs "change to B" on the round before', () => {
    const lines = [ring, rnd(2, sc(6), 6, { colorHeader: 'B' })];
    expect(codes(check(lines))).toEqual(['E_COLOR_SEQ']);
    lines[0] = { ...ring, cues: [{ kind: 'color', text: 'change to B on the last yo' }] };
    expect(codes(check(lines))).toEqual([]);
    const joined = [{ ...ring, join: { changeTo: 'B' } }, rnd(2, sc(6), 6, { colorHeader: 'B', start: { k: 'join' }, join: {} })];
    expect(codes(check(joined)).filter((c) => c === 'E_COLOR_SEQ')).toEqual([]);
  });

  it('a tagged first stitch says its color itself', () => {
    const lines = [ring, rnd(2, [...sc(3, { color: 'B' }), ...sc(3, { color: 'A' })], 6)];
    expect(codes(check(lines))).toEqual([]);
  });

  it('3 colors warn, 4 are an error', () => {
    const three = [ring, rnd(2, [...sc(2, { color: 'A' }), ...sc(2, { color: 'B' }), ...sc(2, { color: 'C' })], 6)];
    expect(codes(check(three))).toEqual(['W_ROUND_COLORS']);
    const four = [ring, rnd(2, [...sc(2, { color: 'A' }), ...sc(2, { color: 'B' }), sc(1, { color: 'C' })[0], sc(1, { color: 'D' })[0]], 6)];
    expect(codes(check(four))).toContain('E_COLOR_SEQ');
  });

  it('a color run of a single stitch', () => {
    const lines = [ring, rnd(2, [...sc(3), ...sc(1, { color: 'B' }), ...sc(2)], 6), rnd(3, sc(6), 6)];
    expect(codes(check(lines))).toEqual(['W_SINGLE_ST']);
  });
});

describe('cues: E_EYE_ORDER, W_EYE_OPENING; W_JOG', () => {
  const eyes = { kind: 'eyes' as const, text: 'Insert the safety eyes.' };
  const stuff = { kind: 'stuff' as const, text: 'Begin stuffing.' };
  it('eyes before stuffing and before the closing round', () => {
    const lines = placePiece({ counts: [6, 12, 18, 24, 24, 24, 18, 12, 6], start: { k: 'mr', n: 6 } });
    const big = { wS: 0.25, hS: 0.25 };
    lines[4].cues = [eyes];
    lines[5].cues = [stuff];
    expect(codes(check(lines, { finish: 'gather', cell: big }))).toEqual([]);
    lines[4].cues = [stuff, eyes];
    expect(codes(check(lines, { finish: 'gather', cell: big }))).toEqual(['E_EYE_ORDER']);
    lines[4].cues = [];
    lines[8].cues = [eyes];
    expect(codes(check(lines, { finish: 'gather', cell: big }))).toEqual(['E_EYE_ORDER', 'E_EYE_ORDER', 'W_EYE_OPENING']);
  });

  it('W_EYE_OPENING below 3 in around', () => {
    const lines = placePiece({ counts: [6, 12, 12, 6], start: { k: 'mr', n: 6 } });
    lines[1].cues = [eyes];
    expect(codes(check(lines, { finish: 'gather' }))).toEqual(['W_EYE_OPENING']); // 12 × 0.2 = 2.4 in
  });

  it('W_JOG where the round before a BLO round has no jogless sl st', () => {
    const lines = placePiece({ counts: [6, 12, 18, 18], loops: ['both', 'both', 'both', 'BLO'], start: { k: 'mr', n: 6 } });
    expect(codes(check(lines))).toEqual([]);
    const noPrep = placePiece({ counts: [6, 12, 18, 18], loops: ['both', 'both', 'both', 'BLO'], start: { k: 'mr', n: 6 } }, { spiral: false });
    expect(codes(check(noPrep))).toEqual(['W_JOG']);
    const afterRing = placePiece({ counts: [6, 6], loops: ['both', 'BLO'], start: { k: 'mr', n: 6 } });
    expect(codes(check(afterRing))).toEqual(['W_JOG']);
  });
});

describe('shaping: W_RUFFLE, W_FAN3, W_SPACING, W_STAGGER, W_STACKED, W_MIN_PART', () => {
  it('W_RUFFLE beyond ⌈2π·hS/wS⌉ per round', () => {
    expect(codes(check(placePiece({ counts: [6, 12, 18], start: { k: 'mr', n: 6 } })))).toEqual([]);
    expect(codes(check(placePiece({ counts: [6, 12, 20], start: { k: 'mr', n: 6 } })))).toEqual(['W_RUFFLE']);
  });

  it('W_FAN3 for inc3 / dec3, but not for a chain oval’s first round', () => {
    expect(codes(check(placePiece({ counts: [6, 14], start: { k: 'mr', n: 6 } })))).toEqual(['W_RUFFLE', 'W_FAN3']);
    expect(codes(check(placePiece({ counts: [8, 8, 15, 15, 7], start: { k: 'mr', n: 8 } })))).toEqual(['W_RUFFLE', 'W_FAN3']); // 15 → 7 needs a dec3
    expect(codes(check(placePiece({ counts: [20, 26], circ: [6, 12], ovalS: [7, 7], start: { k: 'chainOval', chains: 10 } })))).toEqual([]);
  });

  it('W_SPACING: uneven gaps over the whole round', () => {
    const lines = [mr(8), rnd(2, parseOps('sc, inc, sc, inc, sc, sc, sc, inc'), 8)];
    expect(codes(check(lines))).toEqual(['W_SPACING']);
  });

  it('W_STAGGER and W_STACKED: three change rounds with their increases on top of each other', () => {
    const lines = [mr(6), rnd(2, parseOps('6 inc'), 6), rnd(3, parseOps('(sc, inc) x 6'), 12), rnd(4, parseOps('(2 sc, inc) x 6'), 18), rnd(5, parseOps('(3 sc, inc) x 6'), 24), rnd(6, parseOps('(4 sc, inc) x 6'), 30), rnd(7, parseOps('(5 sc, inc) x 6'), 36)];
    const c = codes(check(lines));
    expect(c.filter((x) => x === 'W_STAGGER').length).toBe(4);
    expect(c.filter((x) => x === 'W_STACKED')).toEqual(['W_STACKED']);
  });

  it('oval rounds: end segments are exempt; a side with ≥ 2 uneven specials is not', () => {
    const segs: Line['segments'] = [
      { at: 0, kind: 'end' },
      { at: 1, kind: 'side' },
      { at: 8, kind: 'end' },
      { at: 11, kind: 'side' },
      { at: 18, kind: 'end' },
    ];
    // G8 Rnd 2: its specials cluster in the end segments — no issue
    const g8 = placePiece({ counts: [20, 26], circ: [6, 12], ovalS: [7, 7], start: { k: 'chainOval', chains: 10 } });
    expect(codes(check(g8))).toEqual([]);
    // the same round without segments has gaps 7, 0, 0, 7, 0, 0 over the whole round
    expect(codes(check([g8[0], { ...g8[1], segments: undefined }]))).toEqual(['W_SPACING']);
    // a side of 7 holding two increases, unevenly
    const ops = parseOps('inc, inc, sc, inc, 3 sc, inc, 3 inc, 7 sc, 2 inc');
    expect(codes(check([g8[0], { ...rnd(2, ops, 20), segments: segs }]))).toEqual(['W_RUFFLE', 'W_SPACING']); // +9 also ruffles
  });

  it('W_MIN_PART: never 5 sts around', () => {
    expect(codes(check([mr(4), rnd(2, sc(4), 4)], { flattened: true }))).toEqual(['W_MIN_PART']);
    expect(codes(check([mr(5), rnd(2, sc(5), 5)]))).toEqual([]);
  });
});

describe('W_SIZE (R11, counts level)', () => {
  it('silent on every T4.1 golden; fires on a piece made too long', () => {
    for (const c of goldenCases()) expect(codes(buildPiece(c.id, c.part, c.opts).issues), c.id).toEqual([]);
    const s = buildPiece('s', goldenCases()[2].part, goldenCases()[2].opts);
    const longer = { ...s.counts, L: s.counts.L - 2 * 0.2 };
    expect(codes(check(s.lines, { counts: longer, profile: s.profile, finish: 'gather' }))).toEqual(['W_SIZE']);
    const narrow = { ...s.profile!, rMax: s.profile!.rMax * 1.2 };
    expect(codes(check(s.lines, { counts: s.counts, profile: narrow, finish: 'gather' }))).toEqual(['W_SIZE']);
  });

  it('E_SANITY: 200 rounds in one piece', () => {
    const lines = [mr(6), rnd(2, sc(6), 6, { nEnd: 200 })];
    expect(codes(check(lines))).toContain('E_SANITY');
  });
});
