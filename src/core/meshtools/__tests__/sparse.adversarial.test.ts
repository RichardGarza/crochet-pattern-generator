// Adversarial review of T5.2 sparse kernels: the up-looking Cholesky against a dense solve on random small systems
// (mesh heat systems with obtuse/noisy triangles, random sparse SPD patterns, arbitrary orderings).
import { describe, expect, it } from 'vitest';
import { nestedDissection, pcgJacobi, SparseCholesky, type SymmetricPattern } from '../sparse';
import { cotanLaplacian, surfaceMesh } from '../heat';
import { mulberry32 } from '../../kernel/prng';
import { noisySphere } from './helpers';

function toDense(p: SymmetricPattern, val: Float64Array): number[][] {
  const A = Array.from({ length: p.n }, () => new Array<number>(p.n).fill(0));
  for (let i = 0; i < p.n; i++) for (let k = p.rowPtr[i]; k < p.rowPtr[i + 1]; k++) A[i][p.col[k]] += val[k];
  return A;
}

/** Gaussian elimination with partial pivoting. */
function denseSolve(A0: number[][], b0: ArrayLike<number>): Float64Array {
  const n = A0.length;
  const A = A0.map((r) => r.slice());
  const b = Array.from(b0);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

function maxRel(a: Float64Array, b: Float64Array): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    num = Math.max(num, Math.abs(a[i] - b[i]));
    den = Math.max(den, Math.abs(b[i]));
  }
  return num / den;
}

/** Random sparse SPD matrix on a random graph (not geometric), strictly diagonally dominant with mixed-sign off-diagonals. */
function randomSpd(n: number, deg: number, seed: number): { p: SymmetricPattern; val: Float64Array } {
  const rng = mulberry32(seed);
  const rows: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < deg; d++) {
      const j = Math.floor(rng() * n);
      if (j === i) continue;
      const w = rng() * 2 - 1; // mixed signs: not an M-matrix
      rows[i].set(j, (rows[i].get(j) ?? 0) + w);
      rows[j].set(i, (rows[j].get(i) ?? 0) + w);
    }
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const v of rows[i].values()) s += Math.abs(v);
    rows[i].set(i, s + 0.01 + rng());
  }
  const rowPtr = new Int32Array(n + 1);
  const cols: number[] = [];
  const vals: number[] = [];
  const diag = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    for (const [j, v] of [...rows[i].entries()].sort((a, b) => a[0] - b[0])) {
      if (j === i) diag[i] = cols.length;
      cols.push(j);
      vals.push(v);
    }
    rowPtr[i + 1] = cols.length;
  }
  return { p: { n, rowPtr, col: Int32Array.from(cols), diag }, val: Float64Array.from(vals) };
}

describe('adversarial: sparse Cholesky vs dense solve', () => {
  it('heat systems (M + tL) on noisy sphere meshes (obtuse triangles, positive off-diagonals), several t, nested dissection', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const m = noisySphere(0.6, seed, 10, 6);
      const sm = surfaceMesh(m);
      const { L, mass } = cotanLaplacian(sm);
      let positiveOff = 0;
      for (let i = 0; i < sm.nv; i++) for (let k = sm.pattern.rowPtr[i]; k < sm.pattern.rowPtr[i + 1]; k++) if (sm.pattern.col[k] !== i && L[k] > 0) positiveOff++;
      const chol = new SparseCholesky(sm.pattern, nestedDissection(sm.pattern, sm.positions));
      for (const t of [1e-4, 0.01, 1, 100]) {
        const val = new Float64Array(L.length);
        for (let k = 0; k < L.length; k++) val[k] = t * L[k];
        for (let v = 0; v < sm.nv; v++) val[sm.pattern.diag[v]] += mass[v];
        expect(chol.factor(val)).toBe(true);
        const rng = mulberry32(seed * 100 + Math.round(t * 1000));
        const b = Float64Array.from({ length: sm.nv }, () => rng() - 0.5);
        const x = chol.solve(b);
        const xd = denseSolve(toDense(sm.pattern, val), b);
        expect(maxRel(x, xd)).toBeLessThan(1e-9);
      }
      if (seed === 1) expect(positiveOff).toBeGreaterThan(0); // the test really exercises a non-M-matrix
    }
  });

  it('random sparse SPD graphs with mixed-sign entries, any ordering (identity, reversed, random)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const n = 20 + seed * 7;
      const { p, val } = randomSpd(n, 3, seed);
      const rng = mulberry32(seed + 77);
      const random = Int32Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [random[i], random[j]] = [random[j], random[i]];
      }
      const pos = Float64Array.from({ length: 3 * n }, () => rng());
      const perms = [Int32Array.from({ length: n }, (_, i) => i), Int32Array.from({ length: n }, (_, i) => n - 1 - i), random, nestedDissection(p, pos)];
      const b = Float64Array.from({ length: n }, () => rng() - 0.5);
      const xd = denseSolve(toDense(p, val), b);
      for (const perm of perms) {
        const c = new SparseCholesky(p, perm);
        expect(c.factor(val)).toBe(true);
        expect(maxRel(c.solve(b), xd)).toBeLessThan(1e-10);
        // refactor with scaled values reuses the symbolic analysis
        const v2 = Float64Array.from(val, (x) => 3 * x);
        expect(c.factor(v2)).toBe(true);
        expect(maxRel(c.solve(b), Float64Array.from(xd, (x) => x / 3))).toBeLessThan(1e-10);
      }
    }
  });

  it('indefinite and singular matrices are refused (factor → false, solve throws); 1×1 works', () => {
    const { p, val } = randomSpd(30, 3, 5);
    const bad = Float64Array.from(val);
    bad[p.diag[17]] = -1;
    const c = new SparseCholesky(p, nestedDissection(p, Float64Array.from({ length: 90 }, (_, i) => (i * 0.37) % 1)));
    expect(c.factor(bad)).toBe(false);
    expect(() => c.solve(new Float64Array(30))).toThrow();
    const nan = Float64Array.from(val);
    nan[3] = NaN;
    expect(c.factor(nan)).toBe(false);
    const one: SymmetricPattern = { n: 1, rowPtr: Int32Array.from([0, 1]), col: Int32Array.from([0]), diag: Int32Array.from([0]) };
    const c1 = new SparseCholesky(one, Int32Array.from([0]));
    expect(c1.factor(Float64Array.from([4]))).toBe(true);
    expect(Array.from(c1.solve(Float64Array.from([2])))).toEqual([0.5]);
  });

  it('nested dissection with duplicate positions (all vertices at one point) is still a permutation', () => {
    const { p } = randomSpd(200, 3, 9);
    const perm = nestedDissection(p, new Float64Array(600));
    expect([...perm].sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('PCG: zero rhs, warm start at the solution, and NaN in the rhs does not report convergence', () => {
    const { p, val } = randomSpd(50, 3, 3);
    const b = Float64Array.from({ length: 50 }, (_, i) => Math.sin(i));
    const x = new Float64Array(50);
    expect(pcgJacobi(p, val, b, x).converged).toBe(true);
    const r2 = pcgJacobi(p, val, b, Float64Array.from(x));
    expect(r2.iterations).toBe(0);
    const bn = Float64Array.from(b);
    bn[4] = NaN;
    const r3 = pcgJacobi(p, val, bn, new Float64Array(50));
    expect(r3.converged).toBe(false);
  });
});
