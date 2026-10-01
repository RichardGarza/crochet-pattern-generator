import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../../kernel/geom/marchingCubes';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import { vertexAdjacency } from '../../kernel/geom/taubin';
import { remeshVolume } from '../remesh';
import { applyStroke, brushPlane, diffBytes, mergeDiffs, reapplyDiff, revertDiff, SculptSession, type SculptStroke } from '../sculpt';
import { cloneVolume, MeshToolError, type FieldVolume } from '../volume';
import { voxelizeMesh } from '../voxelize';
import { colored, HEAVY, meshOf, sphereF, type Implicit } from './helpers';
import type { Vec3 } from '../../../types/geometry';

/** Samples f on an n³ lattice over [−half, half]³ (x = 0 is a sample when n is odd). */
function volumeOf(f: Implicit, n: number, half: number): FieldVolume {
  const voxel = (2 * half) / (n - 1);
  const field = new Float32Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = f(-half + x * voxel, -half + y * voxel, -half + z * voxel);
  return { field, dims: [n, n, n], origin: [-half, -half, -half], voxel };
}

/** Per-vertex mean-curvature estimate 2·(umbrella · n)/⟨|e|²⟩ for the vertices within `r` of `c`. */
function curvatures(m: IndexedMesh, c: Vec3, r: number): number[] {
  const n = m.positions.length / 3;
  const P = m.positions;
  const normals = new Float64Array(3 * n);
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, d] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
    const e2 = [P[3 * d] - P[3 * a], P[3 * d + 1] - P[3 * a + 1], P[3 * d + 2] - P[3 * a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const v of [a, b, d]) {
      normals[3 * v] += nx;
      normals[3 * v + 1] += ny;
      normals[3 * v + 2] += nz;
    }
  }
  const adj = vertexAdjacency(m.indices, n);
  const out: number[] = [];
  for (let v = 0; v < n; v++) {
    if (Math.hypot(P[3 * v] - c[0], P[3 * v + 1] - c[1], P[3 * v + 2] - c[2]) > r) continue;
    const s = adj.offsets[v];
    const e = adj.offsets[v + 1];
    if (e === s) continue;
    const mean = [0, 0, 0];
    let e2 = 0;
    for (let k = s; k < e; k++) {
      const u = adj.neighbors[k];
      for (let a = 0; a < 3; a++) mean[a] += P[3 * u + a] / (e - s);
      e2 += ((P[3 * u] - P[3 * v]) ** 2 + (P[3 * u + 1] - P[3 * v + 1]) ** 2 + (P[3 * u + 2] - P[3 * v + 2]) ** 2) / (e - s);
    }
    const nl = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
    const lap = [mean[0] - P[3 * v], mean[1] - P[3 * v + 1], mean[2] - P[3 * v + 2]];
    out.push((2 * (lap[0] * normals[3 * v] + lap[1] * normals[3 * v + 1] + lap[2] * normals[3 * v + 2])) / nl / e2);
  }
  return out;
}

const variance = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

const stroke = (tool: SculptStroke['tool'], points: Vec3[], radius = 0.4, strength = 1, mirrorX = false): SculptStroke => ({ tool, points, radius, strength, mirrorX });

