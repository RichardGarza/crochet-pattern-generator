// Track T6.3 — the color field of a part as the editor paints and reads it (DESIGN.md §2.11.1, §3.4.1 `paint()`):
// pure geometry, part-local inches, no React and no WebGL.
//
// The builder colors a part's vertices from (azimuth, t) about its GEOMETRY's bounding box: `t` = height fraction
// along local Y over that box (0 = bottom), azimuth = atan2(dx, dz) about the box center (0° = front +Z, +90° = the
// object's own left +X), the 64 × 64 paint cell = `uv64Cell(az, t)`. A brush stroke must cover CELLS, not only the
// cells that happen to hold a vertex (the pattern engine samples the field at stitch centers, §2.11.2), so each
// cell gets a surface point: the outermost point of the part on the horizontal ray from the box's vertical axis at
// the cell's height, toward the cell's azimuth. The brush paints the cells whose point is within its radius of the
// clicked point. Mesh parts paint their vertex labels instead (one label per vertex, §2.11.1).
//
// Spots, features and on-model guides use the same frame: directions are taken from the box center, like the
// builder's spot test.
import { tessellatePart, uv64Cell, UV64_NONE, UV64_SIZE } from '../../core/model/builder';
import { localSdf, type LocalSdf } from '../../core/model/sdf';
import { localToWorld } from '../../core/model/transforms';
import { angleDirection, NO_LABEL } from '../../state/slices/model3d';
import type { ColoredMesh } from '../../types/geometry';
import type { Part, Region, Vec3 } from '../../types/model';

const D2R = Math.PI / 180;

/** The frame the builder colors a part in: its geometry's local bounding box. */
export interface PaintFrame {
  min: Vec3;
  max: Vec3;
  /** Box center: the origin of azimuths and of spot / feature directions. */
  ctr: Vec3;
  /** Box height (≥ 1e-6). */
  H: number;
  /** Half the box diagonal: every surface point is within this of `ctr`. */
  reach: number;
}

/** The frame of local geometry positions (x, y, z triples). */
export function paintFrameOf(positions: ArrayLike<number>): PaintFrame {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!(min[0] <= max[0])) return { min: [0, 0, 0], max: [0, 0, 0], ctr: [0, 0, 0], H: 1e-6, reach: 1e-6 };
  const ctr: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { min, max, ctr, H: Math.max(1e-6, max[1] - min[1]), reach: Math.max(1e-6, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2) };
}

/** A part's local surface as the editor needs it: the builder's triangles, its paint frame and its SDF. */
export interface PartSurface {
  part: Part;
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  frame: PaintFrame;
  /** Positive inside; absent for mesh parts (their triangles are ray-cast instead). */
  sdf?: LocalSdf;
}

const surfaces = new WeakMap<Part, WeakMap<object, PartSurface>>();
const NO_MESH = {};

/** The part's surface, cached per part object (and mesh buffer). */
export function partSurface(part: Part, meshes?: Record<string, ColoredMesh>): PartSurface {
  const mesh = part.type === 'mesh' ? meshes?.[part.dims.meshRef] : undefined;
  const key: object = mesh ?? NO_MESH;
  let byMesh = surfaces.get(part);
  if (!byMesh) surfaces.set(part, (byMesh = new WeakMap()));
  const hit = byMesh.get(key);
  if (hit) return hit;
  const t = tessellatePart(part, meshes);
  const s: PartSurface = { part, positions: t.positions, indices: t.indices, frame: paintFrameOf(t.positions), sdf: part.type === 'mesh' && mesh ? undefined : localSdf(part) };
  byMesh.set(key, s);
  return s;
}

/** (azimuth, t) of a part-local point in the frame (§2.11.1). */
export function surfaceCoords(frame: PaintFrame, local: Vec3): { azimuthDeg: number; t: number } {
  const dx = local[0] - frame.ctr[0];
  const dz = local[2] - frame.ctr[2];
  return { azimuthDeg: Math.atan2(dx, dz) / D2R, t: (local[1] - frame.min[1]) / frame.H };
}

