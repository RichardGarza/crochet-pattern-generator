// Track T7 — text carriers (DESIGN.md §3.7.2 first row): pasted chat replies, `.txt`, `.md`, and the JSON reading
// every carrier shares: the forbidden-key reviver (§3.7.6 security), JSON then JSON5, text clean-up (BOM,
// zero-width characters, smart quotes), code fences and the whitespace-tolerant brace scan of §3.7.4 E4.
import JSON5 from 'json5';
import { ForbiddenKeyError, isPlainObject } from './common';

/** Keys rejected anywhere in imported JSON (§3.7.6). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** `"schema": "crochet-model"`, whitespace-tolerant; also the JSON5 / JS spellings (`schema: 'crochet-model'`). */
export const SPEC_KEY_RE = /["']?schema["']?\s*:\s*["']crochet-model["']/g;

function reviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_KEYS.has(key)) throw new ForbiddenKeyError(key);
  return value;
}

export type JsonParse =
  | { ok: true; value: unknown; parser: 'json' | 'json5' }
  | { ok: false; error: string; forbidden?: string };

/**
 * `JSON.parse`, then JSON5 (comments, trailing commas, single quotes, unquoted keys), both through a reviver that
 * rejects `__proto__`, `constructor` and `prototype` keys at any depth. Both parsers define such keys as own
 * properties (they never set a prototype), so the reviver sees them.
 */
export function parseJsonSafe(text: string): JsonParse {
  let firstError = '';
  try {
    return { ok: true, value: JSON.parse(text, reviver), parser: 'json' };
  } catch (error) {
    if (error instanceof ForbiddenKeyError) return { ok: false, error: error.message, forbidden: error.key };
    firstError = (error as Error).message;
  }
  try {
    return { ok: true, value: JSON5.parse(text, reviver), parser: 'json5' };
  } catch (error) {
    if (error instanceof ForbiddenKeyError) return { ok: false, error: error.message, forbidden: error.key };
  }
  return { ok: false, error: firstError };
}

// ---- clean-up

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/** BOM, zero-width characters and soft hyphens removed; non-breaking and other odd spaces become plain spaces. */
export function cleanText(text: string): string {
  return text.replace(ZERO_WIDTH, '').replace(ODD_SPACES, ' ').replace(LINE_SEPARATORS, '\n').replace(/\r\n?/g, '\n');
}

const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB\uFF02]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\uFF07]/g;

/** Curly and other typographic quotes → `"` / `'` (what a chat app or a word processor does to JSON). */
export function straightenQuotes(text: string): string {
  return text.replace(DOUBLE_QUOTES, '"').replace(SINGLE_QUOTES, "'");
}

/** True when the text holds a typographic quote that `straightenQuotes` would change. */
function hasSmartQuotes(text: string): boolean {
  return text.search(DOUBLE_QUOTES) >= 0 || text.search(SINGLE_QUOTES) >= 0;
}

/** Bytes → text: UTF-8 (BOM stripped), or UTF-16 with its BOM. Invalid sequences become U+FFFD. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

// ---- specs

/** A spec as found in JSON: an object whose `schema` is `crochet-model`, or one with a non-empty `parts` array. */
export function isSpecLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.schema === 'crochet-model') return true;
  return value.schema === undefined && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(isPlainObject);
}

/** A work budget shared by the brace matching and parsing of one scan: characters looked at and parse attempts. */
export interface ScanBudget {
  chars: number;
  parses: number;
}

/**
 * The index of the brace or bracket closing the one at `open`, or −1. Aware of `"…"`, `'…'` and `` `…` ``
 * strings (with backslash escapes) and of `//` and `/* *\/` comments, so JSON5 and JS object literals match too.
 * With a `budget`, the characters looked at are charged to it and the search stops when it runs out.
 */
export function braceMatch(text: string, open: number, maxLength = Infinity, budget?: ScanBudget): number {
  const stack: string[] = [];
  const limit = budget ? Math.max(0, budget.chars) : Infinity;
  const stop = Math.min(text.length, open + maxLength, open + limit);
  let i = open;
  let found = -1;
  scan: for (; i < stop; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < stop && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const end = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      if (end < 0 || end >= stop) {
        i = stop;
        break;
      }
      i = text[i + 1] === '/' ? end : end + 1;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) break scan;
      if (stack.length === 0) {
        found = i;
        break scan;
      }
    }
  }
  if (budget) budget.chars -= Math.max(1, Math.min(i, stop) - open + 1);
  return found;
}

export interface ScanHit {
  value: Record<string, unknown>;
  start: number;
  end: number;
  parser: 'json' | 'json5';
}

export type ScanResult = { hit: ScanHit } | { forbidden: string; error: string } | { error: string } | null;

/** How many enclosing braces are tried, and how many braces are looked at, around one match. */
const MAX_ENCLOSING = 64;
const MAX_BRACES = 512;
/** Fences holding `crochet-model` that are tried, the last ones first. */
const MAX_FENCES = 16;
/** A spec is at most 2 MB (§3.5.2); no object longer than that is matched. */
const MAX_SPEC_CHARS = 2 * 1024 * 1024;
/** Parse attempts per scan. */
const MAX_PARSES = 64;

/** The budget of one scan of `length` characters (one text or several): 4 passes over it, at least 4 MB. */
export function scanBudget(length: number): ScanBudget {
  return { chars: Math.max(4 * length, 4 * 1024 * 1024), parses: MAX_PARSES };
}

