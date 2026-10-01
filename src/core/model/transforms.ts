// Transforms and extents of the crochet-model (DESIGN.md §0.1, §3.4.1, §3.7.3, §3.7.6). Step 0 kernel: pure.
//
// Conventions (§0.1): inches; right-handed, +Y up, front +Z, the object's own left +X. `rotationDeg` is Euler
// XYZ in degrees with the three.js order 'XYZ': matrix = Rx·Ry·Rz. `position` is the part's LOCAL ORIGIN in
// model space — the center for every part type except `lathe`, whose origin is the axis point at profile
// y = 0, and a torus arc, whose origin is the center of its ring. A part's CENTER is its local bounding-box
// center mapped to world: `position + R·c_local`.
//
// Extents always come from the builder geometry (§3.4.1), never from `position` alone: every bound here is the
// exact extent of the solid the builder tessellates (analytic for the round primitives, from the builder's
// own vertices for `flat` parts, whose bevel grows the outline).
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import {
  clamp,
  DEG2RAD,
  det3,
  type Mat3,
  mat3FromColumns,
  mulMat3,
  mulMat3Vec,
  RAD2DEG,
  rotationX,
  rotationY,
  rotationZ,
  transpose3,
} from '../kernel/vec';
import { flatLayout } from './builder';
import { sanePart } from './dims';

// ---- numbers

/** Decimals kept by the kernels that derive new coordinates (positions, rotations, dims): 1e-6 in / 1e-6°. */
export const COORD_DECIMALS = 6;

/**
 * Rounds to `decimals` places, halves away from zero — so `roundCoord(−x) = −roundCoord(x)` and mirror twins stay
 * exact mirrors — and −0 becomes 0, so the value serializes and compares like a hand-written one.
 */
export function roundCoord(x: number, decimals = COORD_DECIMALS): number {
  if (!Number.isFinite(x)) return x;
  const k = 10 ** decimals;
  const y = Math.round(Math.abs(x) * k) / k;
  return y === 0 ? 0 : x < 0 ? -y : y;
}

export function roundVec3(v: Vec3, decimals = COORD_DECIMALS): Vec3 {
  return [roundCoord(v[0], decimals), roundCoord(v[1], decimals), roundCoord(v[2], decimals)];
}

// ---- Euler XYZ ↔ matrix