/** The paint cell under a part-local point. */
export function cellAt(frame: PaintFrame, local: Vec3): number {
  const { azimuthDeg, t } = surfaceCoords(frame, local);
  return uv64Cell(azimuthDeg, t);
}

/** The cell's center as (azimuth, t). */
export function cellCenter(cell: number): { azimuthDeg: number; t: number } {
  const row = Math.floor(cell / UV64_SIZE);
  const col = cell % UV64_SIZE;
  return { azimuthDeg: ((col + 0.5) / UV64_SIZE - 0.5) * 360, t: (row + 0.5) / UV64_SIZE };
}

// ---- rays

/** The OUTERMOST surface point on a ray from `origin` along unit `dir` (distance), or null when it misses. */
export function outerHit(s: PartSurface, origin: Vec3, dir: Vec3): number | null {
  return s.sdf ? outerHitSdf(s.sdf, origin, dir, s.frame.reach * 2.2) : outerHitTriangles(s.positions, s.indices, origin, dir);
}

const MARCH_STEPS = 48;

function outerHitSdf(sdf: LocalSdf, o: Vec3, d: Vec3, R: number): number | null {
  const f = (t: number) => sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
  const step = R / MARCH_STEPS;
  let outside = R;
  if (f(outside) >= 0) return null; // the ray starts beyond the part: nothing outside it to come from
  for (let i = 1; i <= MARCH_STEPS; i++) {
    const t = R - i * step;
    if (f(t) >= 0) {
      let lo = t; // inside
      let hi = outside; // outside
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (f(mid) >= 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    outside = t;
  }
  return null;
}

function outerHitTriangles(pos: ArrayLike<number>, idx: ArrayLike<number>, o: Vec3, d: Vec3): number | null {
  let best = -Infinity;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = o[0] - pos[a];
    const ty = o[1] - pos[a + 1];
    const tz = o[2] - pos[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && t > best) best = t;
  }
  return best > -Infinity ? best : null;
}

/** The surface point (part-local) at (azimuth, t): the horizontal ray from the box axis at that height (§2.11.1 frame). */
export function pointAtHeight(s: PartSurface, azimuthDeg: number, t: number): Vec3 {
  const f = s.frame;
  const y = f.min[1] + Math.min(1, Math.max(0, t)) * f.H;
  const o: Vec3 = [f.ctr[0], y, f.ctr[2]];
  const d: Vec3 = [Math.sin(azimuthDeg * D2R), 0, Math.cos(azimuthDeg * D2R)];
  const hit = outerHit(s, o, d);
  return hit === null ? o : [o[0] + d[0] * hit, y, o[2] + d[2] * hit];
}

/** The surface point (part-local) in the direction (azimuth, elevation) from the box center (spots, features). */
export function pointAtAngles(s: PartSurface, azimuthDeg: number, elevationDeg: number): Vec3 {
  const d = angleDirection(azimuthDeg, elevationDeg);
  const o = s.frame.ctr;
  const hit = outerHit(s, o, d) ?? 0;
  return [o[0] + d[0] * hit, o[1] + d[1] * hit, o[2] + d[2] * hit];
}

/** The outward normal at a part-local surface point (SDF gradient; mesh parts: the direction from the center). */
export function normalAt(s: PartSurface, p: Vec3): Vec3 {
  if (s.sdf) {
    const h = Math.max(1e-4, s.frame.reach * 1e-4);
    const f = s.sdf;
    const gx = f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]);
    const gy = f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]);
    const gz = f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h);
    const len = Math.hypot(gx, gy, gz);
    if (len > 1e-12) return [-gx / len, -gy / len, -gz / len];
  }
  const c = s.frame.ctr;
  const v: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const len = Math.hypot(...v);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0];
}

// ---- brush

const cellPointCache = new WeakMap<PartSurface, Float32Array<ArrayBuffer>>();

/** Every paint cell's surface point (4 096 × xyz, part-local). Cached per surface. */
export function cellPoints(s: PartSurface): Float32Array<ArrayBuffer> {
  const hit = cellPointCache.get(s);
  if (hit) return hit;
  const out = new Float32Array(UV64_SIZE * UV64_SIZE * 3);
  for (let cell = 0; cell < UV64_SIZE * UV64_SIZE; cell++) {
    const c = cellCenter(cell);
    const p = pointAtHeight(s, c.azimuthDeg, c.t);
    out[cell * 3] = p[0];
    out[cell * 3 + 1] = p[1];
    out[cell * 3 + 2] = p[2];
  }
  cellPointCache.set(s, out);
  return out;
}

