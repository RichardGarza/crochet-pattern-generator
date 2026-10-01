// Track T2 — the word chart: one line per row as color runs only (DESIGN.md §2.7.2; research 07 §3.3).
//
//   11 ← | 4A 3B 33A | 40
//   ↗ 4 | 1A 1B 1A | 3
//   5–8 | 40A | 40
//
// Runs are written out in working order with no repeats (a word chart is read cell by cell). A run of plain
// stitches or tiles prints `{count}{color}`; any other op, and a stitch with no color at all, prints its compact
// text (`2 inc A`, `6 sc`), so the word chart of a shaped line still adds up. Stitches without a color take the
// line's header color.
import type { Line, Op, Terms } from '../../types';
import { displayOps, runText } from './ops';
import { compactNames } from './terminology';

function plain(op: Op): boolean {
  if (op.k === 'tile') return true;
  return op.k === 'st' && op.st !== 'slst' && op.into === undefined && (op.loop === undefined || op.loop === 'both');
}

function sameOp(a: Op, b: Op): boolean {
  if (a.k !== b.k) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[key] !== y[key]) return false;
  return true;
}

/** The runs of a line in the word chart: `4A 3B 33A`. */
export function wordChartRuns(line: Line, o: { terms?: Terms } = {}): string {
  const header = line.colorHeader;
  const ops = displayOps(line);
  const names = compactNames(o.terms ?? 'us');
  const parts: string[] = [];
  let i = 0;
  while (i < ops.length) {
    let j = i + 1;
    while (j < ops.length && sameOp(ops[j], ops[i])) j++;
    const op = ops[i];
    const n = j - i;
    const color = op.color ?? header;
    if (plain(op) && color !== undefined) parts.push(`${n}${color}`);
    else parts.push(runText(op.color === undefined && header !== undefined ? { ...op, color: header } : op, n, { names }));
    i = j;
  }
  return parts.join(' ');
}

/** One line of the word chart: `11 ← | 4A 3B 33A | 40` (C2C rows put their arrow first: `↗ 4 | … | 3`). */
export function renderWordChartLine(line: Line, o: { terms?: Terms } = {}): string {
  const folded = line.nEnd !== undefined && line.nEnd > line.n;
  const number = folded ? `${line.n}–${line.nEnd}` : `${line.n}`;
  let label = number;
  if (line.arrow !== undefined) label = line.kind === 'c2c' ? `${line.arrow} ${number}` : `${number} ${line.arrow}`;
  return `${label} | ${wordChartRuns(line, o)} | ${line.stated}`;
}
