// Track T3 — the geometry build of `GeomApi.build` (DESIGN.md §2.9.2–2.9.5, §2.9.7 step 5): photos' masks → an
// SDF volume → a validated mesh in inches → a one-part `crochet-model` (`source.stage: 'recon'`).
//
// Paths:
//   - several views constraining X, Y and Z: separable hull (D12) + front-view rounding (D13, κ = 1);
//   - several views on ONE plane with the height (front + back, left + right: F3's "add a back photo"): the
//     inflation of the united silhouette (κ = settings.kappa) in the object frame, the photo plane at depth 0;
//   - one view: the single-image inflation in the PHOTO frame (κ = settings.kappa), turned into the object frame by
//     `settings.photoView` (§2.9.3, exact permutation).
// Then: cleanVolume → marching cubes → Taubin → decimation (≤ 3×) → manifold-3d validation → inches (lowest point
// y = 0, scaled to `settings.targetHeightIn`; for a single top photo that is the longest extent in the photo plane)
// → the stored part volume (`sdf:<meshRef>`, part-local) → inferAttach → nameParts → inferMirrorPairs.
//
// T3.2 builds ONE part (`body`). Labels (255 = unknown), the photo palette and label images, part decomposition,
// the neck split and fitting are T3.3; depth fusion (`useDepth`) is T3.4.
//
// `gate.check(jobId)` runs between stages (§5.4 cooperative cancellation).
import { createFnv1a64 } from '../kernel/hash';
import { encodeSdfVolume, sampleSdfVolume } from '../kernel/geom/sdfVolume';
import { inferAttach, inferMirrorPairs } from '../model/attach';
import { nameParts } from '../model/naming';
import { roundVec3 } from '../model/transforms';
import type { ColoredMesh, ReconRequest, ReconResult, SdfVolume, Vec3, ViewLabel } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Part } from '../../types/model';
import {
  ALIGN_ISSUES,
  DEFAULT_ALIGN,
  PLANE_AXES,
  VIEW_CLOSE_R,
  VIEW_CONVENTIONS,
  alignViews,
  alignedBounds,
  consistencyFromTables,
  makeGrid,
  orientMask,
  planeTables,
  type AlignedView,
  type Alignment,
  type ReconGrid,
  type ViewMask,
  type ViewPlane,
} from './align';
import { frontRounding, inflatedVolume, inflationTable, maxOf, MULTI_VIEW_KAPPA, projectionIoU, separableHull, viewInflation } from './hull';
import { fillHoles, maskBox, morphClose, MASK_ISSUES } from './masks';
import { boundsOf, cleanVolume, meshField, thinSamples, validateMesh, type MeshValidation } from './mesh';
import { decimate } from './simplify';
import { turnVolume } from './viewTurn';

/** Issue codes of the build (proposed for §2.13 in docs/tracks/t3.md). */
export const RECON_ISSUES = {
  /** Nothing is left after carving (misaligned or mislabelled views, empty masks). */
  empty: 'E_RECON_EMPTY',
  /** manifold-3d rejected the mesh (should not happen: marching cubes output is always a closed 2-manifold). */
  invalid: 'E_RECON_INVALID',
  /** Pieces not connected to the main body were dropped. */
  detached: 'W_RECON_DETACHED',
  /** The shape has a hole through it (genus > 0) and "keep holes" is off. */
  genus: 'W_RECON_GENUS',
  /** Parts thinner than 2 voxels: they will be crocheted flat. */
  thin: 'I_RECON_THIN',
} as const;

/** Dropped pieces below this fraction of the inside volume are noise and raise no warning. */
export const DETACHED_WARN_FRACTION = 0.005;
/** Thin samples below this fraction of the inside volume raise no note (rims, single bumps). */
export const THIN_NOTE_FRACTION = 0.002;
/** §2.9.5 step 4: target mean edge = min(w, h)/3 of the stitch cell. */
export const EDGE_PER_STITCH = 1 / 3;
/** The stored part volume extends this many samples beyond the inside samples (§2.9.7 step 3). */
export const SDF_MARGIN = 2;
/** §2.9.3: the resolution while sliders move, and on release. */
export const RECON_PREVIEW_N = 64;
export const RECON_FINAL_N = 128;
/** The resolutions of `ReconSettings.N` (§2.9.3). */
export const RECON_RESOLUTIONS = [64, 128, 192] as const;