/** The cells within `radiusIn` of a part-local point, plus the cell under the point itself (a tiny brush still paints). */
export function brushCells(s: PartSurface, center: Vec3, radiusIn: number): number[] {
  const pts = cellPoints(s);
  const r2 = radiusIn * radiusIn;
  const out = new Set<number>([cellAt(s.frame, center)]);
  for (let cell = 0; cell < UV64_SIZE * UV64_SIZE; cell++) {
    const dx = pts[cell * 3] - center[0];
    const dy = pts[cell * 3 + 1] - center[1];
    const dz = pts[cell * 3 + 2] - center[2];
    if (dx * dx + dy * dy + dz * dz <= r2) out.add(cell);
  }
  return [...out];
}

/** `cells` with `label` written into the given cells; the same array when nothing changes. */
export function paintInto(cells: Uint8Array<ArrayBuffer>, at: readonly number[], label: number): Uint8Array<ArrayBuffer> {
  let out: Uint8Array<ArrayBuffer> | null = null;
  for (const i of at) {
    if (i < 0 || i >= cells.length || cells[i] === label) continue;
    out ??= cells.slice();
    out[i] = label;
  }
  return out ?? cells;
}

/** Mesh vertices (indices) within `radiusIn` of a part-local point; the nearest one when none is. */
export function brushVertices(mesh: Pick<ColoredMesh, 'positions'>, center: Vec3, radiusIn: number): number[] {
  const p = mesh.positions;
  const r2 = radiusIn * radiusIn;
  const out: number[] = [];
  let nearest = -1;
  let nearestD = Infinity;
  for (let v = 0; v * 3 + 2 < p.length; v++) {
    const dx = p[v * 3] - center[0];
    const dy = p[v * 3 + 1] - center[1];
    const dz = p[v * 3 + 2] - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d <= r2) out.push(v);
    if (d < nearestD) {
      nearestD = d;
      nearest = v;
    }
  }
  if (out.length === 0 && nearest >= 0) out.push(nearest);
  return out;
}

/** A mesh with `label` written on the given vertices (fresh label array); the same mesh when nothing changes. */
export function paintVertices(mesh: ColoredMesh, vertices: readonly number[], label: number): ColoredMesh {
  let labels: Uint8Array<ArrayBuffer> | null = null;
  for (const v of vertices) {
    if (v < 0 || v >= mesh.labels.length || mesh.labels[v] === label) continue;
    labels ??= mesh.labels.slice();
    labels[v] = label;
  }
  return labels ? { ...mesh, labels } : mesh;
}

// ---- reading colors (the eyedropper)

/**
 * The palette id the builder shows at a part-local surface point: base color → regions in order (later wins;
 * `pattern` regions are not drawn by the builder) → the paint field (§2.11.1). `meshLabel` = the nearest vertex's
 * label of a mesh part.
 */
export function colorIdAt(part: Part, frame: PaintFrame, local: Vec3, paletteIds: readonly string[], cells?: Uint8Array | null, meshLabel?: number): string {
  const { azimuthDeg: az, t } = surfaceCoords(frame, local);
  const dx = local[0] - frame.ctr[0];
  const dy = local[1] - frame.ctr[1];
  const dz = local[2] - frame.ctr[2];
  const rad = Math.hypot(dx, dy, dz) || 1e-6;
  let id = part.color;
  for (const r of part.regions ?? []) {
    const loose = r as { from?: number; to?: number };
    const inT = t >= (loose.from ?? 0) && t <= (loose.to ?? 1);
    if (r.kind === 'band') {
      if (inT) id = r.color;
    } else if (r.kind === 'stripes') {
      if (inT) id = r.colors[Math.floor((local[1] - frame.min[1]) / r.widthIn) % r.colors.length] ?? id;
    } else if (r.kind === 'patch') {
      if (inT && Math.abs(((((az - r.azimuthDeg) % 360) + 540) % 360) - 180) <= r.spanDeg / 2) id = r.color;
    } else if (r.kind === 'spot') {
      const d = angleDirection(r.azimuthDeg, r.elevationDeg);
      const dot = (dx * d[0] + dy * d[1] + dz * d[2]) / rad;
      if (Math.acos(Math.min(1, dot)) * rad <= r.radiusIn) id = r.color;
    }
  }
  if (cells && part.type !== 'mesh') {
    const label = cells[uv64Cell(az, t)];
    if (label !== UV64_NONE && label < paletteIds.length) id = paletteIds[label];
  }
  if (meshLabel !== undefined && meshLabel !== NO_LABEL && meshLabel < paletteIds.length) id = paletteIds[meshLabel];
  return id;
}

