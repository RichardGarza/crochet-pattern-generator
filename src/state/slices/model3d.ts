// Track T6 — the 3D editor's slice (DESIGN.md §4.2, §4.4, §5.3): pure model edits ("recipes" on a
// `CrochetModelV1`) and the few store actions that run them through `projectStore.update`, the only way to change
// authored data.
//
// Every edit here is pure and deterministic: it never mutates its input, returns the same object when nothing
// changes, keeps every part it does not touch (the same object: §4.4's "the editor never rewrites a part the user did
// not touch" holds by identity, and the history diff skips shared branches), and rounds the coordinates it derives
// to 1e-6 like the model kernels (`roundCoord`).
//
// Transforms (§4.2): Move and Rotate apply one rigid motion to the selected part AND its attach subtree
// ('subtree'), or to the part alone ('alone', ⌥). Rotation is about the part's center (§0.1). Scaling and
// parameter edits change `dims` and RE-ANCHOR the direct children (`reanchorChildren`, the kernel of §4.2): each
// child's subtree is translated by the displacement of its anchor on the parent's surface; children keep their
// rotation and size.
import { original, isDraft, type Draft } from 'immer';
import { attachGraph, GAP_WARN_IN, GAP_FLOAT_IN, subtreeIds } from '../../core/model/attach';
import { mulMat3, type Mat3 } from '../../core/kernel/vec';
import { MODEL_LIMITS } from '../../core/model/limits';
import { DEFAULT_OVERLAP_IN, placeChildOnSurface, reanchorChildren } from '../../core/model/place';
import { LIMB_PROXIMAL_KEY } from '../../core/model/proportions';
import { partVolume, surfaceGap } from '../../core/model/sdf';
import {
  boundsSize,
  composeRigid,
  decomposeRigid,
  eulerXYZToMat3,
  invertRigid,
  localBounds,
  mat3ToEulerXYZ,
  multiplyRigid,
  partAxis,
  partCenter,
  positionForCenter,
  roundCoord,
  roundVec3,
  type Rigid,
} from '../../core/model/transforms';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Feature, Part, PartCrochetHints, Region, Vec3 } from '../../types/model';
import type { ProjectDoc } from '../../types/project';
import { projectStore, type ProjectStore } from '../projectStore';

// ---- types

/** §4.2: 'subtree' = the part and everything attached below it move together; 'alone' = ⌥ held. */
export type TransformScope = 'subtree' | 'alone';

/** A pure edit of the model. Returns its input when nothing changes. */
export type ModelEdit = (model: CrochetModelV1) => CrochetModelV1;

/** The pose of the gizmo's pivot: a part's CENTER (§0.1) and its rotation. */
export interface Pivot {
  center: Vec3;
  rotationDeg: Vec3;
}

export const SNAP_MOVE_IN = 0.05;
export const SNAP_ROTATE_DEG = 5;
/** Changed dims snap to this grid while snapping is on (§4.2 "snap 0.05 in"). */
export const SNAP_DIM_IN = 0.05;
/** §4.2: re-anchoring during a drag runs at most 10 times a second (and always on release). */
export const REANCHOR_INTERVAL_MS = 100;

const IDENTITY: Vec3 = [0, 0, 0];

// ---- small helpers

function byId(model: Pick<CrochetModelV1, 'parts'>, id: string): Part | undefined {
  return model.parts.find((p) => p.id === id);
}

function isIdentityRotation(r: Rigid['rotation']): boolean {
  return r[0] === 1 && r[1] === 0 && r[2] === 0 && r[3] === 0 && r[4] === 1 && r[5] === 0 && r[6] === 0 && r[7] === 0 && r[8] === 1;
}

const isFiniteVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

function sameVec(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
  const x = a ?? IDENTITY;
  const y = b ?? IDENTITY;
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/** Replaces parts by id; parts not in `next` stay the same objects. Returns `model` when nothing changed. */
function withParts(model: CrochetModelV1, next: ReadonlyMap<string, Part>): CrochetModelV1 {
  let changed = false;
  const parts = model.parts.map((p) => {
    const q = next.get(p.id);
    if (q && q !== p) {
      changed = true;
      return q;
    }
    return p;
  });
  return changed ? { ...model, parts } : model;
}

/** The ids a transform of `partId` moves. */
export function affectedIds(model: Pick<CrochetModelV1, 'parts'>, partId: string, scope: TransformScope): string[] {
  if (!byId(model, partId)) return [];
  return scope === 'alone' ? [partId] : subtreeIds(model, partId);
}

// ---- rigid transforms (Move, Rotate)

/**
 * Applies the world-space rigid motion `m` to one part: `World' = m · World`. A pure translation keeps
 * `rotationDeg` exactly as written (no Euler round trip); positions and angles are rounded to 1e-6.
 */
export function applyRigidToPart<P extends Part>(part: P, m: Rigid): P {
  if (isIdentityRotation(m.rotation)) {
    if (m.position[0] === 0 && m.position[1] === 0 && m.position[2] === 0) return part;
    const position = roundVec3([part.position[0] + m.position[0], part.position[1] + m.position[1], part.position[2] + m.position[2]]);
    return sameVec(position, part.position) ? part : { ...part, position };
  }
  const world = multiplyRigid(m, composeRigid(part.position, part.rotationDeg));
  const d = decomposeRigid(world);
  return { ...part, position: roundVec3(d.position), rotationDeg: roundVec3(d.rotationDeg) };
}

/** Applies `m` to `partId` and, for 'subtree', to every part attached below it. */
export function transformPart(model: CrochetModelV1, partId: string, m: Rigid, scope: TransformScope = 'subtree'): CrochetModelV1 {
  const ids = affectedIds(model, partId, scope);
  if (ids.length === 0) return model;
  const next = new Map<string, Part>();
  for (const id of ids) {
    const p = byId(model, id);
    if (p) next.set(id, applyRigidToPart(p, m));
  }
  return withParts(model, next);
}

/** Moves `partId` (and its subtree) by `delta` inches. */
export function movePart(model: CrochetModelV1, partId: string, delta: Vec3, scope: TransformScope = 'subtree'): CrochetModelV1 {
  if (!isFiniteVec3(delta)) return model;
  return transformPart(model, partId, { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: delta }, scope);
}

/** The rigid motion that rotates by `rotationDeg` (Euler XYZ) about the world point `center`. */
export function rotationAbout(center: Vec3, rotationDeg: Vec3): Rigid {
  const pivot = composeRigid(center);
  return multiplyRigid(multiplyRigid(pivot, composeRigid(IDENTITY, rotationDeg)), invertRigid(pivot));
}

/**
 * The gizmo's drag: the pivot (a part's center and rotation) went from `from` to `to`. The motion
 * `m = to · from⁻¹` is applied to the part and, for 'subtree', to its attach subtree — so a rotation turns the
 * subtree about the part's center and a move carries it along (§4.2).
 */
export function transformByPivot(model: CrochetModelV1, partId: string, from: Pivot, to: Pivot, scope: TransformScope = 'subtree'): CrochetModelV1 {
  if (![from.center, from.rotationDeg, to.center, to.rotationDeg].every(isFiniteVec3)) return model;
  // Compared as matrices: a gizmo's degrees → radians → degrees round trip is not exact (12 → 12.000000000000002),
  // and a move must never rewrite an angle.
  const ra = eulerXYZToMat3(from.rotationDeg);
  const rb = eulerXYZToMat3(to.rotationDeg);
  const sameRotation = ra.every((v, i) => Math.abs(v - rb[i]) <= 1e-9);
  const m: Rigid = sameRotation
    ? { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [to.center[0] - from.center[0], to.center[1] - from.center[1], to.center[2] - from.center[2]] }
    : multiplyRigid(composeRigid(to.center, to.rotationDeg), invertRigid(composeRigid(from.center, from.rotationDeg)));
  return transformPart(model, partId, m, scope);
}

/** The gizmo pivot of a part: its center (§0.1) and its rotation. */
export function pivotOf(part: Part): Pivot {
  return { center: partCenter(part), rotationDeg: part.rotationDeg ? [...part.rotationDeg] : [0, 0, 0] };
}

/** Inspector: sets a part's position (its local origin, §0.1); the subtree follows unless 'alone'. */
export function setPartPosition(model: CrochetModelV1, partId: string, position: Vec3, scope: TransformScope = 'subtree'): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || !isFiniteVec3(position)) return model;
  return movePart(model, partId, [position[0] - p.position[0], position[1] - p.position[1], position[2] - p.position[2]], scope);
}

/**
 * Inspector: sets a part's rotation (Euler XYZ degrees), turning it about its center; the subtree turns with it
 * unless 'alone'. The part gets exactly `rotationDeg` (rounded), not an Euler round trip of it.
 */
