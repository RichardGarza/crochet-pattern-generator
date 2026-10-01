// Track T2 — the `c2c` writer (DESIGN.md §2.7.6; research 07 §4): dc tiles worked on the diagonals, from any
// start corner, for either hand, and its validator (E_C2C_TILES).
//
//   ↙ Row 1 (RS) [first tile]: 1 A (1 tile)
//   ↗ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)
//   ↙ Row 3 (RS) [inc beg · inc end]: 1 A, 2 B (3 tiles)
//
// The chart is mapped into the right-handed bottom-right frame (c2cCorners.ts), the normative algorithm runs
// there, and cells and arrows are mapped back. Increase/decrease tags, phases and the bobbin regions (colors
// 6-connected: orthogonal neighbours plus the (r ± 1, c ± 1) diagonal, never (r ± 1, c ∓ 1)) are computed on the
// transformed chart. A region is one bobbin: a new region prints `join B (bobbin n)`, n the lowest number of
// that color not in use by another region at that row, so the highest n is the bobbins to wind; every region
// has two tails (yardage).
//
// Chart cells here are `(r, c)` with r = 0 the bottom row (§2.7.6); grid row = rows − 1 − r.
import type { ChartGrid, Cue, Hand, Issue, Line, Op } from '../../types';
import { type C2CArrow, type Corner, c2cArrows, c2cFrame, CORNER_NAMES } from './c2cCorners';
import { labelCode } from './scFlat';

/** Tiles in diagonal row n of a W × H chart: `min(n − 1, W − 1) − max(0, n − H) + 1` (§2.7.6). */
export function c2cTiles(n: number, W: number, H: number): number {
  return Math.min(n - 1, W - 1) - Math.max(0, n - H) + 1;
}

export type C2CEnd = 'first' | 'inc' | 'dec';

/** One diagonal row: its cells in working order (chart coordinates) and its tags. */
export interface C2CRow {
  n: number;
  side: 'RS' | 'WS';
  arrow: C2CArrow;
  start: C2CEnd;
  end: C2CEnd;
  cells: [number, number][];
}

/**
 * The diagonal rows of a W × H chart for a hand and start corner (geometry only): the normative loop of §2.7.6
 * on the transformed chart, cells mapped back.
 */
export function c2cRows(W: number, H: number, hand: Hand, corner: Corner): C2CRow[] {
  const frame = c2cFrame(W, H, hand, corner);
  const fw = frame.W;
  const fh = frame.H;
  const [oddArrow, evenArrow] = c2cArrows(hand, corner);
  const rows: C2CRow[] = [];
  for (let n = 1; n <= fw + fh - 1; n++) {
    const d = n - 1;
    const odd = n % 2 === 1;
    const cells: [number, number][] = [];
    for (let r = Math.max(0, d - (fw - 1)); r <= Math.min(d, fh - 1); r++) cells.push([r, fw - 1 - (d - r)]);
    cells.sort((a, b) => (odd ? b[0] - a[0] : a[0] - b[0]));
    const blInc = n <= fw;
    const rtInc = n <= fh;
    const [startInc, endInc] = odd ? [rtInc, blInc] : [blInc, rtInc];
    const start: C2CEnd = n === 1 ? 'first' : startInc ? 'inc' : 'dec';
    const end: C2CEnd = n === 1 ? 'first' : endInc ? 'inc' : 'dec';
    rows.push({ n, side: odd ? 'RS' : 'WS', arrow: odd ? oddArrow : evenArrow, start, end, cells: cells.map(([r, c]) => frame.fromFrame(r, c)) });
  }
  return rows;
}

/** The grid label of chart cell (r, c), r = 0 the bottom row. */
export function c2cLabel(grid: ChartGrid, r: number, c: number): number {
  return grid.labels[(grid.rows - 1 - r) * grid.cols + c];
}

export interface C2CRegion {
  label: number;
  /** First and last diagonal row with a tile of the region. */
  firstRow: number;
  lastRow: number;
  /** Bobbin number among the regions of its color in use at the same time (1-based). */
  bobbin: number;
  tiles: number;
}

