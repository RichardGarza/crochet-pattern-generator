// Track T2 — the sc border around a flat panel (DESIGN.md §2.7.10): rounds, per-side counts, where Rnd 1 opens,
// the text, and the validator E_BORDER.
//
// Line model (§2.7.10): Rnd 1 is `kind: 'border'`, `start: { k: 'edge' }`, ops in working order from the start
// corner: `inc3` (the 3-sc corner group), the stitches of the edge after it (S − 2 sc), and so on round the four
// corners; `join: {}`. Two facts the text needs are kept in the line: the START CORNER as Rnd 1's arrow, pointing
// at it (↗ top right, ↖ top left, ↘ bottom right, ↙ bottom left), and a JOIN as the color cue `join B` (no cue =
// the round continues from the last stitch of the panel). Rnds 2–n start `{ k: 'join' }` and have an `inc3` in
// each corner center stitch of the round below; they are separate lines (validated one by one) and print as one
// (`renderBorderLines`). The arrow and the cue are not printed: the opening sentence says both.
//
// Edges follow in working order from the start corner: right-handed counterclockwise seen from the RS (top right
// → top left → bottom left → bottom right), left-handed clockwise (top left → top right → bottom right → bottom
// left); a round that starts at another corner is the same cycle rotated.
import type { ChartGrid, Hand, Issue, Line, Op, ResolvedGauge, Technique2D } from '../../types';
import { borderRounds } from '../gauge/grid';
import { roundHalfUp } from '../gauge/round';
import { toTerms } from '../pattern/terminology';
import { type Corner } from './c2cCorners';

/** The border's corner groups and edges in working order. */
type Edge = 'top' | 'bottom' | 'left' | 'right';

const CYCLE: Readonly<Record<Hand, readonly [Corner, Edge][]>> = Object.freeze({
  right: [
    ['TR', 'top'],
    ['TL', 'left'],
    ['BL', 'bottom'],
    ['BR', 'right'],
  ],
  left: [
    ['TL', 'top'],
    ['TR', 'right'],
    ['BR', 'bottom'],
    ['BL', 'left'],
  ],
});

/** Rnd 1's arrow points at the start corner. */
export const CORNER_ARROW: Readonly<Record<Corner, NonNullable<Line['arrow']>>> = Object.freeze({ TR: '↗', TL: '↖', BR: '↘', BL: '↙' });

export function cornerOfArrow(arrow: string | undefined): Corner | undefined {
  for (const corner of ['TR', 'TL', 'BR', 'BL'] as const) if (CORNER_ARROW[corner] === arrow) return corner;
  return undefined;
}

function horizontal(edge: Edge): boolean {
  return edge === 'top' || edge === 'bottom';
}

/** True for the techniques worked in rows whose last stitch the border can continue from (not mosaic: cut every row). */
export function borderCanContinue(technique: Technique2D): boolean {
  return technique === 'sc_graphgan' || technique === 'sc_tapestry' || technique === 'hdc_graphgan';
}

/** True for the techniques that take a border (every flat technique; not tapestry in the round, §2.7.10). */
export function takesBorder(technique: Technique2D): boolean {
  return technique !== 'sc_tapestry_round';
}

/**
 * Per-side counts of Rnd 1 (§2.7.10), each between the corner center stitches: rows `S_top = W`,
 * `S_side = round(rows · h_cell / w_sc)`; C2C `S_top = round(W · tile / w_sc)`, `S_side = round(H · tile / w_sc)`.
 * Never less than 2 (the two corner-group stitches of the side); see the deviation in docs/tracks/t2.md.
 */
export function borderSides(technique: Technique2D, cols: number, rows: number, gauge: Pick<ResolvedGauge, 'cell' | 'wSc'>): { sTop: number; sSide: number } {
  if (technique === 'c2c') {
    const tile = gauge.cell.w;
    return { sTop: Math.max(2, roundHalfUp((cols * tile) / gauge.wSc)), sSide: Math.max(2, roundHalfUp((rows * tile) / gauge.wSc)) };
  }
  return { sTop: Math.max(2, cols), sSide: Math.max(2, roundHalfUp((rows * gauge.cell.h) / gauge.wSc)) };
}

export type BorderOpening = 'turn' | 'noturn' | 'join';

