// Track T5 — sculpt brushes on a part's signed-distance volume, with sparse undo (DESIGN.md §2.9.8, §4.2, §4.4).
//
// A stroke is a list of dab centers (the volume's frame = the mesh part's local frame, inches). Each dab acts inside
// a sphere of radius R with falloff φ = smoothstep(1, 0, dist/R) and strength k ∈ [0, 1]:
//   inflate  f += k·φ·voxel
//   deflate  f −= k·φ·voxel
//   smooth   f ← lerp(f, box3(f), k·φ)              (box3 = 3×3×3 mean of the field before this dab)
//   flatten  f ← lerp(f, min(f, −dist_P), k·φ)      (P: see `brushPlane`)
// With `mirrorX` every dab has a twin mirrored across x = 0 of the volume's frame (or a plane the caller gives); a
// sample inside both spheres is changed once, by the dab whose falloff is larger there, so a dab and its own twin
// never add up across the plane.
//
// Undo is a sparse diff per stroke: the index and the value before and after of every sample the stroke changed
// (first touch wins for "before"), so reverting writes back the exact float32 values.
import { smoothstep } from '../kernel/vec';
import type { ColoredMesh, Vec3 } from '../../types/geometry';
import { coloredRemesh, FINAL_TAUBIN_PAIRS } from './remesh';
import { checkVolume, MeshToolError, type FieldVolume } from './volume';

export type SculptTool = 'inflate' | 'deflate' | 'smooth' | 'flatten';

/** The stroke of `MeshApi.sculpt` (src/types/workers.ts). */
export interface SculptStroke {
  tool: SculptTool;
  points: Vec3[];
  radius: number;
  strength: number;
  mirrorX: boolean;
}

/** The samples a stroke changed: ascending indices, values before and after (float32, exact). */
export interface VoxelDiff {
  indices: Uint32Array<ArrayBuffer>;
  before: Float32Array<ArrayBuffer>;
  after: Float32Array<ArrayBuffer>;
}

/** Samples within 1.5 voxels of the surface are "under the brush" for the flatten plane. */
const SURFACE_BAND_VOXELS = 1.5;

class Journal {
  private readonly mark: Uint8Array;
  private readonly idx: number[] = [];
  private readonly old: number[] = [];
  constructor(total: number) {
    this.mark = new Uint8Array(total);
  }
  touch(field: Float32Array, k: number): void {
    if (this.mark[k] === 0) {
      this.mark[k] = 1;
      this.idx.push(k);
      this.old.push(field[k]);
    }
  }
  finish(field: Float32Array): VoxelDiff {
    const order = this.idx.map((_, i) => i).sort((a, b) => this.idx[a] - this.idx[b]);
    const indices = new Uint32Array(order.length);
    const before = new Float32Array(order.length);
    const after = new Float32Array(order.length);
    let n = 0;
    for (const i of order) {
      const k = this.idx[i];
      // Keep only samples whose value really changed (bitwise: −0 and +0 differ for the mesher's side test).
      if (Object.is(field[k], Math.fround(this.old[i]))) continue;
      indices[n] = k;
      before[n] = this.old[i];
      after[n] = field[k];
      n++;
    }
    return { indices: indices.slice(0, n), before: before.slice(0, n), after: after.slice(0, n) };
  }
}

function checkStroke(s: SculptStroke): void {
  if (s.tool !== 'inflate' && s.tool !== 'deflate' && s.tool !== 'smooth' && s.tool !== 'flatten') {
    throw new RangeError(`unknown sculpt tool ${String(s.tool)}`);
  }
  if (!(s.radius > 0) || !Number.isFinite(s.radius)) throw new RangeError(`brush radius must be a positive number, got ${s.radius}`);
  if (!Number.isFinite(s.strength) || s.strength < 0) throw new RangeError(`brush strength must be a number >= 0, got ${s.strength}`);
  if (!Array.isArray(s.points)) throw new RangeError('stroke points must be an array');
  for (const p of s.points) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => Number.isFinite(c))) throw new RangeError(`bad stroke point ${String(p)}`);
  }
}