export function setPartRotation(model: CrochetModelV1, partId: string, rotationDeg: Vec3, scope: TransformScope = 'subtree'): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || !isFiniteVec3(rotationDeg)) return model;
  const target = roundVec3(rotationDeg);
  if (sameVec(target, p.rotationDeg)) return model;
  const center = partCenter(p);
  const moved = transformByPivot(model, partId, { center, rotationDeg: p.rotationDeg ?? [0, 0, 0] }, { center, rotationDeg: target }, scope);
  // Pin the part's own angles to what was typed (the decomposition may choose an equivalent triple).
  const q = byId(moved, partId);
  if (!q) return moved;
  const exact: Part = { ...q, rotationDeg: target, position: roundVec3(positionForCenter({ ...q, rotationDeg: target }, center)) };
  return withParts(moved, new Map([[partId, exact]]));
}

// ---- dims (Scale, Parameters)

const { minDimIn: MIN_DIM, maxDimIn: MAX_DIM } = MODEL_LIMITS;

/** A length clamped to the schema's [0.05, 48] in (§3.5.2) and rounded to 1e-6. */
export function clampDim(x: number): number {
  if (!Number.isFinite(x)) return MIN_DIM;
  return roundCoord(Math.min(MAX_DIM, Math.max(MIN_DIM, x)));
}

/** A lathe profile radius: [0, 48]. */
function clampRadius(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return roundCoord(Math.min(MAX_DIM, Math.max(0, x)));
}

function snapTo(x: number, grid: number): number {
  return Math.max(grid, Math.round(x / grid) * grid);
}

/** The factor of a radial dimension when the part-local X and Z factors differ: the one that moved most. */
function radial(sx: number, sz: number): number {
  return Math.abs(Math.log(sx)) >= Math.abs(Math.log(sz)) ? sx : sz;
}

/**
 * Keeps a part's dims valid: every length in [0.05, 48], a capsule at least as long as its two caps (`length ≥
 * 2r`; `lengthFirst` keeps the length and lowers r instead), a torus arc in (0, 360], a lathe profile with
 * non-negative radii and non-decreasing heights.
 */
export function normalizeDims<P extends Part>(part: P, o: { lengthFirst?: boolean } = {}): P {
  const p = part as Part;
  switch (p.type) {
    case 'sphere':
      return { ...part, dims: { ...p.dims, r: clampDim(p.dims.r) } };
    case 'ellipsoid':
      return { ...part, dims: { ...p.dims, rx: clampDim(p.dims.rx), ry: clampDim(p.dims.ry), rz: clampDim(p.dims.rz) } };
    case 'capsule': {
      let r = clampDim(p.dims.r);
      let length = clampDim(p.dims.length);
      if (length < 2 * r) {
        // A capsule is never shorter than two caps of the smallest radius (0.1 in).
        if (o.lengthFirst) {
          length = Math.max(length, 2 * MIN_DIM);
          r = clampDim(length / 2);
        }
        else length = clampDim(2 * r);
        if (length < 2 * r) r = roundCoord(length / 2); // only at the 48 in ceiling
      }
      return { ...part, dims: { ...p.dims, r, length } };
    }
    case 'cylinder':
      return { ...part, dims: { ...p.dims, rTop: clampDim(p.dims.rTop), rBottom: clampDim(p.dims.rBottom), h: clampDim(p.dims.h) } };
    case 'cone':
      return { ...part, dims: { ...p.dims, r: clampDim(p.dims.r), h: clampDim(p.dims.h) } };
    case 'torus': {
      const dims: typeof p.dims = { ...p.dims, R: clampDim(p.dims.R), r: clampDim(p.dims.r) };
      if (dims.arcDeg !== undefined) dims.arcDeg = Number.isFinite(dims.arcDeg) ? Math.min(360, Math.max(1, roundCoord(dims.arcDeg))) : 360;
      return { ...part, dims };
    }
    case 'lathe': {
      let lastY = -Infinity;
      let profile = p.dims.profile.map(([r, y]): [number, number] => {
        const yy = Math.max(lastY, Number.isFinite(y) ? y : 0);
        lastY = yy;
        return [Number.isFinite(r) ? Math.max(0, r) : 0, yy];
      });
      // §3.5.2: the largest radius in [0.05, 48] and the height (last y − first y) in [0.05, 48], by scaling the
      // radii / the heights about the first point (the shape is kept).
      if (profile.length > 0) {
        const maxR = Math.max(...profile.map(([r]) => r));
        const fr = maxR > MAX_DIM ? MAX_DIM / maxR : maxR < MIN_DIM ? (maxR > 0 ? MIN_DIM / maxR : 1) : 1;
        const y0 = profile[0][1];
        const span = profile[profile.length - 1][1] - y0;
        const fy = span > MAX_DIM ? MAX_DIM / span : span < MIN_DIM ? (span > 0 ? MIN_DIM / span : 1) : 1;
        profile = profile.map(([r, y], i): [number, number] => [
          maxR > 0 ? r * fr : i === 0 ? 0 : MIN_DIM,
          span > 0 ? y0 + (y - y0) * fy : y0 + (i * MIN_DIM) / Math.max(1, profile.length - 1),
        ]);
      }
      profile = profile.map(([r, y]): [number, number] => [clampRadius(r), roundCoord(y)]);
      return { ...part, dims: { ...p.dims, profile } };
    }
    case 'flat': {
      const dims: typeof p.dims = { ...p.dims, w: clampDim(p.dims.w), h: clampDim(p.dims.h), thickness: clampDim(p.dims.thickness) };
      // Only a polygon has points (`normalizeFlatFrom` makes them follow a change of w and h).
      if (dims.shape !== 'polygon') delete dims.points;
      return { ...part, dims };
    }
    case 'box':
      return { ...part, dims: { ...p.dims, w: clampDim(p.dims.w), h: clampDim(p.dims.h), d: clampDim(p.dims.d) } };
    case 'mesh':
      return part;
  }
}

/**
 * The part's dims scaled by part-local factors `[sx, sy, sz]` (the scale gizmo works in the part's own axes).
 * A sphere scaled unevenly becomes an ellipsoid (§4.2). Radial dims (capsule, cylinder, cone, lathe radii) take
 * the X or Z factor that moved most; a torus ring (local XY) takes the X or Y factor for R and Z for its tube.
 * `snap`: every dim that changed is rounded to the 0.05 in grid. Mesh parts are returned unchanged (their
 * scale bakes into the vertex buffer: `canScale`).
 */
export function scaledDims(part: Part, factors: Vec3, o: { snap?: boolean } = {}): Part {
  if (!isFiniteVec3(factors) || factors.some((f) => f <= 0)) return part;
  const [sx, sy, sz] = factors;
  const s = (value: number, f: number): number => {
    if (f === 1) return value;
    const v = value * f;
    return o.snap ? snapTo(v, SNAP_DIM_IN) : v;
  };
  let next: Part;
  switch (part.type) {
    case 'sphere': {
      const { r } = part.dims;
      const radii = [s(r, sx), s(r, sy), s(r, sz)].map(clampDim);
      if (radii[0] === radii[1] && radii[1] === radii[2]) next = { ...part, dims: { r: radii[0] } };
      else {
        // An uneven sphere becomes an ellipsoid (§4.2).
        const { dims: _drop, type: _type, ...rest } = part;
        next = { ...rest, type: 'ellipsoid', dims: { rx: radii[0], ry: radii[1], rz: radii[2] } };
      }
      break;
    }
    case 'ellipsoid':
      next = { ...part, dims: { rx: s(part.dims.rx, sx), ry: s(part.dims.ry, sy), rz: s(part.dims.rz, sz) } };
      break;
    case 'capsule': {
      const fr = radial(sx, sz);
      next = { ...part, dims: { r: s(part.dims.r, fr), length: s(part.dims.length, sy) } };
      break;
    }
    case 'cylinder': {
      const fr = radial(sx, sz);
      next = { ...part, dims: { ...part.dims, rTop: s(part.dims.rTop, fr), rBottom: s(part.dims.rBottom, fr), h: s(part.dims.h, sy) } };
      break;
    }
    case 'cone': {
      const fr = radial(sx, sz);
      next = { ...part, dims: { r: s(part.dims.r, fr), h: s(part.dims.h, sy) } };
      break;
    }
    case 'torus': {
      const fR = radial(sx, sy);
      next = { ...part, dims: { ...part.dims, R: s(part.dims.R, fR), r: s(part.dims.r, sz) } };
      break;
    }
    case 'lathe': {
      const fr = radial(sx, sz);
      next = { ...part, dims: { ...part.dims, profile: part.dims.profile.map(([r, y]): [number, number] => [r * fr, y * sy]) } };
      break;
    }
    case 'flat':
      // normalizeDims carries a polygon's points along with w and h.
      next = { ...part, dims: { ...part.dims, w: s(part.dims.w, sx), h: s(part.dims.h, sy), thickness: s(part.dims.thickness, sz) } };
      return normalizeFlatFrom(part, next);
    case 'box':
      next = { ...part, dims: { w: s(part.dims.w, sx), h: s(part.dims.h, sy), d: s(part.dims.d, sz) } };
      break;
    case 'mesh':
      return part;
  }
  return normalizeDims(next, { lengthFirst: part.type === 'capsule' && sy !== 1 && radial(sx, sz) === 1 });
}

