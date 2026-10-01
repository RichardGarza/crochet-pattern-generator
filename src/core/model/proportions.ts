// The proportions kernel (DESIGN.md §4.2). Step 0, pure; used by the editor's Proportions panel (T6) and the
// Q&A's `q_style` / `q_parts` controls (T7), so both agree.
//
// `readProportions` reports the current head : body ratio and limb length chip, and why a control is disabled.
// `applyProportions` changes them. Both edits end by uniformly rescaling the whole model about its ground
// center (`scaleModel`), so the model's bounding-box height — the finished height — is unchanged.
//
//   head : body = 1 : b   ⇔   headHeight / modelHeight = 1 / (1 + b)      (1:1 ⇒ 50%, 1:3 ⇒ 25%)
//   limb length chip      ⇔   limb length / modelHeight = factor × LIMB_TEMPLATE   (0.6 · 1 · 1.5 · 2.2)
//
// `headHeight` is the head part's own bounding-box height and `modelHeight` the whole model's (ears and limbs
// included).
import type { ApplyProportionsFn, LimbLength, LimbTemplate, ReadProportionsFn } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import { mulMat3Vec, normalize } from '../kernel/vec';
import { attachGraph, subtreeIds } from './attach';
import { anchorPoint, captureAnchor, overlapAlongRay, placeChildOnSurfaceWith, reanchorChildren, type SurfaceSources } from './place';
import { scaleMesh, scaleModel, scalePartDims } from './scale';
import { worldSdf } from './sdf';
import { eulerXYZToMat3, localCenter, modelBounds, modelHeight, partAxis, partCenter, roundCoord, roundVec3, worldBounds } from './transforms';

export type { LimbLength, LimbTemplate, ProportionsReading } from '../../types/entryPoints';

/**
 * Template limb lengths as fractions of the model height (§4.2, shared with the seed templates of §3.3).
 * `quadruped-standing` "arms" are its front legs.
 */
export const LIMB_TEMPLATE: LimbTemplate = {
  quadruped: { arm: 0.25, leg: 0.2 },
  'quadruped-standing': { arm: 0.3, leg: 0.3 },
  biped: { arm: 0.3, leg: 0.3 },
  creature: { arm: 0.15, leg: 0.15 },
};

/** The limb length chips: factors of the template length. */
export const LIMB_FACTORS: Readonly<Record<LimbLength, number>> = { nubs: 0.6, short: 1, medium: 1.5, long: 2.2 };

const LIMB_CHIPS: readonly LimbLength[] = ['nubs', 'short', 'medium', 'long'];

/** The reason both head controls show when there is no head, or the head is the root. */
export const NO_HEAD_REASON = 'one-piece body: no separate head';

/** The range of the head's scale k (§4.2). */
const K_MIN = 0.2;
const K_MAX = 5;
/** The range searched for the height ratio of the edit. */
const S_MIN = 0.05;
const S_MAX = 20;
/** Bisection stops this close to its target (relative); §4.2 asks for 0.1%. */
const TOLERANCE = 2e-4;

/** The `LIMB_TEMPLATE` row of a model: by category and pose; a model without a matching category uses `quadruped`. */
export function limbTemplateRow(m: Pick<CrochetModelV1, 'category' | 'pose'>): keyof LimbTemplate {
  switch (m.category) {
    case 'quadruped':
      return m.pose === 'standing' ? 'quadruped-standing' : 'quadruped';
    case 'biped':
    case 'person':
      return 'biped';
    case 'creature':
      return 'creature';
    default:
      return 'quadruped';
  }
}

// ---- finding the parts

/** The head (§4.2): the part with id `head`, else the one labelled "Head". */
function findHead(parts: readonly Part[]): number {
  const byId = parts.findIndex((p) => p.id === 'head');
  if (byId >= 0) return byId;
  return parts.findIndex((p) => typeof p.label === 'string' && p.label.trim().toLowerCase() === 'head');
}

const LIMB_NAME = /^(arm|leg|limb\d+)(_|$)/;

type LimbPart = Extract<Part, { type: 'capsule' | 'cylinder' }>;