/** Index range of the samples within `r` of coordinate `c` on axis `a`, clipped to the lattice. */
function axisRange(v: FieldVolume, a: 0 | 1 | 2, c: number, r: number): [number, number] {
  const lo = Math.max(0, Math.ceil((c - r - v.origin[a]) / v.voxel));
  const hi = Math.min(v.dims[a] - 1, Math.floor((c + r - v.origin[a]) / v.voxel));
  return [lo, hi];
}

/** Outward unit normal (−∇f / |∇f|) at sample (x, y, z) by central differences (one-sided at the border); null when flat. */
function sampleNormal(v: FieldVolume, x: number, y: number, z: number): Vec3 | null {
  const [nx, ny, nz] = v.dims;
  const f = v.field;
  const at = (i: number, j: number, k: number): number => f[i + nx * (j + ny * k)];
  const d = (lo: number, hi: number, val: (t: number) => number, t: number): number => {
    const a = Math.max(lo, t - 1);
    const b = Math.min(hi, t + 1);
    return b > a ? (val(b) - val(a)) / (b - a) : 0;
  };
  const gx = d(0, nx - 1, (t) => at(t, y, z), x);
  const gy = d(0, ny - 1, (t) => at(x, t, z), y);
  const gz = d(0, nz - 1, (t) => at(x, y, t), z);
  const len = Math.hypot(gx, gy, gz);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return [-gx / len, -gy / len, -gz / len];
}

/**
 * The flatten plane of a dab: through the φ-weighted mean SURFACE point under the brush, with the φ-weighted mean
 * outward normal there (samples within 1.5 voxels of the surface, each moved onto it along its normal). On a flat
 * surface the mean point is the brush center itself; on a curved one it lies below the cap, so the dab cuts the cap
 * down (see docs/tracks/t5.md, deviation 2). Null when no surface is under the brush.
 */
export function brushPlane(v: FieldVolume, center: Vec3, radius: number): { point: Vec3; normal: Vec3 } | null {
  const [x0, x1] = axisRange(v, 0, center[0], radius);
  const [y0, y1] = axisRange(v, 1, center[1], radius);
  const [z0, z1] = axisRange(v, 2, center[2], radius);
  const band = SURFACE_BAND_VOXELS * v.voxel;
  let w = 0;
  const p: Vec3 = [0, 0, 0];
  const n: Vec3 = [0, 0, 0];
  for (let z = z0; z <= z1; z++) {
    const pz = v.origin[2] + z * v.voxel;
    for (let y = y0; y <= y1; y++) {
      const py = v.origin[1] + y * v.voxel;
      for (let x = x0; x <= x1; x++) {
        const px = v.origin[0] + x * v.voxel;
        const dist = Math.hypot(px - center[0], py - center[1], pz - center[2]);
        if (dist >= radius) continue;
        const f = v.field[x + v.dims[0] * (y + v.dims[1] * z)];
        if (!(Math.abs(f) < band)) continue;
        const nn = sampleNormal(v, x, y, z);
        if (!nn) continue;
        const phi = smoothstep(1, 0, dist / radius);
        if (phi <= 0) continue;
        w += phi;
        p[0] += phi * (px + f * nn[0]);
        p[1] += phi * (py + f * nn[1]);
        p[2] += phi * (pz + f * nn[2]);
        n[0] += phi * nn[0];
        n[1] += phi * nn[1];
        n[2] += phi * nn[2];
      }
    }
  }
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (!(w > 0) || !(nl > 0)) return null;
  return { point: [p[0] / w, p[1] / w, p[2] / w], normal: [n[0] / nl, n[1] / nl, n[2] / nl] };
}

interface Dab {
  center: Vec3;
  plane: { point: Vec3; normal: Vec3 } | null;
}

