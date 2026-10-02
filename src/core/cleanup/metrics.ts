// Workability metrics of a chart (DESIGN.md §2.5 "Metrics"; research 06 §6.1). Track T1, sprint T1.3.
// Every metric is a pure function of the labels (plus the source colors for fidelity); nothing reads Date or
// Math.random.
//
// Definitions (docs/tracks/t1.md, T1.3 decisions):
//   - confetti: a cell with 0 same-label 4-neighbors and ≤ 1 same-label 8-neighbor — exactly the cells cleanup
//     step 1 replaces (protected cells count too: the metric describes the chart as worked);
//   - color changes of a line: label changes between consecutive cells along the working path, + the seam of a
//     round (last cell vs first);
//   - strands (bobbins, §2.7.3): bobbin techniques (graph, hdc, mosaic) group a line's runs of one color across
//     gaps of ≤ 8 stitches (carried) into segments; a segment continues a strand of the line before when that
//     line has a segment of the same color with a run overlapping one of its runs widened by 2 stitches (one to
//     one, largest overlap first); otherwise it starts a new strand. C2C tiles are not carried (every run is a
//     segment) and continue across ±1 column. Tapestry (§2.7.4): a color is joined at the first line that needs it
//     and cut after a line when it is absent from the next 2 lines; each join is a strand;
//   - strands held in a line ("carried colors per row"): bobbin techniques = the line's segments; tapestry = the
//     colors held (joined, not yet cut) while the line is worked;
//   - fidelity: mean ΔE00 between every cell's source color and its label's color;
//   - workability (display only): clamp(100 − 300·confetti − 4·max(0, chg̅ − 2) − 0.2·max(0, strands − 10) −
//     5·max(0, carriedMax − 2), 0, 100), confetti as a share (0–1), strands = Σ strands, rounded to an integer.
import type { ChartGrid, ChartMetrics, ChartSettings } from '../../types/chart';
import type { Technique2D } from '../../types/gauge';
import { ciede2000, hexToLab } from '../kernel/color';
import { TAPESTRY_TECHNIQUES, type WorkingPath, workingPath } from './params';

/** Longest gap a color is carried across inside a line (§2.7.3: 8 stitches). */
export const CARRY_GAP = 8;
/** How far a run may sit beside a run of the line before and still continue its strand (§2.7.3). */
export const STRAND_REACH = 2;
/** Tapestry: a color absent from this many following lines is cut (§2.7.4). */
export const TAPESTRY_CUT_AFTER = 2;
/** How many busiest lines the metrics list. */
export const BUSIEST_LINES = 3;

/** Neighbor offsets: the four edge neighbors first, then the four corners. */
const NEIGHBORS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * Calls `fn(j, edge)` for every neighbor j of cell i (edge = a 4-neighbor). With `wrap` the columns wrap around
 * (rounds; only when there are at least 3 columns, so no cell is its own neighbor).
 */
export function forNeighbors(i: number, cols: number, rows: number, wrap: boolean, fn: (j: number, edge: boolean) => void): void {
  const r = Math.floor(i / cols);
  const c = i - r * cols;
  const w = wrap && cols >= 3;
  for (let k = 0; k < 8; k++) {
    const rr = r + NEIGHBORS[k][0];
    let cc = c + NEIGHBORS[k][1];
    if (rr < 0 || rr >= rows) continue;
    if (cc < 0 || cc >= cols) {
      if (!w) continue;
      cc = (cc + cols) % cols;
    }
    fn(rr * cols + cc, k < 4);
  }
}

/**
 * Same-label neighbor counts of cell i: `s4` among the edge neighbors, `s8` among all eight; `any` = the cell
 * has a neighbor at all. Inlined (no closure) because confetti is measured after every stage.
 */
