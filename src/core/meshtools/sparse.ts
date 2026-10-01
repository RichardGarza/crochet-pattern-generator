// Track T5 — sparse symmetric linear algebra for the heat method (DESIGN.md §2.10.7 step 2).
//
// - `SymmetricPattern`: the CSR pattern (both triangles, columns ascending, diagonal included) of a matrix on a
//   mesh's vertex graph; values live in a parallel Float64Array.
// - `pcgJacobi`: Jacobi-preconditioned conjugate gradients (the Poisson solve of §2.10.7, relative tolerance 1e-8,
//   ≤ 2000 iterations).
// - `SparseCholesky`: an up-looking sparse Cholesky factorization (the CSparse algorithm: elimination tree, row
//   patterns by `ereach`) on a geometric nested-dissection ordering. Used for the heat step `(M + tL)u = δ`: the heat
//   kernel decays like e^(−d/√t), i.e. by e^(−1) per mesh edge at t = (mean edge)², so the far field of u is far below
//   any iterative solver's residual tolerance, and its normalized gradient would be noise there. A direct
//   factorization keeps those values (the matrix is a diagonally dominant near-M-matrix, forward and back
//   substitution do not cancel). The symbolic analysis is done once per pattern; each t doubling refactors
//   numerically.
//
// Everything is deterministic: no hashing, stable sorts, ties by index.

/** CSR pattern of a symmetric matrix: row i's columns are `col[rowPtr[i] .. rowPtr[i+1])`, ascending, diagonal included. */
export interface SymmetricPattern {
  n: number;
  rowPtr: Int32Array;
  col: Int32Array;
  /** CSR position of the diagonal entry of each row. */
  diag: Int32Array;
}

/** y = A·x for the CSR matrix (pattern, values). */
export function multiply(p: SymmetricPattern, val: Float64Array, x: Float64Array, y: Float64Array): void {
  const { n, rowPtr, col } = p;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) s += val[k] * x[col[k]];
    y[i] = s;
  }
}

export interface PcgResult {
  iterations: number;
  /** ‖b − A·x‖ / ‖b‖ at exit. */
  relResidual: number;
  converged: boolean;
  /** Set by the heat solver when CG did not converge and a direct solve replaced it. */
  direct?: boolean;
}

/**
 * Jacobi-preconditioned CG for a symmetric positive (semi)definite A, in place on `x` (the initial guess). Stops at
 * ‖r‖ ≤ tol·‖b‖ or after `maxIter` iterations. b = 0 gives x = 0.
 */
export function pcgJacobi(p: SymmetricPattern, val: Float64Array, b: Float64Array, x: Float64Array, tol = 1e-8, maxIter = 2000): PcgResult {
  const n = p.n;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const d = new Float64Array(n);
  const q = new Float64Array(n);
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = val[p.diag[i]];
    inv[i] = a > 0 ? 1 / a : 1;
  }
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn);
  if (bn === 0) {
    x.fill(0);
    return { iterations: 0, relResidual: 0, converged: true };
  }
  multiply(p, val, x, q);
  let rn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - q[i];
    rn += r[i] * r[i];
  }
  if (Math.sqrt(rn) <= tol * bn) return { iterations: 0, relResidual: Math.sqrt(rn) / bn, converged: true };
  let rz = 0;
  for (let i = 0; i < n; i++) {
    z[i] = inv[i] * r[i];
    d[i] = z[i];
    rz += r[i] * z[i];
  }
  let it = 0;
  while (it < maxIter) {
    it++;
    multiply(p, val, d, q);
    let dq = 0;
    for (let i = 0; i < n; i++) dq += d[i] * q[i];
    if (!(dq > 0)) break;
    const alpha = rz / dq;
    rn = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * d[i];
      r[i] -= alpha * q[i];
      rn += r[i] * r[i];
    }
    if (Math.sqrt(rn) <= tol * bn) return { iterations: it, relResidual: Math.sqrt(rn) / bn, converged: true };
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      z[i] = inv[i] * r[i];
      rz2 += r[i] * z[i];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) d[i] = z[i] + beta * d[i];
  }
  // Recompute the true residual (the recurrence drifts on hard systems).
  multiply(p, val, x, q);
  rn = 0;
  for (let i = 0; i < n; i++) rn += (b[i] - q[i]) ** 2;
  const rel = Math.sqrt(rn) / bn;
  return { iterations: it, relResidual: rel, converged: rel <= tol };
}