function applyDab(v: FieldVolume, tool: SculptTool, dabs: Dab[], radius: number, k: number, journal: Journal): void {
  const [nx, ny, nz] = v.dims;
  const sxy = nx * ny;
  const f = v.field;
  // Region: union of the dab boxes, plus one sample for the box filter.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const d of dabs) {
    const rx = axisRange(v, 0, d.center[0], radius);
    const ry = axisRange(v, 1, d.center[1], radius);
    const rz = axisRange(v, 2, d.center[2], radius);
    x0 = Math.min(x0, rx[0]);
    x1 = Math.max(x1, rx[1]);
    y0 = Math.min(y0, ry[0]);
    y1 = Math.max(y1, ry[1]);
    z0 = Math.min(z0, rz[0]);
    z1 = Math.max(z1, rz[1]);
  }
  if (x0 > x1 || y0 > y1 || z0 > z1) return;

  // Snapshot of the region grown by one sample (the box filter reads values from before this dab).
  let snap: Float32Array | null = null;
  let sx0 = 0;
  let sy0 = 0;
  let sz0 = 0;
  let sw = 0;
  let sh = 0;
  if (tool === 'smooth') {
    sx0 = Math.max(0, x0 - 1);
    sy0 = Math.max(0, y0 - 1);
    sz0 = Math.max(0, z0 - 1);
    const sx1 = Math.min(nx - 1, x1 + 1);
    const sy1 = Math.min(ny - 1, y1 + 1);
    const sz1 = Math.min(nz - 1, z1 + 1);
    sw = sx1 - sx0 + 1;
    sh = sy1 - sy0 + 1;
    const sd = sz1 - sz0 + 1;
    snap = new Float32Array(sw * sh * sd);
    for (let z = 0; z < sd; z++) for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) snap[x + sw * (y + sh * z)] = f[sx0 + x + nx * (sy0 + y + ny * (sz0 + z))];
  }
  const sdep = snap ? snap.length / (sw * sh) : 0;

  for (let z = z0; z <= z1; z++) {
    const pz = v.origin[2] + z * v.voxel;
    for (let y = y0; y <= y1; y++) {
      const py = v.origin[1] + y * v.voxel;
      for (let x = x0; x <= x1; x++) {
        const px = v.origin[0] + x * v.voxel;
        let phi = 0;
        let which = -1;
        for (let i = 0; i < dabs.length; i++) {
          const c = dabs[i].center;
          const dist = Math.hypot(px - c[0], py - c[1], pz - c[2]);
          if (dist >= radius) continue;
          const ph = smoothstep(1, 0, dist / radius);
          if (ph > phi) {
            phi = ph;
            which = i;
          }
        }
        if (which < 0 || phi <= 0) continue;
        const kk = k * phi;
        const idx = x + nx * y + sxy * z;
        const cur = f[idx];
        let next = cur;
        if (tool === 'inflate') next = cur + kk * v.voxel;
        else if (tool === 'deflate') next = cur - kk * v.voxel;
        else if (tool === 'smooth' && snap) {
          let sum = 0;
          let cnt = 0;
          const lx = x - sx0;
          const ly = y - sy0;
          const lz = z - sz0;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = lz + dz;
            if (zz < 0 || zz >= sdep) continue;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = ly + dy;
              if (yy < 0 || yy >= sh) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = lx + dx;
                if (xx < 0 || xx >= sw) continue;
                sum += snap[xx + sw * (yy + sh * zz)];
                cnt++;
              }
            }
          }
          const box = sum / cnt;
          const own = snap[lx + sw * (ly + sh * lz)];
          next = own + (box - own) * Math.min(1, kk);
        } else if (tool === 'flatten') {
          const plane = dabs[which].plane;
          if (!plane) continue;
          const n = plane.normal;
          const distP = n[0] * (px - plane.point[0]) + n[1] * (py - plane.point[1]) + n[2] * (pz - plane.point[2]);
          const target = Math.min(cur, -distP);
          next = cur + (target - cur) * Math.min(1, kk);
        }
        if (next === cur || !Number.isFinite(next)) continue;
        journal.touch(f, idx);
        f[idx] = next;
      }
    }
  }
}

