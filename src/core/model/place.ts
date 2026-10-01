// Placing a child on its parent's surface, and keeping it there when the parent changes (DESIGN.md §3.3 step 3,
// §4.2 "Re-anchoring children"). Step 0 kernel, shared by the seed builder's stacking (T7), the editor's Add
// part and re-anchoring (T6) and `applyProportions`.
//
// Surfaces come from the analytic SDFs of §3.7.6 (bisection well below the 1e-4 in of §3.3); a mesh part uses
// the SDF the caller supplies, else ray casts on its triangles, else the ellipsoid inscribed in its bounding
// box. Extents always come from the builder geometry, never from `position` (a lathe's `position` is its base).
import type { PlaceChildOnSurfaceFn } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import { DEG2RAD, mulMat3Vec, normalize, RAD2DEG, transpose3 } from '../kernel/vec';
import { attachGraph, subtreeIds } from './attach';
import { localSdf, type MeshSdf, meshSdfOf, sdfNormal, type WorldSdf, worldSdf } from './sdf';
import { boundsSize, eulerXYZToMat3, localBounds, partCenter, positionForCenter, roundVec3, translatePart } from './transforms';

/** How far a sewn child enters its parent along the stacking ray (§3.3 step 3), inches. */
export const DEFAULT_OVERLAP_IN = 0.1;

/** Where the kernels may take the surface of a mesh part from. Both records are keyed by meshRef. */
export interface SurfaceSources {
  /** Part-local SDFs, positive inside (usually sampled from the stored `sdf:<meshRef>` volume). */
  meshSdf?: Record<string, MeshSdf>;
  /** Part-local triangle buffers. */
  meshes?: Record<string, ColoredMesh>;
}

/** A part's surface as the placement kernels see it. */
interface Surface {
  /** The part's center in model space (§0.1). */
  center: Vec3;
  /** The signed distance in model space, positive inside; absent for a mesh part known only by its triangles. */
  sdf?: WorldSdf;
  /** The outermost point of the surface on a ray: its distance from `origin` and the outward normal there. */
  exit(origin: Vec3, dir: Vec3): { t: number; normal: Vec3 } | null;
}

/** Convex solids: a ray from an inside point leaves them exactly once, so a plain bisection finds the exit. */
function isConvex(part: Part): boolean {
  switch (part.type) {
    case 'sphere':
    case 'ellipsoid':
    case 'capsule':
    case 'cylinder':
    case 'cone':
    case 'box':
      return true;
    default:
      return false;
  }
}

/** A radius around the part's center that contains the whole part. */
function reachOf(part: Part, mesh?: ColoredMesh): number {
  const size = boundsSize(localBounds(part, mesh));
  const r = Math.hypot(size[0], size[1], size[2]) / 2;
  return (Number.isFinite(r) ? r : 0) * 1.01 + 1e-3;
}

const along = (o: Vec3, d: Vec3, t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];

/**
 * The largest t in [0, tMax] at which the ray `origin + t·dir` is on or inside the solid — its outermost surface
 * point on that ray — or `null` when the ray never touches the solid. `convex` allows the direct bisection.
 */