interface Limb {
  index: number;
  kind: 'arm' | 'leg';
  /** Total length along the limb's own axis (a capsule's `length`, a cylinder's `h`). */
  length: number;
}

/** The limbs: parts named `arm_*`, `leg_*`, `limb<n>_*` (§2.9.7 step 6) of type capsule or cylinder. */
function findLimbs(parts: readonly Part[]): { limbs: Limb[]; meshLimb?: Part; otherLimb?: Part } {
  const limbs: Limb[] = [];
  let meshLimb: Part | undefined;
  let otherLimb: Part | undefined;
  parts.forEach((p, index) => {
    if (!LIMB_NAME.test(p.id)) return;
    const kind = p.id.startsWith('leg') ? 'leg' : 'arm';
    if (p.type === 'capsule') limbs.push({ index, kind, length: Math.max(p.dims.length, 2 * p.dims.r) });
    else if (p.type === 'cylinder') limbs.push({ index, kind, length: p.dims.h });
    else if (p.type === 'mesh') meshLimb ??= p;
    else otherLimb ??= p;
  });
  return { limbs, meshLimb, otherLimb };
}

function limbsDisabledReason(found: ReturnType<typeof findLimbs>): string | undefined {
  if (found.meshLimb) return `Fit primitive on ${found.meshLimb.id} first`;
  if (found.limbs.length > 0) return undefined;
  if (found.otherLimb) return `limbs must be capsules or cylinders (${found.otherLimb.id} is a ${found.otherLimb.type})`;
  return 'no arms or legs: limbs are capsule or cylinder parts named arm_*, leg_* or limb<n>_*';
}

const meshOf = (p: Part, meshes?: Record<string, ColoredMesh>): ColoredMesh | undefined =>
  p.type === 'mesh' && meshes && Object.hasOwn(meshes, p.dims.meshRef) ? meshes[p.dims.meshRef] : undefined;

const heightOf = (p: Part, meshes?: Record<string, ColoredMesh>): number => {
  const b = worldBounds(p, meshOf(p, meshes));
  return b.max[1] - b.min[1];
};

// ---- reading

/**
 * The model's current proportions (§4.2). `headBody` is b of "head : body = 1 : b", to two decimals (the
 * untouched teddy: 1.3); it is not clamped to the slider's 1…3. `limbs` is the chip nearest to the arms' length
 * (the legs' when the model has no arms). A control that cannot work has its reason in `disabled` and no value.
 */
export const readProportions: ReadProportionsFn = (m) => {
  const disabled: { headBody?: string; limbs?: string } = {};
  const reading: ReturnType<ReadProportionsFn> = { disabled };
  const total = modelHeight(m);

  const head = findHead(m.parts);
  const graph = attachGraph(m.parts);
  if (head < 0 || graph.parent[head] === null) {
    disabled.headBody = NO_HEAD_REASON;
  } else {
    const fraction = heightOf(m.parts[head]) / total;
    if (fraction > 0) reading.headBody = roundCoord(Math.max(0, 1 / fraction - 1), 2);
    else disabled.headBody = NO_HEAD_REASON;
  }

  const found = findLimbs(m.parts);
  const reason = limbsDisabledReason(found);
  if (reason !== undefined) {
    disabled.limbs = reason;
  } else if (!(total > 0)) {
    disabled.limbs = 'the model has no height';
  } else {
    const row = LIMB_TEMPLATE[limbTemplateRow(m)];
    const arms = found.limbs.filter((l) => l.kind === 'arm');
    const group = arms.length > 0 ? arms : found.limbs;
    // The geometric mean of length / (height × template) over the group, and the chip nearest to it.
    let logSum = 0;
    for (const l of group) logSum += Math.log(Math.max(1e-9, l.length / (total * row[l.kind])));
    const factor = Math.exp(logSum / group.length);
    let best: LimbLength = 'short';
    let bestDistance = Infinity;
    for (const chip of LIMB_CHIPS) {
      const d = Math.abs(Math.log(factor / LIMB_FACTORS[chip]));
      if (d < bestDistance) {
        bestDistance = d;
        best = chip;
      }
    }
    reading.limbs = best;
  }
  return reading;
};

// ---- applying