/** A plane in the volume's frame; the X-symmetry plane of a stroke (default x = 0). */
export interface MirrorPlane {
  point: Vec3;
  normal: Vec3;
}

function reflect(c: Vec3, plane: MirrorPlane | undefined): Vec3 | null {
  if (!plane) return c[0] === 0 ? null : [-c[0], c[1], c[2]];
  const n = plane.normal;
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0) || !Number.isFinite(len) || !plane.point.every((x) => Number.isFinite(x))) throw new RangeError('bad mirror plane');
  const d = ((c[0] - plane.point[0]) * n[0] + (c[1] - plane.point[1]) * n[1] + (c[2] - plane.point[2]) * n[2]) / len;
  if (d === 0) return null;
  return [c[0] - (2 * d * n[0]) / len, c[1] - (2 * d * n[1]) / len, c[2] - (2 * d * n[2]) / len];
}

/**
 * Applies a stroke to the volume IN PLACE and returns its sparse diff. Points outside the lattice only reach the
 * samples within the radius; a stroke that changes nothing returns an empty diff. `mirrorPlane` (volume frame)
 * replaces the default x = 0 for `mirrorX` — for a mesh part that is not centered on the model's symmetry plane the
 * editor passes the model's x = 0 plane mapped into the part's frame.
 */
export function applyStroke(v: FieldVolume, stroke: SculptStroke, o: { mirrorPlane?: MirrorPlane } = {}): VoxelDiff {
  checkVolume(v);
  checkStroke(stroke);
  const k = Math.min(1, stroke.strength);
  const journal = new Journal(v.field.length);
  for (const c of stroke.points) {
    const centers: Vec3[] = [[c[0], c[1], c[2]]];
    if (stroke.mirrorX) {
      const twin = reflect(c, o.mirrorPlane);
      if (twin) centers.push(twin);
    }
    const dabs: Dab[] = centers.map((center) => ({ center, plane: stroke.tool === 'flatten' ? brushPlane(v, center, stroke.radius) : null }));
    applyDab(v, stroke.tool, dabs, stroke.radius, k, journal);
  }
  return journal.finish(v.field);
}

/**
 * One diff for two consecutive strokes (`older` then `newer`): "before" from the older one where it has the sample,
 * "after" from the newer one where it has it.
 */
export function mergeDiffs(older: VoxelDiff, newer: VoxelDiff): VoxelDiff {
  const n = older.indices.length + newer.indices.length;
  const indices = new Uint32Array(n);
  const before = new Float32Array(n);
  const after = new Float32Array(n);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < older.indices.length || j < newer.indices.length) {
    const a = i < older.indices.length ? older.indices[i] : Infinity;
    const b = j < newer.indices.length ? newer.indices[j] : Infinity;
    if (a < b) {
      indices[k] = a;
      before[k] = older.before[i];
      after[k] = older.after[i];
      i++;
    } else if (b < a) {
      indices[k] = b;
      before[k] = newer.before[j];
      after[k] = newer.after[j];
      j++;
    } else {
      indices[k] = a;
      before[k] = older.before[i];
      after[k] = newer.after[j];
      i++;
      j++;
    }
    k++;
  }
  return { indices: indices.slice(0, k), before: before.slice(0, k), after: after.slice(0, k) };
}

function checkDiff(v: FieldVolume, d: VoxelDiff): void {
  if (d.indices.length !== d.before.length || d.indices.length !== d.after.length) throw new RangeError('diff arrays differ in length');
  for (let i = 0; i < d.indices.length; i++) if (d.indices[i] >= v.field.length) throw new RangeError(`diff index ${d.indices[i]} is outside the volume`);
}

/** Writes the "before" values back (undo). Exact: the field is bit-identical to the one before the stroke. */
export function revertDiff(v: FieldVolume, d: VoxelDiff): void {
  checkDiff(v, d);
  for (let i = 0; i < d.indices.length; i++) v.field[d.indices[i]] = d.before[i];
}

