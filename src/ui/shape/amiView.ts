// Track T6.3 — reading an `AmiResult` for the editor (DESIGN.md §2.10.10, §4.3): rounds drawn as rings on the model
// (colored per stitch), the pattern ghost, the toy ghost size, badges per part and the ring ↔ line link.
//
// T4 fills `AmiResult` in parallel (T4.3/T4.4); where the frozen types leave a layout open, this module reads it as
// follows (recorded in docs/tracks/t6.md, "Requests for integration"):
//   - `RoundsResult.rings[k]` is round k + 1 in MODEL space (`center`, unit `normal` along the piece axis, `radius`);
//     `polyline` (Path B) = x, y, z triples in model space, the ring as worked;
//   - `stitchLabels[k][j]` = palette index (`model.palette`) of stitch j of round k + 1, stitch 0 next to the seam,
//     in working order (RH: clockwise seen from the end the piece grows toward, §2.11.2), 255 = unknown;
//   - `ghosts[partId]` = the ghost's rings, 7 floats each: center x, y, z, unit normal x, y, z, radius (model space);
//   - `LineRef.line` = the index into `Piece.lines`; ring k of a part belongs to the line of the piece holding that
//     part whose round range `n … nEnd` contains k + 1.
// A malformed entry (wrong length, non-finite numbers) is skipped, never drawn as NaN (§2.10.10).
import { boundsSize, unionBounds, worldBounds, type Bounds } from '../../core/model/transforms';
import type { AmiResult, RingGeom, RoundsResult } from '../../types/ami';
import type { ColoredMesh } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Vec3 } from '../../types/model';
import type { PatternDoc } from '../../types/pattern';
import type { Hand } from '../../types/units';
import type { LineRef } from '../../types/ui';

export const GHOST_STRIDE = 7;
const UNKNOWN = 255;
const FALLBACK_HEX = '#9a8f86';

const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));

function normalize(v: Vec3): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A ring as the viewport draws it: closed polyline points (model space) and one color per point. */
export interface RingView {
  partId: string;
  /** 0-based round index (round k + 1). */
  k: number;
  stitches: number;
  points: Vec3[];
  colors: string[];
}

/** The two in-plane axes of a ring: `u` toward the seam (center back by default), `v = n × u`. */
function ringAxes(normal: Vec3, seamDir?: Vec3): { u: Vec3; v: Vec3 } {
  const tryU = (s: Vec3) => {
    const d = s[0] * normal[0] + s[1] * normal[1] + s[2] * normal[2];
    return normalize([s[0] - d * normal[0], s[1] - d * normal[1], s[2] - d * normal[2]]);
  };
  const u = (seamDir && tryU(seamDir)) ?? tryU([0, 0, -1]) ?? tryU([1, 0, 0]) ?? [1, 0, 0];
  return { u, v: cross(normal, u) };
}

/** Points of a ring (closed: the first point repeated last), `segments` per turn, starting at the seam. */
export function ringPoints(ring: RingGeom, segments: number, seamDir?: Vec3): Vec3[] | null {
  const c = ring.center;
  const n = ring.normal && normalize(ring.normal);
  if (!c || !n || !finite(c[0], c[1], c[2], ring.radius) || !(ring.radius >= 0)) return null;
  if (ring.polyline && ring.polyline.length >= 6 && ring.polyline.length % 3 === 0) {
    const pts: Vec3[] = [];
    for (let i = 0; i < ring.polyline.length; i += 3) {
      const p: Vec3 = [ring.polyline[i], ring.polyline[i + 1], ring.polyline[i + 2]];
      if (!finite(...p)) return null;
      pts.push(p);
    }
    pts.push(pts[0]);
    return pts;
  }
  const { u, v } = ringAxes(n, seamDir);
  const out: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    const ca = Math.cos(a) * ring.radius;
    const sa = Math.sin(a) * ring.radius;
    out.push([c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa]);
  }
  out.push(out[0]);
  return out;
}

/**
 * The color of each ring point from the round's stitch labels. Point i of `count` lies at the fraction i / count of
 * the turn from the seam, counter-clockwise about the normal; a right-hander works clockwise about it (§2.11.2:
 * α_j = α_seam − 2π(j + ½)/n), a left-hander counter-clockwise.
 */
