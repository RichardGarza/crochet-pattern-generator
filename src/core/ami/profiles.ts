// Track T4 — part-local profiles r(s) of every revolved primitive (DESIGN.md §2.10.4, research 03 §5).
//
// A profile is the meridian of a piece in its own frame: arc length `s` runs from the start pole (s = 0) to the
// far end (s = L); `z(s)` is the distance along the crochet axis from the start pole and `r(s)` the circular
// radius there (the minor cross-section radius b for an oval piece, §2.10.2). Segments are exact: straight lines
// and elliptical arcs (circular arcs are arcs with equal semi-axes, whose arc length is closed form; a true
// ellipse uses a numerically integrated arc-length table, accurate to ~1e-12 in). Pure: no DOM, no Math.random.
import type { Part } from '../../types/model';

export type Axis = 'x' | 'y' | 'z';
export type Pole = 'bottom' | 'top';

/** A crease of the profile: BLO (convex) or FLO (concave) is worked on the first round past it (§2.10.5). */
export interface ProfileCorner {
  /** Arc position of the corner. */
  s: number;
  kind: 'convex' | 'concave';
  /** Turn of the tangent at the corner, degrees. */
  turnDeg: number;
}

/** The cross-section of an oval piece (§2.10.2): `a ≥ b`, `a/b > 1.15`. */
export interface OvalSection {
  a: number;
  b: number;
  /**
   * How `a_k − b_k` varies along the piece: `'scaled'` = in proportion to r(s) (an ellipsoid's cross-sections are
   * similar ellipses), `'constant'` = `a − b` everywhere (a box: "constant S", §2.10.4).
   */
  sides: 'scaled' | 'constant';
}

interface LineSeg {
  kind: 'line';
  z0: number;
  r0: number;
  z1: number;
  r1: number;
}

/** Elliptical arc `z = cz − A·cos t`, `r = B·sin t`, t increasing from t0 to t1 (t = 0 is the start-side pole). */
interface ArcSeg {
  kind: 'arc';
  cz: number;
  A: number;
  B: number;
  t0: number;
  t1: number;
  /** Cumulative arc length at `t0 + i·(t1 − t0)/M` (ellipses only). */
  tbl?: Float64Array;
}

export type ProfileSeg = (LineSeg | ArcSeg) & { readonly s0: number; readonly len: number };

export interface Profile {
  /** What the profile was built from (`'custom'` for test profiles). */
  readonly source: Part['type'] | 'custom';
  readonly L: number;
  readonly segs: readonly ProfileSeg[];
  readonly corners: readonly ProfileCorner[];
  /** r(0) = 0: the piece starts on the axis (magic ring or chain oval); else it starts on a chain ring. */
  readonly closedStart: boolean;
  /** r(L) = 0 and the far end is worked closed (not trimmed, not an open end). */
  readonly closedEnd: boolean;
  /** Largest r along the profile. */
  readonly rMax: number;
  readonly oval?: OvalSection;
  /** Set by `trimProfile`: the arc position where the visible part ends (§2.10.3). */
  readonly trimmedAt?: number;
}

export interface ProfileOptions {
  /** Crochet axis â in the part's frame (§2.10.2). Honored by sphere, ellipsoid and box; revolved types use Y. */
  axis?: Axis;
  /** The start pole: `'bottom'` = the −â pole, `'top'` = the +â pole. Default `'bottom'`. */
  start?: Pole;
  /**
   * The far end is an open end (`attach.openEnd`) on an untrimmed piece: the far cap is left off — a sphere or
   * ellipsoid becomes its half towards the start (a cup), a capsule loses its far quarter circle, a cylinder,
   * cone, box or flat-capped lathe its far disc (§2.10.5 "where the far cap begins").
   */
  openFar?: boolean;
}

/** Corners: a turn of at least this many degrees (§2.10.4) or a lathe `sharp` index. */
export const CORNER_TURN_DEG = 45;
/** Oval threshold a/b (§2.10.2). */
export const OVAL_RATIO = 1.15;
/** Symmetry tolerance: r(s) ≈ r(L − s) within 1% of the largest radius (§2.10.5). */
export const SYMMETRY_TOL = 0.01;

const ARC_TABLE_STEPS = 2048;
const EPS = 1e-9;

// ---------------------------------------------------------------------------------------------------------------
// Segments

function arcSpeed(A: number, B: number, t: number): number {
  const st = Math.sin(t);
  const ct = Math.cos(t);
  return Math.sqrt(A * A * st * st + B * B * ct * ct);
}

