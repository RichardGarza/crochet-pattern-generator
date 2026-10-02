// Track T7.4a — the front-view preview of the import screens (preview.ts): hulls, one outline per part in its yarn
// color, back to front, the model's bounds; mesh parts without buffers drawn as their bounding ellipsoid.
import { describe, expect, it } from 'vitest';
import { teddy } from '../../../state/slices/__tests__/teddyProject';
import type { CrochetModelV1 } from '../../../types/model';
import { convexHull, frontView } from '../preview';

describe('convexHull', () => {
  it('a square with inner and repeated points; fewer than 3 points; non-finite values skipped', () => {
    expect(convexHull([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 1, 1])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(convexHull([0, 0, 1, 1])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(convexHull([0, 0, NaN, 3, 1, 0, 0, 1])).toHaveLength(3);
  });
});

describe('frontView', () => {
  it('the teddy: 17 outlines in palette colors, nearest last, bounds of the model', () => {
    const m = teddy();
    const v = frontView(m);
    expect(v.shapes).toHaveLength(17);
    const hex = new Set(m.palette.map((c) => c.hex));
    expect(v.shapes.every((s) => hex.has(s.fill) && s.d.startsWith('M') && s.d.endsWith('Z'))).toBe(true);
    for (let i = 1; i < v.shapes.length; i++) expect(v.shapes[i].z).toBeGreaterThanOrEqual(v.shapes[i - 1].z);
    // the nose sits in front of the muzzle, which sits in front of the head
    const at = (id: string) => v.shapes.findIndex((s) => s.part === id);
    expect(at('nose')).toBeGreaterThan(at('muzzle'));
    expect(at('muzzle')).toBeGreaterThan(at('head'));
    const [x0, y0, x1, y1] = v.box;
    expect(y0).toBeCloseTo(0, 2);
    expect(y1).toBeCloseTo(m.finishedSize.height, 1);
    expect(x0).toBeLessThan(0);
    expect(x1).toBeGreaterThan(0);
  });

  it('a mesh part without its buffers is drawn as its box ellipsoid; an empty model has a unit box', () => {
    const m: CrochetModelV1 = { ...teddy(), parts: [{ id: 'blob', type: 'mesh', dims: { meshRef: 'x', bboxIn: [2, 4, 2] }, position: [0, 2, 0], color: teddy().palette[0].id }] };
    const v = frontView(m);
    expect(v.shapes).toHaveLength(1);
    expect(v.box[3] - v.box[1]).toBeCloseTo(4, 1);
    expect(frontView({ ...m, parts: [] }).box).toEqual([-1, 0, 1, 1]);
  });
});