export function ringColors(labels: ArrayLike<number> | undefined, count: number, palette: readonly { hex: string }[], hand: Hand, fallback: string): string[] {
  const n = labels?.length ?? 0;
  const out: string[] = [];
  for (let i = 0; i <= count; i++) {
    if (!labels || n === 0) {
      out.push(fallback);
      continue;
    }
    const f = (i % count) / count;
    const along = hand === 'left' ? f : (1 - f) % 1;
    const j = Math.min(n - 1, Math.floor(along * n));
    const label = labels[j];
    out.push(label !== UNKNOWN && label < palette.length ? palette[label].hex : fallback);
  }
  return out;
}

function mirroredRounds(r: RoundsResult): RoundsResult {
  const mx = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
  return {
    ...r,
    rings: r.rings.map((g) => {
      const out: RingGeom = { center: mx(g.center), normal: mx(g.normal), radius: g.radius };
      if (g.polyline) {
        const pl = new Float32Array(g.polyline.length);
        for (let i = 0; i < pl.length; i += 3) {
          pl[i] = -g.polyline[i];
          pl[i + 1] = g.polyline[i + 1];
          pl[i + 2] = g.polyline[i + 2];
        }
        out.polyline = pl;
      }
      return out;
    }),
  };
}

/**
 * The rounds of a part: its own, or — for the twin of a mirrored pair that the pattern makes from one piece — its
 * twin's mirrored across x = 0. `mirrored` says which.
 */
export function roundsOf(result: AmiResult, model: CrochetModelV1, partId: string): { rounds: RoundsResult; mirrored: boolean } | null {
  const own = Object.hasOwn(result.rounds, partId) ? result.rounds[partId] : undefined;
  if (own) return { rounds: own, mirrored: false };
  const part = model.parts.find((p) => p.id === partId);
  const twin = part?.mirrorOf ?? model.parts.find((p) => p.mirrorOf === partId)?.id;
  const other = twin && Object.hasOwn(result.rounds, twin) ? result.rounds[twin] : undefined;
  return other ? { rounds: mirroredRounds(other), mirrored: true } : null;
}

/** Every ring of a part as the viewport draws it (malformed rings are skipped). */
export function ringsOf(result: AmiResult, model: CrochetModelV1, partId: string, hand: Hand): RingView[] {
  const got = roundsOf(result, model, partId);
  if (!got) return [];
  const frame = Object.hasOwn(result.frames, partId) ? result.frames[partId] : undefined;
  const seam = frame?.seamDir ? (got.mirrored ? ([-frame.seamDir[0], frame.seamDir[1], frame.seamDir[2]] as Vec3) : frame.seamDir) : undefined;
  const part = model.parts.find((p) => p.id === partId);
  const base = model.palette.find((c) => c.id === part?.color)?.hex ?? FALLBACK_HEX;
  const out: RingView[] = [];
  got.rounds.rings.forEach((ring, k) => {
    const stitches = got.rounds.counts[k] ?? got.rounds.stitchLabels[k]?.length ?? 0;
    const segments = Math.min(256, Math.max(24, stitches * 2));
    const points = ringPoints(ring, segments, seam);
    if (!points) return;
    // A Path B polyline is already in working order; a drawn circle runs counter-clockwise (mirrored: the other way).
    const order: Hand = ring.polyline ? 'left' : got.mirrored ? (hand === 'left' ? 'right' : 'left') : hand;
    const colors = ringColors(got.rounds.stitchLabels[k], points.length - 1, model.palette, order, base);
    out.push({ partId, k, stitches, points, colors });
  });
  return out;
}

/** A ghost's rings (7 floats each); [] for a malformed buffer. Non-finite rings are dropped. */
export function ghostRings(ghost: ArrayLike<number> | undefined): RingGeom[] {
  if (!ghost || ghost.length === 0 || ghost.length % GHOST_STRIDE !== 0) return [];
  const out: RingGeom[] = [];
  for (let i = 0; i < ghost.length; i += GHOST_STRIDE) {
    const center: Vec3 = [ghost[i], ghost[i + 1], ghost[i + 2]];
    const normal = normalize([ghost[i + 3], ghost[i + 4], ghost[i + 5]]);
    const radius = ghost[i + 6];
    if (!normal || !finite(...center, radius) || radius < 0) continue;
    out.push({ center, normal, radius });
  }
  return out;
}

