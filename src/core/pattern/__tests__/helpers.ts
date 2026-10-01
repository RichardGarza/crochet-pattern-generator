// Test helpers for the pattern kernels. Not a test file, and not part of the app.
//
// Everything here is deliberately independent of encode.ts: a parser for the compact notation of the spec's
// test vectors, the placement rule of DESIGN.md §2.10.8 (T4 owns the real one), a literal transcription of the
// encoder's definition (§2.6.1) and a brute-force search.
import type { Line, Loop, Op } from '../../../types';
import type { Rng } from '../../kernel/prng';
import { type Item, runText } from '../ops';

// ---- Ops

export const sc: Op = { k: 'st', st: 'sc' };
export const hdc: Op = { k: 'st', st: 'hdc' };
export const dc: Op = { k: 'st', st: 'dc' };
export const slst: Op = { k: 'st', st: 'slst' };
export const inc: Op = { k: 'inc', n: 2 };
export const inc3: Op = { k: 'inc', n: 3 };
export const dec: Op = { k: 'dec', n: 2 };
export const dec3: Op = { k: 'dec', n: 3 };
export const tile = (color: string): Op => ({ k: 'tile', color });

/** `n` copies of `op` (fresh objects). */
export function times(n: number, ...ops: Op[]): Op[] {
  const out: Op[] = [];
  for (let i = 0; i < n; i++) for (const op of ops) out.push({ ...op });
  return out;
}

/** The same op in a color. */
export function colored<T extends Op>(op: T, color: string): T {
  return { ...op, color };
}

/** The same ops worked in one loop. */
export function inLoop(ops: readonly Op[], loop: Loop): Op[] {
  return ops.map((op) => (op.k === 'tile' ? op : { ...op, loop }));
}

// ---- A parser for the compact notation used by research 07 §7.6 and DESIGN.md

const WORDS: Record<string, Op> = {
  sc,
  hdc,
  dc,
  'sl st': slst,
  inc,
  inc3,
  dec,
  dec3,
  // "invdec" and "sc2tog" are ways to work a decrease (research 07 §6.5).
  invdec: dec,
  sc2tog: dec,
  sc3tog: dec3,
};

function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function parseToken(token: string): Op {
  if (/^[A-Z]$/.test(token)) return { k: 'tile', color: token }; // a C2C tile: `1 A`
  let rest = token;
  let color: string | undefined;
  let loop: Loop | undefined;
  const colorMatch = / ([A-Z])$/.exec(rest);
  if (colorMatch !== null) {
    color = colorMatch[1];
    rest = rest.slice(0, -2);
  }
  const loopMatch = / (BLO|FLO)$/.exec(rest);
  if (loopMatch !== null) {
    loop = loopMatch[1] as Loop;
    rest = rest.slice(0, -4);
  }
  if (!Object.hasOwn(WORDS, rest)) throw new Error(`parseBody: unknown stitch "${token}"`);
  const op: Op = { ...WORDS[rest] };
  if (loop !== undefined && op.k !== 'tile') op.loop = loop;
  if (color !== undefined) op.color = color;
  return op;
}

function parseList(list: string): Op[] {
  const out: Op[] = [];
  for (const part of splitTop(list)) {
    const repeat = /^\((.*)\) x (\d+)$/.exec(part);
    if (repeat !== null) {
      const inner = parseList(repeat[1]);
      for (let i = 0; i < Number(repeat[2]); i++) out.push(...inner.map((op) => ({ ...op })));
      continue;
    }
    const run = /^(?:(\d+) )?(.+)$/.exec(part);
    if (run === null) throw new Error(`parseBody: cannot read "${part}"`);
    const op = parseToken(run[2]);
    for (let i = 0; i < Number(run[1] ?? 1); i++) out.push({ ...op });
  }
  return out;
}

/**
 * Reads the body of a compact line into ops: `sc, inc, (2 sc, inc) x 5, sc`, `6 sc in MR`,
 * `inc in each st around`, `dec around`, `BLO (2 sc, sc2tog) x 6`, `4 sc A, 3 sc B`. The whole-line phrases
 * need the previous count.
 */
