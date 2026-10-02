// Track T4 — piece frames (DESIGN.md §2.10.2): the crochet axis â, the start pole, the seam (center back), and the
// map from a piece's profile (arc position s, azimuth α) to model space that trimming (§2.10.3), the plan's
// start-cap test (§2.10.1 rule 3), the spiral lean (§2.11.2) and assembly (§2.12) share.
//
// Conventions. `d` is the world direction in which the profile runs (from the start pole into the piece): +â for
// a piece started at its bottom (−â) pole, −â for one started at its top pole. Azimuths α are measured about `d`,
// right-handed, from the seam direction (α = 0 at center back): a right-handed crocheter works towards lower α
// (§2.12 "the RH working direction lowers α"). For a piece worked bottom-up (d = +Y) this is the §2.12 frame with
// the seam at 180°; for a piece worked top-down the toy's left and right stitch ranges swap, as §2.12 says.
import type { ColoredMesh } from '../../types/geometry';
import type { Part, Vec3 } from '../../types/model';
import { limbProximalEnd } from '../model/proportions';
import { worldSdf } from '../model/sdf';
import { localToWorld, partAxis, partCenter } from '../model/transforms';
import { naturalAxis, profileOf, profilePoint, type Axis, type Pole, type Profile } from './profiles';

/**
 * The limbs of §4.2 Proportions: capsule or cylinder parts named `arm_*`, `leg_*` or `limb<n>_*` (§2.9.7 step 6),
 * the same test `core/model/proportions.ts` uses.
 */
export const LIMB_NAME = /^(arm|leg|limb\d+)(_|$)/;

export function isLimb(p: Part): boolean {
  return (p.type === 'capsule' || p.type === 'cylinder') && LIMB_NAME.test(p.id);
}

/**
 * Start pole of a limb attached to `parent` (§2.10.2): `crochet.start` when set, else the distal end — the pole
 * opposite `limbProximalEnd` (which honors `attach.openEnd` and the end stored in `x-cpg-proximal` before its SDF
 * comparison), so the piece starts at the hand or foot and the Proportions edit keeps the same end fixed.
 */
export function limbStartPole(p: Part, parent: Part, meshes?: Record<string, ColoredMesh>): Pole {
  const set = p.crochet?.start;
  if (set === 'bottom' || set === 'top') return set;
  return limbProximalEnd(p, parent, meshes) === 'top' ? 'bottom' : 'top';
}