/** The rotation matrix of `rotationDeg` (Euler XYZ, degrees): Rx·Ry·Rz, as three.js `'XYZ'`. */
export function eulerXYZToMat3(rotationDeg: Vec3 | undefined): Mat3 {
  if (!rotationDeg) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = rotationDeg;
  if (x === 0 && y === 0 && z === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return mulMat3(rotationX(x * DEG2RAD), mulMat3(rotationY(y * DEG2RAD), rotationZ(z * DEG2RAD)));
}

/**
 * Below this cos(y) a rotation is treated as gimbal-locked (z = 0). At cos(y) = c the two ways of decomposing are
 * both accurate to about max(1e-16 / c, c): 1e-8 balances them.
 */
const GIMBAL_COS = 1e-8;

/**
 * Euler XYZ angles (degrees) of a rotation matrix — the algorithm of three.js `Euler.setFromRotationMatrix`
 * for order 'XYZ', so the result is the one three.js gives: y in [−90°, 90°]; at gimbal lock (y = ±90°) z is 0
 * and x carries the whole turn about the folded axis.
 *
 * One deviation, near (not at) gimbal lock: three.js switches to its gimbal branch (z = 0) as soon as
 * |m13| ≥ 0.9999999 (|y| ≥ 89.9744°), which loses up to 4.5e-4 (≈ 0.025°) of the rotation for |y| in that band.
 * Here the band keeps the general decomposition, with y = atan2(m13, cos y) instead of the ill-conditioned
 * asin, down to cos(y) = 1e-8; so angles → matrix → angles → matrix is exact to about 1e-8 everywhere, and the
 * angles differ from three.js's only inside the band (by the rotation three.js loses there).
 */
export function mat3ToEulerXYZ(m: Mat3): Vec3 {
  const m13 = m[2];
  let x: number;
  let y: number;
  let z: number;
  if (Math.abs(m13) < 0.9999999) {
    y = Math.asin(clamp(m13, -1, 1));
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    const cosY = Math.hypot(m[0], m[1]);
    if (cosY > GIMBAL_COS) {
      y = Math.atan2(m13, cosY);
      x = Math.atan2(-m[5], m[8]);
      z = Math.atan2(-m[1], m[0]);
    } else {
      y = Math.asin(clamp(m13, -1, 1));
      x = Math.atan2(m[7], m[4]);
      z = 0;
    }
  }
  // + 0 turns −0 into 0: atan2(−0, 1) is −0, and angles are compared and serialized downstream.
  return [x * RAD2DEG + 0, y * RAD2DEG + 0, z * RAD2DEG + 0];
}

// ---- rigid transforms (rotation + translation; parents never scale their children, §3.7.3)

/** `p ↦ rotation·p + position`. */
export interface Rigid {
  rotation: Mat3;
  position: Vec3;
}

/** Compose: the rigid transform of a `position` and a `rotationDeg` (T·R). */
export function composeRigid(position: Vec3, rotationDeg?: Vec3): Rigid {
  return { rotation: eulerXYZToMat3(rotationDeg), position: [position[0], position[1], position[2]] };
}

/** Decompose: the `position` and `rotationDeg` (Euler XYZ, degrees) of a rigid transform. */
export function decomposeRigid(t: Rigid): { position: Vec3; rotationDeg: Vec3 } {
  return { position: [t.position[0], t.position[1], t.position[2]], rotationDeg: mat3ToEulerXYZ(t.rotation) };
}

/** a·b: applies `b` first, then `a`. `World(child) = multiplyRigid(World(parent), composeRigid(pos, rot))` (§3.7.3). */
export function multiplyRigid(a: Rigid, b: Rigid): Rigid {
  const p = mulMat3Vec(a.rotation, b.position);
  return {
    rotation: mulMat3(a.rotation, b.rotation),
    position: [p[0] + a.position[0], p[1] + a.position[1], p[2] + a.position[2]],
  };
}

export function invertRigid(t: Rigid): Rigid {
  const rt = transpose3(t.rotation);
  const p = mulMat3Vec(rt, t.position);
  return { rotation: rt, position: [-p[0], -p[1], -p[2]] };
}

export function applyRigid(t: Rigid, p: Vec3): Vec3 {
  const q = mulMat3Vec(t.rotation, p);
  return [q[0] + t.position[0], q[1] + t.position[1], q[2] + t.position[2]];
}

// ---- 4×4 matrices, column-major like three.js `Matrix4.elements` and glTF `node.matrix`

/** 16 numbers, column-major: element (row, col) is `m[4·col + row]`; the translation is m[12], m[13], m[14]. */
export type Mat4 = number[];

/** T·R·S as three.js `Matrix4.compose` (rotation = Euler XYZ in degrees). */
export function composeMat4(position: Vec3, rotationDeg?: Vec3, scale: Vec3 = [1, 1, 1]): Mat4 {
  const r = eulerXYZToMat3(rotationDeg);
  const [sx, sy, sz] = scale;
  return [
    r[0] * sx,
    r[3] * sx,
    r[6] * sx,
    0,
    r[1] * sy,
    r[4] * sy,
    r[7] * sy,
    0,
    r[2] * sz,
    r[5] * sz,
    r[8] * sz,
    0,
    position[0],
    position[1],
    position[2],
    1,
  ];
}

/**
 * Position, rotation (Euler XYZ, degrees) and scale of an affine matrix without shear, as three.js
 * `Matrix4.decompose`: the scale is the length of each column, and a mirroring matrix (negative determinant)
 * gets a negative x scale. A zero scale leaves that axis' rotation undefined; the identity axis is used.
 */
export function decomposeMat4(m: readonly number[]): { position: Vec3; rotationDeg: Vec3; scale: Vec3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const linear: Mat3 = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  if (det3(linear) < 0) sx = -sx;
  const column = (c: 0 | 1 | 2, s: number): Vec3 =>
    s !== 0 ? [m[4 * c] / s, m[4 * c + 1] / s, m[4 * c + 2] / s] : [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0];
  const rotation = mat3FromColumns(column(0, sx), column(1, sy), column(2, sz));
  return { position: [m[12], m[13], m[14]], rotationDeg: mat3ToEulerXYZ(rotation), scale: [sx, sy, sz] };
}

/** a·b for column-major 4×4 matrices: applies `b` first, then `a`. */
export function multiplyMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[4 * k + row] * b[4 * col + k];
      out[4 * col + row] = s;
    }
  }
  return out;
}