export interface BorderPlan {
  technique: Technique2D;
  hand: Hand;
  /** Panel size in stitches (or tiles) and rows. */
  cols: number;
  rows: number;
  /** Number of rounds n. */
  rounds: number;
  sTop: number;
  sSide: number;
  /** Stitch counts c1 … cn. */
  counts: number[];
  /** Border color code. */
  color: string;
  opening: BorderOpening;
  corner: Corner;
}

/** Where Rnd 1 opens (§2.7.10): continue from the last stitch, or join at the top right (RH) / top left (LH). */
export function borderOpening(i: { technique: Technique2D; hand: Hand; rows: number; color: string; lastColor?: string }): { opening: BorderOpening; corner: Corner } {
  const left = i.hand === 'left';
  if (borderCanContinue(i.technique) && i.lastColor !== undefined && i.lastColor === i.color) {
    const ws = i.rows % 2 === 0;
    if (ws) return { opening: 'turn', corner: left ? 'TL' : 'TR' };
    return { opening: 'noturn', corner: left ? 'TR' : 'TL' };
  }
  return { opening: 'join', corner: left ? 'TL' : 'TR' };
}

/**
 * The border of a panel, or null when there is none (`widthIn` ≤ 0, or a technique without a border). `lastColor`
 * is the color code of the last stitch of the panel's last line (undefined: always join).
 */
export function planBorder(i: {
  technique: Technique2D;
  hand: Hand;
  cols: number;
  rows: number;
  gauge: Pick<ResolvedGauge, 'cell' | 'wSc' | 'hSc'>;
  widthIn: number;
  color: string;
  lastColor?: string;
}): BorderPlan | null {
  if (!takesBorder(i.technique) || !(typeof i.widthIn === 'number' && i.widthIn > 0)) return null;
  const rounds = borderRounds(i.widthIn, i.gauge.hSc);
  if (rounds < 1) return null;
  const hand: Hand = i.hand === 'left' ? 'left' : 'right';
  const { sTop, sSide } = borderSides(i.technique, i.cols, i.rows, i.gauge);
  const c1 = 2 * sTop + 2 * sSide + 4;
  const counts = Array.from({ length: rounds }, (_, r) => c1 + 8 * r);
  const { opening, corner } = borderOpening({ technique: i.technique, hand, rows: i.rows, color: i.color, lastColor: i.lastColor });
  return { technique: i.technique, hand, cols: i.cols, rows: i.rows, rounds, sTop, sSide, counts, color: i.color, opening, corner };
}

/** The four (corner, edge) steps of a round starting at `corner`. */
function cycleFrom(hand: Hand, corner: Corner): [Corner, Edge][] {
  const cycle = CYCLE[hand === 'left' ? 'left' : 'right'];
  const at = Math.max(0, cycle.findIndex(([c]) => c === corner));
  return [...cycle.slice(at), ...cycle.slice(0, at)];
}

/** Rnd 1's ops: from the start corner, `inc3` then S − 2 sc for the edge after it, four times. */
export function borderRound1Ops(plan: Pick<BorderPlan, 'hand' | 'corner' | 'sTop' | 'sSide' | 'color'>): Op[] {
  const ops: Op[] = [];
  for (const [, edge] of cycleFrom(plan.hand, plan.corner)) {
    ops.push({ k: 'inc', n: 3, color: plan.color });
    const k = (horizontal(edge) ? plan.sTop : plan.sSide) - 2;
    for (let i = 0; i < k; i++) ops.push({ k: 'st', st: 'sc', color: plan.color });
  }
  return ops;
}

/** The 0-based positions of the corner center stitches a round's ops make (the middle st of each inc3). */
export function cornerCenters(ops: readonly Op[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const op of ops) {
    if (op.k === 'inc' && op.n === 3) out.push(at + 1);
    at += op.k === 'inc' ? op.n : 1;
  }
  return out;
}

/** The next round's ops: sc in each st, inc3 in each corner center st of the round below. */
export function nextBorderOps(prevCount: number, centers: readonly number[], color: string): Op[] {
  const set = new Set(centers);
  const ops: Op[] = [];
  for (let i = 0; i < prevCount; i++) ops.push(set.has(i) ? { k: 'inc', n: 3, color } : { k: 'st', st: 'sc', color });
  return ops;
}

