// Track T6.3 — the color field as the editor paints and reads it (DESIGN.md §2.11.1): the eyedropper agrees with the
// builder at every vertex; a brush covers whole cells, never every other row; handles move regions as described.
import { describe, expect, it } from 'vitest';
import { partGeometry, vertexColorIds, uv64Cell } from '../../../core/model/builder';
import { localSdf } from '../../../core/model/sdf';
import { addRegion, NO_LABEL, setPartPaint } from '../../../state/slices/model3d';
import { byId, teddy } from '../../../state/slices/__tests__/teddyProject';
import everyType from '../../../../fixtures/models/every-type.json';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import {
  brushCells,
  brushVertices,
  cellAt,
  cellPoints,
  colorIdAt,
  dragRegion,
  paintFrameOf,
  paintInto,
  paintVertices,
  partSurface,
  pointAtAngles,
  pointAtHeight,
  regionHandles,
  regionOutline,
  surfaceCoords,
} from '../paintField';

function painted(): CrochetModelV1 {
  let m = teddy();
  const cells = new Uint8Array(4096).fill(NO_LABEL);
  for (let r = 30; r < 34; r++) cells.fill(2, r * 64, r * 64 + 20);
  m = setPartPaint(m, 'head', cells);
  m = addRegion(m, 'head', { kind: 'band', from: 0.1, to: 0.25, color: 'cream_yarn' }).model;
  m = addRegion(m, 'head', { kind: 'stripes', from: 0.5, to: 0.9, colors: ['cream_yarn', 'caramel_yarn'], widthIn: 0.3 }).model;
  m = addRegion(m, 'head', { kind: 'patch', azimuthDeg: 30, spanDeg: 80, from: 0.3, to: 0.7, color: 'dark_brown_yarn' }).model;
  m = addRegion(m, 'head', { kind: 'spot', azimuthDeg: -40, elevationDeg: 15, radiusIn: 0.6, color: 'black_safety_eye' }).model;
  return m;
}

describe('colorIdAt (the eyedropper)', () => {
  it('equals the builder at every vertex of a part with paint and every region kind', () => {
    const m = painted();
    const head = byId(m).head;
    const g = partGeometry(head, 1);
    const ids = vertexColorIds(g, head, 1, { paletteIds: m.palette.map((c) => c.id) })!;
    const s = partSurface(head);
    const pos = g.attributes.position;
    const cells = new Uint8Array(atob(head.paint!.data).split('').map((c) => c.charCodeAt(0)));
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      const p: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      expect(colorIdAt(head, s.frame, p, m.palette.map((c) => c.id), cells)).toBe(ids[i]);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
    expect(new Set(ids).size).toBe(4); // every color shows somewhere
  });

  it('a mesh part reads the nearest vertex label', () => {
    const head = byId(teddy()).head;
    const s = partSurface(head);
    expect(colorIdAt(head, s.frame, [0, 0, 1], ['a', 'b', 'c'], null, 1)).toBe('b');
    expect(colorIdAt(head, s.frame, [0, 0, 1], ['a', 'b', 'c'], null, NO_LABEL)).toBe(head.color);
  });
});

describe('brush', () => {
  it('every cell has a finite surface point on the part (within its frame)', () => {
    for (const part of (everyType as unknown as CrochetModelV1).parts) {
      if (part.type === 'mesh') continue;
      const s = partSurface(part);
      const pts = cellPoints(s);
      expect(pts).toHaveLength(4096 * 3);
      for (let i = 0; i < pts.length; i++) expect(Number.isFinite(pts[i])).toBe(true);
      // Surface points are on the surface (|sdf| small) wherever the ray hit something.
      const f = localSdf(part);
      let onSurface = 0;
      for (let c = 0; c < 4096; c += 37) if (Math.abs(f(pts[c * 3], pts[c * 3 + 1], pts[c * 3 + 2])) < 0.02) onSurface++;
      expect(onSurface).toBeGreaterThan(0);
    }
  });

  it('a stroke covers consecutive rows and columns around the click (no every-other-row gaps)', () => {
    const head = byId(teddy()).head;
    const s = partSurface(head);
    const front = pointAtAngles(s, 0, 0);
    const cells = brushCells(s, front, 0.6);
    const rows = new Set(cells.map((c) => Math.floor(c / 64)));
    const sorted = [...rows].sort((a, b) => a - b);
    expect(sorted.length).toBeGreaterThan(4);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBe(1);
    expect(cells).toContain(cellAt(s.frame, front));
    // The clicked cell is near the front (column 32 = azimuth 0).
    expect(cellAt(s.frame, front) % 64).toBeGreaterThanOrEqual(31);
    // A tiny brush still paints the cell under the pointer.
    expect(brushCells(s, front, 0.001)).toEqual([cellAt(s.frame, front)]);
  });

  it('paintInto returns the same array when nothing changes and a copy otherwise', () => {
    const c = new Uint8Array(4096).fill(NO_LABEL);
    expect(paintInto(c, [], 1)).toBe(c);
    const d = paintInto(c, [5, 6, 9999, -1], 1);
    expect(d).not.toBe(c);
    expect(c[5]).toBe(NO_LABEL);
    expect([d[5], d[6]]).toEqual([1, 1]);
    expect(paintInto(d, [5, 6], 1)).toBe(d);
  });

  it('mesh brush: vertices within the radius, else the nearest; labels copied, never mutated', () => {
    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]), indices: new Uint32Array([0, 1, 2]), labels: new Uint8Array([NO_LABEL, NO_LABEL, NO_LABEL, NO_LABEL]) };
    expect(brushVertices(mesh, [0, 0, 0], 1.01).sort()).toEqual([0, 1, 2]);
    expect(brushVertices(mesh, [4.9, 5, 5], 0.01)).toEqual([3]);
    const painted = paintVertices(mesh, [0, 3], 2);
    expect(Array.from(painted.labels)).toEqual([2, NO_LABEL, NO_LABEL, 2]);
    expect(Array.from(mesh.labels)).toEqual([NO_LABEL, NO_LABEL, NO_LABEL, NO_LABEL]);
    expect(paintVertices(painted, [0], 2)).toBe(painted);
  });
});