export function parseBody(body: string, prev: number | null = null): Op[] {
  let text = body.trim();
  let loop: Loop | undefined;
  const loopPrefix = /^(BLO|FLO) /.exec(text);
  if (loopPrefix !== null) {
    loop = loopPrefix[1] as Loop;
    text = text.slice(4);
  }
  let ops: Op[];
  const ring = /^(\d+) (.+) in MR$/.exec(text);
  const each = /^(.+) in each st (?:around|across)$/.exec(text);
  const all = /^(.+) (?:around|across)$/.exec(text);
  if (ring !== null) {
    ops = times(Number(ring[1]), parseToken(ring[2]));
  } else if (each !== null) {
    if (prev === null) throw new Error('parseBody: "in each st" needs the previous count');
    ops = times(prev, parseToken(each[1]));
  } else if (all !== null) {
    if (prev === null) throw new Error('parseBody: "around" needs the previous count');
    const op = parseToken(all[1]);
    const uses = op.k === 'dec' ? op.n : 1;
    if (prev % uses !== 0) throw new Error(`parseBody: ${prev} sts cannot be worked "${text}"`);
    ops = times(prev / uses, op);
  } else {
    ops = parseList(text);
  }
  return loop === undefined ? ops : inLoop(ops, loop);
}

// ---- Lines

/** A spiral round `n` with the given ops; `stated` defaults to what the ops make. */
export function rnd(n: number, ops: Op[], prevCount: number | null, extra: Partial<Line> = {}): Line {
  return { kind: 'rnd', n, ops, prevCount, stated: madeBy(ops), ...extra };
}

/** A flat row. */
export function row(n: number, ops: Op[], prevCount: number | null, extra: Partial<Line> = {}): Line {
  return { kind: 'row', n, ops, prevCount, stated: madeBy(ops), ...extra };
}

function madeBy(ops: readonly Op[]): number {
  let total = 0;
  for (const op of ops) total += op.k === 'inc' ? op.n : 1;
  return total;
}

function usedBy(ops: readonly Op[]): number {
  let total = 0;
  for (const op of ops) total += op.k === 'dec' ? op.n : 1;
  return total;
}

/** Counts with a table of their own, so tests of ops.ts do not check it against itself. */
export const count = { made: madeBy, used: usedBy };

// ---- DESIGN.md §2.10.8: placing increases and decreases (inc/dec only; no inc3/dec3 sites)

/**
 * One round from P to T stitches:
 *   increase: k = T − P sites, plain = P − k;  decrease: k = P − T sites, plain = T − k
 *   g = floor(plain / k), r = plain mod k
 *   base = [(g+1) sc, special] × r ++ [g sc, special] × (k − r)
 *   changeIdx even ⇒ rotate base left by ceil(g/2) ops; odd ⇒ no rotation
 */
export function placeRound(P: number, T: number, changeIdx: number): Op[] {
  if (T === P) return times(P, sc);
  const growing = T > P;
  const k = Math.abs(T - P);
  const plain = growing ? P - k : T - k;
  if (plain < 0) throw new Error(`placeRound: ${P} → ${T} needs inc3/dec3`);
  const special = growing ? inc : dec;
  const g = Math.floor(plain / k);
  const r = plain % k;
  const base: Op[] = [];
  for (let group = 0; group < k; group++) {
    base.push(...times(group < r ? g + 1 : g, sc), { ...special });
  }
  if (changeIdx % 2 !== 0) return base;
  const shift = Math.ceil(g / 2) % base.length;
  return [...base.slice(shift), ...base.slice(0, shift)];
}

/** The lines of a piece worked in a spiral from a magic ring, from its stitch counts (§2.10.5, §2.10.8). */
export function spiralLines(counts: readonly number[]): Line[] {
  const lines: Line[] = [];
  let changeIdx = 0;
  for (let i = 0; i < counts.length; i++) {
    if (i === 0) {
      lines.push(rnd(1, times(counts[0], sc), null, { start: { k: 'mr', n: counts[0] } }));
      continue;
    }
    const ops = placeRound(counts[i - 1], counts[i], changeIdx);
    if (counts[i] !== counts[i - 1]) changeIdx++;
    lines.push(rnd(i + 1, ops, counts[i - 1]));
  }
  return lines;
}