/** The border rounds as lines (§2.7.10). */
export function writeBorder(plan: BorderPlan): Line[] {
  const lines: Line[] = [];
  let ops = borderRound1Ops(plan);
  const first: Line = {
    kind: 'border',
    n: 1,
    side: 'RS',
    arrow: CORNER_ARROW[plan.corner],
    start: { k: 'edge' },
    ops,
    prevCount: null,
    stated: plan.counts[0],
    join: {},
  };
  if (plan.opening === 'join') first.cues = [{ kind: 'color', text: `join ${plan.color}` }];
  lines.push(first);
  for (let r = 2; r <= plan.rounds; r++) {
    const prev = plan.counts[r - 2];
    ops = nextBorderOps(prev, cornerCenters(ops), plan.color);
    lines.push({ kind: 'border', n: r, start: { k: 'join' }, ops, prevCount: prev, stated: plan.counts[r - 1], join: {} });
  }
  return lines;
}

/** Stitches of a border (Σ c_r). */
export function borderStitches(plan: Pick<BorderPlan, 'counts'>): number {
  return plan.counts.reduce((a, b) => a + b, 0);
}

// ---- Text

/**
 * The spacing hint (§2.7.10): the best ratio a/b (b ≤ 6) within 4% of `k / units` — "about 5 sc per 6 row ends",
 * "2 sc in each tile edge" (b = 1); without one within 4%, "{k} sc over {units} row ends".
 */
export function spacingHint(k: number, units: number, unit: 'row end' | 'tile edge'): string {
  const plural = `${unit}s`;
  if (!(units > 0) || !(k > 0)) return '';
  const x = k / units;
  let best: { a: number; b: number; err: number } | null = null;
  for (let b = 1; b <= 6; b++) {
    const a = roundHalfUp(x * b);
    if (a < 1) continue;
    const err = Math.abs(a / b - x) / x;
    if (err <= 0.04 + 1e-12 && (best === null || err < best.err - 1e-12)) best = { a, b, err };
  }
  if (best === null) return `${k} sc over ${units} ${units === 1 ? unit : plural}`;
  if (best.b === 1) return `${best.a} sc in each ${unit}`;
  return `about ${best.a} sc per ${best.b} ${plural}`;
}

/** Facts about the panel that only the pattern knows (the line alone gives a correct but plainer text). */
export interface BorderTextContext {
  terms: 'us' | 'uk';
  hand: Hand;
  technique?: Technique2D;
  /** Panel rows (row ends per side; C2C: tiles per side). */
  rows?: number;
  /** Panel width in stitches (C2C: tiles). */
  cols?: number;
}

const WORDS = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' } as const;

function cornerWords(corner: Corner): string {
  return `${corner[0] === 'T' ? 'top' : 'bottom'} ${corner[1] === 'R' ? 'right' : 'left'}`;
}

/** The edges of Rnd 1's ops (sc counts between the four inc3), or null when the round is not shaped that way. */
export function round1Edges(ops: readonly Op[]): number[] | null {
  if (ops.length === 0 || !(ops[0].k === 'inc' && ops[0].n === 3)) return null;
  const edges: number[] = [];
  for (const op of ops) {
    if (op.k === 'inc' && op.n === 3) edges.push(0);
    else if (op.k === 'st' && op.st === 'sc' && op.loop === undefined && op.into === undefined) edges[edges.length - 1]++;
    else return null;
  }
  return edges.length === 4 ? edges : null;
}

function joinCueColor(line: Line): string | undefined {
  for (const cue of line.cues ?? []) {
    const m = /^\s*join\s+(\S+)\s*$/.exec(cue.kind === 'color' ? cue.text : '');
    if (m !== null) return m[1];
  }
  return undefined;
}

function borderColor(line: Line): string | undefined {
  return line.ops.find((op) => op.color !== undefined)?.color ?? line.colorHeader;
}

