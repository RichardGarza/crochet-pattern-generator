// Cleanup presets (DESIGN.md §2.5 table) and the working path (§2.5 "along the working path"). Track T1,
// sprint T1.3. Pure.
import type { ChartSettings } from '../../types/chart';
import type { Technique2D } from '../../types/gauge';

/** Which column of the §2.5 table a technique reads: graph & C2C, or tapestry. */
export type CleanupFamily = 'graph' | 'tapestry';

/** The parameters of one cleanup run (§2.5). */
export interface CleanupParams {
  family: CleanupFamily;
  /** Confetti passes (0 = off). */
  confettiPasses: number;
  /** 4-connected components smaller than this merge into a neighbor (1 = off). */
  aMin: number;
  /** Potts λ (0 = off). */
  lambda: number;
  /** Minimum run along the working path (1 = none). */
  rMin: number;
  /** Tapestry: most labels per line (undefined = no cap). */
  rowCap?: number;
  /** Labels with fewer cells than this remap to the nearest remaining label (0 = off). */
  rareMin: number;
}

/** The tapestry techniques (every color carried through the line); the others read the graph & C2C column. */
export const TAPESTRY_TECHNIQUES: ReadonlySet<Technique2D> = new Set<Technique2D>(['sc_tapestry', 'sc_tapestry_round']);

export function cleanupFamily(technique: Technique2D): CleanupFamily {
  return TAPESTRY_TECHNIQUES.has(technique) ? 'tapestry' : 'graph';
}

/** The §2.5 table, by preset and family. `rareMin` is a cell count (Easy: 0.5% of the cells, rounded up). */
export function cleanupParams(technique: Technique2D, detail: ChartSettings['detail'], cells: number): CleanupParams {
  const family = cleanupFamily(technique);
  const t = family === 'tapestry';
  switch (detail) {
    case 'max':
      return { family, confettiPasses: 0, aMin: 1, lambda: 0, rMin: 1, ...(t ? { rowCap: 4 } : {}), rareMin: 0 };
    case 'easy':
      return { family, confettiPasses: 3, aMin: t ? 5 : 4, lambda: t ? 1.0 : 0.8, rMin: t ? 3 : 2, ...(t ? { rowCap: 2 } : {}), rareMin: Math.ceil(0.005 * cells) };
    case 'balanced':
      return { family, confettiPasses: 3, aMin: t ? 3 : 2, lambda: t ? 0.6 : 0.4, rMin: t ? 2 : 1, ...(t ? { rowCap: 3 } : {}), rareMin: 10 };
    default:
      throw new RangeError(`cleanupParams: unknown detail ${String(detail)}`);
  }
}

/**
 * The lines of a chart along its working path (§2.5): flat rows, circular rounds, or C2C diagonals. Every
 * line lists its cells (row-major indices, row 0 = top); the order inside a line is a fixed reading direction
 * (every pass on a line is symmetric, so the hand's direction does not matter).
 */
export interface WorkingPath {
  /** Cell indices of every line, lines in working order (Row/Rnd/diagonal 1 first). */
  lines: Int32Array[];
  /** Rounds: the last cell of a line is next to its first. */
  circular: boolean;
  /** Columns wrap around in 2D neighborhoods (rounds). */
  wrap: boolean;
  /** For every cell, its line (index into `lines`). */
  lineOf: Int32Array;
  /** For every cell, its position along the strand axis (the chart column): runs in nearby lines overlap on it. */
  x: Int32Array;
}

/**
 * The working path of a technique (§2.5, §2.7): rows and rounds are worked bottom-up (worked row k = chart row
 * `rows − k`, §2.7.2); C2C diagonals start at `startCorner` (§2.7.6) — r + c = const for BR / TL, c − r = const
 * for BL / TR.
 */
export function workingPath(technique: Technique2D, cols: number, rows: number, startCorner: ChartSettings['startCorner'] = 'BR'): WorkingPath {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new RangeError(`workingPath: bad size ${cols} × ${rows}`);
  const n = cols * rows;
  const lineOf = new Int32Array(n);
  const x = new Int32Array(n);
  const lines: Int32Array[] = [];
  if (technique === 'c2c') {
    const count = cols + rows - 1;
    for (let k = 0; k < count; k++) {
      const cells: number[] = [];
      for (let r = 0; r < rows; r++) {
        let c: number;
        switch (startCorner) {
          case 'TL':
            c = k - r;
            break;
          case 'BR':
            c = rows + cols - 2 - k - r;
            break;
          case 'BL':
            c = k - (rows - 1 - r);
            break;
          case 'TR':
            c = cols - 1 - (k - r);
            break;
          default:
            throw new RangeError(`workingPath: unknown startCorner ${String(startCorner)}`);
        }
        if (c >= 0 && c < cols) cells.push(r * cols + c);
      }
      lines.push(Int32Array.from(cells));
    }
  } else {
    for (let k = 1; k <= rows; k++) {
      const r = rows - k;
      const cells = new Int32Array(cols);
      for (let c = 0; c < cols; c++) cells[c] = r * cols + c;
      lines.push(cells);
    }
  }
  lines.forEach((line, k) => {
    for (const i of line) {
      lineOf[i] = k;
      x[i] = i % cols;
    }
  });
  const round = technique === 'sc_tapestry_round';
  return { lines, circular: round, wrap: round, lineOf, x };
}