/** The default palette of a model built before colors are projected (T3.3 replaces it). */
export const RECON_BASE_COLOR = { id: 'main', hex: '#d9b99b', name: 'Main color', role: 'main' } as const;

/** A build that cannot produce a model. The message starts with the issue code (`E_VIEWS: …`). */
export class ReconError extends Error {
  readonly code: string;
  readonly issues: Issue[];
  constructor(issue: Issue, issues: Issue[] = [issue]) {
    super(`${issue.code}: ${issue.message}`);
    this.name = 'ReconError';
    this.code = issue.code;
    this.issues = issues;
  }
}

/** The issue code of a failed build, also after the error crossed a worker boundary (comlink keeps the message). */
export function reconErrorCode(error: unknown): string | null {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  const m = typeof message === 'string' ? /^([EWI]_[A-Z0-9_]+): /.exec(message) : null;
  return m ? m[1] : null;
}

export interface BuildOptions {
  gate?: { check(jobId: number): Promise<void> };
  /** Filled with the milliseconds of each stage (diagnostics, perf tests). */
  timings?: Record<string, number>;
}

const PHOTO_NAMES: Record<ViewLabel, string> = { front: 'front', back: 'back', left: 'left side', right: 'right side', top: 'top', bottom: 'bottom' };

/** The volume of a path before clean-up, in the object frame. */
interface Volume {
  field: Float32Array<ArrayBuffer>;
  grid: ReconGrid;
  iouPerView: Record<string, number>;
  issues: Issue[];
  /** Single top photo: scale the longest extent in the photo plane (X, Z) instead of the height. */
  scaleBy: 'height' | 'planeExtent';
}

function checkRequest(r: ReconRequest): void {
  const s = r.settings;
  if (!RECON_RESOLUTIONS.includes(s.N)) throw new RangeError(`settings.N must be 64, 128 or 192, got ${s.N}`);
  if (!(s.targetHeightIn > 0) || !Number.isFinite(s.targetHeightIn)) throw new RangeError(`settings.targetHeightIn must be a finite number > 0, got ${s.targetHeightIn}`);
  if (!(s.kappa > 0) || !Number.isFinite(s.kappa)) throw new RangeError(`settings.kappa must be a finite number > 0, got ${s.kappa}`);
  if (!Array.isArray(r.views) || r.views.length === 0) throw new RangeError('a build needs at least one view');
  for (const v of r.views) {
    if (!Number.isInteger(v.maskW) || !Number.isInteger(v.maskH) || v.maskW < 1 || v.maskH < 1) throw new RangeError(`view ${v.view.id}: mask size must be integers ≥ 1`);
    if (v.mask.length !== v.maskW * v.maskH) throw new RangeError(`view ${v.view.id}: mask has ${v.mask.length} entries, expected ${v.maskW * v.maskH}`);
  }
  const c = r.gauge?.cell;
  if (!c || !(c.w > 0) || !(c.h > 0)) throw new RangeError('gauge.cell must have positive w and h');
}

/** Multi-view: separable hull + front rounding. */
async function hullVolume(alignment: Alignment, N: number, check: () => Promise<void>, t: (k: string) => void): Promise<Volume> {
  const grid = makeGrid(alignedBounds(alignment), N);
  const tables = planeTables(alignment, grid);
  t('tables');
  const consistency = consistencyFromTables(alignment, grid, tables);
  await check();
  const field = separableHull(tables.planes, N);
  t('hull');
  await check();
  const T = inflationTable(alignment.views, grid, 'XY');
  if (T) frontRounding(field, grid, T, MULTI_VIEW_KAPPA);
  t('rounding');
  const iouPerView: Record<string, number> = {};
  for (const v of alignment.views) iouPerView[v.id] = projectionIoU(field, N, v.convention.plane, tables.perView[v.id]);
  return { field, grid, iouPerView, issues: consistency.issues, scaleBy: 'height' };
}

