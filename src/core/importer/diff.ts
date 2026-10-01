// Track T7 — the diff an import shows before Accept (DESIGN.md §3.7.7): parts added and removed; dims changed by
// more than 2%; parts moved more than 0.1 in; color changes; and the paint carry rule — `paint` comes along only
// when the part's type is unchanged and every dim is within 10% (`sameShapeWithin`, the Step 0 kernel the commit
// itself uses), so the diff can say "photo colors not carried: body, head" and offer a per-part "Carry anyway".
// Pure; ids are compared as written (both models are validated).
import type { CrochetModelV1, Feature, Part } from '../../types/model';
import { PAINT_TOLERANCE, sameShapeWithin } from '../model/revisions';
import { roundCoord } from '../model/transforms';

/** "dims changed > 2%" (§3.7.7). */
export const DIFF_DIMS_TOLERANCE = 0.02;
/** "moved > 0.1 in" (§3.7.7). */
export const DIFF_MOVE_IN = 0.1;
/** A turn worth listing (not in §3.7.7's list; reported with the moves). */
export const DIFF_TURN_DEG = 2;

export interface DimChange {
  key: string;
  from: number;
  to: number;
}

export interface PartChange {
  part: string;
  /** The part's type changed (then `dims` is empty: the shapes are not comparable key by key). */
  type?: { from: Part['type']; to: Part['type'] };
  /** Numeric dims that changed by more than 2% (lathe profiles and polygon outlines as `profile` / `points`). */
  dims: DimChange[];
  /** Distance between the old and the new position (in), when above 0.1 in. */
  movedIn?: number;
  /** Largest change of one Euler angle (degrees), when above 2°. */
  turnedDeg?: number;
  /** The part's main color changed (sRGB hex, as the palettes write them). */
  color?: { from: string; to: string };
}

export interface ModelDiff {
  added: string[];
  removed: string[];
  changed: PartChange[];
  /** Parts with photo colors (`paint`) that will come along (same type, every dim within 10%). */
  paintCarried: string[];
  /** Parts with photo colors that stay behind unless "Carry anyway" is picked for them. */
  paintNotCarried: string[];
  /**
   * Features only the previous model has: `removed` = in the seed Claude Design saw (it left them out: they go),
   * `kept` = added in the editor (Accept carries them back); `added` = only in the new model.
   */
  features: { removed: string[]; kept: string[]; added: string[] };
  /** Palette colors (hex) the new model adds or drops. */
  palette: { added: string[]; removed: string[] };
  /** Nothing listed at all. */
  same: boolean;
  /** One line per finding, in the order shown in the dialog ("photo colors not carried: body, head"). */
  summary: string[];
}

const hexOf = (m: CrochetModelV1, id: string): string | undefined => m.palette.find((c) => c.id === id)?.hex;

function relChanged(a: number, b: number, tol: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a !== b;
  return Math.abs(b - a) > tol * Math.max(Math.abs(a), 1e-9);
}

function dimChanges(prev: Part, next: Part): DimChange[] {
  const a = prev.dims as Record<string, unknown>;
  const b = next.dims as Record<string, unknown>;
  const out: DimChange[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' || typeof y === 'number') {
      const from = typeof x === 'number' ? x : NaN;
      const to = typeof y === 'number' ? y : NaN;
      if (relChanged(from, to, DIFF_DIMS_TOLERANCE)) out.push({ key, from, to });
    } else if (Array.isArray(x) || Array.isArray(y)) {
      // profiles, outlines, bboxIn: only an array that changed, judged as a whole with the same 2%
      if (JSON.stringify(x) !== JSON.stringify(y) && !sameShapeWithin(prev, next, DIFF_DIMS_TOLERANCE)) out.push({ key, from: Array.isArray(x) ? x.length : NaN, to: Array.isArray(y) ? y.length : NaN });
    } else if (x !== y && key !== 'meshRef') {
      out.push({ key, from: NaN, to: NaN });
    }
  }
  return out;
}

const list = (ids: readonly string[]): string => (ids.length <= 6 ? ids.join(', ') : `${ids.slice(0, 6).join(', ')} and ${ids.length - 6} more`);

