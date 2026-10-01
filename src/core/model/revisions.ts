// Model revisions: what the app's own settings keep when the 3D model is replaced (DESIGN.md §5.2.1, §3.7.7,
// §5.5.5). Step 0 kernel: pure, no DOM.
//
// A rebuild from photos and a Claude Design import never edit the model in place: they produce a NEW model,
// and `projectStore.commitModelRevision` makes it the current one. The new model knows nothing about what the
// user set in the editor, so those settings are carried over from the previous model, by part id:
//
//   crochet hints   always (`Part.crochet`: make, start, axis, seed, style, seam);
//   paint           only when the part still has the same type and every dimension is within 10% — a uv64
//                   field painted on one shape would color the wrong rounds of a different one. Otherwise it
//                   stays in the previous revision and is reported in `paintDropped`, and the diff offers
//                   "Carry anyway" (`carryPaintAnyway`);
//   features        the ones the new model does not have (by feature id), when the part they sit on still exists.
//
// Paint cells are palette INDICES and a feature's color is a palette ID, so both are remapped onto the new
// model's palette by color identity: the same palette id, else the same hex, else the color is added to the new
// palette, else (the palette is full) the nearest color by ΔE00.
import type { CarryOverFn, CarryReport } from '../../types/entryPoints';
import type { CrochetModelV1, Feature, PaletteColor, Part, PartCrochetHints } from '../../types/model';
import { deltaE00Hex, isHex } from '../kernel/color';

export type { CarryReport } from '../../types/entryPoints';

/** "Every dim within 10%" (§3.7.7). */
export const PAINT_TOLERANCE = 0.1;
/** Limits of the model schema (§3.5.2). */
export const MAX_PALETTE = 16;
export const MAX_FEATURES = 60;

/** A paint field is 64 × 64 palette indices; 255 = not painted (§3.5.1, §2.11.1). */
const PAINT_CELLS = 64 * 64;
const PAINT_NONE = 255;
const EPS = 1e-9;

export interface CarryOptions {
  /** Part ids whose paint is carried although the shape changed ("Carry anyway", §3.7.7). */
  carryPaintAnyway?: readonly string[];
}

export function emptyCarryReport(): CarryReport {
  return { crochet: [], paint: [], paintDropped: [], features: [] };
}

// ---- "the same type and every dim within 10%"

const within = (prev: number, next: number, tolerance: number): boolean => Math.abs(next - prev) <= tolerance * Math.abs(prev) + EPS;

/** A list of [number, number] points: what a lathe profile and a polygon outline must be to be compared. */
function isPointList(value: unknown): value is readonly (readonly [number, number])[] {
  return Array.isArray(value) && value.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** The largest radius of a lathe profile at height `y` (a profile may hold several points at one height). */
function radiusAt(profile: readonly (readonly [number, number])[], y: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < profile.length; i++) {
    const [r, py] = profile[i];
    if (Math.abs(py - y) <= EPS) best = Math.max(best, r);
    if (i + 1 === profile.length) break;
    const [r2, y2] = profile[i + 1];
    if (y2 - py > EPS && y > py && y < y2) best = Math.max(best, r + ((r2 - r) * (y - py)) / (y2 - py));
  }
  if (best !== Number.NEGATIVE_INFINITY) return best;
  // y lies outside the profile by rounding: the nearest end
  return y <= profile[0][1] ? profile[0][0] : profile[profile.length - 1][0];
}

/**
 * Two lathe profiles describe the same shape within the tolerance: the height and the largest radius are
 * within 10%, and at 33 heights from bottom to top the radii differ by at most 10% of the largest radius. The
 * number of points may differ (a re-imported body rarely keeps its points).
 */