/** A flat part's new dims, with a polygon's points following the change of w and h from `before`. */
function normalizeFlatFrom(before: Extract<Part, { type: 'flat' }>, next: Part): Part {
  const n = normalizeDims(next) as Extract<Part, { type: 'flat' }>;
  if (n.dims.shape !== 'polygon' || !before.dims.points || before.dims.w <= 0 || before.dims.h <= 0) return n;
  const kx = n.dims.w / before.dims.w;
  const ky = n.dims.h / before.dims.h;
  if (kx === 1 && ky === 1) return n;
  return { ...n, dims: { ...n.dims, points: before.dims.points.map(([x, y]): [number, number] => [roundCoord(x * kx), roundCoord(y * ky)]) } };
}

/** Why a part cannot be scaled by the gizmo, or null. */
export function scaleBlockedReason(part: Part): string | null {
  return part.type === 'mesh' ? 'Sculpted (mesh) parts are resized in a later version of the editor' : null;
}

/**
 * Replaces the part `partId` by `nextPart` (new dims, maybe a new type) and re-anchors its direct children on
 * its new surface (§4.2). The children's subtrees are translated; nothing else moves.
 */
function replaceAndReanchor(model: CrochetModelV1, partId: string, nextPart: Part, reanchor = true): CrochetModelV1 {
  const after = withParts(model, new Map([[partId, nextPart]]));
  if (after === model || !reanchor) return after;
  return reanchorChildren(model, after, partId);
}

/** Options of the dims edits. `reanchor: false` changes the part alone (a drag's preview between re-anchors). */
export interface DimsEditOptions {
  reanchor?: boolean;
}

/**
 * Scale (R): the part's dims scaled by part-local `factors` about its CENTER (the gizmo's pivot: a lathe's
 * origin moves so its center stays put), children re-anchored. `snap` rounds the changed dims to 0.05 in.
 */
export function scalePart(model: CrochetModelV1, partId: string, factors: Vec3, o: { snap?: boolean } & DimsEditOptions = {}): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || scaleBlockedReason(p)) return model;
  const scaled = scaledDims(p, factors, o);
  if (scaled === p) return model;
  const center = partCenter(p);
  const placed = { ...scaled, position: roundVec3(positionForCenter(scaled, center)) } as Part;
  if (sameVec(placed.position, p.position)) placed.position = p.position;
  return replaceAndReanchor(model, partId, placed, o.reanchor ?? true);
}

/**
 * Parameters: sets a part's dims (normalized: §3.5.2 limits, capsule caps) keeping its position (its local
 * origin, §0.1), children re-anchored (§4.2). `changed` names the edited key, so a capsule whose new length is
 * below 2r lowers r instead of undoing the edit.
 */
export function setPartDims(model: CrochetModelV1, partId: string, dims: Part['dims'], o: { changed?: string } & DimsEditOptions = {}): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || p.type === 'mesh') return model;
  const raw = { ...p, dims } as Part;
  const candidate = p.type === 'flat' ? normalizeFlatFrom(p, raw) : normalizeDims(raw, { lengthFirst: o.changed === 'length' });
  if (JSON.stringify(candidate.dims) === JSON.stringify(p.dims)) return model;
  return replaceAndReanchor(model, partId, candidate, o.reanchor ?? true);
}

/** Sets one numeric dim (`key` of the part's dims). */
export function setPartDim(model: CrochetModelV1, partId: string, key: string, value: number, o: DimsEditOptions = {}): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || !Number.isFinite(value)) return model;
  const current = (p.dims as unknown as Record<string, unknown>)[key];
  const optionalArc = p.type === 'torus' && key === 'arcDeg';
  if (typeof current !== 'number' && !optionalArc) return model;
  return setPartDims(model, partId, { ...p.dims, [key]: value } as Part['dims'], { changed: key, reanchor: o.reanchor });
}

/** Sets a part's base color (a palette id). */
export function setPartColor(model: CrochetModelV1, partId: string, color: string): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p || p.color === color || !model.palette.some((c) => c.id === color)) return model;
  return withParts(model, new Map([[partId, { ...p, color }]]));
}

/** Sets a part's label; an empty label removes it (the id is shown instead). */
export function setPartLabel(model: CrochetModelV1, partId: string, label: string): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p) return model;
  const text = label.trim().slice(0, MODEL_LIMITS.maxTextChars);
  if ((p.label ?? '') === text) return model;
  const next: Part = { ...p };
  if (text) next.label = text;
  else delete next.label;
  return withParts(model, new Map([[partId, next]]));
}

// ---- the outliner (attach tree)

export interface PartNode {
  id: string;
  part: Part;
  depth: number;
  children: PartNode[];
}

/**
 * The attach tree for the outliner: roots in parts order, children in parts order. Parts whose links do not
 * form a tree (a cycle in an unvalidated model) are listed as roots so nothing is ever hidden.
 */
export function partTree(model: Pick<CrochetModelV1, 'parts'>): PartNode[] {
  const g = attachGraph(model.parts);
  const seen = new Set<number>();
  const build = (i: number, depth: number): PartNode => {
    seen.add(i);
    const children = g.children[i].filter((c) => !seen.has(c)).map((c) => build(c, depth + 1));
    return { id: model.parts[i].id, part: model.parts[i], depth, children };
  };
  const roots = g.roots.map((i) => build(i, 0));
  for (let i = 0; i < model.parts.length; i++) if (!seen.has(i)) roots.push(build(i, 0));
  return roots;
}

