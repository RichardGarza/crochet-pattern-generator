// Track T2 — pieces of a PatternDoc that do not depend on the technique writers: the gauge line, the finished
// size, the hook, the document hash (DESIGN.md §2.8 "Materials page", §5.2).
import type { Cell, PatternDoc, Technique2D, Terms } from '../../types';
import { countsPer4In } from '../gauge/resolve';
import { roundHalfUp } from '../gauge/round';
import { hookUsLabel } from '../gauge/tables';
import { CODE_VERSION, canonicalJson, fnv1a64Hex } from '../kernel/hash';
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

/** The document hash: fnv1a64 of the canonical JSON of everything but `hash`, with the code version. */
export function docHash(doc: Omit<PatternDoc, 'hash'> & { hash?: string }): string {
  const { hash: _hash, ...rest } = doc;
  return fnv1a64Hex(canonicalJson({ v: CODE_VERSION, doc: rest }));
}
