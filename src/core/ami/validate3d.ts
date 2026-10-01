// Track T4 — the 3D validators of DESIGN.md §2.13 that one piece decides (the plan and assembly rules —
// E_ASSEMBLY, E_OPEN_EDGE, W_GAP — and the ghost part of W_SIZE come with the plan, assembly and ghost sprints).
//
// Every rule has exactly one code and one severity. `validatePiece3d` runs the Step 0 line validator
// (`validateLines`, docKind '3d': E_SANITY, E_CONSUME, E_PRODUCE, E_START/E_FOUNDATION for the first line,
// E_INC/DEC_INFEASIBLE, E_COLOR, E_ROUNDTRIP) and adds the piece-level rules below; it never reports a kernel
// finding again (no second E_START on a line the kernel already flagged) and never throws.
//
// | Code | Severity | What this module checks |
// |---|---|---|
// | E_SPIRAL_CHAIN | error | a spiral round starts with a turning chain (`start.k = 'turn'`); joined rounds are exempt |
// | E_START | error | MR size (classic 6, exact / Path B 5–8, flattened 4–8, oval circular 6); chain oval n₁ = 2·ch = 2S + 6; no decrease while `ideal_k < n₁` |
// | E_CLOSE | error | gather finish at 4–8 sts; closed-oval finish at 2S + 6 with S ≥ 2 |
// | E_FOLD | error | a folded `Rnds a–b` line equals each round it stands for (ops, colors, loops, notes) |
// | E_COLOR_SEQ | error | a color change between rounds without a change instruction; > 3 colors in a round |
// | E_EYE_ORDER | error | a safety-eye cue after the stuffing cue or after the closing round |
// | E_SANITY | error | ≥ 200 rounds or ≥ 20 000 sts in a piece (the line-level part is the kernel's) |
// | W_RUFFLE | warn | `|n_k − n_{k−1}| > ⌈2π·hS/wS⌉` |
// | W_SPACING | warn | gaps between specials differ by > 1 (whole round; oval: side segments with ≥ 2 specials) |
// | W_STAGGER | warn | R8 between consecutive change rounds (whole rounds; oval: side segments) |
// | W_STACKED | warn | ≥ 3 consecutive change rounds, all g ≥ 3, each with a site within 1/P of the previous one's |
// | W_SIZE | warn | length and widest-round checks of R11 (needs the counts and the profile) |
// | W_SINGLE_ST | warn | a color run of 1 st |
// | W_MIN_PART | warn | every round < 5 sts |
// | W_ROUND_COLORS | warn | exactly 3 colors in a round |
// | W_CLOSE | warn | a gathered closing round of 7–8 sts |
// | W_FAN3 | warn | an inc3 / dec3 outside a chain oval's first round |
// | W_JOG | warn | a spiral round before a BLO/FLO round that does not end with the jogless sl st |
// | W_EYE_OPENING | warn | the round after which safety eyes go in measures < 3 in around |
//
// E_CORNER (R6, "no stitch is part of both an inc and a dec") cannot occur in a `Line`: every stitch of the round
// below is consumed by exactly one op, which is an inc, a dec or neither. Path B's couplings are checked before
// they become ops (T5); nothing is left to check here.
import type { Issue } from '../../types/issues';
import type { Line, Op, PieceFinish } from '../../types/pattern';
import { produced } from '../pattern/ops';
import { validateLines } from '../pattern/validateLine';
import { mrRange } from './poles';
import { changeSites, isSpecial, minCircularOffset, r8InScope, r8Ok, stackedPair, type ChangeSites } from './place';
import { ovalHalfDiff, profileR, type Profile } from './profiles';
import type { PieceCounts } from './rounds';

