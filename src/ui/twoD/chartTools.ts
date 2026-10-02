// Track T2.3 — the chart editor's tools as pure functions (DESIGN.md §1.3 F1 step 5, §5.5.5, §6.3 T2).
//
// Every tool is `applyChartTool(grid, edits, cell, tool) → result`: a projectStore recipe (with its undo label)
// that writes hand edits as `ColorRef` overrides and locks into `doc.twoD.edits`, or the color an eyedropper
// picked. Nothing here reads the DOM or a store, so the tools are unit-tested in node; the Chart tab passes the
// recipe to `projectStore.update`.
//
// Hand edits are authored data kept by color identity (§5.5.5): an override is `{ cell, color: { hex, yarnId? } }`
// with the cell a row-major index at `edits.baseCols × edits.baseRows`; the chart worker re-inserts the override
// colors as protected centers on every regeneration. The grid a tool sees is the chart as displayed — the computed
// chart with the edits laid over it (`displayChart`), so a fill or a replace acts on what the user sees, and an
// edit is visible at once, before the worker has recomputed.
//
// Edits made at another chart size are first moved to this size by relative position (T1's `remapEdits`, the
// same rule the worker applies; §5.5.5), inside the same recipe, so a tool never mixes two sizes.
import { deltaE00Hex } from '../../core/kernel/color';
import { remapEdits } from '../../core/quantize/colorize';
import type { ChartEdits, ChartGrid, ColorRef, PaletteEntry, ProjectDoc, Yarn } from '../../types';
import type { Draft } from 'immer';

/** The recipe type of `projectStore.update` (kept local so this module needs no store). */
export type DocRecipe = (draft: Draft<ProjectDoc>) => void;

export type ChartTool =
  /** Paint one cell with a color. */
  | { kind: 'paint'; color: ColorRef }
  /** Flood-fill the 4-connected area of the cell's color. */
  | { kind: 'fill'; color: ColorRef }
  /** Every cell of the cell's color takes the new color. */
  | { kind: 'replace'; color: ColorRef }
  /** Pick the cell's color. */
  | { kind: 'eyedropper' }
  /** Protect the cell from clean-up (`lock`), release it (`unlock`), or flip it (`toggle`). */
  | { kind: 'lock'; mode: 'lock' | 'unlock' | 'toggle' }
  /** Remove the cell's hand edit and lock (back to the computed chart). */
  | { kind: 'erase' };

export type ChartToolResult =
  | { kind: 'edit'; label: string; recipe: DocRecipe; cells: number[] }
  | { kind: 'pick'; color: ColorRef; entry: PaletteEntry }
  | null;

/** The palette entry's color identity: lowercase hex and, when the entry is a yarn, its id (§5.5.5). */
export function refOf(entry: Pick<PaletteEntry, 'hex' | 'yarn'>): ColorRef {
  const hex = entry.hex.toLowerCase();
  return entry.yarn?.id ? { hex, yarnId: entry.yarn.id } : { hex };
}

/** A yarn's color identity. */
export function refOfYarn(yarn: Pick<Yarn, 'hex' | 'id'>): ColorRef {
  return { hex: yarn.hex.toLowerCase(), yarnId: yarn.id };
}

export function sameRef(a: ColorRef | undefined, b: ColorRef | undefined): boolean {
  if (!a || !b) return false;
  return a.hex.toLowerCase() === b.hex.toLowerCase() && (a.yarnId ?? '') === (b.yarnId ?? '');
}

/** No edits, at a size. */
export function emptyEdits(cols: number, rows: number): ChartEdits {
  return { baseCols: cols, baseRows: rows, overrides: [], locked: [] };
}

/** The edits at the chart's size (moved by relative position when they were made at another size). */
export function editsAt(edits: ChartEdits | undefined, cols: number, rows: number): ChartEdits {
  if (!edits) return emptyEdits(cols, rows);
  if (edits.baseCols === cols && edits.baseRows === rows) return edits;
  if (edits.overrides.length === 0 && edits.locked.length === 0) return emptyEdits(cols, rows);
  if (!(edits.baseCols > 0) || !(edits.baseRows > 0)) return emptyEdits(cols, rows);
  return remapEdits(edits, cols, rows);
}

export function hasEdits(edits: ChartEdits | undefined): boolean {
  return !!edits && (edits.overrides.length > 0 || edits.locked.length > 0);
}

/** How many cells the user changed by hand (overrides and locks, a cell counted once). */
export function editCount(edits: ChartEdits | undefined): number {
  if (!edits) return 0;
  const cells = new Set<number>();
  for (const o of edits.overrides) cells.add(o.cell);
  for (const c of edits.locked) cells.add(c);
  return cells.size;
}