/** The rigid part of a column-major 4×4 matrix (its scale is dropped). */
export function rigidFromMat4(m: readonly number[]): Rigid {
  const { position, rotationDeg } = decomposeMat4(m);
  return composeRigid(position, rotationDeg);
}

// ---- parts

/** The part's local → world transform. */
export function partTransform(part: Pick<Part, 'position' | 'rotationDeg'>): Rigid {
  return composeRigid(part.position, part.rotationDeg);
}

/** A part-local point in model space. */
export function localToWorld(part: Pick<Part, 'position' | 'rotationDeg'>, pLocal: Vec3): Vec3 {
  return applyRigid(partTransform(part), pLocal);
}

/** A model-space point in the part's local frame. */
export function worldToLocal(part: Pick<Part, 'position' | 'rotationDeg'>, pWorld: Vec3): Vec3 {
  const r = eulerXYZToMat3(part.rotationDeg);
  const d: Vec3 = [pWorld[0] - part.position[0], pWorld[1] - part.position[1], pWorld[2] - part.position[2]];
  return mulMat3Vec(transpose3(r), d);
}

/** The world direction of one of the part's local axes (0 = X, 1 = Y — the axis of round primitives —, 2 = Z). */
export function partAxis(part: Pick<Part, 'rotationDeg'>, axis: 0 | 1 | 2 = 1): Vec3 {
  const r = eulerXYZToMat3(part.rotationDeg);
  return [r[axis], r[3 + axis], r[6 + axis]];
}

/** An axis-aligned box. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function boundsSize(b: Bounds): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boundsCenter(b: Bounds): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The support of the builder solid along a direction given in the part's LOCAL frame: the largest value of
 * `p·w` over the solid, measured from the local origin. `w` must be a unit vector.
 */
function supportLocal(part: Part, wx: number, wy: number, wz: number): number {
  switch (part.type) {
    case 'sphere':
      return part.dims.r;
    case 'ellipsoid':
      return Math.hypot(part.dims.rx * wx, part.dims.ry * wy, part.dims.rz * wz);
    case 'capsule':
      // The builder's straight section is max(0, length − 2r): a capsule shorter than 2r is a sphere.
      return Math.max(0, part.dims.length / 2 - part.dims.r) * Math.abs(wy) + part.dims.r;
    case 'cylinder': {
      const rho = Math.hypot(wx, wz);
      const half = part.dims.h / 2;
      return Math.max(-half * wy + part.dims.rBottom * rho, half * wy + part.dims.rTop * rho);
    }
    case 'cone': {
      const rho = Math.hypot(wx, wz);
      const half = part.dims.h / 2;
      return Math.max(-half * wy + part.dims.r * rho, half * wy);
    }
    case 'lathe': {
      const rho = Math.hypot(wx, wz);
      let best = -Infinity;
      for (const [r, y] of part.dims.profile) best = Math.max(best, y * wy + r * rho);
      return best === -Infinity ? 0 : best;
    }
    case 'torus':
      return torusSupport(part.dims.R, part.dims.r, part.dims.arcDeg, wx, wy);
    case 'box':
      return (Math.abs(wx) * part.dims.w + Math.abs(wy) * part.dims.h + Math.abs(wz) * part.dims.d) / 2;
    case 'flat': {
      const v = flatLayout(part.dims).vertices;
      let best = -Infinity;
      for (let i = 0; i < v.length; i += 3) best = Math.max(best, v[i] * wx + v[i + 1] * wy + v[i + 2] * wz);
      return best === -Infinity ? 0 : best;
    }
    case 'mesh':
      // Without the vertices: the box of `bboxIn` (conservative once the part is rotated).
      return (Math.abs(wx) * part.dims.bboxIn[0] + Math.abs(wy) * part.dims.bboxIn[1] + Math.abs(wz) * part.dims.bboxIn[2]) / 2;
    default:
      return 0;
  }
}

/**
 * Support of the builder's torus: the ring lies in local XY, the tube sweeps the angles [0, arc] from +X toward
 * +Y, and an arc is an open tube whose ends are flat circles (TorusGeometry has no caps).
 */