/**
 * Geometric nested dissection of the graph `pattern` with vertex positions `pos` ([x, y, z, …]): split the vertex
 * set at the median of its widest coordinate, take the vertices of the lower half that touch the upper half as the
 * separator, order both halves recursively and the separator last. Returns `perm` (new position → old vertex).
 * Surfaces give separators of O(√n) vertices (a loop), so the Cholesky fill is O(n log n).
 */
export function nestedDissection(p: SymmetricPattern, pos: ArrayLike<number>): Int32Array {
  const n = p.n;
  const perm = new Int32Array(n);
  let out = 0;
  const side = new Int32Array(n).fill(-1); // stamp: the id of the subset whose upper half the vertex is in
  let stamp = 0;
  const LEAF = 48;
  // Explicit stack of tasks: either a subset to dissect or a list to emit.
  type Task = { verts: Int32Array; emit: boolean };
  const stack: Task[] = [{ verts: Int32Array.from({ length: n }, (_, i) => i), emit: false }];
  while (stack.length > 0) {
    const task = stack.pop() as Task;
    const v = task.verts;
    if (task.emit || v.length <= LEAF) {
      const sorted = task.emit ? v : Int32Array.from(v).sort();
      for (let k = 0; k < sorted.length; k++) perm[out++] = sorted[k];
      continue;
    }
    let ax = 0;
    let best = -1;
    for (let a = 0; a < 3; a++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < v.length; k++) {
        const c = pos[3 * v[k] + a];
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
      if (hi - lo > best) {
        best = hi - lo;
        ax = a;
      }
    }
    const order = Array.from(v).sort((i, j) => pos[3 * i + ax] - pos[3 * j + ax] || i - j);
    const half = order.length >> 1;
    const id = ++stamp;
    for (let k = half; k < order.length; k++) side[order[k]] = id;
    const lower: number[] = [];
    const sep: number[] = [];
    for (let k = 0; k < half; k++) {
      const i = order[k];
      let touches = false;
      for (let q = p.rowPtr[i]; q < p.rowPtr[i + 1]; q++) {
        if (side[p.col[q]] === id) {
          touches = true;
          break;
        }
      }
      (touches ? sep : lower).push(i);
    }
    const upper = order.slice(half);
    // LIFO: push in reverse emission order (lower, upper, separator).
    sep.sort((a, b) => a - b);
    stack.push({ verts: Int32Array.from(sep), emit: true });
    stack.push({ verts: Int32Array.from(upper), emit: false });
    stack.push({ verts: Int32Array.from(lower), emit: false });
  }
  return perm;
}

/** Sparse Cholesky C = P·A·Pᵀ = L·Lᵀ for a fixed symmetric pattern; refactor with new values as often as needed. */
export class SparseCholesky {
  readonly n: number;
  readonly perm: Int32Array;
  readonly pinv: Int32Array;
  /** Upper triangle of C, column-compressed. */
  private readonly cp: Int32Array;
  private readonly ci: Int32Array;
  private readonly cx: Float64Array;
  /** For each CSR position of A in the upper triangle of C: the CSC position in C; −1 for the lower half. */
  private readonly map: Int32Array;
  private readonly parent: Int32Array;
  private readonly lp: Int32Array;
  private readonly li: Int32Array;
  private readonly lx: Float64Array;
  private factored = false;