/** One plane only (single photo in its frame, or front + back / left + right in the object frame). */
async function planeVolume(alignment: Alignment, plane: ViewPlane, N: number, kappa: number, check: () => Promise<void>, t: (k: string) => void): Promise<Volume> {
  const pixelT: Record<string, Float32Array<ArrayBuffer>> = {};
  let maxT = 0;
  for (const v of alignment.views) {
    if (v.convention.plane !== plane) continue;
    pixelT[v.id] = viewInflation(v);
    maxT = Math.max(maxT, maxOf(pixelT[v.id]));
  }
  t('inflation');
  await check();
  const bounds = alignedBounds(alignment);
  const depthAxis = 3 - PLANE_AXES[plane][0] - PLANE_AXES[plane][1];
  bounds.min[depthAxis] = -kappa * maxT;
  bounds.max[depthAxis] = kappa * maxT;
  const grid = makeGrid(bounds, N);
  const tables = planeTables(alignment, grid);
  const sd = tables.planes[plane] as Float32Array;
  const T = inflationTable(alignment.views, grid, plane, pixelT) as Float32Array;
  t('tables');
  await check();
  const field = inflatedVolume(sd, T, grid, plane, kappa);
  t('volume');
  const iouPerView: Record<string, number> = {};
  for (const v of alignment.views) iouPerView[v.id] = projectionIoU(field, N, v.convention.plane, tables.perView[v.id]);
  return { field, grid, iouPerView, issues: [], scaleBy: 'height' };
}

/** A single photo as an aligned view of the PHOTO frame (front conventions: u = x', v = y', toward camera = z'). */
function photoFrameView(r: ReconRequest['views'][number], keepHoles: boolean): AlignedView | null {
  const align = { ...DEFAULT_ALIGN, ...r.view.align };
  const turned = orientMask(r.mask, r.maskW, r.maskH, align.rot90, align.mirror);
  const filled = keepHoles ? turned.mask : fillHoles(turned.mask, turned.w, turned.h);
  const mask = morphClose(filled, turned.w, turned.h, VIEW_CLOSE_R);
  const box = maskBox(mask, turned.w, turned.h);
  if (!box) return null;
  if (!(align.scale > 0) || !Number.isFinite(align.scale)) throw new RangeError(`align.scale must be a finite number > 0, got ${align.scale}`);
  return {
    id: r.view.id,
    label: 'front',
    convention: VIEW_CONVENTIONS.front,
    mask,
    w: turned.w,
    h: turned.h,
    box,
    autoPxPerUnit: box.h,
    pxPerUnit: box.h / align.scale,
    offset: [align.dx, align.dy],
    align,
  };
}

/** The bounding box of the inside samples (f ≥ 0) of an N³ field, grown by `margin` and clamped; null if none. */
function insideBox(field: ArrayLike<number>, N: number, margin: number): { lo: Vec3; hi: Vec3 } | null {
  const lo: Vec3 = [N, N, N];
  const hi: Vec3 = [-1, -1, -1];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      const row = N * (y + N * z);
      for (let x = 0; x < N; x++) {
        if (!(field[row + x] >= 0)) continue;
        if (x < lo[0]) lo[0] = x;
        if (x > hi[0]) hi[0] = x;
        if (y < lo[1]) lo[1] = y;
        if (y > hi[1]) hi[1] = y;
        if (z < lo[2]) lo[2] = z;
        if (z > hi[2]) hi[2] = z;
      }
    }
  }
  if (hi[0] < 0) return null;
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.max(0, lo[k] - margin);
    hi[k] = Math.min(N - 1, hi[k] + margin);
  }
  return { lo, hi };
}

/** The part-local stored volume (§2.9.7 step 3): the field cropped to its inside box + 2 samples, in inches. */
function partVolume(field: Float32Array, grid: ReconGrid, toInches: (p: Vec3) => Vec3, scale: number): SdfVolume {
  const { N, origin, voxel } = grid;
  const box = insideBox(field, N, SDF_MARGIN) as { lo: Vec3; hi: Vec3 };
  const dims: [number, number, number] = [box.hi[0] - box.lo[0] + 1, box.hi[1] - box.lo[1] + 1, box.hi[2] - box.lo[2] + 1];
  const crop = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      const src = box.lo[0] + N * (box.lo[1] + y + N * (box.lo[2] + z));
      const dst = dims[0] * (y + dims[1] * z);
      for (let x = 0; x < dims[0]; x++) {
        const v = field[src + x];
        // +∞ (a full mask's interior) cannot be stored: saturate.
        crop[dst + x] = (Number.isFinite(v) ? v : v > 0 ? 1e6 : -1e6) * scale;
      }
    }
  }
  const o = toInches([origin[0] + voxel * box.lo[0], origin[1] + voxel * box.lo[1], origin[2] + voxel * box.lo[2]]);
  return encodeSdfVolume(crop, dims, o, voxel * scale);
}