/** Simpson's rule on one panel: exact enough (h⁵) for the smooth arc speed on a table step. */
function arcPanel(A: number, B: number, ta: number, tb: number): number {
  return ((tb - ta) / 6) * (arcSpeed(A, B, ta) + 4 * arcSpeed(A, B, (ta + tb) / 2) + arcSpeed(A, B, tb));
}

function makeArc(cz: number, A: number, B: number, t0: number, t1: number): ArcSeg & { len: number } {
  if (Math.abs(A - B) <= EPS * Math.max(A, B, 1)) return { kind: 'arc', cz, A: B, B, t0, t1, len: B * (t1 - t0) };
  const tbl = new Float64Array(ARC_TABLE_STEPS + 1);
  const dt = (t1 - t0) / ARC_TABLE_STEPS;
  for (let i = 0; i < ARC_TABLE_STEPS; i++) {
    const ta = t0 + i * dt;
    // two Simpson panels per table step
    tbl[i + 1] = tbl[i] + arcPanel(A, B, ta, ta + dt / 2) + arcPanel(A, B, ta + dt / 2, ta + dt);
  }
  return { kind: 'arc', cz, A, B, t0, t1, tbl, len: tbl[ARC_TABLE_STEPS] };
}

function makeLine(z0: number, r0: number, z1: number, r1: number): LineSeg & { len: number } {
  return { kind: 'line', z0, r0, z1, r1, len: Math.hypot(z1 - z0, r1 - r0) };
}

/** The parameter t of an arc at arc length u from its start. */
function arcParam(seg: ArcSeg & { len: number }, u: number): number {
  if (!seg.tbl) return seg.t0 + u / seg.B;
  const tbl = seg.tbl;
  const n = tbl.length - 1;
  const dt = (seg.t1 - seg.t0) / n;
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid] <= u) lo = mid;
    else hi = mid;
  }
  const ta = seg.t0 + lo * dt;
  const target = u - tbl[lo];
  // Newton on ∫_{ta}^{t} speed = target, started from the linear guess
  const span = tbl[lo + 1] - tbl[lo];
  let t = ta + (span > 0 ? (target / span) * dt : 0);
  for (let it = 0; it < 4; it++) {
    const f = arcPanel(seg.A, seg.B, ta, t) - target;
    const d = arcSpeed(seg.A, seg.B, t);
    if (d <= 0) break;
    t -= f / d;
  }
  return Math.min(Math.max(t, seg.t0), seg.t1);
}

interface SegPoint {
  z: number;
  r: number;
  /** Unit tangent (dz, dr) in the direction of increasing s. */
  dz: number;
  dr: number;
}

function segPoint(seg: ProfileSeg, u: number): SegPoint {
  const uu = Math.min(Math.max(u, 0), seg.len);
  if (seg.kind === 'line') {
    const f = seg.len > 0 ? uu / seg.len : 0;
    const dz = seg.len > 0 ? (seg.z1 - seg.z0) / seg.len : 1;
    const dr = seg.len > 0 ? (seg.r1 - seg.r0) / seg.len : 0;
    return { z: seg.z0 + f * (seg.z1 - seg.z0), r: seg.r0 + f * (seg.r1 - seg.r0), dz, dr };
  }
  const t = arcParam(seg, uu);
  const vz = seg.A * Math.sin(t);
  const vr = seg.B * Math.cos(t);
  const v = Math.hypot(vz, vr) || 1;
  return { z: seg.cz - seg.A * Math.cos(t), r: Math.max(0, seg.B * Math.sin(t)), dz: vz / v, dr: vr / v };
}

// ---------------------------------------------------------------------------------------------------------------
// Assembling a profile

type RawSeg = (LineSeg | ArcSeg) & { len: number };

interface Build {
  segs: RawSeg[];
  /** Junction indices j (between segs[j−1] and segs[j]) marked sharp regardless of their turn. */
  sharpJunctions?: Set<number>;
  oval?: OvalSection;
}

