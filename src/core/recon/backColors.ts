// Track T3 — single-image back colors (DESIGN.md §2.9.6, §2.9.7 step 7): what the unseen side of each part takes,
// after part decomposition. `ReconSettings.backColors`:
//   'part'   — every unseen vertex of a part takes the part's dominant photo label, computed without the vertices
//              whose label came from a protected component when `oneSidedDetail` is on (with it off they count);
//   'mirror' — the label of the mirror point across the photo plane. In an orthographic photo the mirror point has
//              the same pixel as the vertex itself, so the caller passes that pixel's label (`mirrorLabel`); with
//              `oneSidedDetail` on, a protected pixel gives its component's surrounding label instead;
//   'solid'  — `SOLID_LABEL` (the caller maps it to `solidColor`);
//   'photo'  — nothing (a back photo was added: two-view mode).
// Whatever is still unlabeled is filled breadth first from labeled neighbors along the mesh edges (`fillFromNeighbors`,
// also the multi-view rule for vertices no view sees).
import type { ReconSettings } from '../../types/geometry';

/** The label of a vertex painted with `ReconSettings.solidColor`. */
export const SOLID_LABEL = -2;

export interface PartLabels {
  /** Per vertex: photo label (≥ 0), `SOLID_LABEL`, or −1 = unknown. Filled in place. */
  label: Int16Array;
  /** Per vertex: seen by the photo. */
  seen: Uint8Array;
  /** Per vertex: its label came from a protected component. */
  protectedV: Uint8Array;
  /** 'mirror': per vertex, the label of its mirror point (−1 = outside the eroded mask). */
  mirrorLabel?: Int16Array;
}

/** The most common label among the vertices `use(v)` accepts (ties → the lower label); −1 when none. */
export function dominantLabel(label: ArrayLike<number>, use: (v: number) => boolean): number {
  const counts = new Map<number, number>();
  for (let v = 0; v < label.length; v++) if (label[v] >= 0 && use(v)) counts.set(label[v], (counts.get(label[v]) ?? 0) + 1);
  let best = -1;
  let bestN = 0;
  for (const [l, n] of [...counts].sort((a, b) => a[0] - b[0])) if (n > bestN) (best = l), (bestN = n);
  return best;
}

/** Fills the unseen vertices of one part per `mode` (§2.9.6), then breadth first from neighbors. */
export function fillBackColors(part: PartLabels, indices: ArrayLike<number>, mode: ReconSettings['backColors'], oneSidedDetail: boolean): void {
  const { label, seen, protectedV } = part;
  const nv = label.length;
  if (mode === 'part') {
    let dom = dominantLabel(label, (v) => seen[v] === 1 && !(oneSidedDetail && protectedV[v] === 1));
    if (dom < 0) dom = dominantLabel(label, (v) => seen[v] === 1);
    if (dom >= 0) for (let v = 0; v < nv; v++) if (!seen[v]) label[v] = dom;
  } else if (mode === 'mirror' && part.mirrorLabel) {
    for (let v = 0; v < nv; v++) if (!seen[v] && part.mirrorLabel[v] >= 0) label[v] = part.mirrorLabel[v];
  } else if (mode === 'solid') {
    for (let v = 0; v < nv; v++) if (!seen[v]) label[v] = SOLID_LABEL;
  }
  fillFromNeighbors(label, indices);
}

/** Breadth-first fill of −1 labels from labeled neighbors along the mesh edges (ties → the lower label). */
export function fillFromNeighbors(label: Int16Array, indices: ArrayLike<number>): void {
  const nv = label.length;
  const adjStart = new Int32Array(nv + 1);
  for (let t = 0; t < indices.length; t++) adjStart[indices[t] + 1] += 2;
  for (let v = 0; v < nv; v++) adjStart[v + 1] += adjStart[v];
  const adj = new Int32Array(adjStart[nv]);
  const fill = adjStart.slice(0, nv);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    adj[fill[a]++] = b;
    adj[fill[a]++] = c;
    adj[fill[b]++] = a;
    adj[fill[b]++] = c;
    adj[fill[c]++] = a;
    adj[fill[c]++] = b;
  }
  let frontier: number[] = [];
  for (let v = 0; v < nv; v++) if (label[v] === -1) frontier.push(v);
  while (frontier.length > 0) {
    const assign: [number, number][] = [];
    const next: number[] = [];
    for (const v of frontier) {
      const counts = new Map<number, number>();
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const l = label[adj[k]];
        if (l !== -1) counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = -1;
      let bestN = 0;
      for (const [l, n] of counts) if (n > bestN || (n === bestN && l < best)) (best = l), (bestN = n);
      if (bestN > 0) assign.push([v, best]);
      else next.push(v);
    }
    if (assign.length === 0) break;
    for (const [v, l] of assign) label[v] = l;
    frontier = next;
  }
}
