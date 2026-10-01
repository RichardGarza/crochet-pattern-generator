// Track T7 — the geometry-only path shared by OBJ, PLY, STL and GLB ladder step 4 (DESIGN.md §3.7.5): objects with
// world-space vertices in raw units → the units rule (before anything else) → vertices scaled to inches → a
// primitive fitted per object with T3's `fitPart` where it is implemented (accepted at a residual ≤ 0.12, §2.9.7
// step 4), else a `mesh` part (Path B) → a canonical-shaped model that the repairs of §3.7.6 finish: `inferAttach`
// gives the attach tree by proximity, `nameParts` names generic ids, then `inferMirrorPairs` (10% tolerance).
import type { ColoredMesh } from '../../types/geometry';
import type { ImportContext, UnitsDecision } from '../../types/importer';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, PaletteColor, Part, Vec3 } from '../../types/model';
import { fitPart } from '../recon/fit';
import { isImplemented } from '../stub';
import { roundCoord, roundVec3 } from '../model/transforms';
import { MODEL_LIMITS } from '../model/limits';
import { labelRemap, remapMeshLabels } from './accept';
import { IMPORT_CODES, issue, RepairLog } from './common';
import { colorSlug, dedupeId, DEFAULT_MODEL_NAME, type Normalized } from './dialect';
import { partSlug, type RepairOptions } from './repair';
import { decideUnits, type UnitsHints } from './units';

/** A color of a geometry file (an MTL material, a GLB material, a PLY vertex color). `hex` is sRGB. */
export interface GeoColor {
  hex: string;
  /** A name to derive the palette id from (`caramel_yarn`), else `c_<hex>`. */
  name?: string;
}

/** One object of a geometry file: world-space vertices in the file's raw units. */
export interface GeoObject {
  name: string;
  /** xyz, raw units, world space. */
  positions: Float32Array | Float64Array;
  /** Triangles. */
  indices: Uint32Array;
  /** Index into `GeometrySource.colors` for the whole object. */
  color?: number;
  /** Per vertex: index into `GeometrySource.colors`, 255 = unknown (PLY vertex colors). */
  vertexColors?: Uint8Array;
}

export interface GeometrySource {
  objects: GeoObject[];
  colors: GeoColor[];
  hints?: UnitsHints;
  /** `source` of the model (`{ tool: 'claude-design', stage: 'refined' }` for a three-d-stage export). */
  source?: CrochetModelV1['source'];
  /** Remarks of the reader (skipped objects, colors that could not be read). */
  warnings?: Issue[];
}

/** §2.9.7 step 4: a fit is accepted at an RMS radial error ≤ 12% of the mean radius. */
export const FIT_ACCEPT_RESIDUAL = 0.12;
/** §2.9.7 step 5: twins of a reconstruction are never exact. */
export const GEOMETRY_MIRROR_TOLERANCE = 0.1;
/** A part made from nothing but a gray when the file has no colors. */
export const NO_COLOR_HEX = '#9E9E9E';

const GENERIC_ID =
  /^(?:p_)?(?:part|mesh|object|obj|group|node|component|comp|piece|solid|shape|geometry|geom|default|untitled|polysurface|poly|surface|model|cube|sphere|cylinder|cone|torus|plane|icosphere|circle|body_part)?_?\d*$/;

/** An id that says nothing about the part (`part_3`, `mesh_0`, `object`, `sphere_001`, ``): `nameParts` names it. */
export function isGenericId(id: string): boolean {
  return id === '' || GENERIC_ID.test(id);
}

export interface GeometryNormalized {
  n: Normalized;
  options: RepairOptions;
  units: UnitsDecision;
}

/**
 * Non-finite coordinates (a PLY `nan`, an overflow) are moved onto the object's finite bounds and every triangle
 * that uses them is dropped, so no NaN or Infinity reaches a mesh buffer; indices outside the vertex list are dropped.
 */
function cleanObject(o: GeoObject): GeoObject {
  const n = Math.floor(o.positions.length / 3);
  let bad: Uint8Array | null = null;
  for (let i = 0; i < n * 3; i++) {
    if (!Number.isFinite(o.positions[i])) {
      bad ??= new Uint8Array(n);
      bad[Math.floor(i / 3)] = 1;
    }
  }
  let badIndex = false;
  for (let k = 0; k < o.indices.length; k++) if (o.indices[k] >= n) badIndex = true;
  if (!bad && !badIndex && o.indices.length % 3 === 0) return o;
  const positions = Float64Array.from(o.positions.subarray(0, n * 3));
  const b = boundsOf(positions);
  if (bad) for (let v = 0; v < n; v++) if (bad[v]) for (let k = 0; k < 3; k++) if (!Number.isFinite(positions[3 * v + k])) positions[3 * v + k] = b ? b.min[k] : 0;
  const tris: number[] = [];
  for (let t = 0; t + 2 < o.indices.length; t += 3) {
    const a = o.indices[t];
    const c = o.indices[t + 1];
    const d = o.indices[t + 2];
    if (a >= n || c >= n || d >= n || (bad && (bad[a] || bad[c] || bad[d]))) continue;
    tris.push(a, c, d);
  }
  return { ...o, positions, indices: Uint32Array.from(tris) };
}

function boundsOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } | null {
  if (positions.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (!Number.isFinite(v)) continue;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

/**
 * The model of a geometry-only carrier, before the repairs, and the options the repairs need. Returns a failure
 * issue when nothing usable is left (no triangles, a flat or empty model).
 */
export function normalizeGeometry(src: GeometrySource, ctx: ImportContext = {}): GeometryNormalized | { failure: Issue } {
  const warnings: Issue[] = [...(src.warnings ?? [])];
  const usable = src.objects.map(cleanObject).filter((o) => {
    const ok = o.indices.length >= 3 && o.positions.length >= 9 && boundsOf(o.positions) !== null;
    if (!ok) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `"${o.name || 'an unnamed object'}" has no triangles: skipped`));
    return ok;
  });
  if (usable.length === 0) return { failure: issue(IMPORT_CODES.noModel, 'error', 'the file holds no triangles to read a shape from') };
  // the 60-part limit keeps the LARGEST objects (by bounding box), in file order — never the body for 60 beads
  let objects = usable;
  if (usable.length > MODEL_LIMITS.maxParts) {
    const size = usable.map((o) => {
      const b = boundsOf(o.positions) as { min: Vec3; max: Vec3 };
      return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    });
    const keep = new Set(usable.map((_, i) => i).sort((a, b) => size[b] - size[a] || a - b).slice(0, MODEL_LIMITS.maxParts));
    objects = usable.filter((_, i) => keep.has(i));
    warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `the file has ${usable.length} separate objects: only the ${objects.length} largest were kept`));
  }

  // ---- units, on the raw bounding box of everything (§3.7.5), before fitting and before any clamp
  let minY = Infinity;
  let maxY = -Infinity;
  for (const o of objects) {
    const b = boundsOf(o.positions);
    if (!b) continue;
    minY = Math.min(minY, b.min[1]);
    maxY = Math.max(maxY, b.max[1]);
  }
  const rawHeight = maxY - minY;
  if (!(rawHeight > 0) || !Number.isFinite(rawHeight)) return { failure: issue(IMPORT_CODES.noModel, 'error', 'the shapes in this file are flat (no height): nothing to build a toy from') };
  const units = decideUnits(rawHeight, ctx, src.hints);
  let f = units.factor;
  const repairs = new RepairLog();
  repairs.add('units', { code: 'units', message: units.message, data: { ...units.decision, factor: roundCoord(f, 9) } });
  // §3.5.2 limits, on the real vertices: a model at most 60 in tall, a mesh part at most 48 in across. Scaling here
  // keeps every mesh buffer and its `bboxIn` in agreement (the repairs measure mesh parts by `bboxIn`).
  let extent = 0;
  for (const o of objects) {
    const b = boundsOf(o.positions) as { min: Vec3; max: Vec3 };
    extent = Math.max(extent, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  }
  const shrink = Math.min(1, MODEL_LIMITS.maxHeightIn / (rawHeight * f), MODEL_LIMITS.maxDimIn / (extent * f));
  if (shrink < 1) {
    f *= shrink;
    repairs.add('limits', {
      code: 'limits',
      message: `the model would be ${roundCoord(rawHeight * units.factor, 1)} in tall with a part ${roundCoord(extent * units.factor, 1)} in across: scaled down to fit the limits (${MODEL_LIMITS.maxHeightIn} in tall, ${MODEL_LIMITS.maxDimIn} in per part)`,
      data: { factor: roundCoord(shrink, 9) },
    });
  }
  if (!(Number.isFinite(f) && f > 0)) return { failure: issue(IMPORT_CODES.noModel, 'error', 'the size of this model cannot be read') };

  // ---- palette
  const palette: { id: string; hex: string; name?: string }[] = [];
  const paletteIndex = new Map<number, number>();
  const takenColors = new Set<string>();
  const colorOf = (k: number): number => {
    const known = paletteIndex.get(k);
    if (known !== undefined) return known;
    const c = src.colors[k];
    const base = c.name ? colorSlug(c.name) : `c_${c.hex.slice(1).toLowerCase()}`;
    // two materials with one color and one name are one yarn
    const same = palette.findIndex((p) => p.hex.toLowerCase() === c.hex.toLowerCase() && p.id === base);
    if (same >= 0) {
      paletteIndex.set(k, same);
      return same;
    }
    const id = dedupeId(base, takenColors, 16);
    takenColors.add(id);
    palette.push(c.name ? { id, hex: c.hex, name: c.name } : { id, hex: c.hex });
    paletteIndex.set(k, palette.length - 1);
    return palette.length - 1;
  };
  let grayIndex = -1;
  const gray = (): number => {
    if (grayIndex < 0) {
      const id = dedupeId('gray', takenColors, 16);
      takenColors.add(id);
      palette.push({ id, hex: NO_COLOR_HEX, name: 'gray' });
      grayIndex = palette.length - 1;
      repairs.add('color', { code: 'color', message: 'some parts have no color in the file: they are gray until you pick their yarn', data: { hex: NO_COLOR_HEX } });
    }
    return grayIndex;
  };

  // ---- parts: fitted primitives, else mesh parts
  const canFit = isImplemented(fitPart);
  const takenIds = new Set<string>();
  const takenRefs = new Set<string>();
  const parts: Record<string, unknown>[] = [];
  const meshes: Record<string, ColoredMesh> = {};
  const genericIds: boolean[] = [];
  let fitted = 0;
  objects.forEach((o, i) => {
    const slug = partSlug(o.name);
    const id = dedupeId(slug || `part_${i + 1}`, takenIds, 32);
    takenIds.add(id);
    genericIds.push(isGenericId(slug));
    // world inches
    const n = o.positions.length - (o.positions.length % 3);
    const world = new Float32Array(n);
    for (let k = 0; k < n; k++) world[k] = o.positions[k] * f;
    // colors: the object's own, else the most common vertex color, else gray
    const count = n / 3;
    const labels = new Uint8Array(count).fill(255);
    let main: number | undefined;
    if (o.vertexColors && o.vertexColors.length === count) {
      const tally = new Map<number, number>();
      for (let v = 0; v < count; v++) {
        const c = o.vertexColors[v];
        if (c === 255 || c >= src.colors.length) continue;
        const pi = colorOf(c);
        labels[v] = pi;
        tally.set(pi, (tally.get(pi) ?? 0) + 1);
      }
      let best = -1;
      for (const [pi, t] of tally) if (best < 0 || t > (tally.get(best) ?? 0)) best = pi;
      if (best >= 0) main = best;
    }
    if (main === undefined && o.color !== undefined && o.color < src.colors.length) main = colorOf(o.color);
    if (main === undefined) main = gray();
    for (let v = 0; v < count; v++) if (labels[v] === 255) labels[v] = main;
    const color = palette[main].id;
    const mesh: ColoredMesh = { positions: world, indices: o.indices.slice(), labels };

    if (canFit) {
      try {
        const r = fitPart(mesh);
        if (r.type !== 'mesh' && Number.isFinite(r.residual) && r.residual <= FIT_ACCEPT_RESIDUAL) {
          fitted += 1;
          parts.push({ id, type: r.type, dims: r.dims, position: r.position, rotationDeg: r.rotationDeg, color });
          return;
        }
      } catch {
        // a fit that throws is a fit that failed: the part stays a mesh
      }
    }
    // a mesh part: vertices part-local about the bbox center (§3.5.1)
    const b = boundsOf(world) as { min: Vec3; max: Vec3 };
    const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const local = new Float32Array(n);
    for (let k = 0; k < n; k++) local[k] = world[k] - center[k % 3];
    const bboxIn = [0, 1, 2].map((k) => Math.max(1e-4, roundCoord(b.max[k] - b.min[k]))) as Vec3;
    const meshRef = dedupeId(`mesh_${id}`.slice(0, 32), takenRefs, 32);
    takenRefs.add(meshRef);
    meshes[meshRef] = { ...mesh, positions: local };
    parts.push({ id, type: 'mesh', dims: { meshRef, bboxIn }, position: roundVec3(center), color });
  });
  if (!canFit) {
    warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `shape fitting is not available in this build: the ${parts.length} part${parts.length === 1 ? ' is' : 's are'} kept as meshes (sculptable; the pattern treats them as free-form pieces)`));
  } else if (fitted < parts.length) {
    warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `${parts.length - fitted} of ${parts.length} parts did not fit a simple shape: they are kept as meshes`));
  }

  const model: Record<string, unknown> = {
    schema: 'crochet-model',
    version: '1.0',
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: DEFAULT_MODEL_NAME,
    finishedSize: {},
    palette,
    parts,
    ...(src.source ? { source: src.source } : {}),
  };
  const keepIds = new Set(parts.filter((_, i) => !genericIds[i]).map((p) => p.id as string));
  const name = genericIds.some(Boolean);
  return {
    n: { model: model as unknown as CrochetModelV1, dialect: 'geometry-only', noStatedHeight: true, repairs, warnings },
    options: {
      geometry: { name, ...(name ? { keepIds } : {}), mirrorTolerance: GEOMETRY_MIRROR_TOLERANCE },
      ...(Object.keys(meshes).length > 0 ? { meshes } : {}),
    },
    units: units.decision,
  };
}

/**
 * After the repairs: keep only the meshes of mesh parts that survived, and re-point their vertex labels at the
 * final palette (the repairs may rename colors, or merge them past 16).
 */
export function finishMeshes(model: CrochetModelV1, before: readonly PaletteColor[], meshes: Record<string, ColoredMesh> | undefined): Record<string, ColoredMesh> | undefined {
  if (!meshes) return undefined;
  const out: Record<string, ColoredMesh> = {};
  // by id, else hex, else the nearest color: merged colors (the 16-color limit) keep a label
  const table = labelRemap(before, model.palette);
  for (const p of model.parts as Part[]) {
    if (p.type !== 'mesh' || !Object.hasOwn(meshes, p.dims.meshRef)) continue;
    out[p.dims.meshRef] = remapMeshLabels(meshes[p.dims.meshRef], table);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