/** The chart as displayed: the computed grid with the overrides laid over it, and which cells are locked. */
export interface DisplayChart {
  grid: ChartGrid;
  /** Per cell: 1 = hand-painted, 0 = computed. */
  edited: Uint8Array<ArrayBuffer>;
  locked: Uint8Array<ArrayBuffer>;
  /** Palette entries added for override colors that are not in the computed palette (code `+1`, `+2`, …). */
  added: number;
}

/** Finds the palette entry of a color identity: same yarn id, else same hex. */
export function entryIndexOf(palette: readonly PaletteEntry[], color: ColorRef): number {
  if (color.yarnId) {
    const byYarn = palette.findIndex((p) => p.yarn?.id === color.yarnId);
    if (byYarn >= 0) return byYarn;
  }
  const hex = color.hex.toLowerCase();
  return palette.findIndex((p) => p.hex.toLowerCase() === hex);
}

/** The computed entry within ΔE00 < 2 of a color (the worker maps an override there, §5.5.5), or -1. */
function nearEntryOf(palette: readonly PaletteEntry[], hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return -1;
  let best = -1;
  let bestD = 2;
  palette.forEach((p, i) => {
    if (!/^#[0-9a-f]{6}$/i.test(p.hex)) return;
    const d = deltaE00Hex(p.hex.toLowerCase(), hex.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * The computed chart with the edits over it. Overrides in a color the palette lacks get a temporary entry, so
 * the paint shows at once; the worker's next result names it properly (§5.5.5).
 */
export function displayChart(grid: ChartGrid, edits: ChartEdits | undefined, yarns: readonly Yarn[] = []): DisplayChart {
  const n = grid.cols * grid.rows;
  const labels = new Uint8Array(n);
  labels.set(grid.labels.subarray(0, n));
  const edited = new Uint8Array(n);
  const locked = new Uint8Array(n);
  const palette = grid.palette.slice();
  const at = editsAt(edits, grid.cols, grid.rows);
  let added = 0;
  // One lookup per color identity (a fill writes thousands of overrides of one color).
  const found = new Map<string, number>();
  for (const o of at.overrides) {
    if (!Number.isInteger(o.cell) || o.cell < 0 || o.cell >= n || typeof o.color?.hex !== 'string') continue;
    const id = `${o.color.hex.toLowerCase()}|${o.color.yarnId ?? ''}`;
    let i = found.get(id) ?? entryIndexOf(palette, o.color);
    if (i < 0) i = nearEntryOf(grid.palette, o.color.hex);
    if (i < 0) {
      if (palette.length >= 255) continue; // labels are bytes; the worker caps the palette long before this
      added++;
      const yarn = o.color.yarnId ? yarns.find((y) => y.id === o.color.yarnId) : undefined;
      palette.push({ code: `+${added}`, hex: o.color.hex.toLowerCase(), name: yarn?.name ?? `Painted ${o.color.hex.toLowerCase()}`, ...(yarn ? { yarn } : {}), role: 'override', protected: true });
      i = palette.length - 1;
    }
    found.set(id, i);
    labels[o.cell] = i;
    edited[o.cell] = 1;
  }
  for (const c of at.locked) if (Number.isInteger(c) && c >= 0 && c < n) locked[c] = 1;
  return { grid: { cols: grid.cols, rows: grid.rows, labels, palette }, edited, locked, added };
}

/** The 4-connected area of the cell's label (an explicit stack: a 1000 × 1000 area never overflows). */
export function floodArea(grid: Pick<ChartGrid, 'cols' | 'rows' | 'labels'>, cell: number): number[] {
  const { cols, rows, labels } = grid;
  const n = cols * rows;
  if (!Number.isInteger(cell) || cell < 0 || cell >= n) return [];
  const label = labels[cell];
  const seen = new Uint8Array(n);
  const out: number[] = [];
  const stack = [cell];
  seen[cell] = 1;
  while (stack.length > 0) {
    const c = stack.pop()!;
    out.push(c);
    const x = c % cols;
    const y = (c - x) / cols;
    const visit = (d: number) => {
      if (seen[d] === 0 && labels[d] === label) {
        seen[d] = 1;
        stack.push(d);
      }
    };
    if (x > 0) visit(c - 1);
    if (x < cols - 1) visit(c + 1);
    if (y > 0) visit(c - cols);
    if (y < rows - 1) visit(c + cols);
  }
  return out.sort((a, b) => a - b);
}

/** Every cell with the label. */
export function cellsOfLabel(grid: Pick<ChartGrid, 'labels' | 'cols' | 'rows'>, label: number): number[] {
  const out: number[] = [];
  const n = grid.cols * grid.rows;
  for (let i = 0; i < n; i++) if (grid.labels[i] === label) out.push(i);
  return out;
}

/** Writes the edits back as the chart's size, so a recipe never mixes two sizes. */
function prepare(draft: Draft<ProjectDoc>, cols: number, rows: number): Draft<ChartEdits> {
  const twoD = draft.twoD;
  if (!twoD) throw new Error('this project has no chart yet');
  const cur = twoD.edits as ChartEdits | undefined;
  if (!cur || cur.baseCols !== cols || cur.baseRows !== rows) twoD.edits = editsAt(cur, cols, rows);
  if (!Array.isArray(twoD.edits.overrides)) twoD.edits.overrides = [];
  if (!Array.isArray(twoD.edits.locked)) twoD.edits.locked = [];
  return twoD.edits;
}

/** Sets the color of these cells (one entry per cell; an existing entry is changed in place). */
export function setOverrides(draft: Draft<ProjectDoc>, cols: number, rows: number, cells: readonly number[], color: ColorRef): void {
  const e = prepare(draft, cols, rows);
  const index = new Map<number, number>();
  e.overrides.forEach((o, i) => index.set(o.cell, i));
  const ref: ColorRef = color.yarnId ? { hex: color.hex.toLowerCase(), yarnId: color.yarnId } : { hex: color.hex.toLowerCase() };
  for (const cell of cells) {
    const i = index.get(cell);
    if (i === undefined) {
      index.set(cell, e.overrides.length);
      e.overrides.push({ cell, color: { ...ref } });
    } else if (!sameRef(e.overrides[i].color, ref)) {
      e.overrides[i].color = { ...ref };
    }
  }
}

function removeCells(draft: Draft<ProjectDoc>, cols: number, rows: number, cells: readonly number[], what: { overrides: boolean; locked: boolean }): void {
  const e = prepare(draft, cols, rows);
  const drop = new Set(cells);
  if (what.overrides && e.overrides.some((o) => drop.has(o.cell))) e.overrides = e.overrides.filter((o) => !drop.has(o.cell));
  if (what.locked && e.locked.some((c) => drop.has(c))) e.locked = e.locked.filter((c) => !drop.has(c));
}

function lockCells(draft: Draft<ProjectDoc>, cols: number, rows: number, cells: readonly number[]): void {
  const e = prepare(draft, cols, rows);
  const have = new Set(e.locked);
  for (const c of cells) {
    if (!have.has(c)) {
      have.add(c);
      e.locked.push(c);
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One tool at one cell of the displayed chart (`displayChart(grid, edits)`): the recipe that writes the edit,
 * the color an eyedropper picked, or null when the click changes nothing (outside the chart, the same color).
 * `grid` is the computed chart (the worker's result); `edits` the stored hand edits.
 */
export function applyChartTool(grid: ChartGrid, edits: ChartEdits | undefined, cell: number, tool: ChartTool): ChartToolResult {
  const { cols, rows } = grid;
  const n = cols * rows;
  if (!Number.isInteger(cell) || cell < 0 || cell >= n) return null;
  const shown = displayChart(grid, edits);
  const label = shown.grid.labels[cell];
  const entry = shown.grid.palette[label];
  const at = editsAt(edits, cols, rows);
  switch (tool.kind) {
    case 'eyedropper':
      return entry ? { kind: 'pick', color: refOf(entry), entry } : null;
    case 'paint': {
      // Painting a cell its own computed color still pins it (it keeps that color through regeneration); painting
      // an already painted cell its color again changes nothing.
      if (entry && sameRef(refOf(entry), tool.color) && at.overrides.some((o) => o.cell === cell && sameRef(o.color, tool.color))) return null;
      return { kind: 'edit', label: 'Paint', cells: [cell], recipe: (d) => setOverrides(d, cols, rows, [cell], tool.color) };
    }
    case 'fill': {
      if (entry && sameRef(refOf(entry), tool.color)) return null;
      const cells = floodArea(shown.grid, cell);
      return { kind: 'edit', label: `Fill ${plural(cells.length, 'stitch', 'stitches')}`, cells, recipe: (d) => setOverrides(d, cols, rows, cells, tool.color) };
    }
    case 'replace': {
      if (entry && sameRef(refOf(entry), tool.color)) return null;
      const cells = cellsOfLabel(shown.grid, label);
      const name = entry ? `${entry.code}` : 'color';
      return { kind: 'edit', label: `Replace ${name} (${plural(cells.length, 'stitch', 'stitches')})`, cells, recipe: (d) => setOverrides(d, cols, rows, cells, tool.color) };
    }
    case 'lock': {
      const isLocked = shown.locked[cell] === 1;
      const lock = tool.mode === 'toggle' ? !isLocked : tool.mode === 'lock';
      if (lock === isLocked) return null;
      return lock
        ? { kind: 'edit', label: 'Lock stitches', cells: [cell], recipe: (d) => lockCells(d, cols, rows, [cell]) }
        : { kind: 'edit', label: 'Unlock stitches', cells: [cell], recipe: (d) => removeCells(d, cols, rows, [cell], { overrides: false, locked: true }) };
    }
    case 'erase': {
      if (shown.edited[cell] === 0 && shown.locked[cell] === 0) return null;
      return { kind: 'edit', label: 'Erase hand edits', cells: [cell], recipe: (d) => removeCells(d, cols, rows, [cell], { overrides: true, locked: true }) };
    }
  }
}

/** Palette operations of the Colors panel; they act on every cell of a displayed color. */
export type PaletteOp =
  /** Every cell of `from` takes the color of `into` (two colors become one). */
  | { kind: 'merge'; from: number; into: number }
  /** Every cell of `label` takes this yarn's color (and name). */
  | { kind: 'recolor'; label: number; yarn: Pick<Yarn, 'id' | 'hex' | 'name'> }
  /** Every cell of `label` takes a color. */
  | { kind: 'replace'; label: number; color: ColorRef };

/** A palette operation on the displayed chart: the recipe, or null when it changes nothing. */
export function applyPaletteOp(grid: ChartGrid, edits: ChartEdits | undefined, op: PaletteOp): Extract<ChartToolResult, { kind: 'edit' }> | null {
  const shown = displayChart(grid, edits);
  const { cols, rows } = grid;
  const pal = shown.grid.palette;
  const labelOf = op.kind === 'merge' ? op.from : op.label;
  const from = pal[labelOf];
  if (!from) return null;
  let color: ColorRef;
  let label: string;
  if (op.kind === 'merge') {
    const into = pal[op.into];
    if (!into || op.into === op.from) return null;
    color = refOf(into);
    label = `Merge ${from.code} into ${into.code}`;
  } else if (op.kind === 'recolor') {
    color = refOfYarn(op.yarn);
    label = `Recolor ${from.code} to ${op.yarn.name}`;
  } else {
    color = op.color;
    label = `Replace ${from.code}`;
  }
  if (sameRef(refOf(from), color)) return null;
  const cells = cellsOfLabel(shown.grid, labelOf);
  if (cells.length === 0) return null;
  return { kind: 'edit', label, cells, recipe: (d) => setOverrides(d, cols, rows, cells, color) };
}

/** Clears every hand edit and lock (one undo step). */
export function clearEditsRecipe(cols: number, rows: number): DocRecipe {
  return (d) => {
    if (d.twoD) d.twoD.edits = emptyEdits(cols, rows);
  };
}

/** Cells of a straight line between two cells (a fast drag skips none). Bresenham on (col, row). */
export function cellsBetween(cols: number, a: number, b: number): number[] {
  let x0 = a % cols;
  let y0 = Math.floor(a / cols);
  const x1 = b % cols;
  const y1 = Math.floor(b / cols);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out: number[] = [];
  for (;;) {
    out.push(y0 * cols + x0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

/**
 * The continuation of a drag (paint, lock, erase) over more cells, as one recipe — cheaper than a tool call per
 * cell on a large chart (no displayed chart is built). `lock` is the mode the stroke started with.
 */
export function strokeRecipe(cols: number, rows: number, cells: readonly number[], tool: { kind: 'paint'; color: ColorRef } | { kind: 'lock'; lock: boolean } | { kind: 'erase' }): DocRecipe {
  const n = cols * rows;
  const ok = cells.filter((c) => Number.isInteger(c) && c >= 0 && c < n);
  return (d) => {
    if (ok.length === 0) return;
    if (tool.kind === 'paint') setOverrides(d, cols, rows, ok, tool.color);
    else if (tool.kind === 'lock') {
      if (tool.lock) lockCells(d, cols, rows, ok);
      else removeCells(d, cols, rows, ok, { overrides: false, locked: true });
    } else removeCells(d, cols, rows, ok, { overrides: true, locked: true });
  };
}

/** Stitches per palette label of a displayed chart. */
export function labelCounts(grid: Pick<ChartGrid, 'labels' | 'palette' | 'cols' | 'rows'>): number[] {
  const out = new Array<number>(grid.palette.length).fill(0);
  const n = grid.cols * grid.rows;
  for (let i = 0; i < n; i++) if (grid.labels[i] < out.length) out[grid.labels[i]]++;
  return out;
}
