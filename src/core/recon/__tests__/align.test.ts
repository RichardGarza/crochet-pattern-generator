// View conventions and alignment (DESIGN.md §2.9.2): the label table, mask orientation, automatic scales from the
// shared axes, the top-view mismatch warning, mirrored pairs, per-view signed distance in world units (Step 0 EDT),
// plane tables, the reprojected hull and the per-view consistency IoU (the badges).
import { describe, expect, it } from 'vitest';
import type { Vec3, ViewLabel } from '../../../types/geometry';
import {
  ALIGN_ISSUES,
  DEFAULT_ALIGN,
  PLANE_AXES,
  VIEW_CONVENTIONS,
  alignViews,
  alignedBounds,
  hullSilhouettes,
  makeGrid,
  orientMask,
  pixelToViewUV,
  pixelToWorld,
  planeTables,
  sampleField,
  viewConsistency,
  viewSignedDistance,
  viewUVToPixel,
  worldToPixel,
  type ViewMask,
} from '../align';
import { maskBox } from '../masks';
import { TEDDY, centered, renderSilhouette, sameBytes, solidBounds, sphere, type Camera, type Ellipsoid } from './helpers/views';

const HEAVY = { timeout: 60_000 };

function view(id: string, label: ViewLabel, solids: readonly Ellipsoid[], cam: Camera, align?: ViewMask['align']): ViewMask {
  return { id, label, mask: renderSilhouette(solids, label, cam), w: cam.w, h: cam.h, align };
}

/** Rows of a small mask for orientation tests. */
function rows(lines: string[]): { mask: Uint8Array; w: number; h: number } {
  const h = lines.length;
  const w = lines[0].length;
  return { mask: Uint8Array.from(lines.join('').split(''), (c) => (c === '#' ? 1 : 0)), w, h };
}
const toRows = (m: ArrayLike<number>, w: number, h: number): string[] =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (m[x + w * y] ? '#' : '.')).join(''));

describe('view conventions (§2.9.2 table)', () => {
  it('maps every label exactly as the table says', () => {
    const name = (a: { axis: number; sign: number }): string => `${a.sign > 0 ? '+' : '−'}${'XYZ'[a.axis]}`;
    const table = Object.fromEntries(
      (Object.keys(VIEW_CONVENTIONS) as ViewLabel[]).map((l) => {
        const c = VIEW_CONVENTIONS[l];
        return [l, [`camera ${name(c.depth)}`, `u ${name(c.u)}`, `v ${name(c.v)}`, c.plane]];
      }),
    );
    expect(table).toEqual({
      front: ['camera +Z', 'u +X', 'v +Y', 'XY'],
      back: ['camera −Z', 'u −X', 'v +Y', 'XY'],
      left: ['camera +X', 'u −Z', 'v +Y', 'ZY'],
      right: ['camera −X', 'u +Z', 'v +Y', 'ZY'],
      top: ['camera +Y', 'u +X', 'v −Z', 'XZ'],
      bottom: ['camera −Y', 'u +X', 'v +Z', 'XZ'],
    });
  });

  it('every view is a right-handed camera: u × v points toward the camera', () => {
    for (const c of Object.values(VIEW_CONVENTIONS)) {
      const vec = (a: { axis: number; sign: number }): Vec3 => {
        const out: Vec3 = [0, 0, 0];
        out[a.axis] = a.sign;
        return out;
      };
      const [u, v, d] = [vec(c.u), vec(c.v), vec(c.depth)];
      const cross: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      expect(cross.map((x) => x + 0)).toEqual(d);
      expect(PLANE_AXES[c.plane]).toContain(c.u.axis);
      expect(PLANE_AXES[c.plane]).toContain(c.v.axis);
    }
  });
});

