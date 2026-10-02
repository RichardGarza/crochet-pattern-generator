// Track T4 — the amigurumi engine: model → frames → plan → trim → counts → ops → cues → lines → validate →
// assembly → the 3D PatternDoc (DESIGN.md §2.10–§2.12; §5.2.1 `generateAmigurumi`). `deps.pathB` is the private
// mesh.worker's pathB (§5.4); `deps.gate` lets a superseded run stop between stages.
//
// Sprint T4.3 builds the whole pipeline with the minimal colorwork the teddy needs (a start-cap cover's band on its
// host, §2.10.1 rule 3); stitch colors from regions and paint, joined-round stripes, rings and ghosts for the
// preview and the yardage band details come with T4.4.
import type { AmiRequest, AmiResult, AmiSettings, MakeAs, PieceFrame, RingGeom, RoundsResult } from '../../types/ami';
import type { GenerateAmigurumiFn } from '../../types/entryPoints';
import type { ResolvedGauge } from '../../types/gauge';
import type { ColoredMesh } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Feature, Part, Vec3 } from '../../types/model';
import type { AssemblyStep, Line, MaterialsLine, PatternDoc, Piece, PieceFinish } from '../../types/pattern';
import type { MeshApi } from '../../types/workers';
import { stuffedCell } from '../gauge/resolve';
import { roundHalfUp } from '../gauge/round';
import { hookUsLabel, inToCm } from '../gauge/tables';
import { gramsFor, skeinsToBuy, yardsToMeters } from '../gauge/yarnPerStitch';
import { canonicalJson, CODE_VERSION, createFnv1a64 } from '../kernel/hash';
import { attachGraph, GAP_WARN_IN } from '../model/attach';
import { localSdf, surfaceGapWith, worldSdf, type WorldSdf } from '../model/sdf';
import { localCenter, localToWorld, modelBounds, partCenter } from '../model/transforms';
import { computeSkill } from '../pattern/skill';
import { notesFor } from '../pattern/notes';
import { abbreviationsFor, specialStitchesFor } from '../pattern/terminology';
import { isImplemented } from '../stub';
import { nearestYarn } from '../yarn/match';
import { amiYards, embroideryIn, pieceYarn, type ColorYarn } from '../yardage/threeD';
import { assemblySteps, roundOf, validateAssembly, type Host, type Placement, type Spot } from './assembly';
import { addCue, eyeCue, frontMarkerCue, markerWords, stuffFirmCue, stuffingRound, stuffLightCue, type SeamAt } from './cues';
import { appliqueShape, flattenedTube, type FlatShape } from './flat';
import { add, axisPoint, pieceGeom, projectOnto, scale, surfacePoint, unit, type PieceGeom } from './frame';
import { gapAt, seamAngles } from './lean';
import { foldRounds, placePiece } from './place';
import { ellipsePerimeter, isCup, planPart, stuffingOf, type PartPlan, type Stuffing } from './plan';
import { pieceFinish, sewingTail, closedSeamIn, GATHER_TAIL_IN } from './poles';
import { profilePoint, trimProfile, type Profile } from './profiles';
import { roundsForPart, type PieceCounts } from './rounds';
import { trimWalk, type TrimResult } from './trim';
import { validatePiece3d } from './validate3d';

/** The yarn line `nearestYarn` searches for material names (§2.4: the reference line, also the default `lineIds`). */
export const REFERENCE_LINE_ID = 'red-heart-super-saver';

type Deps = { pathB?: MeshApi['pathB']; gate?: { check(jobId: number): Promise<void> } };

// ---------------------------------------------------------------------------------------------------------------
// Per-part state

interface Node {
  part: Part;
  index: number;
  parent?: Part;
  depth: number;
  geom: PieceGeom | null;
  plan: PartPlan;
  /** The nearest ancestor that is crocheted (a piece or appliqué) — what this part is placed on. */
  hostId?: string;
}

interface Work {
  node: Node;
  /** Primary part of a mirrored "make 2" pair (this part's piece is the primary's). */
  twinOf?: string;
  /** The mirrored copy of this primary part. */
  twin?: string;
  kind: 'revolved' | 'applique' | 'tube' | 'mesh' | 'torus';
  stuffing: Stuffing;
  cell: { wS: number; hS: number };
  style: 'classic' | 'exact';
  trim?: TrimResult;
  /** The worked profile (trimmed), Path A pieces only. */
  profile: Profile | null;
  counts: PieceCounts;
  shape?: FlatShape;
  open: boolean;
  unfolded: Line[];
  path: 'A' | 'B';
  mainCode: string;
  band?: { rounds: number; code: string; partId: string };
  rRef: number;
  alphaSeam: number[];
  finish?: PieceFinish;
  title: string;
  /** Eyes fitted in this piece: the round after which they go in (rA + 1). */
  eyeRound: number;
}

interface EyeGroup {
  hostId: string;
  points: Vec3[];
  ids: string[];
  sizeMm: number;
  embroidered: boolean;
  color?: string;
  /** Continuous round of the first eye. */
  c: number;
  rA: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const SIDE_WORD = /\b(left|right)\b/gi;

/** "Left Ear Inner" → "Inner ear"; "arm_l" → "Arm". */
export function pieceTitle(part: Part): string {
  const raw = (part.label && part.label.trim() !== '' ? part.label : part.id.replace(/_(l|r)$/, '').replace(/_/g, ' ')).replace(SIDE_WORD, ' ');
  let words = raw.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1]?.toLowerCase();
  if (words.length > 1 && (last === 'inner' || last === 'outer')) words = [words[words.length - 1], ...words.slice(0, -1)];
  const s = words.join(' ').toLowerCase();
  return s.length === 0 ? part.id : s[0].toUpperCase() + s.slice(1);
}

function pluralTitle(t: string): string {
  if (/(s|x|ch|sh)$/i.test(t)) return `${t}es`;
  if (/[^aeiou]y$/i.test(t)) return `${t.slice(0, -1)}ies`;
  if (/foot$/i.test(t)) return t.replace(/foot$/i, 'feet');
  return `${t}s`;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** `mirrorOf` pairs with mirrored geometry (dims equal, x mirrored) become one piece "make 2" (§2.10.1). */
export function isMirrored(a: Part, b: Part): boolean {
  if (a.type !== b.type || canonicalJson(a.dims) !== canonicalJson(b.dims)) return false;
  const size = Math.max(1e-3, ...a.position.map(Math.abs), ...b.position.map(Math.abs));
  const tol = 1e-4 * size + 1e-6;
  const ra = a.rotationDeg ?? [0, 0, 0];
  const rb = b.rotationDeg ?? [0, 0, 0];
  const angle = (x: number, y: number) => near(((((x - y) % 360) + 540) % 360) - 180, 0, 1e-3);
  return (
    near(a.position[0], -b.position[0], tol) &&
    near(a.position[1], b.position[1], tol) &&
    near(a.position[2], b.position[2], tol) &&
    angle(ra[0], rb[0]) &&
    angle(ra[1], -rb[1]) &&
    angle(ra[2], -rb[2])
  );
}

/** A point on a part's surface at (azimuth, elevation) in its local frame, from its local center (§3.5.2). */
export function surfaceAt(part: Part, azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  const c = localCenter(part);
  const f = localSdf(part);
  const at = (t: number) => f(c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t);
  let hi = 1e-3;
  for (let i = 0; i < 60 && at(hi) > 0; i++) hi *= 1.5;
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > 0) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return localToWorld(part, [c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t]);
}

