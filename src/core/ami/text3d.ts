// Track T4 — the printed text of amigurumi rounds (DESIGN.md §2.10.6, §2.10.8, §2.10.11): every line goes
// through T2's `renderLine` with `docKind: '3d'` (integration task T4-2), so the compact and verbose dialects, US
// and UK terms and the decrease word are the same in the app, the PDF and the tests.
import type { Hand, Terms } from '../../types/units';
import type { Line } from '../../types/pattern';
import { renderFoundation, renderLine, renderLineExtras } from '../pattern/render';

export interface Text3dOptions {
  dialect: 'compact' | 'verbose';
  terms: Terms;
  hand: Hand;
  /** `AmiSettings.decMethod`: how the verbose dialect writes `dec` (BLO/FLO rounds always print sc2tog). */
  decMethod?: 'invdec' | 'sc2tog';
}

/**
 * The printed lines of one piece, in order: each round as `renderLine` prints it (the chain of a chain-oval or
 * chain-ring start in front of Rnd 1: `Ch 10. Rnd 1: …`), then its cue sentences and notes on lines of their own.
 */
export function pieceText(lines: readonly Line[], o: Text3dOptions): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    const r = { dialect: o.dialect, terms: o.terms, hand: o.hand, docKind: '3d' as const, ...(o.decMethod ? { decMethod: o.decMethod } : {}) };
    const chain = i === 0 ? renderFoundation(line, { terms: o.terms, docKind: '3d' }) : null;
    out.push((chain ? `${chain} ` : '') + renderLine(line, r));
    out.push(...renderLineExtras(line, { terms: o.terms }));
  });
  return out;
}
