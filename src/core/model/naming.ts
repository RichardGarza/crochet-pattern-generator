// Template ids by geometry (DESIGN.md §2.9.7 step 6). Step 0 kernel, shared by photo reconstruction (T3) and the
// importer's geometry-only path (§3.7.5), so the Q&A, the seed and Claude Design see familiar part names.
//
// Rules, on a model that already has its attach tree (`inferAttach`):
//   - the root is `body`; the head is the part already called `head` (id, else label "Head"), else the largest
//     single child of the root that sits above the root's center and holds at least 15% of its volume (the
//     neck-split upper piece);
//   - among the mirror pairs attached to `body`, the pair reaching the lowest 15% of the model height is
//     `leg_l` / `leg_r` and the next pairs by height are `arm_l` / `arm_r`, then `limb2_l` / `limb2_r`, …;
//   - the highest pair on `head` above its center is `ear_l` / `ear_r`;
//   - a single child in front of the head (center z > head center + ¼ head depth) is `muzzle`;
//   - a single child behind the body (center z < body center − ¼ body depth) is `tail`;
//   - everything else is `part_1`, `part_2`, … by decreasing volume.
// `_l` is the member with the larger x (the toy's own left, +X). Ids in `keepIds` are never changed.
import type { NamePartsFn } from '../../types/entryPoints';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import { attachGraph, chooseRoot } from './attach';
import { partVolume } from './sdf';
import { type Bounds, boundsSize, modelBounds, partCenter, worldBounds } from './transforms';

interface Info {
  center: Vec3;
  bounds: Bounds;
  volume: number;
  /** The largest extent of the world bounding box. */
  size: number;
}

/** [index of the member with the larger x, index of the other]. */
type Pair = [number, number];

/**
 * Mirror pairs among the children of one parent: parts linked by `mirrorOf`, and parts of similar size whose
 * centers mirror each other across the plane x = `plane` (within 35% of their size — reconstructed twins are
 * never exact). Closest matches pair first; a part on the plane is never a member.
 */
function findPairs(parts: readonly Part[], info: readonly Info[], siblings: readonly number[], plane: number): Pair[] {
  const pairs: Pair[] = [];
  const used = new Set<number>();
  const ordered = (a: number, b: number): Pair => (info[a].center[0] >= info[b].center[0] ? [a, b] : [b, a]);
  for (const i of siblings) {
    const twin = parts[i].mirrorOf;
    if (twin === undefined || used.has(i)) continue;
    const j = siblings.find((k) => k !== i && !used.has(k) && parts[k].id === twin);
    if (j === undefined) continue;
    used.add(i);
    used.add(j);
    pairs.push(ordered(i, j));
  }
  const candidates: { a: number; b: number; d: number }[] = [];
  for (const a of siblings) {
    if (used.has(a)) continue;
    for (const b of siblings) {
      if (b === a || used.has(b)) continue;
      const ca = info[a].center;
      const cb = info[b].center;
      const size = (info[a].size + info[b].size) / 2;
      const offPlane = Math.max(1e-3, 0.02 * size);
      if (!(ca[0] - plane > offPlane && plane - cb[0] > offPlane)) continue;
      const ratio = info[a].size / info[b].size;
      if (!(ratio > 1 / 1.5 && ratio < 1.5)) continue;
      const d = Math.hypot(2 * plane - cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]);
      if (d <= 0.35 * size) candidates.push({ a, b, d });
    }
  }
  candidates.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
  for (const { a, b } of candidates) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    pairs.push([a, b]);
  }
  return pairs;
}

/** Rewrites every reference to a renamed part: `attach.to`, `mirrorOf`, `features[].on`, `assembly[].part` / `.to`. */
function renameReferences(model: CrochetModelV1, newId: readonly string[], renames: ReadonlyMap<string, string>): CrochetModelV1 {
  const ref = (id: string): string => renames.get(id) ?? id;
  const out: CrochetModelV1 = {
    ...model,
    parts: model.parts.map((p, i) => {
      const part = { ...p, id: newId[i] };
      if (p.attach) part.attach = { ...p.attach, to: ref(p.attach.to) };
      if (p.mirrorOf !== undefined) part.mirrorOf = ref(p.mirrorOf);
      return part;
    }),
  };
  if (model.features) out.features = model.features.map((f) => ({ ...f, on: ref(f.on) }));
  if (model.assembly) {
    out.assembly = model.assembly.map((step) => {
      const s = { ...step, part: ref(step.part) };
      if (step.to !== undefined) s.to = ref(step.to);
      return s;
    });
  }
  return out;
}

/**
 * Names the parts of a model by geometry (§2.9.7 step 6) and rewrites every reference to them. `renames` maps
 * each changed id to its new one. Parts whose id is in `o.keepIds` (ids the user has renamed) keep it, and no
 * other part takes it. Naming a named model again changes nothing.
 */