describe('frames and points', () => {
  it('the frame is the geometry box; coordinates follow §2.11.1', () => {
    const f = paintFrameOf([-1, 0, -2, 1, 4, 2]);
    expect(f).toMatchObject({ min: [-1, 0, -2], max: [1, 4, 2], ctr: [0, 2, 0], H: 4 });
    expect(surfaceCoords(f, [0, 1, 1])).toEqual({ azimuthDeg: 0, t: 0.25 });
    expect(surfaceCoords(f, [1, 3, 0]).azimuthDeg).toBe(90);
    expect(cellAt(f, [0, 1, 1])).toBe(uv64Cell(0, 0.25));
    expect(paintFrameOf([]).H).toBeGreaterThan(0);
  });

  it('pointAtHeight / pointAtAngles land on the surface', () => {
    const head = byId(teddy()).head as Extract<Part, { type: 'ellipsoid' }>;
    const s = partSurface(head);
    const p = pointAtAngles(s, 0, 0);
    expect(p[2]).toBeCloseTo(head.dims.rz, 2);
    const q = pointAtHeight(s, 90, 0.5);
    expect(q[0]).toBeCloseTo(head.dims.rx, 2);
  });
});

describe('on-model guides and handles', () => {
  it('outlines are finite polylines for every region kind', () => {
    const m = painted();
    const head = byId(m).head;
    const s = partSurface(head);
    for (const r of head.regions!) {
      const lines = regionOutline(s, r, 32);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) for (const p of l) expect(p.every(Number.isFinite)).toBe(true);
      for (const h of regionHandles(s, r)) expect(h.at.every(Number.isFinite)).toBe(true);
    }
  });

  it('dragging handles moves from / to, a patch center and edge, a spot center and radius', () => {
    const head = byId(teddy()).head;
    const s = partSurface(head);
    const band = { kind: 'band' as const, from: 0.2, to: 0.4, color: 'x' };
    expect(dragRegion(s, band, 'to', pointAtHeight(s, 0, 0.8)).to).toBeCloseTo(0.8, 2);
    // `from` cannot pass `to`.
    expect(dragRegion(s, band, 'from', pointAtHeight(s, 0, 0.9)).from).toBe(0.4);
    const patch = { kind: 'patch' as const, azimuthDeg: 0, spanDeg: 60, from: 0.4, to: 0.6, color: 'x' };
    const moved = dragRegion(s, patch, 'center', pointAtHeight(s, 90, 0.7));
    expect(moved.azimuthDeg).toBeCloseTo(90, 0);
    expect(moved.to - moved.from).toBeCloseTo(0.2, 6);
    expect((moved.from + moved.to) / 2).toBeCloseTo(0.7, 2);
    expect(dragRegion(s, patch, 'edge', pointAtHeight(s, 50, 0.5)).spanDeg).toBeCloseTo(100, 0);
    const spot = { kind: 'spot' as const, azimuthDeg: 0, elevationDeg: 0, radiusIn: 0.3, color: 'x' };
    const c = dragRegion(s, spot, 'center', pointAtAngles(s, -60, 20));
    expect(c.azimuthDeg).toBeCloseTo(-60, 0);
    expect(c.elevationDeg).toBeCloseTo(20, 0);
    const rim = regionHandles(s, { ...spot, radiusIn: 0.5 }).find((h) => h.handle === 'radius')!.at;
    expect(dragRegion(s, spot, 'radius', rim).radiusIn).toBeCloseTo(0.5, 1);
  });
});