function assemble(source: Profile['source'], b: Build, closedEndGeom: boolean): Profile {
  const keep: RawSeg[] = [];
  const sharpAfterKeep = new Set<number>();
  b.segs.forEach((seg, j) => {
    if (!(seg.len > EPS)) {
      // a zero-length segment: its sharp mark, if any, moves to the next kept junction
      if (b.sharpJunctions?.has(j) || b.sharpJunctions?.has(j + 1)) sharpAfterKeep.add(keep.length);
      return;
    }
    if (b.sharpJunctions?.has(j)) sharpAfterKeep.add(keep.length);
    keep.push(seg);
  });
  if (keep.length === 0) throw new RangeError(`profile: a ${source} part with no length`);
  let s = 0;
  const segs: ProfileSeg[] = keep.map((seg) => {
    const out = { ...seg, s0: s } as ProfileSeg;
    s += seg.len;
    return out;
  });
  const L = s;
  const corners: ProfileCorner[] = [];
  for (let j = 1; j < segs.length; j++) {
    const a = segPoint(segs[j - 1], segs[j - 1].len);
    const c = segPoint(segs[j], 0);
    const cos = Math.min(1, Math.max(-1, a.dz * c.dz + a.dr * c.dr));
    const turnDeg = (Math.acos(cos) * 180) / Math.PI;
    const cross = a.dz * c.dr - a.dr * c.dz;
    if (turnDeg >= CORNER_TURN_DEG - 1e-9 || (sharpAfterKeep.has(j) && turnDeg > 1e-6)) {
      // A convex crease (the cylinder's rim) turns the tangent towards the axis side: cross < 0.
      // a fold straight back (cross = 0, turn 180°, e.g. a zero-height lathe) is a rim: convex
      corners.push({ s: segs[j].s0, kind: cross < 0 || (cross === 0 && turnDeg > 90) ? 'convex' : 'concave', turnDeg });
    }
  }
  const first = segPoint(segs[0], 0);
  const last = segPoint(segs[segs.length - 1], segs[segs.length - 1].len);
  const scale = Math.max(1e-6, L);
  const rMax = maxRadius(segs);
  if (!(rMax > 1e-9 * scale)) throw new RangeError(`profile: a ${source} part with no width (every point on the axis)`);
  return {
    source,
    L,
    segs,
    corners,
    closedStart: first.r <= 1e-9 * scale,
    closedEnd: closedEndGeom && last.r <= 1e-9 * scale,
    rMax,
    ...(b.oval ? { oval: b.oval } : {}),
  };
}

function maxRadius(segs: readonly ProfileSeg[]): number {
  let m = 0;
  for (const seg of segs) {
    if (seg.kind === 'line') m = Math.max(m, seg.r0, seg.r1);
    else {
      m = Math.max(m, seg.B * Math.sin(seg.t0), seg.B * Math.sin(seg.t1));
      if (seg.t0 <= Math.PI / 2 && seg.t1 >= Math.PI / 2) m = Math.max(m, seg.B);
    }
  }
  return m;
}

/** Locate the segment holding arc position s (clamped to [0, L]). */
function locate(p: Profile, s: number): { seg: ProfileSeg; u: number } {
  const ss = Math.min(Math.max(s, 0), p.L);
  let lo = 0;
  let hi = p.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.segs[mid].s0 <= ss) lo = mid;
    else hi = mid - 1;
  }
  const seg = p.segs[lo];
  return { seg, u: ss - seg.s0 };
}

/** The profile point at arc position s: axial distance from the start pole, radius, unit tangent. */
export function profilePoint(p: Profile, s: number): SegPoint {
  const { seg, u } = locate(p, s);
  return segPoint(seg, u);
}

/** r(s): the circular radius (minor radius b for an oval) at arc position s. */
export function profileR(p: Profile, s: number): number {
  return profilePoint(p, s).r;
}

/** `a_k − b_k` of an oval piece at arc position s (0 for a circular piece). */
export function ovalHalfDiff(p: Profile, s: number): number {
  if (!p.oval) return 0;
  const d = p.oval.a - p.oval.b;
  return p.oval.sides === 'constant' ? d : (d * profileR(p, s)) / p.oval.b;
}

/**
 * §2.10.5: "symmetric profile (r(s) ≈ r(L − s) within 1%)" — read as within 1% of the largest radius, checked
 * at 257 evenly spaced arc positions; an oval's side widths must be symmetric the same way.
 */
export function isSymmetricProfile(p: Profile): boolean {
  const tol = SYMMETRY_TOL * Math.max(p.rMax, 1e-9);
  const M = 256;
  for (let i = 0; i <= M / 2; i++) {
    const s = (p.L * i) / M;
    if (Math.abs(profileR(p, s) - profileR(p, p.L - s)) > tol) return false;
    if (p.oval && Math.abs(ovalHalfDiff(p, s) - ovalHalfDiff(p, p.L - s)) > tol) return false;
  }
  return true;
}

/**
 * Cut a profile at `sCut` (the trimmed visible portion, §2.10.3): the far end becomes an open end sewn to the
 * parent; corners past the cut are dropped. `sCut ≥ L` returns the profile unchanged.
 */
