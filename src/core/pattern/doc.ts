// Track T2 — pieces of a PatternDoc that do not depend on the technique writers: the gauge line, the finished
// size, the hook, the document hash (DESIGN.md §2.8 "Materials page", §5.2).
import type { Cell, Line, Op, PatternDoc, Technique2D, Terms } from '../../types';
import { countsPer4In } from '../gauge/resolve';
import { roundHalfUp } from '../gauge/round';
import { hookUsLabel } from '../gauge/tables';
import { CODE_VERSION, canonicalJson, createFnv1a64 } from '../kernel/hash';
import { toTerms } from './terminology';

/** A count as printed in a gauge line: at most one decimal, no trailing zero (13.5, 16). */
export function gaugeNumber(x: number): string {
  return String(roundHalfUp(x * 10) / 10);
}

/**
 * The gauge line in CYC style (§2.8): `13.5 sc and 16 rows = 4" (10 cm)`; C2C `5.2 tiles = 4" (10 cm)`; tapestry
 * adds "in tapestry crochet", rounds count `rnds`. In the given terms.
 */
export function gaugeText2D(technique: Technique2D, cell: Cell, terms: Terms): string {
  const { sts4, rows4 } = countsPer4In(cell);
  const span = '4" (10 cm)';
  let text: string;
  switch (technique) {
    case 'c2c':
      text = `${gaugeNumber(sts4)} tiles = ${span}`;
      break;
    case 'hdc_graphgan':
      text = `${gaugeNumber(sts4)} hdc and ${gaugeNumber(rows4)} rows = ${span}`;
      break;
    case 'sc_tapestry':
      text = `${gaugeNumber(sts4)} sc and ${gaugeNumber(rows4)} rows = ${span} in tapestry crochet`;
      break;
    case 'sc_tapestry_round':
      text = `${gaugeNumber(sts4)} sc and ${gaugeNumber(rows4)} rnds = ${span} in tapestry crochet`;
      break;
    case 'mosaic_overlay':
      text = `${gaugeNumber(sts4)} sts and ${gaugeNumber(rows4)} rows = ${span} in mosaic pattern`;
      break;
    default:
      text = `${gaugeNumber(sts4)} sc and ${gaugeNumber(rows4)} rows = ${span}`;
  }
  return toTerms(text, terms);
}

/** The hook of a pattern: mm and the US label when the size has one (§2.2.1). */
export function hookOf(mm: number): PatternDoc['hook'] {
  const us = hookUsLabel(mm);
  return us === undefined ? { mm } : { mm, us };
}

/** One op as a short token: `sc:A`, `scBLO`, `inc3:B`, `tile:C` (fields in a fixed order). */
function opToken(op: Op): string {
  const head = op.k === 'st' ? op.st : op.k === 'tile' ? 'tile' : `${op.k}${op.n}`;
  const loop = op.k !== 'tile' && op.loop !== undefined ? op.loop : '';
  const into = op.k === 'st' && op.into !== undefined ? `/${op.into}` : '';
  return `${head}${loop}${into}:${op.color ?? ''}`;
}

/** The ops of a line run-length encoded (`sc:A*4,sc:B*3`): equal for equal op lists, short for long rows. */
export function opsKey(ops: readonly Op[]): string {
  let out = '';
  let i = 0;
  while (i < ops.length) {
    const t = opToken(ops[i]);
    let j = i + 1;
    while (j < ops.length && opToken(ops[j]) === t) j++;
    out += `${out === '' ? '' : ','}${t}*${j - i}`;
    i = j;
  }
  return out;
}

/** Everything of a line but its ops as canonical JSON, then its ops key. */
export function lineKey(line: Line, o: { number?: boolean } = {}): string {
  const { ops, n, nEnd, ...rest } = line;
  const head = o.number === false ? rest : { ...rest, n, nEnd };
  return `${canonicalJson(head)}|${opsKey(Array.isArray(ops) ? ops : [])}`;
}

/** A number for the hash: integers as they are, other numbers to 6 decimals (§5.8: never raw floats). */
function stable(value: unknown): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? value : value.toFixed(6);
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stable(v);
    return out;
  }
  return value;
}

/**
 * The document hash: FNV-1a 64 over the code version, the doc's fields (non-integer numbers to 6 decimals, §5.8),
 * the chart's labels, and each line (its fields and run-length ops). `hash` itself is left out.
 */
export function docHash(doc: Omit<PatternDoc, 'hash'> & { hash?: string }): string {
  const { hash: _hash, pieces, chart, ...rest } = doc;
  const h = createFnv1a64();
  h.update(CODE_VERSION).update('\u0000').update(canonicalJson(stable(rest)));
  if (chart !== undefined) {
    const { grid, ...meta } = chart;
    const { labels, ...gridMeta } = grid;
    h.update('\u0000chart').update(canonicalJson(stable({ ...meta, grid: gridMeta }))).update(labels);
  }
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    const { lines, ...pieceMeta } = piece;
    h.update('\u0000piece').update(canonicalJson(stable(pieceMeta)));
    for (const line of Array.isArray(lines) ? lines : []) h.update('\u0001').update(lineKey(line));
  }
  return h.hex();
}