function exitDistance(f: WorldSdf, origin: Vec3, dir: Vec3, tMax: number, convex: boolean): number | null {
  const at = (t: number): number => f(origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t);
  let outside = tMax;
  let inside: number | null = null;
  if (at(tMax) >= 0) return tMax;
  if (convex && at(0) >= 0) {
    inside = 0;
  } else {
    // March inward from outside. The distance is a lower bound of how far the surface is, so a step of 0.9·|f|
    // cannot jump over it; the floor on the step bounds the work on grazing rays.
    const minStep = Math.max(1e-5, tMax * 2e-4);
    let t = tMax;
    let v = at(t);
    for (let i = 0; i < 20000 && inside === null; i++) {
      const next = t - Math.max(minStep, -v * 0.9);
      if (next <= 0) {
        if (at(0) >= 0) inside = 0;
        outside = t;
        break;
      }
      const vNext = at(next);
      if (vNext >= 0) {
        inside = next;
        outside = t;
        break;
      }
      t = next;
      v = vNext;
      if (!Number.isFinite(v)) return null;
    }
    if (inside === null) return null;
  }
  let lo = inside;
  let hi = outside;
  for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The outermost hit of a ray on a triangle mesh (part-local buffers), with the outward normal of that triangle. */
function meshExit(part: Part, mesh: ColoredMesh, origin: Vec3, dir: Vec3): { t: number; normal: Vec3 } | null {
  const r = eulerXYZToMat3(part.rotationDeg);
  const rt = transpose3(r);
  const o = mulMat3Vec(rt, [origin[0] - part.position[0], origin[1] - part.position[1], origin[2] - part.position[2]]);
  const d = mulMat3Vec(rt, dir);
  const p = mesh.positions;
  const idx = mesh.indices;
  let best = -1;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = 0; k + 2 < idx.length; k += 3) {
    const a = 3 * idx[k];
    const b = 3 * idx[k + 1];
    const c = 3 * idx[k + 2];
    const e1x = p[b] - p[a];
    const e1y = p[b + 1] - p[a + 1];
    const e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a];
    const e2y = p[c + 1] - p[a + 1];
    const e2z = p[c + 2] - p[a + 2];
    // Möller–Trumbore
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const sx = o[0] - p[a];
    const sy = o[1] - p[a + 1];
    const sz = o[2] - p[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && t > best) {
      best = t;
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
    }
  }
  if (best < 0) return null;
  let normal = normalize(mulMat3Vec(r, [nx, ny, nz]), dir);
  // At the outermost hit the ray leaves the solid, so the outward normal points along it.
  if (normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
  return { t: best, normal };
}

function surfaceOf(part: Part, sources?: SurfaceSources): Surface {
  const supplied = meshSdfOf(part, sources?.meshSdf);
  const mesh = part.type === 'mesh' && sources?.meshes && Object.hasOwn(sources.meshes, part.dims.meshRef) ? sources.meshes[part.dims.meshRef] : undefined;
  const center = partCenter(part, mesh);
  if (part.type === 'mesh' && !supplied && mesh && mesh.indices.length >= 3) {
    return { center, exit: (origin, dir) => meshExit(part, mesh, origin, dir) };
  }
  const sdf = worldSdf(part, supplied);
  const convex = isConvex(part);
  const reach = reachOf(part, mesh);
  return {
    center,
    sdf,
    exit: (origin, dir) => {
      // The ray may start away from the center; reach far enough to be outside the part for sure.
      const tMax = reach + Math.hypot(origin[0] - center[0], origin[1] - center[1], origin[2] - center[2]);
      const t = exitDistance(sdf, origin, dir, tMax, convex);
      return t === null ? null : { t, normal: sdfNormal(sdf, along(origin, dir, t)) };
    },
  };
}

/**
 * The distance from `origin` along `dir` (model space; `dir` is normalized here) to the OUTERMOST point of the
 * part's surface on that ray, or `null` when the ray misses the part. From the part's center this is how far
 * the part reaches in that direction.
 */
export function surfaceExit(part: Part, origin: Vec3, dir: Vec3, sources?: SurfaceSources): number | null {
  const hit = surfaceOf(part, sources).exit(origin, normalize(dir));
  return hit === null ? null : hit.t;
}

/**
 * Where the child's center goes: on the line through `anchor` along the unit vector `n`, so that the child's
 * surface is `overlap` past `anchor` against `n` (inside the parent, whose surface is at `anchor`).
 */
function centerOnSurface(child: Surface, anchor: Vec3, n: Vec3, overlap: number): Vec3 {
  const back: Vec3 = [-n[0], -n[1], -n[2]];
  const reachBack = child.exit(child.center, back)?.t ?? 0;
  return along(anchor, n, reachBack - overlap);
}

