// Adversarial tests of the sculpt (from the independent T5.1 review; kept as regression tests).
import { describe, expect, it } from 'vitest';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import { remeshVolume } from '../remesh';
import { applyStroke, brushPlane, SculptSession, type SculptStroke } from '../sculpt';
import { cloneVolume, type FieldVolume } from '../volume';
import { voxelizeMesh } from '../voxelize';
import { colored, HEAVY, meshOf, sphereF, type Implicit } from './helpers';
import type { Vec3 } from '../../../types/geometry';

// Diagnostics are kept as no-ops so the measured values stay visible in the test code.
const log = (..._a: unknown[]): void => {};

function volumeOf(f: Implicit, n: number, half: number): FieldVolume {
  const voxel = (2 * half) / (n - 1);
  const field = new Float32Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = f(-half + x * voxel, -half + y * voxel, -half + z * voxel);
  return { field, dims: [n, n, n], origin: [-half, -half, -half], voxel };
}
const st = (tool: SculptStroke['tool'], points: Vec3[], radius = 0.4, strength = 1, mirrorX = false): SculptStroke => ({ tool, points, radius, strength, mirrorX });
const same = (a: ArrayLike<number> & { buffer: ArrayBufferLike }, b: ArrayLike<number> & { buffer: ArrayBufferLike }): boolean => Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0;

describe('sculpt', HEAVY, () => {
  it('interleaved undo/redo sequences restore exact fields and meshes', () => {
    const src = meshOf(sphereF(1), 40, 1.3, 10);
    const vox = voxelizeMesh(src, 48, { margin: 6 });
    const s = new SculptSession('p', vox, colored(src, 3));
    const f0 = new Float32Array(vox.field);
    const a = s.stroke(st('inflate', [[0, 1, 0]]));
    const fa = new Float32Array(vox.field);
    const b = s.stroke(st('smooth', [[1, 0, 0], [0.9, 0.3, 0]], 0.5));
    const fb = new Float32Array(vox.field);
    s.undo(b.undoId);
    expect(same(vox.field, fa)).toBe(true);
    const rb = s.redo();
    expect(rb?.undoId).toBe(b.undoId);
    expect(same(vox.field, fb)).toBe(true);
    s.undo(b.undoId);
    s.undo(a.undoId);
    expect(same(vox.field, f0)).toBe(true);
    const ra = s.redo();
    expect(ra?.undoId).toBe(a.undoId);
    expect(same(vox.field, fa)).toBe(true);
    // labels of the redone mesh = labels of a's mesh
    expect(same(ra?.mesh.labels ?? new Uint8Array(0), a.mesh.labels)).toBe(true);
    const rb2 = s.redo();
    expect(same(vox.field, fb)).toBe(true);
    expect(same(rb2?.mesh.positions ?? new Float32Array(0), b.mesh.positions)).toBe(true);
    // new stroke after undo clears redo
    s.undo(b.undoId);
    const c = s.stroke(st('deflate', [[0, -1, 0]]));
    expect(s.redo()).toBeNull();
    expect(c.undoId).not.toBe(b.undoId);
    expect(s.undoIds).toEqual([a.undoId, c.undoId]);
    // undo of b now unknown
    expect(() => s.undo(b.undoId)).toThrow(/unknown undo id/);
  });

  it('undo after strokes remeshed with pairs = 3 (the in-drag setting) gives back the pre-stroke mesh', () => {
    const src = meshOf(sphereF(1), 40, 1.3, 10);
    const vox = voxelizeMesh(src, 48, { margin: 6 });
    const s = new SculptSession('p', vox, colored(src, 3));
    const a = s.stroke(st('inflate', [[0, 1, 0]]), { pairs: 3 });
    const b = s.stroke(st('inflate', [[0, 1, 0]]), { pairs: 3 });
    const back = s.undo(b.undoId);
    const identical = same(back.positions, a.mesh.positions);
    log('pairs3 undo identical positions', identical);
    expect(identical).toBe(true);
  });

  it('mirrorX with points at x = 0, −0 and 1e-12: one dab, no doubling, symmetric', () => {
    for (const x of [0, -0, 1e-12]) {
      const v = volumeOf(sphereF(1), 41, 1.3);
      const w = volumeOf(sphereF(1), 41, 1.3);
      applyStroke(v, st('inflate', [[x, 0.98, 0]], 0.4, 1, true));
      applyStroke(w, st('inflate', [[0, 0.98, 0]], 0.4, 1, false));
      let worst = 0;
      for (let i = 0; i < v.field.length; i++) worst = Math.max(worst, Math.abs(v.field[i] - w.field[i]));
      log('mirror x', { x, worst });
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it('huge radius, many points, border points', () => {
    const v = volumeOf(sphereF(1), 65, 1.3);
    const t0 = performance.now();
    const d = applyStroke(v, st('inflate', [[0, 0, 0]], 1e6, 0.5));
    const t1 = performance.now();
    expect(d.indices.length).toBe(v.field.length);
    const pts: Vec3[] = Array.from({ length: 500 }, (_, i) => [Math.cos(i / 40), Math.sin(i / 40), 0.1 * Math.sin(i / 7)]);
    const t2 = performance.now();
    const d2 = applyStroke(v, st('smooth', pts, 0.3, 1, true));
    const t3 = performance.now();
    const corner: Vec3 = [1.3, 1.3, 1.3];
    const d3 = applyStroke(v, st('flatten', [corner, [5, 5, 5]], 0.5, 1, true));
    log('huge/many/border', { hugeMs: t1 - t0, manyMs: t3 - t2, many: d2.indices.length, border: d3.indices.length });
    expect(v.field.every((f) => Number.isFinite(f))).toBe(true);
  });

  it('flatten on a concave region does not raise the surface', () => {
    // a dimple: sphere minus a small sphere at the top
    const dimple: Implicit = (x, y, z) => Math.min(sphereF(1)(x, y, z), -sphereF(0.3, [0, 1.15, 0])(x, y, z));
    const v = volumeOf(dimple, 65, 1.3);
    const before = cloneVolume(v);
    const d = applyStroke(v, st('flatten', [[0, 0.9, 0]], 0.5, 1));
    let raised = 0;
    for (let i = 0; i < d.indices.length; i++) if (d.after[i] > d.before[i]) raised++;
    log('flatten concave', { changed: d.indices.length, raised, vol0: signedVolume(remeshVolume(before)), vol1: signedVolume(remeshVolume(v)) });
    expect(raised).toBe(0);
  });

  it('brushPlane on a thin ridge / at a corner returns a sane plane (normal unit, finite)', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    for (const c of [[0, 1, 0], [1.3, 1.3, 1.3], [0, 0, 0]] as Vec3[]) {
      const p = brushPlane(v, c, 0.5);
      log('brushPlane', c, p);
      if (p) expect(Math.hypot(...p.normal)).toBeCloseTo(1, 9);
    }
  });
});
