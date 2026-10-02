// Track T4 — the plan: how each part is made (DESIGN.md §2.10.1), safety-eye sizes (integration task T4-6) and
// default stuffing.
//
// | # | Rule | Result |
// |---|---|---|
// | 1 | id/label contains `eye`, or a sphere/ellipsoid ≤ 0.6 in across with OKLab L < 0.25 attached to another part | `safety_eye` (size snapped; `audience: 'under3'` or embroidered eyes ⇒ `embroidery`) |
// | 2 | largest axis-aligned cross-section circumference < 12·wS | `embroidery` |
// | 3 | start-cap cover: flatness < 0.4, thin axis within 30° of the parent's axis, center within e₁ of the parent surface and within the first 25% of the parent's profile, footprint inside the parent's silhouette | `region` on the parent |
// | 4 | thin: flatness < 0.25 and center within 0.15 in of the parent surface | `applique` |
// | 5 | everything else | `piece` |
//
// Extents are the part's local bbox extents sorted e₁ ≤ e₂ ≤ e₃; flatness = e₁/e₂. `part.crochet.make` (not
// 'auto') wins. The root is always a piece (rules 1–4 describe parts on another part).
import type { MakeAs } from '../../types/ami';
import type { Hex, Part, Vec3 } from '../../types/model';
import { hexToOklab } from '../kernel/color';
import { partWorldVertices, worldSdf, type WorldSdf } from '../model/sdf';
import { boundsSize, localBounds, partAxis, partCenter } from '../model/transforms';
import { dot, projectOnto, sub, type PieceGeom } from './frame';
import { profilePoint } from './profiles';

/** Safety-eye sizes the plan offers (§2.10.1 rule 1), mm. */
export const SAFETY_EYE_MM: readonly number[] = Object.freeze([6, 8, 9, 10, 12, 15]);

/**
 * The nearest safety-eye size that exists, mm (ties go to the larger size, as `roundHalfUp` would). A size that
 * is missing, not finite or ≤ 0 has no nearest size: `undefined` (the caller falls back to the part's diameter).
 */
export function snapSafetyEyeMm(mm: number | undefined): number | undefined {
  if (mm === undefined || !Number.isFinite(mm) || mm <= 0) return undefined;
  let best = SAFETY_EYE_MM[0];
  for (const s of SAFETY_EYE_MM) if (Math.abs(s - mm) <= Math.abs(best - mm) + 1e-9) best = s;
  return best;
}

/** Rule thresholds (§2.10.1). */
export const PLAN = Object.freeze({
  eyeMaxIn: 0.6,
  eyeMaxL: 0.25,
  embroideryWs: 12,
  coverFlatness: 0.4,
  coverAxisDeg: 30,
  coverProfileShare: 0.25,
  coverFootprint: 1.1,
  coverFootprintWs: 0.5,
  thinFlatness: 0.25,
  thinSurfaceIn: 0.15,
  /** Default stuffing: flatness below this ⇒ `none` (never the root). */
  pressedFlatness: 0.45,
  /** A trimmed piece shorter than this × its opening diameter is a "cup" ⇒ `light`. */
  cupRatio: 1.5,
});

export type PlanRule = 'set' | 'root' | 1 | 2 | 3 | 4 | 5;

export interface PartPlan {
  make: MakeAs;
  rule: PlanRule;
  /** Local bbox extents sorted e₁ ≤ e₂ ≤ e₃. */
  extents: [number, number, number];
  /** e₁ / e₂. */
  flatness: number;
  /** Rule 1: the snapped safety-eye size, mm (also for an eye made as embroidery). */
  eyeMm?: number;
  /** Rule 2: the largest axis-aligned cross-section circumference, in. */
  circumference: number;
  /** Rule 3: the facts of the start-cap test (when it was evaluated). */
  cover?: CoverTest;
}

export interface CoverTest {
  ok: boolean;
  axisDeg: number;
  surfaceIn: number;
  profileShare: number;
  footprintIn: number;
  limitIn: number;
  rMaxIn: number;
}