function profilesWithin(prev: readonly (readonly [number, number])[], next: readonly (readonly [number, number])[], tolerance: number): boolean {
  if (!isPointList(prev) || !isPointList(next) || prev.length === 0 || next.length === 0) return false;
  const span = (p: readonly (readonly [number, number])[]) => ({
    y0: p[0][1],
    height: p[p.length - 1][1] - p[0][1],
    rMax: p.reduce((m, [r]) => Math.max(m, r), 0),
  });
  const a = span(prev);
  const b = span(next);
  if (!within(a.height, b.height, tolerance) || !within(a.rMax, b.rMax, tolerance)) return false;
  const SAMPLES = 32;
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES;
    const ra = radiusAt(prev, a.y0 + t * a.height);
    const rb = radiusAt(next, b.y0 + t * b.height);
    if (Math.abs(rb - ra) > tolerance * a.rMax + EPS) return false;
  }
  return true;
}

function pointsWithin(prev: readonly (readonly [number, number])[] | undefined, next: readonly (readonly [number, number])[] | undefined, scale: number, tolerance: number): boolean {
  if (prev === undefined || next === undefined) return prev === next;
  if (!isPointList(prev) || !isPointList(next) || prev.length !== next.length) return false;
  return prev.every(([x, y], i) => Math.abs(next[i][0] - x) <= tolerance * scale + EPS && Math.abs(next[i][1] - y) <= tolerance * scale + EPS);
}

/**
 * True when `next` still has the shape `prev` was painted on: the same part type, and every dimension within
 * `tolerance` (10%) of the previous value. Position and rotation do not matter (paint lives in the part's own
 * frame). Details per type: a cylinder's `open` and a lathe's `sharp` are not dimensions; a torus without
 * `arcDeg` is a full ring (360°); lathes are compared as curves (`profilesWithin`); a flat part must keep its
 * `shape`, and a polygon its number of points; a mesh part is compared by its bounding box. Dimensions that
 * are missing or not finite numbers never match: the answer is then false, not an exception.
 */
export function sameShapeWithin(prev: Part, next: Part, tolerance: number = PAINT_TOLERANCE): boolean {
  const near = (a: number, b: number): boolean => within(a, b, tolerance);
  switch (prev.type) {
    case 'sphere':
      return next.type === 'sphere' && near(prev.dims.r, next.dims.r);
    case 'ellipsoid':
      return next.type === 'ellipsoid' && near(prev.dims.rx, next.dims.rx) && near(prev.dims.ry, next.dims.ry) && near(prev.dims.rz, next.dims.rz);
    case 'capsule':
      return next.type === 'capsule' && near(prev.dims.r, next.dims.r) && near(prev.dims.length, next.dims.length);
    case 'cylinder':
      return next.type === 'cylinder' && near(prev.dims.rTop, next.dims.rTop) && near(prev.dims.rBottom, next.dims.rBottom) && near(prev.dims.h, next.dims.h);
    case 'cone':
      return next.type === 'cone' && near(prev.dims.r, next.dims.r) && near(prev.dims.h, next.dims.h);
    case 'torus':
      return next.type === 'torus' && near(prev.dims.R, next.dims.R) && near(prev.dims.r, next.dims.r) && near(prev.dims.arcDeg ?? 360, next.dims.arcDeg ?? 360);
    case 'lathe':
      return next.type === 'lathe' && profilesWithin(prev.dims.profile, next.dims.profile, tolerance);
    case 'flat':
      return (
        next.type === 'flat' &&
        prev.dims.shape === next.dims.shape &&
        near(prev.dims.w, next.dims.w) &&
        near(prev.dims.h, next.dims.h) &&
        near(prev.dims.thickness, next.dims.thickness) &&
        (prev.dims.shape !== 'polygon' || pointsWithin(prev.dims.points, next.dims.points, Math.max(Math.abs(prev.dims.w), Math.abs(prev.dims.h)), tolerance))
      );
    case 'box':
      return next.type === 'box' && near(prev.dims.w, next.dims.w) && near(prev.dims.h, next.dims.h) && near(prev.dims.d, next.dims.d);
    case 'mesh':
      return next.type === 'mesh' && Array.isArray(prev.dims.bboxIn) && Array.isArray(next.dims.bboxIn) && prev.dims.bboxIn.every((v, i) => near(v, next.dims.bboxIn[i]));
  }
}

