// The shared reference builder `builder-v1` (DESIGN.md §3.4.1). Step 0 kernel.
//
// `buildModel` is the normative code block of §3.4.1 in TypeScript: one named mesh per part, every geometry
// centered on the part's local origin EXCEPT `LatheGeometry`, which is not re-centered — a lathe's origin (its
// `position`) is the axis point at profile y = 0 (§0.1). The prompt embeds the same code as plain JavaScript
// with `unitScale = 0.0254` (meters); the app calls it with `unitScale = 1` (inches).
//
// Beyond the normative text, for the app only (none of this is ever sent to Claude Design):
//   - `mesh` parts are built from the buffers passed in `meshes` (keyed by `dims.meshRef`); without a buffer the
//     part is drawn as the ellipsoid inscribed in its `bboxIn` box, so every part always yields finite geometry;
//   - the `paint` field of a primitive (uv64, §2.11.1) and the vertex labels of a mesh part are painted on top
//     of the regions.
//
// three.js is used for math and geometry only; nothing here needs a DOM or a renderer.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part } from '../../types/model';
import { sanePart } from './dims';

export const BUILDER_VERSION = 'builder-v1';
/** `unitScale` for a scene in inches (the app). */
export const UNIT_SCALE_INCHES = 1;
/** `unitScale` for a scene in meters (the Claude Design stage; the default of §3.4.1). */
export const UNIT_SCALE_METERS = 0.0254;

/** Side of the square paint grid of a primitive (§2.11.1): `paint.data` is base64 of 64 × 64 palette indices. */
export const UV64_SIZE = 64;
/** The paint value for "no paint here". */
export const UV64_NONE = 255;

const D2R = MathUtils.degToRad;
const FALLBACK_COLOR = '#cccccc';
const finite = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const KNOWN_TYPES: ReadonlySet<string> = new Set(['sphere', 'ellipsoid', 'capsule', 'cylinder', 'cone', 'torus', 'lathe', 'flat', 'box', 'mesh']);

type FlatDims = Extract<Part, { type: 'flat' }>['dims'];

/**
 * Builds the three.js object of a model: a `Group` named after the model, holding one `Mesh` per part
 * (`mesh.name` = part id, `material.name` = color id, `mesh.userData.crochet` = the part,
 * `group.userData.crochetModel` = the whole spec).
 *
 * `unitScale` is scene units per inch: 1 in the app, 0.0254 (the default, as in §3.4.1) for a stage in meters.
 * `meshes` supplies the buffers of `mesh` parts, keyed by `dims.meshRef` (part-local inches).
 */
export function buildModel(spec: CrochetModelV1, unitScale = UNIT_SCALE_METERS, meshes?: Record<string, ColoredMesh>): Group {
  const S = unitScale;
  const pal = new Map<string, string>(spec.palette.map((c) => [c.id, c.hex]));
  const paletteIds = spec.palette.map((c) => c.id);
  const mats = new Map<string, MeshStandardMaterial>();
  const solid = (id: string): MeshStandardMaterial => {
    let m = mats.get(id);
    if (!m) {
      m = new MeshStandardMaterial({ color: pal.get(id) ?? FALLBACK_COLOR, roughness: 0.85, metalness: 0 });
      m.name = id;
      mats.set(id, m);
    }
    return m;
  };
  const group = new Group();
  group.name = spec.name || 'model';
  group.userData.crochetModel = spec;
  for (const p of spec.parts) {
    const g = partGeometry(p, S, meshes);
    let mat = solid(p.color);
    const ids = vertexColorIds(g, p, S, { paletteIds, mesh: p.type === 'mesh' ? meshes?.[p.dims.meshRef] : undefined });
    if (ids) {
      applyVertexColors(g, ids, pal);
      mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
      mat.name = `${p.color}_painted`;
    }
    const m = new Mesh(g, mat);
    m.name = p.id;
    m.userData.crochet = p;
    // A scene graph never holds NaN: a broken number in an unvalidated model counts as 0.
    m.position.set(finite(p.position?.[0]) * S, finite(p.position?.[1]) * S, finite(p.position?.[2]) * S);
    const r = p.rotationDeg ?? [0, 0, 0];
    m.rotation.set(D2R(finite(r[0])), D2R(finite(r[1])), D2R(finite(r[2])), 'XYZ');
    group.add(m);
  }
  return group;
}

/**
 * The geometry of one part in its local frame (`geometryFor` of §3.4.1), scaled by `unitScale` (default 1:
 * inches). The reference for every dimension of the schema (§3.5.2).
 */