export interface PlanContext {
  /** The part this one is attached to (absent for the root). */
  parent?: Part;
  /** The parent's frame and untrimmed profile (rule 3); absent when the parent has none. */
  parentGeom?: PieceGeom | null;
  /** The parent's signed distance (positive inside). */
  parentSdf?: WorldSdf;
  /** The stuffed stitch width at the default stuffing (rule 2's 12·wS and rule 3's 0.5·wS). */
  wS: number;
  /** Palette id → hex (rule 1's lightness). */
  colorOf: (id: string) => Hex | undefined;
  audience?: 'adult' | 'child' | 'under3';
  eyes: 'auto' | 'safety' | 'embroidered';
}

/** Local bbox extents sorted ascending. */
export function sortedExtents(part: Part): [number, number, number] {
  const s = boundsSize(localBounds(part));
  return [...s].sort((a, b) => a - b) as [number, number, number];
}

/** Ramanujan's perimeter of an ellipse with semi-axes a, b. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Rule 2: the largest of the three axis-aligned central cross-sections' circumferences. */
export function largestCircumference(part: Part): number {
  const s = boundsSize(localBounds(part));
  const pairs: [number, number][] = [
    [s[0], s[1]],
    [s[0], s[2]],
    [s[1], s[2]],
  ];
  if (part.type === 'box') return Math.max(...pairs.map(([a, b]) => 2 * (a + b)));
  return Math.max(...pairs.map(([a, b]) => ellipsePerimeter(a / 2, b / 2)));
}

const EYE_NAME = /eye/i;

/** The local axis index (0 X, 1 Y, 2 Z) of the smallest extent. */
function thinAxis(part: Part): 0 | 1 | 2 {
  const s = boundsSize(localBounds(part));
  let i: 0 | 1 | 2 = 0;
  if (s[1] < s[i]) i = 1;
  if (s[2] < s[i]) i = 2;
  return i;
}

/**
 * Rule 3, the start-cap cover test, against the parent's frame and untrimmed profile: flatness < 0.4; the thin axis
 * within 30° of the parent's axis; the center within e₁ of the parent surface and, projected onto the parent's
 * profile, within its first 25% from the start pole; every builder vertex of the cover within
 * `1.1·r_max + 0.5·wS` of the parent's axis, `r_max` = the parent profile's largest radius over the cover's span.
 */
export function coverTest(part: Part, extents: [number, number, number], ctx: PlanContext): CoverTest | undefined {
  const g = ctx.parentGeom;
  const sdf = ctx.parentSdf;
  if (!g || !sdf) return undefined;
  const flatness = extents[1] > 0 ? extents[0] / extents[1] : 1;
  const thin = partAxis(part, thinAxis(part));
  const axisDeg = (Math.acos(Math.min(1, Math.abs(dot(thin, g.d)))) * 180) / Math.PI;
  const c = partCenter(part);
  const surfaceIn = Math.abs(sdf(c[0], c[1], c[2]));
  const pr = projectOnto(g, c);
  const profileShare = g.profile.L > 0 ? pr.s / g.profile.L : 1;
  // the cover's axial span and footprint in the parent's frame
  const v = partWorldVertices(part);
  let zMin = Infinity;
  let zMax = -Infinity;
  let footprintIn = 0;
  for (let i = 0; i + 2 < v.length; i += 3) {
    const w: Vec3 = sub([v[i], v[i + 1], v[i + 2]], g.origin);
    const z = dot(w, g.d);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    footprintIn = Math.max(footprintIn, Math.sqrt(Math.max(0, dot(w, w) - z * z)));
  }
  // r_max over the span: sample the profile, keep the points whose z lies in it (else the one nearest the span)
  let rMaxIn = 0;
  let nearest = { dz: Infinity, r: 0 };
  const M = 512;
  for (let i = 0; i <= M; i++) {
    const q = profilePoint(g.profile, (g.profile.L * i) / M);
    if (q.z >= zMin - 1e-9 && q.z <= zMax + 1e-9) rMaxIn = Math.max(rMaxIn, q.r);
    const dz = q.z < zMin ? zMin - q.z : q.z > zMax ? q.z - zMax : 0;
    if (dz < nearest.dz) nearest = { dz, r: q.r };
  }
  if (rMaxIn === 0) rMaxIn = nearest.r;
  // an elliptical parent section is wider than its profile radius along its major axis
  const sectionScale = g.sideExtra > 0 ? 1 : g.ratio;
  const limitIn = PLAN.coverFootprint * rMaxIn * sectionScale + g.sideExtra + PLAN.coverFootprintWs * ctx.wS;
  const ok =
    flatness < PLAN.coverFlatness &&
    axisDeg <= PLAN.coverAxisDeg + 1e-9 &&
    surfaceIn <= extents[0] + 1e-9 &&
    profileShare <= PLAN.coverProfileShare + 1e-9 &&
    footprintIn <= limitIn + 1e-9;
  return { ok, axisDeg, surfaceIn, profileShare, footprintIn, limitIn, rMaxIn };
}