/** The body of Rnd 1 (everything after `Rnd 1 (RS): `, before the count), in US terms. */
function round1Body(line: Line, ctx: BorderTextContext): string {
  const hand: Hand = ctx.hand === 'left' ? 'left' : 'right';
  const c2c = ctx.technique === 'c2c';
  const joinColor = joinCueColor(line);
  const corner = cornerOfArrow(line.arrow) ?? (hand === 'left' ? 'TL' : 'TR');
  const edges = round1Edges(line.ops);
  const steps = cycleFrom(hand, corner);
  const parts: string[] = [];
  // Opening.
  const where = cornerWords(corner);
  if (joinColor !== undefined) {
    const color = joinColor;
    parts.push(
      c2c
        ? `Fasten off. With RS facing, join ${color} with a sl st in the outer corner of the ${where} tile; ch 1 (does not count), 3 sc in same sp (corner)`
        : `Fasten off. With RS facing, join ${color} with a sl st in the ${where} corner st; ch 1 (does not count), 3 sc in same st (corner)`,
    );
  } else {
    const turnCorner: Corner = hand === 'left' ? 'TL' : 'TR';
    const noTurnCorner: Corner = hand === 'left' ? 'TR' : 'TL';
    if (corner === turnCorner) parts.push(`Turn so the RS faces you; ch 1 (does not count), 3 sc in the last st made (${where} corner)`);
    else if (corner === noTurnCorner) parts.push(`Do not turn; ch 1 (does not count), 3 sc in the last st made (${where} corner)`);
    else parts.push(`Ch 1 (does not count), 3 sc in the ${where} corner`);
  }
  let hintH = true;
  let hintV = true;
  for (let i = 0; i < 4; i++) {
    const [, edge] = steps[i];
    const k = edges === null ? 0 : edges[i];
    if (k > 0) {
      const vertical = !horizontal(edge);
      // Which way a side is worked: the edge after a top corner goes down.
      const down = steps[i][0][0] === 'T';
      let phrase: string;
      let units: number | undefined;
      if (c2c) {
        units = vertical ? ctx.rows : ctx.cols;
        phrase = vertical ? `working ${down ? 'down' : 'up'} the ${WORDS[edge]} side, ${k} sc evenly spaced` : `working along the tile edges across the ${edge}, ${k} sc evenly spaced`;
      } else if (vertical) {
        units = ctx.rows;
        phrase = `working ${down ? 'down' : 'up'} the row ends of the ${WORDS[edge]} side, ${k} sc evenly spaced`;
      } else {
        phrase = edge === 'top' ? `sc in each st across the top to the last st (${k} sc)` : `sc in each free loop across to the last loop (${k} sc)`;
      }
      const wantHint = units !== undefined && (vertical ? hintV : c2c && hintH);
      if (wantHint) {
        const hint = spacingHint(k, units!, c2c ? 'tile edge' : 'row end');
        if (hint !== '') phrase += ` (${hint})`;
        if (vertical) hintV = false;
        else hintH = false;
      }
      parts.push(phrase);
    }
    if (i < 3) {
      const next = steps[i + 1][0];
      const words = cornerWords(next);
      if (c2c) parts.push(`3 sc in the outer corner of the ${words} tile`);
      else if (next[0] === 'T') parts.push(`3 sc in the ${words} corner st`);
      else if (!horizontal(steps[i][1])) parts.push(`3 sc in the corner loop of the foundation ch (${words})`);
      else parts.push(`3 sc in the last loop (${words} corner)`);
    }
  }
  return `${parts.join('; ')}; join with sl st in first sc.`;
}

const LATER_BODY = 'Ch 1 (does not count), sc in same st as join and in each st around, working 3 sc in each corner center st; join with sl st in first sc.';

/** One border line as text (both dialects): Rnd 1 with its opening, or a later round. */
export function renderBorderLine(line: Line, ctx: BorderTextContext): string {
  const text = line.start?.k === 'edge' ? `Rnd ${line.n} (RS): ${round1Body(line, ctx)} (${line.stated} sts)` : `Rnd ${line.n}: ${LATER_BODY} (${line.stated} sts)`;
  return toTerms(text, ctx.terms);
}

/** The header printed before Rnd 1: `Border (with B):`. */
export function borderHeader(line: Line, terms: 'us' | 'uk'): string {
  const color = borderColor(line);
  return toTerms(color === undefined ? 'Border:' : `Border (with ${color}):`, terms);
}

/**
 * The border lines of a piece as printed (§2.7.10): the header, Rnd 1, and Rnds 2–n as one line with every count
 * (`(620, 628, 636 sts)`). Lines that are not border lines are ignored.
 */
export function renderBorderLines(lines: readonly Line[], ctx: BorderTextContext): string[] {
  const border = lines.filter((line) => line.kind === 'border');
  if (border.length === 0) return [];
  const out: string[] = [];
  const first = border[0];
  if (first.start?.k === 'edge') {
    out.push(borderHeader(first, ctx.terms));
    out.push(renderBorderLine(first, ctx));
  }
  const later = border.filter((line) => line.start?.k !== 'edge');
  if (later.length === 1) out.push(renderBorderLine(later[0], ctx));
  else if (later.length > 1) {
    const counts = later.map((line) => line.stated).join(', ');
    out.push(toTerms(`Rnds ${later[0].n}–${later[later.length - 1].n}: ${LATER_BODY} (${counts} sts)`, ctx.terms));
  }
  return out;
}