function placeWith(parent: Part, child: Part, at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 }, overlapIn: number, sources?: SurfaceSources): Part {
  const overlap = Number.isFinite(overlapIn) ? overlapIn : DEFAULT_OVERLAP_IN;
  const childSurface = surfaceOf(child, sources);
  let anchor: Vec3;
  let n: Vec3;
  if ('dir' in at) {
    n = normalize(at.dir);
    const parentSurface = surfaceOf(parent, sources);
    const hit = parentSurface.exit(parentSurface.center, n);
    // A ray that misses the parent (through the hole of a torus): start from the parent's center.
    anchor = along(parentSurface.center, n, hit?.t ?? 0);
  } else {
    n = normalize(at.normal);
    anchor = [at.hit[0], at.hit[1], at.hit[2]];
  }
  const center = centerOnSurface(childSurface, anchor, n, overlap);
  const mesh = child.type === 'mesh' ? sources?.meshes?.[child.dims.meshRef] : undefined;
  return { ...child, position: roundVec3(positionForCenter(child, center, mesh)) };
}

/**
 * Puts a child on its parent's surface (§3.3 step 3; the editor's Add part, §4.2). Returns the child with a new
 * `position`; its rotation and dims are kept, and `attach` is the caller's to set.
 *
 * `{ dir }` (model space; top +Y, bottom −Y, front +Z, back −Z, left +X, right −X; normalized here): the
 * child's center goes on the ray from the parent's center along `dir`, at the distance where the child's
 * surface has entered the parent's surface by `overlapIn` along that ray.
 * `{ hit, normal }`: the same along the outward `normal` at the surface point `hit` (a click on the parent).
 *
 * `overlapIn` defaults to 0.10 in; a negative value leaves a gap. `o.meshSdf` is the part-local SDF of the mesh
 * part of the pair (the parent's when both are mesh parts); a mesh part without one is the ellipsoid inscribed
 * in its bounding box. The position is rounded to 1e-6 in.
 */
export const placeChildOnSurface: PlaceChildOnSurfaceFn = (parent, child, at, overlapIn = DEFAULT_OVERLAP_IN, o) => {
  let sources: SurfaceSources | undefined;
  if (o?.meshSdf) {
    const owner = parent.type === 'mesh' ? parent : child.type === 'mesh' ? child : undefined;
    if (owner?.type === 'mesh') sources = { meshSdf: { [owner.dims.meshRef]: o.meshSdf } };
  }
  return placeWith(parent, child, at, overlapIn, sources);
};

/** `placeChildOnSurface` with the surfaces of any number of mesh parts (SDFs or triangle buffers, by meshRef). */
export function placeChildOnSurfaceWith(
  parent: Part,
  child: Part,
  at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 },
  overlapIn = DEFAULT_OVERLAP_IN,
  sources?: SurfaceSources,
): Part {
  return placeWith(parent, child, at, overlapIn, sources);
}

/**
 * How far the child's surface has entered the parent's along the ray from the parent's center through the
 * child's center (§3.3 step 3): positive = overlap, negative = gap. This is the `overlapIn` that
 * `placeChildOnSurface(parent, child, { dir: that ray })` would need to leave the child where it is.
 */
export function overlapAlongRay(parent: Part, child: Part, sources?: SurfaceSources): number {
  const p = surfaceOf(parent, sources);
  const c = surfaceOf(child, sources);
  const d: Vec3 = [c.center[0] - p.center[0], c.center[1] - p.center[1], c.center[2] - p.center[2]];
  const distance = Math.hypot(d[0], d[1], d[2]);
  const n = normalize(d);
  const reachOut = p.exit(p.center, n)?.t ?? 0;
  const reachBack = c.exit(c.center, [-n[0], -n[1], -n[2]])?.t ?? 0;
  return reachOut + reachBack - distance;
}

// ---- re-anchoring (§4.2)

/**
 * A child's attach anchor in its parent's frame: a direction from the parent's center (§0.1) and a signed
 * offset along the parent's surface normal. `azimuthDeg` 0° = the parent's +Z, +90° = its +X; `elevationDeg`
 * +90° = its +Y (§3.5.2).
 */
