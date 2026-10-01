// The salience guard and the merge rule (DESIGN.md §2.4.3; research 06 §2.4). Track T1, sprint T1.2.
//
// Salience: cells whose color is ΔE00 ≥ 20 from the center they were given, in 4-connected groups of ≥ 2 cells,
// become protected centers (eyes, a red nose, a logo dot). Neighboring salient cells join a group only when
// they are alike (ΔE00 < 10 between them), so a red eye next to a blue one makes two groups; groups whose mean
// colors are within ΔE00 5 share one center (two eyes, one color).
// Merge: centers closer than ΔE00 5 merge into the more populous one; a protected center is never merged away.
import { ciede2000, type Color3 } from '../kernel/color';

export const SALIENT_DE00 = 20;
export const SALIENT_MIN_CELLS = 2;
/** Two salient neighbors join one group below this ΔE00. */
export const SALIENT_LINK_DE00 = 10;
export const MERGE_DE00 = 5;

export interface SalientGroup {
  /** Cells of the group (row-major indices), ascending. */
  cells: number[];
  /** Mean CIELAB of the cells. */
  lab: Color3;
  /** Mean linear RGB of the cells. */
  lin: Color3;
}

/**
 * Salient groups of a cols × rows chart: `cellLab` (3 per cell), the CIELAB of each cell's assigned center
 * (`assignedLab`, 3 per cell), `eligible[i]` = 0 for cells that cannot be salient (background, hand edits);
 * `isMixed(i)` = the cell's color is a mix of two centers (a cell straddling an edge), asked only of cells
 * that are far from their center.
 * Groups are found in row-major order and then merged by color (ΔE00 < 5), so the result is deterministic.
 */
export function salientGroups(
  cols: number,
  rows: number,
  cellLab: ArrayLike<number>,
  assignedLab: ArrayLike<number>,
  cellLin: ArrayLike<number>,
  eligible?: Uint8Array,
  isMixed?: (cell: number) => boolean,
): SalientGroup[] {
  const n = cols * rows;
  const salient = new Uint8Array(n);
  const lab = (a: ArrayLike<number>, i: number): Color3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
  for (let i = 0; i < n; i++) {
    if (eligible !== undefined && !eligible[i]) continue;
    if (ciede2000(lab(cellLab, i), lab(assignedLab, i)) >= SALIENT_DE00 && !(isMixed?.(i) ?? false)) salient[i] = 1;
  }
  const comp = new Int32Array(n).fill(-1);
  const groups: SalientGroup[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!salient[s] || comp[s] >= 0) continue;
    const id = groups.length;
    const cells: number[] = [];
    comp[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % cols;
      const y = (i - x) / cols;
      const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1];
      for (const j of nb) {
        if (j < 0 || !salient[j] || comp[j] >= 0) continue;
        if (ciede2000(lab(cellLab, i), lab(cellLab, j)) >= SALIENT_LINK_DE00) continue;
        comp[j] = id;
        stack.push(j);
      }
    }
    cells.sort((a, b) => a - b);
    groups.push({ cells, lab: meanOf(cellLab, cells), lin: meanOf(cellLin, cells) });
  }
  const big = groups.filter((g) => g.cells.length >= SALIENT_MIN_CELLS);
  // Groups of one color share a center: greedy, largest group first (ties → first found).
  const order = big.map((_, k) => k).sort((a, b) => big[b].cells.length - big[a].cells.length || a - b);
  const merged: SalientGroup[] = [];
  for (const k of order) {
    const g = big[k];
    const into = merged.find((m) => ciede2000(m.lab, g.lab) < MERGE_DE00);
    if (into === undefined) merged.push({ cells: [...g.cells], lab: g.lab, lin: g.lin });
    else {
      const a = into.cells.length;
      const b = g.cells.length;
      const mix = (p: Color3, q: Color3): Color3 => [(p[0] * a + q[0] * b) / (a + b), (p[1] * a + q[1] * b) / (a + b), (p[2] * a + q[2] * b) / (a + b)];
      into.lab = mix(into.lab, g.lab);
      into.lin = mix(into.lin, g.lin);
      into.cells = [...into.cells, ...g.cells].sort((x, y) => x - y);
    }
  }
  return merged;
}

function meanOf(a: ArrayLike<number>, cells: readonly number[]): Color3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of cells) {
    x += a[i * 3];
    y += a[i * 3 + 1];
    z += a[i * 3 + 2];
  }
  const n = Math.max(1, cells.length);
  return [x / n, y / n, z / n];
}

/**
 * The merge rule: repeatedly take the closest pair of centers under ΔE00 5 and drop the less populous one
 * (ties → the later one); a protected center is never dropped (two protected centers both stay). Returns the
 * indices of the surviving centers, ascending.
 */
export function mergeCenters(labs: readonly Color3[], population: ArrayLike<number>, isProtected: (k: number) => boolean): number[] {
  const alive = labs.map(() => true);
  for (;;) {
    let best: [number, number] | undefined;
    let bd = MERGE_DE00;
    for (let a = 0; a < labs.length; a++) {
      if (!alive[a]) continue;
      for (let b = a + 1; b < labs.length; b++) {
        if (!alive[b] || (isProtected(a) && isProtected(b))) continue;
        const d = ciede2000(labs[a], labs[b]);
        if (d < bd) {
          bd = d;
          best = [a, b];
        }
      }
    }
    if (best === undefined) break;
    const [a, b] = best;
    // Drop the unprotected one; between two unprotected ones, the less populous (ties → the later index).
    const drop = isProtected(a) ? b : isProtected(b) ? a : population[b] <= population[a] ? b : a;
    alive[drop] = false;
  }
  return labs.map((_, k) => k).filter((k) => alive[k]);
}