export type Issue3dCode =
  | 'E_SPIRAL_CHAIN'
  | 'E_START'
  | 'E_CLOSE'
  | 'E_FOLD'
  | 'E_COLOR_SEQ'
  | 'E_EYE_ORDER'
  | 'E_SANITY'
  | 'W_RUFFLE'
  | 'W_SPACING'
  | 'W_STAGGER'
  | 'W_STACKED'
  | 'W_SIZE'
  | 'W_SINGLE_ST'
  | 'W_MIN_PART'
  | 'W_ROUND_COLORS'
  | 'W_CLOSE'
  | 'W_FAN3'
  | 'W_JOG'
  | 'W_EYE_OPENING';

/** Rounds and stitches a piece may have (R15). */
export const MAX_ROUNDS = 200;
export const MAX_PIECE_STS = 20000;
/** Safety-eye washers need about this much circumference (§2.10.6). */
export const EYE_OPENING_IN = 3;

export interface Piece3dInput {
  /** `where.piece`. */
  id: string;
  /** The lines as printed (folded). */
  lines: readonly Line[];
  /** The rounds before folding (E_FOLD); without them E_FOLD is not checked. */
  unfolded?: readonly Line[];
  /** How the piece ends (E_CLOSE for 'gather', 'flattenSc', 'whipstitch'). */
  finish?: PieceFinish['kind'];
  /** The counts the lines were made from: the pole rule (ideals) and W_SIZE. */
  counts?: PieceCounts;
  /** The profile Path A worked (W_SIZE widths). */
  profile?: Profile | null;
  /** The textbook sphere/capsule radius (W_SIZE for `generator: 'textbook'`). */
  textbookR?: number;
  style: 'classic' | 'exact';
  flattened?: boolean;
  path?: 'A' | 'B';
  /** Path B rounds that were not regularized (§2.10.7 step 7): R7, R8 and W_STACKED do not apply. */
  irregular?: boolean;
  /** Stuffed cell of the piece (`stuffedCell`). */
  cell: { wS: number; hS: number };
  /** Palette codes (E_COLOR, kernel). */
  palette?: Iterable<string>;
}

type Where = { line?: number };

/** All piece-level 3D issues of one piece (the kernel's line issues included, each once). */
export function validatePiece3d(p: Piece3dInput): Issue[] {
  if (typeof p !== 'object' || p === null || !Array.isArray(p.lines)) {
    return [Object.freeze({ code: 'E_SANITY', severity: 'error', message: 'not a piece: it has no lines' }) as Issue];
  }
  const out: Issue[] = [];
  const add = (code: Issue3dCode, message: string, where: Where = {}) => {
    const severity = code.startsWith('E_') ? 'error' : 'warn';
    out.push(Object.freeze({ code, severity, message, where: { piece: p.id, ...where } }) as Issue);
  };
  let kernel: Issue[];
  try {
    kernel = validateLines(p.lines, { piece: p.id, docKind: '3d', ...(p.palette ? { palette: p.palette } : {}) });
  } catch (e) {
    kernel = [{ code: 'E_SANITY', severity: 'error', message: `the lines could not be checked: ${String(e)}`, where: { piece: p.id } }];
  }
  out.push(...kernel);
  // rules below compute on the ops; malformed lines are the kernel's E_SANITY and nothing else is checked
  if (kernel.some((i) => i.code === 'E_SANITY')) return out;
  const kernelStart = new Set(kernel.filter((i) => i.code === 'E_START').map((i) => i.where?.line));
  try {
    pieceRules(p, add, kernelStart);
  } catch (e) {
    add('E_SANITY', `the piece could not be checked: ${String(e)}`);
  }
  return out;
}

/** The issues of every piece. */
export function validate3d(pieces: readonly Piece3dInput[]): Issue[] {
  return pieces.flatMap(validatePiece3d);
}

type Add = (code: Issue3dCode, message: string, where?: Where) => void;

/** A line expanded into the rounds it stands for (a folded line is its first round repeated). */
function roundsOf(lines: readonly Line[]): { line: Line; n: number }[] {
  const out: { line: Line; n: number }[] = [];
  for (const line of lines) {
    const last = line.nEnd !== undefined && line.nEnd > line.n ? line.nEnd : line.n;
    for (let n = line.n; n <= last; n++) out.push({ line, n });
  }
  return out;
}