describe('sculpt brushes (§2.9.8 acceptance)', HEAVY, () => {
  it('inflate grows the volume and deflate shrinks it, only inside the brush', () => {
    const v = volumeOf(sphereF(1), 65, 1.3);
    const v0 = signedVolume(remeshVolume(v));
    const d1 = applyStroke(v, stroke('inflate', [[0, 1, 0], [0.1, 0.99, 0]], 0.4));
    const v1 = signedVolume(remeshVolume(v));
    expect(v1).toBeGreaterThan(v0);
    // every changed sample lies within the radius of a dab
    for (let i = 0; i < d1.indices.length; i++) {
      const k = d1.indices[i];
      const x = k % 65;
      const y = Math.floor(k / 65) % 65;
      const z = Math.floor(k / 65 / 65);
      const p = [v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel];
      const near = Math.min(Math.hypot(p[0], p[1] - 1, p[2]), Math.hypot(p[0] - 0.1, p[1] - 0.99, p[2]));
      expect(near).toBeLessThan(0.4);
      expect(d1.after[i]).toBeGreaterThan(d1.before[i]);
    }
    applyStroke(v, stroke('deflate', [[1, 0, 0]], 0.5));
    applyStroke(v, stroke('deflate', [[1, 0, 0]], 0.5));
    const v2 = signedVolume(remeshVolume(v));
    expect(v2).toBeLessThan(v1);
  });

  it('smooth lowers the curvature variance under the brush', () => {
    // a sphere with bumps 1.5 voxels high and 12 voxels apart
    const bumpy: Implicit = (x, y, z) => 1 - Math.hypot(x, y, z) + 0.05 * Math.sin(16 * x) * Math.sin(16 * y) * Math.sin(16 * z);
    const v = volumeOf(bumpy, 81, 1.3);
    const c: Vec3 = [0, 0, 1];
    const before = variance(curvatures(remeshVolume(v), c, 0.3));
    for (let pass = 0; pass < 6; pass++) applyStroke(v, stroke('smooth', [c, [0.05, 0, 1], [0, 0.05, 1]], 0.5, 1));
    const after = variance(curvatures(remeshVolume(v), c, 0.3));
    expect(after).toBeLessThan(0.7 * before);
  });

  it('flatten lowers the height above the plane', () => {
    const v = volumeOf(sphereF(1), 65, 1.3);
    const c: Vec3 = [0, 0, 1];
    const plane = brushPlane(v, c, 0.5);
    expect(plane).not.toBeNull();
    if (!plane) return;
    // the plane of a convex cap: through the mean surface point (below the top), normal along +z
    expect(plane.normal[2]).toBeGreaterThan(0.99);
    expect(plane.point[2]).toBeLessThan(1);
    const height = (m: IndexedMesh): number => {
      let h = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        const p = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
        if (Math.hypot(p[0] - c[0], p[1] - c[1]) > 0.3 || p[2] < 0) continue;
        const d = (p[0] - plane.point[0]) * plane.normal[0] + (p[1] - plane.point[1]) * plane.normal[1] + (p[2] - plane.point[2]) * plane.normal[2];
        h = Math.max(h, d);
      }
      return h;
    };
    const h0 = height(remeshVolume(v));
    applyStroke(v, stroke('flatten', [c], 0.5, 1));
    const h1 = height(remeshVolume(v));
    expect(h1).toBeLessThan(h0);
    expect(h1).toBeLessThan(0.5 * h0);
  });

  it('flatten leaves a flat surface (almost) alone', () => {
    const slab: Implicit = (_x, y) => 0.3 - Math.abs(y);
    const v = volumeOf(slab, 41, 1);
    const before = cloneVolume(v);
    const d = applyStroke(v, stroke('flatten', [[0, 0.3, 0]], 0.4, 1));
    let worst = 0;
    for (let i = 0; i < d.indices.length; i++) worst = Math.max(worst, Math.abs(d.after[i] - d.before[i]));
    expect(worst).toBeLessThan(0.05 * v.voxel);
    expect(before.field.length).toBe(v.field.length);
  });

  it('X symmetry gives a mirror-symmetric result and never doubles a dab across x = 0', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    applyStroke(v, stroke('inflate', [[0.5, 0.6, 0.6], [0.05, 0.98, 0]], 0.4, 1, true));
    const n = 41;
    let worst = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) worst = Math.max(worst, Math.abs(v.field[x + n * (y + n * z)] - v.field[n - 1 - x + n * (y + n * z)]));
    expect(worst).toBeLessThan(1e-6);
    // a dab at x = 0.05 with its twin at −0.05: the top sample gains one dab's worth (max falloff), not two
    const one = volumeOf(sphereF(1), 41, 1.3);
    const top = 20 + n * (Math.round((0.98 + 1.3) / one.voxel) + n * 20);
    const base = one.field[top];
    applyStroke(one, stroke('inflate', [[0.05, 0.98, 0]], 0.4, 1, true));
    expect(one.field[top] - base).toBeLessThanOrEqual(one.voxel + 1e-7);
  });

  it('strength 0, points far away and empty strokes change nothing; bad strokes throw', () => {
    const v = volumeOf(sphereF(1), 21, 1.3);
    expect(applyStroke(v, stroke('inflate', [[0, 1, 0]], 0.4, 0)).indices.length).toBe(0);
    expect(applyStroke(v, stroke('inflate', [[10, 10, 10]], 0.4, 1)).indices.length).toBe(0);
    expect(applyStroke(v, stroke('smooth', [], 0.4, 1)).indices.length).toBe(0);
    expect(applyStroke(v, stroke('flatten', [[0, 0, 0]], 0.2, 1)).indices.length).toBe(0); // no surface under it
    expect(() => applyStroke(v, stroke('inflate', [[0, 1, 0]], 0))).toThrow(RangeError);
    expect(() => applyStroke(v, stroke('inflate', [[0, NaN, 0]]))).toThrow(RangeError);
    expect(() => applyStroke(v, stroke('pinch' as SculptStroke['tool'], [[0, 1, 0]]))).toThrow(RangeError);
    expect(() => applyStroke(v, stroke('inflate', [[0, 1, 0]], 0.4, -1))).toThrow(RangeError);
  });
});