function torusSupport(R: number, r: number, arcDeg: number | undefined, wx: number, wy: number): number {
  const a = Math.hypot(wx, wy); // the in-plane part of w
  const arc = clamp(arcDeg ?? 360, 0, 360) * DEG2RAD;
  if (arc >= 2 * Math.PI - 1e-12 || a < 1e-12) {
    // Full ring; or w along the ring's axis, where every cross-section reaches the same height r.
    return R * a + r;
  }
  // g(u) = R·a·cos(u − φ) + r·sqrt(1 − a²·sin²(u − φ)) decreases with |u − φ|, so its maximum over the arc is
  // at u = φ when the arc contains it, else at the arc end nearest to φ.
  let phi = Math.atan2(wy, wx);
  if (phi < 0) phi += 2 * Math.PI;
  if (phi <= arc) return R * a + r;
  const g = (u: number): number => {
    const d = u - phi;
    const s = a * Math.sin(d);
    return R * a * Math.cos(d) + r * Math.sqrt(Math.max(0, 1 - s * s));
  };
  return Math.max(g(0), g(arc));
}

function boundsWith(given: Part, r: Mat3, origin: Vec3, mesh?: ColoredMesh): Bounds {
  const part = sanePart(given);
  if (part.type === 'mesh' && mesh && mesh.positions.length >= 3) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const v = mesh.positions;
    for (let i = 0; i + 2 < v.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const c = r[3 * k] * v[i] + r[3 * k + 1] * v[i + 1] + r[3 * k + 2] * v[i + 2] + origin[k];
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
    return { min, max };
  }
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    // The world axis e_k in the local frame is row k of R.
    const wx = r[3 * k];
    const wy = r[3 * k + 1];
    const wz = r[3 * k + 2];
    max[k] = origin[k] + supportLocal(part, wx, wy, wz);
    min[k] = origin[k] - supportLocal(part, -wx, -wy, -wz);
  }
  return { min, max };
}

/**
 * The bounding box of the part's builder geometry in its LOCAL frame. Centered on the origin for every type
 * except `lathe` (y spans [y_min, y_max] of the profile) and a torus arc. `mesh` supplies the vertices of a
 * mesh part; without it the box is ±bboxIn/2.
 */
export function localBounds(part: Part, mesh?: ColoredMesh): Bounds {
  return boundsWith(part, IDENTITY, [0, 0, 0], mesh);
}

/** The center of the local bounding box (`c_local` of §0.1): zero except for a lathe and a torus arc. */
export function localCenter(part: Part, mesh?: ColoredMesh): Vec3 {
  const offCenter =
    part.type === 'lathe' ||
    (part.type === 'torus' && (part.dims.arcDeg ?? 360) < 360) ||
    (part.type === 'mesh' && mesh !== undefined);
  if (!offCenter) return [0, 0, 0];
  const c = boundsCenter(localBounds(part, mesh));
  return [c[0] + 0, c[1] + 0, c[2] + 0]; // −0 + 0 is 0
}

/** The part's center in model space: `position + R·c_local` (§0.1). */
export function partCenter(part: Part, mesh?: ColoredMesh): Vec3 {
  const c = localCenter(part, mesh);
  if (c[0] === 0 && c[1] === 0 && c[2] === 0) return [part.position[0], part.position[1], part.position[2]];
  return localToWorld(part, c);
}

/** The `position` that puts the part's center at `center` (§3.3 step 3: `position = center − R·c_local`). */
export function positionForCenter(part: Part, center: Vec3, mesh?: ColoredMesh): Vec3 {
  const c = localCenter(part, mesh);
  if (c[0] === 0 && c[1] === 0 && c[2] === 0) return [center[0], center[1], center[2]];
  const rc = mulMat3Vec(eulerXYZToMat3(part.rotationDeg), c);
  return [center[0] - rc[0], center[1] - rc[1], center[2] - rc[2]];
}

/**
 * The tight axis-aligned bounding box of the part in model space: the exact extent of the rotated builder solid
 * (not the box around its rotated local box). A mesh part without `mesh` uses the corners of its `bboxIn` box.
 */
export function worldBounds(part: Part, mesh?: ColoredMesh): Bounds {
  return boundsWith(part, eulerXYZToMat3(part.rotationDeg), part.position, mesh);
}

/** The bounding box of the whole model. `meshes` (keyed by meshRef) tightens the boxes of mesh parts. */
export function modelBounds(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>): Bounds {
  let all: Bounds | null = null;
  for (const part of model.parts) {
    const b = worldBounds(part, part.type === 'mesh' ? meshes?.[part.dims.meshRef] : undefined);
    all = all ? unionBounds(all, b) : b;
  }
  return all ?? { min: [0, 0, 0], max: [0, 0, 0] };
}

