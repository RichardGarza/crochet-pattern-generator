// Track T2 — how the colors of a flat chart are worked: carry or bobbin per color per row, and the strands
// (bobbins) that result (DESIGN.md §2.7.2, §2.7.3; research 07 §3.5).
//
// Rule (§2.7.3): a color that is absent for ≤ 8 stitches and reappears in the same row is carried (worked over)
// through the gap; otherwise its next run is a separate strand. A row's runs of one color joined by such
// carries form a *segment*, worked by one strand. A segment continues a strand of the row before when that row
// has a run of the same color overlapping one of the segment's runs widened by 2 stitches (`[x0 − 2, x1 + 2]`);
// each strand of the row before continues at most once; a strand that is not continued ends (cut). Otherwise the
// segment starts a new strand, printed as `join B (bobbin n)`, n the lowest bobbin number of that color not in use
// in the row, so the highest n is the number of bobbins to wind. The first segment of Row 1 is worked with the
// foundation chain's strand (bobbin 1 of its color).
//
// Coordinates: chart column x (0 = left as displayed) and chart row r (0 = top). Worked row k (1-based) uses chart
// row `rows − k` (§2.7.2). Working order: RH reads odd (RS) rows right → left and even (WS) rows left → right; LH
// the other way. Everything here is pure and deterministic.
import type { ChartGrid, Hand } from '../../types';

/** Longest gap (in stitches) a color is carried across inside a row (§2.7.3, research 07 §3.5: T = 8). */
export const CARRY_MAX = 8;
/** How far (in stitches) a run may sit beside a run of the row before and still continue its strand. */
export const STRAND_REACH = 2;
/** More strands than this in one row raise W_ROW_COLORS (§2.4.3: warn > 6 strands in a row). */
export const ROW_STRANDS_WARN = 6;

/** A run of one color in one chart row, columns `x0..x1` inclusive. */
export interface ColorRun {
  label: number;
  x0: number;
  x1: number;
}

/** The runs of one color in one row that one strand works, with the gaps it is carried across. */
export interface Segment {
  label: number;
  x0: number;
  x1: number;
  runs: ColorRun[];
  /** The gaps between consecutive runs, columns inclusive (the strand is worked over them). */
  gaps: { x0: number; x1: number }[];
  /** Stitches the strand is carried across in this row: Σ gap widths. */
  carried: number;
  /** Strand id, 0-based over the whole chart, in order of creation. */
  strand: number;
  /**
   * The strand's bobbin number among the strands of its color in use at the same time, 1-based (`bobbin n`).
   * A strand that ends frees its number, and the next new strand of that color takes the lowest free number.
   */
  bobbin: number;
  /** True when this segment starts a new strand (`join B (bobbin n)`); false when it continues one. */
  joined: boolean;
}

export interface RowPlan {
  /** Worked row number, 1-based. */
  k: number;
  /** Chart row, `rows − k`. */
  r: number;
  /** True when the row is read right → left. */
  rightToLeft: boolean;
  /** The row's segments in working order (by where each starts). */
  segments: Segment[];
}

export interface StrandPlan {
  rows: RowPlan[];
  /** Strands per palette label: every strand ever started (each has 2 tails to weave in). */
  strandsPerColor: number[];
  /** Bobbins to wind per palette label: the most strands of that color in use at once (the highest bobbin number). */
  bobbinsPerColor: number[];
  /** All strands of the chart. */
  strands: number;
  /** The most segments worked in one row. */
  maxPerRow: number;
}

/** True when worked row k (1-based) is read right → left: RH odd rows, LH even rows (§2.7.2). */
export function readsRightToLeft(k: number, hand: Hand): boolean {
  const odd = k % 2 === 1;
  return hand === 'left' ? !odd : odd;
}

/** The labels of chart row r (a view, not a copy). */
export function chartRow(grid: ChartGrid, r: number): Uint8Array {
  return grid.labels.subarray(r * grid.cols, (r + 1) * grid.cols);
}

/** The maximal runs of one label in chart row r, left to right. */
export function rowRuns(grid: ChartGrid, r: number): ColorRun[] {
  const row = chartRow(grid, r);
  const runs: ColorRun[] = [];
  let x0 = 0;
  for (let x = 1; x <= row.length; x++) {
    if (x === row.length || row[x] !== row[x0]) {
      runs.push({ label: row[x0], x0, x1: x - 1 });
      x0 = x;
    }
  }
  return runs;
}

/** The segments of one row (runs of a color joined across gaps of ≤ carryMax), unnumbered, in no order. */
function rowSegments(runs: readonly ColorRun[], carryMax: number): Omit<Segment, 'strand' | 'bobbin' | 'joined'>[] {
  const byLabel = new Map<number, ColorRun[]>();
  for (const run of runs) {
    const list = byLabel.get(run.label);
    if (list === undefined) byLabel.set(run.label, [run]);
    else list.push(run);
  }
  const out: Omit<Segment, 'strand' | 'bobbin' | 'joined'>[] = [];
  for (const [label, list] of byLabel) {
    let current: Omit<Segment, 'strand' | 'bobbin' | 'joined'> | null = null;
    for (const run of list) {
      const gap = current === null ? Infinity : run.x0 - current.x1 - 1;
      if (current !== null && gap <= carryMax) {
        current.gaps.push({ x0: current.x1 + 1, x1: run.x0 - 1 });
        current.carried += gap;
        current.x1 = run.x1;
        current.runs.push(run);
      } else {
        if (current !== null) out.push(current);
        current = { label, x0: run.x0, x1: run.x1, runs: [run], gaps: [], carried: 0 };
      }
    }
    if (current !== null) out.push(current);
  }
  return out;
}

