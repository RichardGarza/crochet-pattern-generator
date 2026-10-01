// Track T2 — vertical block repeats of a 2D piece (DESIGN.md §2.6.2): the longest consecutively repeated block of
// L ≥ 2 lines becomes `Rows 13–24: rep Rows 1–12.` Flat work (and turned rounds) needs an even L, so every
// repeated row keeps its side and reading direction; rounds worked in one direction take any L.
//
// In the `Line` model a repeat is a note on the last line of the block it repeats (`Line.notes`), and the
// repeated lines are left out of `Piece.lines`; the 2D validators read the note back (`parseRepeatNote`) and
// check the rows it stands for against the chart (E_RUN_SUM coverage, E_FOLD). Two lines are the same line when
// everything but their number is equal: start, side, arrow, ops, cues, join, notes, counts. The first line of a
// piece (worked into the foundation chain or ring) is never part of a block, since repeating it would not start
// from the chain. A block whose lines are all identical is left to line folding (§2.6.2).
import type { Line } from '../../types';
import { canonicalJson } from '../kernel/hash';

export interface BlockRepeat {
  /** First and last line of the block that is worked again. */
  source: [number, number];
  /** First and last line the repeat stands for (`from = source[1] + 1`). */
  from: number;
  to: number;
  /** How many more times the block is worked (≥ 1). */
  times: number;
}

function lineKey(line: Line): string {
  const { n: _n, nEnd: _nEnd, ...rest } = line;
  return canonicalJson(rest);
}

/**
 * The block repeat that saves the most lines (ties: the shorter block, then the earlier one), or null.
 * `lines` are the unfolded lines of one piece, numbered 1, 2, 3, … in order. `even`: blocks of an even number of
 * lines only (flat work).
 */
export function findBlockRepeat(lines: readonly Line[], o: { even: boolean }): BlockRepeat | null {
  const n = lines.length;
  for (let i = 0; i < n; i++) if (lines[i].n !== i + 1 || (lines[i].nEnd !== undefined && lines[i].nEnd !== lines[i].n)) return null;
  const ids = new Map<string, number>();
  const key = lines.map((line) => {
    const k = lineKey(line);
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  });
  let best: { L: number; s: number; reps: number; saved: number } | null = null;
  // Index 0 is the first line of the piece: never part of a block.
  for (let L = 2; 1 + 2 * L <= n; L++) {
    if (o.even && L % 2 === 1) continue;
    // m[i]: line i equals line i + L. A run of t equal positions from s holds floor(t / L) more copies of the
    // block s..s+L−1.
    let i = 1;
    while (i + L < n) {
      if (key[i] !== key[i + L]) {
        i++;
        continue;
      }
      let t = 0;
      while (i + t + L < n && key[i + t] === key[i + t + L]) t++;
      const reps = Math.floor(t / L);
      if (reps >= 1) {
        let constant = true;
        for (let j = i + 1; j < i + L; j++) if (key[j] !== key[i]) constant = false;
        const saved = L * reps;
        if (!constant && (best === null || saved > best.saved || (saved === best.saved && L < best.L))) best = { L, s: i, reps, saved };
      }
      i += Math.max(1, t);
    }
  }
  if (best === null) return null;
  const first = best.s + 1;
  return { source: [first, first + best.L - 1], from: first + best.L, to: first + best.L * (best.reps + 1) - 1, times: best.reps };
}

/** `Rows 13–24: rep Rows 1–12.` / `Rnds 9–16: rep Rnds 5–8 2 times.` */
export function repeatNoteText(rep: BlockRepeat, kind: Line['kind']): string {
  const word = kind === 'rnd' || kind === 'border' ? 'Rnds' : 'Rows';
  const more = rep.times === 1 ? '' : ` ${rep.times} times`;
  return `${word} ${rep.from}–${rep.to}: rep ${word} ${rep.source[0]}–${rep.source[1]}${more}.`;
}

const NOTE = /^(Rows|Rnds) (\d+)–(\d+): rep (Rows|Rnds) (\d+)–(\d+)(?: (\d+) times)?\.$/;

/** The repeat a note states, or null for any other note. */
export function parseRepeatNote(text: string): BlockRepeat | null {
  const m = NOTE.exec(typeof text === 'string' ? text : '');
  if (m === null || m[1] !== m[4]) return null;
  const times = m[7] === undefined ? 1 : Number(m[7]);
  return { from: Number(m[2]), to: Number(m[3]), source: [Number(m[5]), Number(m[6])], times };
}

/** The repeat stated in a line's notes, or null. */
export function lineRepeat(line: Pick<Line, 'notes'>): BlockRepeat | null {
  for (const note of Array.isArray(line.notes) ? line.notes : []) {
    const rep = parseRepeatNote(note);
    if (rep !== null) return rep;
  }
  return null;
}

/** The lines with the repeated ones left out and the note on the block's last line. */
export function applyBlockRepeat(lines: readonly Line[], rep: BlockRepeat): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    if (line.n >= rep.from && line.n <= rep.to) continue;
    if (line.n === rep.source[1]) out.push({ ...line, notes: [...(line.notes ?? []), repeatNoteText(rep, line.kind)] });
    else out.push(line);
  }
  return out;
}