/** Depth-first order of the tree, skipping the children of collapsed nodes. */
export function visibleRows(tree: readonly PartNode[], collapsed: ReadonlySet<string>): PartNode[] {
  const out: PartNode[] = [];
  const walk = (n: PartNode) => {
    out.push(n);
    if (!collapsed.has(n.id)) n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

/** The ids of `partId`'s ancestors, nearest first. */
export function ancestorIds(model: Pick<CrochetModelV1, 'parts'>, partId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([partId]);
  let p = byId(model, partId);
  while (p?.attach?.to && !seen.has(p.attach.to)) {
    seen.add(p.attach.to);
    out.push(p.attach.to);
    p = byId(model, p.attach.to);
  }
  return out;
}

/** A part's display name: its label, else its id. */
export function partName(part: Pick<Part, 'id' | 'label'>): string {
  return part.label?.trim() || part.id;
}

// ---- validation shown by the editor

const gapCache = new WeakMap<Part, WeakMap<Part, number>>();

/** `surfaceGap(child, parent)`, memoized by the two part objects (parts are immutable). */
export function cachedGap(child: Part, parent: Part): number {
  let inner = gapCache.get(child);
  if (!inner) gapCache.set(child, (inner = new WeakMap()));
  let gap = inner.get(parent);
  if (gap === undefined) {
    gap = surfaceGap(child, parent);
    inner.set(parent, gap);
  }
  return gap;
}

/**
 * `W_GAP` (§2.13): every part whose gap to its parent is more than 0.1 in — what ⌥-moving a parent away from its
 * children raises (§4.2). Mesh parts without their buffers are measured as their `bboxIn` ellipsoid.
 */
export function gapIssues(model: Pick<CrochetModelV1, 'parts'>): Issue[] {
  const issues: Issue[] = [];
  for (const p of model.parts) {
    const to = p.attach?.to;
    if (!to) continue;
    const parent = byId(model, to);
    if (!parent) continue;
    const gap = cachedGap(p, parent);
    if (!(gap > GAP_WARN_IN)) continue;
    const name = partName(p);
    const parentName = partName(parent);
    const rounded = Math.round(gap * 100) / 100;
    issues.push({
      code: 'W_GAP',
      severity: 'warn',
      message:
        gap > GAP_FLOAT_IN
          ? `${name} floats ${rounded} in from ${parentName}: move it back so it can be sewn on`
          : `${name} has a ${rounded} in gap to ${parentName}`,
      where: { part: p.id },
    });
  }
  return issues;
}

// ---- store actions

function modelOf(doc: ProjectDoc | null): CrochetModelV1 | undefined {
  return doc?.threeD?.model;
}

/** The current model of a store's project, if any. */
export function currentModel(store: ProjectStore = projectStore): CrochetModelV1 | undefined {
  return modelOf(store.getState().doc);
}

/** `next` as the edit of `base`: the same object when nothing changed, else with `revision` + 1 (§3.5.1). */
export function withRevision(base: CrochetModelV1, next: CrochetModelV1): CrochetModelV1 {
  if (next === base) return base;
  return { ...next, revision: base.revision + 1 };
}

/** Options of the store actions: `linked: false` leaves mirror twins and stored limb ends alone (§4.2). */
export interface LinkOptions {
  /** Default true: the edit is followed by `linkEdit` (mirror-linked twins follow; stale `x-cpg-proximal` keys go). */
  linked?: boolean;
}

/** `edit`, followed by `linkEdit` unless `linked` is false. */
export function linkedEdit(edit: ModelEdit, o: LinkOptions = {}): ModelEdit {
  if (o.linked === false) return edit;
  return (m) => linkEdit(m, edit(m));
}

/** A projectStore recipe that applies a pure model edit to the open project's model (and bumps `revision`). */
export function modelRecipe(edit: ModelEdit, o: LinkOptions = {}): (draft: Draft<ProjectDoc>) => void {
  const run = linkedEdit(edit, o);
  return (draft) => {
    const threeD = draft.threeD;
    if (!threeD?.model) throw new Error('This project has no 3D model to edit');
    const base = (isDraft(threeD.model) ? original(threeD.model) : threeD.model) as CrochetModelV1;
    const next = withRevision(base, run(base));
    if (next !== base) threeD.model = next as Draft<CrochetModelV1>;
  };
}

/**
 * Applies a pure model edit as one history step (`label` is what Undo shows). Mirror-linked twins follow the
 * edit in the same step (`linkEdit`) unless `linked` is false. Returns false when nothing was written: no model,
 * a read-only project, or an edit that changes nothing.
 */
export function editModel(label: string, edit: ModelEdit, o: { coalesceKey?: string; store?: ProjectStore } & LinkOptions = {}): boolean {
  const store = o.store ?? projectStore;
  const before = store.getState().doc;
  if (!modelOf(before)) return false;
  const ok = store.getState().update(label, modelRecipe(edit, o), o.coalesceKey ? { coalesceKey: o.coalesceKey } : undefined);
  return ok && store.getState().doc !== before;
}

let dragCounter = 0;

/**
 * One gesture (a gizmo drag, a slider drag) as ONE history step (§4.4): every `update` recomputes the model from
 * the model at `begin` — so a drag that changes scope mid-way (⌥ pressed) or comes back to its start is exact —
 * and writes it under one coalesce key; `end` seals the step. `cancel` restores the starting model (Escape).
 */
export interface ModelGesture {
  readonly start: CrochetModelV1;
  update(edit: ModelEdit): boolean;
  end(): void;
  cancel(): void;
}

export function beginModelGesture(label: string, o: { store?: ProjectStore } & LinkOptions = {}): ModelGesture | null {
  const store = o.store ?? projectStore;
  const start = currentModel(store);
  if (!start) return null;
  const linked = o.linked !== false;
  const key = `t6-gesture-${++dragCounter}`;
  let ended = false;
  const write = (next: CrochetModelV1): boolean =>
    store.getState().update(
      label,
      (draft) => {
        if (draft.threeD) draft.threeD.model = next as Draft<CrochetModelV1>;
      },
      { coalesceKey: key },
    );
  return {
    start,
    update(edit) {
      if (ended || !store.getState().doc?.threeD?.model) return false;
      const next = edit(start);
      return write(withRevision(start, linked ? linkEdit(start, next) : next));
    },
    end() {
      if (ended) return;
      ended = true;
      store.getState().endCoalescing();
    },
    cancel() {
      if (ended) return;
      if (store.getState().doc?.threeD?.model) write(start);
      ended = true;
      store.getState().endCoalescing();
    },
  };
}

/** A resize edit: the full edit with `reanchor: true`, the part alone with `reanchor: false`. */
export type ResizeEdit = (model: CrochetModelV1, o: Required<DimsEditOptions>) => CrochetModelV1;

/**
 * A resize drag (the Scale gizmo, a size slider) as ONE history step whose re-anchoring runs at most every
 * `intervalMs` (§4.2: "during the drag (≤ 10 Hz) and on release"). Every `update` resizes the part at once; the
 * children are re-anchored when the interval has passed, otherwise they stay where the last re-anchoring put
 * them, and a timer re-anchors after the last update of a pause. `end` always re-anchors, so the step ends with
 * exactly what one unthrottled edit from the start would give.
 */
export interface ResizeGesture {
  readonly start: CrochetModelV1;
  update(partId: string, edit: ResizeEdit): boolean;
  /** Re-anchors now if an update is waiting for it. */
  flush(): void;
  end(): void;
  cancel(): void;
}

export interface ResizeGestureOptions extends LinkOptions {
  store?: ProjectStore;
  intervalMs?: number;
  now?: () => number;
  /** Runs `fn` after `ms` (default `setTimeout`); returns a function that cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function beginResizeGesture(label: string, o: ResizeGestureOptions = {}): ResizeGesture | null {
  const gesture = beginModelGesture(label, { store: o.store, linked: o.linked });
  if (!gesture) return null;
  const interval = o.intervalMs ?? REANCHOR_INTERVAL_MS;
  const now = o.now ?? (() => performance.now());
  const schedule = o.schedule ?? defaultSchedule;
  const start = gesture.start;
  let last = start; // the model of the last full (re-anchored) update
  let lastAt = -Infinity;
  let pending: { partId: string; edit: ResizeEdit } | null = null;
  let cancelTimer: (() => void) | null = null;
  let done = false;

  const stopTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };
  const full = (edit: ResizeEdit): boolean => {
    stopTimer();
    pending = null;
    lastAt = now();
    const next = edit(start, { reanchor: true });
    last = next;
    return gesture.update(() => next);
  };
  return {
    start,
    update(partId, edit) {
      if (done) return false;
      if (now() - lastAt >= interval) return full(edit);
      pending = { partId, edit };
      const resized = edit(start, { reanchor: false }).parts.find((p) => p.id === partId);
      const next = resized ? withParts(last, new Map([[partId, resized]])) : last;
      if (!cancelTimer) cancelTimer = schedule(() => {
        cancelTimer = null;
        if (pending && !done) full(pending.edit);
      }, Math.max(0, interval - (now() - lastAt)));
      return gesture.update(() => next);
    },
    flush() {
      if (pending && !done) full(pending.edit);
    },
    end() {
      if (done) return;
      if (pending) full(pending.edit);
      stopTimer();
      done = true;
      gesture.end();
    },
    cancel() {
      if (done) return;
      stopTimer();
      done = true;
      gesture.cancel();
    },
  };
}

// =====================================================================================================
// T6.2 — structure edits (§4.2): Add part, Duplicate, Delete, Mirror (+ linked edits), Attach, Make as, Start
// / axis. All pure like the edits above; none of them ever produces a repeated part id (§0.1).
// =====================================================================================================

// ---- ids

/** The part-id pattern of §3.5.1 (also the feature-id pattern, §3.5.2). */
export const PART_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ID_LENGTH = 32;
const { maxParts: MAX_PARTS } = MODEL_LIMITS;

/** A valid part id made from any text: lowercase letters, digits and `_`, starting with a letter, ≤ 32 chars. */
export function slugPartId(text: string): string {
  let s = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(s)) s = s ? `part_${s}` : 'part';
  return s.slice(0, MAX_ID_LENGTH).replace(/_+$/, '');
}

/** The ids a new part must not take: every part id and every feature id. */
export function takenIds(model: Pick<CrochetModelV1, 'parts' | 'features'>): Set<string> {
  return new Set([...model.parts.map((p) => p.id), ...(model.features ?? []).map((f) => f.id)]);
}

/**
 * `wanted` as a valid id that is not in `taken` (default: the model's part and feature ids): the slug itself,
 * else the slug with `_2`, `_3`, … (shortened so the id stays ≤ 32 chars). Never a repeated id (§0.1).
 */
export function uniquePartId(model: Pick<CrochetModelV1, 'parts' | 'features'>, wanted: string, taken: ReadonlySet<string> = takenIds(model)): string {
  const base = slugPartId(wanted);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

function deepCopy<T>(x: T): T {
  return structuredClone(x);
}

// ---- Add part (§4.2: "click on a part's surface: placed by placeChildOnSurface (0.1 in overlap along the
// clicked normal), attach.to = that part")

/** The primitives Add part offers (a mesh part comes from the sculpt tools, not from Add part). */
export const ADDABLE_TYPES = ['sphere', 'ellipsoid', 'capsule', 'cylinder', 'cone', 'torus', 'box', 'flat', 'lathe'] as const;
export type AddableType = (typeof ADDABLE_TYPES)[number];

/** How far a new part enters the part it is added to (§4.2, `placeChildOnSurface`'s default). */
export const ADD_OVERLAP_IN = DEFAULT_OVERLAP_IN;

/** The id a new part of each type starts from (made unique by `uniquePartId`). */
export const NEW_PART_ID: Readonly<Record<AddableType, string>> = {
  sphere: 'ball',
  ellipsoid: 'oval',
  capsule: 'capsule',
  cylinder: 'tube',
  cone: 'cone',
  torus: 'ring',
  box: 'block',
  flat: 'patch',
  lathe: 'dome',
};

/**
 * The size of a new part on `parent`: 0.35 × the parent's middle extent, in [0.3, 3] in, on the 0.05 in grid —
 * an ear-sized piece on a head, a nose-sized one on a muzzle.
 */
export function newPartSize(parent: Part): number {
  const extents = boundsSize(localBounds(parent)).sort((a, b) => a - b);
  const d = Number.isFinite(extents[1]) ? extents[1] * 0.35 : 1;
  return roundCoord(Math.min(3, Math.max(0.3, Math.round(d / SNAP_DIM_IN) * SNAP_DIM_IN)));
}

/** The dims of a new primitive about `d` inches across (a valid part of §3.5.2 for every d ≥ 0.1). */
export function newPrimitiveDims(type: AddableType, d: number): Part['dims'] {
  const r = (x: number) => clampDim(x);
  switch (type) {
    case 'sphere':
      return { r: r(d / 2) };
    case 'ellipsoid':
      return { rx: r(d / 2), ry: r(d * 0.65), rz: r(d * 0.4) };
    case 'capsule': {
      const radius = r(d / 4);
      return { r: radius, length: clampDim(Math.max(d * 1.2, 2 * radius)) };
    }
    case 'cylinder':
      return { rTop: r(d / 3), rBottom: r(d / 3), h: r(d * 0.8) };
    case 'cone':
      return { r: r(d / 3), h: r(d * 0.8) };
    case 'torus':
      return { R: r(d / 2.5), r: r(d / 10) };
    case 'box':
      return { w: r(d * 0.8), h: r(d * 0.8), d: r(d * 0.8) };
    case 'flat':
      return { shape: 'circle', w: r(d), h: r(d), thickness: r(Math.min(0.12, d / 5)) };
    case 'lathe':
      return {
        profile: [
          [roundCoord(d * 0.45), 0],
          [roundCoord(d * 0.45), roundCoord(d * 0.25)],
          [roundCoord(d * 0.3), roundCoord(d * 0.55)],
          [0, roundCoord(d * 0.65)],
        ],
      };
  }
}

/** The local axis a new part points along the surface normal: round shapes their length (Y), flat ones their face (Z). */
const ORIENT_AXIS: Readonly<Record<AddableType, Vec3 | null>> = {
  sphere: null,
  box: null,
  ellipsoid: [0, 1, 0],
  capsule: [0, 1, 0],
  cylinder: [0, 1, 0],
  cone: [0, 1, 0],
  lathe: [0, 1, 0],
  flat: [0, 0, 1],
  torus: [0, 0, 1],
};

/** The rotation (row-major) taking the unit vector `a` onto the unit vector `b` (Rodrigues). */
function rotationBetween(a: Vec3, b: Vec3): Mat3 {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-12) {
    // Half a turn about any axis perpendicular to a.
    const p: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const k = normalize3([a[1] * p[2] - a[2] * p[1], a[2] * p[0] - a[0] * p[2], a[0] * p[1] - a[1] * p[0]]);
    return [2 * k[0] * k[0] - 1, 2 * k[0] * k[1], 2 * k[0] * k[2], 2 * k[1] * k[0], 2 * k[1] * k[1] - 1, 2 * k[1] * k[2], 2 * k[2] * k[0], 2 * k[2] * k[1], 2 * k[2] * k[2] - 1];
  }
  const v: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c,
    v[0] * v[1] * k - v[2],
    v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2],
    v[1] * v[1] * k + c,
    v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1],
    v[2] * v[1] * k + v[0],
    v[2] * v[2] * k + c,
  ];
}