describe('orientMask', () => {
  const L = rows(['#..', '#..', '##.']);

  it('rotates clockwise in quarter turns and mirrors after rotating', () => {
    expect(toRows(orientMask(L.mask, 3, 3, 1, false).mask, 3, 3)).toEqual(['###', '#..', '...']);
    expect(toRows(orientMask(L.mask, 3, 3, 2, false).mask, 3, 3)).toEqual(['.##', '..#', '..#']);
    expect(toRows(orientMask(L.mask, 3, 3, 3, false).mask, 3, 3)).toEqual(['...', '..#', '###']);
    expect(toRows(orientMask(L.mask, 3, 3, 0, true).mask, 3, 3)).toEqual(['..#', '..#', '.##']);
    expect(toRows(orientMask(L.mask, 3, 3, 1, true).mask, 3, 3)).toEqual(['###', '..#', '...']);
  });

  it('swaps the size on odd turns; four turns and two mirrors are the identity', () => {
    const r = rows(['##..', '#...']);
    const o = orientMask(r.mask, 4, 2, 1, false);
    expect([o.w, o.h]).toEqual([2, 4]);
    expect(toRows(o.mask, 2, 4)).toEqual(['##', '.#', '..', '..']);
    let m = { mask: Uint8Array.from(r.mask), w: 4, h: 2 };
    for (let k = 0; k < 4; k++) m = orientMask(m.mask, m.w, m.h, 1, false);
    expect(Array.from(m.mask)).toEqual(Array.from(r.mask));
    const twice = orientMask(orientMask(r.mask, 4, 2, 0, true).mask, 4, 2, 0, true);
    expect(Array.from(twice.mask)).toEqual(Array.from(r.mask));
    expect(() => orientMask(r.mask, 3, 2, 0, false)).toThrow(RangeError);
    expect(() => orientMask(r.mask, 4, 2, 4 as 0, false)).toThrow(RangeError);
  });
});