const isJoined = (l: Line) => l.join !== undefined || l.start?.k === 'join';
const sharedLoop = (ops: readonly Op[]) => {
  const first = ops[0]?.k === 'tile' ? undefined : ops[0]?.loop;
  return first === 'BLO' || first === 'FLO' ? (ops.every((o) => o.k !== 'tile' && o.loop === first) ? first : undefined) : undefined;
};

function pieceRules(p: Piece3dInput, add: Add, kernelStart: Set<number | undefined>): void {
  const { lines } = p;
  if (lines.length === 0) return;
  // E_SANITY (R15), piece level — counted without expanding the folded lines (an absurd nEnd must not hang)
  const span = (l: Line) => (l.nEnd !== undefined && l.nEnd > l.n ? l.nEnd - l.n + 1 : 1);
  const nRounds = lines.reduce((s, l) => s + span(l), 0);
  const total = lines.reduce((s, l) => s + span(l) * l.stated, 0);
  if (nRounds >= MAX_ROUNDS) add('E_SANITY', `${nRounds} rounds in one piece (the limit is ${MAX_ROUNDS - 1})`);
  if (total >= MAX_PIECE_STS) add('E_SANITY', `${total} sts in one piece (the limit is ${MAX_PIECE_STS - 1})`);
  if (nRounds >= MAX_ROUNDS || total >= MAX_PIECE_STS) return;
  const rounds = roundsOf(lines);

  // E_SPIRAL_CHAIN
  for (const line of lines) {
    if (line.kind === 'rnd' && line.start?.k === 'turn' && !isJoined(line)) {
      add('E_SPIRAL_CHAIN', `Rnd ${line.n} starts with a turning chain; spiral rounds are worked without one`, { line: line.n });
    }
  }

  startRules(p, add, kernelStart);
  closeRules(p, add);
  if (p.unfolded) foldIssues(p.unfolded, lines).forEach((m) => add('E_FOLD', m.message, { line: m.line }));
  colorRules(rounds, add);
  cueRules(p, add);
  shapeRules(p, rounds, add);
  if (p.counts) sizeRules(p, p.counts, add);

  // W_MIN_PART (R14)
  const widest = Math.max(...lines.map((l) => l.stated));
  if (widest < 5) add('W_MIN_PART', `the piece is never wider than ${widest} sts; consider a chain or embroidery instead`);
}

// ---- E_START (the parts the kernel does not check)

function startRules(p: Piece3dInput, add: Add, kernelStart: Set<number | undefined>): void {
  const first = p.lines[0];
  const start = first.start;
  if (!start || kernelStart.has(first.n)) return;
  const n1 = first.stated;
  const oval = p.counts?.ovalS !== undefined;
  if (start.k === 'mr') {
    let lo: number;
    let hi: number;
    if (oval) [lo, hi] = [6, 6];
    else if (p.counts?.generator === 'textbook') [lo, hi] = [6, 6];
    else [lo, hi] = mrRange({ style: p.style, flattened: p.flattened, path: p.path });
    if (n1 < lo || n1 > hi) add('E_START', `Rnd 1 has ${n1} sts in the magic ring; it must hold ${lo === hi ? lo : `${lo}–${hi}`}`, { line: first.n });
  } else if (start.k === 'chainOval') {
    const S = start.chains - 3;
    if (n1 !== 2 * start.chains || S < 1) add('E_START', `a chain oval of ch ${start.chains} starts with ${2 * start.chains} sts (2S + 6, S ≥ 1), not ${n1}`, { line: first.n });
  }
  // pole rule: no decrease while ideal_k < n₁ (circular part)
  const c = p.counts;
  if (c && c.ideal.length > 0 && (start.k === 'mr' || start.k === 'chainOval')) {
    const circ = c.circ;
    for (let k = 1; k < circ.length && k < c.ideal.length && c.ideal[k] < circ[0]; k++) {
      if (circ[k] < circ[k - 1]) {
        add('E_START', `Rnd ${k + 1} decreases while the shape is still narrower than the start (pole rule)`, { line: k + 1 });
        break;
      }
    }
  }
}