interface Work {
  model: CrochetModelV1;
  meshes?: Record<string, ColoredMesh>;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function movePart(p: Part, d: Vec3): Part {
  return { ...p, position: roundVec3([p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]]) };
}

/**
 * Bisection for `evaluate(x).value = target` with `value` increasing on [lo, hi]. Returns the result at the end of
 * the range when the target lies outside it, else the first result within `TOLERANCE` (relative) of the target.
 */
function solveIncreasing<T>(evaluate: (x: number) => { value: number; result: T }, target: number, lo: number, hi: number): T {
  const atLo = evaluate(lo);
  if (!(atLo.value < target)) return atLo.result;
  const atHi = evaluate(hi);
  if (!(atHi.value > target)) return atHi.result;
  let left = lo;
  let right = hi;
  let mid = atLo;
  for (let i = 0; i < 60; i++) {
    const x = (left + right) / 2;
    mid = evaluate(x);
    if (Math.abs(mid.value - target) <= TOLERANCE * Math.abs(target)) break;
    if (mid.value < target) left = x;
    else right = x;
  }
  return mid.result;
}

/**
 * The head edit of §4.2 as a function of the head's scale k: the head is scaled uniformly about its center, moved
 * along the ray from its parent's center so its original penetration into the parent is kept, and its direct
 * children are re-anchored on its new surface (their subtrees follow). `null` when the model has no separate head.
 */
function headEditor(work: Work): { height0: number; apply(k: number): Work } | null {
  const { model, meshes } = work;
  const parts = model.parts;
  const graph = attachGraph(parts);
  const headIndex = findHead(parts);
  const parentIndex = headIndex < 0 ? null : graph.parent[headIndex];
  if (headIndex < 0 || parentIndex === null) return null;
  const head = parts[headIndex];
  const parent = parts[parentIndex];
  const sources: SurfaceSources = { meshes };
  const headMesh = meshOf(head, meshes);
  const height0 = heightOf(head, meshes);
  if (!(height0 > 0)) return null;

  const ray = normalize(sub(partCenter(head, headMesh), partCenter(parent, meshOf(parent, meshes))));
  const overlap = overlapAlongRay(parent, head, sources);
  const kids = graph.children[headIndex].map((c) => ({
    anchor: captureAnchor(head, parts[c], sources),
    ids: new Set(subtreeIds(model, parts[c].id)),
  }));
  const centerLocal = localCenter(head, headMesh);
  const rotation = eulerXYZToMat3(head.rotationDeg);

  const apply = (k: number): Work => {
    // Scale about the head's center: the local origin moves by R·c_local·(1 − k).
    const shift = mulMat3Vec(rotation, [centerLocal[0] * (1 - k), centerLocal[1] * (1 - k), centerLocal[2] * (1 - k)]);
    const scaled: Part = { ...scalePartDims(head, k), position: [head.position[0] + shift[0], head.position[1] + shift[1], head.position[2] + shift[2]] };
    const meshesK = headMesh && meshes && head.type === 'mesh' ? { ...meshes, [head.dims.meshRef]: scaleMesh(headMesh, k) } : meshes;
    const sourcesK: SurfaceSources = { meshes: meshesK };
    const placed = placeChildOnSurfaceWith(parent, scaled, { dir: ray }, overlap, sourcesK);
    const moves = new Map<string, Vec3>();
    for (const kid of kids) {
      const d = sub(anchorPoint(placed, kid.anchor, sourcesK), kid.anchor.point);
      for (const id of kid.ids) moves.set(id, d);
    }
    const next: CrochetModelV1 = {
      ...model,
      parts: parts.map((p, i) => {
        if (i === headIndex) return placed;
        const d = moves.get(p.id);
        return d ? movePart(p, d) : p;
      }),
    };
    return { model: next, meshes: meshesK };
  };
  return { height0, apply };
}

interface LimbPlan {
  id: string;
  kind: 'arm' | 'leg';
  /** +1: the proximal pole is the −axis end, so the center moves along +axis when the limb grows; −1: the other end; 0: no parent. */
  grow: -1 | 0 | 1;
}

function limbLength(p: LimbPart): number {
  return p.type === 'capsule' ? Math.max(p.dims.length, 2 * p.dims.r) : p.dims.h;
}