function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : [0, 1, 0];
}

/** Euler XYZ degrees that point a new part's axis along `normal`; `undefined` when no turn is needed. */
function orientationFor(type: AddableType, normal: Vec3): Vec3 | undefined {
  const axis = ORIENT_AXIS[type];
  if (!axis || !isFiniteVec3(normal)) return undefined;
  const r = roundVec3(mat3ToEulerXYZ(rotationBetween(axis, normalize3(normal))));
  return r[0] === 0 && r[1] === 0 && r[2] === 0 ? undefined : r;
}

/** Why a part cannot be added to `parentId` now, or null. */
export function addPartBlockedReason(model: Pick<CrochetModelV1, 'parts'>, parentId: string | null | undefined): string | null {
  if (model.parts.length >= MAX_PARTS) return `A model holds at most ${MAX_PARTS} parts`;
  if (!parentId || !byId(model, parentId)) return 'Pick the part to attach it to';
  return null;
}

export interface AddPartOptions {
  /** The id to start from (default per type: `ball`, `oval`, …); made unique. */
  id?: string;
  label?: string;
  /** About how many inches across (default `newPartSize(parent)`). */
  size?: number;
  /** A palette id (default: the parent's color). */
  color?: string;
  /** Default 0.10 in (§4.2). */
  overlapIn?: number;
}

/**
 * Add part (§4.2): a new primitive attached to `parentId` (`attach.to`), placed on the parent's surface by
 * `placeChildOnSurface` with a 0.10 in overlap — `{ hit, normal }` for a click on the parent, `{ dir }` for a side
 * of it (from the parent's center) — and turned so its length (round shapes) or its face (flat pieces, rings)
 * points along that normal. Returns the model unchanged and `id: null` when the part cannot be added.
 */
export function addPart(
  model: CrochetModelV1,
  parentId: string,
  type: AddableType,
  at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 },
  o: AddPartOptions = {},
): { model: CrochetModelV1; id: string | null } {
  const parent = byId(model, parentId);
  if (!parent || addPartBlockedReason(model, parentId) || !(ADDABLE_TYPES as readonly string[]).includes(type)) return { model, id: null };
  const size = o.size !== undefined && Number.isFinite(o.size) && o.size > 0 ? o.size : newPartSize(parent);
  const id = uniquePartId(model, o.id ?? NEW_PART_ID[type]);
  const color = o.color && model.palette.some((c) => c.id === o.color) ? o.color : parent.color;
  const normal = 'dir' in at ? at.dir : at.normal;
  const draft = { id, type, dims: newPrimitiveDims(type, size), position: partCenter(parent), color, attach: { to: parentId } } as Part;
  const rotationDeg = orientationFor(type, normal);
  if (rotationDeg) draft.rotationDeg = rotationDeg;
  const label = o.label?.trim().slice(0, MODEL_LIMITS.maxTextChars);
  if (label) draft.label = label;
  const placed = placeChildOnSurface(parent, draft, at, o.overlapIn ?? ADD_OVERLAP_IN);
  return { model: { ...model, parts: [...model.parts, placed] }, id };
}

// ---- Duplicate (⌘D; §4.2 "offset +0.5 in X")

export const DUPLICATE_OFFSET_IN: Vec3 = [0.5, 0, 0];

function existingIds(model: Pick<CrochetModelV1, 'parts'>, ids: readonly string[]): string[] {
  const want = new Set(ids);
  return model.parts.filter((p) => want.has(p.id)).map((p) => p.id);
}

/** Why the parts cannot be duplicated, or null. */
export function duplicateBlockedReason(model: Pick<CrochetModelV1, 'parts'>, ids: readonly string[]): string | null {
  const n = existingIds(model, ids).length;
  if (n === 0) return 'Select the parts to duplicate';
  if (model.parts.length + n > MAX_PARTS) return `A model holds at most ${MAX_PARTS} parts`;
  return null;
}

/**
 * Duplicate: a copy of each part, moved by `offset` (default +0.5 in X), with a new unique id and the label
 * "<name> copy". A copy hangs from the copy of its parent when that was duplicated too, else from the same parent;
 * a copy of the root hangs from the root (the model stays one tree). Copies are not mirror-linked (`mirrorOf` is
 * dropped). Returns the new ids in the order of `model.parts`; nothing changes when the copies would not fit.
 */