export function sameNeighbors(labels: Uint8Array, cols: number, rows: number, i: number, wrap: boolean): { s4: number; s8: number; any: boolean } {
  const r = Math.floor(i / cols);
  const c = i - r * cols;
  const own = labels[i];
  const w = wrap && cols >= 3;
  const cl = c > 0 ? c - 1 : w ? cols - 1 : -1;
  const cr = c < cols - 1 ? c + 1 : w ? 0 : -1;
  let s4 = 0;
  let s8 = 0;
  const up = r > 0 ? (r - 1) * cols : -1;
  const dn = r < rows - 1 ? (r + 1) * cols : -1;
  const me = r * cols;
  if (cl >= 0 && labels[me + cl] === own) s4++;
  if (cr >= 0 && labels[me + cr] === own) s4++;
  if (up >= 0) {
    if (labels[up + c] === own) s4++;
    if (cl >= 0 && labels[up + cl] === own) s8++;
    if (cr >= 0 && labels[up + cr] === own) s8++;
  }
  if (dn >= 0) {
    if (labels[dn + c] === own) s4++;
    if (cl >= 0 && labels[dn + cl] === own) s8++;
    if (cr >= 0 && labels[dn + cr] === own) s8++;
  }
  const any = cl >= 0 || cr >= 0 || up >= 0 || dn >= 0;
  return { s4, s8: s8 + s4, any };
}

/** True when cell i is confetti: 0 same-label 4-neighbors and ≤ 1 same-label 8-neighbor (§2.5 step 1). */
export function isConfetti(labels: Uint8Array, cols: number, rows: number, i: number, wrap = false): boolean {
  const { s4, s8, any } = sameNeighbors(labels, cols, rows, i, wrap);
  return any && s4 === 0 && s8 <= 1;
}

/** Share (0–1) of the cells that are confetti. */
export function confettiShare(labels: Uint8Array, cols: number, rows: number, wrap = false): number {
  const n = cols * rows;
  if (n === 0) return 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    // Most cells have a same-label edge neighbor: test the row first.
    const c = i % cols;
    if ((c > 0 && labels[i - 1] === labels[i]) || (c < cols - 1 && labels[i + 1] === labels[i])) continue;
    if (isConfetti(labels, cols, rows, i, wrap)) k++;
  }
  return k / n;
}

/** Color changes of every line along the working path (a round counts its seam). */
export function lineChanges(labels: Uint8Array, path: Pick<WorkingPath, 'lines' | 'circular'>): Int32Array {
  const out = new Int32Array(path.lines.length);
  path.lines.forEach((line, k) => {
    let ch = 0;
    for (let p = 1; p < line.length; p++) if (labels[line[p]] !== labels[line[p - 1]]) ch++;
    if (path.circular && line.length > 2 && labels[line[0]] !== labels[line[line.length - 1]]) ch++;
    out[k] = ch;
  });
  return out;
}

/** Mean, max and the busiest lines (1-based line numbers in working order, most changes first, ties → first). */
export function changeStats(changes: Int32Array): { mean: number; max: number; busiest: number[] } {
  if (changes.length === 0) return { mean: 0, max: 0, busiest: [] };
  let sum = 0;
  let max = 0;
  for (const c of changes) {
    sum += c;
    max = Math.max(max, c);
  }
  const busiest = [...changes.keys()]
    .filter((k) => changes[k] > 0)
    .sort((a, b) => changes[b] - changes[a] || a - b)
    .slice(0, BUSIEST_LINES)
    .map((k) => k + 1);
  return { mean: sum / changes.length, max, busiest };
}

interface Run {
  label: number;
  x0: number;
  x1: number;
}

/** Runs of one line, by position x (the strand axis); a run wrapping a round's seam is split there. */
function lineRuns(labels: Uint8Array, line: Int32Array, x: Int32Array): Run[] {
  const runs: Run[] = [];
  const n = line.length;
  // Rows are listed by x; C2C diagonals by row, so x runs one way or the other.
  const rev = n > 1 && x[line[0]] > x[line[n - 1]];
  for (let q = 0; q < n; q++) {
    const i = line[rev ? n - 1 - q : q];
    const l = labels[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.label === l && last.x1 === x[i] - 1) last.x1 = x[i];
    else runs.push({ label: l, x0: x[i], x1: x[i] });
  }
  return runs;
}

