// Length display helpers: lengths are inches inside the app; the UI shows in or cm (DESIGN.md §0.1).
import type { UnitPref } from '../../types/units';

export const CM_PER_IN = 2.54;

/** Inches → the number shown in `units`. */
export function toDisplayLength(inches: number, units: UnitPref): number {
  return units === 'cm' ? inches * CM_PER_IN : inches;
}

/** A number typed in `units` → inches. */
export function fromDisplayLength(value: number, units: UnitPref): number {
  return units === 'cm' ? value / CM_PER_IN : value;
}

/** A number with at most `precision` decimals and no trailing zeros: 12.50 → "12.5", 3.0 → "3". */
export function formatNumber(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(precision);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

/** "12.5 in" / "31.8 cm". */
export function formatLength(inches: number, units: UnitPref, precision = units === 'cm' ? 1 : 2): string {
  return `${formatNumber(toDisplayLength(inches, units), precision)} ${units}`;
}

/**
 * What the user typed → a number, or null when it is not one. Accepts a decimal comma ("12,5"), surrounding
 * spaces and a leading "+"; rejects everything else ("12in", "1e3" is accepted as JavaScript reads it).
 */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