/** The model's bounding-box height — its finished height (§4.2). */
export function modelHeight(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>): number {
  const b = modelBounds(model, meshes);
  return b.max[1] - b.min[1];
}

/**
 * The ground center, the point the whole model is scaled about (§4.2): on the ground under the model's origin —
 * x = 0 (the mirror plane), z = 0, y = the model's lowest point. Scaling about it keeps mirror pairs mirrored
 * across x = 0 and the lowest point where it is; for a grounded model it multiplies every coordinate and
 * dimension by the factor.
 */
export function groundCenter(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>): Vec3 {
  const minY = modelBounds(model, meshes).min[1];
  return [0, Number.isFinite(minY) ? minY : 0, 0];
}

/** A copy of the part moved by `d`. */
export function translatePart<P extends Part>(part: P, d: Vec3): P {
  return { ...part, position: [part.position[0] + d[0], part.position[1] + d[1], part.position[2] + d[2]] };
}

/**
 * Grounding (§0.1, §3.7.6): translates every part so the model's lowest point is at y = 0. Returns the new
 * model and the shift `dy` that was added to every `position[1]` (0 when the model is already grounded or its
 * bounds are not finite). Positions are not rounded here.
 */
export function groundModel<M extends Pick<CrochetModelV1, 'parts'>>(model: M, meshes?: Record<string, ColoredMesh>): { model: M; dy: number } {
  const minY = modelBounds(model, meshes).min[1];
  const dy = Number.isFinite(minY) && minY !== 0 ? -minY : 0;
  if (dy === 0) return { model, dy: 0 };
  return { model: { ...model, parts: model.parts.map((p) => translatePart(p, [0, dy, 0])) }, dy };
}

/**
 * Rounds every length and angle a kernel may have derived — positions, rotations, dims (profiles and polygon
 * points included), `crochet.seed`, region lengths, feature sizes and `finishedSize` — to `decimals` places
 * (default 1e-6), with −0 written as 0. Authored fractions and directions (from/to, azimuth, elevation) are
 * left alone.
 */
export function roundModel<M extends CrochetModelV1>(model: M, decimals = COORD_DECIMALS): M {
  const rc = (x: number): number => roundCoord(x, decimals);
  const size = model.finishedSize;
  const finishedSize = { ...size, height: rc(size.height) };
  if (size.width !== undefined) finishedSize.width = rc(size.width);
  if (size.depth !== undefined) finishedSize.depth = rc(size.depth);
  const out: M = { ...model, finishedSize, parts: model.parts.map((p) => roundPart(p, decimals)) };
  if (model.features) {
    out.features = model.features.map((f) => {
      const g = { ...f };
      if (g.sizeIn !== undefined) g.sizeIn = rc(g.sizeIn);
      if (g.sizeMm !== undefined) g.sizeMm = rc(g.sizeMm);
      return g;
    });
  }
  return out;
}

/** `roundModel` for one part. */
export function roundPart<P extends Part>(part: P, decimals = COORD_DECIMALS): P {
  const rc = (x: number): number => roundCoord(x, decimals);
  const out: P = { ...part, position: roundVec3(part.position, decimals), dims: roundDims(part.dims, rc) as P['dims'] };
  if (part.rotationDeg) out.rotationDeg = roundVec3(part.rotationDeg, decimals);
  if (part.regions) {
    out.regions = part.regions.map((r) => {
      if (r.kind === 'stripes') return { ...r, widthIn: rc(r.widthIn) };
      if (r.kind === 'spot') return { ...r, radiusIn: rc(r.radiusIn) };
      if (r.kind === 'pattern' && r.scaleIn !== undefined) return { ...r, scaleIn: rc(r.scaleIn) };
      return r;
    });
  }
  if (part.crochet?.seed) out.crochet = { ...part.crochet, seed: roundVec3(part.crochet.seed, decimals) };
  return out;
}

function roundDims(value: unknown, rc: (x: number) => number): unknown {
  if (typeof value === 'number') return rc(value);
  if (Array.isArray(value)) return value.map((v) => roundDims(v, rc));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'sharp' ? v : roundDims(v, rc);
    return out;
  }
  return value;
}