export function duplicateParts(
  model: CrochetModelV1,
  ids: readonly string[],
  o: { offset?: Vec3 } = {},
): { model: CrochetModelV1; ids: string[]; map: Record<string, string> } {
  if (duplicateBlockedReason(model, ids)) return { model, ids: [], map: {} };
  const offset = isFiniteVec3(o.offset) ? o.offset : DUPLICATE_OFFSET_IN;
  const chosen = existingIds(model, ids);
  const taken = takenIds(model);
  const map: Record<string, string> = {};
  for (const id of chosen) {
    const copyId = uniquePartId(model, id, taken);
    taken.add(copyId);
    map[id] = copyId;
  }
  const copies = chosen.map((id) => {
    const p = byId(model, id) as Part;
    const copy = deepCopy(p);
    copy.id = map[id];
    copy.position = roundVec3([p.position[0] + offset[0], p.position[1] + offset[1], p.position[2] + offset[2]]);
    copy.label = `${partName(p)} copy`.slice(0, MODEL_LIMITS.maxTextChars);
    delete copy.mirrorOf;
    copy.attach = p.attach ? { ...p.attach, to: map[p.attach.to] ?? p.attach.to } : { to: p.id };
    return copy;
  });
  return { model: { ...model, parts: [...model.parts, ...copies] }, ids: copies.map((c) => c.id), map };
}

// ---- Delete (⌫; §4.2 "children re-attach to the deleted part's parent")

/** Why the parts cannot be deleted, or null. */
export function deleteBlockedReason(model: Pick<CrochetModelV1, 'parts'>, ids: readonly string[]): string | null {
  const n = existingIds(model, ids).length;
  if (n === 0) return 'Select the parts to delete';
  if (n >= model.parts.length) return 'A model needs at least one part';
  return null;
}

export interface DeletePlan {
  /** The parts that go, in parts order. */
  removed: string[];
  /** Surviving parts whose parent goes: the part they will hang from (`null` = the new root). */
  reattached: { id: string; to: string | null }[];
  /** When the root goes: the largest of the parts left without a parent becomes the root. */
  newRoot: string | null;
}

/**
 * What deleting `ids` does: every surviving part whose parent goes hangs from its nearest surviving ancestor;
 * parts left without one (the root went) hang from the largest of them (by volume; ties → parts order), which
 * becomes the new root, so the model stays one tree.
 */
export function planDelete(model: Pick<CrochetModelV1, 'parts'>, ids: readonly string[]): DeletePlan {
  const removed = existingIds(model, ids);
  const gone = new Set(removed);
  const reattached: DeletePlan['reattached'] = [];
  const orphans: Part[] = [];
  for (const p of model.parts) {
    if (gone.has(p.id) || !p.attach?.to || !gone.has(p.attach.to)) continue;
    const up = ancestorIds(model, p.id).find((a) => !gone.has(a)) ?? null;
    if (up) reattached.push({ id: p.id, to: up });
    else orphans.push(p);
  }
  let newRoot: string | null = null;
  if (orphans.length > 0) {
    let best = orphans[0];
    let bestVolume = partVolume(best);
    for (const p of orphans.slice(1)) {
      const v = partVolume(p);
      if (v > bestVolume + 1e-12) {
        best = p;
        bestVolume = v;
      }
    }
    newRoot = best.id;
    for (const p of orphans) reattached.push({ id: p.id, to: p.id === newRoot ? null : newRoot });
  }
  // Parts order, so the plan reads like the outliner.
  const order = new Map(model.parts.map((p, i) => [p.id, i]));
  reattached.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { removed, reattached, newRoot };
}

/**
 * Delete: removes `ids` and re-attaches the parts that hung from them (`planDelete`); a re-parented part loses
 * its stored limb end (`x-cpg-proximal`, §3.5.2). Mirror links to a deleted part, features on it and assembly
 * steps naming it go too. Nothing changes when every part would go (`deleteBlockedReason`).
 */
export function deleteParts(model: CrochetModelV1, ids: readonly string[]): CrochetModelV1 {
  if (deleteBlockedReason(model, ids)) return model;
  const plan = planDelete(model, ids);
  const gone = new Set(plan.removed);
  const moved = new Map(plan.reattached.map((r) => [r.id, r.to]));
  const parts = model.parts
    .filter((p) => !gone.has(p.id))
    .map((p) => {
      let q = p;
      if (moved.has(p.id)) {
        const to = moved.get(p.id) ?? null;
        q = { ...p };
        if (to) q.attach = { ...p.attach, to };
        else delete q.attach;
        delete q[LIMB_PROXIMAL_KEY];
      }
      if (q.mirrorOf && gone.has(q.mirrorOf)) {
        q = q === p ? { ...p } : q;
        delete q.mirrorOf;
      }
      return q;
    });
  const next: CrochetModelV1 = { ...model, parts };
  if (model.features) {
    const features = model.features.filter((f: Feature) => !gone.has(f.on));
    if (features.length !== model.features.length) next.features = features;
  }
  if (model.assembly) {
    const assembly = model.assembly.filter((a) => !gone.has(a.part) && !(a.to && gone.has(a.to)));
    if (assembly.length !== model.assembly.length) next.assembly = assembly;
  }
  return next;
}

// ---- Mirror (M; §4.2 "create/update <id>_r from <id>_l across x = 0 (x and rotation y, z negated), mirrorOf
// link; linked edits propagate until Unlink")

const RIGHT_OF: Readonly<Record<string, string>> = { l: 'r', left: 'right', fl: 'fr', bl: 'br' };

/**
 * The right-side id of a left-side id (`ear_l` → `ear_r`, `ear_l_inner` → `ear_r_inner`, `leg_fl` → `leg_fr`,
 * `wing_left` → `wing_right`): the last `_`-token naming the left side. `null` without one.
 */
export function rightTwinId(id: string): string | null {
  const tokens = id.split('_');
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (Object.hasOwn(RIGHT_OF, tokens[i])) {
      tokens[i] = RIGHT_OF[tokens[i]];
      return tokens.join('_');
    }
  }
  return null;
}

/** "Left Ear" → "Right Ear" (and left/right in any case); `null` when the label names no side. */
function rightLabel(label: string): string | null {
  if (!/\bleft\b/i.test(label)) return null;
  return label.replace(/\bleft\b/gi, (w) => (w === 'LEFT' ? 'RIGHT' : w[0] === 'L' ? 'Right' : 'right'));
}

/**
 * The part mirror-linked with `partId`: the part it names in `mirrorOf`, or the part whose `mirrorOf` names it
 * (the first in parts order). `undefined` when it has none.
 */
export function mirrorTwin(model: Pick<CrochetModelV1, 'parts'>, partId: string): Part | undefined {
  const p = byId(model, partId);
  if (!p) return undefined;
  if (p.mirrorOf) {
    const s = byId(model, p.mirrorOf);
    if (s && s.id !== p.id) return s;
  }
  return model.parts.find((q) => q.id !== partId && q.mirrorOf === partId);
}

/** The source of a linked pair (the part without `mirrorOf`) and its twin, for `partId`; `null` when not linked. */
export function mirrorPair(model: Pick<CrochetModelV1, 'parts'>, partId: string): { source: Part; twin: Part } | null {
  const p = byId(model, partId);
  const t = mirrorTwin(model, partId);
  if (!p || !t) return null;
  return p.mirrorOf === t.id ? { source: t, twin: p } : { source: p, twin: t };
}

/** Parts that sit on the middle line (|center x| below this) mirror onto themselves. */
export const MIRROR_CENTER_IN = 0.05;

/** Why `partId` cannot be mirrored now, or null. */
export function mirrorBlockedReason(model: Pick<CrochetModelV1, 'parts'>, partId: string): string | null {
  const p = byId(model, partId);
  if (!p) return 'Select the part to mirror';
  if (p.type === 'mesh') return 'Sculpted parts are mirrored with the sculpt tools (X symmetry)';
  if (mirrorPair(model, partId)) return null; // re-mirrors the twin
  if (Math.abs(partCenter(p)[0]) < MIRROR_CENTER_IN) return 'This part sits on the middle line, so its mirror image would land on itself';
  if (model.parts.length >= MAX_PARTS) return `A model holds at most ${MAX_PARTS} parts`;
  return null;
}

const MIRROR_X: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];

function wrapDeg(a: number): number {
  const x = (((a + 180) % 360) + 360) % 360 - 180;
  return roundCoord(x === -180 ? 180 : x) + 0;
}

function mirrorRegion(r: Region): Region {
  if (r.kind === 'patch' || r.kind === 'spot') return { ...r, azimuthDeg: wrapDeg(-r.azimuthDeg) };
  return { ...r };
}

/** A 64 × 64 paint field mirrored left to right (azimuth a → −a: column c → 63 − c). `null` when malformed. */
function mirrorUv64(data: string): string | null {
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return null;
  }
  if (bin.length !== 4096) return null;
  let out = '';
  for (let row = 0; row < 64; row++) for (let col = 0; col < 64; col++) out += bin[row * 64 + (63 - col)];
  return btoa(out);
}