describe('alignViews: automatic scales from the shared axes', () => {
  it('a sphere photographed at three zooms: every view gets its own px/unit, extents 1 × 1 × 1', () => {
    const s = [sphere(0.5)];
    const a = alignViews([
      view('f', 'front', s, { w: 300, h: 260, pxPerUnit: 200 }),
      view('l', 'left', s, { w: 200, h: 220, pxPerUnit: 150, center: [90, 120] }),
      view('t', 'top', s, { w: 400, h: 400, pxPerUnit: 310, center: [210, 190] }),
    ]);
    expect(a.issues).toEqual([]);
    expect(a.planes).toEqual(['XY', 'XZ', 'ZY']);
    expect(a.views.map((v) => v.pxPerUnit)).toEqual([200, 150, 310]);
    expect(a.extents[0]).toBeCloseTo(1, 12);
    expect(a.extents[1]).toBe(1);
    expect(a.extents[2]).toBeCloseTo(1, 12);
    expect(a.scaleMismatch.t).toBeCloseTo(0, 12);
  });

  it('recovers the teddy proportions X : Y : Z from front, left and top photos', () => {
    const t = centered(TEDDY);
    const { min, max } = solidBounds(t);
    const H = max[1] - min[1];
    const a = alignViews([
      view('f', 'front', t, { w: 480, h: 420, pxPerUnit: 360 }),
      view('l', 'left', t, { w: 400, h: 400, pxPerUnit: 300, center: [180, 210] }),
      view('t', 'top', t, { w: 500, h: 360, pxPerUnit: 420, center: [260, 170] }),
    ]);
    expect(a.issues).toEqual([]);
    const px = 2 / 300; // one pixel of the coarsest view, relative
    expect(a.extents[0]).toBeCloseTo((max[0] - min[0]) / H, 1);
    expect(Math.abs(a.extents[0] - (max[0] - min[0]) / H)).toBeLessThan(px);
    expect(Math.abs(a.extents[2] - (max[2] - min[2]) / H)).toBeLessThan(px);
    expect(a.scaleMismatch.t).toBeLessThan(0.01);
  });

  it('a wrongly scaled top view triggers the mismatch warning (> 8%)', () => {
    const s = [sphere(0.5)];
    const base = [view('f', 'front', s, { w: 300, h: 300, pxPerUnit: 200 }), view('r', 'right', s, { w: 300, h: 300, pxPerUnit: 200 })];
    const ok = alignViews([...base, view('t', 'top', s, { w: 300, h: 300, pxPerUnit: 200, stretchU: 1.05 })]);
    expect(ok.issues).toEqual([]);
    const bad = alignViews([...base, view('t', 'top', s, { w: 360, h: 300, pxPerUnit: 200, stretchU: 1.2 })]);
    expect(bad.scaleMismatch.t).toBeCloseTo(0.2, 2);
    expect(bad.issues.map((i) => [i.code, i.severity])).toEqual([[ALIGN_ISSUES.scale, 'warn']]);
    expect(bad.issues[0].message).toContain('20%');
  });

  it('front + top (no side): the top view sets the depth', () => {
    const e: Ellipsoid[] = [{ c: [0, 0, 0], r: [0.3, 0.5, 0.2] }];
    const a = alignViews([view('f', 'front', e, { w: 300, h: 300, pxPerUnit: 250 }), view('t', 'top', e, { w: 300, h: 300, pxPerUnit: 400 })]);
    expect(a.issues).toEqual([]);
    expect(a.views.find((v) => v.id === 't')?.pxPerUnit).toBeCloseTo(400, 0);
    expect(a.extents[2]).toBeCloseTo(0.4, 2);
  });

  it('side + top (no front): the top view sets the width', () => {
    const e: Ellipsoid[] = [{ c: [0, 0, 0], r: [0.3, 0.5, 0.2] }];
    const a = alignViews([view('l', 'left', e, { w: 300, h: 300, pxPerUnit: 250 }), view('t', 'top', e, { w: 300, h: 300, pxPerUnit: 400 })]);
    expect(a.issues).toEqual([]);
    expect(a.extents[0]).toBeCloseTo(0.6, 2);
  });

  it('E_VIEWS: one front photo, front + back, or top/bottom only; W_VIEW_EMPTY; W_VIEW_DUPLICATE; bad input throws', () => {
    const s = [sphere(0.5)];
    const cam = { w: 200, h: 200, pxPerUnit: 150 };
    const codes = (vs: ViewMask[]): string[] => alignViews(vs).issues.map((i) => i.code);
    expect(codes([view('f', 'front', s, cam)])).toEqual([ALIGN_ISSUES.views]);
    expect(codes([view('f', 'front', s, cam), view('b', 'back', s, cam)])).toEqual([ALIGN_ISSUES.views]);
    const topOnly = alignViews([view('t', 'top', s, cam), view('u', 'bottom', s, cam)]);
    expect(topOnly.issues.map((i) => i.code)).toEqual([ALIGN_ISSUES.views]);
    expect(topOnly.views).toEqual([]);
    const empty: ViewMask = { id: 'e', label: 'left', mask: new Uint8Array(100), w: 10, h: 10 };
    expect(codes([view('f', 'front', s, cam), empty, view('t', 'top', s, cam)])).toEqual([ALIGN_ISSUES.emptyView]);
    expect(codes([view('f', 'front', s, cam), view('f2', 'front', s, cam), view('l', 'left', s, cam)])).toEqual([ALIGN_ISSUES.duplicate]);
    // Every per-view issue names its photo (Issue.where.view = PhotoView.id, §2.9.1–2.9.2); E_VIEWS names none.
    expect(alignViews([view('f', 'front', s, cam), empty, view('t', 'top', s, cam)]).issues[0].where).toEqual({ view: 'e' });
    expect(alignViews([view('f', 'front', s, cam), view('f2', 'front', s, cam), view('l', 'left', s, cam)]).issues[0].where).toEqual({ view: 'f2' });
    expect(topOnly.issues[0].where).toBeUndefined();
    expect(() => alignViews([{ ...view('f', 'front', s, cam), align: { ...DEFAULT_ALIGN, scale: 0 } }])).toThrow(RangeError);
    expect(() => alignViews([{ ...view('f', 'front', s, cam), label: 'side' as ViewLabel }])).toThrow(RangeError);
    expect(() => alignViews([{ ...view('f', 'front', s, cam), label: 'toString' as ViewLabel }])).toThrow(RangeError);
    expect(() => alignViews([view('f', 'front', s, cam), view('f', 'left', s, cam)])).toThrow(/two views have the id/);
    expect(() => alignViews([view('f', 'front', s, cam, { ...DEFAULT_ALIGN, rot90: 4 as 0 })])).toThrow(RangeError);
    expect(() => alignViews([view('f', 'front', s, cam, { ...DEFAULT_ALIGN, mirror: 'yes' as unknown as boolean })])).toThrow(RangeError);
    expect(() => alignViews([view('f', 'front', s, cam, { ...DEFAULT_ALIGN, dx: Number.NaN })])).toThrow(RangeError);
  });
});