/** The index of the mesh vertex nearest a part-local point (-1 for an empty mesh). */
export function nearestVertex(mesh: Pick<ColoredMesh, 'positions'>, p: Vec3): number {
  let best = -1;
  let bestD = Infinity;
  const q = mesh.positions;
  for (let v = 0; v * 3 + 2 < q.length; v++) {
    const d = (q[v * 3] - p[0]) ** 2 + (q[v * 3 + 1] - p[1]) ** 2 + (q[v * 3 + 2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

// ---- on-model guides (the region being edited)

/** Polylines (part-local) that outline a region on its part: band and stripes edges, a patch's border, a spot's rim. */
export function regionOutline(s: PartSurface, r: Region, segments = 72): Vec3[][] {
  const ring = (t: number): Vec3[] => Array.from({ length: segments + 1 }, (_, i) => pointAtHeight(s, -180 + (360 * i) / segments, t));
  switch (r.kind) {
    case 'band':
      return [ring(r.from), ring(r.to)];
    case 'stripes':
    case 'pattern':
      return [ring(r.from ?? 0), ring(r.to ?? 1)];
    case 'patch': {
      const a0 = r.azimuthDeg - r.spanDeg / 2;
      const a1 = r.azimuthDeg + r.spanDeg / 2;
      const n = Math.max(4, Math.round((segments * r.spanDeg) / 360));
      const m = 12;
      const out: Vec3[] = [];
      for (let i = 0; i <= n; i++) out.push(pointAtHeight(s, a0 + ((a1 - a0) * i) / n, r.from));
      for (let i = 1; i <= m; i++) out.push(pointAtHeight(s, a1, r.from + ((r.to - r.from) * i) / m));
      for (let i = 1; i <= n; i++) out.push(pointAtHeight(s, a1 - ((a1 - a0) * i) / n, r.to));
      for (let i = 1; i <= m; i++) out.push(pointAtHeight(s, a0, r.to - ((r.to - r.from) * i) / m));
      return [out];
    }
    case 'spot':
      return [spotRim(s, r.azimuthDeg, r.elevationDeg, r.radiusIn, segments)];
  }
}

/** The rim of a spot: the directions at angle θ from its center with θ · (distance to the surface) = radius. */
export function spotRim(s: PartSurface, azimuthDeg: number, elevationDeg: number, radiusIn: number, segments = 48): Vec3[] {
  const c = pointAtAngles(s, azimuthDeg, elevationDeg);
  const o = s.frame.ctr;
  const rSurf = Math.max(1e-6, Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]));
  const theta = Math.min(Math.PI, radiusIn / rSurf);
  const d = angleDirection(azimuthDeg, elevationDeg);
  // Two unit vectors perpendicular to d.
  const ref: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(d, ref));
  const v = cross(d, u);
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (2 * Math.PI * i) / segments;
    const dir: Vec3 = [
      d[0] * Math.cos(theta) + (u[0] * Math.cos(phi) + v[0] * Math.sin(phi)) * Math.sin(theta),
      d[1] * Math.cos(theta) + (u[1] * Math.cos(phi) + v[1] * Math.sin(phi)) * Math.sin(theta),
      d[2] * Math.cos(theta) + (u[2] * Math.cos(phi) + v[2] * Math.sin(phi)) * Math.sin(theta),
    ];
    const hit = outerHit(s, o, normalize(dir)) ?? 0;
    out.push([o[0] + dir[0] * hit, o[1] + dir[1] * hit, o[2] + dir[2] * hit]);
  }
  return out;
}

