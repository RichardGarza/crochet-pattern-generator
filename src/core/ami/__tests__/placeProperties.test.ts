// Property tests for T4.2 (§6.3 T4: "random lathe profiles never produce an E_*"; "G8, G19 and the teddy muzzle
// pass every E_* with no W_SPACING/W_STAGGER/W_STACKED from oval end segments"): random pieces go through the
// whole text pipeline — counts, placement, jogless prep, folding, T2's renderLine, validate3d.
import { describe, expect, it } from 'vitest';
import type { Issue } from '../../../types/issues';
import type { Part } from '../../../types/model';
import { profileOf } from '../profiles';
import type { Style } from '../rounds';
import { part } from './helpers/goldens';
import { buildPiece, type BuiltPiece } from './helpers/pieces';
import { between, randomBulge, randomGauge, randomLathe, randomSymmetricLathe, rng } from './helpers/random';

const HEAVY = { timeout: 120_000 } as const;
const STYLES: Style[] = ['exact', 'classic'];
const errors = (issues: readonly Issue[]) => issues.filter((i) => i.severity === 'error');
const R7R8 = new Set(['W_SPACING', 'W_STAGGER', 'W_STACKED']);

function tally(into: Map<string, number>, b: BuiltPiece) {
  for (const i of b.issues) into.set(i.code, (into.get(i.code) ?? 0) + 1);
}

describe('random lathes: no E_* after placement, folding and printing', HEAVY, () => {
  it('1000 random lathes × 2 styles, closed / trimmed / open far end, either start pole', () => {
    const rand = rng(9001);
    const seen = new Map<string, number>();
    let pieces = 0;
    for (let i = 0; i < 1000; i++) {
      const p = randomLathe(rand, { offAxisStart: rand() < 0.15 });
      const L = profileOf(p)?.L ?? 1;
      const g = randomGauge(rand, L);
      const u = rand();
      const extra = u < 0.25 ? { trimAt: between(rand, 0.3, 0.95) * L } : u < 0.4 ? { openFar: true } : {};
      const start = rand() < 0.5 ? ('top' as const) : ('bottom' as const);
      for (const style of STYLES) {
        const b = buildPiece(`lathe${i}`, p, { ...g, style, start, ...extra });
        pieces++;
        expect(errors(b.issues), JSON.stringify({ i, dims: p.dims, g, style, start, extra, counts: b.counts.counts, issues: b.issues.slice(0, 4) })).toEqual([]);
        expect(b.text.length).toBeGreaterThanOrEqual(b.lines.length);
        tally(seen, b);
      }
    }
    expect(pieces).toBe(2000);
    // warnings are allowed on random shapes; report them so a regression in their rate shows in the log
    console.info('T4.2 random lathes, warnings per code (2000 pieces):', Object.fromEntries([...seen].sort()));
  });

  it('200 symmetric and 100 single-bulge lathes: no E_*, and no W_STACKED on smooth shapes', () => {
    const rand = rng(77);
    for (let i = 0; i < 300; i++) {
      const p = i < 200 ? randomSymmetricLathe(rand) : randomBulge(rand);
      const g = randomGauge(rand, profileOf(p)?.L);
      for (const style of STYLES) {
        const b = buildPiece(`b${i}`, p, { ...g, style });
        expect(errors(b.issues), JSON.stringify({ i, style, counts: b.counts.counts })).toEqual([]);
      }
    }
  });
});

describe('oval pieces: no E_*, no W_SPACING / W_STAGGER / W_STACKED (end segments exempt, single mid-side changes)', HEAVY, () => {
  it('250 random oval ellipsoids and boxes × 2 styles × closed / trimmed', () => {
    const rand = rng(5150);
    let ovals = 0;
    const seen = new Map<string, number>();
    for (let i = 0; i < 250; i++) {
      const g = randomGauge(rand);
      const a = between(rand, 0.3, 3);
      const p: Part =
        i % 2 === 0
          ? part('ellipsoid', { rx: a, ry: a / between(rand, 1.16, 3), rz: between(rand, 0.2, 3) })
          : part('box', { w: between(rand, 0.4, 4), h: between(rand, 0.3, 4), d: between(rand, 0.3, 4) });
      const axis = i % 2 === 0 ? ('z' as const) : undefined;
      const L = profileOf(p, { axis })?.L ?? 1;
      if (L / g.hS > 150) continue;
      for (const style of STYLES) {
        for (const trim of [undefined, between(rand, 0.3, 0.9) * L]) {
          const b = buildPiece(`oval${i}`, p, { ...g, style, ...(axis ? { axis } : {}), start: rand() < 0.5 ? 'top' : 'bottom', ...(trim ? { trimAt: trim } : {}) });
          if (b.counts.ovalS) ovals++;
          expect(errors(b.issues), JSON.stringify({ i, type: p.type, dims: p.dims, g, style, trim, counts: b.counts.counts, S: b.counts.ovalS, issues: b.issues.slice(0, 3) })).toEqual([]);
          if (b.counts.ovalS) expect(b.issues.filter((x) => R7R8.has(x.code)), JSON.stringify({ i, dims: p.dims })).toEqual([]);
          tally(seen, b);
        }
      }
    }
    expect(ovals).toBeGreaterThan(500);
    console.info('T4.2 random ovals, warnings per code:', Object.fromEntries([...seen].sort()));
  });
});

describe('determinism', () => {
  it('the same piece gives the same lines and text', () => {
    const p = randomLathe(rng(3));
    const g = { wS: 0.21, hS: 0.2 };
    const a = buildPiece('a', p, { ...g, style: 'exact' });
    const b = buildPiece('a', p, { ...g, style: 'exact' });
    expect(JSON.stringify(b.lines)).toBe(JSON.stringify(a.lines));
    expect(b.text).toEqual(a.text);
  });
});
