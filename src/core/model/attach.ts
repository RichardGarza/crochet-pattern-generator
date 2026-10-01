// The attach tree and the mirror pairs (DESIGN.md §3.7.6, D21). Step 0 kernel, shared by the importer (every
// carrier), photo reconstruction (§2.9.7 step 5) and the editor.
//
// Every model, from every source, is normalized to ONE attach tree: `inferAttach` keeps the links a model
// already has, picks the root, and grows the tree outward from it by largest overlap volume (Prim's rule), so
// a part never hangs from its own child. `inferMirrorPairs` links `X_r` to `X_l` when the two are mirror images.
// Both are pure and idempotent, and both log one `Repair` per change.
import type { InferAttachFn, InferMirrorPairsFn } from '../../types/entryPoints';
import type { Repair } from '../../types/importer';
import type { CrochetModelV1, Part } from '../../types/model';
import { mulMat3, transpose3 } from '../kernel/vec';
import {
  gapOfVertices,
  gapProbe,
  gapWithEnclosure,
  type MeshSdf,
  meshSdfOf,
  OVERLAP_MAX_SAMPLES,
  overlapVolumeWith,
  partVolume,
  partWorldVertices,
  type WorldSdf,
  worldSdf,
} from './sdf';
import { boundsSize, eulerXYZToMat3, localBounds, modelBounds, worldBounds } from './transforms';

/** A gap above this raises `W_GAP` (§2.13). */
export const GAP_WARN_IN = 0.1;
/** A gap above this is reported as a floating part (§3.7.6). */
export const GAP_FLOAT_IN = 0.25;
/** Two overlap volumes within this fraction of the larger one are a tie (§3.7.6). */
const OVERLAP_TIE = 0.01;
/** Grid cells `inferAttach` may spend on overlap volumes in one call, and the fewest it gives any one pair. */
const OVERLAP_BUDGET_SAMPLES = 40_000_000;
const OVERLAP_MIN_SAMPLES = 32_768;

// ---- the attach graph

/** The attach links of a parts list, by part index. */
export interface AttachGraph {
  /** Part id → index (the first part with that id). */
  index: Map<string, number>;
  /** The index of each part's parent; `null` without `attach`, or when the link is dangling or to itself. */
  parent: (number | null)[];
  /** The indices of each part's direct children, in parts order. */
  children: number[][];
  /** The parts without a parent, in parts order. A part on a cycle is not a root. */
  roots: number[];
  /** True when the links form exactly one tree: one root, every other part reachable from it. */
  isTree: boolean;
}

export function attachGraph(parts: readonly Part[]): AttachGraph {
  const index = new Map<string, number>();
  parts.forEach((p, i) => {
    if (!index.has(p.id)) index.set(p.id, i);
  });
  const parent = parts.map((p, i): number | null => {
    const to: unknown = p.attach?.to;
    if (typeof to !== 'string') return null;
    const j = index.get(to);
    return j === undefined || j === i ? null : j;
  });
  const children: number[][] = parts.map(() => []);
  const roots: number[] = [];
  parent.forEach((j, i) => {
    if (j === null) roots.push(i);
    else children[j].push(i);
  });
  let reached = 0;
  if (roots.length === 1) {
    const queue = [roots[0]];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      const at = queue.shift() as number;
      reached++;
      for (const c of children[at]) {
        if (!seen.has(c)) {
          seen.add(c);
          queue.push(c);
        }
      }
    }
  }
  return { index, parent, children, roots, isTree: parts.length > 0 && roots.length === 1 && reached === parts.length };
}

/** True when the model's attach links form exactly one tree (what `generateAmigurumi` requires, §2.10). */
export function isOneTree(model: Pick<CrochetModelV1, 'parts'>): boolean {
  return attachGraph(model.parts).isTree;
}

/** The root of the model's attach tree; `undefined` when the links do not form one tree. */
export function attachRoot(model: Pick<CrochetModelV1, 'parts'>): Part | undefined {
  const g = attachGraph(model.parts);
  return g.isTree ? model.parts[g.roots[0]] : undefined;
}

/** The ids of a part and everything attached to it, directly or not: the part first, then breadth first. */
export function subtreeIds(model: Pick<CrochetModelV1, 'parts'>, id: string): string[] {
  const g = attachGraph(model.parts);
  const start = g.index.get(id);
  if (start === undefined) return [];
  const out: string[] = [];
  const queue = [start];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const at = queue.shift() as number;
    out.push(model.parts[at].id);
    for (const c of g.children[at]) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}