/** Folds consecutive plain rounds with identical ops into one line (`Rnds 7–12`), as a generator would. */
export function foldPlain(lines: readonly Line[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    const foldable =
      last !== undefined &&
      line.start === undefined &&
      last.start === undefined &&
      line.stated === line.prevCount &&
      last.stated === last.prevCount &&
      line.stated === last.stated &&
      JSON.stringify(line.ops) === JSON.stringify(last.ops);
    if (foldable && last !== undefined) last.nEnd = line.n;
    else out.push({ ...line });
  }
  return out;
}

// ---- The encoder's definition, transcribed literally (DESIGN.md §2.6.1, research 07 §7.4)

export type RefItem = { kind: 'run'; op: Op; n: number } | { kind: 'rep'; inner: RefItem[]; times: number };

export function refText(items: readonly RefItem[]): string {
  return items.map((item) => (item.kind === 'run' ? runText(item.op, item.n) : `(${refText(item.inner)}) x ${item.times}`)).join(', ');
}

interface RefEncoding {
  cost: number;
  items: RefItem[];
}

/** better(a, b): lower cost → fewer top-level items → shorter canonical compact string → lexicographic. */
function better(a: RefEncoding | null, b: RefEncoding): RefEncoding {
  if (a === null) return b;
  if (a.cost !== b.cost) return a.cost < b.cost ? a : b;
  if (a.items.length !== b.items.length) return a.items.length < b.items.length ? a : b;
  const ta = refText(a.items);
  const tb = refText(b.items);
  if (ta.length !== tb.length) return ta.length < tb.length ? a : b;
  return ta <= tb ? a : b;
}

/**
 * encode(i, j, depth) exactly as the spec writes it, over tokens given as (key, op, weight): identical keys are
 * identical tokens; a token stands for `weight` ops (1 in 'ops' mode, the run length in 'runs' mode).
 */
export function referenceEncode(tokens: readonly { key: string; op: Op; weight: number }[]): RefEncoding {
  if (tokens.length === 0) return { cost: 0, items: [] };
  const memo = new Map<string, RefEncoding>();
  const encode = (i: number, j: number, depth: number): RefEncoding => {
    const id = `${i},${j},${depth}`;
    const known = memo.get(id);
    if (known !== undefined) return known;
    let result: RefEncoding;
    let uniform = true;
    for (let x = i + 1; x <= j; x++) if (tokens[x].key !== tokens[i].key) uniform = false;
    if (uniform) {
      let weight = 0;
      for (let x = i; x <= j; x++) weight += tokens[x].weight;
      result = { cost: 1, items: [{ kind: 'run', op: tokens[i].op, n: weight }] };
    } else {
      let best: RefEncoding | null = null;
      for (let k = i; k < j; k++) {
        const a = encode(i, k, depth);
        const b = encode(k + 1, j, depth);
        best = better(best, { cost: a.cost + b.cost, items: [...a.items, ...b.items] });
      }
      if (depth === 0) {
        const n = j - i + 1;
        for (let p = 2; p <= n / 2; p++) {
          if (n % p !== 0) continue;
          let periodic = true;
          for (let x = i + p; x <= j; x++) if (tokens[x].key !== tokens[x - p].key) periodic = false;
          if (!periodic) continue;
          const inner = encode(i, i + p - 1, 1);
          best = better(best, { cost: inner.cost + 1, items: [{ kind: 'rep', inner: inner.items, times: n / p }] });
        }
      }
      if (best === null) throw new Error('referenceEncode: no encoding');
      result = best;
    }
    memo.set(id, result);
    return result;
  };
  return encode(0, tokens.length - 1, 0);
}

/** A key that identifies an op for the reference: its JSON with sorted keys. */
export function opKey(op: Op): string {
  const fields = op as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(fields)
      .filter((name) => fields[name] !== undefined)
      .sort()
      .map((name) => [name, fields[name]]),
  );
}

/** One token per op. */
export function opTokens(ops: readonly Op[]): { key: string; op: Op; weight: number }[] {
  return ops.map((op) => ({ key: opKey(op), op, weight: 1 }));
}