// ---------------------------------------------------------------------------------------------------------------
// Small vector helpers

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function unit(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const n = norm(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : fallback;
}
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const AXES: Axis[] = ['x', 'y', 'z'];

// ---------------------------------------------------------------------------------------------------------------
// Axis (§2.10.2 rules 1–4)

/** How the axis was chosen: 1 `crochet.axis`, 2 protrusion, 3 longest semi-axis, 4 the primitive's local Y. */
export type AxisRule = 1 | 2 | 3 | 4;

/** Types that honor `crochet.axis` and rule 2 (the others are revolved about their local Y, §3.5.1). */
const FREE_AXIS = new Set<Part['type']>(['sphere', 'ellipsoid', 'box']);

/**
 * The crochet axis â of a part in its local frame (§2.10.2): (1) `crochet.axis` (sphere, ellipsoid, box); (2) an
 * attached sphere or ellipsoid (a protrusion) uses its local axis closest to the direction from the parent's
 * center to its own (ties: Y, then X, then Z); (3) an unattached ellipsoid its longest semi-axis; (4) otherwise
 * local Y.
 */
export function axisOf(part: Part, parent?: Part): { axis: Axis; rule: AxisRule } {
  const set = part.crochet?.axis;
  if ((set === 'x' || set === 'y' || set === 'z') && FREE_AXIS.has(part.type)) return { axis: set, rule: 1 };
  if (parent && (part.type === 'sphere' || part.type === 'ellipsoid')) {
    const dir = sub(partCenter(part), partCenter(parent));
    if (norm(dir) > 1e-9) {
      let best: Axis = 'y';
      let bestDot = -1;
      for (const a of ['y', 'x', 'z'] as Axis[]) {
        const d = Math.abs(dot(unit(dir), partAxis(part, AXIS_INDEX[a])));
        if (d > bestDot + 1e-12) {
          best = a;
          bestDot = d;
        }
      }
      return { axis: best, rule: 2 };
    }
  }
  if (part.type === 'ellipsoid') return { axis: naturalAxis(part), rule: 3 };
  return { axis: 'y', rule: 4 };
}

// ---------------------------------------------------------------------------------------------------------------
// Poles

/** Where the profile's axis runs in the part's local frame: the local coordinate of the −â and +â pole points. */
export function axialSpan(part: Part, axis: Axis): { lo: number; hi: number } | null {
  switch (part.type) {
    case 'sphere':
      return { lo: -part.dims.r, hi: part.dims.r };
    case 'ellipsoid': {
      const r = axis === 'x' ? part.dims.rx : axis === 'y' ? part.dims.ry : part.dims.rz;
      return { lo: -r, hi: r };
    }
    case 'capsule': {
      const h = Math.max(part.dims.length, 2 * part.dims.r) / 2;
      return { lo: -h, hi: h };
    }
    case 'cylinder':
    case 'cone':
      return { lo: -part.dims.h / 2, hi: part.dims.h / 2 };
    case 'box': {
      const h = (axis === 'x' ? part.dims.w : axis === 'y' ? part.dims.h : part.dims.d) / 2;
      return { lo: -h, hi: h };
    }
    case 'lathe': {
      const ys = part.dims.profile.map((q) => q[1]);
      return { lo: Math.min(...ys), hi: Math.max(...ys) };
    }
    case 'torus': {
      if ((part.dims.arcDeg ?? 360) >= 360) return null;
      // a torus arc is worked as the capsule of §2.10.4; it is laid out straight along local Y here (an
      // approximation for trimming and placements; the piece itself is "shaped into a curl")
      const h = ((part.dims.R * (part.dims.arcDeg as number) * Math.PI) / 180 + 2 * part.dims.r) / 2;
      return { lo: -h, hi: h };
    }
    default:
      return null;
  }
}

/** The world point of a pole of a part (the axis point at its −â or +â end). */
export function polePoint(part: Part, axis: Axis, pole: Pole): Vec3 | null {
  const span = axialSpan(part, axis);
  if (!span) return null;
  const local: Vec3 = [0, 0, 0];
  local[AXIS_INDEX[axis]] = pole === 'bottom' ? span.lo : span.hi;
  return localToWorld(part, local);
}

/** How the start pole was chosen (§2.10.2). */
export type StartRule = 'set' | 'openEnd' | 'root' | 'limb' | 'tip' | 'default';

/**
 * The start pole (§2.10.2): `crochet.start`; else the end opposite an explicit open end (`attach.openEnd`); else
 * the root's lowest pole (world y); else a limb's distal end (`limbStartPole`); else the pole lying farther outside
 * the parent (the lower parent SDF: tip first).
 */
export function startPoleOf(part: Part, axis: Axis, parent: Part | undefined, o: { meshes?: Record<string, ColoredMesh>; parentSdf?: (p: Vec3) => number } = {}): { start: Pole; rule: StartRule } {
  const set = part.crochet?.start;
  if (set === 'bottom' || set === 'top') return { start: set, rule: 'set' };
  const open = part.attach?.openEnd;
  if (open === 'top') return { start: 'bottom', rule: 'openEnd' };
  if (open === 'bottom') return { start: 'top', rule: 'openEnd' };
  const lo = polePoint(part, axis, 'bottom');
  const hi = polePoint(part, axis, 'top');
  if (!lo || !hi) return { start: 'bottom', rule: 'default' };
  if (!parent) return { start: hi[1] < lo[1] - 1e-9 ? 'top' : 'bottom', rule: 'root' };
  if (isLimb(part) && axis === 'y') return { start: limbStartPole(part, parent, o.meshes), rule: 'limb' };
  const f = o.parentSdf ?? ((p: Vec3) => worldSdf(parent)(p[0], p[1], p[2]));
  const fl = f(lo);
  const fh = f(hi);
  if (Math.abs(fl - fh) <= 1e-9) return { start: 'bottom', rule: 'tip' };
  return { start: fh < fl ? 'top' : 'bottom', rule: 'tip' };
}

// ---------------------------------------------------------------------------------------------------------------
// The piece frame and its map to model space

export interface PieceGeom {
  part: Part;
  axis: Axis;
  axisRule: AxisRule;
  start: Pole;
  startRule: StartRule;
  /** World unit vector of +â. */
  axisW: Vec3;
  /** World unit vector along which s increases (+â from the bottom pole, −â from the top pole). */
  d: Vec3;
  /** World point of the profile's s = 0 (the start pole's axis point). */
  origin: Vec3;
  /** World unit vector ⊥ d: the seam (center back, or −Y when â is within 30° of ±Z). */
  seam: Vec3;
  /** `d × seam`: α = +90°. */
  side: Vec3;
  /** Whether the seam is center back (else the underside, −Y). */
  seamAt: 'back' | 'bottom';
  /** World unit vector ⊥ d along the cross-section's major axis (a ≥ b). */
  major: Vec3;
  /** `d × major`. */
  minor: Vec3;
  /** a/b of an elliptical cross-section (ellipsoids: similar ellipses); 1 for round sections. */
  ratio: number;
  /** A box's constant a − b (its sides are straight). */
  sideExtra: number;
  /** The untrimmed profile (with the far cap left off when `attach.openEnd` says so). */
  profile: Profile;
}

const SEAM_Z_DEG = 30;

/** §2.10.2 seam: center back = −Z projected perpendicular to â; −Y when â is within 30° of ±Z. */
export function seamOf(axisW: Vec3): { seam: Vec3; at: 'back' | 'bottom' } {
  const cosZ = Math.abs(axisW[2]);
  const nearZ = cosZ >= Math.cos((SEAM_Z_DEG * Math.PI) / 180) - 1e-12;
  const v: Vec3 = nearZ ? [0, -1, 0] : [0, 0, -1];
  const proj = sub(v, scale(axisW, dot(v, axisW)));
  // â exactly along the fallback direction cannot happen (nearZ picks −Y only when â is near Z)
  return { seam: unit(proj, [1, 0, 0]), at: nearZ ? 'bottom' : 'back' };
}

/**
 * The full frame of a piece (§2.10.2) and its profile. `null` for parts without a revolved profile (full torus,
 * flat, mesh).
 */
export function pieceGeom(part: Part, parent: Part | undefined, o: { meshes?: Record<string, ColoredMesh>; parentSdf?: (p: Vec3) => number } = {}): PieceGeom | null {
  const { axis, rule: axisRule } = axisOf(part, parent);
  const span = axialSpan(part, axis);
  if (!span) return null;
  const { start, rule: startRule } = startPoleOf(part, axis, parent, o);
  const openFar = part.attach?.openEnd === 'top' || part.attach?.openEnd === 'bottom';
  const profile = profileOf(part, { axis, start, openFar });
  if (!profile) return null;
  const axisW = unit(partAxis(part, AXIS_INDEX[axis]));
  const d = start === 'bottom' ? axisW : scale(axisW, -1);
  const originLocal: Vec3 = [0, 0, 0];
  originLocal[AXIS_INDEX[axis]] = start === 'bottom' ? span.lo : span.hi;
  const origin = localToWorld(part, originLocal);
  const { seam, at } = seamOf(axisW);
  const side = cross(d, seam);
  // cross-section: the two local axes other than â, the larger one is the major axis
  let ratio = 1;
  let sideExtra = 0;
  let majorAxis: Axis = AXES.find((a) => a !== axis) as Axis;
  if (part.type === 'ellipsoid' || part.type === 'box') {
    const dims: Record<Axis, number> =
      part.type === 'ellipsoid'
        ? { x: part.dims.rx, y: part.dims.ry, z: part.dims.rz }
        : { x: part.dims.w / 2, y: part.dims.h / 2, z: part.dims.d / 2 };
    const others = AXES.filter((a) => a !== axis);
    majorAxis = dims[others[0]] >= dims[others[1]] ? others[0] : others[1];
    const minorAxis = others.find((a) => a !== majorAxis) as Axis;
    const a = dims[majorAxis];
    const b = dims[minorAxis];
    if (part.type === 'ellipsoid') ratio = b > 0 ? a / b : 1;
    else sideExtra = Math.max(0, a - b);
  }
  const major = unit(partAxis(part, AXIS_INDEX[majorAxis]));
  const minor = cross(d, major);
  return { part, axis, axisRule, start, startRule, axisW, d, origin, seam, side, seamAt: at, major, minor, ratio, sideExtra, profile };
}

/** The unit radial direction at azimuth α (radians, right-handed about d from the seam). */
export function radialDir(g: PieceGeom, alpha: number): Vec3 {
  const c = Math.cos(alpha);
  const s = Math.sin(alpha);
  return [g.seam[0] * c + g.side[0] * s, g.seam[1] * c + g.side[1] * s, g.seam[2] * c + g.side[2] * s];
}

/** Distance from the axis to the surface in radial direction u, for a cross-section of minor radius r. */
function sectionRadius(g: PieceGeom, r: number, u: Vec3): number {
  if (r <= 0) return 0;
  const A = g.sideExtra > 0 ? r + g.sideExtra : r * g.ratio;
  if (Math.abs(A - r) <= 1e-12) return r;
  const x = dot(u, g.major) / A;
  const y = dot(u, g.minor) / r;
  return 1 / Math.sqrt(x * x + y * y);
}

/** The world point of the piece's surface at arc position s (of `p`, default the untrimmed profile) and azimuth α. */
export function surfacePoint(g: PieceGeom, s: number, alpha: number, p: Profile = g.profile): Vec3 {
  const q = profilePoint(p, s);
  const u = radialDir(g, alpha);
  const rho = sectionRadius(g, q.r, u);
  return [g.origin[0] + g.d[0] * q.z + u[0] * rho, g.origin[1] + g.d[1] * q.z + u[1] * rho, g.origin[2] + g.d[2] * q.z + u[2] * rho];
}

/** The world point on the axis at arc position s. */
export function axisPoint(g: PieceGeom, s: number, p: Profile = g.profile): Vec3 {
  const q = profilePoint(p, s);
  return add(g.origin, scale(g.d, q.z));
}

export interface Projection {
  /** Arc position of the nearest profile point. */
  s: number;
  /** Axial distance from the start pole. */
  z: number;
  /** Radial distance from the axis (world inches). */
  rho: number;
  /** Azimuth about d from the seam, radians in (−π, π]. */
  alpha: number;
}

/**
 * A world point in the piece's frame: its azimuth, and the arc position of the nearest point of the meridian (an
 * elliptical section is first mapped onto the circle of its minor radius).
 */
export function projectOnto(g: PieceGeom, pw: Vec3, p: Profile = g.profile): Projection {
  const v = sub(pw, g.origin);
  const z = dot(v, g.d);
  const radial = sub(v, scale(g.d, z));
  const rho = norm(radial);
  const alpha = rho > 1e-12 ? Math.atan2(dot(radial, g.side), dot(radial, g.seam)) : 0;
  // equivalent radius on the minor circle
  let req = rho;
  if (rho > 1e-12 && (g.ratio !== 1 || g.sideExtra > 0)) {
    const u = scale(radial, 1 / rho);
    const rAt = (r: number) => sectionRadius(g, r, u);
    // the section radius in direction u grows monotonically with r: invert by bisection
    let lo = 0;
    let hi = Math.max(rho, 1e-6) * 2 + g.sideExtra;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      if (rAt(mid) < rho) lo = mid;
      else hi = mid;
    }
    req = (lo + hi) / 2;
  }
  const M = 256;
  let best = 0;
  let bestD = Infinity;
  const L = p.L;
  const at = (s: number) => {
    const q = profilePoint(p, s);
    return (q.z - z) ** 2 + (q.r - req) ** 2;
  };
  for (let i = 0; i <= M; i++) {
    const s = (L * i) / M;
    const dd = at(s);
    if (dd < bestD) {
      bestD = dd;
      best = s;
    }
  }
  // golden-section refinement inside the neighboring samples
  let a = Math.max(0, best - L / M);
  let b = Math.min(L, best + L / M);
  for (let it = 0; it < 40; it++) {
    const m1 = a + (b - a) * 0.382;
    const m2 = a + (b - a) * 0.618;
    if (at(m1) <= at(m2)) b = m2;
    else a = m1;
  }
  return { s: (a + b) / 2, z, rho, alpha };
}