/**
 * The fields of `source` mirrored across x = 0, applied to `onto` (a twin keeps its id, label, attach, mirrorOf,
 * notes and other `x-*` keys): position x negated; rotation (x, −y, −z) — the reflection of R is M·R·M with
 * M = diag(−1, 1, 1), and for Euler XYZ that negates y and z exactly; dims, color, stuffing, flatten, regions
 * (azimuths negated), paint (left ↔ right), crochet hints (seam azimuth and seed mirrored) and the stored limb end.
 * Shapes that are not symmetric in their own x get their mirror image in the dims: polygon points (x negated,
 * order reversed) and a torus arc (turned by 180° − arc about its own z, so it covers the mirrored span).
 */
export function mirroredFrom(source: Part, onto?: Part): Part {
  const out = (onto ? { ...onto } : { ...deepCopy(source) }) as Part & Record<string, unknown>;
  out.type = source.type;
  (out as { dims: Part['dims'] }).dims = deepCopy(source.dims);
  out.position = roundVec3([-source.position[0], source.position[1], source.position[2]]);
  const r = source.rotationDeg ?? [0, 0, 0];
  let rotation: Vec3 = [r[0] + 0, roundCoord(-r[1]) + 0, roundCoord(-r[2]) + 0];
  if (source.type === 'torus' && (source.dims.arcDeg ?? 360) < 360) {
    const fix = eulerXYZToMat3([0, 0, 180 - (source.dims.arcDeg ?? 360)]);
    const m = mulMat3(mulMat3(MIRROR_X, mulMat3(eulerXYZToMat3(r), MIRROR_X)), fix);
    rotation = roundVec3(mat3ToEulerXYZ(m));
  }
  if (rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0 && !source.rotationDeg) delete out.rotationDeg;
  else out.rotationDeg = rotation;
  if (source.type === 'flat' && source.dims.points) {
    (out.dims as Extract<Part, { type: 'flat' }>['dims']).points = [...source.dims.points].reverse().map(([x, y]): [number, number] => [roundCoord(-x) + 0, y]);
  }
  out.color = source.color;
  for (const key of ['stuffing', 'flatten'] as const) {
    if (source[key] === undefined) delete out[key];
    else (out as Record<string, unknown>)[key] = source[key];
  }
  if (source.regions) out.regions = source.regions.map(mirrorRegion);
  else delete out.regions;
  const paint = source.paint ? mirrorUv64(source.paint.data) : null;
  if (source.paint && paint) out.paint = { kind: 'uv64', data: paint };
  else delete out.paint;
  if (source.crochet) {
    const c: PartCrochetHints = { ...source.crochet };
    if (c.seamAzimuthDeg !== undefined) c.seamAzimuthDeg = roundCoord((360 - c.seamAzimuthDeg) % 360) + 0;
    if (c.seed) c.seed = [roundCoord(-c.seed[0]) + 0, c.seed[1], c.seed[2]];
    out.crochet = c;
  } else delete out.crochet;
  if (source[LIMB_PROXIMAL_KEY] !== undefined) out[LIMB_PROXIMAL_KEY] = source[LIMB_PROXIMAL_KEY];
  else delete out[LIMB_PROXIMAL_KEY];
  return out as Part;
}

/**
 * Mirror (M): for each part, in tree order (parents first): a part that is mirror-linked re-mirrors its pair —
 * the twin (the part carrying `mirrorOf`) is rewritten from its source; otherwise a new twin is made across
 * x = 0 with `mirrorOf` = the part, the id `<id>_r` from `<id>_l` (`rightTwinId`; else `<id>_r`; made unique),
 * the label with Left → Right (else "<name> mirrored"), hanging from the mirror twin of the part's parent when
 * that has one (so `ear_l_inner`'s twin hangs from `ear_r`), else from the same parent. Mesh parts and parts on the
 * middle line are skipped (`mirrorBlockedReason`). Returns the twins' ids.
 */
export function mirrorParts(model: CrochetModelV1, ids: readonly string[]): { model: CrochetModelV1; twins: string[] } {
  const depth = (id: string) => ancestorIds(model, id).length;
  const order = existingIds(model, ids).sort((a, b) => depth(a) - depth(b));
  let m = model;
  const twins: string[] = [];
  for (const id of order) {
    if (mirrorBlockedReason(m, id)) continue;
    const pair = mirrorPair(m, id);
    if (pair) {
      const next = mirroredFrom(pair.source, pair.twin);
      m = withParts(m, new Map([[pair.twin.id, sameJson(next, pair.twin) ? pair.twin : next]]));
      twins.push(pair.twin.id);
      continue;
    }
    const p = byId(m, id) as Part;
    const twinId = uniquePartId(m, rightTwinId(p.id) ?? `${p.id}_r`);
    const twin = mirroredFrom(p);
    twin.id = twinId;
    twin.mirrorOf = p.id;
    const label = p.label ? rightLabel(p.label) ?? `${p.label} mirrored` : null;
    if (label) twin.label = label.slice(0, MODEL_LIMITS.maxTextChars);
    else delete twin.label;
    if (p.attach) {
      const parentTwin = mirrorTwin(m, p.attach.to);
      twin.attach = { ...p.attach, to: parentTwin ? parentTwin.id : p.attach.to };
    } else twin.attach = { to: p.id }; // a mirrored root hangs from it: one tree
    m = { ...m, parts: [...m.parts, twin] };
    twins.push(twinId);
  }
  return { model: m, twins };
}

/** Unlink: the part and its twin stop following each other (the twin's `mirrorOf` goes). */
export function unlinkMirror(model: CrochetModelV1, partId: string): CrochetModelV1 {
  const pair = mirrorPair(model, partId);
  if (!pair) return model;
  const twin = { ...pair.twin };
  delete twin.mirrorOf;
  return withParts(model, new Map([[twin.id, twin]]));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields a mirror link carries over (everything `mirroredFrom` writes). */
function mirrorKey(p: Part): string {
  return JSON.stringify([p.type, p.dims, p.position, p.rotationDeg ?? null, p.color, p.stuffing ?? null, p.flatten ?? null, p.regions ?? null, p.paint ?? null, p.crochet ?? null, p[LIMB_PROXIMAL_KEY] ?? null]);
}

/**
 * Linked edits (§4.2): after an edit `before → after`, each mirror-linked pair of which exactly ONE side changed
 * in a mirrored field (shape, place, color, stuffing, regions, paint, crochet hints) gets the other side rewritten
 * as its mirror image (`mirroredFrom`) — in the same history step. When that twin changed size its own children
 * are re-anchored (§4.2), and when it moved while the changed side's children moved with it (a subtree move) its
 * subtree follows by the same rigid motion; children that are themselves linked to a changed part are rewritten
 * as twins instead. Pairs where both sides changed (a move of their common parent) are left as they are.
 */
export function propagateMirrors(before: CrochetModelV1, after: CrochetModelV1): CrochetModelV1 {
  if (before === after) return after;
  const prev = new Map(before.parts.map((p) => [p.id, p]));
  const changed = new Set<string>();
  for (const p of after.parts) {
    const b = prev.get(p.id);
    if (b && b !== p && mirrorKey(b) !== mirrorKey(p)) changed.add(p.id);
  }
  if (changed.size === 0) return after;
  // Linked pairs, the changed side first, parents first.
  const jobs: { from: Part; to: Part }[] = [];
  const seen = new Set<string>();
  for (const id of changed) {
    const twin = mirrorTwin(after, id);
    if (!twin || changed.has(twin.id) || seen.has(twin.id) || !prev.has(twin.id)) continue;
    seen.add(twin.id);
    jobs.push({ from: byId(after, id) as Part, to: twin });
  }
  if (jobs.length === 0) return after;
  const depth = (id: string) => ancestorIds(after, id).length;
  jobs.sort((a, b) => depth(a.to.id) - depth(b.to.id));
  const rewritten = new Set(jobs.map((j) => j.to.id));
  let m = after;
  for (const { from, to } of jobs) {
    const current = byId(m, to.id) as Part;
    const next = mirroredFrom(from, current);
    if (sameJson(next, current)) continue;
    const motion = multiplyRigid(composeRigid(partCenter(next), next.rotationDeg), invertRigid(composeRigid(partCenter(current), current.rotationDeg)));
    const resized = sameJson([current.type, current.dims], [next.type, next.dims]) === false;
    const beforeTwin = m;
    m = withParts(m, new Map([[to.id, next]]));
    // The twin's own children: linked ones are rewritten by their own job; the others follow.
    const fromChildren = childrenIdsOf(after, from.id);
    const subtreeMoved = fromChildren.length === 0 || fromChildren.some((c) => changed.has(c));
    const followers = subtreeIds(m, to.id).slice(1).filter((id) => !rewritten.has(id) && !changed.has(id));
    if (resized) {
      const re = reanchorChildren(beforeTwin, m, to.id);
      const keep = new Map<string, Part>();
      for (const id of followers) {
        const q = byId(re, id);
        if (q) keep.set(id, q);
      }
      m = withParts(m, keep);
    } else if (subtreeMoved && followers.length > 0 && !isIdentityRigid(motion)) {
      const moved = new Map<string, Part>();
      for (const id of followers) {
        const q = byId(m, id);
        if (q) moved.set(id, applyRigidToPart(q, motion));
      }
      m = withParts(m, moved);
    }
  }
  return m;
}

function childrenIdsOf(model: Pick<CrochetModelV1, 'parts'>, id: string): string[] {
  return model.parts.filter((p) => p.attach?.to === id && p.id !== id).map((p) => p.id);
}

function isIdentityRigid(m: Rigid): boolean {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return m.rotation.every((v, i) => Math.abs(v - I[i]) < 1e-12) && m.position.every((v) => Math.abs(v) < 1e-9);
}

/**
 * The stored limb end (`x-cpg-proximal`, §3.5.2) goes when a part was re-parented (`attach.to` changed) or turned
 * end for end (its local Y axis now points more than 90° away from where it pointed).
 */
export function dropStaleProximal(before: CrochetModelV1, after: CrochetModelV1): CrochetModelV1 {
  if (before === after) return after;
  const prev = new Map(before.parts.map((p) => [p.id, p]));
  const fixed = new Map<string, Part>();
  for (const p of after.parts) {
    if (p[LIMB_PROXIMAL_KEY] === undefined) continue;
    const b = prev.get(p.id);
    if (!b || b === p) continue;
    const reparented = (b.attach?.to ?? null) !== (p.attach?.to ?? null);
    const a0 = partAxis(b, 1);
    const a1 = partAxis(p, 1);
    const flipped = a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2] < 0;
    if (reparented || flipped) {
      const q = { ...p };
      delete q[LIMB_PROXIMAL_KEY];
      fixed.set(p.id, q);
    }
  }
  return fixed.size > 0 ? withParts(after, fixed) : after;
}