export interface AttachAnchor {
  azimuthDeg: number;
  elevationDeg: number;
  /** The contact point's distance from the parent's surface along the outward normal; negative = inside. */
  offsetIn: number;
  /** The anchor in model space when it was captured: the surface point on that direction + offset·normal. */
  point: Vec3;
}

/** Samples per axis of the contact grid; odd, so the child's own planes of symmetry are sampled. */
const CONTACT_GRID = 21;

/**
 * The contact point the anchor follows: the centroid of the volume the child shares with its parent, or — when
 * the child does not enter the parent — of the layer of the child nearest the parent.
 *
 * It is measured on a regular grid in the CHILD's local frame (cell centers of its bounding box), not on the
 * builder's triangles: the grid is symmetric about the child's local planes, so a centered child gets a
 * centered anchor and mirror twins get mirrored anchors, however the builder happens to tessellate.
 * A mesh child known only by its triangles is sampled at its vertices; a mesh parent known only by its
 * triangles has no inside test, and the child's center is used.
 */
function contactPoint(parent: Surface, child: Part, childCenter: Vec3, sources?: SurfaceSources): Vec3 {
  const f = parent.sdf;
  if (!f) return childCenter;
  const r = eulerXYZToMat3(child.rotationDeg);
  const [px, py, pz] = child.position;
  const supplied = meshSdfOf(child, sources?.meshSdf);
  const mesh = child.type === 'mesh' && !supplied ? sources?.meshes?.[child.dims.meshRef] : undefined;

  // The sample points of the child, in model space, with the parent's signed distance at each.
  const points: number[] = [];
  let layer: number;
  const add = (x: number, y: number, z: number): void => {
    const wx = r[0] * x + r[1] * y + r[2] * z + px;
    const wy = r[3] * x + r[4] * y + r[5] * z + py;
    const wz = r[6] * x + r[7] * y + r[8] * z + pz;
    points.push(wx, wy, wz, f(wx, wy, wz));
  };
  if (mesh) {
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) add(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    layer = reachOf(child, mesh) / CONTACT_GRID;
  } else {
    const inside = localSdf(child, supplied);
    const b = localBounds(child);
    const step: Vec3 = [(b.max[0] - b.min[0]) / CONTACT_GRID, (b.max[1] - b.min[1]) / CONTACT_GRID, (b.max[2] - b.min[2]) / CONTACT_GRID];
    for (let k = 0; k < CONTACT_GRID; k++) {
      const z = b.min[2] + (k + 0.5) * step[2];
      for (let j = 0; j < CONTACT_GRID; j++) {
        const y = b.min[1] + (j + 0.5) * step[1];
        for (let i = 0; i < CONTACT_GRID; i++) {
          const x = b.min[0] + (i + 0.5) * step[0];
          if (inside(x, y, z) >= 0) add(x, y, z);
        }
      }
    }
    layer = Math.max(step[0], step[1], step[2]);
  }

  let deepest = -Infinity;
  for (let i = 3; i < points.length; i += 4) if (points[i] > deepest) deepest = points[i];
  if (!Number.isFinite(deepest)) return childCenter;
  // Inside the parent when the child enters it; otherwise the layer of the child nearest the parent.
  const threshold = deepest >= 0 ? 0 : deepest - layer;
  let count = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < points.length; i += 4) {
    if (points[i + 3] >= threshold) {
      count++;
      sx += points[i];
      sy += points[i + 1];
      sz += points[i + 2];
    }
  }
  return count > 0 ? [sx / count, sy / count, sz / count] : childCenter;
}

function anchorOn(parentPart: Part, parent: Surface, azimuthDeg: number, elevationDeg: number, offsetIn: number): Vec3 {
  const az = azimuthDeg * DEG2RAD;
  const el = elevationDeg * DEG2RAD;
  const local: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  const u = mulMat3Vec(eulerXYZToMat3(parentPart.rotationDeg), local);
  const hit = parent.exit(parent.center, u);
  if (hit === null) return along(parent.center, u, offsetIn);
  return along(along(parent.center, u, hit.t), hit.normal, offsetIn);
}