/** The surface point of a solid nearest to p (from its signed distance; positive inside). */
function closestOnSurface(f: WorldSdf, p: Vec3): Vec3 {
  let q = p;
  for (let it = 0; it < 4; it++) {
    const d = f(q[0], q[1], q[2]);
    if (Math.abs(d) < 1e-6) break;
    const h = 1e-4;
    const g: Vec3 = [
      f(q[0] + h, q[1], q[2]) - f(q[0] - h, q[1], q[2]),
      f(q[0], q[1] + h, q[2]) - f(q[0], q[1] - h, q[2]),
      f(q[0], q[1], q[2] + h) - f(q[0], q[1], q[2] - h),
    ];
    const n = unit(scale(g, -1)); // outward
    q = add(q, scale(n, d));
  }
  return q;
}

const codeLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `C${i + 1}`);

const fmtIn = (x: number) => String(roundHalfUp(x * 4) / 4);
const fmtCm = (x: number) => String(roundHalfUp(inToCm(x) * 2) / 2);

// ---------------------------------------------------------------------------------------------------------------
// Stage 1: frames and the plan (root first), mirrored pairs; per piece: trim and stuffing

export interface PlanStage {
  graph: ReturnType<typeof attachGraph>;
  /** Part indices, breadth first from the root. */
  order: number[];
  nodes: Map<string, Node>;
  /** Mirrored copy → its primary part ("make 2"). */
  twinOf: Map<string, string>;
  byId: Map<string, Part>;
  sdf: (p: Part) => WorldSdf;
  /** W_GAP findings. */
  issues: Issue[];
}

/** Frames for every part, root first (§2.10.2), the plan (§2.10.1) and the "make 2" pairs; `null` unless one tree. */
export function planStage(req: Pick<AmiRequest, 'model' | 'gauge' | 'settings' | 'meshes'>): PlanStage | null {
  const model = req.model;
  const s = req.settings;
  const graph = attachGraph(model.parts);
  if (!graph.isTree) return null;
  const issues: Issue[] = [];
  const order: number[] = [];
  const depth = new Map<number, number>();
  const queue = [graph.roots[0]];
  depth.set(graph.roots[0], 0);
  while (queue.length > 0) {
    const at = queue.shift() as number;
    order.push(at);
    for (const c of graph.children[at]) {
      depth.set(c, (depth.get(at) ?? 0) + 1);
      queue.push(c);
    }
  }
  const parts = model.parts;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const paletteHex = new Map(model.palette.map((c) => [c.id, c.hex]));
  const defaultCell = stuffedCell(req.gauge, s.defaultStuffing);
  const nodes = new Map<string, Node>();
  const sdfOf = new Map<string, WorldSdf>();
  const sdf = (p: Part) => {
    let f = sdfOf.get(p.id);
    if (!f) sdfOf.set(p.id, (f = worldSdf(p)));
    return f;
  };
  for (const i of order) {
    const part = parts[i];
    const pi = graph.parent[i];
    const parent = pi === null ? undefined : parts[pi];
    const geom = part.type === 'mesh' || part.type === 'flat' ? null : pieceGeom(part, parent, { meshes: req.meshes, ...(parent ? { parentSdf: (p: Vec3) => sdf(parent)(p[0], p[1], p[2]) } : {}) });
    const parentNode = parent ? nodes.get(parent.id) : undefined;
    const plan = planPart(part, {
      ...(parent ? { parent, parentGeom: parentNode?.geom ?? null, parentSdf: sdf(parent) } : {}),
      wS: defaultCell.wS,
      colorOf: (id) => paletteHex.get(id),
      ...(model.audience ? { audience: model.audience } : {}),
      eyes: s.eyes,
    });
    let hostId: string | undefined;
    for (let at = pi; at !== null; at = graph.parent[at]) {
      const n = nodes.get(parts[at].id);
      if (n && (n.plan.make === 'piece' || n.plan.make === 'applique')) {
        hostId = n.part.id;
        break;
      }
    }
    nodes.set(part.id, { part, index: i, ...(parent ? { parent } : {}), depth: depth.get(i) ?? 0, geom, plan, ...(hostId ? { hostId } : {}) });
    if (parent) {
      const gap = surfaceGapWith(part, parent);
      if (gap > GAP_WARN_IN) issues.push(Object.freeze({ code: 'W_GAP', severity: 'warn', message: `${part.id} is ${gap.toFixed(2)} in from ${parent.id}; it will not touch it when sewn on`, where: { part: part.id } }));
    }
  }
  const twinOf = new Map<string, string>();
  for (const i of order) {
    const p = parts[i];
    if (!p.mirrorOf) continue;
    const a = byId.get(p.mirrorOf);
    const na = a ? nodes.get(a.id) : undefined;
    const nb = nodes.get(p.id);
    if (!a || !na || !nb || twinOf.has(a.id) || na.plan.make !== nb.plan.make) continue;
    if (isMirrored(a, p)) twinOf.set(p.id, a.id);
  }
  return { graph, order, nodes, twinOf, byId, sdf, issues };
}

export interface PieceSetup {
  trim?: TrimResult;
  /** The piece ends open: trimmed, or an untrimmed piece with `attach.openEnd`. */
  open: boolean;
  cup: boolean;
  stuffing: Stuffing;
}

/**
 * Trim (§2.10.3, walked at the stitch of the part's own or the default stuffing — the stuffing itself depends on
 * the trim) and the stuffing (§2.10.1) of a crocheted piece.
 */
export function pieceSetup(part: Part, node: Node, s: AmiSettings, gauge: ResolvedGauge, sdf: (p: Part) => WorldSdf): PieceSetup {
  const make = node.plan.make;
  const root = node.parent === undefined;
  const walkCell = stuffedCell(gauge, part.stuffing ?? s.defaultStuffing);
  let trim: TrimResult | undefined;
  if (!root && node.geom && node.parent && make === 'piece') trim = trimWalk(node.geom, sdf(node.parent), walkCell.hS);
  const openFar = part.attach?.openEnd === 'top' || part.attach?.openEnd === 'bottom';
  let cup = false;
  const g = node.geom;
  if (g && trim?.sCut !== undefined) {
    const q = profilePoint(g.profile, trim.sCut);
    const a = g.sideExtra > 0 ? q.r + g.sideExtra : q.r * g.ratio;
    cup = isCup(trim.sCut, ellipsePerimeter(a, q.r) / Math.PI);
  }
  const stuffing = make === 'applique' || part.type === 'flat' ? 'none' : stuffingOf(part, { make, root, flatness: node.plan.flatness, cup, defaultStuffing: s.defaultStuffing });
  return { ...(trim ? { trim } : {}), open: trim?.sCut !== undefined || openFar || make === 'applique' || part.type === 'flat', cup, stuffing };
}

/** One row of the plan (§2.10.1 teddy table columns), for tests and the editor. */
export interface PlanRow {
  id: string;
  parent?: string;
  make: MakeAs;
  rule: PartPlan['rule'];
  flatness: number;
  eyeMm?: number;
  axis?: 'X' | 'Y' | 'Z';
  axisRule?: PieceGeom['axisRule'];
  start?: PieceGeom['start'];
  startRule?: PieceGeom['startRule'];
  /** Buried share of the profile (§2.10.3), crocheted pieces other than the root. */
  buried?: number;
  end?: 'open' | 'closed';
  stuffing?: Stuffing;
  /** A "make 2" copy of this part. */
  twinOf?: string;
}

