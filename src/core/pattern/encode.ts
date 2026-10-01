// The repeat encoder (DESIGN.md §2.6.1, D8; research 07 §7.4). Step 0 kernel: pure, no DOM.
//
// `encodeOps` folds the ops of one line into the shortest list of runs (`4 sc`) and one-level repeats
// (`(sc, inc) x 6`); `expand` (ops.ts) is its inverse, and `expand(encodeOps(x))` deep-equals `x` for every
// input (R10). The same encoder serves 2D rows and 3D rounds, with two ways of cutting a line into tokens:
//
//   'ops'  — one token per op (3D rounds), so a repeat may start or end in the middle of a run of sc and
//            periodic shaping stays visible: `sc inc sc sc inc sc …` → `(sc, inc, sc) x 6`.
//   'runs' — one token per run of identical ops (2D rows: `{color, count}` atoms), so a 1 000-stitch row costs
//            as many tokens as it has color changes. A repeat is then made of whole runs.
//
// Definition (normative, §2.6.1). Cost: a run costs 1; a repeat costs its inner cost + 1; a list costs the
// sum. Among all ways to write the tokens as runs and one-level repeats, the result is the one with the lowest
// cost, then the fewest top-level items, then the shortest canonical compact text, then the lexicographically
// smallest text (UTF-16 code units).
//
// Implementation. The spec defines the search as a DP over ranges (i, j) with every split point. This file
// reaches the identical optimum with a DP over suffixes, which is O(n²) instead of O(n³):
//   - an optimal encoding is a list of items, and every item is the best encoding of the tokens it covers
//     (replace an item by a better one and the whole list gets better: all four criteria add up, and texts of
//     equal length compare part by part);
//   - a single item covering tokens i..k is either one run (all tokens equal) or a repeat. Of all the periods
//     that divide the length, only the smallest can win: the inner part of a longer period contains the
//     shorter one at least twice, so it costs strictly more. One KMP failure function per start index gives
//     the smallest period of every prefix;
//   - inside a repeat (depth 1) nothing may be bracketed, so the cheapest inner part is its run-length form.
// So best(i) = min over k of item(i..k) followed by best(k + 1). Scores are kept as three integers (cost,
// top-level items, text length); a text is built only when two candidates tie on all three. The tests compare
// this against a literal transcription of the spec's recursion and against a brute-force enumeration.
//
// Above EXACT_MAX_TOKENS tokens the spec prescribes a linear fallback (`fallbackEncode`). Results are memoised
// in an LRU keyed by fnv1a64(token ints ‖ mode), so the identical rows of a chart are encoded once.
import type { Op } from '../../types';
import { canonicalJson, createFnv1a64 } from '../kernel/hash';
import { type Item, expand, runText, tokenText } from './ops';

export { expand };
export type { Item };

/** How a line is cut into tokens: per op (3D rounds) or per run of identical ops (2D rows). See the file header. */
export type EncodeMode = 'ops' | 'runs';

/** The exact search runs up to this many tokens; longer lines use the linear fallback (§2.6.1, D8). */
export const EXACT_MAX_TOKENS = 250;
/** The fallback looks for repeats of blocks of at most this many runs. */
export const FALLBACK_MAX_PERIOD = 8;
/** Entries kept by the memo (least recently used are dropped first). */
export const MEMO_CAPACITY = 4096;
/**
 * The memo also holds at most this many token integers in total, so thousands of very long lines cannot pin
 * tens of megabytes in a worker. A line longer than this is not memoised at all.
 */
export const MEMO_MAX_TOKENS = 1 << 20;

export interface EncodeOptions {
  /** Default 'ops'. */
  mode?: EncodeMode;
  /**
   * `Line.segments`: the op index where each segment starts. Segments are encoded separately and joined, so no
   * repeat and no run crosses a boundary (oval ends vs sides, research 07 §6.9): `sc, inc, sc | 7 sc` stays
   * `sc, inc, sc, 7 sc`. The one exception is the short-circuit of §2.6.1: a line that is one op throughout is
   * one run, whatever its segments. Each segment is searched on its own, so the 120-token limit applies to a
   * segment. The order of the cuts does not matter; a repeated cut counts once; a cut at 0, at the end, outside
   * the line or not a whole number is ignored, and so is an entry that is not `{ at: number }`.
   */
  segments?: readonly { readonly at: number }[];
  /** Overrides EXACT_MAX_TOKENS (which is normative): for tests and for tuning by integration. */
  exactMaxTokens?: number;
}

