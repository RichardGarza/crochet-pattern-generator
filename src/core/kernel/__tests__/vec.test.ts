import { Euler, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../types/geometry';
import { mulberry32 } from '../prng';
import {
  add,
  addScaled,
  anyPerpendicular,
  clamp,
  cross,
  DEG2RAD,
  det3,
  distance,
  dot,
  eigenSymmetric3,
  identity3,
  invert3,
  length,
  lengthSq,
  lerp,
  lerpVec,
  type Mat3,
  mat3Column,
  mat3FromColumns,
  mat3FromRows,
  maxVec,
  minVec,
  mod,
  mulMat3,
  mulMat3Vec,
  multiply,
  nearlyEqual,
  negate,
  normalize,
  RAD2DEG,
  rotationAxisAngle,
  rotationX,
  rotationY,
  rotationZ,
  scale,
  smoothstep,
  sub,
  transpose3,
  vec3,
} from '../vec';

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

/** The upper-left 3×3 of a three.js Matrix4 (column-major) as our row-major Mat3. */
function fromThree(m: Matrix4): Mat3 {
  const e = m.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-12): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps);
}

describe('scalars', () => {
  it('clamp, lerp, mod, smoothstep', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
    expect(lerp(2, 6, 0.25)).toBe(3);
    expect(mod(-1, 360)).toBe(359);
    expect(mod(725, 360)).toBe(5);
    expect(mod(0, 360)).toBe(0);
    expect(smoothstep(2, 14, 2)).toBe(0);
    expect(smoothstep(2, 14, 14)).toBe(1);
    expect(smoothstep(2, 14, 8)).toBe(0.5);
    expect(smoothstep(2, 14, -3)).toBe(0);
    expect(smoothstep(2, 14, 99)).toBe(1);
    // 3t² − 2t³ at t = ¼ and ¾: not the straight line through the end points
    expect(smoothstep(0, 1, 0.25)).toBe(0.15625);
    expect(smoothstep(0, 1, 0.75)).toBe(0.84375);
    expect(smoothstep(2, 14, 5)).toBe(0.15625);
    expect(lerp(2, 6, 0)).toBe(2);
    expect(lerp(2, 6, 1)).toBe(6);
    expect(clamp(7, 2, 5)).toBe(5);
    expect(clamp(1, 2, 5)).toBe(2);
    expect(mod(-725, 360)).toBe(355);
    expect(mod(5.5, -2)).toBe(-0.5);
    expect(DEG2RAD * 180).toBeCloseTo(Math.PI, 15);
    expect(RAD2DEG * Math.PI).toBeCloseTo(180, 12);
  });
});