// ---- E_CLOSE / W_CLOSE (R9)

function closeRules(p: Piece3dInput, add: Add): void {
  const f = p.finish;
  if (f !== 'gather' && f !== 'flattenSc' && f !== 'whipstitch') return;
  const last = p.lines[p.lines.length - 1];
  const n = last.stated;
  const where = { line: last.nEnd ?? last.n };
  if (f === 'gather') {
    if (n > 8 || n < 4) add('E_CLOSE', `the piece closes on ${n} sts; a gathered end needs 4–8`, where);
    else if (n >= 7) add('W_CLOSE', `the piece closes on ${n} sts; 6 or fewer close neater`, where);
    return;
  }
  const S = (n - 6) / 2;
  const sK = p.counts?.ovalS?.[p.counts.ovalS.length - 1];
  if (!Number.isInteger(S) || S < 2 || (sK !== undefined && sK !== S)) add('E_CLOSE', `the closed-oval finish needs 2S + 6 sts with S ≥ 2 on the last round, not ${n}`, where);
}

// ---- E_FOLD

/**
 * A canonical form for comparing what prints: keys sorted, `undefined` fields dropped, and `loop: 'both'` dropped
 * from ops (the default; the kernel prints both alike).
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const isOp = typeof o.k === 'string' && ('st' in o || 'n' in o || o.k === 'tile');
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined && !(isOp && k === 'loop' && o[k] === 'both'))
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

/** E_FOLD findings: every folded line must equal each unfolded round it stands for. */
export function foldIssues(unfolded: readonly Line[], folded: readonly Line[]): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  const byN = new Map<number, Line>();
  for (const l of unfolded) byN.set(l.n, l);
  const strip = (l: Line) => canonical({ ...l, n: 0, nEnd: undefined });
  let expect = unfolded.length > 0 ? unfolded[0].n : 1;
  for (const f of folded) {
    const last = f.nEnd !== undefined && f.nEnd > f.n ? f.nEnd : f.n;
    if (f.n !== expect) out.push({ line: f.n, message: `Rnd ${f.n} follows Rnd ${expect - 1}: rounds are missing or repeated` });
    expect = last + 1;
    for (let n = f.n; n <= last; n++) {
      const u = byN.get(n);
      if (!u) {
        out.push({ line: f.n, message: `Rnds ${f.n}–${last} stand for Rnd ${n}, which the piece does not have` });
        break;
      }
      if (strip(u) !== strip(f) || u.nEnd !== undefined) {
        out.push({ line: f.n, message: last > f.n ? `Rnds ${f.n}–${last} fold Rnd ${n}, which is not the same round (ops, colors, loops or notes differ)` : `Rnd ${n} is not printed as it was made` });
        break;
      }
    }
    if (last > f.n && f.prevCount !== f.stated) out.push({ line: f.n, message: `Rnds ${f.n}–${last} change the count; only identical plain rounds fold` });
  }
  const lastUnfolded = unfolded.length > 0 ? unfolded[unfolded.length - 1].n : 0;
  if (expect - 1 !== lastUnfolded) out.push({ line: expect, message: `the printed rounds end at Rnd ${expect - 1}, the piece at Rnd ${lastUnfolded}` });
  return out;
}

// ---- colors: E_COLOR_SEQ, W_ROUND_COLORS, W_SINGLE_ST (R12)

const MAIN = '\u0000main';

