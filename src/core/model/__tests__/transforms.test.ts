import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Part, Vec3 } from '../../../types/model';
import { mulberry32, randomRange } from '../../kernel/prng';
import { det3, type Mat3, mulMat3, mulMat3Vec, transpose3 } from '../../kernel/vec';
import {
  applyRigid,
  boundsCenter,
  boundsSize,
  composeMat4,
  composeRigid,
  decomposeMat4,
  decomposeRigid,
  eulerXYZToMat3,
  groundCenter,
  groundModel,
  invertRigid,
  localBounds,
  localCenter,
  localToWorld,
  mat3ToEulerXYZ,
  modelBounds,
  modelHeight,
  multiplyMat4,
  multiplyRigid,
  partAxis,
  partCenter,
  partTransform,
  positionForCenter,
  rigidFromMat4,
  roundCoord,
  roundModel,
  roundVec3,
  translatePart,
  unionBounds,
  worldBounds,
  worldToLocal,
} from '../transforms';
import { readEveryType, readEveryTypeMeshes } from './helpers/everyType';
import { localMesh, meshBounds, modelOf, part, samplePrimitives, worldMesh } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

/** The upper-left 3×3 of a three.js Matrix4 (column-major) as our row-major Mat3. */
function fromThree(m: Matrix4): Mat3 {
  const e = m.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

function threeEuler(deg: Vec3): Matrix4 {
  return new Matrix4().makeRotationFromEuler(new Euler(MathUtils.degToRad(deg[0]), MathUtils.degToRad(deg[1]), MathUtils.degToRad(deg[2]), 'XYZ'));
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-12): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `[${i}] ${a[i]} vs ${b[i]}`).toBeLessThanOrEqual(eps);
}

const GIMBAL: Vec3[] = [
  [0, 90, 0],
  [0, -90, 0],
  [30, 90, 0],
  [30, 90, 45],
  [-120, -90, 70],
  [180, 90, 180],
  [10, 89.99999999, 20],
  [10, -89.99999999, 20],
];