export function partGeometry(part: Part, unitScale = UNIT_SCALE_INCHES, meshes?: Record<string, ColoredMesh>): BufferGeometry {
  const S = unitScale;
  const p = sanePart(part); // the part itself when it is valid; never NaN or a negative length into three.js
  switch (p.type) {
    case 'sphere':
      return new SphereGeometry(p.dims.r * S, 48, 32);
    case 'ellipsoid':
      return new SphereGeometry(1, 48, 32).scale(p.dims.rx * S, p.dims.ry * S, p.dims.rz * S);
    case 'capsule':
      return new CapsuleGeometry(p.dims.r * S, Math.max(0, p.dims.length - 2 * p.dims.r) * S, 12, 32);
    case 'cylinder':
      return new CylinderGeometry(p.dims.rTop * S, p.dims.rBottom * S, p.dims.h * S, 48, 1, p.dims.open === 'both');
    case 'cone':
      return new ConeGeometry(p.dims.r * S, p.dims.h * S, 48);
    case 'torus':
      return new TorusGeometry(p.dims.R * S, p.dims.r * S, 24, 64, D2R(p.dims.arcDeg ?? 360));
    case 'lathe': {
      // LatheGeometry reads two points at least; a one-point profile (invalid, §3.5.2) is drawn as its ring.
      const profile = p.dims.profile.length === 1 ? [p.dims.profile[0], p.dims.profile[0]] : p.dims.profile;
      return new LatheGeometry(
        profile.map(([r, y]) => new Vector2(r * S, y * S)),
        48,
      );
    }
    case 'box':
      return new BoxGeometry(p.dims.w * S, p.dims.h * S, p.dims.d * S, 4, 4, 4);
    case 'flat':
      return flatGeometry(p.dims, S).center();
    case 'mesh': {
      const mesh = meshes?.[p.dims.meshRef];
      if (mesh && mesh.positions.length >= 9) return meshGeometry(mesh, S);
      // No buffer at hand: the ellipsoid inscribed in the part's bounding box.
      const [bx, by, bz] = p.dims.bboxIn;
      return new SphereGeometry(1, 48, 32).scale((bx / 2) * S, (by / 2) * S, (bz / 2) * S);
    }
    default:
      throw new Error(`unknown part type ${String((p as { type?: unknown }).type)}`);
  }
}

/** The uncentered extrusion of a flat part: z from −0.3·t to 0.7·t, the outline grown by the bevel in between. */
function flatGeometry(d: FlatDims, S: number): ExtrudeGeometry {
  const t = d.thickness * S;
  return new ExtrudeGeometry(shape2D(d, S), {
    depth: t * 0.4,
    bevelEnabled: true,
    bevelThickness: t * 0.3,
    bevelSize: flatBevelSize(d) * S,
    bevelSegments: 4,
    curveSegments: 32,
  });
}

/** How far the builder's bevel grows the outline of a flat part at mid-thickness, in inches. */
export function flatBevelSize(d: FlatDims): number {
  return Math.min(d.thickness * 0.3, 0.1 * Math.min(d.w, d.h));
}

/** The outline of a flat part in its local XY plane, facing +Z (`shape2D` of §3.4.1). */
function shape2D(d: FlatDims, S: number): Shape {
  const w = d.w * S;
  const h = d.h * S;
  const s = new Shape();
  if (d.shape === 'circle' || d.shape === 'oval') {
    s.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2);
  } else if (d.shape === 'teardrop') {
    s.moveTo(0, h / 2);
    s.bezierCurveTo(w * 0.55, 0, w * 0.5, -h / 2, 0, -h / 2);
    s.bezierCurveTo(-w * 0.5, -h / 2, -w * 0.55, 0, 0, h / 2);
  } else if (d.shape === 'triangle') {
    s.moveTo(0, h / 2);
    s.lineTo(w / 2, -h / 2);
    s.lineTo(-w / 2, -h / 2);
    s.closePath();
  } else if (d.shape === 'polygon' && Array.isArray(d.points) && d.points.length >= 3) {
    d.points.forEach(([x, y], i) => (i ? s.lineTo(x * S, y * S) : s.moveTo(x * S, y * S)));
    s.closePath();
  } else {
    // 'rect' — and a polygon without usable points, which the schema rejects (§3.5.2) but must not throw here.
    s.moveTo(-w / 2, -h / 2);
    s.lineTo(w / 2, -h / 2);
    s.lineTo(w / 2, h / 2);
    s.lineTo(-w / 2, h / 2);
    s.closePath();
  }
  return s;
}