function meshRefOf(positions: Float32Array, indices: Uint32Array): string {
  return `recon_${createFnv1a64().update(positions).update(indices).hex().slice(0, 12)}`;
}

/**
 * Builds the geometry of a `ReconRequest` (§2.9.2–2.9.5). Throws `ReconError` (message `E_…: …`) when no model can
 * be made, `RangeError` for a malformed request, and whatever `o.gate.check` throws (`Superseded`).
 */
export async function buildRecon(req: ReconRequest, o: BuildOptions = {}): Promise<ReconResult> {
  checkRequest(req);
  const s = req.settings;
  const N = s.N;
  const check = async (): Promise<void> => {
    if (o.gate) await o.gate.check(req.jobId);
  };
  let last = performance.now();
  const t = (k: string): void => {
    const now = performance.now();
    if (o.timings) o.timings[k] = (o.timings[k] ?? 0) + (now - last);
    last = now;
  };

  // ---- volume
  let vol: Volume;
  const issues: Issue[] = [];
  if (req.views.length === 1) {
    const r = req.views[0];
    const photo = photoFrameView(r, s.keepHoles);
    if (!photo) {
      throw new ReconError({
        code: MASK_ISSUES.empty,
        severity: 'error',
        message: `No object was found in the ${PHOTO_NAMES[r.view.label] ?? 'chosen'} photo. Paint it with the brush or try a plainer background.`,
        where: { view: r.view.id },
      });
    }
    t('masks');
    const alignment: Alignment = { views: [photo], extents: [photo.box.w / photo.box.h, 1, 0], scaleMismatch: {}, planes: ['XY'], issues: [] };
    const inPhoto = await planeVolume(alignment, 'XY', N, s.kappa, check, t);
    const turned = turnVolume({ data: inPhoto.field, dims: [N, N, N], origin: inPhoto.grid.origin, voxel: inPhoto.grid.voxel }, s.photoView);
    vol = {
      field: turned.data,
      grid: { N, origin: turned.origin, voxel: turned.voxel },
      iouPerView: inPhoto.iouPerView,
      issues: [],
      scaleBy: s.photoView === 'top' ? 'planeExtent' : 'height',
    };
    t('turn');
  } else {
    const masks: ViewMask[] = req.views.map((v) => ({ id: v.view.id, label: v.view.label, mask: v.mask, w: v.maskW, h: v.maskH, align: v.view.align }));
    const alignment = alignViews(masks, { keepHoles: s.keepHoles });
    t('masks');
    const errors = alignment.issues.filter((i) => i.severity === 'error');
    issues.push(...alignment.issues.filter((i) => i.severity !== 'error'));
    const showsHeight = alignment.planes.length === 1 && alignment.planes[0] !== 'XZ' && alignment.views.length > 0;
    if (errors.length === 0) {
      vol = await hullVolume(alignment, N, check, t);
    } else if (errors.every((e) => e.code === ALIGN_ISSUES.views) && showsHeight) {
      vol = await planeVolume(alignment, alignment.planes[0], N, s.kappa, check, t);
    } else {
      throw new ReconError(errors[0], [...errors, ...issues]);
    }
    issues.push(...vol.issues);
  }
  await check();

  // ---- clean-up
  const { field, grid } = vol;
  const clean = cleanVolume(field, N, grid.voxel, { mergeTouching: s.mergeTouching });
  t('clean');
  if (clean.inside === 0) {
    throw new ReconError(
      {
        code: RECON_ISSUES.empty,
        severity: 'error',
        message: 'The photos do not overlap in 3D, so nothing is left of the object. Check the labels, the masks and the alignment.',
      },
      issues,
    );
  }
  const dropped = clean.removed / (clean.removed + clean.inside);
  if (dropped >= DETACHED_WARN_FRACTION) {
    issues.push({
      code: RECON_ISSUES.detached,
      severity: 'warn',
      message: `${Math.round(dropped * 1000) / 10}% of the shape was not connected to the main body and was left out. If parts only touch in the photos, turn on "Merge touching parts".`,
    });
  }
  const thin = thinSamples(field, N);
  if (thin.count >= THIN_NOTE_FRACTION * clean.inside) {
    issues.push({
      code: RECON_ISSUES.thin,
      severity: 'info',
      message: 'Some parts are thinner than two voxels (ears, tails, fins): they will be crocheted as flat pieces.',
    });
  }
  t('thin');
  await check();

  // ---- mesh (world units), decimate, validate
  const raw = meshField(field, grid);
  t('mesh');
  await check();
  const rawBounds = boundsOf(raw.positions);
  const extentOf = (b: { size: Vec3 }): number => (vol.scaleBy === 'height' ? b.size[1] : Math.max(b.size[0], b.size[2]));
  const worldPerInch = extentOf(rawBounds) / s.targetHeightIn;
  if (!(worldPerInch > 0)) {
    throw new ReconError({ code: RECON_ISSUES.empty, severity: 'error', message: 'The shape came out empty. Check the masks.' }, issues);
  }
  const targetEdge = EDGE_PER_STITCH * Math.min(req.gauge.cell.w, req.gauge.cell.h) * worldPerInch;
  const dec = await decimate(raw, targetEdge, { maxError: 0.5 * grid.voxel });
  t('decimate');
  let checked: MeshValidation = await validateMesh(dec.mesh);
  if ((checked.status !== 'NoError' || !(checked.volume > 0)) && dec.mesh !== raw) checked = await validateMesh(raw);
  t('validate');
  if (checked.status !== 'NoError' || !(checked.volume > 0)) {
    throw new ReconError(
      { code: RECON_ISSUES.invalid, severity: 'error', message: `The mesh could not be validated (${checked.status}). Try another resolution or "Merge touching parts".` },
      issues,
    );
  }
  if (checked.genus > 0 && !s.keepHoles) {
    issues.push({
      code: RECON_ISSUES.genus,
      severity: 'warn',
      message: `The shape has ${checked.genus === 1 ? 'a hole' : `${checked.genus} holes`} through it (for example an arm that touches the body). Fix the masks, or turn on "keep holes" if the hole is real.`,
    });
  }
  await check();

  // ---- inches: lowest point y = 0, scaled to the target; part-local mesh around its bbox center
  const mesh = checked.mesh;
  const b = boundsOf(mesh.positions);
  const scale = s.targetHeightIn / extentOf(b);
  const shift: Vec3 = [0, b.min[1], 0];
  const toInches = (p: Vec3): Vec3 => [(p[0] - shift[0]) * scale, (p[1] - shift[1]) * scale, (p[2] - shift[2]) * scale];
  const centerIn = toInches(b.center);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p = toInches([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    positions[i] = p[0] - centerIn[0];
    positions[i + 1] = p[1] - centerIn[1];
    positions[i + 2] = p[2] - centerIn[2];
  }
  const indices = Uint32Array.from(mesh.indices);
  const sizeIn: Vec3 = [b.size[0] * scale, b.size[1] * scale, b.size[2] * scale];
  const sdf = partVolume(field, grid, (p) => {
    const q = toInches(p);
    return [q[0] - centerIn[0], q[1] - centerIn[1], q[2] - centerIn[2]];
  }, scale);
  t('inches');

  // ---- the model: one mesh part; attach tree, names, pairs in the §2.9.7 step 5 order
  const meshRef = meshRefOf(positions, indices);
  const part: Part = {
    id: 'body',
    type: 'mesh',
    dims: { meshRef, bboxIn: roundVec3(sizeIn) },
    position: roundVec3(centerIn),
    color: RECON_BASE_COLOR.id,
    stuffing: 'firm',
  };
  let model: CrochetModelV1 = {
    schema: 'crochet-model',
    version: '1.0',
    revision: 1,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: req.views.length === 1 ? 'Toy from one photo' : 'Toy from photos',
    finishedSize: { height: sizeIn[1], width: sizeIn[0], depth: sizeIn[2] },
    palette: [{ ...RECON_BASE_COLOR }],
    parts: [part],
    source: { stage: 'recon', views: req.views.map((v) => v.view.label) },
  };
  const meshSdf = { [meshRef]: (p: Vec3): number => sampleSdfVolume(sdf, p) };
  model = inferAttach(model, { meshSdf }).model;
  model = nameParts(model).model;
  model = inferMirrorPairs(model, { tolerance: 0.1 }).model;
  t('model');

  const colored: ColoredMesh = { positions, indices, labels: new Uint8Array(positions.length / 3).fill(255) };
  return {
    jobId: req.jobId,
    model,
    meshes: { [meshRef]: colored },
    sdfs: { [meshRef]: sdf },
    labelImages: {},
    photoPalette: [],
    report: { iouPerView: vol.iouPerView, parts: model.parts.length, genus: checked.genus },
    issues,
  };
}
