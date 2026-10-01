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
import { MODEL_LIMITS } from '../../core/model/limits';
import { reanchorChildren } from '../../core/model/place';
import { surfaceGap } from '../../core/model/sdf';
import {
  composeRigid,
  decomposeRigid,
  eulerXYZToMat3,
  invertRigid,
  multiplyRigid,
  partCenter,
  positionForCenter,
  roundCoord,
  roundVec3,
  type Rigid,
} from '../../core/model/transforms';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
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

/** A projectStore recipe that applies a pure model edit to the open project's model (and bumps `revision`). */
export function modelRecipe(edit: ModelEdit): (draft: Draft<ProjectDoc>) => void {
  return (draft) => {
    const threeD = draft.threeD;
    if (!threeD?.model) throw new Error('This project has no 3D model to edit');
    const base = (isDraft(threeD.model) ? original(threeD.model) : threeD.model) as CrochetModelV1;
    const next = withRevision(base, edit(base));
    if (next !== base) threeD.model = next as Draft<CrochetModelV1>;
  };
}

/**
 * Applies a pure model edit as one history step (`label` is what Undo shows). Returns false when nothing was
 * written: no model, a read-only project, or an edit that changes nothing.
 */
export function editModel(label: string, edit: ModelEdit, o: { coalesceKey?: string; store?: ProjectStore } = {}): boolean {
  const store = o.store ?? projectStore;
  const before = store.getState().doc;
  if (!modelOf(before)) return false;
  const ok = store.getState().update(label, modelRecipe(edit), o.coalesceKey ? { coalesceKey: o.coalesceKey } : undefined);
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

export function beginModelGesture(label: string, o: { store?: ProjectStore } = {}): ModelGesture | null {
  const store = o.store ?? projectStore;
  const start = currentModel(store);
  if (!start) return null;
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
      return write(withRevision(start, edit(start)));
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

export interface ResizeGestureOptions {
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
  const gesture = beginModelGesture(label, { store: o.store });
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