describe('pixel ↔ world', () => {
  const t = centered(TEDDY);
  const a = alignViews([
    view('f', 'front', t, { w: 400, h: 360, pxPerUnit: 300 }),
    view('b', 'back', t, { w: 400, h: 360, pxPerUnit: 280, center: [210, 175] }),
    view('l', 'left', t, { w: 400, h: 360, pxPerUnit: 300 }),
    view('t', 'top', t, { w: 400, h: 360, pxPerUnit: 300 }),
  ]);

  it('round-trips and projects along the view axis', () => {
    for (const v of a.views) {
      const [px, py] = viewUVToPixel(v, 0.123, -0.2);
      const [u, w] = pixelToViewUV(v, px, py);
      expect(u).toBeCloseTo(0.123, 12);
      expect(w).toBeCloseTo(-0.2, 12);
      const p = pixelToWorld(v, 100, 50);
      const q = worldToPixel(v, p);
      expect(q[0]).toBeCloseTo(100, 9);
      expect(q[1]).toBeCloseTo(50, 9);
      // Moving along the view's depth axis does not move the pixel.
      const deeper: Vec3 = [...p];
      deeper[v.convention.depth.axis] += 0.37;
      expect(worldToPixel(v, deeper)).toEqual(q);
    }
  });

  it('the object\'s own left (+X) is image right in front and image left in the back photo', () => {
    const f = a.views.find((v) => v.id === 'f')!;
    const b = a.views.find((v) => v.id === 'b')!;
    const arm: Vec3 = [0.3, -0.05, 0];
    expect(worldToPixel(f, arm)[0]).toBeGreaterThan(f.box.cx);
    expect(worldToPixel(b, arm)[0]).toBeLessThan(b.box.cx);
    // The muzzle (+Z) is image left in the left-side photo (camera at +X looks toward −X; u = −Z).
    const l = a.views.find((v) => v.id === 'l')!;
    expect(worldToPixel(l, [0, 0.1, 0.2])[0]).toBeLessThan(l.box.cx);
    // Top photo: the object's front (+Z) is at the photo bottom.
    const top = a.views.find((v) => v.id === 't')!;
    expect(worldToPixel(top, [0, 0, 0.2])[1]).toBeGreaterThan(top.box.cy);
  });

  it('every view is centered on its mask box center; the world origin is the object\'s box center', () => {
    for (const v of a.views) {
      const p = pixelToWorld(v, v.box.cx, v.box.cy);
      expect(Math.hypot(...p)).toBeLessThan(1e-12);
    }
    const b = alignedBounds(a);
    expect(b.max[1] - b.min[1]).toBeCloseTo(1, 12);
    expect(b.min[1]).toBeCloseTo(-0.5, 12);
  });

  it('manual offset, scale, rotation and mirror', () => {
    const s = [sphere(0.5)];
    const cam = { w: 200, h: 200, pxPerUnit: 150 };
    const plain = alignViews([view('f', 'front', s, cam), view('l', 'left', s, cam)]).views[0];
    const moved = alignViews([view('f', 'front', s, cam, { ...DEFAULT_ALIGN, dx: 0.1, dy: -0.05, scale: 1.1 }), view('l', 'left', s, cam)]).views[0];
    // scale 1.1 makes the view's outline 10% larger in the world: fewer pixels per unit.
    expect(moved.pxPerUnit).toBeCloseTo(plain.pxPerUnit / 1.1, 12);
    expect(moved.autoPxPerUnit).toBe(plain.pxPerUnit);
    expect(pixelToViewUV(moved, moved.box.cx, moved.box.cy)).toEqual([0.1, -0.05]);
    // A photo taken sideways (rotated a quarter turn counter-clockwise) is fixed by rot90 = 1.
    const e: Ellipsoid[] = [{ c: [0, 0, 0], r: [0.25, 0.5, 0.25] }];
    const upright = renderSilhouette(e, 'front', { w: 200, h: 240, pxPerUnit: 200 });
    const sideways = orientMask(upright, 200, 240, 3, false);
    const fixed = alignViews([{ id: 'f', label: 'front', mask: sideways.mask, w: sideways.w, h: sideways.h, align: { ...DEFAULT_ALIGN, rot90: 1 } }, view('l', 'left', e, cam)]);
    expect(sameBytes(fixed.views[0].mask, upright)).toBe(true);
    expect(fixed.extents[0]).toBeCloseTo(0.5, 2);
  });
});

