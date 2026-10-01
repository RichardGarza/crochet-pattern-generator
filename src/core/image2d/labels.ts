// Flat-art sampling on labels (DESIGN.md §2.3.4 "Flat"; research 06 §4.2). Track T1, sprint T1.1. Pure.
//
// Flat art is quantized at source resolution (T1.2, §2.4) into a label image; this module turns that label
// image into cell labels:
//   1. `despeckleLabels` — the "3×3 median on labels" (light denoise of JPEG speckle);
//   2. `poolLabels` — per cell the area-weighted label mode, with thin-feature protection: label components
//      whose maximum distance transform is below half a cell and whose skeleton spans ≥ 2 cells win any cell
//      their skeleton crosses with ≥ 15% coverage; diagonal-only links get one bridging cell. Thin cells are
//      returned as a mask that joins cleanup's protect mask (§2.5).
//
// Resolved ambiguities (docs/tracks/t1.md):
//   - a median is undefined on categorical labels; the filter is a conservative 3×3 mode filter that only
//     replaces a pixel whose own label fills at most 2 of its 9-pixel window (isolated speckle) — a plain
//     majority filter would erase every 1-px line before thin-feature protection could keep it;
//   - components are 8-connected (a diagonal line is one feature);
//   - distance transform: distance from each pixel to the nearest pixel whose 4-neighborhood holds another
//     label, + 1 (an upper bound of the distance to the component's outside within one pixel); "half a cell"
//     is half the larger cell side in pixels;
//   - skeleton = the ridge of that distance (pixels at least as far as each 8-neighbor of the same component);
//   - coverage = share of the cell's area covered by the component; a cell several thin components claim goes
//     to the one with the largest coverage (ties → lowest label);
//   - the 15% claim threshold is lowered, per component and cell, to the coverage of a crossing of half the
//     cell's smaller side (width estimated as 2·area / exposed sides): a 2-px line crossing a 15-px cell
//     straight covers only 13%, and 1-px lines would vanish from every cell larger than 6.7 px;
//   - a skeleton cell that joins two otherwise separate groups of the feature's cells is claimed too;
//   - a component covering more than 40% of the cells it touches is a texture (dither, fine checker, label
//     noise), not a thin feature — otherwise the protect mask would cover whole regions; and a component
//     shorter than a cell (length ≈ exposed sides / 2) is a speck.
import { edt2d } from '../kernel/geom/edt';
import { checkSpans } from './linear';
import type { Spans } from './types';

/** Label of a pixel or cell with no label (background, §2.3.2). Real labels are 0..254. */
export const NO_LABEL = 255;
/** Share of a cell a thin component must cover to win it (§2.3.4). */
export const THIN_MIN_COVERAGE = 0.15;
/** A thin component covering more than this share of the cells it touches is a texture, not a feature. */
export const THIN_MAX_DENSITY = 0.4;
/** A pixel whose label fills at most this many pixels of its 3×3 window is speckle. */
export const SPECKLE_MAX = 2;

function checkLabels(labels: Uint8Array, w: number, h: number, fn: string): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || labels.length !== w * h) {
    throw new RangeError(`${fn}: labels must hold w·h = ${w * h} entries for a ${w} × ${h} image`);
  }
}

/**
 * Conservative 3×3 mode filter (the "3×3 median on labels" of §2.3.4): a pixel whose label fills at most two
 * pixels of its 3×3 window (itself included) takes the window's most frequent label (ties → the lowest
 * label); every other pixel keeps its label. NO_LABEL pixels never change and never count.
 */
export function despeckleLabels(labels: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  checkLabels(labels, w, h, 'despeckleLabels');
  const out = new Uint8Array(labels);
  const count = new Uint16Array(256);
  const seen: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = labels[i];
      if (own === NO_LABEL) continue;
      seen.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const l = labels[yy * w + xx];
          if (l === NO_LABEL) continue;
          if (count[l] === 0) seen.push(l);
          count[l]++;
        }
      }
      if (count[own] <= SPECKLE_MAX) {
        let best = own;
        let bestN = count[own];
        for (const l of seen) {
          if (count[l] > bestN || (count[l] === bestN && l < best)) {
            best = l;
            bestN = count[l];
          }
        }
        out[i] = best;
      }
      for (const l of seen) count[l] = 0;
    }
  }
  return out;
}

