// Small checks shared by the gauge modules. Internal: index.ts does not re-export this file.
import type { TechniqueId } from '../../types/gauge';
import type { Cyc } from '../../types/units';

export function freeze<T extends object>(o: T): Readonly<T> {
  return Object.freeze(o);
}

/** Neither undefined nor null: a field read back from JSON may be null where the type says undefined. */
export function present<T>(x: T | undefined | null): x is T {
  return x !== undefined && x !== null;
}

/** A finite number above 0. */
export function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** A finite number, 0 or above. */
export function nonNegative(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/**
 * A value as it should read in an error message. Text is quoted and marked, so the text "4" is not mistaken for
 * the number 4 ("must be a number 0–7, got 4" would read as a contradiction).
 */
export function show(v: unknown): string {
  if (typeof v === 'string') return `"${v}" (text)`;
  try {
    return String(v);
  } catch {
    return typeof v; // an object without a string form
  }
}

/** One decimal, without a trailing ".0". */
export function fmt(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export const TECHNIQUE_IDS: readonly TechniqueId[] = freeze<TechniqueId[]>([
  'sc_graphgan',
  'sc_tapestry',
  'sc_tapestry_round',
  'c2c',
  'hdc_graphgan',
  'mosaic_overlay',
  'amigurumi_sc',
]);

export function isTechnique(t: unknown): t is TechniqueId {
  return typeof t === 'string' && (TECHNIQUE_IDS as readonly string[]).includes(t);
}

/** An integer `lo`…7 given as a number (a text "4" or a prototype key is not a yarn weight). */
export function isCyc(c: unknown, lo: number = 0): c is Cyc {
  return typeof c === 'number' && Number.isInteger(c) && c >= lo && c <= 7;
}

export function isTapestry(t: TechniqueId): boolean {
  return t === 'sc_tapestry' || t === 'sc_tapestry_round';
}