describe('signed distance per view, sampling, grid', () => {
  it('every mask is cleaned: enclosed holes filled (unless keepHoles) and closed by 2 px', () => {
    const s = [sphere(0.5)];
    const f = view('f', 'front', s, { w: 200, h: 200, pxPerUnit: 150 });
    const holed = Uint8Array.from(f.mask as Uint8Array);
    for (let y = 90; y < 110; y++) for (let x = 90; x < 110; x++) holed[x + 200 * y] = 0;
    const l = view('l', 'left', s, { w: 200, h: 200, pxPerUnit: 150 });
    expect(alignViews([{ ...f, mask: holed }, l]).views[0].mask[100 + 200 * 100]).toBe(1);
    expect(alignViews([{ ...f, mask: holed }, l], { keepHoles: true }).views[0].mask[100 + 200 * 100]).toBe(0);
  });

  it('the photo frame counts as outside: a full-frame or cut-off mask gives a finite field', () => {
    const full: ViewMask = { id: 'f', label: 'front', mask: new Uint8Array(40 * 30).fill(1), w: 40, h: 30 };
    const side = view('l', 'left', [sphere(0.5)], { w: 100, h: 100, pxPerUnit: 60 });
    const a = alignViews([full, side]);
    const sd = viewSignedDistance(a.views[0]);
    expect(sd.every(Number.isFinite)).toBe(true);
    // The center is 15 px from the top and bottom frame: 0.5 world units at 30 px per unit (+ half a pixel).
    expect(sd[20 + 40 * 15]).toBeCloseTo(15 / 30, 1);
    // Cut by the bottom edge: the zero level is at the photo edge, negative below it.
    const cut = view('f', 'front', [sphere(0.5)], { w: 200, h: 150, pxPerUnit: 160, center: [100, 120] });
    const b = alignViews([cut, view('l', 'left', [sphere(0.5)], { w: 200, h: 200, pxPerUnit: 160 })]);
    const v = b.views.find((x) => x.id === 'f')!;
    const field = viewSignedDistance(v);
    expect(sampleField(field, v.w, v.h, 100, 155, 1 / v.pxPerUnit)).toBeLessThan(0);
    expect(field[100 + 200 * 149]).toBeGreaterThan(0);
    expect(field[100 + 200 * 149]).toBeLessThan(1 / v.pxPerUnit);
  });

  it('the per-view signed EDT is in world units (Step 0 kernel)', () => {
    const s = [sphere(0.5)];
    const a = alignViews([view('f', 'front', s, { w: 301, h: 301, pxPerUnit: 200, center: [150.5, 150.5] }), view('l', 'left', s, { w: 200, h: 200, pxPerUnit: 120 })]);
    const f = a.views[0];
    const sd = viewSignedDistance(f);
    // At the disc center: the radius, 0.5 world units (±1 px).
    expect(Math.abs(sd[150 + 301 * 150] - 0.5)).toBeLessThan(1 / 200);
    // At the image corner: −(distance to the disc).
    expect(Math.abs(sd[0] - -(Math.hypot(150, 150) / 200 - 0.5))).toBeLessThan(1 / 200);
  });

  it('sampleField: bilinear inside, clamped and lowered outside, no NaN from infinities', () => {
    const w = 3;
    const h = 2;
    const field = Float32Array.from([0, 1, 2, 10, 11, 12]);
    expect(sampleField(field, w, h, 1.5, 0.5, 1)).toBe(1);
    expect(sampleField(field, w, h, 1, 1, 1)).toBeCloseTo(5.5, 12);
    expect(sampleField(field, w, h, -2.5, 0.5, 0.5)).toBeCloseTo(0 - 3 * 0.5, 12);
    const inf = Float32Array.from([Infinity, Infinity, Infinity, Infinity]);
    expect(sampleField(inf, 2, 2, 1, 1, 1)).toBe(Infinity);
    expect(sampleField(Float32Array.from([-Infinity, -Infinity]), 2, 1, 0.75, 0.5, 1)).toBe(-Infinity);
  });

  it('makeGrid: a cube around the box with 10% padding per side, N samples per axis', () => {
    const g = makeGrid({ min: [-0.3, -0.5, -0.2], max: [0.3, 0.5, 0.2] }, 128);
    expect(g.N).toBe(128);
    expect(g.voxel * 127).toBeCloseTo(1 / 0.8, 12);
    expect(g.origin[1]).toBeCloseTo(-0.625, 12);
    expect(g.origin[0] + (g.voxel * 127) / 2).toBeCloseTo(0, 12);
    expect(() => makeGrid({ min: [0, 0, 0], max: [0, 0, 0] }, 64)).toThrow(RangeError);
    expect(() => makeGrid({ min: [0, 0, 0], max: [1, 1, 1] }, 1)).toThrow(RangeError);
  });
});