// ---- palette remapping

const sameHex = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Maps colors of the previous palette onto `palette` (the new model's, extended as needed). */
function createPaletteMap(prevPalette: readonly PaletteColor[], nextPalette: readonly PaletteColor[]) {
  const palette = [...nextPalette];
  const byPrevIndex = new Map<number, number>();

  const resolve = (color: PaletteColor): number => {
    const byId = palette.findIndex((c) => c.id === color.id);
    if (byId >= 0) return byId;
    const byHex = palette.findIndex((c) => sameHex(c.hex, color.hex));
    if (byHex >= 0) return byHex;
    if (palette.length < MAX_PALETTE) {
      palette.push({ ...color });
      return palette.length - 1;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < palette.length; i++) {
      const d = isHex(color.hex) && isHex(palette[i].hex) ? deltaE00Hex(color.hex, palette[i].hex) : Number.MAX_VALUE;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  };

  return {
    /** The new palette index for an index into the previous palette; PAINT_NONE for an index that names nothing. */
    index(prevIndex: number): number {
      if (prevIndex >= prevPalette.length) return PAINT_NONE;
      let mapped = byPrevIndex.get(prevIndex);
      if (mapped === undefined) {
        mapped = resolve(prevPalette[prevIndex]);
        byPrevIndex.set(prevIndex, mapped);
      }
      return mapped;
    },
    /** The new palette id for a palette id of the previous model (unknown ids are returned unchanged). */
    id(prevId: string): string {
      if (palette.some((c) => c.id === prevId)) return prevId;
      const color = prevPalette.find((c) => c.id === prevId);
      return color ? palette[resolve(color)].id : prevId;
    },
    /** True when the new palette indexes every previous color exactly as the previous palette did. */
    sameIndices: (): boolean => prevPalette.every((c, i) => nextPalette[i]?.id === c.id),
    palette,
    grew: (): boolean => palette.length > nextPalette.length,
  };
}

function decodePaint(data: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length !== PAINT_CELLS) return null;
  const cells = new Uint8Array(PAINT_CELLS);
  for (let i = 0; i < PAINT_CELLS; i++) cells[i] = binary.charCodeAt(i);
  return cells;
}

function encodePaint(cells: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < cells.length; i += CHUNK) binary += String.fromCharCode(...cells.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * The paint field re-indexed for the new palette, or null when it cannot be carried: data that is not a
 * 64 × 64 field cannot be re-indexed, so it is carried only when the palette indices did not move.
 */
function remapPaint(paint: NonNullable<Part['paint']>, map: ReturnType<typeof createPaletteMap>): NonNullable<Part['paint']> | null {
  const cells = decodePaint(paint.data);
  if (!cells) return map.sameIndices() ? paint : null;
  let changed = false;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v === PAINT_NONE) continue;
    const mapped = map.index(v);
    if (mapped !== v) {
      cells[i] = mapped;
      changed = true;
    }
  }
  return changed ? { kind: paint.kind, data: encodePaint(cells) } : paint;
}

// ---- carry-over