/** What every editor edit runs after itself (§4.2): mirror-linked twins follow, stale limb ends are dropped. */
export function linkEdit(before: CrochetModelV1, after: CrochetModelV1): CrochetModelV1 {
  if (before === after) return after;
  return dropStaleProximal(before, propagateMirrors(before, after));
}

// ---- Attach (§4.2: "pick a new parent (cycles refused; the root has none; there is no detach, so the model
// stays one tree); choose open end (top/bottom/none) and method")

export type AttachMethod = NonNullable<NonNullable<Part['attach']>['method']>;
export type OpenEnd = NonNullable<NonNullable<Part['attach']>['openEnd']>;
export const ATTACH_METHODS: readonly AttachMethod[] = ['sewn', 'crochet-in-place', 'worked-from', 'glued', 'none'];
export const OPEN_ENDS: readonly OpenEnd[] = ['top', 'bottom', 'none'];

/** The id of the attach tree's root (the first part without a parent), or null for an empty model. */
export function attachRootId(model: Pick<CrochetModelV1, 'parts'>): string | null {
  const g = attachGraph(model.parts);
  const i = g.roots[0];
  return i === undefined ? null : model.parts[i].id;
}

/** Why `partId` cannot hang from `parentId`, or null. The root of the tree hangs from nothing. */
export function attachBlockedReason(model: Pick<CrochetModelV1, 'parts'>, partId: string, parentId: string): string | null {
  const p = byId(model, partId);
  const parent = byId(model, parentId);
  if (!p || !parent) return 'Pick a part';
  if (partId === parentId) return 'A part cannot hang from itself';
  const g = attachGraph(model.parts);
  if (!p.attach && g.isTree) return 'This is the main piece: every other part hangs from it';
  if (subtreeIds(model, partId).includes(parentId)) return `${partName(parent)} hangs from ${partName(p)}, so this would make a loop`;
  return null;
}

/**
 * Attach: `partId` hangs from `parentId` (method and open end kept unless given). Refused (the model unchanged)
 * when it would make a loop, for the root and for a part itself (`attachBlockedReason`); there is no way to
 * detach. A part that changes parent loses its stored limb end (`x-cpg-proximal`).
 */
export function attachPart(model: CrochetModelV1, partId: string, parentId: string, o: { openEnd?: OpenEnd | null; method?: AttachMethod | null } = {}): CrochetModelV1 {
  if (attachBlockedReason(model, partId, parentId)) return model;
  const p = byId(model, partId) as Part;
  const attach = { ...p.attach, to: parentId };
  const next: Part = { ...p, attach };
  if (p.attach?.to !== parentId) delete next[LIMB_PROXIMAL_KEY];
  const done = withParts(model, new Map([[partId, next]]));
  return setAttachOptions(done, partId, o);
}

/**
 * The attach options of a part that hangs from something: `openEnd` (which end stays open and is sewn on;
 * `null` = decided by the plan) and `method` (`null` = the default, sewn). Choosing the top or bottom end drops
 * the stored limb end: the open end wins (§3.5.2).
 */
export function setAttachOptions(model: CrochetModelV1, partId: string, o: { openEnd?: OpenEnd | null; method?: AttachMethod | null }): CrochetModelV1 {
  const p = byId(model, partId);
  if (!p?.attach) return model;
  const attach = { ...p.attach };
  if (o.openEnd === null) delete attach.openEnd;
  else if (o.openEnd !== undefined && OPEN_ENDS.includes(o.openEnd)) attach.openEnd = o.openEnd;
  if (o.method === null) delete attach.method;
  else if (o.method !== undefined && ATTACH_METHODS.includes(o.method)) attach.method = o.method;
  if (sameJson(attach, p.attach)) return model;
  const next: Part = { ...p, attach };
  if (attach.openEnd === 'top' || attach.openEnd === 'bottom') delete next[LIMB_PROXIMAL_KEY];
  return withParts(model, new Map([[partId, next]]));
}

// ---- Make as, Start / axis (§4.2, §2.10.1, §2.10.2) — `crochet.*`

export type MakeChoice = NonNullable<PartCrochetHints['make']>;
export const MAKE_CHOICES: readonly MakeChoice[] = ['auto', 'piece', 'applique', 'embroidery', 'safety_eye', 'region', 'skip'];

/** True for the types whose `crochet.axis` is honored (§2.10.2); revolved types are worked about their own Y. */
export function axisHonored(type: Part['type']): boolean {
  return type === 'sphere' || type === 'ellipsoid' || type === 'box';
}

export interface CrochetHintsPatch {
  make?: MakeChoice;
  start?: NonNullable<PartCrochetHints['start']>;
  axis?: NonNullable<PartCrochetHints['axis']>;
  /** `null` = the project's style (`AmiSettings.style`). */
  style?: NonNullable<PartCrochetHints['style']> | null;
  /** Degrees about the part's axis; `null` removes it. */
  seamAzimuthDeg?: number | null;
  /** Part-local start point of a mesh part; `null` removes it. */
  seed?: Vec3 | null;
}

/**
 * Sets crochet hints on parts (`crochet.*`). `'auto'` and `null` remove a key (the plan decides, §2.10.1–2), and
 * an empty `crochet` is removed; invalid values are ignored. Mirror-linked twins follow through `linkEdit`.
 */
export function setCrochetHints(model: CrochetModelV1, ids: readonly string[], patch: CrochetHintsPatch): CrochetModelV1 {
  const next = new Map<string, Part>();
  for (const id of existingIds(model, ids)) {
    const p = byId(model, id) as Part;
    const c: PartCrochetHints = { ...p.crochet };
    if (patch.make !== undefined && MAKE_CHOICES.includes(patch.make)) {
      if (patch.make === 'auto') delete c.make;
      else c.make = patch.make;
    }
    if (patch.start === 'auto') delete c.start;
    else if (patch.start === 'bottom' || patch.start === 'top') c.start = patch.start;
    if (patch.axis === 'auto') delete c.axis;
    else if (patch.axis === 'x' || patch.axis === 'y' || patch.axis === 'z') c.axis = patch.axis;
    if (patch.style === null) delete c.style;
    else if (patch.style === 'classic' || patch.style === 'exact') c.style = patch.style;
    if (patch.seamAzimuthDeg !== undefined) {
      if (patch.seamAzimuthDeg === null) delete c.seamAzimuthDeg;
      else if (Number.isFinite(patch.seamAzimuthDeg)) c.seamAzimuthDeg = roundCoord((((patch.seamAzimuthDeg % 360) + 360) % 360)) + 0;
    }
    if (patch.seed !== undefined) {
      if (patch.seed === null) delete c.seed;
      else if (isFiniteVec3(patch.seed)) c.seed = roundVec3(patch.seed);
    }
    const q: Part = { ...p };
    if (Object.keys(c).length > 0) q.crochet = c;
    else delete q.crochet;
    if (!sameJson(q.crochet ?? null, p.crochet ?? null)) next.set(id, q);
  }
  return withParts(model, next);
}