/** The limb with a new total length, its proximal pole kept where it is. */
function resizeLimb(p: LimbPart, length: number, grow: -1 | 0 | 1): LimbPart {
  const old = limbLength(p);
  const next = roundCoord(p.type === 'capsule' ? Math.min(48, Math.max(length, 2 * p.dims.r)) : Math.min(48, Math.max(length, 0.05)));
  const axis = partAxis(p, 1);
  const half = ((next - old) / 2) * grow;
  const position = roundVec3([p.position[0] + axis[0] * half, p.position[1] + axis[1] * half, p.position[2] + axis[2] * half]);
  return p.type === 'capsule' ? { ...p, position, dims: { ...p.dims, length: next } } : { ...p, position, dims: { ...p.dims, h: next } };
}

/**
 * The model with every limb set to `lengths` (by part id), parents before children: each limb keeps its proximal
 * pole and its direct children are re-anchored. No rescale. Exported for the tests of G23 ("the proximal pole
 * moved < 0.01 in before the rescale").
 */
export function resizeLimbs(model: CrochetModelV1, lengths: Readonly<Record<string, number>>, meshes?: Record<string, ColoredMesh>): CrochetModelV1 {
  const plans = planLimbs(model, meshes);
  let current = model;
  for (const plan of plans) {
    if (!Object.hasOwn(lengths, plan.id)) continue;
    const before = current;
    const limb = before.parts.find((p) => p.id === plan.id);
    if (!limb || (limb.type !== 'capsule' && limb.type !== 'cylinder')) continue;
    const resized = resizeLimb(limb, lengths[plan.id], plan.grow);
    const after: CrochetModelV1 = { ...before, parts: before.parts.map((p) => (p.id === plan.id ? resized : p)) };
    current = reanchorChildren(before, after, plan.id, { before: { meshes }, after: { meshes } });
  }
  return current;
}

/**
 * How decisive the parent-SDF test of §4.2 must be, as a fraction of the limb's radius: two poles whose parent
 * SDFs differ by less than this lie along the parent alike (a limb hanging tangent to its parent's side), and
 * the test cannot tell the attached end from the free one.
 */
const POLE_SDF_MARGIN = 0.25;

/** The limb's radius: a capsule's `r`, a cylinder's larger end radius. */
function limbRadius(p: LimbPart): number {
  return p.type === 'capsule' ? p.dims.r : Math.max(p.dims.rTop, p.dims.rBottom);
}

/**
 * Which pole of a limb is its proximal end (§4.2): `grow` −1 = the +axis pole, +1 = the −axis pole. In order:
 *
 * 1. `attach.openEnd` `'top'` / `'bottom'`: the open end is the one sewn to the parent, so it is the proximal
 *    end (`'top'` = the +axis pole, as in §2.10.2).
 * 2. A mesh parent known only by its triangles (no SDF): the pole nearer the parent's center.
 * 3. The spec's rule: the pole with the larger parent SDF (the end inside or nearest the parent) — when the two
 *    differ by at least `POLE_SDF_MARGIN` × the limb's radius.
 * 4. Otherwise the two ends meet the parent alike and the rule would follow the limb's length, not its
 *    attachment (the teddy's arm lies along the body: at 'nubs' length its lower pole is the nearer one, so
 *    the next chip would grow the arm up from the hand). Limbs grow away from the model's mirror plane x = 0:
 *    the pole with the smaller |x| is proximal. Keeping that pole and changing the length moves the other pole
 *    along the axis, so a limb that heads away from the mirror plane keeps the same proximal pole on every
 *    later chip. When both poles are as far from the plane (within 1e-6 in), rule 3's comparison decides.
 */