/** What `strandStats` returns. */
export interface StrandStats {
  /** Strands started per label (index = label). */
  strandsPerColor: number[];
  /** Strands held in every line (index = line). */
  heldPerLine: Int32Array;
}

/** Strands per color and strands held per line (see the file header for the rules of each family). */
export function strandStats(labels: Uint8Array, labelCount: number, path: Pick<WorkingPath, 'lines' | 'x'>, technique: Technique2D): StrandStats {
  const strands = new Array<number>(labelCount).fill(0);
  const held = new Int32Array(path.lines.length);
  if (TAPESTRY_TECHNIQUES.has(technique)) {
    const present = path.lines.map((line) => {
      const s = new Uint8Array(labelCount);
      for (const i of line) s[labels[i]] = 1;
      return s;
    });
    for (let l = 0; l < labelCount; l++) {
      let holding = false;
      for (let k = 0; k < path.lines.length; k++) {
        if (present[k][l] && !holding) {
          holding = true;
          strands[l]++;
        }
        if (holding) held[k]++;
        if (holding) {
          let needed = false;
          for (let q = k + 1; q <= Math.min(path.lines.length - 1, k + TAPESTRY_CUT_AFTER); q++) if (present[q][l]) needed = true;
          if (!needed) holding = false;
        }
      }
    }
    return { strandsPerColor: strands, heldPerLine: held };
  }
  const c2c = technique === 'c2c';
  const gapMax = c2c ? 0 : CARRY_GAP;
  const reach = c2c ? 1 : STRAND_REACH;
  /** The line before: its runs by label (sorted by x, disjoint), each with its segment number. */
  let prevRuns = new Map<number, { x0: number; x1: number; seg: number }[]>();
  let prevCount = 0;
  path.lines.forEach((line, k) => {
    const runs = lineRuns(labels, line, path.x);
    // Segments: runs of one color joined across gaps of ≤ gapMax stitches.
    const segOf: number[] = [];
    const segLabel: number[] = [];
    const open = new Map<number, number>();
    const lastX1 = new Map<number, number>();
    for (const r of runs) {
      const s = open.get(r.label);
      if (s !== undefined && r.x0 - lastX1.get(r.label)! - 1 <= gapMax) segOf.push(s);
      else {
        open.set(r.label, segLabel.length);
        segOf.push(segLabel.length);
        segLabel.push(r.label);
      }
      lastX1.set(r.label, r.x1);
    }
    held[k] = segLabel.length;
    // Overlaps with the line before (runs widened by `reach`), summed per (segment, segment before).
    const ov = new Map<number, number>();
    runs.forEach((a, q) => {
      const list = prevRuns.get(a.label);
      if (list === undefined) return;
      const lo0 = a.x0 - reach;
      const hi0 = a.x1 + reach;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].x1 < lo0) lo = mid + 1;
        else hi = mid;
      }
      for (let t = lo; t < list.length && list[t].x0 <= hi0; t++) {
        const b = list[t];
        const o = Math.min(hi0, b.x1) - Math.max(lo0, b.x0) + 1;
        if (o > 0) {
          const key = segOf[q] * (prevCount + 1) + b.seg;
          ov.set(key, (ov.get(key) ?? 0) + o);
        }
      }
    });
    // One-to-one continuation, largest overlap first (ties → the earlier segment, then the earlier one before).
    const pairs = [...ov.entries()].map(([key, o]) => ({ s: Math.floor(key / (prevCount + 1)), p: key % (prevCount + 1), o }));
    pairs.sort((a, b) => b.o - a.o || a.s - b.s || a.p - b.p);
    const sDone = new Uint8Array(segLabel.length);
    const pDone = new Uint8Array(prevCount);
    for (const { s, p } of pairs) {
      if (sDone[s] || pDone[p]) continue;
      sDone[s] = 1;
      pDone[p] = 1;
    }
    for (let s = 0; s < segLabel.length; s++) if (!sDone[s]) strands[segLabel[s]]++;
    prevRuns = new Map();
    runs.forEach((r, q) => {
      let list = prevRuns.get(r.label);
      if (list === undefined) prevRuns.set(r.label, (list = []));
      list.push({ x0: r.x0, x1: r.x1, seg: segOf[q] });
    });
    prevCount = segLabel.length;
  });
  return { strandsPerColor: strands, heldPerLine: held };
}