function sameHint(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/**
 * `prev`'s hints over `next`'s (the user's setting wins, key by key), or null when that changes nothing. Only the
 * keys `prev` sets count: a hint an editor left `undefined` does not wipe the value the new model brings.
 */
function mergeHints(prev: PartCrochetHints | undefined, next: PartCrochetHints | undefined): PartCrochetHints | null {
  if (!prev) return null;
  const keys = (Object.keys(prev) as (keyof PartCrochetHints)[]).filter((k) => prev[k] !== undefined);
  if (keys.length === 0) return null;
  if (next && keys.every((k) => sameHint(prev[k], next[k]))) return null;
  const merged: Record<string, unknown> = { ...next };
  for (const key of keys) merged[key] = prev[key];
  return merged as PartCrochetHints;
}

/**
 * `carryOver` with the "Carry anyway" list (`commitModelRevision` passes `carryPaintAnyway` here).
 *
 * Never mutates its arguments; the result shares everything that did not change with `next`, and is `next`
 * itself when nothing was carried. The report lists part ids in the order of `next.parts` and feature ids in
 * the order of `prev.features`:
 *   crochet        hints of the previous part were written onto the new part (the previous value wins per key);
 *   paint          the previous paint was written onto the new part, re-indexed for the new palette;
 *   paintDropped   the previous part had paint, the part still exists, but its shape changed (or the field
 *                  could not be re-indexed) and it was not in `carryPaintAnyway`: the paint stays in the
 *                  previous revision. Parts that no longer exist are not listed;
 *   features       features of the previous model that the new one lacks, appended (up to 60 in total).
 */
export function carryOverWith(prev: CrochetModelV1 | undefined, next: CrochetModelV1, o: CarryOptions = {}): { model: CrochetModelV1; report: CarryReport } {
  const report = emptyCarryReport();
  if (!prev) return { model: next, report };

  const anyway = new Set(o.carryPaintAnyway ?? []);
  const prevParts = new Map<string, Part>();
  for (const part of prev.parts) if (!prevParts.has(part.id)) prevParts.set(part.id, part);
  const map = createPaletteMap(prev.palette, next.palette);

  let partsChanged = false;
  const parts = next.parts.map((part): Part => {
    const before = prevParts.get(part.id);
    if (!before) return part;
    let result = part;

    const hints = mergeHints(before.crochet, part.crochet);
    if (hints) {
      result = { ...result, crochet: hints };
      report.crochet.push(part.id);
    }

    if (before.paint && !(part.paint && part.paint.kind === before.paint.kind && part.paint.data === before.paint.data)) {
      const carried = sameShapeWithin(before, part) || anyway.has(part.id) ? remapPaint(before.paint, map) : null;
      if (carried) {
        // The new part may already hold exactly this field (re-indexed): then there is nothing to carry.
        if (!(part.paint && part.paint.kind === carried.kind && part.paint.data === carried.data)) {
          result = { ...result, paint: carried };
          report.paint.push(part.id);
        }
      } else {
        report.paintDropped.push(part.id);
      }
    }

    if (result !== part) partsChanged = true;
    return result;
  });

  const nextFeatures = next.features ?? [];
  const haveFeature = new Set(nextFeatures.map((f) => f.id));
  const havePart = new Set(next.parts.map((p) => p.id));
  const carriedFeatures: Feature[] = [];
  for (const feature of prev.features ?? []) {
    if (nextFeatures.length + carriedFeatures.length >= MAX_FEATURES) break;
    if (haveFeature.has(feature.id) || !havePart.has(feature.on)) continue;
    haveFeature.add(feature.id);
    const color = feature.color === undefined ? undefined : map.id(feature.color);
    carriedFeatures.push(color === feature.color ? feature : { ...feature, color });
    report.features.push(feature.id);
  }

  if (!partsChanged && carriedFeatures.length === 0 && !map.grew()) return { model: next, report };
  const model: CrochetModelV1 = { ...next };
  if (partsChanged) model.parts = parts;
  if (map.grew()) model.palette = map.palette;
  if (carriedFeatures.length > 0) model.features = [...nextFeatures, ...carriedFeatures];
  return { model, report };
}

/**
 * Carries the app-owned settings of the previous model into a new one, by part id (§5.2.1): `crochet` hints
 * always, `paint` when the part's type is unchanged and every dim is within 10%, and the features the new
 * model lacks. `prev` is undefined for the first model of a project: nothing to carry.
 */
export const carryOver: CarryOverFn = (prev, next) => carryOverWith(prev, next);