/** Writes the "after" values again (redo). */
export function reapplyDiff(v: FieldVolume, d: VoxelDiff): void {
  checkDiff(v, d);
  for (let i = 0; i < d.indices.length; i++) v.field[d.indices[i]] = d.after[i];
}

/** Bytes a diff holds (for the 200-step history budget). */
export function diffBytes(d: VoxelDiff): number {
  return d.indices.byteLength + d.before.byteLength + d.after.byteLength;
}

interface UndoRecord {
  id: string;
  diff: VoxelDiff;
  /** The mesh before the stroke when it was the session's starting mesh (not a remesh of the volume). */
  baseMesh: ColoredMesh | null;
  /** Labels / partId / Taubin pairs of the mesh before the stroke (or, on the redo stack, after it). */
  labels: Uint8Array<ArrayBuffer>;
  partId?: Uint8Array<ArrayBuffer>;
  pairs: number;
}

function copyMesh(m: ColoredMesh): ColoredMesh {
  const out: ColoredMesh = { positions: m.positions.slice(), indices: m.indices.slice(), labels: m.labels.slice() };
  if (m.partId) out.partId = m.partId.slice();
  return out;
}

export interface SessionStrokeOptions {
  /** Taubin pairs of the new mesh (default 10 = the end of a stroke; 3 while a drag is live). */
  pairs?: number;
  /**
   * The undo id of the stroke this one continues (the live updates of one drag): its diff is folded into that
   * record, so one drag stays one history step (§4.4). Must be the latest stroke.
   */
  continues?: string;
  /** X-symmetry plane in the volume's frame (default x = 0). */
  mirrorPlane?: MirrorPlane;
}

/**
 * One sculptable part: its working volume, its current colored mesh, and a linear undo stack of sparse diffs.
 * The worker keeps one session per `volumeId` (T5.3); the session itself is pure and synchronous. Every mesh it
 * returns is a fresh copy, so the caller may transfer its buffers.
 */
export class SculptSession {
  readonly id: string;
  readonly volume: FieldVolume;
  private current: ColoredMesh;
  private currentPairs = FINAL_TAUBIN_PAIRS;
  private readonly stack: UndoRecord[] = [];
  private readonly redoStack: UndoRecord[] = [];
  private counter = 0;
  /** Whether `current` is still the mesh the session started from. */
  private atBase = true;

  /**
   * `volume` is owned by the session from now on (sculpted in place). `mesh` is the part's current mesh in the
   * volume's frame (the labels to carry; copied); without it the volume is remeshed and every label is 255.
   */
  constructor(id: string, volume: FieldVolume, mesh?: ColoredMesh) {
    checkVolume(volume);
    this.id = id;
    this.volume = volume;
    this.current = mesh ? copyMesh(mesh) : coloredRemesh(volume, undefined);
    this.atBase = true;
  }

  /** A copy of the current mesh. */
  get mesh(): ColoredMesh {
    return copyMesh(this.current);
  }

  /** Undo ids, oldest first. */
  get undoIds(): string[] {
    return this.stack.map((r) => r.id);
  }

  /** Applies a stroke, remeshes and carries the labels; returns the new mesh, its undo id and the stroke's diff. */
  stroke(stroke: SculptStroke, o: SessionStrokeOptions = {}): { mesh: ColoredMesh; undoId: string; diff: VoxelDiff } {
    const pairs = o.pairs ?? FINAL_TAUBIN_PAIRS;
    let top: UndoRecord | undefined;
    if (o.continues !== undefined) {
      top = this.stack[this.stack.length - 1];
      if (!top || top.id !== o.continues) throw new MeshToolError('undo-order', `${o.continues} is not the latest stroke on ${this.id}`);
    }
    const before = this.current;
    const diff = applyStroke(this.volume, stroke, { mirrorPlane: o.mirrorPlane });
    const mesh = coloredRemesh(this.volume, before, { pairs });
    let id: string;
    if (top) {
      top.diff = mergeDiffs(top.diff, diff);
      id = top.id;
    } else {
      id = `${this.id}:${++this.counter}`;
      this.stack.push({
        id,
        diff,
        baseMesh: this.atBase ? before : null,
        labels: before.labels as Uint8Array<ArrayBuffer>,
        partId: before.partId as Uint8Array<ArrayBuffer> | undefined,
        pairs: this.currentPairs,
      });
    }
    this.redoStack.length = 0;
    this.current = mesh;
    this.currentPairs = pairs;
    this.atBase = false;
    return { mesh: copyMesh(mesh), undoId: id, diff: top ? top.diff : diff };
  }

