import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { normalize } from '../../kernel/vec';
import { subtreeIds } from '../attach';
import { flatBevelSize } from '../builder';
import {
  anchorPoint,
  captureAnchor,
  DEFAULT_OVERLAP_IN,
  overlapAlongRay,
  placeChildOnSurface,
  placeChildOnSurfaceWith,
  reanchorChildren,
  surfaceExit,
} from '../place';
import { scaleMesh, scalePartDims } from '../scale';
import { partSdf, surfaceGap } from '../sdf';
import { boundsSize, localBounds, partAxis, partCenter, worldToLocal } from '../transforms';
import { readEveryType, readEveryTypeMeshes } from './helpers/everyType';
import { modelOf, part, rayHits, samplePrimitives, worldMesh } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

const DIRECTIONS: Record<string, Vec3> = {
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [1, 0, 0],
  right: [-1, 0, 0],
  'top-left': [1, 1, 0],
  'front-bottom': [0, -1, 1],
  'back-top-right': [-1, 1, -1],
};

/**
 * The overlap along a ray, measured on the builder meshes (independent of the SDFs): how far the child's
 * nearest surface point on the ray lies inside the parent's outermost one.
 */
function meshOverlap(parent: Part, child: Part, origin: Vec3, dir: Vec3): number {
  const out = rayHits(worldMesh(parent), origin, dir, 1e-7);
  const hits = rayHits(worldMesh(child), origin, dir, 1e-7);
  if (out.length === 0 || hits.length === 0) return Number.NaN;
  return out[out.length - 1] - hits[0];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

describe('placeChildOnSurface with { dir } (§3.3 step 3)', () => {
  // Every parent type, unrotated and rotated. The mesh measurement is as fine as the tessellation: 0.012 in for
  // these sizes; a flat parent's mesh is grown by the builder bevel, which the SDFs ignore (§3.7.6).
  const parents: Part[] = [];
  for (const p of samplePrimitives()) {
    parents.push({ ...p, id: `${p.type}_plain`, position: [0.5, 2, -1] });
    parents.push({ ...p, id: `${p.type}_turned`, position: [0.5, 2, -1], rotationDeg: [35, -20, 60] });
  }
  const child = part('sphere', { r: 0.4 }, { id: 'child', position: [9, 9, 9] });

  it.each(parents.map((p) => [p.id, p] as const))('puts the child 0.10 in into the surface of a %s parent, along every direction', (_id, parent) => {
    const c = partCenter(parent);
    const tolerance = parent.type === 'flat' ? flatBevelSize(parent.dims) * Math.SQRT2 + 0.012 : 0.012;
    let measured = 0;
    // A torus is only hit by rays near its ring plane: use directions in that plane (and two that miss).
    const directions: Record<string, Vec3> =
      parent.type === 'torus'
        ? {
            'ring +x': partAxis(parent, 0),
            'ring +y': partAxis(parent, 1),
            'ring diagonal': normalize(sub(partAxis(parent, 0), partAxis(parent, 1))),
            'ring axis': partAxis(parent, 2),
            top: [0, 1, 0],
          }
        : DIRECTIONS;
    for (const [name, raw] of Object.entries(directions)) {
      const dir = normalize(raw);
      const placed = placeChildOnSurface(parent, child, { dir: raw });
      // the child's center is on the ray from the parent's center
      const offset = sub(partCenter(placed), c);
      expect(len(cross(offset, dir)), `${name}: on the ray`).toBeLessThan(1e-5);
      expect(offset[0] * dir[0] + offset[1] * dir[1] + offset[2] * dir[2], `${name}: ahead of the center`).toBeGreaterThan(0);
      // by the kernel's own measure the overlap is exact …
      const exact = overlapAlongRay(parent, placed);
      if (surfaceExit(parent, c, dir) !== null) expect(exact, `${name}: overlapAlongRay`).toBeCloseTo(DEFAULT_OVERLAP_IN, 4);
      // … and on the builder meshes it is 0.10 in within the tessellation
      const onMesh = meshOverlap(parent, placed, c, dir);
      if (Number.isNaN(onMesh)) continue; // the ray runs through the hole of the torus: nothing to measure
      measured++;
      expect(Math.abs(onMesh - 0.1), `${name}: measured on the meshes ${onMesh}`).toBeLessThanOrEqual(tolerance);
      // the child really enters the parent, and not by much
      expect(surfaceGap(placed, parent)).toBeLessThan(0);
    }
    expect(measured).toBeGreaterThanOrEqual(parent.type === 'torus' ? 3 : 9);
  });

  it('works for every child type: the child’s own extent along the ray is what counts', () => {
    const parent = part('sphere', { r: 2 }, { id: 'body', position: [0, 2, 0] });
    for (const base of samplePrimitives()) {
      for (const rotationDeg of [undefined, [35, -20, 60] as Vec3]) {
        const c: Part = { ...base, id: 'child', rotationDeg };
        for (const raw of [DIRECTIONS.top, DIRECTIONS.left, DIRECTIONS['back-top-right']]) {
          const dir = normalize(raw);
          const placed = placeChildOnSurface(parent, c, { dir });
          expect(overlapAlongRay(parent, placed), `${base.type}`).toBeCloseTo(0.1, 4);
          const tolerance = base.type === 'flat' ? flatBevelSize(base.dims) * Math.SQRT2 + 0.012 : 0.012;
          const onMesh = meshOverlap(parent, placed, partCenter(parent), dir);
          if (!Number.isNaN(onMesh)) expect(Math.abs(onMesh - 0.1), `${base.type} ${String(rotationDeg)}`).toBeLessThanOrEqual(tolerance);
          // rotation and dims are kept; only the position changes
          expect(placed.rotationDeg).toEqual(c.rotationDeg);
          expect(placed.dims).toBe(c.dims);
          expect(placed.id).toBe('child');
        }
      }
    }
  });

  it('a lathe child: its CENTER goes on the ray, and position = center − R·c_local (§0.1)', () => {
    const parent = part('sphere', { r: 1 }, { id: 'body', position: [0, 1, 0] });
    const lathe = part('lathe', { profile: [[0, 0], [0.5, 0.3], [0, 2]] }, { id: 'hat' });
    const top = placeChildOnSurface(parent, lathe, { dir: [0, 1, 0] });
    // the hat's base (profile y = 0) is 0.1 below the top of the body: its position is that base point
    expect(top.position).toEqual([0, 1.9, 0]);
    expect(partCenter(top)).toEqual([0, 2.9, 0]);
    const side = placeChildOnSurface(parent, lathe, { dir: [1, 0, 0] });
    expect(partCenter(side)[1]).toBeCloseTo(1, 6); // level with the parent's center
    expect(side.position[1]).toBeCloseTo(0, 6); // its base is one unit below its center
    // a lathe parent: the ray starts at its center, not at its position
    const body = part('lathe', { profile: [[0, 0], [1, 1], [0, 2]] }, { id: 'body', position: [3, 5, 0] });
    const ball = placeChildOnSurface(body, part('sphere', { r: 0.5 }, { id: 'ball' }), { dir: [1, 0, 0] });
    expect(ball.position).toEqual([3 + 1 + 0.5 - 0.1, 6, 0]);
  });

  it('overlapIn: default 0.10, any other depth, zero, and a negative value for a gap', () => {
    const parent = part('sphere', { r: 1 }, { id: 'body' });
    const c = part('sphere', { r: 0.5 }, { id: 'c' });
    expect(DEFAULT_OVERLAP_IN).toBe(0.1);
    expect(placeChildOnSurface(parent, c, { dir: [0, 1, 0] }).position).toEqual([0, 1.4, 0]);
    expect(placeChildOnSurface(parent, c, { dir: [0, 1, 0] }, 0.3).position).toEqual([0, 1.2, 0]);
    expect(placeChildOnSurface(parent, c, { dir: [0, 1, 0] }, 0).position).toEqual([0, 1.5, 0]);
    expect(placeChildOnSurface(parent, c, { dir: [0, 1, 0] }, -0.25).position).toEqual([0, 1.75, 0]);
    expect(placeChildOnSurface(parent, c, { dir: [0, 1, 0] }, Number.NaN).position).toEqual([0, 1.4, 0]);
    expect(surfaceGap(placeChildOnSurface(parent, c, { dir: [1, 2, 3] }, -0.25), parent)).toBeCloseTo(0.25, 2);
    // the direction is normalized; a zero direction falls back to +Y
    expect(placeChildOnSurface(parent, c, { dir: [0, 7, 0] }).position).toEqual([0, 1.4, 0]);
    expect(placeChildOnSurface(parent, c, { dir: [0, 0, 0] }).position).toEqual([0, 1.4, 0]);
    const diagonal = placeChildOnSurface(parent, c, { dir: [1, 1, 0] }).position;
    expect(diagonal[0]).toBeCloseTo(1.4 * Math.SQRT1_2, 6);
    expect(diagonal[1]).toBeCloseTo(1.4 * Math.SQRT1_2, 6);
  });

  it('rounds the position to 1e-6 and does not modify its arguments', () => {
    const parent = part('ellipsoid', { rx: 2.1, ry: 2.6, rz: 1.9 }, { id: 'body', position: [0, 2.678905, 0] });
    const c = part('capsule', { r: 0.55, length: 3 }, { id: 'arm', rotationDeg: [-28, 0, 22] });
    const snapshot = JSON.stringify([parent, c]);
    const placed = placeChildOnSurface(parent, c, { dir: [1, 0.3, 0.2] });
    expect(JSON.stringify([parent, c])).toBe(snapshot);
    for (const v of placed.position) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
    expect(placeChildOnSurface(parent, c, { dir: [1, 0.3, 0.2] })).toEqual(placed); // deterministic
  });

  it('a ray that misses the parent (through a torus) starts from the parent’s center', () => {
    const ring = part('torus', { R: 2, r: 0.3 }, { id: 'ring', position: [0, 5, 0] });
    const c = part('sphere', { r: 0.5 }, { id: 'c' });
    expect(surfaceExit(ring, partCenter(ring), [0, 0, 1])).toBeNull();
    const placed = placeChildOnSurface(ring, c, { dir: [0, 0, 1] });
    expect(placed.position).toEqual([0, 5, 0.4]);
    // in the ring's own plane the outermost surface is the far side of the tube
    expect(placeChildOnSurface(ring, c, { dir: [1, 0, 0] }).position).toEqual([2.7, 5, 0]);
  });

  it('a mesh part uses o.meshSdf (part-local); without it, the ellipsoid inscribed in bboxIn', () => {
    const blob = part('mesh', { meshRef: 'm', bboxIn: [2, 2, 2] }, { id: 'blob', position: [0, 1, 0] });
    const c = part('sphere', { r: 0.5 }, { id: 'c' });
    // fallback: a unit sphere
    expect(placeChildOnSurface(blob, c, { dir: [1, 1, 0] }).position[0]).toBeCloseTo(1.4 * Math.SQRT1_2, 5);
    // its real shape: a cube, whose corner is farther out on the diagonal
    const cube = (q: Vec3): number => 1 - Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
    const onCube = placeChildOnSurface(blob, c, { dir: [1, 1, 0] }, 0.1, { meshSdf: cube });
    expect(onCube.position[0]).toBeCloseTo(1 + (0.5 - 0.1) * Math.SQRT1_2, 3);
    // a mesh child on a primitive parent: meshSdf is the child's
    const body = part('sphere', { r: 1 }, { id: 'body' });
    const smallCube = (q: Vec3): number => 0.5 - Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
    const child = part('mesh', { meshRef: 'k', bboxIn: [1, 1, 1] }, { id: 'kid' });
    expect(placeChildOnSurface(body, child, { dir: [0, 1, 0] }, 0.1, { meshSdf: smallCube }).position).toEqual([0, 1.4, 0]);
    expect(placeChildOnSurface(body, { ...child, rotationDeg: [0, 0, 45] }, { dir: [0, 1, 0] }, 0.1, { meshSdf: smallCube }).position[1]).toBeCloseTo(
      1 + Math.SQRT1_2 - 0.1,
      4,
    );
  });

  it('placeChildOnSurfaceWith casts rays on the triangles of a mesh part', () => {
    const model = readEveryType();
    const meshes = readEveryTypeMeshes();
    const blob = model.parts.find((p) => p.type === 'mesh') as Extract<Part, { type: 'mesh' }>;
    const c = part('sphere', { r: 0.2 }, { id: 'c' });
    for (const raw of [DIRECTIONS.top, DIRECTIONS.left, DIRECTIONS.front, DIRECTIONS['top-left']]) {
      const dir = normalize(raw);
      const placed = placeChildOnSurfaceWith(blob, c, { dir }, 0.1, { meshes });
      const exit = surfaceExit(blob, partCenter(blob), dir, { meshes });
      expect(exit).not.toBeNull();
      const distance = len(sub(partCenter(placed), partCenter(blob)));
      expect(distance).toBeCloseTo((exit as number) + 0.2 - 0.1, 5);
      expect(overlapAlongRay(blob, placed, { meshes })).toBeCloseTo(0.1, 5);
    }
    // the mesh (a coarse UV ellipsoid) reaches exactly its bounding box along the axes
    expect(surfaceExit(blob, partCenter(blob), [1, 0, 0], { meshes })).toBeCloseTo(blob.dims.bboxIn[0] / 2, 5);
    expect(surfaceExit(blob, partCenter(blob), [0, 1, 0], { meshes })).toBeCloseTo(blob.dims.bboxIn[1] / 2, 5);
  });
});

describe('placeChildOnSurface with { hit, normal } (the editor’s Add part, §4.2)', () => {
  it('puts the child 0.10 in into the clicked point, along the clicked normal', () => {
    const parent = part('box', { w: 2, h: 2, d: 2 }, { id: 'body' });
    const ball = part('sphere', { r: 0.5 }, { id: 'c' });
    expect(placeChildOnSurface(parent, ball, { hit: [0.3, 1, -0.2], normal: [0, 1, 0] }).position).toEqual([0.3, 1.4, -0.2]);
    expect(placeChildOnSurface(parent, ball, { hit: [1, 0.5, 0.5], normal: [3, 0, 0] }).position).toEqual([1.4, 0.5, 0.5]);
    expect(placeChildOnSurface(parent, ball, { hit: [0.3, 1, -0.2], normal: [0, 1, 0] }, 0.25).position).toEqual([0.3, 1.25, -0.2]);
    // a capsule standing on the surface: half its length above the point, minus the overlap
    const capsule = part('capsule', { r: 0.2, length: 1.2 }, { id: 'c' });
    expect(placeChildOnSurface(parent, capsule, { hit: [0, 1, 0], normal: [0, 1, 0] }).position).toEqual([0, 1.5, 0]);
    // lying down, it is its radius that counts
    expect(placeChildOnSurface(parent, { ...capsule, rotationDeg: [0, 0, 90] }, { hit: [0, 1, 0], normal: [0, 1, 0] }).position).toEqual([0, 1.1, 0]);
    // a lathe child: its base goes 0.1 below the surface
    const cone = part('lathe', { profile: [[0.4, 0], [0.2, 0.5], [0, 1]] }, { id: 'c' });
    expect(placeChildOnSurface(parent, cone, { hit: [0, 1, 0], normal: [0, 1, 0] }).position).toEqual([0, 0.9, 0]);
  });

  it('needs nothing from the parent but the click: every parent type, sloped normals included', () => {
    const ball = part('sphere', { r: 0.3 }, { id: 'c' });
    for (const p of samplePrimitives()) {
      const parent = { ...p, position: [1, 2, 3] as Vec3, rotationDeg: [20, 40, -30] as Vec3 };
      const dir = normalize([0.3, 0.8, 0.5]);
      const t = surfaceExit(parent, partCenter(parent), dir);
      if (t === null) continue;
      const c = partCenter(parent);
      const hit: Vec3 = [c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t];
      expect(Math.abs(partSdf(parent)(hit)), p.type).toBeLessThan(1e-6); // the hit is on the surface
      const placed = placeChildOnSurface(parent, ball, { hit, normal: dir });
      const expected: Vec3 = [hit[0] + dir[0] * 0.2, hit[1] + dir[1] * 0.2, hit[2] + dir[2] * 0.2];
      for (let k = 0; k < 3; k++) expect(placed.position[k]).toBeCloseTo(expected[k], 5);
    }
  });
});

describe('surfaceExit and overlapAlongRay', () => {
  it('surfaceExit is the distance to the outermost surface point on a ray', () => {
    const ball = part('sphere', { r: 2 }, { position: [1, 1, 1] });
    expect(surfaceExit(ball, [1, 1, 1], [0, 0, 5])).toBeCloseTo(2, 6);
    expect(surfaceExit(ball, [1, 1, -4], [0, 0, 1])).toBeCloseTo(7, 6); // from outside: the far side
    expect(surfaceExit(ball, [1, 1, -4], [0, 0, -1])).toBeNull(); // pointing away
    expect(surfaceExit(ball, [1, 4, -4], [0, 0, 1])).toBeNull(); // passing by
    const ring = part('torus', { R: 2, r: 0.5 });
    expect(surfaceExit(ring, [0, 0, 0], [1, 0, 0])).toBeCloseTo(2.5, 6);
    expect(surfaceExit(ring, [0, 0, 0], [0, 1, 0])).toBeCloseTo(2.5, 6);
    expect(surfaceExit(ring, [0, 0, 0], [0, 0, 1])).toBeNull();
    // a concave lathe (an hourglass): the outermost crossing, not the first. Going straight up at radius 0.6 the
    // ray leaves the lower bulb at y = 0.6, enters the upper one at y = 1.4 and leaves it for good at y = 1.88.
    const hourglass = part('lathe', { profile: [[0, 0], [1, 0.2], [0.2, 1], [1, 1.8], [0, 2]] });
    expect(surfaceExit(hourglass, [0.6, 0.4, 0], [0, 1, 0])).toBeCloseTo(1.48, 6);
    expect(surfaceExit(hourglass, [0, 1, 0], [0.8, 0.6, 0])).toBeCloseTo(1, 6); // out through the upper slope, at radius 0.8
  });

  it('overlapAlongRay is what placeChildOnSurface sets, and a gap is negative', () => {
    const body = part('ellipsoid', { rx: 2.1, ry: 2.6, rz: 1.9 }, { id: 'body', position: [0, 2.6, 0] });
    const head = part('ellipsoid', { rx: 2.4, ry: 2.15, rz: 2.2 }, { id: 'head', position: [0, 7.2, 0.1] });
    // the teddy's head sits 0.15 in into its body (5.2 − 5.05), measured along the slightly tilted ray
    expect(overlapAlongRay(body, head)).toBeCloseTo(0.149, 2);
    expect(overlapAlongRay(body, { ...head, position: [0, 8, 0] })).toBeCloseTo(-0.65, 2);
    for (const overlap of [0.05, 0.1, 0.4, -0.3]) {
      const placed = placeChildOnSurface(body, head, { dir: [0.2, 1, 0.1] }, overlap);
      expect(overlapAlongRay(body, placed)).toBeCloseTo(overlap, 4);
    }
  });
});

describe('re-anchoring children (§4.2)', () => {
  const teddy = buildCanonicalTeddy().model;
  const by = (m: CrochetModelV1): Record<string, Part> => Object.fromEntries(m.parts.map((p) => [p.id, p]));
  const scaledHead = (k: number): CrochetModelV1 => ({ ...teddy, parts: teddy.parts.map((p) => (p.id === 'head' ? scalePartDims(p, k) : p)) });

  /** The direction of a point from a part's center, in that part's frame, as [azimuth, elevation] in degrees. */
  const direction = (parent: Part, p: Vec3): [number, number] => {
    const c = worldToLocal(parent, partCenter(parent));
    const q = worldToLocal(parent, p);
    const d = normalize(sub(q, c));
    return [(Math.atan2(d[0], d[2]) * 180) / Math.PI, (Math.asin(d[1]) * 180) / Math.PI];
  };

  it('captureAnchor: a direction from the parent’s center in the parent’s frame, and a signed offset along the normal', () => {
    const t = by(teddy);
    const ear = captureAnchor(t.head, t.ear_l);
    // the ear sits up and to the toy's left (+X = azimuth +90°), partly buried: its contact point is inside the head
    expect(ear.azimuthDeg).toBeGreaterThan(80);
    expect(ear.azimuthDeg).toBeLessThan(100);
    expect(ear.elevationDeg).toBeGreaterThan(30);
    expect(ear.elevationDeg).toBeLessThan(60);
    expect(ear.offsetIn).toBeLessThan(0);
    expect(ear.offsetIn).toBeGreaterThan(-0.6);
    expect(partSdf(t.head)(ear.point)).toBeGreaterThan(0);
    // mirror twins have mirrored anchors
    const right = captureAnchor(t.head, t.ear_r);
    expect(right.azimuthDeg).toBeCloseTo(-ear.azimuthDeg, 6);
    expect(right.elevationDeg).toBeCloseTo(ear.elevationDeg, 6);
    expect(right.offsetIn).toBeCloseTo(ear.offsetIn, 6);
    expect(right.point[0]).toBeCloseTo(-ear.point[0], 6);
    // a centered child has a centered anchor: straight ahead, slightly down
    const muzzle = captureAnchor(t.head, t.muzzle);
    expect(muzzle.azimuthDeg).toBeCloseTo(0, 6);
    expect(muzzle.point[0]).toBeCloseTo(0, 9);
    expect(muzzle.elevationDeg).toBeLessThan(0);
    // the anchor is in the PARENT's frame: turning the whole pair about Y turns nothing in it
    const leg = captureAnchor(t.leg_l, t.foot_pad_l);
    expect(leg.elevationDeg).toBeGreaterThan(85); // the pad is on the leg's +Y end, whatever the leg's rotation
  });

  it('anchorPoint on the unchanged parent is the captured point, exactly', () => {
    const t = by(teddy);
    for (const [parent, child] of [['head', 'ear_l'], ['head', 'muzzle'], ['body', 'arm_l'], ['leg_l', 'foot_pad_l'], ['body', 'tail']]) {
      const anchor = captureAnchor(t[parent], t[child]);
      expect(anchorPoint(t[parent], anchor)).toEqual(anchor.point);
    }
  });

  it('a child that does not touch its parent keeps its distance', () => {
    const parent = part('sphere', { r: 1 }, { id: 'body' });
    const floating = part('sphere', { r: 0.3 }, { id: 'kite', position: [0, 2, 0], attach: { to: 'body' } });
    const anchor = captureAnchor(parent, floating);
    expect(anchor.elevationDeg).toBeCloseTo(90, 6);
    expect(anchor.offsetIn).toBeGreaterThan(0.7); // its lowest point is 0.7 above the surface; the contact
    expect(anchor.offsetIn).toBeLessThan(0.74); // point is the middle of its lowest layer
    const after = reanchorChildren(modelOf([parent, floating]), modelOf([scalePartDims(parent, 2), floating]), 'body');
    expect(after.parts[1].position[1]).toBeCloseTo(3, 3);
    expect(surfaceGap(after.parts[1], after.parts[0])).toBeCloseTo(0.7, 2);
  });

  it('T6 golden (§4.2): scaling the teddy head 1.2× keeps each ear’s gap to the head ≤ 0.1 in and its (az, el) within 1°', () => {
    const after = reanchorChildren(teddy, scaledHead(1.2), 'head');
    const a = by(after);
    const b = by(teddy);
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'eye_l', 'eye_r']) {
      expect(surfaceGap(a[id], a.head), id).toBeLessThanOrEqual(0.1);
      const before = captureAnchor(b.head, b[id]);
      const now = captureAnchor(a.head, a[id]);
      expect(Math.abs(now.azimuthDeg - before.azimuthDeg), `${id} azimuth`).toBeLessThan(1);
      expect(Math.abs(now.elevationDeg - before.elevationDeg), `${id} elevation`).toBeLessThan(1);
      // the child still enters the head about as deep as before
      expect(Math.abs(surfaceGap(a[id], a.head) - surfaceGap(b[id], b.head)), id).toBeLessThan(0.08);
      // children keep their rotation and size
      expect(a[id].rotationDeg).toEqual(b[id].rotationDeg);
      expect(a[id].dims).toEqual(b[id].dims);
    }
    // the ears moved outward, along their direction from the head's center
    const [az, el] = direction(a.head, partCenter(a.ear_l));
    const [az0, el0] = direction(b.head, partCenter(b.ear_l));
    expect(Math.abs(az - az0)).toBeLessThan(2);
    expect(Math.abs(el - el0)).toBeLessThan(2);
    expect(len(sub(a.ear_l.position, a.head.position))).toBeGreaterThan(len(sub(b.ear_l.position, b.head.position)) + 0.2);
    // mirrored
    expect(a.ear_r.position).toEqual([-a.ear_l.position[0], a.ear_l.position[1], a.ear_l.position[2]]);
  });

  it('moves the whole attach subtree of each child by the anchor’s displacement, and nothing else', () => {
    const after = reanchorChildren(teddy, scaledHead(1.2), 'head');
    const a = by(after);
    const b = by(teddy);
    const moved = (id: string): Vec3 => sub(a[id].position, b[id].position);
    for (const [child, grandchild] of [['ear_l', 'ear_l_inner'], ['ear_r', 'ear_r_inner'], ['muzzle', 'nose']]) {
      const d = moved(child);
      const g = moved(grandchild);
      expect(len(d)).toBeGreaterThan(0.1);
      for (let k = 0; k < 3; k++) expect(g[k]).toBeCloseTo(d[k], 5);
    }
    const subtree = new Set(subtreeIds(teddy, 'head'));
    for (const p of teddy.parts) {
      if (!subtree.has(p.id)) expect(a[p.id]).toBe(p); // body, arms, legs, tail: untouched (§4.4)
    }
    expect(a.head).toEqual(scalePartDims(b.head, 1.2)); // the parent itself is the caller's edit
    for (const p of after.parts) for (const v of p.position) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
  });

  it('an unchanged parent moves nothing; a moved parent takes its children along', () => {
    expect(reanchorChildren(teddy, teddy, 'head')).toBe(teddy);
    expect(reanchorChildren(teddy, teddy, 'nobody')).toBe(teddy);
    expect(reanchorChildren(teddy, teddy, 'tail')).toBe(teddy); // no children
    const shifted: CrochetModelV1 = { ...teddy, parts: teddy.parts.map((p) => (p.id === 'head' ? { ...p, position: [0.5, p.position[1] + 1, p.position[2]] } : p)) };
    const after = by(reanchorChildren(teddy, shifted, 'head'));
    const before = by(teddy);
    for (const id of subtreeIds(teddy, 'head').slice(1)) {
      expect(after[id].position[0]).toBeCloseTo(before[id].position[0] + 0.5, 5);
      expect(after[id].position[1]).toBeCloseTo(before[id].position[1] + 1, 5);
      expect(after[id].position[2]).toBeCloseTo(before[id].position[2], 5);
    }
  });

  it('a parent that changes shape: children stay on its new surface, at the same direction', () => {
    // the body gets wider (rx only): the arms move out in x, the head and tail (on the Y and Z sides) barely move
    const wider: CrochetModelV1 = {
      ...teddy,
      parts: teddy.parts.map((p) => (p.id === 'body' && p.type === 'ellipsoid' ? { ...p, dims: { ...p.dims, rx: p.dims.rx * 1.5 } } : p)),
    };
    const a = by(reanchorChildren(teddy, wider, 'body'));
    const b = by(teddy);
    expect(a.arm_l.position[0] - b.arm_l.position[0]).toBeGreaterThan(0.5);
    expect(a.arm_r.position[0]).toBeCloseTo(-a.arm_l.position[0], 6);
    expect(Math.abs(a.head.position[1] - b.head.position[1])).toBeLessThan(0.02);
    expect(len(sub(a.tail.position, b.tail.position))).toBeLessThan(0.02);
    // every child still enters the body (rigid children on a surface whose curvature changed: the depth of the
    // deepest vertex shifts a little, the contact point's offset does not)
    for (const id of ['arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail', 'head']) {
      expect(surfaceGap(a[id], a.body), id).toBeLessThan(0);
      expect(Math.abs(surfaceGap(a[id], a.body) - surfaceGap(b[id], b.body)), id).toBeLessThan(0.25);
    }
    // the head's own children came along with it
    for (let k = 0; k < 3; k++) expect(a.muzzle.position[k] - b.muzzle.position[k]).toBeCloseTo(a.head.position[k] - b.head.position[k], 5);
  });

  it('a mesh parent known by its triangles: children follow its scaled surface', () => {
    const model = readEveryType();
    const meshes = readEveryTypeMeshes();
    const blob = model.parts.find((p) => p.type === 'mesh') as Extract<Part, { type: 'mesh' }>;
    const pin = placeChildOnSurfaceWith(blob, part('sphere', { r: 0.1 }, { id: 'pin', attach: { to: blob.id } }), { dir: [0, 1, 0] }, 0.05, { meshes });
    const before = modelOf([blob, pin]);
    const bigger = modelOf([scalePartDims(blob, 2), pin]);
    const biggerMeshes = { [blob.dims.meshRef]: scaleMesh(meshes[blob.dims.meshRef], 2) };
    const after = reanchorChildren(before, bigger, blob.id, { before: { meshes }, after: { meshes: biggerMeshes } });
    expect(after.parts[1].position[1] - pin.position[1]).toBeCloseTo(blob.dims.bboxIn[1] / 2, 4); // the top moved up by half the height
    expect(overlapAlongRay(bigger.parts[0], after.parts[1], { meshes: biggerMeshes })).toBeCloseTo(0.05, 3);
    expect(boundsSize(localBounds(bigger.parts[0], biggerMeshes[blob.dims.meshRef]))[1]).toBeCloseTo(blob.dims.bboxIn[1] * 2, 5);
  });
});