/** The direct children of a part, in parts order. */
export function childrenOf(model: Pick<CrochetModelV1, 'parts'>, id: string): Part[] {
  const g = attachGraph(model.parts);
  const at = g.index.get(id);
  return at === undefined ? [] : g.children[at].map((i) => model.parts[i]);
}

// ---- inferAttach

const isBody = (p: Part): boolean => p.id === 'body' || (typeof p.label === 'string' && p.label.trim().toLowerCase() === 'body');

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const finiteVolume = (p: Part): number => {
  const v = partVolume(p);
  return Number.isFinite(v) ? v : 0;
};

/**
 * The root rule of §3.7.6 for one parts list: among `candidates` (part indices, not empty), those whose world
 * bounding box reaches the lowest 10% of the model's height — of them the one with id or label `body`, else
 * the largest by volume; when none reaches it, the largest candidate. Ties → the lowest index.
 */
function rootChooser(parts: readonly Part[]): (candidates: readonly number[]) => number {
  const volume = parts.map(finiteVolume);
  const all = modelBounds({ parts: parts as Part[] });
  const lowLimit = all.min[1] + 0.1 * (all.max[1] - all.min[1]);
  const reachesBottom = parts.map((p) => worldBounds(p).min[1] <= lowLimit);
  const largest = (candidates: readonly number[]): number =>
    candidates.reduce((best, i) => (volume[i] > volume[best] ? i : best), candidates[0]);
  return (candidates) => {
    const low = candidates.filter((i) => reachesBottom[i]);
    if (low.length === 0) return largest(candidates);
    const body = low.find((i) => isBody(parts[i]));
    return body ?? largest(low);
  };
}

/**
 * The index of the part the root rule of §3.7.6 names: the only part without a parent, else the choice among
 * the parentless parts (among all parts when the links only form cycles). −1 for an empty list.
 */
export function chooseRoot(parts: readonly Part[]): number {
  if (parts.length === 0) return -1;
  const roots = attachGraph(parts).roots;
  if (roots.length === 1) return roots[0];
  return rootChooser(parts)(roots.length > 0 ? roots : parts.map((_, i) => i));
}

/**
 * Completes the attach tree (§3.7.6). Parts that already have a valid `attach` keep it. A link to a missing part
 * or to the part itself is dropped, and a cycle is broken at the member the root rule would choose; those
 * parts are then linked again like every other unattached part.
 *
 * Root: the only part without `attach`; otherwise, among the unattached parts whose world bounding box
 * reaches the lowest 10% of the model's height, the one with id or label `body`, else the largest by volume;
 * if none reaches it, the largest unattached part.
 *
 * Links: the tree starts as the root's component. Repeatedly, over every unattached component root `c` and
 * every part `p` already in the tree, the pair with the largest overlap volume is linked
 * (`c.attach = { to: p, method: 'sewn' }`; ties within 1% → the larger `c`, then its id) and `c`'s component
 * joins the tree. When no pair overlaps, the pair with the smallest surface gap is linked. The result is
 * always one tree. Every new link is one `attach-inferred` repair whose `data` holds `to` and either
 * `overlapIn3` or `gapIn` (a gap above 0.1 in is a `W_GAP`).
 *
 * `o.meshSdf` holds the part-local SDFs of mesh parts, keyed by meshRef (else by part id).
 *
 * Precondition, not checked: part ids are unique (§3.5.1; the importer's ids repair runs first). Every kernel
 * resolves an id to the first part that carries it. With a repeated id the result is still one tree by that
 * resolution: a later part with the repeated id is never made a parent, nor the root while another part can be.
 */