describe('sparse undo (§2.9.8, §4.4)', HEAVY, () => {
  it('revert restores the field bit for bit; reapply gives the stroke result again', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    const original = new Float32Array(v.field);
    const d = applyStroke(v, stroke('smooth', [[0, 0, 1], [0, 0.2, 0.98]], 0.5, 0.7));
    const sculpted = new Float32Array(v.field);
    expect(d.indices.length).toBeGreaterThan(0);
    expect(d.indices.length).toBeLessThan(v.field.length / 10); // sparse
    expect(diffBytes(d)).toBe(12 * d.indices.length);
    for (let i = 1; i < d.indices.length; i++) expect(d.indices[i]).toBeGreaterThan(d.indices[i - 1]);
    revertDiff(v, d);
    expect(Buffer.compare(Buffer.from(v.field.buffer), Buffer.from(original.buffer))).toBe(0);
    reapplyDiff(v, d);
    expect(Buffer.compare(Buffer.from(v.field.buffer), Buffer.from(sculpted.buffer))).toBe(0);
    expect(() => revertDiff(v, { indices: new Uint32Array([1e9]), before: new Float32Array(1), after: new Float32Array(1) })).toThrow(RangeError);
  });

  it('SculptSession: strokes carry labels; undo restores the exact meshes in order; out-of-order undo is refused', () => {
    const src = meshOf(sphereF(1), 50, 1.3, 10);
    const labels = new Uint8Array(src.positions.length / 3).map((_, i) => (src.positions[3 * i + 1] > 0 ? 1 : 2));
    const start = { ...colored(src), labels };
    const vox = voxelizeMesh(src, 64, { margin: 6 });
    const field0 = new Float32Array(vox.field);
    const s = new SculptSession('vol1', vox, start);
    expect(s.mesh).not.toBe(start); // a copy
    expect(Buffer.compare(Buffer.from(s.mesh.positions.buffer), Buffer.from(start.positions.buffer))).toBe(0);
    const a = s.stroke(stroke('inflate', [[0, 1, 0]], 0.5));
    const b = s.stroke(stroke('deflate', [[0, -1, 0]], 0.5));
    const fieldB = new Float32Array(vox.field);
    const c = s.stroke(stroke('flatten', [[1, 0, 0]], 0.5));
    expect(new Set(a.undoId === b.undoId ? [] : [a.undoId, b.undoId, c.undoId]).size).toBe(3);
    expect(s.undoIds).toEqual([a.undoId, b.undoId, c.undoId]);
    // labels carried: top stays 1, bottom 2
    for (let v = 0; v < c.mesh.labels.length; v++) {
      const y = c.mesh.positions[3 * v + 1];
      if (Math.abs(y) > 0.15) expect(c.mesh.labels[v]).toBe(y > 0 ? 1 : 2);
    }
    expect(() => s.undo(a.undoId)).toThrow(MeshToolError);
    expect(() => s.undo('nope')).toThrow(/unknown undo id/);
    const backB = s.undo(c.undoId);
    expect(Buffer.compare(Buffer.from(vox.field.buffer), Buffer.from(fieldB.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(backB.positions.buffer), Buffer.from(b.mesh.positions.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(backB.indices.buffer), Buffer.from(b.mesh.indices.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(backB.labels.buffer), Buffer.from(b.mesh.labels.buffer))).toBe(0);
    // redo, then undo everything
    const redone = s.redo();
    expect(redone?.undoId).toBe(c.undoId);
    expect(Buffer.compare(Buffer.from(redone?.mesh.positions.buffer ?? new ArrayBuffer(0)), Buffer.from(c.mesh.positions.buffer))).toBe(0);
    s.undo(c.undoId);
    s.undo(b.undoId);
    const back0 = s.undo(a.undoId);
    // the mesh the session started from (a copy of it)
    expect(Buffer.compare(Buffer.from(back0.positions.buffer), Buffer.from(start.positions.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(back0.labels.buffer), Buffer.from(start.labels.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(vox.field.buffer), Buffer.from(field0.buffer))).toBe(0);
    expect(() => s.undo(a.undoId)).toThrow(/nothing to undo/);
    expect(s.historyBytes()).toBeGreaterThan(0);
  });

  it('a session without a starting mesh remeshes its volume (labels unknown)', () => {
    const v = volumeOf(sphereF(1), 33, 1.3);
    const s = new SculptSession('v', v);
    expect(s.mesh.labels.every((l) => l === 255)).toBe(true);
    const r = s.stroke(stroke('inflate', [[0, 1, 0]]), { pairs: 3 });
    expect(r.mesh.positions.length).toBeGreaterThan(0);
  });

  it('one drag = one history step: live updates continue the stroke (3 pairs), remesh(10) ends it; undo restores the start', () => {
    const src = meshOf(sphereF(1), 40, 1.3, 10);
    const vox = voxelizeMesh(src, 48, { margin: 6 });
    const f0 = new Float32Array(vox.field);
    const s = new SculptSession('drag', vox, colored(src, 4));
    const first = s.stroke(stroke('inflate', [[0, 1, 0]]), { pairs: 3 });
    const second = s.stroke(stroke('inflate', [[0.1, 0.99, 0]]), { pairs: 3, continues: first.undoId });
    const third = s.stroke(stroke('inflate', [[0.2, 0.97, 0]]), { pairs: 3, continues: first.undoId });
    expect(second.undoId).toBe(first.undoId);
    expect(third.undoId).toBe(first.undoId);
    expect(s.undoIds).toEqual([first.undoId]);
    const end = s.remesh(10);
    expect(end.labels.every((l) => l === 4)).toBe(true);
    expect(() => s.stroke(stroke('inflate', [[0, 1, 0]]), { continues: 'drag:99' })).toThrow(MeshToolError);
    s.undo(first.undoId);
    expect(Buffer.compare(Buffer.from(vox.field.buffer), Buffer.from(f0.buffer))).toBe(0);
  });

  it('mergeDiffs keeps the oldest "before" and the newest "after"', () => {
    const v = volumeOf(sphereF(1), 33, 1.3);
    const f0 = new Float32Array(v.field);
    const d1 = applyStroke(v, stroke('inflate', [[0, 1, 0]]));
    const d2 = applyStroke(v, stroke('inflate', [[0.3, 0.95, 0]]));
    const f2 = new Float32Array(v.field);
    const m = mergeDiffs(d1, d2);
    revertDiff(v, m);
    expect(Buffer.compare(Buffer.from(v.field.buffer), Buffer.from(f0.buffer))).toBe(0);
    reapplyDiff(v, m);
    expect(Buffer.compare(Buffer.from(v.field.buffer), Buffer.from(f2.buffer))).toBe(0);
  });

  it('returned meshes are copies (the worker may transfer them)', () => {
    const src = meshOf(sphereF(1), 30, 1.3, 10);
    const s = new SculptSession('t', voxelizeMesh(src, 40, { margin: 6 }), colored(src, 2));
    const r = s.stroke(stroke('inflate', [[0, 1, 0]]));
    r.mesh.labels.fill(9); // the caller scribbling on (or detaching) its copy changes nothing inside
    const back = s.undo(r.undoId);
    expect(back.labels.every((l) => l === 2)).toBe(true);
  });

  it('a caller-given mirror plane mirrors the dab across it', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    // mirror across z = 0 instead of x = 0
    applyStroke(v, stroke('inflate', [[0.3, 0.5, 0.7]], 0.4, 1, true), { mirrorPlane: { point: [0, 0, 0], normal: [0, 0, 2] } });
    const n = 41;
    let worst = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) worst = Math.max(worst, Math.abs(v.field[x + n * (y + n * z)] - v.field[x + n * (y + n * (n - 1 - z))]));
    expect(worst).toBeLessThan(1e-6);
    expect(() => applyStroke(v, stroke('inflate', [[0.3, 0.5, 0.7]], 0.4, 1, true), { mirrorPlane: { point: [0, 0, 0], normal: [0, 0, 0] } })).toThrow(RangeError);
  });
});
