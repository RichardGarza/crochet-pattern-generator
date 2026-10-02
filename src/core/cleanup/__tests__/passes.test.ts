import { describe, expect, it } from 'vitest';
import { ciede2000, hexToLab } from '../../kernel/color';
import { mulberry32 } from '../../kernel/prng';
import { ANCHOR_EPS, capLine, confettiPass, type LabelGrid, medianCenterDistance, mergeSmallComponents, pottsLine, type PottsInput, remapRareColors, SHORT_RUN_PENALTY } from '../passes';

function grid(rows: string[], protect: string[] = [], wrap = false): LabelGrid {
  const cols = rows[0].length;
  const labels = Uint8Array.from(rows.join('').split('').map(Number));
  const p = new Uint8Array(labels.length);
  protect.join('').split('').forEach((ch, i) => (p[i] = ch === '1' ? 1 : 0));
  return { cols, rows: rows.length, labels, protect: p, wrap };
}
const rowsOf = (g: LabelGrid): string[] => Array.from({ length: g.rows }, (_, r) => [...g.labels.subarray(r * g.cols, (r + 1) * g.cols)].join(''));

const HEX = ['#f0ecdc', '#1e1e28', '#c8102e', '#2c3e8f', '#f9d71c'];
const LAB = HEX.map(hexToLab);
/** Source color of every cell = its label's color (ties then go to the label, not the source). */
const cellLabOf = (g: LabelGrid, hex: (i: number) => string = (i) => HEX[g.labels[i]]): Float64Array => Float64Array.from(Array.from(g.labels, (_, i) => [...hexToLab(hex(i))]).flat());

describe('confettiPass (§2.5 step 1)', () => {
  it('an isolated cell takes the most frequent other 8-neighbor label', () => {
    const g = grid(['00011', '02011', '00011']);
    expect(confettiPass(g, cellLabOf(g), LAB)).toBe(1);
    expect(rowsOf(g)).toEqual(['00011', '00011', '00011']);
  });

  it('ties go to the color nearest the cell source color', () => {
    // Cell 4 (label 2) has four 0 and four 1 neighbors; its source is dark → takes 1.
    const g = grid(['010', '121', '010'], ['111', '101', '111']);
    const lab = cellLabOf(g, (i) => (i === 4 ? '#303030' : HEX[g.labels[i]]));
    confettiPass(g, lab, LAB);
    expect(g.labels[4]).toBe(1);
    g.labels[4] = 2;
    confettiPass(g, cellLabOf(g, (i) => (i === 4 ? '#e0e0e0' : HEX[g.labels[i]])), LAB);
    expect(g.labels[4]).toBe(0);
  });

  it('protected cells never change; a cell with a same-label edge neighbor is kept', () => {
    const g = grid(['00000', '02000', '00000', '00330', '00000'], ['00000', '01000', '00000', '00000', '00000']);
    expect(confettiPass(g, cellLabOf(g), LAB)).toBe(0);
    expect(rowsOf(g)[1]).toBe('02000');
    expect(rowsOf(g)[3]).toBe('00330');
  });

  it('simultaneous: the result does not depend on the scan order (transposed input → transposed output)', () => {
    const rng = mulberry32(3);
    const n = 9;
    const a = grid(Array.from({ length: n }, () => Array.from({ length: n }, () => (rng() < 0.7 ? 0 : 1 + Math.floor(rng() * 3))).join('')));
    const t: LabelGrid = { ...a, labels: new Uint8Array(n * n), protect: new Uint8Array(n * n) };
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) t.labels[c * n + r] = a.labels[r * n + c];
    const la = cellLabOf(a);
    const lt = cellLabOf(t);
    confettiPass(a, la, LAB);
    confettiPass(t, lt, LAB);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) expect(t.labels[c * n + r]).toBe(a.labels[r * n + c]);
  });

  it('rounds wrap around the seam', () => {
    const g = grid(['1000', '1002', '1000'], [], true);
    // Cell 7 (label 2) sees column 0 (label 1) across the seam: 1 vs 0 counts 3 : 5 → 0.
    confettiPass(g, cellLabOf(g), LAB);
    expect(g.labels[7]).toBe(0);
  });
});