function colorRules(rounds: { line: Line; n: number }[], add: Add): void {
  let prevLast: string | undefined;
  let prevLine: Line | undefined;
  // runs over the whole spiral: [color, stitches made, round of its first stitch]
  const runs: { color: string; sts: number; n: number; first: boolean }[] = [];
  for (const { line, n } of rounds) {
    const colorOf = (op: Op) => (op.k === 'tile' ? op.color : (op.color ?? line.colorHeader ?? MAIN));
    const colors = new Set(line.ops.map(colorOf));
    const named = [...colors].filter((c) => c !== MAIN).length + (colors.has(MAIN) ? 1 : 0);
    if (named > 3) add('E_COLOR_SEQ', `Rnd ${n} uses ${named} colors; amigurumi rounds take at most 3`, { line: n });
    else if (named === 3) add('W_ROUND_COLORS', `Rnd ${n} uses 3 colors; carrying 2 extra strands is fiddly`, { line: n });
    const head = line.ops[0];
    const first = head !== undefined ? colorOf(head) : undefined;
    // a tagged first stitch (`4 sc B`) says its color itself; an untagged one needs "change to B" on the round before
    const tagged = head !== undefined && head.k !== 'tile' && head.color !== undefined && head.color !== line.colorHeader;
    if (prevLine && prevLast !== undefined && first !== undefined && first !== prevLast && prevLine !== line && !tagged) {
      const told = (prevLine.cues ?? []).some((c) => c.kind === 'color') || prevLine.join?.changeTo !== undefined;
      if (!told) add('E_COLOR_SEQ', `Rnd ${n} starts in another color, but Rnd ${n - 1} does not say to change`, { line: n - 1 });
    }
    for (const op of line.ops) {
      const c = colorOf(op);
      const sts = produced([op]);
      const last = runs[runs.length - 1];
      if (last && last.color === c) last.sts += sts;
      else runs.push({ color: c, sts, n, first: n === line.n });
    }
    if (line.ops.length > 0) prevLast = colorOf(line.ops[line.ops.length - 1]);
    prevLine = line;
  }
  if (runs.length > 1) {
    // a folded line repeats its runs: report them once, at the line's first round
    for (const r of runs) if (r.sts === 1 && r.first) add('W_SINGLE_ST', `a single stitch of ${r.color === MAIN ? 'the main color' : r.color} in Rnd ${r.n}; embroider it instead`, { line: r.n });
  }
}

// ---- cues: E_EYE_ORDER, W_EYE_OPENING, W_JOG

function cueRules(p: Piece3dInput, add: Add): void {
  const { lines } = p;
  const all = (kind: 'eyes' | 'stuff') =>
    lines.flatMap((l, i) => (l.cues ?? []).flatMap((c, j) => (c.kind === kind ? [{ i, j }] : [])));
  const stuff = all('stuff')[0];
  const closed = p.finish === 'gather' || p.finish === 'flattenSc' || p.finish === 'whipstitch';
  for (const eyes of all('eyes')) {
    const line = lines[eyes.i];
    const n = line.nEnd ?? line.n;
    if (stuff && (stuff.i < eyes.i || (stuff.i === eyes.i && stuff.j < eyes.j))) add('E_EYE_ORDER', `the safety eyes come after the stuffing cue; fit them before stuffing`, { line: n });
    if (closed && eyes.i >= lines.length - 1) add('E_EYE_ORDER', `the safety eyes come after the closing round; fit them before closing`, { line: n });
    if (line.stated * p.cell.wS < EYE_OPENING_IN - 1e-9) add('W_EYE_OPENING', `Rnd ${n} is only ${(line.stated * p.cell.wS).toFixed(1)} in around; the washers may not pass — consider embroidered eyes`, { line: n });
  }
  // W_JOG: a spiral round before a BLO/FLO round without the jogless sl st
  for (let i = 1; i < lines.length; i++) {
    const loop = sharedLoop(lines[i].ops);
    if (!loop || isJoined(lines[i]) || isJoined(lines[i - 1]) || sharedLoop(lines[i - 1].ops) === loop) continue;
    const before = lines[i - 1];
    const lastOp = before.ops[before.ops.length - 1];
    if (!(lastOp && lastOp.k === 'st' && lastOp.st === 'slst')) add('W_JOG', `Rnd ${lines[i].n} (${loop}) starts with a jog: Rnd ${before.nEnd ?? before.n} cannot end with the slip-stitch trick`, { line: lines[i].n });
  }
}

