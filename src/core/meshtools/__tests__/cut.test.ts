import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { cutPart, cutVolume } from '../cut';
import { remeshVolume } from '../remesh';
import { MeshToolError } from '../volume';
import { voxelizeMesh } from '../voxelize';
import { colored, ellipsoidF, HEAVY, meshOf, sphereF, type Implicit } from './helpers';

const peanut: Implicit = (x, y, z) => Math.max(sphereF(0.6, [0, -0.45, 0])(x, y, z), sphereF(0.5, [0, 0.5, 0])(x, y, z));

describe('plane cut (§2.9.8 acceptance)', HEAVY, () => {
  for (const [name, f, plane] of [
    ['sphere, through the center', sphereF(1), { point: [0, 0, 0], normal: [0, 1, 0] }],
    ['sphere, oblique and off center', sphereF(1), { point: [0.3, 0.1, 0], normal: [1, 0.4, -0.2] }],
    ['peanut, at the waist', peanut, { point: [0, 0.05, 0], normal: [0, 1, 0] }],
    ['ellipsoid, near one end', ellipsoidF([0.5, 1.2, 0.6]), { point: [0, 0.9, 0], normal: [0, 1, 0] }],
  ] as const) {
    it(`${name}: two watertight genus-0 meshes whose volumes sum to the original ±2%`, async () => {
      const src = meshOf(f, 60, 1.35, 10);
      const vol = voxelizeMesh(src, 96);
      const original = signedVolume(remeshVolume(vol));
      expect(original / signedVolume(src)).toBeCloseTo(1, 2);
      const [a, b] = cutPart(vol, { point: [...plane.point], normal: [...plane.normal] }, colored(src, 7));
      for (const piece of [a, b]) {
        expect(isWatertight(piece.mesh.indices)).toBe(true);
        expect(piece.components).toBe(1);
        expect(piece.volumeIn3).toBeGreaterThan(0);
        expect(piece.mesh.labels.every((l) => l === 7)).toBe(true);
        const report = await manifoldReport(piece.mesh);
        expect(report.status).toBe('NoError');
        expect(report.genus).toBe(0);
        expect(report.parts).toBe(1);
      }
      expect((a.volumeIn3 + b.volumeIn3) / original).toBeGreaterThan(0.98);
      expect((a.volumeIn3 + b.volumeIn3) / original).toBeLessThan(1.02);
      // a lies behind the plane (opposite the normal), b in front
      const n = plane.normal;
      const len = Math.hypot(n[0], n[1], n[2]);
      const side = (m: Float32Array): number => {
        let s = 0;
        for (let i = 0; i < m.length; i += 3) s += ((m[i] - plane.point[0]) * n[0] + (m[i + 1] - plane.point[1]) * n[1] + (m[i + 2] - plane.point[2]) * n[2]) / len;
        return s / (m.length / 3);
      };
      expect(side(a.mesh.positions)).toBeLessThan(0);
      expect(side(b.mesh.positions)).toBeGreaterThan(0);
    });
  }

  it('cutVolume is the min of the field and the plane distances, and leaves the input alone', () => {
    const vol = voxelizeMesh(meshOf(sphereF(1), 30, 1.3), 24);
    const copy = new Float32Array(vol.field);
    const { a, b } = cutVolume(vol, { point: [0, 0, 0], normal: [0, 0, 2] });
    expect(Buffer.compare(Buffer.from(vol.field.buffer), Buffer.from(copy.buffer))).toBe(0);
    for (let i = 0; i < vol.field.length; i += 97) {
      const z = vol.origin[2] + Math.floor(i / (vol.dims[0] * vol.dims[1])) * vol.voxel;
      expect(a.field[i]).toBeCloseTo(Math.min(vol.field[i], -z), 5);
      expect(b.field[i]).toBeCloseTo(Math.min(vol.field[i], z), 5);
    }
  });

  it('refuses a plane that misses the part and malformed planes', () => {
    const vol = voxelizeMesh(meshOf(sphereF(1), 30, 1.3), 24);
    expect(() => cutPart(vol, { point: [0, 2, 0], normal: [0, 1, 0] })).toThrow(MeshToolError);
    expect(() => cutPart(vol, { point: [0, 2, 0], normal: [0, 1, 0] })).toThrow('the plane does not cut this part');
    expect(() => cutVolume(vol, { point: [0, 0, 0], normal: [0, 0, 0] })).toThrow(RangeError);
    expect(() => cutVolume(vol, { point: [0, NaN, 0], normal: [0, 1, 0] })).toThrow(RangeError);
  });

  it('a cut through a U shape leaves two pieces on one side and says so', () => {
    const u: Implicit = (x, y, z) =>
      Math.max(ellipsoidF([0.25, 0.8, 0.25], [-0.6, 0.2, 0])(x, y, z), ellipsoidF([0.25, 0.8, 0.25], [0.6, 0.2, 0])(x, y, z), ellipsoidF([0.9, 0.25, 0.25], [0, -0.5, 0])(x, y, z));
    const vol = voxelizeMesh(meshOf(u, 50, 1.3), 64);
    const [a, b] = cutPart(vol, { point: [0, 0, 0], normal: [0, 1, 0] });
    expect(a.components).toBe(1);
    expect(b.components).toBe(2);
  });

  it('carries two colors across the cut (labels by nearest vertex), and refuses a grazing sliver', () => {
    const src = meshOf(sphereF(1), 50, 1.3, 10);
    const n = src.positions.length / 3;
    const labels = new Uint8Array(n).map((_, v) => (src.positions[3 * v] > 0 ? 3 : 5)); // +x half 3, −x half 5
    const vol = voxelizeMesh(src, 64);
    const [a, b] = cutPart(vol, { point: [0, 0, 0], normal: [0, 1, 0] }, { ...colored(src), labels });
    for (const piece of [a, b]) {
      let wrong = 0;
      for (let v = 0; v < piece.mesh.labels.length; v++) {
        const x = piece.mesh.positions[3 * v];
        if (Math.abs(x) > 0.1 && piece.mesh.labels[v] !== (x > 0 ? 3 : 5)) wrong++;
      }
      expect(wrong).toBe(0);
    }
    expect(() => cutPart(vol, { point: [0, 0.999, 0], normal: [0, 1, 0] })).toThrow('the plane does not cut this part');
  });
});