/** One token per run of identical ops. */
export function runTokens(ops: readonly Op[]): { key: string; op: Op; weight: number }[] {
  const out: { key: string; op: Op; weight: number }[] = [];
  let lastKey = '';
  for (const op of ops) {
    const key = opKey(op);
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && key === lastKey) last.weight++;
    else out.push({ key, op, weight: 1 });
    lastKey = key;
  }
  for (const token of out) token.key = `${token.key}×${token.weight}`;
  return out;
}

/**
 * The lowest cost over EVERY way to write the tokens as runs and one-level repeats, by exhaustive search (no
 * dynamic programming): the first item is any run or any repeat of any period, then the rest.
 */
export function bruteForceCost(keys: readonly string[]): number {
  const runCount = (from: number, to: number): number => {
    let runs = 1;
    for (let x = from + 1; x <= to; x++) if (keys[x] !== keys[x - 1]) runs++;
    return runs;
  };
  const search = (i: number): number => {
    if (i === keys.length) return 0;
    let best = Infinity;
    for (let k = i; k < keys.length; k++) {
      const n = k - i + 1;
      let uniform = true;
      for (let x = i + 1; x <= k; x++) if (keys[x] !== keys[i]) uniform = false;
      if (uniform) best = Math.min(best, 1 + search(k + 1));
      for (let p = 1; p <= n / 2; p++) {
        if (n % p !== 0) continue;
        let periodic = true;
        for (let x = i + p; x <= k; x++) if (keys[x] !== keys[x - p]) periodic = false;
        if (periodic) best = Math.min(best, runCount(i, i + p - 1) + 1 + search(k + 1));
      }
    }
    return best;
  };
  return search(0);
}

// ---- Random lines

const RANDOM_OPS: readonly Op[] = [
  sc,
  inc,
  dec,
  slst,
  hdc,
  inc3,
  dec3,
  { k: 'st', st: 'sc', color: 'A' },
  { k: 'st', st: 'sc', color: 'B' },
  { k: 'st', st: 'sc', loop: 'BLO' },
  { k: 'dec', n: 2, loop: 'BLO' },
  { k: 'inc', n: 2, color: 'A' },
  { k: 'st', st: 'dc', loop: 'FLO', into: 'flo2below' },
  { k: 'st', st: 'sc', loop: 'both' },
  { k: 'tile', color: 'A' },
  { k: 'tile', color: 'B' },
];

/** A random op list over the first `alphabet` ops of a fixed list (sc, inc, dec, …). */
export function randomOps(rng: Rng, length: number, alphabet: number): Op[] {
  const out: Op[] = [];
  for (let i = 0; i < length; i++) out.push({ ...RANDOM_OPS[Math.floor(rng() * Math.min(alphabet, RANDOM_OPS.length))] });
  return out;
}

/**
 * A random op list with structure: blocks that repeat, runs, and a few stray ops, so that repeats, rotations
 * and near-repeats all occur.
 */
export function structuredOps(rng: Rng, target: number, alphabet: number): Op[] {
  const out: Op[] = [];
  while (out.length < target) {
    const roll = rng();
    if (roll < 0.5) {
      const block = randomOps(rng, 1 + Math.floor(rng() * 5), alphabet);
      const reps = 1 + Math.floor(rng() * 6);
      for (let r = 0; r < reps; r++) out.push(...block.map((op) => ({ ...op })));
    } else if (roll < 0.8) {
      out.push(...times(1 + Math.floor(rng() * 9), randomOps(rng, 1, alphabet)[0]));
    } else {
      out.push(...randomOps(rng, 1, alphabet));
    }
  }
  return out.slice(0, target);
}

/**
 * Strict equality of two op lists, field by field (what `toStrictEqual` checks, without its cost on thousands
 * of long lists). Use `expect(a).toStrictEqual(b)` afterwards to get a readable difference.
 */
export function sameOpList(a: readonly Op[], b: readonly Op[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const key of keys) if (!Object.hasOwn(y, key) || x[key] !== y[key]) return false;
  }
  return true;
}

/** Items as plain data (no frozen objects), for `toEqual`. */
export function plain(items: readonly Item[]): unknown {
  return JSON.parse(JSON.stringify(items));
}