// ---- Token vocabulary: every distinct op gets a small integer, for the whole life of the module.

interface Vocabulary {
  readonly ids: Map<string, number>;
  /** The frozen, canonical copy of each op: what the encoded items point to. */
  readonly ops: Op[];
  /** Canonical compact name of each op, without a count. */
  readonly text: string[];
  /** True when a run of the op always prints its count (C2C tiles: `1 A`). */
  readonly counted: boolean[];
}

// Far more distinct ops than any session produces (kinds × loops × palette colors); past it the vocabulary and
// the memo start afresh, which callers cannot observe.
const VOCABULARY_LIMIT = 1 << 16;

function newVocabulary(): Vocabulary {
  return { ids: new Map(), ops: [], text: [], counted: [] };
}

let vocabulary = newVocabulary();

function stitchCode(st: unknown): string | undefined {
  switch (st) {
    case 'sc':
      return 'a';
    case 'hdc':
      return 'b';
    case 'dc':
      return 'c';
    case 'slst':
      return 'd';
    default:
      return undefined;
  }
}

function loopCode(loop: unknown): string | undefined {
  switch (loop) {
    case undefined:
      return '0';
    case 'both':
      return '1';
    case 'BLO':
      return '2';
    case 'FLO':
      return '3';
    default:
      return undefined;
  }
}

/**
 * True for data that JSON writes and reads back unchanged: null, booleans, strings, finite numbers other than
 * −0, and arrays and plain objects of those (a field set to `undefined` counts as absent).
 */
function isPlainData(value: unknown, depth: number): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0);
    case 'object':
      break;
    default:
      return false;
  }
  if (depth > 16) return false; // deeper than any op; also ends a cycle
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!(i in value) || !isPlainData(value[i], depth + 1)) return false;
    return true;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (fields[key] !== undefined && !isPlainData(fields[key], depth + 1)) return false;
  return true;
}

/**
 * The identity of an op as a string. Two ops get the same key exactly when they are deep-equal (a field set
 * to `undefined` counts as absent; `loop: 'both'` and no `loop` are different ops, so `expand` returns each as
 * it was given). Ops of the frozen `Op` type take the short form; anything else — a field this file does not
 * know, a value outside the type — is keyed by its canonical JSON, so a future field can never be dropped.
 * That only works for plain JSON data, so anything else (NaN, a Date, a function, a cycle) is refused.
 */