describe('Vec3', () => {
  it('does the basic arithmetic without touching its inputs', () => {
    const a: Vec3 = [1, 2, 3];
    const b: Vec3 = [4, -5, 6];
    expect(add(a, b)).toEqual([5, -3, 9]);
    expect(sub(a, b)).toEqual([-3, 7, -3]);
    expect(scale(a, 2)).toEqual([2, 4, 6]);
    expect(addScaled(a, b, 0.5)).toEqual([3, -0.5, 6]);
    expect(negate(a)).toEqual([-1, -2, -3]);
    expect(multiply(a, b)).toEqual([4, -10, 18]);
    expect(dot(a, b)).toBe(12);
    expect(lengthSq(a)).toBe(14);
    expect(length([3, 4, 0])).toBe(5);
    expect(distance([1, 1, 1], [4, 5, 1])).toBe(5);
    expect(lerpVec(a, b, 0.5)).toEqual([2.5, -1.5, 4.5]);
    expect(minVec(a, b)).toEqual([1, -5, 3]);
    expect(maxVec(a, b)).toEqual([4, 2, 6]);
    // every component independently, in both argument orders
    expect(minVec([9, 2, 7], [3, 8, 1])).toEqual([3, 2, 1]);
    expect(minVec([3, 8, 1], [9, 2, 7])).toEqual([3, 2, 1]);
    expect(maxVec([9, 2, 7], [3, 8, 1])).toEqual([9, 8, 7]);
    expect(maxVec([3, 8, 1], [9, 2, 7])).toEqual([9, 8, 7]);
    expect(addScaled([1, 2, 3], [10, 20, 30], -1)).toEqual([-9, -18, -27]);
    expect(lerpVec([0, 10, -4], [8, 20, 4], 0.25)).toEqual([2, 12.5, -2]);
    expect(distance([0, 0, 0], [1, 2, 2])).toBe(3);
    expect(vec3()).toEqual([0, 0, 0]);
    expect(vec3(1, 2, 3)).toEqual([1, 2, 3]);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([4, -5, 6]);
  });

  it('has a right-handed cross product: X × Y = Z', () => {
    expect(cross(X, Y)).toEqual(Z);
    expect(cross(Y, Z)).toEqual(X);
    expect(cross(Z, X)).toEqual(Y);
    expect(cross(Y, X)).toEqual([0, 0, -1]);
    const a: Vec3 = [1, 2, 3];
    const b: Vec3 = [-2, 0.5, 4];
    const c = cross(a, b);
    expect(dot(c, a)).toBeCloseTo(0, 12);
    expect(dot(c, b)).toBeCloseTo(0, 12);
  });

  it('normalizes, with a fallback for zero vectors', () => {
    expectClose(normalize([3, 0, 4]), [0.6, 0, 0.8]);
    expect(normalize([0, 0, 0])).toEqual([0, 1, 0]);
    expect(normalize([0, 0, 0], [0, 0, 1])).toEqual([0, 0, 1]);
    // Small is not zero: a tiny vector keeps its DIRECTION (the fallback is only for lengths below 1e-12).
    const tiny = normalize([1e-5, 2e-5, -3e-5]);
    expectClose(tiny, normalize([1, 2, -3]), 1e-12);
    expect(tiny[2]).toBeLessThan(0);
    expectClose(normalize([0, 0, -1e-9]), [0, 0, -1], 1e-12);
    expectClose(normalize([3e-11, 0, 4e-11]), [0.6, 0, 0.8], 1e-9);
    expect(normalize([1e-13, 0, 0])).toEqual([0, 1, 0]);
    expect(normalize([1e-13, 0, 0], [1, 0, 0])).toEqual([1, 0, 0]);
    // the fallback is returned as a copy
    const fallback: Vec3 = [0, 0, 1];
    expect(normalize([0, 0, 0], fallback)).not.toBe(fallback);
  });

  it('compares with a tolerance', () => {
    expect(nearlyEqual([1, 2, 3], [1, 2, 3 + 1e-12])).toBe(true);
    expect(nearlyEqual([1, 2, 3], [1, 2, 3.1])).toBe(false);
    expect(nearlyEqual([1, 2, 3], [1, 2, 3.1], 0.2)).toBe(true);
    expect(nearlyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(nearlyEqual([Number.NaN, 0, 0], [Number.NaN, 0, 0])).toBe(false);
  });

  it('finds a perpendicular unit vector', () => {
    const rng = mulberry32(4);
    const inputs: Vec3[] = [X, Y, Z, [1, 1, 1], [0, -2, 0]];
    for (let i = 0; i < 50; i++) inputs.push([rng() - 0.5, rng() - 0.5, rng() - 0.5]);
    for (const v of inputs) {
      const p = anyPerpendicular(v);
      expect(length(p)).toBeCloseTo(1, 12);
      expect(dot(p, normalize(v))).toBeCloseTo(0, 12);
    }
    expect(anyPerpendicular([0, 1, 0])).toEqual(anyPerpendicular([0, 1, 0]));
  });
});

describe('Mat3', () => {
  const m: Mat3 = [2, -1, 0, 1, 3, 4, 0, 5, -2];

  it('multiplies row-major matrices and column vectors', () => {
    expect(mulMat3Vec(identity3(), [1, 2, 3])).toEqual([1, 2, 3]);
    expect(mulMat3Vec(m, [1, 2, 3])).toEqual([0, 19, 4]);
    expect(mulMat3(identity3(), m)).toEqual(m);
    expect(mulMat3(m, identity3())).toEqual(m);
    // (a·b)·v = a·(b·v)
    const a = rotationX(0.3);
    const b = rotationY(-1.1);
    const v: Vec3 = [0.2, -0.7, 1.5];
    expectClose(mulMat3Vec(mulMat3(a, b), v), mulMat3Vec(a, mulMat3Vec(b, v)));
  });

  it('builds from rows and columns', () => {
    expect(mat3FromRows([1, 2, 3], [4, 5, 6], [7, 8, 9])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const c = mat3FromColumns([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    expect(c).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
    expect(mat3Column(c, 0)).toEqual([1, 2, 3]);
    expect(mat3Column(c, 2)).toEqual([7, 8, 9]);
    // The columns are the images of the axes.
    expect(mulMat3Vec(c, X)).toEqual([1, 2, 3]);
    expect(mulMat3Vec(c, Z)).toEqual([7, 8, 9]);
    expect(transpose3(c)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('computes determinants and inverses', () => {
    expect(det3(identity3())).toBe(1);
    expect(det3(m)).toBe(-54);
    const inv = invert3(m);
    expect(inv).not.toBeNull();
    expectClose(mulMat3(m, inv as Mat3), identity3());
    expectClose(mulMat3(inv as Mat3, m), identity3());
    expect(invert3([1, 2, 3, 2, 4, 6, 0, 1, 1])).toBeNull();
    expect(invert3([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    // "singular" is relative: small but well-conditioned matrices invert, at any scale
    const small = invert3([1e-5, 0, 0, 0, 1e-5, 0, 0, 0, 1e-5]);
    expectClose(small as Mat3, [1e5, 0, 0, 0, 1e5, 0, 0, 0, 1e5], 1e-6);
    const scaled = m.map((v) => v * 1e-7) as Mat3;
    expectClose(mulMat3(scaled, invert3(scaled) as Mat3), identity3(), 1e-9);
    const huge = m.map((v) => v * 1e9) as Mat3;
    expectClose(mulMat3(huge, invert3(huge) as Mat3), identity3(), 1e-9);
    // nearly dependent rows are singular at any scale
    expect(invert3([1, 2, 3, 2, 4, 6 + 1e-14, 0, 1, 1])).toBeNull();
    expect(invert3([1e-6, 2e-6, 3e-6, 2e-6, 4e-6, 6e-6, 0, 1e-6, 1e-6])).toBeNull();
  });
});

describe('rotations', () => {
  it('turn the axes the right-handed way', () => {
    expectClose(mulMat3Vec(rotationX(Math.PI / 2), Y), Z, 1e-15);
    expectClose(mulMat3Vec(rotationY(Math.PI / 2), Z), X, 1e-15);
    expectClose(mulMat3Vec(rotationZ(Math.PI / 2), X), Y, 1e-15);
  });

  it('match the view turns of §2.9.3', () => {
    const p: Vec3 = [0.3, -1.2, 2.5];
    const [x, y, z] = p;
    // left:  R_y(+90°), (x', y', z') → (z', y', −x')
    expectClose(mulMat3Vec(rotationY(90 * DEG2RAD), p), [z, y, -x], 1e-12);
    // right: R_y(−90°), (x', y', z') → (−z', y', x')
    expectClose(mulMat3Vec(rotationY(-90 * DEG2RAD), p), [-z, y, x], 1e-12);
    // top:   R_x(−90°), (x', y', z') → (x', z', −y')
    expectClose(mulMat3Vec(rotationX(-90 * DEG2RAD), p), [x, z, -y], 1e-12);
  });

  it('are proper rotations: determinant 1 and inverse = transpose', () => {
    for (const r of [rotationX(0.7), rotationY(-2.1), rotationZ(3.3), rotationAxisAngle([1, 2, 3], 1.234)]) {
      expect(det3(r)).toBeCloseTo(1, 12);
      expectClose(mulMat3(r, transpose3(r)), identity3());
      expectClose(invert3(r) as Mat3, transpose3(r));
    }
  });

  it('agree with three.js', () => {
    for (const angle of [0, 0.4, -1.3, Math.PI, 5]) {
      expectClose(rotationX(angle), fromThree(new Matrix4().makeRotationX(angle)));
      expectClose(rotationY(angle), fromThree(new Matrix4().makeRotationY(angle)));
      expectClose(rotationZ(angle), fromThree(new Matrix4().makeRotationZ(angle)));
      const axis = new Vector3(1, -2, 0.5).normalize();
      expectClose(rotationAxisAngle([1, -2, 0.5], angle), fromThree(new Matrix4().makeRotationAxis(axis, angle)));
    }
  });

  it("compose Euler XYZ as Rx·Ry·Rz, the three.js order 'XYZ' of §0.1", () => {
    const rng = mulberry32(12);
    for (let i = 0; i < 25; i++) {
      const ax = (rng() - 0.5) * 6;
      const ay = (rng() - 0.5) * 6;
      const az = (rng() - 0.5) * 6;
      const ours = mulMat3(rotationX(ax), mulMat3(rotationY(ay), rotationZ(az)));
      const theirs = fromThree(new Matrix4().makeRotationFromEuler(new Euler(ax, ay, az, 'XYZ')));
      expectClose(ours, theirs);
    }
    // The §3.6 example: arm_l has rotationDeg [-20, 0, 25].
    const arm = mulMat3(rotationX(-20 * DEG2RAD), mulMat3(rotationY(0), rotationZ(25 * DEG2RAD)));
    expectClose(arm, fromThree(new Matrix4().makeRotationFromEuler(new Euler(-20 * DEG2RAD, 0, 25 * DEG2RAD, 'XYZ'))));
  });

  it('axis-angle about the coordinate axes equals rotationX/Y/Z', () => {
    expectClose(rotationAxisAngle([2, 0, 0], 0.8), rotationX(0.8));
    expectClose(rotationAxisAngle([0, 5, 0], 0.8), rotationY(0.8));
    expectClose(rotationAxisAngle([0, 0, 0.1], 0.8), rotationZ(0.8));
  });
});

describe('eigenSymmetric3', () => {
  it('reads a diagonal matrix directly, sorted from largest to smallest', () => {
    const { values, vectors } = eigenSymmetric3([2, 0, 0, 0, 5, 0, 0, 0, 3]);
    expect(values).toEqual([5, 3, 2]);
    expect(vectors).toEqual([Y, Z, X]); // Y × Z = X: right-handed
    // diag(2, 3, 5): the sorted axes are Z, Y, and the third must be Z × Y = −X to stay right-handed
    const other = eigenSymmetric3([2, 0, 0, 0, 3, 0, 0, 0, 5]);
    expect(other.values).toEqual([5, 3, 2]);
    expectClose(other.vectors[0], Z);
    expectClose(other.vectors[1], Y);
    expectClose(other.vectors[2], [-1, 0, 0]);
  });

  it('always returns a right-handed frame (a rotation, never a reflection)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => rng() * 4 - 2);
      const { vectors } = eigenSymmetric3([a, b, c, b, d, e, c, e, f]);
      expect(det3(mat3FromColumns(vectors[0], vectors[1], vectors[2]))).toBeCloseTo(1, 10);
      expectClose(cross(vectors[0], vectors[1]), vectors[2], 1e-10);
    }
  });

  it('solves a known 2×2 block', () => {
    // [[2, 1], [1, 2]] has eigenvalues 3 and 1 with eigenvectors (1, 1)/√2 and (1, −1)/√2.
    const { values, vectors } = eigenSymmetric3([2, 1, 0, 1, 2, 0, 0, 0, 10]);
    expectClose(values, [10, 3, 1]);
    expectClose(vectors[0], [0, 0, 1]);
    expectClose(vectors[1], [Math.SQRT1_2, Math.SQRT1_2, 0]);
    // the third axis is vectors[0] × vectors[1] = Z × (1, 1, 0)/√2 = (−1, 1, 0)/√2
    expectClose(vectors[2], [-Math.SQRT1_2, Math.SQRT1_2, 0]);
  });

  it('satisfies A·v = λ·v with orthonormal vectors on random symmetric matrices', () => {
    const rng = mulberry32(2718);
    for (let i = 0; i < 200; i++) {
      const a = rng() * 4 - 2;
      const b = rng() * 4 - 2;
      const c = rng() * 4 - 2;
      const d = rng() * 4 - 2;
      const e = rng() * 4 - 2;
      const f = rng() * 4 - 2;
      const A: Mat3 = [a, b, c, b, d, e, c, e, f];
      const { values, vectors } = eigenSymmetric3(A);
      expect(values[0] >= values[1] && values[1] >= values[2]).toBe(true);
      expect(values[0] + values[1] + values[2]).toBeCloseTo(a + d + f, 10);
      for (let k = 0; k < 3; k++) {
        expectClose(mulMat3Vec(A, vectors[k]), scale(vectors[k], values[k]), 1e-10);
        expect(length(vectors[k])).toBeCloseTo(1, 12);
        for (let j = k + 1; j < 3; j++) expect(dot(vectors[k], vectors[j])).toBeCloseTo(0, 10);
        // the first two axes have their largest component positive; the third follows from them
        if (k < 2) {
          const big = Math.max(...vectors[k].map(Math.abs));
          expect(vectors[k].some((x) => x === big)).toBe(true);
        }
      }
    }
  });

  it('finds the principal axis of a point cloud', () => {
    const rng = mulberry32(5);
    const axis = normalize([1, 2, -0.5]);
    let cxx = 0;
    let cxy = 0;
    let cxz = 0;
    let cyy = 0;
    let cyz = 0;
    let czz = 0;
    for (let i = 0; i < 2000; i++) {
      const t = (rng() - 0.5) * 10;
      const p = add(scale(axis, t), [(rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2]);
      cxx += p[0] * p[0];
      cxy += p[0] * p[1];
      cxz += p[0] * p[2];
      cyy += p[1] * p[1];
      cyz += p[1] * p[2];
      czz += p[2] * p[2];
    }
    const { values, vectors } = eigenSymmetric3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz]);
    expect(Math.abs(dot(vectors[0], axis))).toBeGreaterThan(0.999);
    expect(values[0]).toBeGreaterThan(100 * values[1]);
  });

  it('reads only the upper triangle and handles the zero matrix', () => {
    const upper = eigenSymmetric3([4, 1, 2, 99, 3, 0.5, 99, 99, 1]);
    const full = eigenSymmetric3([4, 1, 2, 1, 3, 0.5, 2, 0.5, 1]);
    expect(upper).toEqual(full);
    const zero = eigenSymmetric3([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(zero.values).toEqual([0, 0, 0]);
    expect(zero.vectors).toEqual([X, Y, Z]);
  });
});