function proximalGrow(p: LimbPart, parent: Part, meshes?: Record<string, ColoredMesh>): -1 | 1 {
  const openEnd = p.attach?.openEnd;
  if (openEnd === 'top') return -1;
  if (openEnd === 'bottom') return 1;
  const axis = partAxis(p, 1);
  const half = limbLength(p) / 2;
  const c = partCenter(p);
  const plus: Vec3 = [c[0] + axis[0] * half, c[1] + axis[1] * half, c[2] + axis[2] * half];
  const minus: Vec3 = [c[0] - axis[0] * half, c[1] - axis[1] * half, c[2] - axis[2] * half];
  if (parent.type === 'mesh' && meshOf(parent, meshes)) {
    // No SDF for a mesh known only by its triangles: the pole nearer the parent's center.
    const pc = partCenter(parent, meshOf(parent, meshes));
    const dPlus = Math.hypot(plus[0] - pc[0], plus[1] - pc[1], plus[2] - pc[2]);
    const dMinus = Math.hypot(minus[0] - pc[0], minus[1] - pc[1], minus[2] - pc[2]);
    return dPlus < dMinus ? -1 : 1;
  }
  const f = worldSdf(parent);
  const fPlus = f(plus[0], plus[1], plus[2]);
  const fMinus = f(minus[0], minus[1], minus[2]);
  const bySdf: -1 | 1 = fPlus > fMinus ? -1 : 1;
  if (!(Math.abs(fPlus - fMinus) < POLE_SDF_MARGIN * limbRadius(p))) return bySdf;
  const xPlus = Math.abs(plus[0]);
  const xMinus = Math.abs(minus[0]);
  if (Math.abs(xPlus - xMinus) <= 1e-6) return bySdf;
  return xPlus < xMinus ? -1 : 1;
}

/**
 * The limbs in tree order (parents first), each with the end that stays put (`proximalGrow`). A mirror twin
 * takes its twin's end.
 */
function planLimbs(model: CrochetModelV1, meshes?: Record<string, ColoredMesh>): LimbPlan[] {
  const parts = model.parts;
  const graph = attachGraph(parts);
  const { limbs } = findLimbs(parts);
  const depth = (i: number): number => {
    let d = 0;
    for (let at = graph.parent[i]; at !== null && d <= parts.length; at = graph.parent[at]) d++;
    return d;
  };
  const plans = new Map<string, LimbPlan>();
  const ordered = limbs.map((l) => ({ ...l, depth: depth(l.index) })).sort((a, b) => a.depth - b.depth || a.index - b.index);
  for (const l of ordered) {
    const p = parts[l.index] as LimbPart;
    const parentIndex = graph.parent[l.index];
    const grow: -1 | 0 | 1 = parentIndex === null ? 0 : proximalGrow(p, parts[parentIndex], meshes);
    plans.set(p.id, { id: p.id, kind: l.kind, grow });
  }
  // Mirror twins get the same change: the same end stays put (the twins' local frames mirror each other).
  for (const l of ordered) {
    const p = parts[l.index];
    const twin = p.mirrorOf === undefined ? undefined : plans.get(p.mirrorOf);
    const own = plans.get(p.id);
    if (twin && own) own.grow = twin.grow;
  }
  return ordered.map((l) => plans.get(parts[l.index].id) as LimbPlan);
}

/**
 * Keeps exact mirror twins exact: a part with `mirrorOf` that was the mirror image of its twin before the edit
 * (to 1e-6) is written as the mirror image of its twin after it. The two were computed independently, so they
 * can differ in the last rounded digit.
 */
function keepMirrors(before: CrochetModelV1, after: CrochetModelV1): CrochetModelV1 {
  const was = new Map(before.parts.map((p) => [p.id, p]));
  const now = new Map(after.parts.map((p) => [p.id, p]));
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 2e-6;
  let changed = false;
  const parts = after.parts.map((p) => {
    if (p.mirrorOf === undefined) return p;
    const twinWas = was.get(p.mirrorOf);
    const selfWas = was.get(p.id);
    const twin = now.get(p.mirrorOf);
    if (!twinWas || !selfWas || !twin || twin.type !== p.type) return p;
    const a = selfWas.position;
    const t = twinWas.position;
    if (!(close(a[0], -t[0]) && close(a[1], t[1]) && close(a[2], t[2]))) return p;
    if (JSON.stringify(selfWas.dims) !== JSON.stringify(twinWas.dims)) return p;
    const position: Vec3 = [twin.position[0] === 0 ? 0 : -twin.position[0], twin.position[1], twin.position[2]];
    if (position[0] === p.position[0] && position[1] === p.position[1] && position[2] === p.position[2] && JSON.stringify(p.dims) === JSON.stringify(twin.dims)) {
      return p;
    }
    changed = true;
    return { ...p, position, dims: structuredClone(twin.dims) } as Part;
  });
  return changed ? { ...after, parts } : after;
}