/** The axis-aligned box of a set of circles (exact: a circle's extent along axis i is r·√(1 − n_i²)). */
export function ringsBounds(rings: readonly RingGeom[]): Bounds | null {
  let b: Bounds | null = null;
  for (const g of rings) {
    const e: Vec3 = [0, 1, 2].map((i) => g.radius * Math.sqrt(Math.max(0, 1 - g.normal[i] * g.normal[i]))) as Vec3;
    const box: Bounds = { min: [g.center[0] - e[0], g.center[1] - e[1], g.center[2] - e[2]], max: [g.center[0] + e[0], g.center[1] + e[1], g.center[2] + e[2]] };
    b = b ? unionBounds(b, box) : box;
  }
  return b;
}

/**
 * The toy ghost size (§2.10.10): the box of every piece's ghost rings in model space plus the geometry of the parts
 * that are not crocheted pieces (eyes, embroidery, …). A piece without a usable ghost counts with its geometry.
 * Null when no piece has a ghost (nothing to say beyond the model itself).
 */
export function toyGhostBounds(result: AmiResult, model: CrochetModelV1, meshes?: Record<string, ColoredMesh>): Bounds | null {
  let any = false;
  let b: Bounds | null = null;
  const add = (x: Bounds | null) => {
    if (x) b = b ? unionBounds(b, x) : x;
  };
  for (const p of model.parts) {
    const make = Object.hasOwn(result.plan, p.id) ? result.plan[p.id] : undefined;
    if (make === 'skip') continue;
    const rings = make === 'piece' ? ghostRings(Object.hasOwn(result.ghosts, p.id) ? result.ghosts[p.id] : undefined) : [];
    const box = rings.length > 0 ? ringsBounds(rings) : null;
    if (box) {
      any = true;
      add(box);
    } else add(worldBounds(p, p.type === 'mesh' ? meshes?.[p.dims.meshRef] : undefined));
  }
  return any ? b : null;
}

/** The toy ghost height, or null. */
export function toyGhostHeight(result: AmiResult, model: CrochetModelV1, meshes?: Record<string, ColoredMesh>): number | null {
  const b = toyGhostBounds(result, model, meshes);
  if (!b) return null;
  const h = boundsSize(b)[1];
  return Number.isFinite(h) && h > 0 ? h : null;
}

/** ✓ / ⚠ n / ✕ n per part (§4.3): the result's issues that name the part, or a piece made from it. */
export interface PartStatus {
  errors: number;
  warnings: number;
  /** The issues themselves (errors first). */
  issues: Issue[];
}

export function partStatuses(result: AmiResult): Map<string, PartStatus> {
  const pieces = new Map(result.pattern.pieces.map((p) => [p.id, p.partIds]));
  const out = new Map<string, PartStatus>();
  const issues = [...result.issues, ...result.pattern.issues.filter((i) => !result.issues.includes(i))];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue.code}|${issue.message}|${issue.where?.part ?? ''}|${issue.where?.piece ?? ''}|${issue.where?.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (issue.severity === 'info') continue;
    const ids = new Set<string>();
    if (issue.where?.part) ids.add(issue.where.part);
    if (issue.where?.piece) for (const id of pieces.get(issue.where.piece) ?? []) ids.add(id);
    for (const id of ids) {
      const s = out.get(id) ?? { errors: 0, warnings: 0, issues: [] };
      if (issue.severity === 'error') s.errors++;
      else s.warnings++;
      s.issues.push(issue);
      out.set(id, s);
    }
  }
  for (const s of out.values()) s.issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return out;
}

/** The pattern line of ring k (0-based) of a part, or null. */
export function lineRefForRing(doc: PatternDoc, partId: string, k: number): LineRef | null {
  for (const piece of doc.pieces) {
    if (!piece.partIds.includes(partId)) continue;
    const i = piece.lines.findIndex((l) => (l.kind === 'rnd' || l.kind === 'row') && l.n <= k + 1 && k + 1 <= (l.nEnd ?? l.n));
    if (i >= 0) return { piece: piece.id, line: i };
  }
  return null;
}

/** The parts and 0-based rounds a pattern line covers (what to highlight on the model), or null. */
export function ringsForLineRef(doc: PatternDoc, ref: LineRef | null): { partIds: string[]; from: number; to: number } | null {
  if (!ref?.piece) return null;
  const piece = doc.pieces.find((p) => p.id === ref.piece);
  const line = piece?.lines[ref.line];
  if (!piece || !line || (line.kind !== 'rnd' && line.kind !== 'row')) return null;
  return { partIds: piece.partIds, from: line.n - 1, to: (line.nEnd ?? line.n) - 1 };
}
