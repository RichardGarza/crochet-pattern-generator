// T3.2 — the single-photo view turns of §2.9.3 map the photo axes as the §2.9.2 table says (§6.3 T3).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../types/geometry';
import { turnPoint, turnVolume, unturnPoint, VIEW_TURNS, type PhotoViewChoice } from '../viewTurn';

/**
 * §2.9.2, written out here independently of align.ts and viewTurn.ts: per label, where image right (u), image up
 * (v) and "toward the camera" point in the object frame.
 */
const TABLE: Record<PhotoViewChoice, { u: Vec3; v: Vec3; toCamera: Vec3 }> = {
  front: { u: [1, 0, 0], v: [0, 1, 0], toCamera: [0, 0, 1] }, // camera at +Z
  left: { u: [0, 0, -1], v: [0, 1, 0], toCamera: [1, 0, 0] }, // the object's own left, camera at +X
  right: { u: [0, 0, 1], v: [0, 1, 0], toCamera: [-1, 0, 0] }, // camera at −X
  top: { u: [1, 0, 0], v: [0, 0, -1], toCamera: [0, 1, 0] }, // camera at +Y, the object's front at the photo bottom
};

/** −0 → 0 (a flipped zero is still zero). */
const z0 = (p: Vec3): Vec3 => [p[0] + 0, p[1] + 0, p[2] + 0];

const VIEWS: PhotoViewChoice[] = ['front', 'left', 'right', 'top'];

function det(t: (p: Vec3) => Vec3): number {
  const a = t([1, 0, 0]);
  const b = t([0, 1, 0]);
  const c = t([0, 0, 1]);
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

describe('view turns (§2.9.3)', () => {
  it.each(VIEWS)('%s: photo x′ → image u, y′ → image v, z′ → toward the camera, a proper rotation', (view) => {
    expect(z0(turnPoint([1, 0, 0], view))).toEqual(TABLE[view].u);
    expect(z0(turnPoint([0, 1, 0], view))).toEqual(TABLE[view].v);
    expect(z0(turnPoint([0, 0, 1], view))).toEqual(TABLE[view].toCamera);
    expect(det((p) => turnPoint(p, view))).toBe(1);
  });

  it('matches the spec formulas', () => {
    const p: Vec3 = [0.1, 0.2, 0.3];
    expect(z0(turnPoint(p, 'front'))).toEqual([0.1, 0.2, 0.3]);
    expect(z0(turnPoint(p, 'left'))).toEqual([0.3, 0.2, -0.1]); // (z′, y′, −x′)
    expect(z0(turnPoint(p, 'right'))).toEqual([-0.3, 0.2, 0.1]); // (−z′, y′, x′)
    expect(z0(turnPoint(p, 'top'))).toEqual([0.1, 0.3, -0.2]); // (x′, z′, −y′)
    for (const v of VIEWS) expect(z0(unturnPoint(turnPoint(p, v), v))).toEqual(p);
    expect(Object.keys(VIEW_TURNS).sort()).toEqual([...VIEWS].sort());
  });

  it.each(VIEWS)('%s: turnVolume is an exact permutation (every sample lands at its turned position)', (view) => {
    const dims = [5, 4, 3] as const;
    const origin: Vec3 = [-0.7, 0.3, -0.1];
    const voxel = 0.25;
    const data = Float32Array.from({ length: 60 }, (_, i) => i * 1.5 + 1);
    const out = turnVolume({ data, dims, origin, voxel }, view);
    expect([...out.data].sort((a, b) => a - b)).toEqual([...data].sort((a, b) => a - b));
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          const p: Vec3 = [origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z];
          const q = turnPoint(p, view);
          const I = (q[0] - out.origin[0]) / voxel;
          const J = (q[1] - out.origin[1]) / voxel;
          const K = (q[2] - out.origin[2]) / voxel;
          for (const v of [I, J, K]) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9);
          const k = Math.round(I) + out.dims[0] * (Math.round(J) + out.dims[1] * Math.round(K));
          expect(out.data[k]).toBe(data[x + dims[0] * (y + dims[1] * z)]);
        }
      }
    }
  });

  it('rejects an unknown view and a wrong buffer', () => {
    expect(() => turnPoint([0, 0, 0], 'back' as PhotoViewChoice)).toThrow(RangeError);
    expect(() => turnPoint([0, 0, 0], 'toString' as PhotoViewChoice)).toThrow(RangeError);
    expect(() => turnVolume({ data: new Float32Array(5), dims: [2, 2, 2], origin: [0, 0, 0], voxel: 1 }, 'left')).toThrow(RangeError);
  });
});