export function trimProfile(p: Profile, sCut: number): Profile {
  if (!(sCut > EPS) || !Number.isFinite(sCut)) throw new RangeError(`trimProfile: the cut must be a length > 0, got ${sCut}`);
  if (sCut >= p.L - EPS) return p;
  const segs: ProfileSeg[] = [];
  for (const seg of p.segs) {
    if (seg.s0 >= sCut - EPS) break;
    const len = Math.min(seg.len, sCut - seg.s0);
    if (len === seg.len) {
      segs.push(seg);
      continue;
    }
    if (seg.kind === 'line') {
      const e = segPoint(seg, len);
      segs.push({ ...seg, z1: e.z, r1: e.r, len });
    } else {
      const t1 = arcParam(seg, len);
      const cut = makeArc(seg.cz, seg.A, seg.B, seg.t0, t1);
      segs.push({ ...cut, s0: seg.s0, len } as ProfileSeg);
    }
  }
  return {
    ...p,
    L: sCut,
    segs,
    corners: p.corners.filter((c) => c.s < sCut - EPS),
    closedEnd: false,
    rMax: maxRadius(segs),
    trimmedAt: sCut,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Primitives

const AXES: Axis[] = ['x', 'y', 'z'];

/**
 * The primitive's own crochet axis when nothing else decides it (§2.10.2 rules 3–4): an ellipsoid uses its
 * longest semi-axis (ties → Y, then X); every other primitive its local Y (a torus: the ring).
 */
export function naturalAxis(part: Part): Axis {
  if (part.type === 'ellipsoid') {
    const { rx, ry, rz } = part.dims;
    const m = Math.max(rx, ry, rz);
    if (ry === m) return 'y';
    if (rx === m) return 'x';
    return 'z';
  }
  return 'y';
}

function axisSplit(dims: Record<Axis, number>, axis: Axis): { polar: number; a: number; b: number } {
  const others = AXES.filter((x) => x !== axis).map((x) => dims[x]);
  return { polar: dims[axis], a: Math.max(...others), b: Math.min(...others) };
}

function ovalOf(a: number, b: number, sides: OvalSection['sides']): OvalSection | undefined {
  return b > 0 && a / b > OVAL_RATIO + 1e-12 ? { a, b, sides } : undefined;
}

/** A half (t from 0 to π) or, with an open far end, a quarter (0 to π/2) of an ellipse meridian. */
function meridian(A: number, B: number, openFar: boolean): RawSeg[] {
  return [makeArc(A, A, B, 0, openFar ? Math.PI / 2 : Math.PI)];
}

/** Revolved wall with optional discs at the start (z = 0) and far end. */
function walled(r0: number, r1: number, h: number, disc0: boolean, disc1: boolean): Build {
  const segs: RawSeg[] = [];
  if (disc0) segs.push(makeLine(0, 0, 0, r0));
  segs.push(makeLine(0, r0, h, r1));
  if (disc1) segs.push(makeLine(h, r1, h, 0));
  return { segs };
}

function latheBuild(dims: { profile: [number, number][]; sharp?: number[] }, start: Pole, openFar: boolean): Build {
  const pts = dims.profile.map(([r, y], i) => ({ r: Math.max(0, r), y, i }));
  if (start === 'top') pts.reverse();
  const y0 = pts[0].y;
  const zOf = (y: number) => (start === 'top' ? y0 - y : y - y0);
  const sharp = new Set(dims.sharp ?? []);
  const segs: RawSeg[] = [];
  const sharpJunctions = new Set<number>();
  const scale = Math.max(1e-6, ...pts.map((q) => Math.abs(q.y - y0)), ...pts.map((q) => q.r));
  // An end off the axis is closed by a flat disc, as the SDF closes it (s0b-model deviation 3).
  if (pts[0].r > 1e-9 * scale) segs.push(makeLine(0, 0, 0, pts[0].r));
  for (let j = 0; j + 1 < pts.length; j++) {
    if (sharp.has(pts[j].i)) sharpJunctions.add(segs.length);
    segs.push(makeLine(zOf(pts[j].y), pts[j].r, zOf(pts[j + 1].y), pts[j + 1].r));
  }
  const last = pts[pts.length - 1];
  if (last.r > 1e-9 * scale && !openFar) {
    if (sharp.has(last.i)) sharpJunctions.add(segs.length);
    segs.push(makeLine(zOf(last.y), last.r, zOf(last.y), 0));
  }
  return { segs, sharpJunctions };
}

/**
 * The profile of a part (§2.10.4), or `null` for parts that have none here: a full torus (see `torusCounts`),
 * `flat` parts (§2.10.9) and `mesh` parts (lathe fit or Path B, §2.10.7). A torus arc (< 360°) is the capsule
 * of length `R·arc + 2r` of §2.10.4.
 */
export function profileOf(part: Part, o: ProfileOptions = {}): Profile | null {
  checkDims(part);
  const start = o.start ?? 'bottom';
  const openFar = o.openFar === true;
  switch (part.type) {
    case 'sphere': {
      const { r } = part.dims;
      return assemble('sphere', { segs: meridian(r, r, openFar) }, !openFar);
    }
    case 'ellipsoid': {
      const axis = o.axis ?? naturalAxis(part);
      const { rx, ry, rz } = part.dims;
      const { polar, a, b } = axisSplit({ x: rx, y: ry, z: rz }, axis);
      const oval = ovalOf(a, b, 'scaled');
      return assemble('ellipsoid', { segs: meridian(polar, b, openFar), ...(oval ? { oval } : {}) }, !openFar);
    }
    case 'capsule':
      return capsule('capsule', part.dims.r, part.dims.length, openFar);
    case 'torus': {
      const arcDeg = part.dims.arcDeg ?? 360;
      if (arcDeg >= 360) return null;
      const { R, r } = part.dims;
      return capsule('torus', r, (R * arcDeg * Math.PI) / 180 + 2 * r, openFar);
    }
    case 'cylinder': {
      const { rTop, rBottom, h } = part.dims;
      const open = part.dims.open ?? 'none';
      const openBottom = open === 'bottom' || open === 'both';
      const openTop = open === 'top' || open === 'both';
      const b =
        start === 'bottom'
          ? walled(rBottom, rTop, h, !openBottom, !openTop && !openFar)
          : walled(rTop, rBottom, h, !openTop, !openBottom && !openFar);
      return assemble('cylinder', b, true);
    }
    case 'cone': {
      const { r, h } = part.dims;
      // apex +Y: from the top the slant comes first, from the bottom the base disc
      const b = start === 'top' ? walled(0, r, h, false, !openFar) : walled(r, 0, h, true, false);
      return assemble('cone', b, true);
    }
    case 'lathe': {
      // An open far end drops the closing disc of an off-axis end; a profile that itself comes back to the axis
      // has no cap to leave off and stays closed (like a cone started from its base).
      const b = latheBuild(part.dims, start, openFar);
      const pts = part.dims.profile;
      const farR = start === 'top' ? pts[0][0] : pts[pts.length - 1][0];
      return assemble('lathe', b, !openFar || !(farR > 0));
    }
    case 'box': {
      const axis = o.axis ?? 'y';
      const { w, h, d } = part.dims;
      const { polar, a, b } = axisSplit({ x: w / 2, y: h / 2, z: d / 2 }, axis);
      const oval = ovalOf(a, b, 'constant');
      const build = walled(b, b, 2 * polar, true, !openFar);
      return assemble('box', { ...build, ...(oval ? { oval } : {}) }, true);
    }
    default:
      return null;
  }
}

/** Every number of a revolved part's dims must be finite (the schema bounds them to 0.05–48 in, §3.5.2). */
function checkDims(part: Part): void {
  if (part.type === 'flat' || part.type === 'mesh') return;
  const nums: number[] = [];
  if (part.type === 'lathe') {
    if (!Array.isArray(part.dims.profile) || part.dims.profile.length < 2) throw new RangeError('profile: a lathe needs at least 2 profile points');
    part.dims.profile.forEach(([r, y]) => nums.push(r, y));
  }
  else for (const v of Object.values(part.dims)) if (typeof v === 'number') nums.push(v);
  if (!nums.every(Number.isFinite)) throw new RangeError(`profile: a ${part.type} part with a non-finite dimension: ${JSON.stringify(part.dims)}`);
}

function capsule(source: Profile['source'], r: number, length: number, openFar: boolean): Profile {
  const wall = Math.max(0, length - 2 * r);
  const segs: RawSeg[] = [makeArc(r, r, r, 0, Math.PI / 2), makeLine(r, r, r + wall, r)];
  if (!openFar) segs.push(makeArc(r + wall, r, r, Math.PI / 2, Math.PI));
  return assemble(source, { segs }, !openFar);
}

/** A profile from a polyline `[z, r]` (z non-decreasing) — for tests and the lathe fit of mesh parts. */
export function polylineProfile(pts: readonly [number, number][], o: { sharp?: number[]; oval?: OvalSection } = {}): Profile {
  const segs: RawSeg[] = [];
  const sharpJunctions = new Set<number>();
  for (let j = 0; j + 1 < pts.length; j++) {
    if (o.sharp?.includes(j)) sharpJunctions.add(segs.length);
    segs.push(makeLine(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]));
  }
  return assemble('custom', { segs, sharpJunctions, ...(o.oval ? { oval: o.oval } : {}) }, true);
}