/**
 * §3.7.4 E4: every match of `"schema": "crochet-model"` (whitespace-tolerant), then the innermost enclosing
 * brace-matched object whose own `schema` is `crochet-model` and that parses (JSON, then JSON5). `order` picks
 * the first or the last such object in the text (a chat reply's latest spec is its last one). The work is bounded
 * (`scanBudget`): brace matches are remembered per opening brace, failed parses are not retried, and the scan
 * gives up when the budget is spent, so hostile text cannot make it super-linear.
 */
export function braceScan(text: string, order: 'first' | 'last' = 'first', budget: ScanBudget = scanBudget(text.length)): ScanResult {
  const matches: number[] = [];
  for (const m of text.matchAll(SPEC_KEY_RE)) matches.push(m.index);
  if (order === 'last') matches.reverse();
  let lastError: ScanResult = null;
  const closeOf = new Map<number, number>();
  const failed = new Set<number>();
  const close = (j: number): number => {
    let end = closeOf.get(j);
    if (end === undefined) {
      end = braceMatch(text, j, MAX_SPEC_CHARS, budget);
      closeOf.set(j, end);
    }
    return end;
  };
  for (const at of matches) {
    let tried = 0;
    let examined = 0;
    let prev = at;
    for (let j = text.lastIndexOf('{', at); j >= 0 && tried < MAX_ENCLOSING && examined++ < MAX_BRACES; j = j > 0 ? text.lastIndexOf('{', j - 1) : -1) {
      // the backward walk to this brace is work too
      budget.chars -= prev - j + 1;
      prev = j;
      if (budget.chars <= 0 || budget.parses <= 0) return lastError;
      const end = close(j);
      if (end < at) continue;
      tried++;
      if (failed.has(j)) continue;
      budget.parses--;
      budget.chars -= end + 1 - j;
      const parsed = parseJsonSafe(text.slice(j, end + 1));
      if (!parsed.ok) {
        if (parsed.forbidden) return { forbidden: parsed.forbidden, error: parsed.error };
        failed.add(j);
        lastError ??= { error: parsed.error };
        continue;
      }
      if (isPlainObject(parsed.value) && parsed.value.schema === 'crochet-model') {
        return { hit: { value: parsed.value, start: j, end: end + 1, parser: parsed.parser } };
      }
      failed.add(j);
    }
  }
  return lastError;
}

export interface Fence {
  lang: string;
  body: string;
}

/** Markdown code fences (``` or ~~~, three or more, closed by the same run; an unclosed fence runs to the end). */
export function codeFences(text: string): Fence[] {
  const lines = text.split('\n');
  const fences: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
      body.push(lines[j]);
    }
    fences.push({ lang: open[2].toLowerCase(), body: body.join('\n') });
    i = j;
  }
  return fences;
}

export type TextSpec =
  | { ok: true; value: Record<string, unknown>; how: string; confidence: 'high' | 'medium' }
  | { ok: false; error?: string; forbidden?: string };

/** One fence body or one text: the whole of it as JSON, else the brace scan. */
function specFromChunk(chunk: string, order: 'first' | 'last', budget: ScanBudget): TextSpec {
  const trimmed = chunk.trim();
  if (trimmed.startsWith('{') && budget.parses > 0) {
    budget.parses--;
    budget.chars -= trimmed.length;
    const whole = parseJsonSafe(trimmed);
    if (whole.ok && isPlainObject(whole.value) && whole.value.schema === 'crochet-model') return { ok: true, value: whole.value, how: whole.parser, confidence: 'high' };
    if (!whole.ok && whole.forbidden) return { ok: false, forbidden: whole.forbidden, error: whole.error };
  }
  const scan = braceScan(chunk, order, budget);
  if (scan && 'hit' in scan) return { ok: true, value: scan.hit.value, how: `brace scan (${scan.hit.parser})`, confidence: 'high' };
  if (scan && 'forbidden' in scan) return { ok: false, forbidden: scan.forbidden, error: scan.error };
  return { ok: false, error: scan?.error };
}

/**
 * §3.7.2, pasted text / `.txt` / `.md`: the last code fence that contains `crochet-model` (earlier ones if it does
 * not parse), then a brace scan of the whole text for the last spec. Each is tried on the cleaned text and, when
 * it has typographic quotes, again with straightened quotes; JSON then JSON5 each time.
 */
export function specFromText(text: string): TextSpec {
  const cleaned = cleanText(text);
  const variants = hasSmartQuotes(cleaned) ? [cleaned, straightenQuotes(cleaned)] : [cleaned];
  let error: string | undefined;
  for (const [k, variant] of variants.entries()) {
    const quotes = k === 1 ? ', smart quotes straightened' : '';
    // one budget for the whole text: hostile pastes cannot make the search super-linear; the last fences matter most
    const budget = scanBudget(variant.length);
    const fences = codeFences(variant)
      .filter((f) => f.body.includes('crochet-model'))
      .slice(-MAX_FENCES);
    for (let i = fences.length - 1; i >= 0; i--) {
      const r = specFromChunk(fences[i].body, 'last', budget);
      if (r.ok) return { ...r, how: `code fence, ${r.how}${quotes}` };
      if (r.forbidden) return r;
      error ??= r.error;
    }
    const r = specFromChunk(variant, 'last', budget);
    if (r.ok) return { ...r, how: `text, ${r.how}${quotes}`, confidence: r.how.startsWith('brace') ? 'medium' : 'high' };
    if (r.forbidden) return r;
    error ??= r.error;
  }
  return { ok: false, error };
}
