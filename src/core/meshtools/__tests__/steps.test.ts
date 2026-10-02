import { describe, expect, it } from 'vitest';
import { remeshVolume } from '../remesh';
import { surfaceMesh, cotanLaplacian, HeatSolver, remeshForPathB } from '../heat';
import { nestedDissection, nestedDissectionSteps, SparseCholesky } from '../sparse';
import { drain, drainAsync, type Steps } from '../steps';
import { voxelizeMesh, voxelizeMeshSteps } from '../voxelize';
import { HEAVY, uvSphere } from './helpers';

// The resumable forms (steps.ts) give exactly the synchronous results; the async driver checks the gate per slice
// and stops cleanly when the check rejects.

function* counter(n: number): Steps<number> {
  let s = 0;
  try {
    for (let i = 0; i < n; i++) {
      s += i;
      yield;
    }
  } finally {
    closed.push(n);
  }
  return s;
}
const closed: number[] = [];

describe('steps: drain / drainAsync', () => {
  it('drain runs to the end', () => {
    expect(drain(counter(5))).toBe(10);
  });

  it('drainAsync checks at the start, per slice and at the end; a fake clock decides the slices', async () => {
    let t = 0;
    let checks = 0;
    const stretches: number[] = [];
    const g = (function* (): Steps<string> {
      for (let i = 0; i < 10; i++) {
        t += 3; // each step "takes" 3 ms
        yield;
      }
      return 'done';
    })();
    const r = await drainAsync(g, { check: async () => void checks++, sliceMs: 8, now: () => t, onStretch: (s) => stretches.push(s) });
    expect(r).toBe('done');
    // start + after 9, 18, 27 ms (3 slices) + the end
    expect(checks).toBe(5);
    expect(stretches).toEqual([9, 9, 9, 3]);
  });

  it('a rejecting check closes the generator (finally runs) and propagates', async () => {
    closed.length = 0;
    let n = 0;
    await expect(drainAsync(counter(100), { check: async () => { if (++n === 4) throw new Error('superseded'); }, sliceMs: 0 })).rejects.toThrow('superseded');
    expect(closed).toEqual([100]);
  });
});

describe('resumable kernels equal their synchronous forms', HEAVY, () => {
  const m = uvSphere(1, 48, 24);

  it('voxelizeMeshSteps = voxelizeMesh; the sign-only far field meshes to the identical surface', () => {
    const a = voxelizeMesh(m, 48);
    const b = drain(voxelizeMeshSteps(m, 48));
    expect(b.field).toEqual(a.field);
    const s = drain(voxelizeMeshSteps(m, 48, { farField: 'sign' }));
    const ma = remeshVolume(a, { pairs: 10 });
    const ms = remeshVolume(s, { pairs: 10 });
    expect(ms.indices).toEqual(ma.indices);
    expect(ms.positions).toEqual(ma.positions);
    expect(() => voxelizeMesh(m, 48, { farField: 'x' as never })).toThrow(RangeError);
  });

  it('factorSteps = factor; nestedDissectionSteps = nestedDissection; HeatSolver.build = new HeatSolver', () => {
    const sm = surfaceMesh(remeshForPathB(m, 0.08).mesh);
    const perm = nestedDissection(sm.pattern, sm.positions);
    expect(drain(nestedDissectionSteps(sm.pattern, sm.positions))).toEqual(perm);
    const { L, mass } = cotanLaplacian(sm);
    const val = Float64Array.from(L);
    for (let v = 0; v < sm.nv; v++) val[sm.pattern.diag[v]] += mass[v];
    const a = new SparseCholesky(sm.pattern, perm);
    const b = new SparseCholesky(sm.pattern, perm);
    expect(a.factor(val)).toBe(true);
    let yields = 0;
    const g = b.factorSteps(val, 1000);
    for (let r = g.next(); !r.done; r = g.next()) yields++;
    expect(yields).toBeGreaterThan(10);
    const rhs = Float64Array.from({ length: sm.nv }, (_, i) => Math.sin(i));
    expect(b.solve(rhs)).toEqual(a.solve(rhs));
    const h1 = new HeatSolver(sm).geodesic([0]);
    const h2 = drain(HeatSolver.build(sm)).geodesic([0]);
    expect(h2.phi).toEqual(h1.phi);
  });

  it('an abandoned factorization leaves the factor unusable', () => {
    const sm = surfaceMesh(remeshForPathB(m, 0.08).mesh);
    const { L, mass } = cotanLaplacian(sm);
    const val = Float64Array.from(L);
    for (let v = 0; v < sm.nv; v++) val[sm.pattern.diag[v]] += mass[v];
    const c = new SparseCholesky(sm.pattern, nestedDissection(sm.pattern, sm.positions));
    const g = c.factorSteps(val, 1000);
    g.next();
    g.next();
    g.return(false);
    expect(() => c.solve(new Float64Array(sm.nv))).toThrow(/before a successful factor/);
  });
});