/** For every pixel along an axis, the first cell whose span contains its center (−1 if none). */
function cellOfPixel(s: Spans, n: number): Int32Array {
  const out = new Int32Array(n).fill(-1);
  for (let k = 0; k < s.start.length; k++) {
    for (let p = Math.max(0, Math.floor(s.start[k] - 0.5)); p < Math.min(n, Math.ceil(s.end[k])); p++) {
      const c = p + 0.5;
      if (out[p] < 0 && c >= s.start[k] && c < s.end[k]) out[p] = k;
    }
  }
  return out;
}

/** Overlap of every pixel with the cells along an axis: for pixel p, pairs (cell, overlap in px). */
function overlaps(s: Spans, n: number): { cells: number[][]; w: number[][] } {
  const cells: number[][] = Array.from({ length: n }, () => []);
  const w: number[][] = Array.from({ length: n }, () => []);
  for (let k = 0; k < s.start.length; k++) {
    for (let p = Math.floor(s.start[k]); p < Math.ceil(s.end[k]); p++) {
      const o = Math.min(p + 1, s.end[k]) - Math.max(p, s.start[k]);
      if (o > 0) {
        cells[p].push(k);
        w[p].push(o);
      }
    }
  }
  return { cells, w };
}

/** 8-connected components of equal labels (NO_LABEL excluded). Component ids follow scan order. */
export function labelComponents(labels: Uint8Array, w: number, h: number): { comp: Int32Array; count: number; label: number[]; size: number[] } {
  checkLabels(labels, w, h, 'labelComponents');
  const comp = new Int32Array(w * h).fill(-1);
  const label: number[] = [];
  const size: number[] = [];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (comp[s] >= 0 || labels[s] === NO_LABEL) continue;
    const l = labels[s];
    let top = 0;
    stack[top++] = s;
    comp[s] = count;
    let n = 0;
    while (top > 0) {
      const i = stack[--top];
      n++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const j = yy * w + xx;
          if (comp[j] < 0 && labels[j] === l) {
            comp[j] = count;
            stack[top++] = j;
          }
        }
      }
    }
    label.push(l);
    size.push(n);
    count++;
  }
  return { comp, count, label, size };
}

/** What `poolLabels` returns. */
export interface PooledLabels {
  cols: number;
  rows: number;
  /** Row-major cell labels; NO_LABEL where the cell holds no labeled pixel. */
  labels: Uint8Array<ArrayBuffer>;
  /** 1 = the cell was given to a thin feature (or bridges one): it joins the protect mask (§2.5). */
  thin: Uint8Array<ArrayBuffer>;
}

/**
 * Per cell the area-weighted label mode of `labels` (a `w × h` label image) over the cell's source rectangle
 * `[xs.start[j], xs.end[j]) × [ys.start[i], ys.end[i])` (ties → the lowest label; NO_LABEL pixels are
 * ignored), then thin-feature protection (see the file header) unless `o.thin === false`.
 */
export function poolLabels(labels: Uint8Array, w: number, h: number, xs: Spans, ys: Spans, o: { thin?: boolean } = {}): PooledLabels {
  checkLabels(labels, w, h, 'poolLabels');
  checkSpans(xs, w, 'poolLabels: column');
  checkSpans(ys, h, 'poolLabels: row');
  const cols = xs.start.length;
  const rows = ys.start.length;
  const out = new Uint8Array(cols * rows).fill(NO_LABEL);
  const thin = new Uint8Array(cols * rows);
  const hist = new Float64Array(256);
  const seen: number[] = [];
  for (let i = 0; i < rows; i++) {
    const y0 = ys.start[i];
    const y1 = ys.end[i];
    for (let j = 0; j < cols; j++) {
      const x0 = xs.start[j];
      const x1 = xs.end[j];
      seen.length = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (!(wy > 0)) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const l = labels[y * w + x];
          if (l === NO_LABEL) continue;
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (!(wx > 0)) continue;
          if (hist[l] === 0) seen.push(l);
          hist[l] += wx * wy;
        }
      }
      let best = NO_LABEL;
      let bestW = 0;
      for (const l of seen) {
        if (hist[l] > bestW || (hist[l] === bestW && l < best)) {
          best = l;
          bestW = hist[l];
        }
        hist[l] = 0;
      }
      out[i * cols + j] = best;
    }
  }
  if (o.thin !== false) protectThin(labels, w, h, xs, ys, out, thin);
  return { cols, rows, labels: out, thin };
}

