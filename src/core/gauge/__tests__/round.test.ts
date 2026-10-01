import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mulberry32, randomRange } from '../../kernel/prng';
import * as gauge from '../index';
import { ceilTolerant, roundHalfUp } from '../round';

/** The random sweeps below check tens of thousands of values: a generous timeout, because other runs share the machine. */
const SWEEP_TIMEOUT_MS = 30_000;

describe('roundHalfUp — "Math.round = JS half-up rounding everywhere" (§2.10.5), decided as in exact arithmetic', () => {
  it('is Math.round for ordinary values, ties included', () => {
    for (const x of [0, 0.2, 0.49, 0.5, 0.51, 1, 1.5, 2.5, 3.4999, 99.5, 134.6, 1000.5, 123456.5]) {
      expect(roundHalfUp(x)).toBe(Math.round(x));
    }
    // negative ties round toward +∞, as Math.round does (`+ 0` turns Math.round's −0 into 0)
    for (const x of [-0.2, -0.5, -0.51, -1.5, -2.5, -2.50001, -99.5]) expect(roundHalfUp(x)).toBe(Math.round(x) + 0);
    const rng = mulberry32(1);
    for (let i = 0; i < 20000; i++) {
      const x = randomRange(rng, -2000, 2000);
      expect(roundHalfUp(x)).toBe(Math.round(x) + 0);
    }
  }, SWEEP_TIMEOUT_MS);

  it('never returns −0: a count of zero is plain 0', () => {
    expect(Object.is(Math.round(-0.2), -0)).toBe(true);
    for (const x of [-0.2, -0.5, -0, 0, 0.3]) expect(Object.is(roundHalfUp(x), 0)).toBe(true);
    for (const x of [0, -0, 1e-15, -0.5]) expect(Object.is(ceilTolerant(x), 0)).toBe(true);
  });

  it('rounds a tie up when binary division left it a few ulps short', () => {
    // 35 in of super bulky hdc (cell 1.05 · 4 / 7.5): 62.5 stitches on paper
    const hdc = 35 / (1.05 * (4 / 7.5));
    expect(hdc).toBe(62.49999999999999);
    expect(Math.round(hdc)).toBe(62);
    expect(roundHalfUp(hdc)).toBe(63);
    // 39 in of lace C2C (tile 2.6 · 4 / 34): 127.5 tiles on paper
    const c2c = 39 / (2.6 * (4 / 34));
    expect(c2c).toBe(127.49999999999999);
    expect(roundHalfUp(c2c)).toBe(128);
    // 6.25 in of jumbo tapestry rows (h = 1 / 0.88): 5.5 rows on paper
    const tapestry = 6.25 / (1 / 0.88);
    expect(tapestry).toBeLessThan(5.5);
    expect(roundHalfUp(tapestry)).toBe(6);
  });

  it('leaves a value that is really below the tie alone', () => {
    expect(roundHalfUp(62.4999)).toBe(62);
    expect(roundHalfUp(62.499999999)).toBe(62);
    expect(roundHalfUp(0.4999999)).toBe(0);
    expect(roundHalfUp(999.49999)).toBe(999);
  });

  it('is monotone, so a larger size never rounds to a smaller count', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 5000; i++) {
      const a = randomRange(rng, -50, 1500);
      const b = a + randomRange(rng, 0, 3);
      expect(roundHalfUp(b)).toBeGreaterThanOrEqual(roundHalfUp(a));
    }
    let prev = roundHalfUp(61);
    for (let x = 61; x < 64; x += 1e-4) {
      const r = roundHalfUp(x);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  }, SWEEP_TIMEOUT_MS);

  it('passes NaN and infinities through', () => {
    expect(roundHalfUp(Number.NaN)).toBeNaN();
    expect(roundHalfUp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundHalfUp(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('stays Math.round at any size: the noise band never grows beyond 1e-6', () => {
    expect(roundHalfUp(5e11)).toBe(5e11);
    expect(roundHalfUp(999999999999.4)).toBe(999999999999);
    expect(roundHalfUp(999999999999.6)).toBe(1000000000000);
    expect(roundHalfUp(1e15 + 0.25)).toBe(1e15);
    expect(roundHalfUp(2 ** 52 + 1)).toBe(2 ** 52 + 1);
    expect(roundHalfUp(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(roundHalfUp(-(2 ** 52) - 1)).toBe(-(2 ** 52) - 1);
    expect(roundHalfUp(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    const rng = mulberry32(7);
    for (let i = 0; i < 20000; i++) {
      const x = randomRange(rng, -1, 1) * 10 ** randomRange(rng, 0, 15.5);
      expect(roundHalfUp(x)).toBe(Math.round(x) + 0);
    }
    // whole numbers of any size are left alone
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(randomRange(rng, 0, 1) * 10 ** randomRange(rng, 0, 15.9));
      expect(roundHalfUp(n)).toBe(n);
      expect(ceilTolerant(n)).toBe(n);
    }
    expect(ceilTolerant(1e12)).toBe(1e12);
    expect(ceilTolerant(3e12 + 0.5)).toBe(3e12 + 1);
    expect(ceilTolerant(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  }, SWEEP_TIMEOUT_MS);
});

describe('ceilTolerant — whole skeins', () => {
  it('is Math.ceil for ordinary values', () => {
    for (const x of [0, 0.01, 0.5, 1, 1.0001, 2, 2.5, 10.27, 999.999]) expect(ceilTolerant(x)).toBe(Math.ceil(x));
  });

  it('does not buy an extra skein for a few ulps', () => {
    const x = (0.1 + 0.2) / 0.15;
    expect(x).toBeGreaterThan(2);
    expect(Math.ceil(x)).toBe(3);
    expect(ceilTolerant(x)).toBe(2);
    expect(ceilTolerant(2.000001)).toBe(3);
    expect(ceilTolerant(0)).toBe(0);
    expect(ceilTolerant(Number.NaN)).toBeNaN();
    expect(ceilTolerant(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(ceilTolerant(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('the gauge kernel is pure (§0.1, §5.1, §5.8)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has the modules of §5.1', () => {
    for (const f of ['tables.ts', 'resolve.ts', 'grid.ts', 'sphere.ts', 'yarnPerStitch.ts', 'index.ts']) expect(sources).toContain(f);
    expect([...sources].sort()).toEqual(['checks.ts', 'grid.ts', 'index.ts', 'resolve.ts', 'round.ts', 'sphere.ts', 'tables.ts', 'yarnPerStitch.ts']);
  });

  it('uses no Math.random, no Date, no DOM and no dependency outside src/types and itself', () => {
    for (const f of sources) {
      const text = readFileSync(join(dir, f), 'utf8');
      // code only: comments may say "window" or "date"
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const banned = code.match(/Math\.random|\bDate\b|performance\.now|\bdocument\b|\bwindow\b|\bglobalThis\b|\bprocess\b/g) ?? [];
      expect(banned, f).toEqual([]);
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        expect(m[1].startsWith('./') || m[1].startsWith('../../types/'), `${f} imports ${m[1]}`).toBe(true);
      }
    }
  });

  it('exports every module through the barrel', () => {
    for (const name of ['resolveGauge', 'checkGauge', 'resolveGaugeChecked', 'grid', 'chartSize', 'gridIssues', 'snap', 'borderRounds', 'sphereSizing', 'sphereDiameterIn', 'lSc', 'lAmi', 'TABLE_A', 'TABLE_B', 'TABLE_E', 'CYC_RANGE', 'roundHalfUp', 'yarnPerStitchDefaults', 'hookUsLabel']) {
      expect(gauge, name).toHaveProperty(name);
    }
    // the internal checks stay internal
    for (const name of ['positive', 'present', 'fmt', 'show', 'freeze', 'isTechnique']) expect(gauge, name).not.toHaveProperty(name);
  });

  it('gives the same answer every time (same input ⇒ same output)', () => {
    const run = (): string =>
      JSON.stringify([
        gauge.resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 2, hookMm: 4.5 }),
        gauge.resolveGauge({ cyc: 3, technique: 'amigurumi_sc', yarnUnder: true, hookMm: 3 }),
        gauge.checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 16, spanIn: 10 } }),
        gauge.grid({ w: 0.3, h: 0.26 }, { wIn: 37.3, imgW: 811, imgH: 1033, border: { widthIn: 1.3, roundH: 0.26 }, rowsMult: { m: 2, plus: 0 } }),
        gauge.sphereSizing(3.3, { w: 0.2, h: 0.19 }, 1.05),
        gauge.yarnPerStitchDefaults(5),
      ]);
    const first = run();
    for (let i = 0; i < 10; i++) expect(run()).toBe(first);
  });
});