/** Mean ΔE00 between every cell's source color (`cellLab`, 3 per cell) and its label's color. */
export function fidelityDE00(labels: Uint8Array, paletteLab: readonly ArrayLike<number>[], cellLab: ArrayLike<number>, cache?: FidelityCache): number {
  const n = labels.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (cache !== undefined && cache.label[i] === l) {
      sum += cache.de[i];
      continue;
    }
    const lab = [cellLab[i * 3], cellLab[i * 3 + 1], cellLab[i * 3 + 2]];
    const de = ciede2000(lab, paletteLab[l]);
    if (cache !== undefined) {
      cache.label[i] = l;
      cache.de[i] = de;
    }
    sum += de;
  }
  return sum / n;
}

/** Per-cell ΔE00 memo for `fidelityDE00` across cleanup stages (valid while the palette does not change). */
export interface FidelityCache {
  /** Label the stored ΔE00 belongs to (256 = none). */
  label: Uint16Array;
  de: Float64Array;
}

export function fidelityCache(n: number): FidelityCache {
  return { label: new Uint16Array(n).fill(256), de: new Float64Array(n) };
}

/** The display-only Workability score (§2.5), an integer 0–100. `confetti` is a share (0–1). */
export function workabilityScore(m: { confetti: number; changesMean: number; strands: number; carriedMax: number }): number {
  const raw = 100 - 300 * m.confetti - 4 * Math.max(0, m.changesMean - 2) - 0.2 * Math.max(0, m.strands - 10) - 5 * Math.max(0, m.carriedMax - 2);
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/** Options of `chartMetrics`. */
export interface MetricsOptions {
  technique: Technique2D;
  startCorner?: ChartSettings['startCorner'];
  /** Source color of every cell (CIELAB, 3 per cell); without it fidelity is 0. */
  cellLab?: ArrayLike<number>;
  /** The working path, when the caller has it. */
  path?: WorkingPath;
  /** Lab of every palette entry, when the caller has it. */
  paletteLab?: readonly ArrayLike<number>[];
  fidelity?: FidelityCache;
}

/**
 * Every §2.5 metric of a chart. `confettiPct` is a percentage (0–100); `busiestRows` are 1-based line numbers in
 * working order (Row k / Rnd k = chart row `rows − k`; C2C: diagonal k from the start corner); `strandsPerColor`
 * is indexed by palette entry; `ends` = 2 × Σ strands; `carriedPerRowMax` = the most strands held in one line.
 */
export function chartMetrics(grid: ChartGrid, o: MetricsOptions): ChartMetrics {
  const { cols, rows, labels } = grid;
  const path = o.path ?? workingPath(o.technique, cols, rows, o.startCorner);
  const confetti = confettiShare(labels, cols, rows, path.wrap);
  const ch = changeStats(lineChanges(labels, path));
  const st = strandStats(labels, grid.palette.length, path, o.technique);
  const strands = st.strandsPerColor.reduce((a, b) => a + b, 0);
  let carriedMax = 0;
  for (const h of st.heldPerLine) carriedMax = Math.max(carriedMax, h);
  const paletteLab = o.paletteLab ?? grid.palette.map((p) => hexToLab(p.hex));
  const fidelity = o.cellLab !== undefined ? fidelityDE00(labels, paletteLab, o.cellLab, o.fidelity) : 0;
  return {
    confettiPct: 100 * confetti,
    changesPerRowMean: ch.mean,
    changesPerRowMax: ch.max,
    busiestRows: ch.busiest,
    strandsPerColor: st.strandsPerColor,
    ends: 2 * strands,
    carriedPerRowMax: carriedMax,
    fidelityDE00: fidelity,
    workability: workabilityScore({ confetti, changesMean: ch.mean, strands, carriedMax }),
  };
}