describe('mergeSmallComponents (§2.5 step 2)', () => {
  it('components below A_min merge into the neighbor label with the longest shared border', () => {
    const g = grid(['000111', '002111', '002111', '000111']);
    // The 2-cell component of 2 borders 0 on 4 sides and 1 on 2 → 0 (A_min 3).
    expect(mergeSmallComponents(g, 3, LAB)).toBe(2);
    expect(rowsOf(g)).toEqual(['000111', '000111', '000111', '000111']);
  });

  it('A_min 2 leaves 2-cell components; A_min 1 is off', () => {
    const g = grid(['000111', '002111', '002111', '000111']);
    expect(mergeSmallComponents(g, 2, LAB)).toBe(0);
    expect(mergeSmallComponents(g, 1, LAB)).toBe(0);
  });

  it('a component with a protected cell is kept; ties go to the closest color', () => {
    const p = grid(['0000', '0220', '0000'], ['0000', '0100', '0000']);
    expect(mergeSmallComponents(p, 3, LAB)).toBe(0);
    const t = grid(['00000', '33233', '11111']);
    mergeSmallComponents(t, 2, LAB);
    expect(t.labels[7]).toBe(3); // 2 neighbors of 3 (border 2) beat 0 and 1 (border 1 each)
    // A tie (border 2 : 2) goes to the color nearer the component's own (ΔE00 between label colors).
    const tie = grid(['000', '021', '111']);
    mergeSmallComponents(tie, 2, LAB);
    expect(tie.labels[4]).toBe(ciede2000(LAB[2], LAB[0]) < ciede2000(LAB[2], LAB[1]) ? 0 : 1);
  });

  it('merged components grow; the pass repeats until nothing is small', () => {
    const g = grid(['0000000', '0123000', '0000000']);
    mergeSmallComponents(g, 2, LAB);
    expect(rowsOf(g)).toEqual(['0000000', '0000000', '0000000']);
  });
});

/** The energy `pottsLine` minimizes, written out independently (see passes.ts). */
function energy(seq: number[], cur: number[], prot: number[], unary: (t: number, l: number) => number, L: number[], lambda: number, R: number, circular: boolean): number {
  const W = seq.length;
  let e = 0;
  for (let t = 0; t < W; t++) {
    if (prot[t] && seq[t] !== cur[t]) return Infinity;
    if (prot[t]) continue;
    const min = Math.min(...L.map((l) => unary(t, l)));
    e += seq[t] === cur[t] && L.includes(cur[t]) ? min - ANCHOR_EPS : unary(t, seq[t]);
  }
  // Runs; a run through a protected cell counts as full.
  const runs: { l: number; len: number }[] = [];
  seq.forEach((l, t) => {
    const last = runs[runs.length - 1];
    if (last && last.l === l) last.len++;
    else runs.push({ l, len: 1 });
    if (prot[t]) runs[runs.length - 1].len += R;
  });
  e += lambda * (runs.length - 1);
  for (let q = 0; q < runs.length - 1; q++) if (runs[q].len < R && !(circular && q === 0)) e += SHORT_RUN_PENALTY;
  const last = runs[runs.length - 1];
  if (circular) {
    if (runs.length > 1 && last.l !== seq[0]) {
      e += lambda;
      if (last.len < R) e += SHORT_RUN_PENALTY;
    }
  } else if (last.len < R && W >= R) e += SHORT_RUN_PENALTY;
  return e;
}