// ---- shaping: W_RUFFLE, W_FAN3, W_SPACING, W_STAGGER, W_STACKED

/** Gaps (plain ops) between consecutive specials of `ops`, cyclic or not. */
function gaps(ops: readonly Op[], cyclic: boolean): number[] {
  const at = ops.flatMap((op, i) => (isSpecial(op) ? [i] : []));
  if (at.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < at.length; i++) out.push(at[i] - at[i - 1] - 1);
  if (cyclic) out.push(ops.length - at[at.length - 1] - 1 + at[0]);
  return out;
}

/** The side segments of an oval round, merging a side split by the round start. */
function sideSegments(line: Line): Op[][] {
  const segs = line.segments ?? [];
  const parts: { kind: string; ops: Op[] }[] = segs.map((s, i) => ({ kind: s.kind, ops: line.ops.slice(s.at, i + 1 < segs.length ? segs[i + 1].at : line.ops.length) }));
  if (parts.length >= 2 && parts[0].kind === 'side' && parts[parts.length - 1].kind === 'side') {
    const lastPart = parts.pop() as { kind: string; ops: Op[] };
    parts[0] = { kind: 'side', ops: [...lastPart.ops, ...parts[0].ops] };
  }
  return parts.filter((x) => x.kind === 'side').map((x) => x.ops);
}

function shapeRules(p: Piece3dInput, rounds: { line: Line; n: number }[], add: Add): void {
  const { wS, hS } = p.cell;
  const maxStep = Math.ceil((2 * Math.PI * hS) / wS - 1e-9);
  for (let i = 1; i < rounds.length; i++) {
    const a = rounds[i - 1].line.stated;
    const b = rounds[i].line.stated;
    if (Math.abs(b - a) > maxStep) add('W_RUFFLE', `Rnd ${rounds[i].n} changes by ${b - a} sts; more than ${maxStep} per round ruffles or puckers`, { line: rounds[i].n });
  }
  for (const line of p.lines) {
    const chainOvalRnd1 = line.start?.k === 'chainOval';
    if (!chainOvalRnd1 && line.ops.some((op) => (op.k === 'inc' || op.k === 'dec') && op.n === 3)) {
      add('W_FAN3', `Rnd ${line.n} needs ${line.ops.some((op) => op.k === 'inc' && op.n === 3) ? 'inc3' : 'dec3'}: the count changes by more than one stitch per stitch`, { line: line.n });
    }
  }
  if (p.irregular) return;

  // change rounds in order (a folded line has no changes)
  type Change = { n: number; whole?: ChangeSites; sides?: ChangeSites[] };
  const changes: Change[] = [];
  for (const line of p.lines) {
    // round 1 counts only after a chain ring (worked into P = chains, as placePiece counts it); a magic ring or a
    // chain oval's first round has no round below it
    if ((line.prevCount === null && line.start?.k !== 'chainRing') || !line.ops.some(isSpecial)) continue;
    if (line.segments && line.segments.length > 0) {
      const sides = sideSegments(line);
      for (const s of sides) {
        const g = gaps(s, false);
        if (g.length > 0 && Math.max(...g) - Math.min(...g) > 1) add('W_SPACING', `Rnd ${line.n}: the changes along a side are unevenly spaced (gaps ${g.join(', ')})`, { line: line.n });
      }
      changes.push({ n: line.n, sides: sides.map(changeSites) });
    } else {
      const g = gaps(line.ops, true);
      if (g.length > 0 && Math.max(...g) - Math.min(...g) > 1) add('W_SPACING', `Rnd ${line.n}: the changes are unevenly spaced (gaps ${g.join(', ')})`, { line: line.n });
      changes.push({ n: line.n, whole: changeSites(line.ops) });
    }
  }
  // pairs of consecutive change rounds in R8's frame and scope (oval: side segments with ≥ 2 specials)
  const pairs = (a: Change, b: Change): [ChangeSites, ChangeSites][] => {
    if (a.whole && b.whole) return [[a.whole, b.whole]];
    if (a.sides && b.sides && a.sides.length === b.sides.length) {
      return a.sides.flatMap((s, i) => (s.k >= 2 && b.sides![i].k >= 2 ? [[s, b.sides![i]] as [ChangeSites, ChangeSites]] : []));
    }
    return [];
  };
  let stackRun = 1;
  for (let i = 1; i < changes.length; i++) {
    const ps = pairs(changes[i - 1], changes[i]);
    for (const [a, b] of ps) {
      if (!r8Ok(a, b)) {
        const off = minCircularOffset(a.centers, b.centers);
        add('W_STAGGER', `Rnd ${changes[i].n}: its changes sit ${off.toFixed(3)} of a round from those of Rnd ${changes[i - 1].n} (at least ${(1 / (4 * b.k)).toFixed(3)} keeps the shape round)`, { line: changes[i].n });
        break;
      }
    }
    const stacked = ps.length > 0 && ps.some(([a, b]) => r8InScope(a, b) && stackedPair(a, b));
    stackRun = stacked ? stackRun + 1 : 1;
    if (stackRun === 3) add('W_STACKED', `Rnds ${changes[i - 2].n}, ${changes[i - 1].n} and ${changes[i].n} stack their changes on top of each other; the piece will look faceted`, { line: changes[i].n });
  }
}