  constructor(p: SymmetricPattern, perm: Int32Array) {
    const n = p.n;
    this.n = n;
    this.perm = perm;
    const pinv = new Int32Array(n);
    for (let k = 0; k < n; k++) pinv[perm[k]] = k;
    this.pinv = pinv;
    // C's upper triangle: entry (i, j) of A goes to column max(pinv i, pinv j), row min(…); keep i ≤ j in A (each
    // unordered pair once).
    const count = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      for (let k = p.rowPtr[i]; k < p.rowPtr[i + 1]; k++) {
        const j = p.col[k];
        if (j < i) continue;
        count[Math.max(pinv[i], pinv[j]) + 1]++;
      }
    }
    for (let c = 0; c < n; c++) count[c + 1] += count[c];
    const cp = Int32Array.from(count);
    const next = Int32Array.from(count);
    const ci = new Int32Array(cp[n]);
    const map = new Int32Array(p.col.length).fill(-1);
    for (let i = 0; i < n; i++) {
      for (let k = p.rowPtr[i]; k < p.rowPtr[i + 1]; k++) {
        const j = p.col[k];
        if (j < i) continue;
        const a = pinv[i];
        const b = pinv[j];
        const c = Math.max(a, b);
        const q = next[c]++;
        ci[q] = Math.min(a, b);
        map[k] = q;
      }
    }
    this.cp = cp;
    this.ci = ci;
    this.cx = new Float64Array(ci.length);
    this.map = map;
    // Elimination tree (cs_etree on the upper triangle).
    const parent = new Int32Array(n).fill(-1);
    const ancestor = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) {
      for (let q = cp[k]; q < cp[k + 1]; q++) {
        let i = ci[q];
        while (i !== -1 && i < k) {
          const inext = ancestor[i];
          ancestor[i] = k;
          if (inext === -1) parent[i] = k;
          i = inext;
        }
      }
    }
    this.parent = parent;
    // Column counts of L from the row patterns (ereach), then column pointers.
    const colCount = new Int32Array(n);
    const s = new Int32Array(n);
    const w = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) {
      const top = this.ereach(k, s, w);
      for (let q = top; q < n; q++) colCount[s[q]]++;
      colCount[k]++;
    }
    const lp = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) lp[k + 1] = lp[k] + colCount[k];
    this.lp = lp;
    this.li = new Int32Array(lp[n]);
    this.lx = new Float64Array(lp[n]);
  }

  /** Nonzeros of L. */
  get nnzL(): number {
    return this.lp[this.n];
  }

  /** Pattern of row k of L (without the diagonal) into s[top..n), topological order; w is a stamp array (−1 init). */
  private ereach(k: number, s: Int32Array, w: Int32Array): number {
    const n = this.n;
    let top = n;
    w[k] = k;
    for (let q = this.cp[k]; q < this.cp[k + 1]; q++) {
      let i = this.ci[q];
      if (i > k) continue;
      let len = 0;
      while (w[i] !== k) {
        s[len++] = i;
        w[i] = k;
        i = this.parent[i];
      }
      while (len > 0) s[--top] = s[--len];
    }
    return top;
  }

  /**
   * Numeric factorization of A with values `val` on the constructor's pattern. Returns false (and leaves the factor
   * unusable) when A is not positive definite.
   */
  factor(val: Float64Array): boolean {
    const n = this.n;
    const { cp, ci, cx, lp, li, lx, map } = this;
    cx.fill(0);
    for (let k = 0; k < map.length; k++) if (map[k] >= 0) cx[map[k]] += val[k];
    const c = Int32Array.from(lp.subarray(0, n));
    const s = new Int32Array(n);
    const w = new Int32Array(n).fill(-1);
    const x = new Float64Array(n);
    this.factored = false;
    for (let k = 0; k < n; k++) {
      const top = this.ereach(k, s, w);
      x[k] = 0;
      for (let q = cp[k]; q < cp[k + 1]; q++) if (ci[q] <= k) x[ci[q]] += cx[q];
      let d = x[k];
      x[k] = 0;
      for (let t = top; t < n; t++) {
        const i = s[t];
        const lki = x[i] / lx[lp[i]];
        x[i] = 0;
        for (let q = lp[i] + 1; q < c[i]; q++) x[li[q]] -= lx[q] * lki;
        d -= lki * lki;
        const q = c[i]++;
        li[q] = k;
        lx[q] = lki;
      }
      if (!(d > 0) || !Number.isFinite(d)) return false;
      const q = c[k]++;
      li[q] = k;
      lx[q] = Math.sqrt(d);
    }
    this.factored = true;
    return true;
  }

  /** Solves A·x = b with the current factor (b in the original ordering); returns x. */
  solve(b: Float64Array): Float64Array {
    if (!this.factored) throw new Error('SparseCholesky.solve before a successful factor()');
    const n = this.n;
    const { lp, li, lx, perm } = this;
    const y = new Float64Array(n);
    for (let k = 0; k < n; k++) y[k] = b[perm[k]];
    for (let j = 0; j < n; j++) {
      y[j] /= lx[lp[j]];
      const yj = y[j];
      if (yj === 0) continue;
      for (let q = lp[j] + 1; q < lp[j + 1]; q++) y[li[q]] -= lx[q] * yj;
    }
    for (let j = n - 1; j >= 0; j--) {
      let v = y[j];
      for (let q = lp[j] + 1; q < lp[j + 1]; q++) v -= lx[q] * y[li[q]];
      y[j] = v / lx[lp[j]];
    }
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) x[perm[k]] = y[k];
    return x;
  }
}