/**
 * Changes the model's proportions (§4.2) and returns the new model — and, when `meshes` is passed, the mesh
 * buffers as they are after the edit (a mesh head and the final rescale change them; the input is never
 * modified).
 *
 * `o.headBody` = b of "head : body = 1 : b" (the slider's 1…3; any positive number is accepted): the head is
 * scaled uniformly about its center by k in [0.2, 5], moved along the ray from its parent's center so its
 * original penetration is kept, and its children are re-anchored. `o.limbs` = the limb length chip: every limb
 * gets the total length factor × template × model height along its own axis, its proximal end fixed, mirror
 * twins alike, its children re-anchored. A control that `readProportions` reports as disabled is ignored.
 *
 * The edit ends with a uniform rescale of the whole model about its ground center, so the finished height is
 * unchanged; the scale of the head and the limb lengths are found by bisection so the ratios hold AFTER that
 * rescale (to 0.02%). The model's lowest point stays at the height it had. Coordinates are rounded to 1e-6 in.
 */
export const applyProportions: ApplyProportionsFn = (m, o, meshes) => {
  const unchanged = meshes === undefined ? { model: m } : { model: m, meshes };
  const start: Work = { model: m, meshes };
  const height0 = modelHeight(m, meshes);
  if (!(height0 > 0) || !Number.isFinite(height0)) return unchanged;

  const b = o.headBody;
  const headEdit = typeof b === 'number' && Number.isFinite(b) && b > 0 ? headEditor(start) : null;
  const headTarget = typeof b === 'number' ? 1 / (1 + b) : 0;

  const found = findLimbs(m.parts);
  const chip = o.limbs !== undefined && Object.hasOwn(LIMB_FACTORS, o.limbs) && limbsDisabledReason(found) === undefined ? o.limbs : undefined;
  const row = LIMB_TEMPLATE[limbTemplateRow(m)];
  if (!headEdit && chip === undefined) return unchanged;

  // One unknown, s = (height after the edit) / (height before it). After the final rescale by 1/s the ratios hold
  // when the head's height is headTarget·s·H0 and each limb's length is factor·template·s·H0; the right s is
  // where the edited model's height is s·H0. `s − height(s)/H0` grows with s (the head and the limbs are
  // shorter than the model), so bisection finds it. For the head alone this is the bisection on k of §4.2.
  const build = (s: number): { value: number; result: Work & { height: number } } => {
    let work = start;
    if (headEdit) {
      const k = Math.min(K_MAX, Math.max(K_MIN, (headTarget * s * height0) / headEdit.height0));
      work = headEdit.apply(k);
    }
    if (chip !== undefined) {
      const lengths: Record<string, number> = {};
      for (const l of found.limbs) lengths[m.parts[l.index].id] = s * LIMB_FACTORS[chip] * row[l.kind] * height0;
      work = { model: resizeLimbs(work.model, lengths, work.meshes), meshes: work.meshes };
    }
    const model = keepMirrors(m, work.model);
    const height = modelHeight(model, work.meshes);
    return { value: 1 + s - height / height0, result: { model, meshes: work.meshes, height } };
  };
  const solved = solveIncreasing(build, 1, S_MIN, S_MAX);
  if (!(solved.height > 0) || !Number.isFinite(solved.height)) return unchanged;

  // Rescale to the original height; then keep the lowest point where it was (limbs may have reached below it).
  const restored = scaleModel(solved.model, height0 / solved.height, solved.meshes);
  const dy = modelBounds(m, meshes).min[1] - modelBounds(restored.model, restored.meshes).min[1];
  const lifted: CrochetModelV1 =
    Number.isFinite(dy) && Math.abs(dy) > 5e-7 ? { ...restored.model, parts: restored.model.parts.map((p) => movePart(p, [0, dy, 0])) } : restored.model;
  const model = keepMirrors(m, lifted);
  return meshes === undefined ? { model } : { model, meshes: restored.meshes };
};