function meshGeometry(mesh: ColoredMesh, S: number): BufferGeometry {
  const g = new BufferGeometry();
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i] * S;
  g.setAttribute('position', new BufferAttribute(positions, 3));
  if (mesh.indices.length > 0) g.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
  g.computeVertexNormals();
  return g;
}

// ---- colors

/**
 * The palette id of every vertex of a part's geometry: base color → regions in order, later wins (band,
 * stripes, patch, spot; `pattern` regions are rendered by the app only) → the paint field (uv64 for primitives,
 * vertex labels for mesh parts). This is `paint()` of §3.4.1, returning ids instead of writing colors.
 *
 * `g` must be the part's geometry at the same `unitScale`. Returns `null` when the part is one solid color
 * (no regions and no paint), which is what the builder renders with the shared solid material.
 */
export function vertexColorIds(
  g: BufferGeometry,
  p: Part,
  unitScale = UNIT_SCALE_INCHES,
  o?: { paletteIds?: readonly string[]; mesh?: ColoredMesh },
): string[] | null {
  const S = unitScale;
  const regions = p.regions ?? [];
  const grid = p.type !== 'mesh' && p.paint?.kind === 'uv64' && o?.paletteIds ? decodeUv64(p.paint.data) : null;
  const labels = p.type === 'mesh' && o?.mesh && o.paletteIds ? o.mesh.labels : null;
  const pos = g.attributes.position;
  const hasLabels = labels !== null && labels.length === pos.count && labels.some((l) => l !== UV64_NONE);
  if (regions.length === 0 && !grid && !hasLabels) return null;

  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb) return null;
  const ctr = bb.getCenter(new Vector3());
  const v = new Vector3();
  const H = Math.max(1e-6, bb.max.y - bb.min.y);
  const ids: string[] = new Array<string>(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y - bb.min.y) / H;
    const dx = v.x - ctr.x;
    const dy = v.y - ctr.y;
    const dz = v.z - ctr.z;
    const rad = Math.hypot(dx, dy, dz) || 1e-6;
    const az = (Math.atan2(dx, dz) * 180) / Math.PI;
    let id = p.color;
    for (const r of regions) {
      if (r.kind === 'band') {
        if (t >= r.from && t <= r.to) id = r.color;
      } else if (r.kind === 'stripes') {
        if (t >= (r.from ?? 0) && t <= (r.to ?? 1)) {
          id = r.colors[Math.floor((v.y - bb.min.y) / (r.widthIn * S)) % r.colors.length] ?? id;
        }
      } else if (r.kind === 'patch') {
        const inT = t >= r.from && t <= r.to;
        if (inT && Math.abs(((((az - r.azimuthDeg) % 360) + 540) % 360) - 180) <= r.spanDeg / 2) id = r.color;
      } else if (r.kind === 'spot') {
        const a = D2R(r.azimuthDeg);
        const e = D2R(r.elevationDeg);
        const dot = (dx * Math.cos(e) * Math.sin(a) + dy * Math.sin(e) + dz * Math.cos(e) * Math.cos(a)) / rad;
        if (Math.acos(Math.min(1, dot)) * rad <= r.radiusIn * S) id = r.color;
      }
    }
    if (grid && o?.paletteIds) {
      const label = grid[uv64Cell(az, t)];
      if (label !== UV64_NONE && label < o.paletteIds.length) id = o.paletteIds[label];
    }
    if (hasLabels && labels && o?.paletteIds) {
      const label = labels[i];
      if (label !== UV64_NONE && label < o.paletteIds.length) id = o.paletteIds[label];
    }
    ids[i] = id;
  }
  return ids;
}