/** How much a segment's runs, widened by `reach`, overlap a previous segment's runs (0 = not at all). */
function overlap(a: { runs: readonly ColorRun[] }, b: { runs: readonly ColorRun[] }, reach: number): number {
  let total = 0;
  for (const u of a.runs) {
    const lo = u.x0 - reach;
    const hi = u.x1 + reach;
    for (const v of b.runs) {
      const from = Math.max(lo, v.x0);
      const to = Math.min(hi, v.x1);
      if (to >= from) total += to - from + 1;
    }
  }
  return total;
}

/**
 * The strand plan of a flat chart worked in rows (§2.7.3). Deterministic; the numbering of bobbins follows the
 * working order, so it depends on the hand. `carryMax` (default 8) is the longest gap a color is carried
 * across.
 */
export function planStrands(grid: ChartGrid, o: { hand: Hand; carryMax?: number; reach?: number }): StrandPlan {
  const carryMax = o.carryMax ?? CARRY_MAX;
  const reach = o.reach ?? STRAND_REACH;
  const strandsPerColor = new Array<number>(grid.palette.length).fill(0);
  const bobbinsPerColor = new Array<number>(grid.palette.length).fill(0);
  const rows: RowPlan[] = [];
  let strands = 0;
  let maxPerRow = 0;
  let previous: Segment[] = [];
  for (let k = 1; k <= grid.rows; k++) {
    const r = grid.rows - k;
    const rightToLeft = readsRightToLeft(k, o.hand);
    const raw = rowSegments(rowRuns(grid, r), carryMax);
    // Working order: by where each segment starts in the direction of work (ties: the wider one first).
    raw.sort((a, b) => (rightToLeft ? b.x1 - a.x1 || a.x0 - b.x0 : a.x0 - b.x0 || b.x1 - a.x1));
    // Pass 1: which segments continue a strand of the row before.
    const taken = new Array<boolean>(previous.length).fill(false);
    const match = new Array<number>(raw.length).fill(-1);
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i];
      let best = -1;
      let bestScore = 0;
      for (let j = 0; j < previous.length; j++) {
        if (taken[j] || previous[j].label !== seg.label) continue;
        const score = overlap(seg, previous[j], reach);
        if (score > bestScore) {
          best = j;
          bestScore = score;
        }
      }
      if (best >= 0) {
        taken[best] = true;
        match[i] = best;
      }
    }
    // Bobbin numbers in use in this row: those of the strands that go on (a strand that is not continued ends,
    // and its number is free again).
    const inUse = new Map<number, Set<number>>();
    const claim = (label: number, bobbin: number): void => {
      const set = inUse.get(label);
      if (set === undefined) inUse.set(label, new Set([bobbin]));
      else set.add(bobbin);
    };
    for (let i = 0; i < raw.length; i++) if (match[i] >= 0) claim(raw[i].label, previous[match[i]].bobbin);
    // Pass 2: number the segments; a new strand takes the lowest free bobbin number of its color.
    const segments: Segment[] = [];
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i];
      while (strandsPerColor.length <= seg.label) strandsPerColor.push(0);
      while (bobbinsPerColor.length <= seg.label) bobbinsPerColor.push(0);
      if (match[i] >= 0) {
        const prev = previous[match[i]];
        segments.push({ ...seg, strand: prev.strand, bobbin: prev.bobbin, joined: false });
      } else {
        strandsPerColor[seg.label] += 1;
        let bobbin = 1;
        const used = inUse.get(seg.label);
        while (used !== undefined && used.has(bobbin)) bobbin++;
        claim(seg.label, bobbin);
        bobbinsPerColor[seg.label] = Math.max(bobbinsPerColor[seg.label], bobbin);
        const fromFoundation = k === 1 && i === 0;
        segments.push({ ...seg, strand: strands, bobbin, joined: !fromFoundation });
        strands += 1;
      }
    }
    maxPerRow = Math.max(maxPerRow, segments.length);
    rows.push({ k, r, rightToLeft, segments });
    previous = segments;
  }
  return { rows, strandsPerColor, bobbinsPerColor, strands, maxPerRow };
}

/**
 * The color cues of one row, in this order: `join B (bobbin 2)` for each new strand in working order, then
 * `carry A, C` for the colors carried across a gap in this row (in working order). `code` maps a label to its
 * palette code.
 */
export function rowCueTexts(row: RowPlan, code: (label: number) => string): string[] {
  const out: string[] = [];
  for (const seg of row.segments) if (seg.joined) out.push(`join ${code(seg.label)} (bobbin ${seg.bobbin})`);
  const carried: string[] = [];
  for (const seg of row.segments) {
    if (seg.carried > 0) {
      const name = code(seg.label);
      if (!carried.includes(name)) carried.push(name);
    }
  }
  if (carried.length > 0) out.push(`carry ${carried.join(', ')}`);
  return out;
}