describe('plane tables, hull silhouettes, consistency IoU', HEAVY, () => {
  it('three views of a sphere agree: IoU ≈ 1 for every view, no warning', () => {
    const s = [sphere(0.5)];
    const a = alignViews([
      view('f', 'front', s, { w: 300, h: 300, pxPerUnit: 220 }),
      view('l', 'left', s, { w: 300, h: 300, pxPerUnit: 180 }),
      view('t', 'top', s, { w: 300, h: 300, pxPerUnit: 250 }),
    ]);
    const c = viewConsistency(a);
    expect(c.issues).toEqual([]);
    for (const v of c.views) {
      expect(v.iou, v.id).toBeGreaterThan(0.98);
      expect(v.warn).toBe(false);
    }
  });

  it('the teddy from four or five views: consistent; the back photo is mirrored and united with the front', () => {
    const t = centered(TEDDY);
    const views = [
      view('f', 'front', t, { w: 420, h: 400, pxPerUnit: 330 }),
      view('b', 'back', t, { w: 420, h: 400, pxPerUnit: 300, center: [200, 210] }),
      view('l', 'left', t, { w: 400, h: 400, pxPerUnit: 310 }),
      view('r', 'right', t, { w: 400, h: 400, pxPerUnit: 290 }),
      view('t', 'top', t, { w: 420, h: 380, pxPerUnit: 340 }),
    ];
    const a = alignViews(views);
    expect(a.issues).toEqual([]);
    const c = viewConsistency(a, 96);
    expect(c.issues).toEqual([]);
    for (const v of c.views) expect(v.iou, v.id).toBeGreaterThan(0.95);
    // Opposite views carry the same (mirrored) silhouette: front and back tables agree.
    const g = makeGrid(alignedBounds(a), 64);
    const { perView } = planeTables(a, g);
    let agree = 0;
    for (let k = 0; k < 64 * 64; k++) if (perView.f[k] > 0 === perView.b[k] > 0) agree++;
    expect(agree / (64 * 64)).toBeGreaterThan(0.99);
  });

  it('a mislabeled photo (a side photo labelled "top") is flagged with W_VIEW_IOU', () => {
    const t = centered(TEDDY);
    const a = alignViews([
      view('f', 'front', t, { w: 420, h: 400, pxPerUnit: 330 }),
      view('l', 'left', t, { w: 400, h: 400, pxPerUnit: 310 }),
      { ...view('t', 'left', t, { w: 400, h: 400, pxPerUnit: 300 }), label: 'top' },
    ]);
    const c = viewConsistency(a, 96);
    expect(c.views.some((v) => v.warn)).toBe(true);
    expect(c.issues.map((i) => i.code)).toContain(ALIGN_ISSUES.iou);
    const flagged = new Set(c.views.filter((v) => v.warn).map((v) => v.id));
    for (const issue of c.issues) expect(flagged.has(issue.where?.view as string)).toBe(true);
  });

  it('a stray blob that shifts the box center lowers the IoU below 0.9; align.dx restores it', () => {
    const t = centered(TEDDY);
    const cam = { w: 500, h: 400, pxPerUnit: 300, center: [200, 200] as [number, number] };
    const side = view('l', 'left', t, cam);
    const clean = maskBox(side.mask, 500, 400)!;
    // A stray blob far to the image right (u = −Z = 0.6) widens the side mask's box, so auto-centering is off.
    const blob = renderSilhouette([{ c: [0, -0.4, -0.6], r: [0.05, 0.05, 0.05] }], 'left', cam);
    const glitched = Uint8Array.from(side.mask as Uint8Array, (v, i) => v | blob[i]);
    const front = view('f', 'front', t, { w: 420, h: 400, pxPerUnit: 330 });
    const top = view('t', 'top', t, { w: 420, h: 380, pxPerUnit: 340 });
    const a0 = alignViews([front, { ...side, mask: glitched }, top]);
    const iouBad = viewConsistency(a0, 96).views.find((v) => v.id === 'l')!.iou;
    expect(iouBad).toBeLessThan(0.9);
    // The user drags the side view back by the box-center shift (in object heights).
    const lv = a0.views.find((v) => v.id === 'l')!;
    const dx = (lv.box.cx - clean.cx) / lv.pxPerUnit;
    expect(dx).toBeGreaterThan(0.1);
    const fixed = viewConsistency(alignViews([front, { ...side, mask: glitched, align: { ...DEFAULT_ALIGN, dx } }, top]), 96);
    const iouFixed = fixed.views.find((v) => v.id === 'l')!.iou;
    expect(iouFixed).toBeGreaterThan(0.9);
    expect(iouFixed).toBeGreaterThan(iouBad + 0.05);
  });

  it('mirrored-pair union: a notch cut into the side mask is repaired by the other side; the bad photo is flagged', () => {
    const t = centered(TEDDY);
    const left = view('l', 'left', t, { w: 400, h: 400, pxPerUnit: 300 });
    const holed = Uint8Array.from(left.mask as Uint8Array);
    // A 30 px notch from the photo top down through the head and body (an enclosed hole would be filled by the
    // clean-up of §2.9.2; a notch open to the outside is not).
    for (let y = 0; y < 260; y++) for (let x = 170; x < 200; x++) holed[x + 400 * y] = 0;
    const views = [
      view('f', 'front', t, { w: 420, h: 400, pxPerUnit: 330 }),
      { ...left, mask: holed },
      view('r', 'right', t, { w: 400, h: 400, pxPerUnit: 300 }),
      view('t', 'top', t, { w: 420, h: 380, pxPerUnit: 340 }),
    ];
    const a = alignViews(views);
    const g = makeGrid(alignedBounds(a), 96);
    const { planes, perView } = planeTables(a, g);
    // The united ZY table covers the hole; the left view's own table does not.
    let holeCells = 0;
    let repaired = 0;
    for (let k = 0; k < 96 * 96; k++) {
      if (perView.l[k] <= 0 && perView.r[k] > 0) {
        holeCells++;
        if ((planes.ZY as Float32Array)[k] > 0) repaired++;
      }
    }
    expect(holeCells).toBeGreaterThan(20);
    expect(repaired).toBe(holeCells);
    const c = viewConsistency(a, 96);
    const iou = Object.fromEntries(c.views.map((v) => [v.id, v.iou]));
    expect(iou.l).toBeLessThan(iou.r);
    expect(iou.r).toBeGreaterThan(0.95);
  });

  it('no aligned views: an empty report, no throw', () => {
    const s = [sphere(0.5)];
    const c = viewConsistency(alignViews([view('t', 'top', s, { w: 100, h: 100, pxPerUnit: 80 })]));
    expect(c).toEqual({ grid: null, views: [], silhouettes: {}, issues: [] });
  });

  it('hullSilhouettes with two planes only: rows where both views are inside', () => {
    const N = 4;
    const xy = Float32Array.from([1, 1, -1, -1, 1, 1, 1, 1, -1, -1, -1, -1, 1, -1, -1, -1]);
    const zy = Float32Array.from([1, -1, -1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const s = hullSilhouettes({ XY: xy, ZY: zy }, N);
    expect(s.XZ).toBeUndefined();
    // Row y = 0: x ∈ {0, 1}, z ∈ {0}; y = 1: no z; y = 2: no x; y = 3: x = 0, z ∈ all.
    expect(Array.from(s.XY as Uint8Array)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(Array.from(s.ZY as Uint8Array)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('EDT use: the three-view hull of a sphere from the plane tables has 1.119 × its volume (Steinmetz tricylinder)', () => {
    // Sign-only count on the N = 128 lattice; T3.2 meshes the same tables (theory (16 − 8√2)/(4π/3) = 1.1188).
    const s = [sphere(0.5)];
    const a = alignViews([
      view('f', 'front', s, { w: 512, h: 512, pxPerUnit: 400 }),
      view('l', 'left', s, { w: 512, h: 512, pxPerUnit: 380 }),
      view('t', 'top', s, { w: 512, h: 512, pxPerUnit: 420 }),
    ]);
    const N = 128;
    const g = makeGrid(alignedBounds(a), N);
    const { planes } = planeTables(a, g);
    const xy = planes.XY as Float32Array;
    const zy = planes.ZY as Float32Array;
    const xz = planes.XZ as Float32Array;
    let hull = 0;
    let ball = 0;
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (Math.min(xy[x + N * y], zy[z + N * y], xz[x + N * z]) > 0) hull++;
          const p = [g.origin[0] + g.voxel * x, g.origin[1] + g.voxel * y, g.origin[2] + g.voxel * z];
          if (Math.hypot(p[0], p[1], p[2]) <= 0.5) ball++;
        }
      }
    }
    expect(Math.abs(hull / ball - 1.119)).toBeLessThan(0.01);
  });

  it('is deterministic', () => {
    const t = centered(TEDDY);
    const vs = [view('f', 'front', t, { w: 300, h: 300, pxPerUnit: 240 }), view('l', 'left', t, { w: 300, h: 300, pxPerUnit: 230 }), view('t', 'top', t, { w: 300, h: 300, pxPerUnit: 250 })];
    const c1 = viewConsistency(alignViews(vs), 64);
    const c2 = viewConsistency(alignViews(vs), 64);
    expect(c1.views).toEqual(c2.views);
    expect(sameBytes(c1.silhouettes.XY as Uint8Array, c2.silhouettes.XY as Uint8Array)).toBe(true);
  });
});