export const inferAttach: InferAttachFn = (m, o) => {
  const parts = m.parts.slice();
  const n = parts.length;
  if (n === 0) return { model: m, repairs: [] };
  const meshSdf: Record<string, MeshSdf> | undefined = o?.meshSdf;
  const repairs: Repair[] = [];
  const graph = attachGraph(parts);
  const parent = graph.parent.slice();

  // Links that cannot stay: dangling, or to the part itself.
  const dropped = new Map<number, string>();
  parts.forEach((p, i) => {
    if (p.attach !== undefined && parent[i] === null) {
      const to: unknown = p.attach.to;
      dropped.set(i, to === p.id ? 'itself' : `"${String(to)}", which does not exist`);
    }
  });

  const volume = parts.map(finiteVolume);
  const pickRoot = rootChooser(parts);

  // Cycles: every part has at most one parent, so a walk that returns to itself has found one.
  const state = new Int32Array(n); // 0 = not visited, k > 0 = visited by walk k
  for (let start = 0, walk = 1; start < n; start++, walk++) {
    let at: number | null = start;
    while (at !== null && state[at] === 0) {
      state[at] = walk;
      at = parent[at];
    }
    if (at !== null && state[at] === walk) {
      const cycle: number[] = [];
      let k: number = at;
      do {
        cycle.push(k);
        k = parent[k] as number;
      } while (k !== at);
      cycle.sort((a, b) => a - b);
      const cut = pickRoot(cycle);
      dropped.set(cut, `"${parts[parent[cut] as number].id}" in a cycle (${cycle.map((i) => parts[i].id).join(' → ')})`);
      parent[cut] = null;
    }
  }

  const roots: number[] = [];
  const children: number[][] = parts.map(() => []);
  parent.forEach((j, i) => {
    if (j === null) roots.push(i);
    else children[j].push(i);
  });
  if (roots.length === 1 && dropped.size === 0) return { model: m, repairs: [] };

  // Ids are meant to be unique (the importer's ids step makes them so). A link names its target by id, and an id
  // names the FIRST part that carries it, so a later part with a repeated id can never be a link's target: it
  // is never chosen as a parent, nor as the root while another part can be (a part linked to it would point at
  // the first part with that id — possibly itself).
  const referable = parts.map((p, i) => graph.index.get(p.id) === i);
  const rootCandidates = roots.filter((i) => referable[i]);
  const root = roots.length === 1 ? roots[0] : pickRoot(rootCandidates.length > 0 ? rootCandidates : roots);

  // The tree, in the order parts joined it (the root first).
  const inTree = new Array<boolean>(n).fill(false);
  const tree: number[] = [];
  const join = (top: number): void => {
    const queue = [top];
    inTree[top] = true;
    while (queue.length > 0) {
      const at = queue.shift() as number;
      tree.push(at);
      for (const c of children[at]) {
        if (!inTree[c]) {
          inTree[c] = true;
          queue.push(c);
        }
      }
    }
  };
  join(root);

  // A work budget for the overlap grids: a model whose parts all overlap one another (60 parts: 1 770 pairs)
  // would otherwise take minutes. The cap per pair depends only on the model, so the result is deterministic;
  // it stays at the kernel's default for ordinary models (the teddy has about 40 pairs of touching boxes).
  const boxes = parts.map((p) => worldBounds(p));
  let touching = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1] && a.min[2] < b.max[2] && b.min[2] < a.max[2]) touching++;
    }
  }
  const maxSamples = Math.max(OVERLAP_MIN_SAMPLES, Math.min(OVERLAP_MAX_SAMPLES, Math.floor(OVERLAP_BUDGET_SAMPLES / Math.max(1, touching))));

  const overlaps = new Map<number, number>();
  const overlapOf = (c: number, p: number): number => {
    const key = c * n + p;
    let v = overlaps.get(key);
    if (v === undefined) {
      v = overlapVolumeWith(parts[c], parts[p], { meshSdf, maxSamples });
      if (!(v > 0)) v = 0; // NaN counts as no overlap
      overlaps.set(key, v);
    }
    return v;
  };
  // Gaps: each part is tessellated once, and its SDF built once, however many pairs it takes part in.
  const vertices = new Map<number, Float64Array<ArrayBuffer>>();
  const verticesOf = (i: number): Float64Array<ArrayBuffer> => {
    let v = vertices.get(i);
    if (!v) {
      v = partWorldVertices(parts[i]);
      vertices.set(i, v);
    }
    return v;
  };
  const sdfs = new Map<number, WorldSdf>();
  const sdfOf = (i: number): WorldSdf => {
    let f = sdfs.get(i);
    if (!f) {
      f = worldSdf(parts[i], meshSdfOf(parts[i], meshSdf));
      sdfs.set(i, f);
    }
    return f;
  };
  const gaps = new Map<number, number>();
  const gapOf = (c: number, p: number): number => {
    const key = c * n + p;
    let g = gaps.get(key);
    if (g === undefined) {
      const swap = gapProbe(parts[c], parts[p]) === 'parent';
      const probe = swap ? p : c;
      const solid = swap ? c : p;
      g = gapWithEnclosure(gapOfVertices(verticesOf(probe), sdfOf(solid)), () => gapOfVertices(verticesOf(solid), sdfOf(probe)));
      if (Number.isNaN(g)) g = Infinity;
      gaps.set(key, g);
    }
    return g;
  };
  /** Ties → the larger component root, then its id, then the candidate found first (nearer the root). */
  const preferC = (a: number, b: number): number => volume[b] - volume[a] || compareIds(parts[a].id, parts[b].id) || a - b;

  for (;;) {
    const pending = roots.filter((c) => !inTree[c]);
    if (pending.length === 0) break;

    let best: { c: number; p: number; overlap: number; gap: number } | null = null;
    let top = 0;
    const targets = tree.filter((p) => referable[p]);
    for (const c of pending) for (const p of targets) top = Math.max(top, overlapOf(c, p));
    if (top > 0) {
      for (const c of pending) {
        for (const p of targets) {
          const v = overlapOf(c, p);
          if (v < top * (1 - OVERLAP_TIE)) continue;
          const order = best === null ? -1 : preferC(c, best.c) || best.overlap - v;
          if (order < 0) best = { c, p, overlap: v, gap: 0 };
        }
      }
    } else {
      for (const c of pending) {
        for (const p of targets) {
          const g = gapOf(c, p);
          // Infinity − Infinity is NaN, whose comparison is false: two unmeasurable gaps tie.
          const order = best === null ? -1 : Math.abs(g - best.gap) > 1e-9 ? g - best.gap : preferC(c, best.c);
          if (order < 0) best = { c, p, overlap: 0, gap: g };
        }
      }
    }
    // `pending` and `targets` are never empty here (the root is referable: a later duplicate has no children, so
    // when every parentless part were one, every part would be parentless — and the first of each id is not a
    // later duplicate), so a pair was always chosen.
    const link = best as { c: number; p: number; overlap: number; gap: number };
    const child = parts[link.c];
    const to = parts[link.p];
    parts[link.c] = { ...child, attach: { to: to.id, method: 'sewn' } };
    parent[link.c] = link.p;
    const was = dropped.get(link.c);
    dropped.delete(link.c);
    const instead = was === undefined ? '' : ` (it was attached to ${was})`;
    if (link.overlap > 0) {
      repairs.push({
        code: 'attach-inferred',
        part: child.id,
        message: `${child.id} attached to ${to.id}: they overlap by ${round4(link.overlap)} in³${instead}`,
        data: { to: to.id, overlapIn3: round4(link.overlap) },
      });
    } else {
      const gap = Number.isFinite(link.gap) ? round4(Math.max(0, link.gap)) : null;
      const text =
        gap === null
          ? `${child.id} attached to ${to.id}, the nearest part`
          : gap > GAP_FLOAT_IN
            ? `${child.id} attached to ${to.id}: this part floats ${gap} in from ${to.id}`
            : gap > GAP_WARN_IN
              ? `${child.id} attached to ${to.id}, the nearest part: gap ${gap} in`
              : `${child.id} attached to ${to.id}, the nearest part (they touch)`;
      repairs.push({ code: 'attach-inferred', part: child.id, message: text + instead, data: { to: to.id, gapIn: gap } });
    }
    join(link.c);
  }

  // A root that carried a link that could not stay.
  const was = dropped.get(root);
  if (was !== undefined) {
    const rest = { ...parts[root] };
    delete rest.attach;
    parts[root] = rest;
    repairs.push({
      code: 'attach-inferred',
      part: parts[root].id,
      message: `${parts[root].id} was attached to ${was}; it is now the root`,
      data: { root: true },
    });
  }
  return { model: { ...m, parts }, repairs };
};