export interface C2CRegions {
  /** Region id per grid cell (row-major, row 0 = top), in order of first tile worked. */
  regionOf: Int32Array;
  regions: C2CRegion[];
  /** Regions per palette label (each has 2 tails). */
  regionsPerColor: number[];
  /** Bobbins to wind per palette label: the most regions of that color in use at once. */
  bobbinsPerColor: number[];
}

/**
 * The bobbin regions of a C2C chart: 6-connected components of one color on the transformed chart, numbered in
 * working order. Deterministic.
 */
export function c2cRegions(grid: ChartGrid, hand: Hand, corner: Corner, rows: readonly C2CRow[] = c2cRows(grid.cols, grid.rows, hand, corner)): C2CRegions {
  const W = grid.cols;
  const H = grid.rows;
  const frame = c2cFrame(W, H, hand, corner);
  const fw = frame.W;
  const fh = frame.H;
  // Labels on the frame.
  const fl = new Int32Array(fw * fh);
  for (let r = 0; r < fh; r++) {
    for (let c = 0; c < fw; c++) {
      const [or, oc] = frame.fromFrame(r, c);
      fl[r * fw + c] = c2cLabel(grid, or, oc);
    }
  }
  const comp = new Int32Array(fw * fh).fill(-1);
  const NB: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
  ];
  // Components are numbered in working order: the first tile of each, row by row.
  let next = 0;
  const regionOf = new Int32Array(W * H).fill(-1);
  const regions: C2CRegion[] = [];
  const stack: number[] = [];
  for (const row of rows) {
    for (const [r, c] of row.cells) {
      const [fr, fc] = frame.toFrame(r, c);
      const start = fr * fw + fc;
      if (comp[start] < 0) {
        comp[start] = next;
        stack.push(start);
        while (stack.length > 0) {
          const at = stack.pop()!;
          const ar = Math.floor(at / fw);
          const ac = at % fw;
          for (const [dr, dc] of NB) {
            const br = ar + dr;
            const bc = ac + dc;
            if (br < 0 || bc < 0 || br >= fh || bc >= fw) continue;
            const b = br * fw + bc;
            if (comp[b] >= 0 || fl[b] !== fl[start]) continue;
            comp[b] = next;
            stack.push(b);
          }
        }
        regions.push({ label: fl[start], firstRow: row.n, lastRow: row.n, bobbin: 0, tiles: 0 });
        next++;
      }
      const id = comp[start];
      const region = regions[id];
      region.lastRow = row.n;
      region.tiles++;
      regionOf[(H - 1 - r) * W + c] = id;
    }
  }
  // Bobbin numbers: a region takes the lowest number of its color not held by a region still in use (one that
  // started before it and ends at or after its first row). Regions come in order of their first row, so per color
  // a heap of (last row, bobbin) frees numbers and a heap of free numbers hands out the lowest.
  const colors = Math.max(grid.palette.length, ...regions.map((x) => x.label + 1), 0);
  const regionsPerColor = new Array<number>(colors).fill(0);
  const bobbinsPerColor = new Array<number>(colors).fill(0);
  const active = new Map<number, MinHeap>();
  const free = new Map<number, MinHeap>();
  for (const region of regions) {
    regionsPerColor[region.label]++;
    let act = active.get(region.label);
    let fr = free.get(region.label);
    if (act === undefined || fr === undefined) {
      act = new MinHeap();
      fr = new MinHeap();
      active.set(region.label, act);
      free.set(region.label, fr);
    }
    while (act.size > 0 && act.peekKey() < region.firstRow) fr.push(act.pop(), 0);
    const bobbin = fr.size > 0 ? fr.pop() : bobbinsPerColor[region.label] + 1;
    region.bobbin = bobbin;
    bobbinsPerColor[region.label] = Math.max(bobbinsPerColor[region.label], bobbin);
    act.push(bobbin, region.lastRow);
  }
  return { regionOf, regions, regionsPerColor, bobbinsPerColor };
}