export const nameParts: NamePartsFn = (m, o) => {
  const parts = m.parts;
  const n = parts.length;
  if (n === 0) return { model: m, renames: {} };
  const keep = o?.keepIds;
  const kept = parts.map((p) => keep?.has(p.id) === true);
  const graph = attachGraph(parts);
  const info: Info[] = parts.map((p) => {
    const bounds = worldBounds(p);
    const volume = partVolume(p);
    return { center: partCenter(p), bounds, volume: Number.isFinite(volume) ? volume : 0, size: Math.max(...boundsSize(bounds)) };
  });
  const all = modelBounds(m);
  const height = all.max[1] - all.min[1];

  const names = new Array<string | undefined>(n).fill(undefined);
  const taken = new Set<string>();
  parts.forEach((p, i) => {
    if (kept[i]) {
      names[i] = p.id;
      taken.add(p.id);
    }
  });
  const give = (i: number, name: string): boolean => {
    if (names[i] !== undefined || taken.has(name)) return false;
    names[i] = name;
    taken.add(name);
    return true;
  };
  /** Names a pair `<base>_l` / `<base>_r`; a member that is kept, or whose name is taken, is left for later. */
  const givePair = (pair: Pair, base: string): void => {
    give(pair[0], `${base}_l`);
    give(pair[1], `${base}_r`);
  };

  const root = chooseRoot(parts);
  give(root, 'body');
  const plane = info[root].center[0];
  const pairsOf = new Map<number, Pair[]>();
  const pairs = (parent: number): Pair[] => {
    let found = pairsOf.get(parent);
    if (!found) {
      found = findPairs(parts, info, graph.children[parent], plane);
      pairsOf.set(parent, found);
    }
    return found;
  };
  const singles = (parent: number): number[] => {
    const paired = new Set(pairs(parent).flat());
    return graph.children[parent].filter((c) => !paired.has(c));
  };
  const byVolume = (a: number, b: number): number => info[b].volume - info[a].volume || a - b;

  // The head: a part that already says so, else the neck-split upper piece by geometry.
  let head = parts.findIndex((p, i) => i !== root && p.id === 'head');
  if (head < 0) head = parts.findIndex((p, i) => i !== root && typeof p.label === 'string' && p.label.trim().toLowerCase() === 'head');
  if (head < 0) {
    const above = singles(root)
      .filter((c) => info[c].center[1] > info[root].center[1] && info[c].volume >= 0.15 * info[root].volume)
      .sort(byVolume);
    head = above.length > 0 ? above[0] : -1;
  }
  if (head >= 0) give(head, 'head');

  // Pairs on the body: those that reach the ground first (back to front), then the others by height.
  const bodyPairs = pairs(root).map((pair) => {
    const lowest = Math.min(info[pair[0]].bounds.min[1], info[pair[1]].bounds.min[1]);
    return {
      pair,
      onGround: lowest <= all.min[1] + 0.15 * height,
      y: (info[pair[0]].center[1] + info[pair[1]].center[1]) / 2,
      z: (info[pair[0]].center[2] + info[pair[1]].center[2]) / 2,
    };
  });
  const ground = bodyPairs.filter((p) => p.onGround).sort((a, b) => a.z - b.z || a.pair[0] - b.pair[0]);
  const others = bodyPairs.filter((p) => !p.onGround).sort((a, b) => a.y - b.y || a.pair[0] - b.pair[0]);
  let limb = 0; // 0 → arm, then limb2, limb3, …
  [...ground, ...others].forEach((entry, k) => {
    if (k === 0 && entry.onGround) {
      givePair(entry.pair, 'leg');
      return;
    }
    givePair(entry.pair, limb === 0 ? 'arm' : `limb${limb + 1}`);
    limb++;
  });

  if (head >= 0) {
    // Ears: the highest pair above the head's center.
    const up = pairs(head)
      .map((pair) => ({ pair, y: (info[pair[0]].center[1] + info[pair[1]].center[1]) / 2, volume: info[pair[0]].volume + info[pair[1]].volume }))
      .filter((p) => p.y > info[head].center[1])
      .sort((a, b) => b.y - a.y || b.volume - a.volume || a.pair[0] - b.pair[0]);
    if (up.length > 0) givePair(up[0].pair, 'ear');
    // Muzzle: a single child in front of the head.
    const depth = info[head].bounds.max[2] - info[head].bounds.min[2];
    const front = singles(head)
      .filter((c) => info[c].center[2] > info[head].center[2] + depth / 4)
      .sort(byVolume);
    if (front.length > 0) give(front[0], 'muzzle');
  }

  // Tail: a single child behind the body.
  const bodyDepth = info[root].bounds.max[2] - info[root].bounds.min[2];
  const behind = singles(root)
    .filter((c) => c !== head && info[c].center[2] < info[root].center[2] - bodyDepth / 4)
    .sort(byVolume);
  if (behind.length > 0) give(behind[0], 'tail');

  // Everything else: part_1, part_2, … by decreasing volume.
  const rest = parts.map((_, i) => i).filter((i) => names[i] === undefined);
  rest.sort(byVolume);
  let next = 1;
  for (const i of rest) {
    while (taken.has(`part_${next}`)) next++;
    give(i, `part_${next}`);
  }

  const newId = names.map((name, i) => name ?? parts[i].id);
  const renames: Record<string, string> = {};
  const map = new Map<string, string>();
  parts.forEach((p, i) => {
    if (newId[i] !== p.id && !map.has(p.id)) {
      map.set(p.id, newId[i]);
      Object.defineProperty(renames, p.id, { value: newId[i], enumerable: true, writable: true, configurable: true });
    }
  });
  if (map.size === 0) return { model: m, renames };
  return { model: renameReferences(m, newId, map), renames };
};