// ---- inferMirrorPairs

const LEFT_OF: Readonly<Record<string, string>> = { r: 'l', right: 'left', fr: 'fl', br: 'bl' };

/**
 * The id of the left twin of a right-side id: the last `_`-separated token that names the right side
 * (`r`, `right`, `fr`, `br`) becomes its left form — `ear_r` → `ear_l`, `ear_r_inner` → `ear_l_inner`,
 * `leg_fr` → `leg_fl`, `wing_right` → `wing_left`. `null` for an id without such a token.
 */
export function leftTwinId(id: string): string | null {
  const tokens = id.split('_');
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (Object.hasOwn(LEFT_OF, tokens[i])) {
      tokens[i] = LEFT_OF[tokens[i]];
      return tokens.join('_');
    }
  }
  return null;
}

function equalDims(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equalDims(v, b[i], tol));
  }
  return a === b;
}

/** Equal type and dims within a relative tolerance. Defaults count as written; the mesh buffer of a mesh part is not compared. */
function sameShape(a: Part, b: Part, tol: number): boolean {
  if (a.type !== b.type) return false;
  const da = a.dims as Record<string, unknown>;
  const db = b.dims as Record<string, unknown>;
  const fill = (d: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...d };
    if (a.type === 'torus') out.arcDeg = out.arcDeg ?? 360;
    if (a.type === 'cylinder') out.open = out.open ?? 'none';
    if (a.type === 'mesh') delete out.meshRef;
    return out;
  };
  const fa = fill(da);
  const fb = fill(db);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  for (const key of keys) {
    if (fa[key] === undefined && fb[key] === undefined) continue;
    if (!equalDims(fa[key], fb[key], tol)) return false;
  }
  return true;
}