/** A binary min-heap of values ordered by key (then value); `push(value, key)`, `pop()` returns the value. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  peekKey(): number {
    return this.keys[0];
  }
  private less(i: number, j: number): boolean {
    return this.keys[i] < this.keys[j] || (this.keys[i] === this.keys[j] && this.vals[i] < this.vals[j]);
  }
  private swap(i: number, j: number): void {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.vals[i], this.vals[j]] = [this.vals[j], this.vals[i]];
  }
  push(value: number, key: number): void {
    this.keys.push(key);
    this.vals.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.vals[0];
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.less(l, m)) m = l;
        if (r < this.keys.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

export interface C2CWriterOptions {
  hand: Hand;
  /** Default: bottom-right (RH) / bottom-left (LH). */
  corner?: Corner;
  /** Print `join B (bobbin n)` where a new region starts (default true). */
  cues?: boolean;
}

export interface C2CWriterResult {
  lines: Line[];
  rows: C2CRow[];
  regions: C2CRegions;
  corner: Corner;
  arrows: [C2CArrow, C2CArrow];
}

/** The one-time note at the row after the increase phase (§2.7.6). */
export function c2cPhaseNote(W: number, H: number): string {
  return W === H
    ? 'The piece now has its full width: from this row on, every row decreases at both ends.'
    : 'One side now has its full length: from this row on, each row increases at one end and decreases at the other, so the number of tiles stays the same.';
}

/** The C2C rows of a chart (§2.7.6): one line per diagonal, tiles in working order, tags, phases, region cues. */
export function writeC2C(grid: ChartGrid, o: C2CWriterOptions): C2CWriterResult {
  const hand: Hand = o.hand === 'left' ? 'left' : 'right';
  const corner = o.corner ?? (hand === 'left' ? 'BL' : 'BR');
  const W = grid.cols;
  const H = grid.rows;
  const rows = c2cRows(W, H, hand, corner);
  const regions = c2cRegions(grid, hand, corner, rows);
  const phaseRow = Math.min(W, H) + 1;
  const lines: Line[] = [];
  let firstRegion = true;
  const started = new Set<number>();
  for (const row of rows) {
    const ops: Op[] = row.cells.map(([r, c]) => ({ k: 'tile', color: labelCode(grid, c2cLabel(grid, r, c)) }));
    const line: Line = {
      kind: 'c2c',
      n: row.n,
      side: row.side,
      arrow: row.arrow,
      start: { k: 'c2c', start: row.start, end: row.end },
      ops,
      prevCount: row.n === 1 ? null : c2cTiles(row.n - 1, W, H),
      stated: ops.length,
    };
    const cues: Cue[] = [];
    for (const [r, c] of row.cells) {
      const id = regions.regionOf[(H - 1 - r) * W + c];
      if (started.has(id)) continue;
      started.add(id);
      if (firstRegion) {
        firstRegion = false;
        continue;
      }
      const region = regions.regions[id];
      cues.push({ kind: 'color', text: `join ${labelCode(grid, region.label)} (bobbin ${region.bobbin})` });
    }
    if (o.cues !== false && cues.length > 0) line.cues = cues;
    if (row.n === phaseRow) line.notes = [c2cPhaseNote(W, H)];
    lines.push(line);
  }
  return { lines, rows, regions, corner, arrows: c2cArrows(hand, corner) };
}

// ---- Validation (E_C2C_TILES)

function issue(message: string, where?: Issue['where']): Issue {
  return Object.freeze(where === undefined ? { code: 'E_C2C_TILES', severity: 'error' as const, message } : { code: 'E_C2C_TILES', severity: 'error' as const, message, where: Object.freeze(where) });
}

/**
 * E_C2C_TILES (§2.13): rows = W + H − 1 in order; each row has `tiles(n)` tiles (Σ = W·H) and is its diagonal
 * read from the start corner (tile colors in working order); its start/end tags give the phases min(W,H) /
 * |W − H| / min(W,H) − 1; RS/WS and the arrow are the corner's. Lines that are not C2C rows are ignored.
 */