  /** Remeshes the current volume with `pairs` Taubin pairs (e.g. 10 at the end of a drag) without a history step. */
  remesh(pairs = FINAL_TAUBIN_PAIRS): ColoredMesh {
    if (this.atBase) return copyMesh(this.current);
    this.current = coloredRemesh(this.volume, this.current, { pairs });
    this.currentPairs = pairs;
    return copyMesh(this.current);
  }

  private rebuild(labels: Uint8Array<ArrayBuffer>, partId: Uint8Array<ArrayBuffer> | undefined, pairs: number): ColoredMesh {
    const m = coloredRemesh(this.volume, undefined, { pairs });
    if (m.labels.length === labels.length) m.labels = labels;
    if (partId && partId.length === m.labels.length) m.partId = partId;
    return m;
  }

  /**
   * Undoes the LAST stroke, which must be `undoId` (the editor's history is linear). The volume is restored bit
   * for bit; the mesh is the one from before the stroke (a copy of the starting mesh, or the identical remesh of the
   * restored volume with the labels and Taubin pairs it had).
   */
  undo(undoId: string): ColoredMesh {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new MeshToolError('unknown-undo', `nothing to undo on ${this.id}`);
    if (top.id !== undoId) {
      if (this.stack.some((r) => r.id === undoId)) throw new MeshToolError('undo-order', `undo ${top.id} before ${undoId}`);
      throw new MeshToolError('unknown-undo', `unknown undo id ${undoId}`);
    }
    this.stack.pop();
    revertDiff(this.volume, top.diff);
    const after = this.current;
    const afterPairs = this.currentPairs;
    if (top.baseMesh) {
      this.current = top.baseMesh;
      this.atBase = true;
    } else {
      this.current = this.rebuild(top.labels, top.partId, top.pairs);
      this.atBase = false;
    }
    this.currentPairs = top.pairs;
    this.redoStack.push({ ...top, labels: after.labels as Uint8Array<ArrayBuffer>, partId: after.partId as Uint8Array<ArrayBuffer> | undefined, pairs: afterPairs });
    return copyMesh(this.current);
  }

  /** Re-applies the most recently undone stroke (not in `MeshApi`; see docs/tracks/t5.md, requests). */
  redo(): { mesh: ColoredMesh; undoId: string } | null {
    const r = this.redoStack.pop();
    if (!r) return null;
    const before = this.current;
    reapplyDiff(this.volume, r.diff);
    const m = this.rebuild(r.labels, r.partId, r.pairs);
    this.stack.push({
      id: r.id,
      diff: r.diff,
      baseMesh: this.atBase ? before : null,
      labels: before.labels as Uint8Array<ArrayBuffer>,
      partId: before.partId as Uint8Array<ArrayBuffer> | undefined,
      pairs: this.currentPairs,
    });
    this.current = m;
    this.currentPairs = r.pairs;
    this.atBase = false;
    return { mesh: copyMesh(m), undoId: r.id };
  }

  /** Bytes held by the undo and redo stacks' diffs. */
  historyBytes(): number {
    let n = 0;
    for (const r of this.stack) n += diffBytes(r.diff) + r.labels.byteLength;
    for (const r of this.redoStack) n += diffBytes(r.diff) + r.labels.byteLength;
    return n;
  }
}