describe('Euler XYZ ↔ matrix (§0.1: three.js order "XYZ", matrix = Rx·Ry·Rz)', () => {
  it('eulerXYZToMat3 equals three.js for random angles, and is a rotation', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const deg: Vec3 = [randomRange(rng, -360, 360), randomRange(rng, -360, 360), randomRange(rng, -360, 360)];
      const m = eulerXYZToMat3(deg);
      expectClose(m, fromThree(threeEuler(deg)), 1e-12);
      expect(det3(m)).toBeCloseTo(1, 12);
      expectClose(mulMat3(m, transpose3(m)), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
    }
  });

  it('is Rx·Ry·Rz: a part rotated [90, 0, 0] has its local +Y along world +Z (a cone pointing forward)', () => {
    expectClose(mulMat3Vec(eulerXYZToMat3([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
    expectClose(mulMat3Vec(eulerXYZToMat3([0, 90, 0]), [0, 0, 1]), [1, 0, 0]);
    expectClose(mulMat3Vec(eulerXYZToMat3([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
    // X is applied last (outermost): Rx(90)·Rz(90) sends +X → +Y → +Z
    expectClose(mulMat3Vec(eulerXYZToMat3([90, 0, 90]), [1, 0, 0]), [0, 0, 1]);
    expect(eulerXYZToMat3(undefined)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(eulerXYZToMat3([0, 0, 0])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('mat3ToEulerXYZ gives the angles three.js gives', () => {
    const rng = mulberry32(12);
    const cases: Vec3[] = [...GIMBAL];
    for (let i = 0; i < 200; i++) cases.push([randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)]);
    for (const deg of cases) {
      const m = eulerXYZToMat3(deg);
      const ours = mat3ToEulerXYZ(m);
      const theirs = new Euler().setFromRotationMatrix(threeEuler(deg), 'XYZ');
      expectClose(ours, [MathUtils.radToDeg(theirs.x), MathUtils.radToDeg(theirs.y), MathUtils.radToDeg(theirs.z)], 1e-9);
    }
  });

  it('round-trips: angles → matrix → angles → matrix is the same rotation, also at gimbal lock', () => {
    const rng = mulberry32(13);
    const cases: Vec3[] = [...GIMBAL];
    for (let i = 0; i < 300; i++) cases.push([randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)]);
    for (const deg of cases) {
      const m = eulerXYZToMat3(deg);
      const back = mat3ToEulerXYZ(m);
      for (const v of back) expect(Number.isFinite(v)).toBe(true);
      expectClose(eulerXYZToMat3(back), m, 1e-9);
      expect(Math.abs(back[1])).toBeLessThanOrEqual(90 + 1e-9);
    }
  });

  it('round-trips the angles themselves when y is inside (−90°, 90°) and x, z inside (−180°, 180°]', () => {
    const rng = mulberry32(14);
    for (let i = 0; i < 300; i++) {
      const deg: Vec3 = [randomRange(rng, -179.9, 179.9), randomRange(rng, -89.9, 89.9), randomRange(rng, -179.9, 179.9)];
      expectClose(mat3ToEulerXYZ(eulerXYZToMat3(deg)), deg, 1e-9);
    }
    expectClose(mat3ToEulerXYZ(eulerXYZToMat3([82, 0, -12])), [82, 0, -12], 1e-12);
    expectClose(mat3ToEulerXYZ(eulerXYZToMat3([0, 0, -28])), [0, 0, -28], 1e-12);
  });

  it('at gimbal lock z is 0 and x carries the whole turn, as in three.js', () => {
    const back = mat3ToEulerXYZ(eulerXYZToMat3([30, 90, 45]));
    expect(back[1]).toBeCloseTo(90, 6);
    expect(back[2]).toBe(0);
    expect(back[0]).toBeCloseTo(75, 6); // x + z fold together at y = +90°
    const down = mat3ToEulerXYZ(eulerXYZToMat3([30, -90, 45]));
    expect(down[1]).toBeCloseTo(-90, 6);
    expect(down[2]).toBe(0);
    expect(down[0]).toBeCloseTo(-15, 6); // x − z at y = −90°
  });
});

describe('rigid transforms: compose / decompose', () => {
  it('composeRigid and decomposeRigid round-trip', () => {
    const rng = mulberry32(21);
    for (let i = 0; i < 100; i++) {
      const position: Vec3 = [randomRange(rng, -10, 10), randomRange(rng, -10, 10), randomRange(rng, -10, 10)];
      const rotationDeg: Vec3 = [randomRange(rng, -179, 179), randomRange(rng, -89, 89), randomRange(rng, -179, 179)];
      const back = decomposeRigid(composeRigid(position, rotationDeg));
      expect(back.position).toEqual(position);
      expectClose(back.rotationDeg, rotationDeg, 1e-9);
    }
    expect(decomposeRigid(composeRigid([1, 2, 3]))).toEqual({ position: [1, 2, 3], rotationDeg: [0, 0, 0] });
  });

  it('multiplyRigid(a, b) applies b first, then a — the nesting of §3.7.3 — and equals three.js matrices', () => {
    const rng = mulberry32(22);
    for (let i = 0; i < 100; i++) {
      const pa: Vec3 = [randomRange(rng, -5, 5), randomRange(rng, -5, 5), randomRange(rng, -5, 5)];
      const ra: Vec3 = [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)];
      const pb: Vec3 = [randomRange(rng, -5, 5), randomRange(rng, -5, 5), randomRange(rng, -5, 5)];
      const rb: Vec3 = [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)];
      const p: Vec3 = [randomRange(rng, -5, 5), randomRange(rng, -5, 5), randomRange(rng, -5, 5)];
      const a = composeRigid(pa, ra);
      const b = composeRigid(pb, rb);
      const world = multiplyRigid(a, b);
      expectClose(applyRigid(world, p), applyRigid(a, applyRigid(b, p)), 1e-11);
      const ma = threeEuler(ra).setPosition(...pa);
      const mb = threeEuler(rb).setPosition(...pb);
      const v = new Vector3(...p).applyMatrix4(ma.clone().multiply(mb));
      expectClose(applyRigid(world, p), [v.x, v.y, v.z], 1e-11);
      // inverse
      expectClose(applyRigid(invertRigid(world), applyRigid(world, p)), p, 1e-11);
    }
  });

  it('a child nested in a rotated parent: the teddy foot pad (§3.7.3 golden)', () => {
    const leg = composeRigid([1.15, 0.78, 1.25], [82, 0, -12]);
    const pad = decomposeRigid(multiplyRigid(leg, composeRigid([0, 1.4, 0], [0, 0, 0])));
    expectClose(pad.position, [1.4411, 0.9706, 2.6061], 1e-4);
    expectClose(pad.rotationDeg, [82, 0, -12], 1e-9);
  });
});

describe('4×4 matrices (column-major, three.js and glTF layout)', () => {
  it('composeMat4 equals Matrix4.compose', () => {
    const rng = mulberry32(31);
    for (let i = 0; i < 100; i++) {
      const position: Vec3 = [randomRange(rng, -5, 5), randomRange(rng, -5, 5), randomRange(rng, -5, 5)];
      const rotationDeg: Vec3 = [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)];
      const scale: Vec3 = [randomRange(rng, 0.2, 3), randomRange(rng, 0.2, 3), randomRange(rng, 0.2, 3)];
      const q = new Quaternion().setFromEuler(new Euler(...(rotationDeg.map(MathUtils.degToRad) as Vec3), 'XYZ'));
      const expected = new Matrix4().compose(new Vector3(...position), q, new Vector3(...scale));
      expectClose(composeMat4(position, rotationDeg, scale), expected.elements, 1e-12);
    }
    expect(composeMat4([1, 2, 3])).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  });

  it('decomposeMat4 round-trips compose, and equals Matrix4.decompose', () => {
    const rng = mulberry32(32);
    for (let i = 0; i < 100; i++) {
      const position: Vec3 = [randomRange(rng, -5, 5), randomRange(rng, -5, 5), randomRange(rng, -5, 5)];
      const rotationDeg: Vec3 = [randomRange(rng, -179, 179), randomRange(rng, -89, 89), randomRange(rng, -179, 179)];
      const scale: Vec3 = [randomRange(rng, 0.2, 3), randomRange(rng, 0.2, 3), randomRange(rng, 0.2, 3)];
      const m = composeMat4(position, rotationDeg, scale);
      const back = decomposeMat4(m);
      expectClose(back.position, position, 1e-12);
      expectClose(back.rotationDeg, rotationDeg, 1e-9);
      expectClose(back.scale, scale, 1e-12);
      expectClose(composeMat4(back.position, back.rotationDeg, back.scale), m, 1e-11);
      const p = new Vector3();
      const q = new Quaternion();
      const s = new Vector3();
      new Matrix4().fromArray(m).decompose(p, q, s);
      const e = new Euler().setFromQuaternion(q, 'XYZ');
      expectClose(back.scale, [s.x, s.y, s.z], 1e-12);
      expectClose(back.rotationDeg, [MathUtils.radToDeg(e.x), MathUtils.radToDeg(e.y), MathUtils.radToDeg(e.z)], 1e-9);
    }
  });

  it('a mirroring matrix gets a negative x scale; a zero scale does not produce NaN', () => {
    const mirrored = decomposeMat4(composeMat4([0, 0, 0], [10, 20, 30], [-2, 1, 1]));
    expect(mirrored.scale[0]).toBeCloseTo(-2, 12);
    expectClose(mirrored.rotationDeg, [10, 20, 30], 1e-9);
    const flat = decomposeMat4(composeMat4([1, 2, 3], [0, 0, 0], [1, 0, 1]));
    expect(flat.scale).toEqual([1, 0, 1]);
    for (const v of flat.rotationDeg) expect(Number.isFinite(v)).toBe(true);
  });

  it('multiplyMat4 equals Matrix4.multiply, and rigidFromMat4 drops the scale', () => {
    const a = composeMat4([1, 2, 3], [10, 20, 30], [1, 1, 1]);
    const b = composeMat4([-2, 0.5, 4], [-40, 5, 100], [2, 2, 2]);
    const expected = new Matrix4().fromArray(a).multiply(new Matrix4().fromArray(b));
    expectClose(multiplyMat4(a, b), expected.elements, 1e-12);
    const rigid = rigidFromMat4(b);
    expectClose(rigid.position, [-2, 0.5, 4]);
    expectClose(rigid.rotation, eulerXYZToMat3([-40, 5, 100]), 1e-12);
    // glTF node.matrix of the fixture is a pure rotation + translation: the teddy leg
    expectClose(decomposeMat4(composeMat4([1.15, 0.78, 1.25], [82, 0, -12])).rotationDeg, [82, 0, -12], 1e-9);
  });
});

describe('part frames', () => {
  const p = part('capsule', { r: 0.5, length: 3 }, { position: [1, 2, 3], rotationDeg: [82, 0, -12] });

  it('localToWorld and worldToLocal are inverse; partTransform matches the builder mesh placement', () => {
    const rng = mulberry32(41);
    for (let i = 0; i < 50; i++) {
      const q: Vec3 = [randomRange(rng, -3, 3), randomRange(rng, -3, 3), randomRange(rng, -3, 3)];
      expectClose(worldToLocal(p, localToWorld(p, q)), q, 1e-12);
      const m = threeEuler(p.rotationDeg as Vec3).setPosition(...p.position);
      const v = new Vector3(...q).applyMatrix4(m);
      expectClose(localToWorld(p, q), [v.x, v.y, v.z], 1e-12);
      expectClose(applyRigid(partTransform(p), q), [v.x, v.y, v.z], 1e-12);
    }
  });

  it('partAxis is the world direction of a local axis', () => {
    expectClose(partAxis(p, 1), [0.2079, 0.1361, 0.9686], 1e-4); // the teddy leg points forward and slightly up
    expectClose(partAxis(part('sphere', { r: 1 }), 1), [0, 1, 0]);
    expectClose(partAxis(part('sphere', { r: 1 }, { rotationDeg: [0, 0, 90] }), 0), [0, 1, 0]);
    expectClose(partAxis(p), partAxis(p, 1));
  });

  it('translatePart moves a copy', () => {
    const moved = translatePart(p, [1, -1, 0.5]);
    expect(moved.position).toEqual([2, 1, 3.5]);
    expect(p.position).toEqual([1, 2, 3]);
    expect(moved.dims).toBe(p.dims);
  });
});

describe('bounding boxes come from the builder geometry (§0.1, §3.4.1)', () => {
  // Tessellation: a vertex of the builder mesh can be short of the true extreme by r·(1 − cos(π/segments)).
  const slack = (p: Part): number => {
    const size = Math.max(...boundsSize(localBounds(p)));
    return p.type === 'box' ? 1e-6 : 0.012 * size;
  };

  it('localBounds contains the builder mesh and is tight, for every primitive type', () => {
    for (const p of samplePrimitives()) {
      const mesh = meshBounds(localMesh(p));
      const b = localBounds(p);
      for (let k = 0; k < 3; k++) {
        expect(b.min[k], `${p.type} min[${k}]`).toBeLessThanOrEqual(mesh.min[k] + 1e-6);
        expect(b.max[k], `${p.type} max[${k}]`).toBeGreaterThanOrEqual(mesh.max[k] - 1e-6);
        expect(mesh.min[k] - b.min[k], `${p.type} min[${k}] tight`).toBeLessThanOrEqual(slack(p));
        expect(b.max[k] - mesh.max[k], `${p.type} max[${k}] tight`).toBeLessThanOrEqual(slack(p));
      }
    }
  });

  it('worldBounds contains the rotated builder mesh and is tight (not the box around the rotated local box)', () => {
    const rng = mulberry32(51);
    for (const base of samplePrimitives()) {
      for (let i = 0; i < 6; i++) {
        const p = {
          ...base,
          position: [randomRange(rng, -3, 3), randomRange(rng, -3, 3), randomRange(rng, -3, 3)] as Vec3,
          rotationDeg: [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)] as Vec3,
        };
        const mesh = meshBounds(worldMesh(p));
        const b = worldBounds(p);
        for (let k = 0; k < 3; k++) {
          expect(b.min[k], `${p.type} min[${k}]`).toBeLessThanOrEqual(mesh.min[k] + 1e-6);
          expect(b.max[k], `${p.type} max[${k}]`).toBeGreaterThanOrEqual(mesh.max[k] - 1e-6);
          expect(mesh.min[k] - b.min[k], `${p.type} min[${k}] tight`).toBeLessThanOrEqual(slack(p));
          expect(b.max[k] - mesh.max[k], `${p.type} max[${k}] tight`).toBeLessThanOrEqual(slack(p));
        }
      }
    }
  });

  it('exact extents of the round primitives', () => {
    expect(localBounds(part('sphere', { r: 0.9 }))).toEqual({ min: [-0.9, -0.9, -0.9], max: [0.9, 0.9, 0.9] });
    expect(localBounds(part('ellipsoid', { rx: 1.2, ry: 0.8, rz: 0.6 }))).toEqual({ min: [-1.2, -0.8, -0.6], max: [1.2, 0.8, 0.6] });
    expect(localBounds(part('capsule', { r: 0.4, length: 2.2 }))).toEqual({ min: [-0.4, -1.1, -0.4], max: [0.4, 1.1, 0.4] });
    // a capsule shorter than 2r is the builder's sphere of radius r
    expect(localBounds(part('capsule', { r: 0.4, length: 0.5 }))).toEqual({ min: [-0.4, -0.4, -0.4], max: [0.4, 0.4, 0.4] });
    expect(localBounds(part('cylinder', { rTop: 0.5, rBottom: 0.8, h: 1.4 }))).toEqual({ min: [-0.8, -0.7, -0.8], max: [0.8, 0.7, 0.8] });
    expect(localBounds(part('cone', { r: 0.7, h: 1.5 }))).toEqual({ min: [-0.7, -0.75, -0.7], max: [0.7, 0.75, 0.7] });
    expectClose(localBounds(part('torus', { R: 1.1, r: 0.3 })).min, [-1.4, -1.4, -0.3]);
    expectClose(localBounds(part('torus', { R: 1.1, r: 0.3 })).max, [1.4, 1.4, 0.3]);
    expect(localBounds(part('box', { w: 1.4, h: 0.9, d: 0.6 }))).toEqual({ min: [-0.7, -0.45, -0.3], max: [0.7, 0.45, 0.3] });
    expect(localBounds(part('mesh', { meshRef: 'm', bboxIn: [2, 1, 0.5] }))).toEqual({ min: [-1, -0.5, -0.25], max: [1, 0.5, 0.25] });
  });

  it('a rotated ellipsoid, capsule and cylinder: the teddy extents measured on the exported OBJ (research 08)', () => {
    const teddy = buildCanonicalTeddy().normalized;
    const by = Object.fromEntries(teddy.parts.map((p) => [p.id, p]));
    expect(worldBounds(by.leg_l).min[1]).toBeCloseTo(-0.0789, 4); // the lowest point of the model
    expect(worldBounds(by.arm_l).max[0]).toBeCloseTo(2.9059, 4); // the widest
    expect(worldBounds(by.ear_l).max[1]).toBeCloseTo(9.8, 9); // the tallest: a disc ellipsoid turned 28° keeps its height
    expect(worldBounds(by.foot_pad_l).max[2]).toBeCloseTo(2.8202, 4); // the front
    expect(worldBounds(by.tail).min[2]).toBeCloseTo(-2.25, 9); // the back
  });

  it('a lathe is not centered: its box spans [y_min, y_max] of the profile from its origin', () => {
    const lathe = part('lathe', { profile: [[0, 0.5], [1.5, 1], [1, 2], [0, 3.2]] }, { position: [1, 10, -2] });
    expect(localBounds(lathe)).toEqual({ min: [-1.5, 0.5, -1.5], max: [1.5, 3.2, 1.5] });
    expect(localCenter(lathe)).toEqual([0, 1.85, 0]);
    expect(partCenter(lathe)).toEqual([1, 11.85, -2]);
    expect(worldBounds(lathe)).toEqual({ min: [-0.5, 10.5, -3.5], max: [2.5, 13.2, -0.5] });
    // turned upside down about its origin
    const flipped = { ...lathe, rotationDeg: [180, 0, 0] as Vec3 };
    expect(worldBounds(flipped).min[1]).toBeCloseTo(10 - 3.2, 9);
    expect(worldBounds(flipped).max[1]).toBeCloseTo(10 - 0.5, 9);
    expectClose(partCenter(flipped), [1, 10 - 1.85, -2], 1e-9);
  });

  it('a torus arc is not centered either: its center is its bounding-box center', () => {
    const half = part('torus', { R: 1, r: 0.2, arcDeg: 180 });
    const b = localBounds(half);
    expectClose(b.min, [-1.2, 0, -0.2], 1e-9); // the open ends are flat circles in the plane y = 0
    expectClose(b.max, [1.2, 1.2, 0.2], 1e-9);
    expectClose(localCenter(half), [0, 0.6, 0], 1e-9);
    const quarter = part('torus', { R: 1, r: 0.2, arcDeg: 90 });
    expectClose(localBounds(quarter).min, [0, 0, -0.2], 1e-9);
    expectClose(localBounds(quarter).max, [1.2, 1.2, 0.2], 1e-9);
    const mesh = meshBounds(localMesh(part('torus', { R: 1, r: 0.2, arcDeg: 200 })));
    const arc = localBounds(part('torus', { R: 1, r: 0.2, arcDeg: 200 }));
    for (let k = 0; k < 3; k++) {
      expect(arc.min[k]).toBeLessThanOrEqual(mesh.min[k] + 1e-6);
      expect(arc.max[k]).toBeGreaterThanOrEqual(mesh.max[k] - 1e-6);
      expect(mesh.min[k] - arc.min[k]).toBeLessThanOrEqual(0.01);
      expect(arc.max[k] - mesh.max[k]).toBeLessThanOrEqual(0.01);
    }
    expect(localCenter(part('torus', { R: 1, r: 0.2 }))).toEqual([0, 0, 0]);
    expect(localCenter(part('torus', { R: 1, r: 0.2, arcDeg: 360 }))).toEqual([0, 0, 0]);
  });

  it('a flat part includes the builder bevel, which grows the outline at mid-thickness', () => {
    const disc = part('flat', { shape: 'circle', w: 2, h: 2, thickness: 0.4 });
    const b = localBounds(disc);
    const bevel = Math.min(0.3 * 0.4, 0.1 * 2); // §3.4.1
    expect(b.max[0]).toBeCloseTo(1 + bevel, 2);
    expect(b.max[1]).toBeCloseTo(1 + bevel, 2);
    expect(b.max[2]).toBeCloseTo(0.2, 6);
    expect(b.min[2]).toBeCloseTo(-0.2, 6);
    // a teardrop is narrower than its nominal w: the Bézier outline of §3.4.1 reaches ±0.394·w
    const drop = localBounds(part('flat', { shape: 'teardrop', w: 1, h: 2, thickness: 0.2 }));
    expect(drop.max[0]).toBeGreaterThan(0.39);
    expect(drop.max[0]).toBeLessThan(0.47);
    expect(drop.max[0]).toBeCloseTo(-drop.min[0], 6);
    expect(drop.max[1]).toBeCloseTo(-drop.min[1], 6); // centered by the builder
  });

  it('a mesh part uses its vertices when they are passed, else the box of bboxIn', () => {
    const model = readEveryType();
    const meshes = readEveryTypeMeshes();
    const blob = model.parts.find((p) => p.type === 'mesh') as Extract<Part, { type: 'mesh' }>;
    const mesh = meshes[blob.dims.meshRef];
    expectClose(boundsSize(localBounds(blob, mesh)), blob.dims.bboxIn, 1e-5);
    expectClose(boundsSize(localBounds(blob)), blob.dims.bboxIn, 1e-12);
    const turned = { ...blob, rotationDeg: [0, 0, 45] as Vec3 };
    const tight = boundsSize(worldBounds(turned, mesh));
    const loose = boundsSize(worldBounds(turned));
    expect(tight[0]).toBeLessThan(loose[0]);
    expect(loose[0]).toBeCloseTo((0.8 + 0.6) / Math.SQRT2, 6);
    expect(partCenter(blob, mesh)).toEqual(partCenter(blob));
  });

  it('part centers: position for every type except lathe and torus arc (§0.1), and positionForCenter inverts it', () => {
    for (const p of samplePrimitives()) {
      const placed = { ...p, position: [1, 2, 3] as Vec3, rotationDeg: [30, 40, 50] as Vec3 };
      if (p.type === 'lathe') {
        const c = localCenter(p);
        expect(c[1]).toBeCloseTo(1.2, 9);
        expectClose(partCenter(placed), localToWorld(placed, c), 1e-12);
      } else {
        expect(partCenter(placed)).toEqual([1, 2, 3]);
      }
      expectClose(positionForCenter(placed, partCenter(placed)), placed.position, 1e-12);
      const moved = { ...placed, position: positionForCenter(placed, [7, 8, 9]) };
      expectClose(partCenter(moved), [7, 8, 9], 1e-12);
      // the center is the center of the local box, mapped to world
      expectClose(partCenter(placed), localToWorld(placed, boundsCenter(localBounds(p))), 1e-9);
    }
  });

  it('unionBounds, modelBounds and modelHeight', () => {
    const a = part('sphere', { r: 1 }, { id: 'a', position: [0, 1, 0] });
    const b = part('box', { w: 1, h: 4, d: 1 }, { id: 'b', position: [3, 2, -1] });
    expect(unionBounds(worldBounds(a), worldBounds(b))).toEqual({ min: [-1, 0, -1.5], max: [3.5, 4, 1] });
    expect(modelBounds(modelOf([a, b]))).toEqual({ min: [-1, 0, -1.5], max: [3.5, 4, 1] });
    expect(modelHeight(modelOf([a, b]))).toBe(4);
    expect(modelBounds({ parts: [] })).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });
});

describe('grounding (§0.1: the lowest point is at y = 0)', () => {
  it('translates every part by the same dy so the lowest point of the geometry is at y = 0', () => {
    const lathe = part('lathe', { profile: [[0, -0.4], [1, 0], [0, 2]] }, { id: 'body', position: [0, 1, 0] });
    const ball = part('sphere', { r: 0.5 }, { id: 'ball', position: [0, 0.2, 2] });
    const { model, dy } = groundModel(modelOf([lathe, ball]));
    expect(dy).toBeCloseTo(0.3, 12); // the ball's bottom was at −0.3; the lathe's at 1 − 0.4 = 0.6 — not at its position
    expect(model.parts[0].position).toEqual([0, 1.3, 0]);
    expect(model.parts[1].position).toEqual([0, 0.5, 2]);
    expect(modelBounds(model).min[1]).toBeCloseTo(0, 12);
    expect(lathe.position).toEqual([0, 1, 0]); // the input is not modified
  });

  it('is idempotent and leaves a grounded model untouched', () => {
    const m = modelOf([part('sphere', { r: 1 }, { position: [0, 1, 0] })]);
    const once = groundModel(m);
    expect(once.dy).toBe(0);
    expect(once.model).toBe(m);
    const high = groundModel(modelOf([part('sphere', { r: 1 }, { position: [0, 5, 0] })]));
    expect(high.dy).toBe(-4);
    expect(groundModel(high.model).dy).toBe(0);
  });

  it('grounds on the rotated geometry: the teddy rests on its leg capsules (§3.7.3: +0.0789)', () => {
    const { normalized } = buildCanonicalTeddy();
    const { model, dy } = groundModel(normalized);
    expect(dy).toBeCloseTo(0.078905, 6);
    expect(modelBounds(model).min[1]).toBeCloseTo(0, 12);
    expect(modelHeight(model)).toBeCloseTo(modelHeight(normalized), 12);
  });

  it('uses the vertices of mesh parts when they are passed', () => {
    const model = readEveryType();
    const meshes = readEveryTypeMeshes();
    const lifted = { ...model, parts: model.parts.map((p) => translatePart(p, [0, 2, 0])) };
    expect(groundModel(lifted, meshes).dy).toBeCloseTo(-2, 5);
  });

  it('never returns NaN positions for a model with broken numbers', () => {
    const broken = modelOf([part('sphere', { r: Number.NaN }, { position: [0, 1, 0] })]);
    expect(groundModel(broken).dy).toBe(0);
  });

  it('the ground center is on the mirror plane, under the origin, at the lowest point', () => {
    const m = modelOf([part('sphere', { r: 1 }, { position: [4, 3, -2] })]);
    expect(groundCenter(m)).toEqual([0, 2, 0]);
  });
});

describe('rounding', () => {
  it('roundCoord rounds to 1e-6, halves away from zero, and never writes −0', () => {
    expect(roundCoord(1.23456749)).toBe(1.234567);
    expect(roundCoord(-27.999999999999996)).toBe(-28);
    expect(roundCoord(6.6000000000000005)).toBe(6.6);
    expect(Object.is(roundCoord(-0), 0)).toBe(true);
    expect(Object.is(roundCoord(-1e-9), 0)).toBe(true);
    expect(roundCoord(2.5, 0)).toBe(3);
    expect(roundCoord(-2.5, 0)).toBe(-3); // symmetric: mirror twins stay mirrored
    expect(roundCoord(0.125, 2)).toBe(0.13);
    expect(roundCoord(-0.125, 2)).toBe(-0.13);
    expect(roundCoord(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(roundCoord(Number.NaN))).toBe(true);
    const rng = mulberry32(61);
    for (let i = 0; i < 200; i++) {
      const x = randomRange(rng, -50, 50);
      expect(roundCoord(-x)).toBe(-roundCoord(x) + 0);
      expect(Math.abs(roundCoord(x) - x)).toBeLessThanOrEqual(5.0000001e-7);
    }
    expect(roundVec3([1.00000049, -0, 2.0000005])).toEqual([1, 0, 2.000001]);
  });

  it('roundModel rounds lengths and angles the kernels derive, and nothing else', () => {
    const m = modelOf(
      [
        part('lathe', { profile: [[0, 0], [1.00000049, 0.30000001], [0, 1.9999996]], sharp: [1] }, {
          id: 'body',
          position: [0.1234567891, -0, 1e-9],
          rotationDeg: [82.00000001, 0, -12.000000000000002],
          regions: [
            { kind: 'stripes', colors: ['c1'], widthIn: 0.33333333333, from: 0.123456789 },
            { kind: 'spot', azimuthDeg: 10.123456789, elevationDeg: 0, radiusIn: 0.2000000004, color: 'c1' },
          ],
          crochet: { seed: [0.1, 0.20000000001, 0.3] },
        }),
      ],
      { finishedSize: { height: 9.8789054678, width: 5.81175252 }, features: [{ id: 'e', kind: 'nose', on: 'body', azimuthDeg: 1.23456789, elevationDeg: 0, sizeIn: 0.25000000001 }] },
    );
    const r = roundModel(m);
    expect(r.parts[0].position).toEqual([0.123457, 0, 0]);
    expect(r.parts[0].rotationDeg).toEqual([82, 0, -12]);
    expect(r.parts[0].dims).toEqual({ profile: [[0, 0], [1, 0.3], [0, 2]], sharp: [1] });
    expect(r.parts[0].regions).toEqual([
      { kind: 'stripes', colors: ['c1'], widthIn: 0.333333, from: 0.123456789 },
      { kind: 'spot', azimuthDeg: 10.123456789, elevationDeg: 0, radiusIn: 0.2, color: 'c1' },
    ]);
    expect(r.parts[0].crochet).toEqual({ seed: [0.1, 0.2, 0.3] });
    expect(r.finishedSize).toEqual({ height: 9.878905, width: 5.811753 });
    expect(r.features).toEqual([{ id: 'e', kind: 'nose', on: 'body', azimuthDeg: 1.23456789, elevationDeg: 0, sizeIn: 0.25 }]);
    expect(m.parts[0].position[0]).toBe(0.1234567891);
  });
});