/** §3.7.7: what accepting `next` changes compared with `prev` (the project's seed or current model). */
export function diffModels(prev: CrochetModelV1 | undefined, next: CrochetModelV1, o: { seedFeatureIds?: Iterable<string> } = {}): ModelDiff {
  const before = new Map<string, Part>();
  for (const p of prev?.parts ?? []) if (!before.has(p.id)) before.set(p.id, p);
  const after = new Map<string, Part>();
  for (const p of next.parts) if (!after.has(p.id)) after.set(p.id, p);
  const added = next.parts.filter((p) => !before.has(p.id)).map((p) => p.id);
  const removed = (prev?.parts ?? []).filter((p) => !after.has(p.id)).map((p) => p.id);
  const changed: PartChange[] = [];
  const paintCarried: string[] = [];
  const paintNotCarried: string[] = [];
  for (const p of next.parts) {
    const q = before.get(p.id);
    if (!q || !prev) continue;
    const c: PartChange = { part: p.id, dims: [] };
    if (q.type !== p.type) c.type = { from: q.type, to: p.type };
    else c.dims = dimChanges(q, p);
    const moved = Math.hypot(p.position[0] - q.position[0], p.position[1] - q.position[1], p.position[2] - q.position[2]);
    if (moved > DIFF_MOVE_IN) c.movedIn = roundCoord(moved, 3);
    const ra = q.rotationDeg ?? [0, 0, 0];
    const rb = p.rotationDeg ?? [0, 0, 0];
    const turned = Math.max(...ra.map((v, i) => Math.abs(((((rb[i] - v) % 360) + 540) % 360) - 180)));
    if (turned > DIFF_TURN_DEG) c.turnedDeg = roundCoord(turned, 1);
    const ca = hexOf(prev, q.color);
    const cb = hexOf(next, p.color);
    if (ca && cb && ca.toLowerCase() !== cb.toLowerCase()) c.color = { from: ca, to: cb };
    if (c.type || c.dims.length > 0 || c.movedIn !== undefined || c.turnedDeg !== undefined || c.color) changed.push(c);
    if (q.paint) (sameShapeWithin(q, p, PAINT_TOLERANCE) ? paintCarried : paintNotCarried).push(p.id);
  }
  const fa = new Set((prev?.features ?? []).map((f: Feature) => f.id));
  const fb = new Set((next.features ?? []).map((f: Feature) => f.id));
  const seed = new Set(o.seedFeatureIds ?? []);
  const missing = [...fa].filter((id) => !fb.has(id));
  const features = { removed: missing.filter((id) => seed.has(id)), kept: missing.filter((id) => !seed.has(id)), added: [...fb].filter((id) => !fa.has(id)) };
  const ha = new Set((prev?.palette ?? []).map((c) => c.hex.toLowerCase()));
  const hb = new Set(next.palette.map((c) => c.hex.toLowerCase()));
  const palette = {
    added: next.palette.filter((c) => !ha.has(c.hex.toLowerCase())).map((c) => c.hex),
    removed: (prev?.palette ?? []).filter((c) => !hb.has(c.hex.toLowerCase())).map((c) => c.hex),
  };

  const summary: string[] = [];
  if (added.length > 0) summary.push(`parts added: ${list(added)}`);
  if (removed.length > 0) summary.push(`parts removed: ${list(removed)}`);
  const reshaped = changed.filter((c) => c.type || c.dims.length > 0).map((c) => c.part);
  if (reshaped.length > 0) summary.push(`shape changed: ${list(reshaped)}`);
  const moved = changed.filter((c) => c.movedIn !== undefined || c.turnedDeg !== undefined).map((c) => c.part);
  if (moved.length > 0) summary.push(`moved: ${list(moved)}`);
  const recolored = changed.filter((c) => c.color).map((c) => c.part);
  if (recolored.length > 0) summary.push(`colors changed: ${list(recolored)}`);
  if (paintNotCarried.length > 0) summary.push(`photo colors not carried: ${list(paintNotCarried)}`);
  if (features.removed.length > 0) summary.push(`face details removed: ${list(features.removed)}`);
  if (features.kept.length > 0) summary.push(`face details you added are kept: ${list(features.kept)}`);
  if (features.added.length > 0) summary.push(`face details added: ${list(features.added)}`);
  const same = summary.length === 0 && palette.added.length === 0 && palette.removed.length === 0;
  return { added, removed, changed, paintCarried, paintNotCarried, features, palette, same, summary };
}