describe('pottsLine (§2.5 step 3)', () => {
  const centers = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 0.5, 0, 0, 1, 0]);
  const at = (x: number, y = 0): [number, number, number] => [x, y, 0];

  it('a short excursion is smoothed when it saves more than it costs (anchored unary)', () => {
    // Labels 0 0 1 0 0; the middle cell's color is between 0 and 1.
    const g: LabelGrid = { cols: 5, rows: 1, labels: Uint8Array.of(0, 0, 1, 0, 0), protect: new Uint8Array(5), wrap: false };
    const feat = Float64Array.from([...at(0), ...at(0), ...at(0.6), ...at(0), ...at(0)]);
    const p: PottsInput = { feat, centers, sigma: 1, lambda: 0.4, rMin: 1 };
    expect(pottsLine(g, Int32Array.of(0, 1, 2, 3, 4), p, false)).toBe(1);
    expect([...g.labels]).toEqual([0, 0, 0, 0, 0]);
    // A clear excursion (its color is label 1's) stays: 0.4 · 2 < 1.
    const h: LabelGrid = { ...g, labels: Uint8Array.of(0, 0, 1, 0, 0) };
    expect(pottsLine(h, Int32Array.of(0, 1, 2, 3, 4), { ...p, feat: Float64Array.from([...at(0), ...at(0), ...at(1), ...at(0), ...at(0)]) }, false)).toBe(0);
    // λ = 0 never changes anything (the current label is anchored to the smallest unary).
    const z: LabelGrid = { ...g, labels: Uint8Array.of(1, 0, 1, 0, 1) };
    expect(pottsLine(z, Int32Array.of(0, 1, 2, 3, 4), { ...p, lambda: 0 }, false)).toBe(0);
  });

  it('only labels already in the line are used; protected cells keep theirs', () => {
    const g: LabelGrid = { cols: 5, rows: 1, labels: Uint8Array.of(0, 1, 0, 1, 0), protect: Uint8Array.of(0, 1, 0, 0, 0), wrap: false };
    const feat = Float64Array.from([...at(0.5, 0.5), ...at(0.5, 0.5), ...at(0.5, 0.5), ...at(0.5, 0.5), ...at(0.5, 0.5)]);
    pottsLine(g, Int32Array.of(0, 1, 2, 3, 4), { feat, centers, sigma: 1, lambda: 2, rMin: 1 }, false);
    expect(g.labels[1]).toBe(1);
    expect([...g.labels].every((l) => l === 0 || l === 1)).toBe(true); // never label 2, though it fits the color
  });

  it('r_min: single-stitch runs go when possible; a protected single cell stays feasible', () => {
    const g: LabelGrid = { cols: 6, rows: 1, labels: Uint8Array.of(0, 0, 1, 0, 0, 0), protect: Uint8Array.of(0, 0, 1, 0, 0, 0), wrap: false };
    const feat = Float64Array.from([...at(0), ...at(0), ...at(0.4), ...at(0), ...at(0), ...at(0)]);
    pottsLine(g, Int32Array.from([0, 1, 2, 3, 4, 5]), { feat, centers, sigma: 1, lambda: 0, rMin: 2 }, false);
    expect([...g.labels]).toEqual([0, 0, 1, 0, 0, 0]);
    g.protect[2] = 0;
    pottsLine(g, Int32Array.from([0, 1, 2, 3, 4, 5]), { feat, centers, sigma: 1, lambda: 0, rMin: 2 }, false);
    expect([...g.labels]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('matches a brute-force minimum on 300 random small lines (rows and rounds, r_min 1–3, forbidden labels)', () => {
    const rng = mulberry32(17);
    for (let trial = 0; trial < 300; trial++) {
      const W = 1 + Math.floor(rng() * 7);
      const K = 2 + Math.floor(rng() * 2);
      const R = 1 + Math.floor(rng() * 3);
      const lambda = [0, 0.4, 1][Math.floor(rng() * 3)];
      const circular = rng() < 0.4;
      const labels = Uint8Array.from({ length: W }, () => Math.floor(rng() * K));
      const protect = Uint8Array.from({ length: W }, () => (rng() < 0.15 ? 1 : 0));
      const feat = Float64Array.from({ length: W * 3 }, () => rng());
      const cent = Float64Array.from({ length: 4 * 3 }, () => rng());
      const allowed = rng() < 0.3 ? Uint8Array.from({ length: 256 }, (_, l) => (l === 0 || protect.some((p, t) => p && labels[t] === l) || rng() < 0.5 ? 1 : 0)) : undefined;
      const cur = [...labels];
      const prot = [...protect];
      const L = [...new Set(cur)].filter((l) => allowed === undefined || allowed[l]).sort((a, b) => a - b);
      const sigma = 0.7;
      if (L.length === 0) {
        // No allowed label in the line: nothing to choose from, the line is left alone.
        const g0: LabelGrid = { cols: W, rows: 1, labels, protect, wrap: false };
        expect(pottsLine(g0, Int32Array.from({ length: W }, (_, t) => t), { feat, centers: cent, sigma, lambda, rMin: R }, circular, allowed)).toBe(0);
        continue;
      }
      const unary = (t: number, l: number): number => Math.hypot(feat[t * 3] - cent[l * 3], feat[t * 3 + 1] - cent[l * 3 + 1], feat[t * 3 + 2] - cent[l * 3 + 2]) / sigma;
      let best = Infinity;
      const seq = new Array<number>(W).fill(0);
      const walk = (t: number): void => {
        if (t === W) {
          best = Math.min(best, energy(seq, cur, prot, unary, L, lambda, R, circular));
          return;
        }
        for (const l of L) {
          seq[t] = l;
          walk(t + 1);
        }
      };
      walk(0);
      const g: LabelGrid = { cols: W, rows: 1, labels, protect, wrap: false };
      pottsLine(g, Int32Array.from({ length: W }, (_, t) => t), { feat, centers: cent, sigma, lambda, rMin: R }, circular, allowed);
      for (let t = 0; t < W; t++) if (prot[t]) expect(g.labels[t]).toBe(cur[t]);
      const got = energy([...g.labels], cur, prot, unary, L, lambda, R, circular);
      expect(got, `trial ${trial} ${JSON.stringify({ W, R, lambda, circular, cur, prot, L })}`).toBeCloseTo(best, 9);
    }
  });

  it('medianCenterDistance', () => {
    const c = Float64Array.from([0, 0, 0, 3, 0, 0, 0, 4, 0]);
    expect(medianCenterDistance(c, [0, 1, 2])).toBe(4); // 3, 4, 5
    expect(medianCenterDistance(c, [0, 1])).toBe(3);
    expect(medianCenterDistance(c, [0])).toBe(1);
    expect(medianCenterDistance(Float64Array.from([1, 1, 1, 1, 1, 1]), [0, 1])).toBe(1);
  });
});

describe('capLine (§2.5 step 4) and remapRareColors (step 5)', () => {
  const centers = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0]);
  it('a line with more labels than the cap keeps the most important ones (protected labels always)', () => {
    const labels = Uint8Array.of(0, 0, 0, 1, 1, 2, 3, 4, 0, 0);
    const protect = new Uint8Array(10);
    protect[7] = 1; // label 4 is protected in this line
    const g: LabelGrid = { cols: 10, rows: 1, labels, protect, wrap: false };
    const feat = Float64Array.from(Array.from(labels, (l) => [...centers.subarray(l * 3, l * 3 + 3)]).flat());
    capLine(g, Int32Array.from({ length: 10 }, (_, t) => t), 3, { feat, centers, sigma: 1, lambda: 0, rMin: 1 }, false, () => false);
    expect(new Set(g.labels).size).toBe(3);
    expect(g.labels[7]).toBe(4);
    expect([...new Set(g.labels)].sort()).toEqual([0, 1, 4]);
  });

  it('importance 3 for a protected palette entry', () => {
    const labels = Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 2, 2, 3);
    const g: LabelGrid = { cols: 10, rows: 1, labels, protect: new Uint8Array(10), wrap: false };
    const feat = Float64Array.from(Array.from(labels, (l) => [...centers.subarray(l * 3, l * 3 + 3)]).flat());
    capLine(g, Int32Array.from({ length: 10 }, (_, t) => t), 3, { feat, centers, sigma: 1, lambda: 0, rMin: 1 }, false, (l) => l === 3);
    expect([...new Set(g.labels)].sort()).toEqual([0, 1, 3]);
  });

  it('rare colors remap to the nearest remaining label, rarest first, never below 2 labels or a protected one', () => {
    const g = grid(['0000000000', '0000000000', '1111111111', '1111111112', '3000000004']);
    // Counts: 0 → 28, 1 → 19, 2 → 1, 3 → 1, 4 → 1. min 5.
    remapRareColors(g, 5, LAB, (l) => l === 4);
    expect(g.labels.includes(2)).toBe(false);
    expect(g.labels.includes(3)).toBe(false);
    expect(g.labels.includes(4)).toBe(true); // protected entry
    const two = grid(['0001', '0000']);
    expect(remapRareColors(two, 5, LAB, () => false)).toBe(0); // only 2 labels
    const locked = grid(['0001', '0002', '0000'], ['0001', '0000', '0000']);
    remapRareColors(locked, 5, LAB, () => false);
    expect(locked.labels[3]).toBe(1);
    expect(locked.labels[7]).not.toBe(2);
  });
});