/** The region's handle points (part-local): the draggable spots of the on-model handles (§4.2). */
export type RegionHandle = 'from' | 'to' | 'center' | 'edge' | 'radius';

export function regionHandles(s: PartSurface, r: Region): { handle: RegionHandle; at: Vec3 }[] {
  switch (r.kind) {
    case 'band':
      return [
        { handle: 'to', at: pointAtHeight(s, 0, r.to) },
        { handle: 'from', at: pointAtHeight(s, 0, r.from) },
      ];
    case 'stripes':
      return [
        { handle: 'to', at: pointAtHeight(s, 0, r.to ?? 1) },
        { handle: 'from', at: pointAtHeight(s, 0, r.from ?? 0) },
      ];
    case 'patch':
      return [
        { handle: 'center', at: pointAtHeight(s, r.azimuthDeg, (r.from + r.to) / 2) },
        { handle: 'to', at: pointAtHeight(s, r.azimuthDeg, r.to) },
        { handle: 'from', at: pointAtHeight(s, r.azimuthDeg, r.from) },
        { handle: 'edge', at: pointAtHeight(s, r.azimuthDeg + r.spanDeg / 2, (r.from + r.to) / 2) },
      ];
    case 'spot': {
      const rim = spotRim(s, r.azimuthDeg, r.elevationDeg, r.radiusIn, 4);
      return [
        { handle: 'center', at: pointAtAngles(s, r.azimuthDeg, r.elevationDeg) },
        { handle: 'radius', at: rim[0] },
      ];
    }
    case 'pattern':
      return [];
  }
}

/**
 * A region with one handle dragged to a part-local surface point `p` (on-model handles, §4.2): `from` / `to` take
 * the point's height, a patch's center its azimuth (keeping the height span, moved to the point's height), its edge
 * the half span, a spot's center its direction and its radius handle the arc distance from the center.
 */
export function dragRegion<R extends Region>(s: PartSurface, r: R, handle: RegionHandle, p: Vec3): R {
  const { azimuthDeg, t } = surfaceCoords(s.frame, p);
  const out = { ...r } as Region;
  const tt = Math.min(1, Math.max(0, t));
  if ((out.kind === 'band' || out.kind === 'stripes' || out.kind === 'patch' || out.kind === 'pattern') && (handle === 'from' || handle === 'to')) {
    const from = out.from ?? 0;
    const to = out.to ?? 1;
    if (handle === 'from') out.from = Math.min(tt, to);
    else out.to = Math.max(tt, from);
  }
  if (out.kind === 'patch' && handle === 'center') {
    const half = (out.to - out.from) / 2;
    const mid = Math.min(1 - half, Math.max(half, tt));
    out.azimuthDeg = azimuthDeg;
    out.from = mid - half;
    out.to = mid + half;
  }
  if (out.kind === 'patch' && handle === 'edge') {
    const delta = Math.abs(((((azimuthDeg - out.azimuthDeg) % 360) + 540) % 360) - 180);
    out.spanDeg = Math.min(360, Math.max(2, 2 * delta));
  }
  if (out.kind === 'spot' && handle === 'center') {
    const o = s.frame.ctr;
    const dx = p[0] - o[0];
    const dy = p[1] - o[1];
    const dz = p[2] - o[2];
    out.azimuthDeg = Math.atan2(dx, dz) / D2R;
    out.elevationDeg = Math.atan2(dy, Math.hypot(dx, dz)) / D2R;
  }
  if (out.kind === 'spot' && handle === 'radius') {
    const o = s.frame.ctr;
    const d = angleDirection(out.azimuthDeg, out.elevationDeg);
    const v: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const rad = Math.hypot(...v) || 1e-6;
    const ang = Math.acos(Math.min(1, Math.max(-1, (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / rad)));
    out.radiusIn = Math.max(0.02, ang * rad);
  }
  return out as R;
}

/** A part-local point of `part` in model space (re-exported for the viewport). */
export function toWorld(part: Part, local: Vec3): Vec3 {
  return localToWorld(part, local);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}