/**
 * Captures a child's attach anchor on its parent (§4.2): the direction from the parent's center to the
 * child's contact point, in the parent's frame, and that point's signed offset along the surface normal.
 */
export function captureAnchor(parent: Part, child: Part, sources?: SurfaceSources): AttachAnchor {
  const p = surfaceOf(parent, sources);
  const childMesh = child.type === 'mesh' ? sources?.meshes?.[child.dims.meshRef] : undefined;
  const childCenter = partCenter(child, childMesh);
  let q = contactPoint(p, child, childCenter, sources);
  let d: Vec3 = [q[0] - p.center[0], q[1] - p.center[1], q[2] - p.center[2]];
  if (Math.hypot(d[0], d[1], d[2]) < 1e-9) {
    q = childCenter;
    d = [q[0] - p.center[0], q[1] - p.center[1], q[2] - p.center[2]];
  }
  const u = normalize(d);
  const local = mulMat3Vec(transpose3(eulerXYZToMat3(parent.rotationDeg)), u);
  const azimuthDeg = Math.atan2(local[0], local[2]) * RAD2DEG;
  const elevationDeg = Math.asin(Math.min(1, Math.max(-1, local[1]))) * RAD2DEG;
  const hit = p.exit(p.center, u);
  let offsetIn: number;
  if (hit === null) {
    offsetIn = Math.hypot(d[0], d[1], d[2]);
  } else {
    const s = along(p.center, u, hit.t);
    offsetIn = (q[0] - s[0]) * hit.normal[0] + (q[1] - s[1]) * hit.normal[1] + (q[2] - s[2]) * hit.normal[2];
  }
  return { azimuthDeg, elevationDeg, offsetIn, point: anchorOn(parent, p, azimuthDeg, elevationDeg, offsetIn) };
}

/** Re-projects an anchor onto a parent (usually the edited one): the model-space point it now names. */
export function anchorPoint(parent: Part, anchor: Pick<AttachAnchor, 'azimuthDeg' | 'elevationDeg' | 'offsetIn'>, sources?: SurfaceSources): Vec3 {
  return anchorOn(parent, surfaceOf(parent, sources), anchor.azimuthDeg, anchor.elevationDeg, anchor.offsetIn);
}

/**
 * Re-anchors the direct children of an edited parent (§4.2): each child's anchor is captured on the parent as
 * it was in `before`, re-projected onto the parent as it is in `after`, and the child's whole attach subtree
 * in `after` is translated by the anchor's displacement. Children keep their rotation; no other part moves.
 * Positions are rounded to 1e-6 in. `o.before` / `o.after` supply the surfaces of mesh parts.
 */
export function reanchorChildren(
  before: CrochetModelV1,
  after: CrochetModelV1,
  parentId: string,
  o?: { before?: SurfaceSources; after?: SurfaceSources },
): CrochetModelV1 {
  const graph = attachGraph(before.parts);
  const at = graph.index.get(parentId);
  const parentAfter = after.parts.find((p) => p.id === parentId);
  if (at === undefined || !parentAfter) return after;
  const parentBefore = before.parts[at];
  const move = new Map<string, Vec3>();
  for (const c of graph.children[at]) {
    const child = before.parts[c];
    const anchor = captureAnchor(parentBefore, child, o?.before);
    const target = anchorPoint(parentAfter, anchor, o?.after);
    const d: Vec3 = [target[0] - anchor.point[0], target[1] - anchor.point[1], target[2] - anchor.point[2]];
    if (!(Number.isFinite(d[0]) && Number.isFinite(d[1]) && Number.isFinite(d[2]))) continue;
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
    for (const id of subtreeIds(before, child.id)) if (!move.has(id)) move.set(id, d);
  }
  if (move.size === 0) return after;
  return {
    ...after,
    parts: after.parts.map((p) => {
      const d = move.get(p.id);
      if (!d) return p;
      const moved = translatePart(p, d);
      return { ...moved, position: roundVec3(moved.position) };
    }),
  };
}