/** §2.10.1: how one part is made. */
export function planPart(part: Part, ctx: PlanContext): PartPlan {
  const extents = sortedExtents(part);
  const flatness = extents[1] > 0 ? extents[0] / extents[1] : 1;
  const circumference = largestCircumference(part);
  const base = { extents, flatness, circumference };
  const eyeMm = () => snapSafetyEyeMm(extents[2] * 25.4);
  const eyeMake = (): MakeAs => (ctx.audience === 'under3' || ctx.eyes === 'embroidered' ? 'embroidery' : 'safety_eye');
  const set = part.crochet?.make;
  if (set && set !== 'auto') {
    const make = set as MakeAs;
    return { ...base, make, rule: 'set', ...(make === 'safety_eye' ? { eyeMm: eyeMm() } : {}) };
  }
  if (!ctx.parent) return { ...base, make: 'piece', rule: 'root' };
  // rule 1
  const named = EYE_NAME.test(part.id) || EYE_NAME.test(part.label ?? '');
  const hex = ctx.colorOf(part.color);
  const dark = hex !== undefined && hexToOklab(hex)[0] < PLAN.eyeMaxL;
  const small = (part.type === 'sphere' || part.type === 'ellipsoid') && extents[2] <= PLAN.eyeMaxIn + 1e-9;
  if (named || (small && dark)) return { ...base, make: eyeMake(), rule: 1, eyeMm: eyeMm() };
  // rule 2
  if (circumference < PLAN.embroideryWs * ctx.wS) return { ...base, make: 'embroidery', rule: 2 };
  // rule 3
  const cover = coverTest(part, extents, ctx);
  if (cover?.ok) return { ...base, make: 'region', rule: 3, cover };
  // rule 4
  const sdf = ctx.parentSdf ?? worldSdf(ctx.parent);
  const c = partCenter(part);
  if (flatness < PLAN.thinFlatness && Math.abs(sdf(c[0], c[1], c[2])) <= PLAN.thinSurfaceIn + 1e-9) {
    return { ...base, make: 'applique', rule: 4, ...(cover ? { cover } : {}) };
  }
  return { ...base, make: 'piece', rule: 5, ...(cover ? { cover } : {}) };
}

export type Stuffing = 'firm' | 'medium' | 'light' | 'none';

/**
 * §2.10.1 default stuffing: the part's own `stuffing` wins; flat parts and appliqués are never stuffed;
 * flatness < 0.45 ⇒ `none` (never for the root); a trimmed "cup" (crocheted length < 1.5 × its opening diameter)
 * ⇒ `light`; otherwise `AmiSettings.defaultStuffing`.
 */
export function stuffingOf(part: Part, o: { make: MakeAs; root: boolean; flatness: number; cup: boolean; defaultStuffing: 'firm' | 'medium' | 'light' }): Stuffing {
  if (o.make !== 'piece' || part.type === 'flat') return 'none';
  if (part.stuffing) return part.stuffing;
  if (!o.root && o.flatness < PLAN.pressedFlatness) return 'none';
  if (o.cup) return 'light';
  return o.defaultStuffing;
}

/** A trimmed piece is a cup when its crocheted length is under 1.5 × its opening's diameter. */
export function isCup(lengthIn: number, openingDiameterIn: number): boolean {
  return lengthIn < PLAN.cupRatio * openingDiameterIn - 1e-12;
}
