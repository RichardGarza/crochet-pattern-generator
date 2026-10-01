import { describe, expect, it } from 'vitest';
import { multiply, nestedDissection, pcgJacobi, SparseCholesky, type SymmetricPattern } from '../sparse';
import { mulberry32 } from '../../kernel/prng';

/** A 2D grid graph (4-neighbors) of nx × ny vertices with random SPD values: graph Laplacian with random weights + diag. */
function gridSystem(nx: number, ny: number, seed: number, shift = 0.05): { p: SymmetricPattern; val: Float64Array; pos: Float64Array } {
  const n = nx * ny;
  const rng = mulberry32(seed);
  const rows: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const id = (x: number, y: number): number => x + nx * y;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = id(x, y);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        if (x + dx >= nx || y + dy >= ny) continue;
        const j = id(x + dx, y + dy);
        const w = 0.5 + rng();
        rows[i].set(j, (rows[i].get(j) ?? 0) - w);
        rows[j].set(i, (rows[j].get(i) ?? 0) - w);
        rows[i].set(i, (rows[i].get(i) ?? 0) + w);
        rows[j].set(j, (rows[j].get(j) ?? 0) + w);
      }
      rows[i].set(i, (rows[i].get(i) ?? 0) + shift);
    }
  }
  const rowPtr = new Int32Array(n + 1);
  const cols: number[] = [];
  const vals: number[] = [];
  const diag = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const entries = [...rows[i].entries()].sort((a, b) => a[0] - b[0]);
    for (const [j, v] of entries) {
      if (j === i) diag[i] = cols.length;
      cols.push(j);
      vals.push(v);
    }
    rowPtr[i + 1] = cols.length;
  }
  const pos = new Float64Array(3 * n);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) pos.set([x, y, 0], 3 * id(x, y));
  return { p: { n, rowPtr, col: Int32Array.from(cols), diag }, val: Float64Array.from(vals), pos };
}

function residual(p: SymmetricPattern, val: Float64Array, x: Float64Array, b: Float64Array): number {
  const q = new Float64Array(p.n);
  multiply(p, val, x, q);
  let r = 0;
  let bn = 0;
  for (let i = 0; i < p.n; i++) {
    r += (q[i] - b[i]) ** 2;
    bn += b[i] ** 2;
  }
  return Math.sqrt(r / bn);
}

describe('sparse kernels for the heat method', () => {
  it('nested dissection returns a permutation', () => {
    const { p, pos } = gridSystem(37, 23, 1);
    const perm = nestedDissection(p, pos);
    const seen = new Uint8Array(p.n);
    for (const v of perm) seen[v]++;
    expect(seen.every((c) => c === 1)).toBe(true);
    // deterministic
    expect(Array.from(nestedDissection(p, pos))).toEqual(Array.from(perm));
  });

  it('Cholesky solves to machine precision, with far less fill than the natural order', () => {
    const { p, val, pos } = gridSystem(60, 60, 2);
    const nd = new SparseCholesky(p, nestedDissection(p, pos));
    const natural = new SparseCholesky(p, Int32Array.from({ length: p.n }, (_, i) => i));
    expect(nd.factor(val)).toBe(true);
    expect(natural.factor(val)).toBe(true);
    expect(nd.nnzL).toBeLessThan(0.6 * natural.nnzL);
    const rng = mulberry32(9);
    const b = Float64Array.from({ length: p.n }, () => rng() - 0.5);
    const x = nd.solve(b);
    expect(residual(p, val, x, b)).toBeLessThan(1e-12);
    const x2 = natural.solve(b);
    for (let i = 0; i < p.n; i++) expect(Math.abs(x[i] - x2[i])).toBeLessThan(1e-9);
    // refactor with new values on the same pattern
    const val2 = Float64Array.from(val);
    for (let i = 0; i < p.n; i++) val2[p.diag[i]] += 1;
    expect(nd.factor(val2)).toBe(true);
    expect(residual(p, val2, nd.solve(b), b)).toBeLessThan(1e-12);
  });

  it('a delta right-hand side keeps its far field (no cancellation), unlike CG at 1e-8', () => {
    // 1D-like strip: strong decay along x
    const { p, val, pos } = gridSystem(200, 3, 3, 4);
    const chol = new SparseCholesky(p, nestedDissection(p, pos));
    expect(chol.factor(val)).toBe(true);
    const b = new Float64Array(p.n);
    b[0] = 1;
    const x = chol.solve(b);
    // the solution of an M-matrix with a nonnegative rhs is positive everywhere, even where it is ~1e-200
    let minX = Infinity;
    for (let i = 0; i < p.n; i++) minX = Math.min(minX, x[i]);
    expect(minX).toBeGreaterThan(0);
    const y = new Float64Array(p.n);
    pcgJacobi(p, val, b, y, 1e-8, 2000);
    let neg = 0;
    for (let i = 0; i < p.n; i++) if (!(y[i] > 0)) neg++;
    expect(neg).toBeGreaterThan(0); // CG's far field is residual noise (zero or negative)
  });

  it('factor reports an indefinite matrix; solve refuses without a factor', () => {
    const { p, val, pos } = gridSystem(5, 5, 4);
    const bad = Float64Array.from(val);
    bad[p.diag[12]] = -10;
    const c = new SparseCholesky(p, nestedDissection(p, pos));
    expect(c.factor(bad)).toBe(false);
    expect(() => c.solve(new Float64Array(p.n))).toThrow();
  });

  it('Jacobi-PCG converges on an SPD system and returns zero for a zero rhs', () => {
    const { p, val } = gridSystem(40, 40, 5);
    const rng = mulberry32(1);
    const b = Float64Array.from({ length: p.n }, () => rng() - 0.5);
    const x = new Float64Array(p.n);
    const r = pcgJacobi(p, val, b, x, 1e-10, 2000);
    expect(r.converged).toBe(true);
    expect(residual(p, val, x, b)).toBeLessThan(1e-9);
    const z = Float64Array.from({ length: p.n }, () => 1);
    expect(pcgJacobi(p, val, new Float64Array(p.n), z).iterations).toBe(0);
    expect(z.every((v) => v === 0)).toBe(true);
    // an iteration cap that is too small reports non-convergence
    const y = new Float64Array(p.n);
    expect(pcgJacobi(p, val, b, y, 1e-14, 3).converged).toBe(false);
  });
});