/** True when the cells around `cell` owned by `c` form ≥ 2 groups that do not touch each other. */
function joinsGroups(owner: Int32Array, c: number, cell: number, cols: number, rows: number): boolean {
  const i = Math.floor(cell / cols);
  const j = cell - i * cols;
  // The 8 neighbors in ring order; two owned neighbors next to each other in the ring touch.
  const ring = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
    [0, -1],
  ];
  const own = ring.map(([di, dj]) => {
    const ii = i + di;
    const jj = j + dj;
    return ii >= 0 && ii < rows && jj >= 0 && jj < cols && owner[ii * cols + jj] === c;
  });
  // Count runs of owned neighbors around the ring; corner cells also touch the edge cells two steps away.
  let groups = 0;
  for (let k = 0; k < 8; k++) if (own[k] && !own[(k + 7) % 8]) groups++;
  if (groups === 0 && own.every(Boolean)) groups = 1;
  // Two runs separated only by an empty corner still touch (edge cells k−1 and k+1 around corner k).
  for (let k = 0; k < 8; k += 2) {
    if (!own[k] && own[(k + 7) % 8] && own[(k + 1) % 8]) groups--;
  }
  return groups >= 2;
}

/** Thin-feature protection (§2.3.4), in place on `out` / `thin`. */
function protectThin(labels: Uint8Array, w: number, h: number, xs: Spans, ys: Spans, out: Uint8Array, thin: Uint8Array): void {
  const cols = xs.start.length;
  const rows = ys.start.length;
  let cellW = 0;
  for (let j = 0; j < cols; j++) cellW += xs.end[j] - xs.start[j];
  let cellH = 0;
  for (let i = 0; i < rows; i++) cellH += ys.end[i] - ys.start[i];
  const half = 0.5 * Math.max(cellW / cols, cellH / rows);
  // A cell smaller than two pixels cannot lose a feature that is at least a pixel wide to the mode.
  if (half < 1) return;

  const { comp, count, label, size } = labelComponents(labels, w, h);
  // Boundary pixels: a 4-neighbor holds another label (image edges are not boundaries). `sides` counts the
  // exposed pixel sides of every component: a band of width t and length L has about 2L of them, so
  // 2·area / sides estimates its width.
  const boundary = new Uint8Array(w * h);
  const sides = new Float64Array(count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (l === NO_LABEL) continue;
      const e = (x > 0 && labels[i - 1] !== l ? 1 : 0) + (x < w - 1 && labels[i + 1] !== l ? 1 : 0) + (y > 0 && labels[i - w] !== l ? 1 : 0) + (y < h - 1 && labels[i + w] !== l ? 1 : 0);
      if (e > 0) {
        boundary[i] = 1;
        sides[comp[i]] += e;
      }
    }
  }
  const d = edt2d(boundary, w, h);
  const maxT = new Float64Array(count);
  for (let i = 0; i < w * h; i++) {
    const c = comp[i];
    if (c >= 0) maxT[c] = Math.max(maxT[c], (Number.isFinite(d[i]) ? d[i] : w + h) + 1);
  }
  const isThin = new Uint8Array(count);
  for (let c = 0; c < count; c++) isThin[c] = maxT[c] < half ? 1 : 0;

  const colOf = cellOfPixel(xs, w);
  const rowOf = cellOfPixel(ys, h);
  // Skeleton cells of every thin component.
  const skeletonCells = new Map<number, Set<number>>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = comp[i];
      if (c < 0 || !isThin[c] || rowOf[y] < 0 || colOf[x] < 0) continue;
      let ridge = true;
      for (let dy = -1; dy <= 1 && ridge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (comp[j] === c && d[j] > d[i]) {
            ridge = false;
            break;
          }
        }
      }
      if (!ridge) continue;
      let set = skeletonCells.get(c);
      if (set === undefined) skeletonCells.set(c, (set = new Set()));
      set.add(rowOf[y] * cols + colOf[x]);
    }
  }
  let eligible: number[] = [];
  for (const [c, cells] of skeletonCells) if (cells.size >= 2) eligible.push(c);
  if (eligible.length === 0) return;
  eligible.sort((a, b) => a - b);
  const eligibleSet = new Set(eligible);

  // Coverage of every eligible component in every cell it touches.
  const ox = overlaps(xs, w);
  const oy = overlaps(ys, h);
  const coverage = new Map<number, Map<number, number>>();
  for (const c of eligible) coverage.set(c, new Map());
  for (let y = 0; y < h; y++) {
    if (oy.cells[y].length === 0) continue;
    for (let x = 0; x < w; x++) {
      const c = comp[y * w + x];
      if (c < 0 || !eligibleSet.has(c)) continue;
      const m = coverage.get(c)!;
      for (let a = 0; a < oy.cells[y].length; a++) {
        for (let b = 0; b < ox.cells[x].length; b++) {
          const cell = oy.cells[y][a] * cols + ox.cells[x][b];
          m.set(cell, (m.get(cell) ?? 0) + oy.w[y][a] * ox.w[x][b]);
        }
      }
    }
  }
  const cellArea = (cell: number): number => {
    const i = Math.floor(cell / cols);
    const j = cell - i * cols;
    return (ys.end[i] - ys.start[i]) * (xs.end[j] - xs.start[j]);
  };
  const share = (c: number, cell: number): number => (coverage.get(c)!.get(cell) ?? 0) / cellArea(cell);
  // Textures are not features: a dither, a fine checker or label noise is one 8-connected component whose
  // distance transform is 0 everywhere, but it fills its cells (a line covers ≈ width / cell side of them).
  // Specks are not features either: a thin feature is at least one cell long (length ≈ exposed sides / 2).
  eligible = eligible.filter((c) => {
    let touched = 0;
    for (const cell of coverage.get(c)!.keys()) touched += cellArea(cell);
    return size[c] / touched <= THIN_MAX_DENSITY && sides[c] / 2 >= 2 * half;
  });
  // The claim threshold: 15% (§2.3.4), or — for a line too thin to cover 15% of a large cell even when it
  // crosses it straight — the coverage of a crossing of half the cell's smaller side.
  const claimShare = (c: number, cell: number): number => {
    const i = Math.floor(cell / cols);
    const j = cell - i * cols;
    const side = Math.min(ys.end[i] - ys.start[i], xs.end[j] - xs.start[j]);
    const width = sides[c] > 0 ? (2 * size[c]) / sides[c] : 1;
    return Math.min(THIN_MIN_COVERAGE, (0.5 * width * side) / cellArea(cell));
  };

  // Claims: a thin component wins the skeleton cells it covers enough; the largest coverage wins a cell.
  const claim = new Map<number, { c: number; cov: number }>();
  for (const c of eligible) {
    const cells = [...skeletonCells.get(c)!].sort((a, b) => a - b);
    for (const cell of cells) {
      const cov = share(c, cell);
      if (cov < claimShare(c, cell)) continue;
      const prev = claim.get(cell);
      if (prev === undefined || cov > prev.cov || (cov === prev.cov && label[c] < label[prev.c])) claim.set(cell, { c, cov });
    }
  }
  const owner = new Int32Array(cols * rows).fill(-1);
  for (const cell of [...claim.keys()].sort((a, b) => a - b)) {
    const { c } = claim.get(cell)!;
    out[cell] = label[c];
    thin[cell] = 1;
    owner[cell] = c;
  }

  // Gaps: where the feature crosses a cell corner its coverage splits between neighboring cells and none
  // reaches 15%. A skeleton cell whose claimed neighbors (8-neighborhood, same component) fall into two or
  // more groups that do not touch is claimed too, so the feature stays connected (largest coverage first).
  for (const c of eligible) {
    for (let pass = 0; pass < 8; pass++) {
      const open = [...skeletonCells.get(c)!].filter((cell) => owner[cell] !== c && !thin[cell]);
      open.sort((a, b) => share(c, b) - share(c, a) || a - b);
      let changed = false;
      for (const cell of open) {
        if (joinsGroups(owner, c, cell, cols, rows)) {
          out[cell] = label[c];
          thin[cell] = 1;
          owner[cell] = c;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  // Diagonal-only links: two cells of one thin component that touch only at a corner get one bridging cell
  // (the orthogonal neighbor the component covers more; ties → the lower cell index).
  for (const c of eligible) {
    const l = label[c];
    const cells = [...coverage.get(c)!.keys()].filter((cell) => out[cell] === l).sort((a, b) => a - b);
    const mine = new Set(cells);
    for (const cell of cells) {
      const i = Math.floor(cell / cols);
      const j = cell - i * cols;
      if (i + 1 >= rows) continue;
      for (const dj of [-1, 1]) {
        const jj = j + dj;
        if (jj < 0 || jj >= cols) continue;
        const diag = (i + 1) * cols + jj;
        if (!mine.has(diag) || (owner[cell] !== c && owner[diag] !== c)) continue;
        const sideA = i * cols + jj;
        const sideB = (i + 1) * cols + j;
        if (out[sideA] === l || out[sideB] === l) continue;
        const ca = share(c, sideA);
        const cb = share(c, sideB);
        const pick = ca > cb || (ca === cb && sideA < sideB) ? sideA : sideB;
        if (thin[pick] && owner[pick] !== c) continue; // never take another thin feature's cell
        out[pick] = l;
        thin[pick] = 1;
        owner[pick] = c;
        mine.add(pick);
      }
    }
  }
}