/** The plan of every part, in model order. `null` unless the attach graph is one tree. */
export function planReport(req: Pick<AmiRequest, 'model' | 'gauge' | 'settings' | 'meshes'>): PlanRow[] | null {
  const st = planStage(req);
  if (!st) return null;
  return req.model.parts.map((part) => {
    const n = st.nodes.get(part.id) as Node;
    const crocheted = n.plan.make === 'piece' || n.plan.make === 'applique';
    const setup = crocheted ? pieceSetup(part, n, req.settings, req.gauge, st.sdf) : undefined;
    return {
      id: part.id,
      ...(n.parent ? { parent: n.parent.id } : {}),
      make: n.plan.make,
      rule: n.plan.rule,
      flatness: n.plan.flatness,
      ...(n.plan.eyeMm !== undefined ? { eyeMm: n.plan.eyeMm } : {}),
      ...(crocheted && n.geom && n.plan.make === 'piece' ? { axis: n.geom.axis.toUpperCase() as 'X' | 'Y' | 'Z', axisRule: n.geom.axisRule, start: n.geom.start, startRule: n.geom.startRule } : {}),
      ...(setup?.trim ? { buried: setup.trim.buried } : {}),
      ...(setup ? { end: setup.open ? ('open' as const) : ('closed' as const), stuffing: setup.stuffing } : {}),
      ...(st.twinOf.has(part.id) ? { twinOf: st.twinOf.get(part.id) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The engine

/** §5.2.1: the whole amigurumi pattern of a model. */
export const generateAmigurumi: GenerateAmigurumiFn = async (req: AmiRequest, deps: Deps = {}): Promise<AmiResult> => {
  const gate = async () => {
    if (deps.gate) await deps.gate.check(req.jobId);
  };
  const s = req.settings;
  const model = req.model;
  const gauge = req.gauge;
  const issues: Issue[] = [];
  const stage = planStage(req);
  if (!stage) {
    const issue: Issue = Object.freeze({ code: 'E_ASSEMBLY', severity: 'error', message: 'the parts are not attached as one tree; re-infer the attachments' });
    return emptyResult(req, [issue]);
  }
  const { graph, order, nodes, twinOf, byId, sdf } = stage;
  const parts = model.parts;
  issues.push(...stage.issues);
  await gate();

  // ---- palette codes, in order of use
  const codes = new Map<string, string>();
  const code = (paletteId: string) => {
    let c = codes.get(paletteId);
    if (!c) codes.set(paletteId, (c = codeLetter(codes.size)));
    return c;
  };

  // ---- pieces: trim, stuffing, counts, placement
  const works = new Map<string, Work>();
  for (const i of order) {
    const part = parts[i];
    const node = nodes.get(part.id) as Node;
    const make = node.plan.make;
    if (make !== 'piece' && make !== 'applique') continue;
    const primaryId = twinOf.get(part.id);
    const primary = primaryId ? works.get(primaryId) : undefined;
    const style = part.crochet?.style ?? s.style;
    const setup = pieceSetup(part, node, s, gauge, sdf);
    const trim = setup.trim;
    if (primary) {
      // the mirrored copy: the same piece; its own frame and trim for the placements on and of it
      const own = node.geom ? (trim?.sCut !== undefined ? trimProfile(node.geom.profile, trim.sCut) : node.geom.profile) : primary.profile;
      works.set(part.id, { ...primary, node, twinOf: primary.node.part.id, ...(trim ? { trim } : {}), profile: own });
      primary.twin = part.id;
      continue;
    }
    let kind: Work['kind'] = 'revolved';
    let stuffing: Stuffing;
    let counts: PieceCounts | null = null;
    let profile: Profile | null = null;
    let shape: FlatShape | undefined;
    let path: 'A' | 'B' = 'A';
    const openFar = part.attach?.openEnd === 'top' || part.attach?.openEnd === 'bottom';
    if (make === 'applique') {
      kind = 'applique';
      stuffing = 'none';
      shape = appliqueShape(part, node.plan.extents, { w: gauge.cell.w, h: gauge.cell.h });
      counts = shape.counts;
    } else if (part.type === 'flat') {
      kind = 'tube';
      stuffing = 'none';
      const tip = tubeTip(part, node.parent, node.parent ? sdf(node.parent) : undefined);
      shape = flattenedTube(part, tip, { w: gauge.cell.w, h: gauge.cell.h });
      counts = shape.counts;
    } else if (part.type === 'mesh') {
      kind = 'mesh';
      path = 'B';
      stuffing = setup.stuffing;
      counts = await meshCounts(part, node, req, deps, issues);
      await gate();
      if (!counts) continue;
    } else {
      if (part.type === 'torus' && (part.dims.arcDeg ?? 360) >= 360) kind = 'torus';
      const g = node.geom;
      stuffing = setup.stuffing;
      const cell = stuffedCell(gauge, stuffing);
      counts = roundsForPart(part, {
        wS: cell.wS,
        hS: cell.hS,
        style,
        ...(g ? { axis: g.axis, start: g.start } : {}),
        ...(trim?.sCut !== undefined ? { trimAt: trim.sCut } : {}),
        ...(openFar ? { openFar: true } : {}),
      });
      if (!counts) continue;
      if (g) profile = trim?.sCut !== undefined ? trimProfile(g.profile, trim.sCut) : g.profile;
    }
    const cell = stuffedCell(gauge, stuffing);
    const open = counts.finish === 'open';
    const unfolded = shape?.rows ? shape.rows.map((r) => ({ ...r })) : placePiece({ counts: counts.counts, circ: counts.circ, ovalS: counts.ovalS, loops: counts.loops, start: counts.start }, { spiral: s.spiral });
    works.set(part.id, {
      node,
      kind,
      stuffing,
      cell,
      style,
      ...(trim ? { trim } : {}),
      profile,
      counts,
      ...(shape ? { shape } : {}),
      open,
      unfolded,
      path,
      mainCode: code(part.color),
      rRef: 1,
      alphaSeam: [],
      title: pieceTitle(part),
      eyeRound: 0,
    });
  }
  await gate();

  // ---- start-cap covers: a band in the cover's color on the host (§2.10.1 rule 3)
  for (const i of order) {
    const part = parts[i];
    const node = nodes.get(part.id) as Node;
    if (node.plan.make !== 'region' || !node.parent) continue;
    const host = works.get(node.parent.id);
    if (!host || host.twinOf || host.kind !== 'revolved' || !host.node.geom || !host.profile) continue;
    if (host.band) continue;
    const end = coverEnd(host, sdf(part));
    const rounds = Math.min(host.unfolded.length - 1, Math.round(end / host.counts.hEff));
    if (rounds < 1) continue;
    const bandCode = code(part.color);
    if (bandCode === host.mainCode) continue;
    host.band = { rounds, code: bandCode, partId: part.id };
    applyBand(host, s.spiral);
  }

  // ---- placements: anchors on hosts (rounds first; stitches after the lean is known)
  const eyeGroups: EyeGroup[] = [];
  const embroidery: { node: Node; hostId: string; point: Vec3; color: string; label: string; feature?: Feature }[] = [];
  const hostGeom = (id: string) => {
    const w = works.get(id);
    return w && w.node.geom && w.profile ? { w, g: w.node.geom, p: w.profile } : undefined;
  };
  const spotOn = (hostId: string, partId: string, anchor: Vec3): Spot | undefined => {
    const h = hostGeom(hostId);
    if (!h) return undefined;
    const pr = projectOnto(h.g, anchor, h.p);
    return { partId, c: pr.s / h.w.counts.hEff, alpha: pr.alpha, y: anchor[1], x: anchor[0], hostId };
  };
  // eyes: parts planned as eyes, and eye features
  const eyeParts = order.map((i) => nodes.get(parts[i].id) as Node).filter((n) => (n.plan.make === 'safety_eye' || (n.plan.make === 'embroidery' && n.plan.rule === 1)) && n.hostId);
  for (const n of eyeParts) {
    const host = n.hostId as string;
    const anchor = closestOnSurface(sdf(byId.get(host) as Part), partCenter(n.part));
    addEye(eyeGroups, host, n.part.id, anchor, n.plan.eyeMm ?? 10, n.plan.make === 'embroidery', n.part.color);
  }
  for (const f of model.features ?? []) {
    const hostPart = byId.get(f.on);
    if (!hostPart) continue;
    const hostNode = nodes.get(f.on);
    const host = hostNode && works.has(f.on) ? f.on : hostNode?.hostId;
    if (!host) continue;
    const pts = [surfaceAt(hostPart, f.azimuthDeg, f.elevationDeg), ...(f.mirror ? [surfaceAt(hostPart, -f.azimuthDeg, f.elevationDeg)] : [])];
    if (f.kind === 'safety_eye' || f.kind === 'embroidered_eye') {
      const embroidered = f.kind === 'embroidered_eye' || model.audience === 'under3' || s.eyes === 'embroidered';
      const mm = snapEye(f.sizeMm ?? (f.sizeIn ? f.sizeIn * 25.4 : 10));
      pts.forEach((p, k) => addEye(eyeGroups, host, k === 0 ? f.id : `${f.id}_mirror`, p, mm, embroidered, f.color));
    } else {
      embroidery.push({ node: hostNode as Node, hostId: host, point: pts[0], color: f.color ?? hostPart.color, label: f.kind, feature: f });
    }
  }
  for (const g of eyeGroups) {
    const spot = spotOn(g.hostId, g.ids[0], g.points[0]);
    const w = works.get(g.hostId);
    if (!spot || !w) continue;
    g.c = spot.c;
    g.rA = Math.min(Math.max(1, Math.floor(spot.c)), Math.max(1, w.unfolded.length - 1));
  }
  // children placed on hosts
  const placementOf = new Map<string, { pl: Placement; depth: number; c: number }>();
  for (const i of order) {
    const part = parts[i];
    const node = nodes.get(part.id) as Node;
    const w = works.get(part.id);
    if (node.plan.make === 'embroidery' && node.plan.rule !== 1 && node.hostId) {
      embroidery.push({ node, hostId: node.hostId, point: closestOnSurface(sdf(byId.get(node.hostId) as Part), partCenter(part)), color: part.color, label: pieceTitle(part) });
      continue;
    }
    if (!w || !node.parent || !node.hostId) continue;
    const host = node.hostId;
    const anchor = anchorOf(w, node, sdf(byId.get(host) as Part));
    const spot = spotOn(host, part.id, anchor);
    if (!spot) continue;
    const primaryId = w.twinOf ?? part.id;
    const existing = placementOf.get(primaryId);
    if (existing) {
      existing.pl.spots.push(spot);
      continue;
    }
    const pole = poleOf(spot, works.get(host) as Work, anchor);
    const pl: Placement = {
      kind: w.kind === 'applique' || w.open ? 'open-edge' : 'closed',
      title: w.title,
      titles: pluralTitle(w.title),
      spots: [spot],
      ...(w.kind === 'applique' || w.open ? { openSts: w.counts.counts[w.counts.counts.length - 1] } : {}),
      wS: w.cell.wS,
      stuffing: w.stuffing,
      ...(w.kind === 'applique' ? { flatSewn: true } : {}),
      ...(pole ? { pole } : {}),
      markName: `the ${(w.twin ? pluralTitle(w.title) : w.title).toLowerCase()}`,
    };
    placementOf.set(primaryId, { pl, depth: node.depth, c: spot.c });
  }

  // ---- reference rounds, lean, cues
  for (const w of works.values()) {
    if (w.twinOf) continue;
    const id = w.node.part.id;
    const R = w.unfolded.length;
    const eyes = eyeGroups.filter((g) => g.hostId === id && !g.embroidered && g.rA > 0);
    const feats = [...eyeGroups.filter((g) => g.hostId === id && g.embroidered), ...embroidery.filter((e) => e.hostId === id)].map((e) => ('c' in e ? e.c : (spotOn(id, id, e.point)?.c ?? 0)));
    const places = [...placementOf.values()].filter((x) => x.pl.spots[0].hostId === id).map((x) => x.c);
    const first = (xs: number[]) => (xs.length > 0 ? roundOf(Math.min(...xs), R) : 0);
    let rRef = eyes.length > 0 ? Math.min(...eyes.map((g) => g.rA + 1)) : first(feats) || first(places);
    const hosts = rRef > 0;
    if (!hosts) {
      let widest = 0;
      w.unfolded.forEach((l, k) => {
        if (l.stated > w.unfolded[widest].stated) widest = k;
      });
      rRef = widest + 1;
    }
    w.rRef = Math.min(Math.max(1, rRef), R);
    w.alphaSeam = seamAngles(w.unfolded.map((l) => l.stated), w.rRef, s.leanStPerRnd, s.hand);
    const seamAt: SeamAt = w.node.geom?.seamAt ?? 'back';
    if (hosts && w.unfolded[0]?.kind === 'rnd') addCue(w.unfolded[w.rRef - 1], frontMarkerCue(w.unfolded[w.rRef - 1].stated, w.rRef, seamAt));
    // safety eyes
    for (const g of eyes) {
      const r = Math.min(R, g.rA + 1);
      const n = w.unfolded[r - 1].stated;
      const gaps = g.points.map((p) => {
        const sp = spotOn(id, g.ids[0], p) as Spot;
        return gapAt(sp.alpha, w.alphaSeam[r - 1] ?? 0, n, s.hand);
      });
      addCue(w.unfolded[r - 1], eyeCue({ sizeMm: g.sizeMm, rA: g.rA, gaps, n, count: g.points.length }));
      w.eyeRound = Math.max(w.eyeRound, r);
    }
    // stuffing (closed pieces; open ones are stuffed in their assembly step)
    if (!w.open && w.kind !== 'applique' && w.kind !== 'tube') {
      const at = stuffingRound(w.unfolded, w.stuffing, w.eyeRound);
      if (at !== null) addCue(w.unfolded[at - 1], w.stuffing === 'light' ? stuffLightCue() : stuffFirmCue(at));
    }
  }
  await gate();

  // ---- finishes
  for (const w of works.values()) {
    if (w.twinOf) continue;
    w.finish = finishOf(w, nodes);
  }
  for (const w of works.values()) if (w.twinOf) w.finish = works.get(w.twinOf)?.finish;

  // ---- assembly
  const hostsMap = new Map<string, Host>();
  for (const w of works.values()) {
    const id = w.node.part.id;
    const primary = w.twinOf ? (works.get(w.twinOf) as Work) : w;
    hostsMap.set(id, {
      id,
      title: primary.title,
      seamAt: w.node.geom?.seamAt ?? 'back',
      counts: primary.unfolded.map((l) => l.stated),
      hEff: primary.counts.hEff,
      hS: primary.cell.hS,
      alphaSeam: primary.alphaSeam,
    });
  }
  const ordered: Placement[] = [];
  const byDepth = [...placementOf.values()];
  const hostOrder = (id: string) => nodes.get(id)?.index ?? 0;
  const eyePlacements: { pl: Placement; depth: number; hostId: string }[] = [];
  for (const g of eyeGroups) {
    if (g.embroidered) continue;
    const w = works.get(g.hostId);
    if (!w) continue;
    const spots = g.points.map((p, k) => spotOn(g.hostId, g.ids[k] ?? g.ids[0], p)).filter((x): x is Spot => x !== undefined);
    if (spots.length === 0) continue;
    eyePlacements.push({
      pl: { kind: 'feature-ref', title: spots.length > 1 ? 'Eyes' : 'Eye', titles: 'Eyes', spots, wS: w.cell.wS, afterRnd: g.rA + 1, markName: spots.length > 1 ? 'the eyes' : 'the eye' },
      depth: (nodes.get(g.hostId)?.depth ?? 0) + 1,
      hostId: g.hostId,
    });
  }
  const depths = [...new Set([...byDepth.map((x) => x.depth), ...eyePlacements.map((x) => x.depth)])].sort((a, b) => a - b);
  for (const d of depths) {
    const hostIds = [...new Set([...byDepth.filter((x) => x.depth === d).map((x) => x.pl.spots[0].hostId), ...eyePlacements.filter((x) => x.depth === d).map((x) => x.hostId)])].sort((a, b) => hostOrder(a) - hostOrder(b));
    for (const h of hostIds) {
      for (const e of eyePlacements.filter((x) => x.depth === d && x.hostId === h)) ordered.push(e.pl);
      const kids = byDepth.filter((x) => x.depth === d && x.pl.spots[0].hostId === h).sort((a, b) => a.c - b.c);
      for (const k of kids) ordered.push(k.pl);
    }
  }
  const assembly: AssemblyStep[] = assemblySteps(ordered, hostsMap, s.hand);

  // ---- pieces of the document
  const pieces: Piece[] = [];
  const root = parts[graph.roots[0]];
  for (const i of order.slice().sort((a, b) => a - b)) {
    const w = works.get(parts[i].id);
    if (!w || w.twinOf) continue;
    const lines = w.unfolded[0]?.kind === 'rnd' ? foldRounds(w.unfolded) : w.unfolded;
    const partIds = [w.node.part.id, ...(w.twin ? [w.twin] : [])];
    pieces.push({
      id: w.node.part.id,
      title: w.title,
      makeCount: partIds.length,
      partIds,
      intro: introOf(w, codes, model),
      lines,
      finish: w.finish as PieceFinish,
      stuffing: w.stuffing,
    });
  }
  await gate();

  // ---- validation
  const palette = new Set(codes.values());
  for (const p of pieces) {
    const w = works.get(p.id) as Work;
    issues.push(
      ...validatePiece3d({
        id: p.id,
        lines: p.lines,
        unfolded: w.unfolded,
        finish: w.finish?.kind === 'seamToStart' ? undefined : w.finish?.kind,
        counts: w.counts,
        profile: w.counts.generator === 'pathA' && w.kind === 'revolved' ? w.profile : null,
        ...(w.counts.generator === 'textbook' && (w.node.part.type === 'sphere' || w.node.part.type === 'capsule') ? { textbookR: w.node.part.dims.r } : {}),
        style: w.style,
        ...(w.kind === 'tube' ? { flattened: true } : {}),
        path: w.path,
        ...(w.path === 'B' ? { irregular: true } : {}),
        cell: w.cell,
        palette,
      }),
    );
  }
  issues.push(
    ...validateAssembly({
      pieces,
      steps: assembly,
      rootId: root.id,
      rounds: (id) => works.get(id)?.unfolded.map((l) => l.stated),
      oneTree: true,
    }),
  );

  // ---- materials, notions, notes, finishing
  const doc = buildDoc({ req, pieces, works, assembly, codes, eyeGroups, embroidery, issues });
  const plan: Record<string, MakeAs> = {};
  for (const n of nodes.values()) plan[n.part.id] = n.plan.make;
  const frames: Record<string, PieceFrame> = {};
  const rounds: Record<string, RoundsResult> = {};
  for (const w of works.values()) {
    const id = w.node.part.id;
    const g = w.node.geom;
    const primary = w.twinOf ? (works.get(w.twinOf) as Work) : w;
    if (g) {
      frames[id] = {
        axis: g.axisW,
        startPole: g.start,
        seamDir: g.seam,
        ...(primary.counts.ovalS ? { oval: { S1: primary.counts.ovalS[0] } } : {}),
        ...(w.trim?.sCut !== undefined ? { trimmedAt: w.trim.sCut } : {}),
      };
    }
    rounds[id] = roundsResult(w, primary, model);
  }
  return { jobId: req.jobId, plan, frames, rounds, ghosts: {}, pattern: doc, issues: doc.issues, hash: doc.hash };
};

// ---------------------------------------------------------------------------------------------------------------
// Pieces of the engine

function snapEye(mm: number): number {
  const sizes = [6, 8, 9, 10, 12, 15];
  let best = sizes[0];
  for (const x of sizes) if (Math.abs(x - mm) <= Math.abs(best - mm) + 1e-9) best = x;
  return best;
}

function addEye(groups: EyeGroup[], hostId: string, id: string, p: Vec3, sizeMm: number, embroidered: boolean, color?: string): void {
  // a pair: same host, same size, and level (they share a round once projected; grouped by height here)
  const g = groups.find((x) => x.hostId === hostId && x.sizeMm === sizeMm && x.embroidered === embroidered && Math.abs(x.points[0][1] - p[1]) < 0.25);
  if (g) {
    g.points.push(p);
    g.ids.push(id);
    return;
  }
  groups.push({ hostId, points: [p], ids: [id], sizeMm, embroidered, ...(color ? { color } : {}), c: 0, rA: 0 });
}

/** The local-Y end of a flat part away from its attachment (the lower parent SDF); `top` without a parent. */
function tubeTip(part: Extract<Part, { type: 'flat' }>, parent: Part | undefined, f: WorldSdf | undefined): 'top' | 'bottom' {
  if (!parent || !f) return 'top';
  const hi = localToWorld(part, [0, part.dims.h / 2, 0]);
  const lo = localToWorld(part, [0, -part.dims.h / 2, 0]);
  return f(hi[0], hi[1], hi[2]) <= f(lo[0], lo[1], lo[2]) ? 'top' : 'bottom';
}

/** Path B through the private mesh.worker (task T4-5: the part's seed, and the attachment boundary). */
async function meshCounts(part: Part, node: Node, req: AmiRequest, deps: Deps, issues: Issue[]): Promise<PieceCounts | null> {
  if (part.type !== 'mesh') return null;
  const mesh = req.meshes[part.dims.meshRef];
  if (!deps.pathB || !mesh) {
    issues.push(Object.freeze({ code: 'E_SANITY', severity: 'error', message: `${part.id}: a mesh part needs its mesh and the Path B worker`, where: { part: part.id } }));
    return null;
  }
  const r = await deps.pathB({
    jobId: req.jobId,
    mesh,
    partId: part.id,
    frame: {},
    gauge: req.gauge,
    settings: req.settings,
    ...(part.crochet?.seed ? { seed: part.crochet.seed } : {}),
    ...(node.parent ? { attach: attachBoundary(part, mesh, node.parent) } : {}),
  });
  if ('needsSplit' in r) {
    issues.push(Object.freeze({ code: 'E_SANITY', severity: 'error', message: `${part.id}: the mesh splits into ${r.needsSplit.loops.length} loops at level ${r.needsSplit.level}; cut it into parts first`, where: { part: part.id } }));
    return null;
  }
  return {
    generator: 'pathA',
    counts: r.counts.slice(),
    circ: r.ovalS ? r.counts.map((c, k) => c - 2 * (r.ovalS as number[])[k]) : r.counts.slice(),
    ...(r.ovalS ? { ovalS: r.ovalS.slice() } : {}),
    ideal: [],
    raw: r.counts.slice(),
    sk: r.counts.map((_, k) => (k + 1) * r.hEff),
    loops: r.loops.slice(),
    N: r.counts.length,
    hEff: r.hEff,
    L: r.counts.length * r.hEff,
    start: r.start,
    closedEnd: r.closedEnd,
    finish: r.finish === 'open' ? 'open' : r.finish === 'flattenSc' ? 'flattenSc' : r.finish === 'seamToStart' ? 'seamToStart' : 'gather',
    symmetric: false,
    dropped: 0,
    appended: 0,
  };
}

/**
 * The attachment boundary of a mesh part, part-local (task T4-5): its vertices that lie in or on the parent
 * (within 2% of its size), evenly thinned to at most 256 points; the 1% nearest the parent when none touch it.
 */
export function attachBoundary(part: Extract<Part, { type: 'mesh' }>, mesh: ColoredMesh, parent: Part): Vec3[] {
  const f = worldSdf(parent);
  const pos = mesh.positions;
  const tol = 0.02 * Math.max(...part.dims.bboxIn);
  const all: { p: Vec3; d: number }[] = [];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const local: Vec3 = [pos[i], pos[i + 1], pos[i + 2]];
    const w = localToWorld(part, local);
    all.push({ p: local, d: f(w[0], w[1], w[2]) });
  }
  let pick = all.filter((x) => x.d >= -tol);
  if (pick.length === 0) pick = all.slice().sort((a, b) => b.d - a.d).slice(0, Math.max(1, Math.ceil(all.length / 100)));
  const step = Math.max(1, Math.ceil(pick.length / 256));
  return pick.filter((_, k) => k % step === 0).map((x) => x.p);
}

/** How far a host's start-cap cover reaches along the host (§2.10.1 rule 3 band, sampled as in §2.10.3). */
function coverEnd(host: Work, cover: WorldSdf): number {
  const g = host.node.geom as PieceGeom;
  const p = host.profile as Profile;
  const step = host.cell.hS / 4;
  let end = 0;
  for (let s = 0; s <= p.L + 1e-9; s += step) {
    let inside = 0;
    for (let j = 0; j < 16; j++) {
      const q = surfacePoint(g, s, (2 * Math.PI * j) / 16, p);
      if (cover(q[0], q[1], q[2]) > 0) inside++;
    }
    if (inside < 8) break;
    end = s;
  }
  // the ring at s = 0 is the start pole itself; a cover that reaches past it covers at least round 1
  return end;
}

/** Rounds 1 … band in the cover's color, the rest in the main color; the change is announced on the round before. */
function applyBand(w: Work, spiral: boolean): void {
  const band = w.band;
  if (!band) return;
  w.unfolded.forEach((l, k) => {
    l.colorHeader = k < band.rounds ? band.code : w.mainCode;
  });
  const before = w.unfolded[band.rounds - 1];
  addCue(before, { kind: 'color', text: `change to ${w.mainCode} on the last yo` });
  const at = (w.node.geom?.seamAt ?? 'back') === 'back' ? 'at center back' : 'underneath, at the marker';
  if (spiral) addCue(before, { kind: 'note', text: `A small jog shows ${at} where Rnd ${band.rounds + 1} begins.` });
}

/** §2.12 item 1: a trimmed child — its open edge's centroid; a closed child — the midpoint of the closest points. */
function anchorOf(w: Work, node: Node, hostSdf: WorldSdf): Vec3 {
  const g = node.geom;
  const part = node.part;
  if (w.kind === 'applique' || w.kind === 'tube' || !g) return closestOnSurface(hostSdf, partCenter(part));
  if (w.open) {
    const sEdge = w.trim?.sCut ?? g.profile.L;
    let c: Vec3 = [0, 0, 0];
    const n = 32;
    for (let j = 0; j < n; j++) c = add(c, surfacePoint(g, sEdge, (2 * Math.PI * j) / n, g.profile));
    return scale(c, 1 / n);
  }
  // closed: the child's surface point deepest in (or nearest to) the host, and the host surface point nearest it
  let best: Vec3 = axisPoint(g, 0);
  let bestD = -Infinity;
  const L = g.profile.L;
  for (let i = 0; i <= 48; i++) {
    for (let j = 0; j < 24; j++) {
      const q = surfacePoint(g, (L * i) / 48, (2 * Math.PI * j) / 24);
      const d = hostSdf(q[0], q[1], q[2]);
      if (d > bestD) {
        bestD = d;
        best = q;
      }
    }
  }
  const onHost = closestOnSurface(hostSdf, best);
  return scale(add(best, onHost), 0.5);
}

/** A child at a pole of its host (within 1.5 rounds of an end and near the axis): "centered on the top of the Body". */
function poleOf(spot: Spot, host: Work, anchor: Vec3): Placement['pole'] | undefined {
  const g = host.node.geom;
  const p = host.profile;
  if (!g || !p) return undefined;
  const R = host.unfolded.length;
  const atStart = spot.c <= 1.5;
  const atEnd = spot.c >= R - 0.5 && host.counts.closedEnd;
  if (!atStart && !atEnd) return undefined;
  const pr = projectOnto(g, anchor, p);
  if (pr.rho > 0.35 * Math.max(p.rMax, 1e-9) * (g.ratio || 1)) return undefined;
  const dir = atStart ? scale(g.d, -1) : g.d;
  const ax = [Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])];
  const where = ax[1] >= ax[0] && ax[1] >= ax[2] ? (dir[1] > 0 ? 'top' : 'bottom') : ax[2] >= ax[0] ? (dir[2] > 0 ? 'front' : 'back') : atStart ? 'tip' : 'end';
  return { where, host: host.title };
}

/** The finish of a piece and its tail (§2.10.6). */
function finishOf(w: Work, nodes: Map<string, Node>): PieceFinish {
  const c = w.counts;
  const last = c.counts[c.counts.length - 1];
  const node = w.node;
  const sewn = node.parent !== undefined && (node.part.attach?.method ?? 'sewn') === 'sewn';
  void nodes;
  if (w.kind === 'applique' || w.kind === 'tube') {
    const f = pieceFinish({ kind: 'open', openSts: last, wS: w.cell.wS });
    return w.kind === 'tube' ? { ...f, text: `Do not stuff; press the piece flat. ${f.text}` } : f;
  }
  if (c.finish === 'open') return pieceFinish({ kind: 'open', openSts: last, wS: w.cell.wS });
  if (c.finish === 'seamToStart') {
    const t = sewingTail(last * w.cell.wS);
    return { kind: 'seamToStart', tailIn: t.in, sewTailIn: t.in, text: `Fasten off, leaving a ${t.in}" (${t.cm} cm) tail; sew the last round to the first.` };
  }
  const seam = sewn ? closedSeamIn(w.trim?.contactWidth ?? 0, w.cell.wS) : undefined;
  if (c.finish === 'flattenSc') {
    const S = (c.ovalS ?? [])[c.ovalS ? c.ovalS.length - 1 : 0] ?? 2;
    const f = pieceFinish({ kind: 'flattenSc', S, wS: w.cell.wS });
    if (seam === undefined) return f;
    const t = sewingTail(seam);
    return { ...f, tailIn: GATHER_TAIL_IN + t.in, sewTailIn: t.in, text: f.text.replace(/Fasten off\.$/, `Fasten off, leaving a ${t.in}" (${t.cm} cm) tail to sew the piece on.`) };
  }
  return pieceFinish({ kind: 'gather', wS: w.cell.wS, ...(seam !== undefined ? { sewnSeamIn: seam } : {}) });
}

function introOf(w: Work, codes: Map<string, string>, model: CrochetModelV1): string[] {
  const out: string[] = [];
  const name = (id: string) => colorName(model, id);
  const colorById = new Map([...codes].map(([id, c]) => [c, id]));
  if (w.band) out.push(`Start with ${w.band.code} (${name(colorById.get(w.band.code) ?? '')}); change to ${w.mainCode} (${name(w.node.part.color)}) where stated.`);
  else out.push(`With ${w.mainCode} (${name(w.node.part.color)}).`);
  if (w.twin) out.push('Make 2.');
  if (w.kind === 'applique') out.push(w.shape?.approximated ? 'Appliqué, worked flat in one layer; the outline is approximated by an oval.' : 'Appliqué, worked flat in one layer.');
  else if (w.kind === 'tube') out.push('Worked from the tip to the base and pressed flat.');
  else if (w.node.geom && w.node.parent) {
    const from = startWords(w);
    if (from) out.push(`Worked from ${from}.`);
  }
  if (w.open && w.kind === 'revolved') out.push('The piece ends open; it is sewn on by its open edge.');
  return out;
}

/** "the hand", "the foot", "the top", "its tip". */
function startWords(w: Work): string | undefined {
  const g = w.node.geom;
  if (!g) return undefined;
  const id = w.node.part.id;
  if (g.startRule === 'limb') return /^arm/.test(id) ? 'the hand' : /^leg/.test(id) ? 'the foot' : 'the tip';
  const dir = scale(g.d, -1);
  const a = [Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])];
  if (a[1] >= a[0] && a[1] >= a[2]) return dir[1] > 0 ? 'the top' : 'the bottom';
  if (a[2] >= a[0]) return dir[2] > 0 ? 'the front tip' : 'the back';
  return 'the tip';
}

/** RoundsResult of a piece: counts, loops and simple rings (center, normal, radius) along its worked profile. */
function roundsResult(w: Work, primary: Work, model: CrochetModelV1): RoundsResult {
  const c = primary.counts;
  const g = w.node.geom;
  const rings: RingGeom[] = [];
  if (g && w.kind === 'revolved') {
    const p = w.trim?.sCut !== undefined ? trimProfile(g.profile, w.trim.sCut) : g.profile;
    c.counts.forEach((_, k) => {
      const sK = Math.min(p.L, (k + 1) * c.hEff);
      const q = profilePoint(p, sK);
      rings.push({ center: add(g.origin, scale(g.d, q.z)), normal: g.d, radius: q.r });
    });
  }
  const palIndex = (codeOrId: string) => Math.max(0, model.palette.findIndex((x) => x.id === codeOrId));
  const mainIdx = palIndex(w.node.part.color);
  const bandIdx = primary.band ? palIndex(model.parts.find((p) => p.id === primary.band?.partId)?.color ?? '') : mainIdx;
  const stitchLabels = c.counts.map((n, k) => new Uint8Array(n).fill(primary.band && k < primary.band.rounds ? bandIdx : mainIdx));
  return {
    partId: w.node.part.id,
    path: primary.path,
    counts: c.counts.slice(),
    loops: c.loops.slice(),
    hEff: c.hEff,
    closedEnd: c.closedEnd,
    start: c.start,
    finish: primary.finish?.kind ?? (c.finish === 'flattenSc' ? 'flattenSc' : c.finish),
    ...(c.ovalS ? { ovalS: c.ovalS.slice() } : {}),
    rings,
    stitchLabels,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The document

interface DocInput {
  req: AmiRequest;
  pieces: Piece[];
  works: Map<string, Work>;
  assembly: AssemblyStep[];
  codes: Map<string, string>;
  eyeGroups: EyeGroup[];
  embroidery: { node: Node; hostId: string; point: Vec3; color: string; label: string; feature?: Feature }[];
  issues: Issue[];
}

function buildDoc(i: DocInput): PatternDoc {
  const { req, pieces, works, codes } = i;
  const s: AmiSettings = req.settings;
  const model = req.model;
  const gauge: ResolvedGauge = req.gauge;
  const lAmi = gauge.lscIn;
  // yarn per color
  const perColor = new Map<string, ColorYarn>();
  const addYarn = (code: string, y: ColorYarn) => {
    const v = perColor.get(code) ?? { inches: 0, stitches: 0 };
    v.inches += y.inches;
    v.stitches += y.stitches;
    perColor.set(code, v);
  };
  for (const p of pieces) {
    const w = works.get(p.id) as Work;
    const f = p.finish;
    const finishTail = f.kind === 'open' || f.kind === 'seamToStart' ? (f.sewTailIn ?? f.tailIn) : f.tailIn;
    for (const [c, y] of pieceYarn({ lines: p.lines, mainCode: w.mainCode, makeCount: p.makeCount, finishTailIn: finishTail }, lAmi)) addYarn(c, y);
  }
  // embroidery yarn: noses, mouths, embroidered eyes
  const embroideryCodes = new Map<string, { eyePairs: number; features: number }>();
  const bump = (paletteId: string, k: 'eyePairs' | 'features') => {
    const c = codes.get(paletteId) ?? codeFor(codes, paletteId);
    const v = embroideryCodes.get(c) ?? { eyePairs: 0, features: 0 };
    v[k]++;
    embroideryCodes.set(c, v);
  };
  for (const e of i.embroidery) bump(e.color, 'features');
  for (const g of i.eyeGroups) if (g.embroidered) bump(g.color ?? model.palette[0].id, 'eyePairs');
  for (const [c, v] of embroideryCodes) addYarn(c, { inches: embroideryIn(v), stitches: 0 });

  const idOfCode = new Map([...codes].map(([id, c]) => [c, id]));
  const totalSts = [...perColor.values()].reduce((a, v) => a + v.stitches, 0);
  const materials: MaterialsLine[] = [...perColor]
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
    .map(([c, y]) => {
      const pid = idOfCode.get(c) as string;
      const pc = model.palette.find((x) => x.id === pid);
      const hex = pc?.hex ?? '#808080';
      const band = amiYards(y.inches, gauge);
      const match = isImplemented(nearestYarn) ? nearestYarn(hex, [REFERENCE_LINE_ID]) : null;
      return {
        code: c,
        hex,
        name: colorName(model, pid),
        ...(match ? { yarn: match.yarn, deltaE00: roundHalfUp(match.deltaE00 * 10) / 10 } : {}),
        stitches: y.stitches,
        strands: 1,
        yards: roundHalfUp(band.yards * 10) / 10,
        yardsLow: roundHalfUp(band.yardsLow * 10) / 10,
        yardsHigh: roundHalfUp(band.yardsHigh * 10) / 10,
        meters: roundHalfUp(yardsToMeters(band.yards) * 10) / 10,
        ...(match?.yarn.skeinYards ? { skeins: skeinsToBuy(band.yardsHigh, match.yarn.skeinYards) } : {}),
        ...(match?.yarn.ydPer100g ? { grams: roundHalfUp(gramsFor(band.yards, match.yarn.ydPer100g)) } : {}),
      };
    });
  void totalSts;

  // notions
  const notions = ['Tapestry needle', 'Stitch markers (2)'];
  if (pieces.some((p) => p.stuffing && p.stuffing !== 'none')) notions.push('Fiberfill stuffing');
  const eyeSizes = new Map<number, number>();
  for (const g of i.eyeGroups) if (!g.embroidered) eyeSizes.set(g.sizeMm, (eyeSizes.get(g.sizeMm) ?? 0) + g.points.length * (works.get(g.hostId)?.twin ? 2 : 1));
  for (const [mm, n] of [...eyeSizes].sort((a, b) => a[0] - b[0])) notions.push(`${n} × ${mm} mm safety ${n === 1 ? 'eye' : 'eyes'} with washers`);
  if (i.assembly.length > 0) notions.push('Pins');

  // finishing: embroidery, then ends
  const finishing: string[] = [];
  for (const e of i.embroidery) finishing.push(embroideryText(e, works, codes, model));
  for (const g of i.eyeGroups) {
    if (!g.embroidered) continue;
    const w = works.get(g.hostId);
    if (!w) continue;
    finishing.push(`Eyes: with ${codes.get(g.color ?? '') ?? codeFor(codes, g.color ?? '')}, embroider ${g.points.length > 1 ? 'the eyes' : 'the eye'} on the ${w.title} between Rnds ${g.rA} and ${g.rA + 1} (embroidered eyes are safe for children under 3).`);
  }
  finishing.push('Weave in all ends inside the pieces.');

  // finished size: the model's bounding box (the toy ghost size comes with the ghosts, T4.4)
  const b = modelBounds(model, req.meshes);
  const size = { wIn: roundHalfUp((b.max[0] - b.min[0]) * 4) / 4, hIn: roundHalfUp((b.max[1] - b.min[1]) * 4) / 4, dIn: roundHalfUp((b.max[2] - b.min[2]) * 4) / 4, tolPct: roundHalfUp(gauge.tol * 100) };

  const allLines = pieces.flatMap((p) => p.lines);
  const roundsCount = allLines.filter((l) => l.kind === 'rnd').reduce((a, l) => a + (l.nEnd && l.nEnd > l.n ? l.nEnd - l.n + 1 : 1), 0);
  const colorChanges = allLines.reduce((a, l) => a + (l.cues ?? []).filter((c) => c.kind === 'color').length, 0);
  const colorsUsed = new Set(pieces.flatMap((p) => p.lines.flatMap((l) => [l.colorHeader, ...l.ops.map((o) => o.color)].filter((x): x is string => x !== undefined)))).size || 1;
  const skill = computeSkill({
    colors: Math.max(colorsUsed, new Set(pieces.map((p) => works.get(p.id)?.mainCode)).size),
    meanChangesPerLine: roundsCount > 0 ? colorChanges / roundsCount : 0,
    technique: 'amigurumi_sc',
    pieces: pieces.reduce((a, p) => a + p.makeCount, 0),
    irregularShaping: pieces.some((p) => works.get(p.id)?.counts.ovalS !== undefined || works.get(p.id)?.path === 'B'),
    bloFlo: allLines.some((l) => l.ops.some((o) => o.k !== 'tile' && (o.loop === 'BLO' || o.loop === 'FLO'))),
  });
  const notes = notesFor('amigurumi', { terms: s.terms, hand: s.hand, joinedRounds: false, leanStPerRnd: s.leanStPerRnd });
  const gaugeD = (36 * gauge.cell.w) / Math.PI;
  const gaugeText = `Rnds 1–6 = ${fmtIn(gaugeD)}" (${fmtCm(gaugeD)} cm) across, worked flat (6 sc in MR, +6 sts a round)`;
  const us = hookUsLabel(gauge.hookMm);
  const docNoHash: Omit<PatternDoc, 'hash'> = {
    kind: '3d',
    title: model.name,
    terms: s.terms,
    hand: s.hand,
    dialect: s.dialect,
    skill,
    finishedSize: size,
    gaugeText,
    hook: us === undefined ? { mm: gauge.hookMm } : { mm: gauge.hookMm, us },
    materials,
    notions,
    notes,
    abbreviations: abbreviationsFor(allLines, s.terms, s.decMethod),
    specialStitches: specialStitchesFor(allLines, s.terms, s.decMethod),
    pieces,
    assembly: i.assembly,
    finishing,
    issues: i.issues.map((x) => Object.freeze({ ...x })),
  };
  return { ...docNoHash, hash: hashDoc(docNoHash) };
}

/** A palette color's name as a maker reads it ("caramel_yarn" → "caramel yarn"). */
function colorName(model: CrochetModelV1, id: string): string {
  const raw = model.palette.find((p) => p.id === id)?.name ?? id;
  return raw.replace(/_/g, ' ').trim();
}

function codeFor(codes: Map<string, string>, paletteId: string): string {
  let c = codes.get(paletteId);
  if (!c) codes.set(paletteId, (c = codeLetter(codes.size)));
  return c;
}

function embroideryText(e: DocInput['embroidery'][number], works: Map<string, Work>, codes: Map<string, string>, model: CrochetModelV1): string {
  const w = works.get(e.hostId);
  const c = codes.get(e.color) ?? codeFor(codes, e.color);
  const name = colorName(model, e.color);
  const label = e.feature ? e.feature.kind[0].toUpperCase() + e.feature.kind.slice(1) : e.label;
  if (!w || !w.node.geom || !w.profile) return `${label}: with ${c} (${name}), embroider the ${label.toLowerCase()} as shown.`;
  const pr = projectOnto(w.node.geom, e.point, w.profile);
  const R = w.unfolded.length;
  const r = roundOf(pr.s / w.counts.hEff, R);
  const what = label.toLowerCase();
  if (r <= 2) return `${label}: with ${c} (${name}), embroider the ${what} over Rnds 1–${Math.min(R, 3)} of the ${w.title}, centered on its tip.`;
  const n = w.unfolded[r - 1].stated;
  const st = 1 + Math.floor(((((w.alphaSeam[r - 1] ?? 0) - pr.alpha) / (2 * Math.PI) % 1) + 1) % 1 * n + 1e-9);
  return `${label}: with ${c} (${name}), embroider the ${what} on the ${w.title} around Rnd ${r}, st ${Math.min(n, st)} (counting from ${markerWords(w.node.geom.seamAt)}).`;
}

/** FNV-1a 64 over the code version and the document (non-integer numbers to 6 decimals, §5.8). */
function hashDoc(doc: Omit<PatternDoc, 'hash'>): string {
  const stable = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(6);
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = stable(x);
      return o;
    }
    return v;
  };
  return createFnv1a64().update(CODE_VERSION).update('\u0000ami\u0000').update(canonicalJson(stable(doc))).hex();
}

function emptyResult(req: AmiRequest, issues: Issue[]): AmiResult {
  const s = req.settings;
  const docNoHash: Omit<PatternDoc, 'hash'> = {
    kind: '3d',
    title: req.model.name,
    terms: s.terms,
    hand: s.hand,
    dialect: s.dialect,
    skill: computeSkill({ colors: 0, meanChangesPerLine: 0, technique: 'amigurumi_sc' }),
    finishedSize: { wIn: 0, hIn: 0, tolPct: roundHalfUp(req.gauge.tol * 100) },
    gaugeText: '',
    hook: { mm: req.gauge.hookMm },
    materials: [],
    notions: [],
    notes: [],
    abbreviations: [],
    specialStitches: [],
    pieces: [],
    assembly: [],
    finishing: [],
    issues,
  };
  const hash = hashDoc(docNoHash);
  return { jobId: req.jobId, plan: {}, frames: {}, rounds: {}, ghosts: {}, pattern: { ...docNoHash, hash }, issues, hash };
}