const wrapDeg = (d: number): number => {
  const w = ((d % 360) + 540) % 360;
  return Math.abs(w - 180);
};

/** True when `right` is `left` mirrored across x = 0: position (−x, y, z) and rotation (a, −b, −c). */
function mirroredPose(left: Part, right: Part, posTol: number, rotTolDeg: number): boolean {
  const pl = left.position;
  const pr = right.position;
  if (!(Math.abs(pr[0] + pl[0]) <= posTol && Math.abs(pr[1] - pl[1]) <= posTol && Math.abs(pr[2] - pl[2]) <= posTol)) return false;
  const rl = left.rotationDeg ?? [0, 0, 0];
  const rr = right.rotationDeg ?? [0, 0, 0];
  const byAngles = wrapDeg(rr[0] - rl[0]) <= rotTolDeg && wrapDeg(rr[1] + rl[1]) <= rotTolDeg && wrapDeg(rr[2] + rl[2]) <= rotTolDeg;
  if (byAngles) return true;
  // The same rotation written with other Euler angles: compare the matrices.
  const expected = eulerXYZToMat3([rl[0], -rl[1], -rl[2]]);
  const delta = mulMat3(transpose3(expected), eulerXYZToMat3(rr));
  const cos = Math.min(1, Math.max(-1, (delta[0] + delta[4] + delta[8] - 1) / 2));
  return (Math.acos(cos) * 180) / Math.PI <= rotTolDeg;
}

/**
 * Links mirror pairs (§3.7.6): for ids `X_l` / `X_r` (also `left` / `right`, `fl` / `fr`, `bl` / `br`, as any
 * `_`-separated token) with equal type and dims, positions mirrored across x = 0 and rotations (a, b, c) vs
 * (a, −b, −c), sets `mirrorOf: 'X_l'` on `X_r` and logs one `mirror-inferred` repair. A part that already has
 * `mirrorOf`, that another part already names in `mirrorOf`, or whose twin has `mirrorOf`, is left alone (the
 * schema allows no mirror chains).
 *
 * `o.tolerance` is the relative tolerance on dims: 1e-6 by default, 0.1 for reconstructions. Positions must
 * agree within max(0.001 in, tolerance × the part's largest extent) and rotations within
 * max(0.5°, tolerance × 90°), which is ±0.001 in and ±0.5° at the default.
 */
export const inferMirrorPairs: InferMirrorPairsFn = (m, o) => {
  const given = o?.tolerance;
  const tol = typeof given === 'number' && given >= 0 ? given : 1e-6;
  const byId = new Map<string, Part>();
  for (const p of m.parts) if (!byId.has(p.id)) byId.set(p.id, p);
  // The mirror links as they stand, updated as pairs are linked (in parts order), so one pass never makes a chain.
  const mirrors = new Set<string>(); // ids of parts with mirrorOf
  const mirrored = new Set<string>(); // ids some part names in mirrorOf
  for (const p of m.parts) {
    if (p.mirrorOf === undefined) continue;
    mirrors.add(p.id);
    mirrored.add(p.mirrorOf);
  }
  const repairs: Repair[] = [];
  let changed = false;
  const parts = m.parts.map((right) => {
    if (right.mirrorOf !== undefined) return right;
    const twinId = leftTwinId(right.id);
    const left = twinId === null ? undefined : byId.get(twinId);
    // mirrorOf names a source part (schema): the left twin must not mirror anything, the right one must not be a source.
    if (!left || left === right || mirrors.has(left.id) || mirrored.has(right.id)) return right;
    if (!sameShape(left, right, tol)) return right;
    const size = Math.max(...boundsSize(localBounds(left)));
    const posTol = Math.max(1e-3, tol * (Number.isFinite(size) ? size : 0));
    const rotTol = Math.max(0.5, tol * 90);
    if (!mirroredPose(left, right, posTol, rotTol)) return right;
    changed = true;
    mirrors.add(right.id);
    mirrored.add(left.id);
    repairs.push({
      code: 'mirror-inferred',
      part: right.id,
      message: `${right.id} is the mirror image of ${left.id}`,
      data: { mirrorOf: left.id },
    });
    return { ...right, mirrorOf: left.id };
  });
  return { model: changed ? { ...m, parts } : m, repairs };
};