function applyVertexColors(g: BufferGeometry, ids: readonly string[], pal: ReadonlyMap<string, string>): void {
  const col = new Float32Array(ids.length * 3);
  const c = new Color();
  for (let i = 0; i < ids.length; i++) {
    c.set(pal.get(ids[i]) ?? FALLBACK_COLOR); // set() converts sRGB → linear
    col[3 * i] = c.r;
    col[3 * i + 1] = c.g;
    col[3 * i + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

/**
 * The cell of the 64 × 64 paint grid for a surface direction (§2.11.1: `u = az/360 + 0.5`, `v = t`): row-major
 * with one row per height step, `index = row · 64 + column`, `row = ⌊v · 64⌋` (0 = bottom) and
 * `column = ⌊u · 64⌋` (0 = the back seam at azimuth −180°, 32 = the front), both clamped to 0…63.
 */
export function uv64Cell(azimuthDeg: number, t: number): number {
  const u = azimuthDeg / 360 + 0.5;
  const col = Math.min(UV64_SIZE - 1, Math.max(0, Math.floor(u * UV64_SIZE)));
  const row = Math.min(UV64_SIZE - 1, Math.max(0, Math.floor(t * UV64_SIZE)));
  return row * UV64_SIZE + col;
}

/** Decodes `paint.data` into its 64 × 64 palette indices; `null` when it is not base64 of exactly 4096 bytes. */
export function decodeUv64(data: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length !== UV64_SIZE * UV64_SIZE) return null;
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encodes 64 × 64 palette indices (255 = none) as `paint.data`. */
export function encodeUv64(cells: Uint8Array): string {
  if (cells.length !== UV64_SIZE * UV64_SIZE) {
    throw new RangeError(`encodeUv64: expected ${UV64_SIZE * UV64_SIZE} cells, got ${cells.length}`);
  }
  let binary = '';
  for (let i = 0; i < cells.length; i++) binary += String.fromCharCode(cells[i]);
  return btoa(binary);
}

// ---- tessellation for the other kernels (inches, part-local)

/** A part's builder geometry as plain buffers: part-local inches, ArrayBuffer-backed copies. */
export interface PartTessellation {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

/**
 * Tessellates one part with the builder (`unitScale = 1`): the vertices and triangles of its geometry in the
 * part's local frame. Geometries without an index (flat parts) get the trivial one.
 */
export function tessellatePart(p: Part, meshes?: Record<string, ColoredMesh>): PartTessellation {
  // Unlike the builder, the kernels do not throw on a part type they do not know: it has no geometry.
  if (!KNOWN_TYPES.has(p.type)) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  const g = partGeometry(p, UNIT_SCALE_INCHES, meshes);
  const src = g.attributes.position;
  const positions = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    positions[3 * i] = src.getX(i);
    positions[3 * i + 1] = src.getY(i);
    positions[3 * i + 2] = src.getZ(i);
  }
  const index = g.getIndex();
  const indices = new Uint32Array(index ? index.count : src.count);
  if (index) for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  else for (let i = 0; i < src.count; i++) indices[i] = i;
  g.dispose();
  return { positions, indices };
}

/** What the other kernels need to know about a flat part's builder geometry. */
export interface FlatLayout {
  /**
   * The outline as the builder places it: closed polygon [x0, y0, x1, y1, …] in local XY (the first point is
   * not repeated), shifted exactly like the builder's `.center()`. This is the outline of the front and back
   * faces; at mid-thickness the bevel grows it by `flatBevelSize`.
   */
  outline: Float64Array<ArrayBuffer>;
  /** Half extents of the builder geometry's bounding box (bevel included), centered on the local origin. */
  half: [number, number, number];
  /** Every vertex of the builder geometry (bevel included), part-local inches, [x, y, z, …] without duplicates. */
  vertices: Float32Array<ArrayBuffer>;
}

const flatCache = new Map<string, FlatLayout>();
const FLAT_CACHE_MAX = 64;

/** The builder layout of a flat part (cached by its dims; deterministic). */
export function flatLayout(dims: FlatDims): FlatLayout {
  const d = sanePart({ type: 'flat', dims } as Part).dims as FlatDims;
  const key = JSON.stringify([d.shape, d.w, d.h, d.thickness, d.shape === 'polygon' ? d.points : null]);
  const hit = flatCache.get(key);
  if (hit) return hit;

  const g = flatGeometry(d, 1);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const center = bb ? bb.getCenter(new Vector3()) : new Vector3();
  const size = bb ? bb.getSize(new Vector3()) : new Vector3();

  const contour = shape2D(d, 1).extractPoints(32).shape;
  if (contour.length > 1 && contour[0].equals(contour[contour.length - 1])) contour.pop();
  const outline = new Float64Array(contour.length * 2);
  for (let i = 0; i < contour.length; i++) {
    outline[2 * i] = contour[i].x - center.x;
    outline[2 * i + 1] = contour[i].y - center.y;
  }

  const src = g.attributes.position;
  const seen = new Set<string>();
  const unique: number[] = [];
  for (let i = 0; i < src.count; i++) {
    const x = src.getX(i) - center.x;
    const y = src.getY(i) - center.y;
    const z = src.getZ(i) - center.z;
    const k = `${x},${y},${z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(x, y, z);
  }
  g.dispose();

  const layout: FlatLayout = {
    outline,
    half: [size.x / 2, size.y / 2, size.z / 2],
    vertices: new Float32Array(unique),
  };
  if (flatCache.size >= FLAT_CACHE_MAX) {
    const oldest = flatCache.keys().next();
    if (!oldest.done) flatCache.delete(oldest.value);
  }
  flatCache.set(key, layout);
  return layout;
}