// ---- Validation (E_BORDER)

function issue(message: string, where?: Issue['where']): Issue {
  return Object.freeze(where === undefined ? { code: 'E_BORDER', severity: 'error' as const, message } : { code: 'E_BORDER', severity: 'error' as const, message, where: Object.freeze(where) });
}

export interface ValidateBorderInput {
  chart: ChartGrid;
  technique: Technique2D;
  hand: Hand;
  lines: readonly Line[];
  piece?: string;
  /** Color code of the last stitch of the panel's last line (where a continued Rnd 1 starts). */
  lastColor?: string;
  /** With the gauge, S_side (and C2C S_top) and the round count are checked against §2.7.10's formulas. */
  gauge?: Pick<ResolvedGauge, 'cell' | 'wSc' | 'hSc'>;
  /** The border setting: its width (round count) and color code. */
  border?: { widthIn: number; color?: string };
}

/**
 * E_BORDER (§2.13, §2.7.10): per-side counts, Rnd 1 = 2·S_top + 2·S_side + 4, +8 per later round with one inc3 in
 * each corner center stitch, Rnd 1 opening at the corner where the last line ends or with a join, the round count
 * from the setting, one color. Never throws.
 */
export function validateBorder(i: ValidateBorderInput): Issue[] {
  const issues: Issue[] = [];
  const border = i.lines.filter((line) => typeof line === 'object' && line !== null && line.kind === 'border' && Array.isArray(line.ops));
  const at = (n: number): Issue['where'] => (i.piece === undefined ? { line: n } : { piece: i.piece, line: n });
  const hand: Hand = i.hand === 'left' ? 'left' : 'right';
  const W = i.chart.cols;
  const R = i.chart.rows;
  const want = i.border;
  if (want !== undefined) {
    const n = takesBorder(i.technique) && want.widthIn > 0 && i.gauge !== undefined ? borderRounds(want.widthIn, i.gauge.hSc) : takesBorder(i.technique) && want.widthIn > 0 ? -1 : 0;
    if (n === 0 && border.length > 0) issues.push(issue(`this piece has no border (${takesBorder(i.technique) ? 'width 0' : 'not for tapestry in the round'}), but ${border.length} border rounds are written`));
    else if (n > 0 && border.length !== n) issues.push(issue(`a ${want.widthIn} in border is ${n} round${n === 1 ? '' : 's'} (round(${want.widthIn} / ${round3(i.gauge!.hSc)})), not ${border.length}`));
    else if (n < 0 && border.length === 0) issues.push(issue('the border is missing'));
  }
  if (border.length === 0) return issues;
  border.forEach((line, j) => {
    if (line.n !== j + 1 || (line.nEnd !== undefined && line.nEnd !== line.n)) issues.push(issue(`border rounds are numbered 1 to ${border.length} and printed one by one (got Rnd ${line.n}${line.nEnd !== undefined ? `–${line.nEnd}` : ''})`, at(line.n)));
  });
  const first = border[0];
  if (first.start?.k !== 'edge') {
    issues.push(issue('border Rnd 1 is worked into the panel edges (start: edge)', at(first.n)));
    return issues;
  }
  const color = borderColor(first);
  for (const line of border) {
    if (line.ops.some((op) => op.color !== color)) issues.push(issue(`Rnd ${line.n}: a border is worked in one color (${color ?? 'none'})`, at(line.n)));
  }
  if (want?.color !== undefined && color !== want.color) issues.push(issue(`the border is set to ${want.color} but is worked in ${color ?? 'no color'}`, at(1)));
  // Opening.
  const joinColor = joinCueColor(first);
  const corner = cornerOfArrow(first.arrow);
  if (corner === undefined) issues.push(issue('border Rnd 1 must name its start corner (its arrow points at it)', at(1)));
  if (joinColor !== undefined) {
    const joinCorner: Corner = hand === 'left' ? 'TL' : 'TR';
    if (joinColor !== color) issues.push(issue(`Rnd 1 joins ${joinColor} but is worked in ${color ?? 'no color'}`, at(1)));
    if (corner !== undefined && corner !== joinCorner) issues.push(issue(`a joined border starts at the ${cornerWords(joinCorner)} corner (${hand}-handed), not the ${cornerWords(corner)}`, at(1)));
  } else if (corner !== undefined) {
    if (!borderCanContinue(i.technique)) {
      issues.push(issue(`a ${i.technique === 'c2c' ? 'C2C' : i.technique} border cannot continue from the last stitch: fasten off and join it`, at(1)));
    } else {
      const { corner: end } = borderOpening({ technique: i.technique, hand, rows: R, color: color ?? '', lastColor: color });
      if (i.lastColor !== undefined && i.lastColor !== color) issues.push(issue(`Rnd 1 continues from the last stitch (${i.lastColor}) in another color (${color ?? 'none'}): fasten off and join instead`, at(1)));
      if (corner !== end) issues.push(issue(`Row ${R} is ${R % 2 === 0 ? 'WS' : 'RS'} and ends at the ${cornerWords(end)} corner (${hand}-handed); a continued Rnd 1 opens there, not at the ${cornerWords(corner)}`, at(1)));
    }
  }
  // Rnd 1 shape and per-side counts.
  const edges = round1Edges(first.ops);
  if (edges === null) {
    issues.push(issue('Rnd 1 is 3 sc in each of the four corners (inc3) with sc along the edges between them, starting at a corner', at(1)));
    return issues;
  }
  const steps = cycleFrom(hand, corner ?? (hand === 'left' ? 'TL' : 'TR'));
  const sides = steps.map(([, edge], j) => ({ edge, s: edges[j] + 2 }));
  const tops = sides.filter((x) => horizontal(x.edge)).map((x) => x.s);
  const verts = sides.filter((x) => !horizontal(x.edge)).map((x) => x.s);
  let sTop = tops[0];
  let sSide = verts[0];
  if (tops[0] !== tops[1] || verts[0] !== verts[1]) issues.push(issue(`opposite sides of Rnd 1 must match: top/bottom ${tops.join('/')}, sides ${verts.join('/')}`, at(1)));
  if (i.gauge !== undefined) {
    const f = borderSides(i.technique, W, R, i.gauge);
    if (sTop !== f.sTop) issues.push(issue(`S_top = ${f.sTop}${i.technique === 'c2c' ? ` (round(${W} · tile / w_sc))` : ' (1 sc per stitch)'}, but Rnd 1 has ${sTop}`, at(1)));
    if (sSide !== f.sSide) issues.push(issue(`S_side = round(${R} · ${i.technique === 'c2c' ? 'tile' : 'h'} / w_sc) = ${f.sSide}, but Rnd 1 has ${sSide}`, at(1)));
    sTop = f.sTop;
    sSide = f.sSide;
  } else if (i.technique !== 'c2c' && sTop !== Math.max(2, W)) {
    issues.push(issue(`S_top = W = ${W} (1 sc per stitch of the last row), but Rnd 1 has ${sTop}`, at(1)));
  }
  const c1 = 2 * sTop + 2 * sSide + 4;
  if (first.stated !== c1) issues.push(issue(`Rnd 1 = 2·S_top + 2·S_side + 4 = ${c1}, but it states ${first.stated}`, at(1)));
  // Later rounds.
  let prev = first;
  for (const line of border.slice(1)) {
    const want8 = prev.stated + 8;
    if (line.start?.k !== 'join') issues.push(issue(`Rnd ${line.n}: a later border round starts in the join (ch 1, sc in same st)`, at(line.n)));
    if (line.prevCount !== prev.stated || line.stated !== want8) issues.push(issue(`Rnd ${line.n}: each round adds 8 sts (${prev.stated} → ${want8}), not ${line.prevCount ?? '?'} → ${line.stated}`, at(line.n)));
    const expected = nextBorderOps(prev.stated, cornerCenters(prev.ops), color ?? '');
    const same = expected.length === line.ops.length && expected.every((op, j) => op.k === line.ops[j].k && (op.k !== 'inc' || (line.ops[j] as { n?: number }).n === op.n));
    if (!same) issues.push(issue(`Rnd ${line.n}: 3 sc (inc3) go in each of the 4 corner center sts of Rnd ${prev.n} and 1 sc in every other st`, at(line.n)));
    prev = line;
  }
  return issues;
}

function round3(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}