export function validateC2C(grid: ChartGrid, lines: readonly Line[], o: { hand: Hand; corner: Corner; piece?: string }): Issue[] {
  const W = grid.cols;
  const H = grid.rows;
  const rows = c2cRows(W, H, o.hand, o.corner);
  const c2c = lines.filter((line) => typeof line === 'object' && line !== null && line.kind === 'c2c' && Array.isArray(line.ops) && Number.isInteger(line.n));
  const at = (n: number): Issue['where'] => (o.piece === undefined ? { line: n } : { piece: o.piece, line: n });
  const issues: Issue[] = [];
  if (c2c.length !== W + H - 1) issues.push(issue(`a ${W} × ${H} C2C chart has ${W + H - 1} diagonal rows, not ${c2c.length}`));
  let total = 0;
  const phases = { inc: 0, steady: 0, dec: 0 };
  c2c.forEach((line, i) => {
    total += line.ops.length;
    const want = rows[i];
    if (want === undefined) return;
    if (line.n !== want.n || (line.nEnd !== undefined && line.nEnd !== line.n)) {
      issues.push(issue(`Row ${line.n}: C2C rows are numbered 1 to ${W + H - 1} in order and never folded (expected Row ${want.n})`, at(line.n)));
      return;
    }
    const tiles = c2cTiles(want.n, W, H);
    if (line.ops.length !== tiles) issues.push(issue(`Row ${want.n}: tiles(${want.n}) = ${tiles}, but the row has ${line.ops.length} tiles (${line.ops.length} ≠ ${tiles})`, at(want.n)));
    const start = line.start?.k === 'c2c' ? line.start : undefined;
    if (start === undefined || start.start !== want.start || start.end !== want.end) {
      const tag = (s: C2CEnd, e: C2CEnd): string => (s === 'first' ? '[first tile]' : `[${s} beg · ${e} end]`);
      issues.push(issue(`Row ${want.n}: from the ${CORNER_NAMES[o.corner]} corner this row is ${tag(want.start, want.end)}, not ${start === undefined ? 'untagged' : tag(start.start, start.end)}`, at(want.n)));
    }
    if (line.side !== want.side || line.arrow !== want.arrow) {
      issues.push(issue(`Row ${want.n}: from the ${CORNER_NAMES[o.corner]} corner (${o.hand}-handed) this is a ${want.side} row running ${want.arrow}, not ${line.side ?? 'no side'} ${line.arrow ?? 'no arrow'}`, at(want.n)));
    }
    if (line.ops.length === tiles) {
      const colors = want.cells.map(([r, c]) => labelCode(grid, c2cLabel(grid, r, c)));
      const got = line.ops.map((op) => (op.k === 'tile' ? op.color : '?'));
      if (colors.some((color, j) => color !== got[j])) issues.push(issue(`Row ${want.n}: its tiles are not chart diagonal ${want.n} read ${want.arrow} (${colors.join(' ')} expected)`, at(want.n)));
    }
    if (start !== undefined) {
      if (start.start === 'first' || (start.start === 'inc' && start.end === 'inc')) phases.inc++;
      else if (start.start === 'dec' && start.end === 'dec') phases.dec++;
      else phases.steady++;
    }
  });
  if (total !== W * H) issues.push(issue(`the rows hold ${total} tiles, but the chart has W·H = ${W * H} (${total} ≠ ${W * H})`));
  const lo = Math.min(W, H);
  if (c2c.length === W + H - 1 && (phases.inc !== lo || phases.steady !== Math.abs(W - H) || phases.dec !== lo - 1)) {
    issues.push(issue(`the phases are ${phases.inc} / ${phases.steady} / ${phases.dec} rows (increase / steady / decrease), not ${lo} / ${Math.abs(W - H)} / ${lo - 1}`));
  }
  return issues;
}