function tokenKey(op: Op): string {
  if (typeof op !== 'object' || op === null) throw new TypeError(`encodeOps: an op must be an object, got ${String(op)}`);
  const f = op as unknown as Record<string, unknown>;
  let defined = 0;
  for (const name in f) if (f[name] !== undefined) defined++;
  const color = f.color;
  if (color === undefined || typeof color === 'string') {
    const tag = color === undefined ? '' : `|${color}`;
    const hasColor = color === undefined ? 0 : 1;
    const loop = loopCode(f.loop);
    const hasLoop = f.loop === undefined ? 0 : 1;
    switch (f.k) {
      case 'st': {
        const st = stitchCode(f.st);
        const hasInto = f.into === undefined ? 0 : 1;
        if (
          st !== undefined &&
          loop !== undefined &&
          (f.into === undefined || f.into === 'flo2below') &&
          defined === 2 + hasLoop + hasColor + hasInto
        ) {
          return `s${st}${loop}${hasInto}${tag}`;
        }
        break;
      }
      case 'inc':
      case 'dec':
        if ((f.n === 2 || f.n === 3) && loop !== undefined && defined === 2 + hasLoop + hasColor) {
          return `${f.k === 'inc' ? 'i' : 'd'}${f.n}${loop}${tag}`;
        }
        break;
      case 'tile':
        if (hasColor === 1 && defined === 2) return `t${tag}`;
        break;
      default:
        break;
    }
  }
  if (!isPlainData(op, 0)) throw new TypeError('encodeOps: an op may hold only plain JSON data (strings, finite numbers, booleans, null, arrays, plain objects)');
  return `?${canonicalJson(op)}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A frozen copy with only the defined fields, in a fixed order. */
function canonicalOp(op: Op): Op {
  switch (op.k) {
    case 'st': {
      const copy: Extract<Op, { k: 'st' }> = { k: 'st', st: op.st };
      if (op.loop !== undefined) copy.loop = op.loop;
      if (op.color !== undefined) copy.color = op.color;
      if (op.into !== undefined) copy.into = op.into;
      return Object.freeze(copy);
    }
    case 'inc':
    case 'dec': {
      const copy: Extract<Op, { k: 'inc' | 'dec' }> = { k: op.k, n: op.n };
      if (op.color !== undefined) copy.color = op.color;
      if (op.loop !== undefined) copy.loop = op.loop;
      return Object.freeze(copy);
    }
    case 'tile':
      return Object.freeze({ k: 'tile', color: op.color });
  }
}

function intern(op: Op): number {
  const key = tokenKey(op);
  const known = vocabulary.ids.get(key);
  if (known !== undefined) return known;
  const id = vocabulary.ops.length;
  const canonical = key.startsWith('?') ? deepFreeze(JSON.parse(key.slice(1)) as Op) : canonicalOp(op);
  vocabulary.ids.set(key, id);
  vocabulary.ops.push(canonical);
  vocabulary.text.push(tokenText(canonical));
  vocabulary.counted.push(canonical.k === 'tile');
  return id;
}

// ---- Memo (LRU): identical token lists are encoded once.

interface MemoEntry {
  readonly tag: string;
  readonly tokens: Uint32Array;
  readonly items: readonly Item[];
}

const memo = new Map<string, MemoEntry>();
let memoTokens = 0;
let memoHits = 0;
let memoMisses = 0;

/** Empties the memo and the token vocabulary (tests; also called when the vocabulary grows past its limit). */
export function resetEncodeMemo(): void {
  memo.clear();
  memoTokens = 0;
  vocabulary = newVocabulary();
  memoHits = 0;
  memoMisses = 0;
}

/** Counters of the memo, for tests and profiling: entries, token integers held, hits, misses, distinct ops seen. */
export function encodeMemoStats(): { size: number; tokens: number; hits: number; misses: number; vocabulary: number } {
  return { size: memo.size, tokens: memoTokens, hits: memoHits, misses: memoMisses, vocabulary: vocabulary.ops.length };
}

/** Puts an entry in as the most recently used one, then drops the oldest entries until both limits hold. */
function memoStore(key: string, entry: MemoEntry): void {
  const replaced = memo.get(key);
  if (replaced !== undefined) {
    memoTokens -= replaced.tokens.length;
    memo.delete(key);
  }
  if (entry.tokens.length > MEMO_MAX_TOKENS) return;
  memo.set(key, entry);
  memoTokens += entry.tokens.length;
  while (memo.size > MEMO_CAPACITY || memoTokens > MEMO_MAX_TOKENS) {
    const oldest = memo.entries().next();
    if (oldest.done === true) break;
    memoTokens -= oldest.value[1].tokens.length;
    memo.delete(oldest.value[0]);
  }
}

function sameTokens(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Small helpers

function digits(x: number): number {
  return x < 10 ? 1 : x < 100 ? 2 : x < 1000 ? 3 : String(x).length;
}

function makeRun(opId: number, n: number): Item {
  return { kind: 'run', op: vocabulary.ops[opId], n };
}

function freezeItems(items: Item[]): readonly Item[] {
  for (const item of items) {
    if (item.kind === 'rep') {
      for (const inner of item.inner) Object.freeze(inner);
      Object.freeze(item.inner);
    }
    Object.freeze(item);
  }
  return Object.freeze(items);
}

/** Run-length form of a token list: the op id and the length of each maximal run. */
function runLengths(ids: Uint32Array): [Uint32Array, Uint32Array] {
  let runs = 0;
  for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[i - 1]) runs++;
  const atomOp = new Uint32Array(runs);
  const atomCount = new Uint32Array(runs);
  let r = -1;
  for (let i = 0; i < ids.length; i++) {
    if (i === 0 || ids[i] !== ids[i - 1]) atomOp[++r] = ids[i];
    atomCount[r]++;
  }
  return [atomOp, atomCount];
}

/** One small integer per distinct (op, count) pair, so runs compare with `===`. */
function denseAtoms(atomOp: Uint32Array, atomCount: Uint32Array): Uint32Array {
  const dense = new Uint32Array(atomOp.length);
  const byOp = new Map<number, Map<number, number>>();
  let next = 0;
  for (let i = 0; i < atomOp.length; i++) {
    let byCount = byOp.get(atomOp[i]);
    if (byCount === undefined) {
      byCount = new Map();
      byOp.set(atomOp[i], byCount);
    }
    let id = byCount.get(atomCount[i]);
    if (id === undefined) {
      id = next++;
      byCount.set(atomCount[i], id);
    }
    dense[i] = id;
  }
  return dense;
}

// ---- Exact search (n ≤ EXACT_MAX_TOKENS)

/**
 * The shortest encoding of a token list (see the file header).
 * @param tok    one integer per token; equal integers = equal tokens
 * @param opId   the vocabulary id of the op each token stands for
 * @param weight how many ops each token stands for (run tokens), or null for one op per token
 */
function exactEncode(tok: Uint32Array, opId: Uint32Array, weight: Uint32Array | null): Item[] {
  const n = tok.length;
  const { ops, text, counted } = vocabulary;
  const runLen = (id: number, w: number): number => text[id].length + (w === 1 && !counted[id] ? 0 : digits(w) + 1);

  // runEnd[i]: the last index of the maximal run of equal tokens that starts at i. A run token is already a
  // whole run, so it never merges with its neighbour.
  const runEnd = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) runEnd[i] = weight === null && i + 1 < n && tok[i] === tok[i + 1] ? runEnd[i + 1] : i;
  const weightOf = (a: number, b: number): number => (weight === null ? b - a + 1 : weight[a]);

  // Best encoding of tok[i..]: its score, and its first item as (next[i] = index after the item, period[i] =
  // 0 for a run, else the length of the repeated block).
  const cost = new Int32Array(n + 1);
  const top = new Int32Array(n + 1);
  const len = new Int32Array(n + 1);
  const next = new Int32Array(n);
  const period = new Int32Array(n);
  const fail = new Int32Array(n + 1);
  const suffixText: (string | undefined)[] = new Array<string | undefined>(n + 1);

  const itemText = (i: number, end: number, p: number): string => {
    if (p === 0) return runText(ops[opId[i]], weightOf(i, end));
    const parts: string[] = [];
    const last = i + p - 1;
    for (let a = i; a <= last; ) {
      const b = Math.min(runEnd[a], last);
      parts.push(runText(ops[opId[a]], weightOf(a, b)));
      a = b + 1;
    }
    return `(${parts.join(', ')}) x ${(end - i + 1) / p}`;
  };
  // Canonical text of the best encoding of tok[j..] (final for every j > i while suffix i is being solved).
  const textFrom = (j: number): string => {
    const chain: number[] = [];
    let x = j;
    while (x < n && suffixText[x] === undefined) {
      chain.push(x);
      x = next[x];
    }
    let tail = x < n ? (suffixText[x] ?? '') : '';
    for (let c = chain.length - 1; c >= 0; c--) {
      const at = chain[c];
      const item = itemText(at, next[at] - 1, period[at]);
      tail = next[at] < n ? `${item}, ${tail}` : item;
      suffixText[at] = tail;
    }
    return tail;
  };
  const candidateText = (i: number, end: number, p: number): string =>
    end + 1 < n ? `${itemText(i, end, p)}, ${textFrom(end + 1)}` : itemText(i, end, p);

  for (let i = n - 1; i >= 0; i--) {
    let bestCost = 0;
    let bestTop = 0;
    let bestLen = 0;
    let bestNext = -1;
    let bestPeriod = 0;
    let bestText: string | undefined;
    // KMP failure function of tok[i..], extended one token at a time: fail[m] = longest proper border of the
    // first m tokens, so their smallest period is m − fail[m].
    let border = 0;
    fail[1] = 0;
    for (let k = i; k < n; k++) {
      const m = k - i + 1;
      if (m > 1) {
        const t = tok[k];
        while (border > 0 && tok[i + border] !== t) border = fail[border];
        if (tok[i + border] === t) border++;
        fail[m] = border;
      }
      let p = 0;
      let c = 1;
      let l: number;
      if (k <= runEnd[i]) {
        l = runLen(opId[i], weightOf(i, k));
      } else {
        p = m - fail[m];
        if (p < 2 || 2 * p > m || m % p !== 0) continue;
        // `(inner) x times`: the inner part is the run-length form of one period.
        l = 5 + digits(m / p) - 2;
        const last = i + p - 1;
        for (let a = i; a <= last; ) {
          const b = runEnd[a] < last ? runEnd[a] : last;
          c++;
          l += runLen(opId[a], weightOf(a, b)) + 2;
          a = b + 1;
        }
      }
      const rest = k + 1;
      const candCost = c + cost[rest];
      const candTop = 1 + top[rest];
      const candLen = rest < n ? l + 2 + len[rest] : l;
      let take: boolean;
      if (bestNext < 0 || candCost !== bestCost) take = bestNext < 0 || candCost < bestCost;
      else if (candTop !== bestTop) take = candTop < bestTop;
      else if (candLen !== bestLen) take = candLen < bestLen;
      else {
        bestText ??= candidateText(i, bestNext - 1, bestPeriod);
        const text2 = candidateText(i, k, p);
        take = text2 < bestText;
        if (take) bestText = text2;
      }
      if (take) {
        if (candCost !== bestCost || candTop !== bestTop || candLen !== bestLen) bestText = undefined;
        bestCost = candCost;
        bestTop = candTop;
        bestLen = candLen;
        bestNext = rest;
        bestPeriod = p;
      }
    }
    cost[i] = bestCost;
    top[i] = bestTop;
    len[i] = bestLen;
    next[i] = bestNext;
    period[i] = bestPeriod;
  }

  const items: Item[] = [];
  for (let i = 0; i < n; i = next[i]) {
    const end = next[i] - 1;
    const p = period[i];
    if (p === 0) {
      items.push(makeRun(opId[i], weightOf(i, end)));
    } else {
      const inner: Item[] = [];
      const last = i + p - 1;
      for (let a = i; a <= last; ) {
        const b = Math.min(runEnd[a], last);
        inner.push(makeRun(opId[a], weightOf(a, b)));
        a = b + 1;
      }
      items.push({ kind: 'rep', inner, times: (end - i + 1) / p });
    }
  }
  return items;
}

// ---- Linear fallback (n > EXACT_MAX_TOKENS, both modes)

/**
 * §2.6.1: on the run list — if the whole list is periodic (period ≤ half the list) emit `(runs) x k`;
 * otherwise scan left to right and, at each position, take the block of p ≤ 8 runs with the largest covered
 * length p·reps (reps ≥ 2, ties → smaller p) as a repeat, else emit the run and advance.
 */
function fallbackEncode(atomOp: Uint32Array, atomCount: Uint32Array): Item[] {
  const count = atomOp.length;
  const tok = denseAtoms(atomOp, atomCount);
  const block = (from: number, p: number, times: number): Item => {
    const inner: Item[] = [];
    for (let x = from; x < from + p; x++) inner.push(makeRun(atomOp[x], atomCount[x]));
    return { kind: 'rep', inner, times };
  };

  const fail = new Int32Array(count + 1);
  for (let m = 2, border = 0; m <= count; m++) {
    const t = tok[m - 1];
    while (border > 0 && tok[border] !== t) border = fail[border];
    if (tok[border] === t) border++;
    fail[m] = border;
  }
  const whole = count - fail[count];
  if (whole >= 2 && 2 * whole <= count && count % whole === 0) return [block(0, whole, count / whole)];

  const items: Item[] = [];
  let i = 0;
  while (i < count) {
    let bestP = 0;
    let bestReps = 0;
    const maxP = Math.min(FALLBACK_MAX_PERIOD, Math.floor((count - i) / 2));
    for (let p = 2; p <= maxP; p++) {
      let reps = 1;
      for (;;) {
        const at = i + reps * p;
        if (at + p > count) break;
        let same = true;
        for (let x = 0; x < p; x++) {
          if (tok[at + x] !== tok[i + x]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        reps++;
      }
      if (reps >= 2 && p * reps > bestP * bestReps) {
        bestP = p;
        bestReps = reps;
      }
    }
    if (bestP > 0) {
      items.push(block(i, bestP, bestReps));
      i += bestP * bestReps;
    } else {
      items.push(makeRun(atomOp[i], atomCount[i]));
      i++;
    }
  }
  return items;
}

// ---- One segment: tokens, memo, search

const EMPTY: readonly Item[] = Object.freeze([]);

function encodeSpan(ops: readonly Op[], from: number, to: number, mode: EncodeMode, exactMax: number): readonly Item[] {
  const n = to - from;
  if (n <= 0) return EMPTY;
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = intern(ops[from + i]);

  let atomOp: Uint32Array | null = null;
  let atomCount: Uint32Array | null = null;
  let tokens = ids;
  if (mode === 'runs') {
    [atomOp, atomCount] = runLengths(ids);
    tokens = new Uint32Array(2 * atomOp.length);
    for (let i = 0; i < atomOp.length; i++) {
      tokens[2 * i] = atomOp[i];
      tokens[2 * i + 1] = atomCount[i];
    }
  }
  const tokenCount = atomOp === null ? n : atomOp.length;

  // Short-circuit: a single token or a uniform line is one run.
  if (atomOp !== null && atomCount !== null) {
    if (tokenCount === 1) return freezeItems([makeRun(atomOp[0], atomCount[0])]);
  } else {
    let uniform = true;
    for (let i = 1; i < n && uniform; i++) uniform = ids[i] === ids[0];
    if (uniform) return freezeItems([makeRun(ids[0], n)]);
  }

  const exact = tokenCount <= exactMax;
  const tag = `${mode === 'runs' ? 'r' : 'o'}${exact ? 'e' : 'f'}`;
  const key = createFnv1a64().update(tokens).update(tag).hex();
  const hit = memo.get(key);
  if (hit !== undefined && hit.tag === tag && sameTokens(hit.tokens, tokens)) {
    memoHits++;
    memo.delete(key);
    memo.set(key, hit);
    return hit.items;
  }
  memoMisses++;

  let items: Item[];
  if (atomOp !== null && atomCount !== null) {
    items = exact ? exactEncode(denseAtoms(atomOp, atomCount), atomOp, atomCount) : fallbackEncode(atomOp, atomCount);
  } else if (exact) {
    items = exactEncode(ids, ids, null);
  } else {
    const [runOp, runCount] = runLengths(ids);
    items = fallbackEncode(runOp, runCount);
  }
  const frozen = freezeItems(items);
  memoStore(key, { tag, tokens, items: frozen });
  return frozen;
}

/** The op indexes inside the line where a new segment starts, ascending and without repeats. */
function segmentCuts(segments: EncodeOptions['segments'], length: number): number[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const inside: number[] = [];
  for (const segment of segments as readonly unknown[]) {
    if (typeof segment !== 'object' || segment === null) continue;
    const at: unknown = (segment as { at?: unknown }).at;
    if (typeof at === 'number' && Number.isInteger(at) && at > 0 && at < length) inside.push(at);
  }
  inside.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const at of inside) if (cuts.length === 0 || cuts[cuts.length - 1] !== at) cuts.push(at);
  return cuts;
}

// ---- Public API

/**
 * Encodes a list of ops as runs and one-level repeats (§2.6.1). The result is frozen and may be shared with
 * other calls: read it, never change it. `expand(encodeOps(ops, o))` deep-equals `ops` for every `o`.
 * Throws a TypeError when an element of `ops` is not an object, or holds something that is not plain JSON data
 * (only possible in a field outside the frozen `Op` type).
 */
export function encodeOps(ops: readonly Op[], o: EncodeOptions = {}): readonly Item[] {
  if (vocabulary.ops.length > VOCABULARY_LIMIT) resetEncodeMemo();
  const mode: EncodeMode = o.mode === 'runs' ? 'runs' : 'ops';
  const limit = o.exactMaxTokens;
  const exactMax = typeof limit === 'number' && limit >= 0 ? Math.floor(limit) : EXACT_MAX_TOKENS;
  const cuts = segmentCuts(o.segments, ops.length);
  if (cuts.length === 0) return encodeSpan(ops, 0, ops.length, mode, exactMax);

  const out: Item[] = [];
  let from = 0;
  for (let s = 0; s <= cuts.length; s++) {
    const to = s < cuts.length ? cuts[s] : ops.length;
    for (const item of encodeSpan(ops, from, to, mode, exactMax)) out.push(item);
    from = to;
  }
  // §2.6.1 short-circuit: a uniform line is one run. Interned ops are singletons, so `===` means "the same op".
  const first = out[0];
  if (first.kind === 'run' && out.every((item) => item.kind === 'run' && item.op === first.op)) {
    let n = 0;
    for (const item of out) if (item.kind === 'run') n += item.n;
    return freezeItems([{ kind: 'run', op: first.op, n }]);
  }
  return Object.freeze(out);
}

/** The cost the encoder minimises: 1 per run, inner cost + 1 per repeat. */
export function encodeCost(items: readonly Item[]): number {
  let total = 0;
  for (const item of items) total += item.kind === 'run' ? 1 : 1 + encodeCost(item.inner);
  return total;
}

/**
 * The canonical compact text of an encoded line: `sc, (inc, 2 sc) x 5, inc, sl st`. US names, with the loop and
 * the color on every token. This is the text the encoder compares when two encodings tie; the compact renderer
 * (compact.ts) prints the same structure with the line's own header, loop prefix and whole-line phrases.
 */
export function canonicalCompact(items: readonly Item[]): string {
  const parts: string[] = [];
  for (const item of items) {
    parts.push(item.kind === 'run' ? runText(item.op, item.n) : `(${canonicalCompact(item.inner)}) x ${item.times}`);
  }
  return parts.join(', ');
}