// ---- W_SIZE (R11), counts level (the ghost part comes with the ghost)

function sizeRules(p: Piece3dInput, c: PieceCounts, add: Add): void {
  const { wS, hS } = p.cell;
  const eps = 1e-9;
  if (c.generator === 'torus') return;
  const say = (what: string) => add('W_SIZE', `${what}; try "style: exact", more rounds, or adjust the part`);
  if (c.generator === 'textbook') {
    const T = c.counts.length;
    const made = (c.closedEnd ? T + 1 : T) * hS;
    if (Math.abs(made - c.L) > hS / 2 + eps) say(`the piece is ${made.toFixed(2)} in long against ${c.L.toFixed(2)} in`);
    if (p.textbookR !== undefined) {
      const k = Math.max(...c.counts) / 6;
      if (Math.abs(6 * k * wS - 2 * Math.PI * p.textbookR) > 3 * wS + eps) say(`the widest round (${6 * k} sts) is ${(6 * k * wS).toFixed(2)} in around against ${(2 * Math.PI * p.textbookR).toFixed(2)} in`);
    }
    return;
  }
  // Path A: N·hS against L (+1.5·hS when the pole rule shortened the closed end)
  const N = c.counts.length + (c.closedEnd ? 1 : 0);
  const allow = hS / 2 + (c.dropped > 0 ? 1.5 * hS : 0) + eps;
  if (Math.abs(N * hS - c.L) > allow) say(`the piece is ${(N * hS).toFixed(2)} in long against ${c.L.toFixed(2)} in`);
  const prof = p.profile;
  if (!prof) return;
  let widest = 0;
  for (let i = 1; i < c.counts.length; i++) if (c.counts[i] > c.counts[widest]) widest = i;
  if (c.ovalS) {
    const s = c.sk[Math.min(widest, c.sk.length - 1)] ?? 0;
    const b = profileR(prof, s);
    const amb = ovalHalfDiff(prof, s);
    const stadium = 4 * amb + 2 * Math.PI * b;
    const made = c.counts[widest] * wS;
    if (Math.abs(made - stadium) > wS + eps) say(`the widest round (${c.counts[widest]} sts) is ${made.toFixed(2)} in around against ${stadium.toFixed(2)} in`);
    return;
  }
  const maxCirc = Math.max(...c.circ);
  const target = 2 * Math.PI * prof.rMax;
  const sym = Math.max(...c.ideal) < 18 ? 4 : 6;
  const tol = p.style === 'classic' ? (sym / 2) * wS : wS;
  if (Math.abs(maxCirc * wS - target) > tol + eps) say(`the widest round (${maxCirc} sts) is ${(maxCirc * wS).toFixed(2)} in around against ${target.toFixed(2)} in`);
}
