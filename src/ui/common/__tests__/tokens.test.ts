// The theme tokens meet WCAG 2.2 AA in both themes (DESIGN.md §5.7 accessibility): 4.5:1 for text, 3:1 for
// the borders of form controls, focus rings and status icons. Reads tokens.css itself, so a token edit that
// breaks a pair fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');

/** The custom properties declared in the first block that starts at `selector`. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no block ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = block(':root {');
const darkMedia = block(":root:not([data-theme='light'])");
const darkPicked = block(":root[data-theme='dark']");
const dark = { ...light, ...darkPicked };

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT_PAIRS: [fg: string, bg: string][] = [
  ...['bg', 'surface', 'surface-raised', 'surface-sunken', 'surface-hover'].flatMap((bg): [string, string][] => [
    ['text', bg],
    ['text-muted', bg],
  ]),
  ['text-subtle', 'surface'],
  ['text-subtle', 'bg'],
  ['accent-text', 'surface'],
  ['accent-text', 'bg'],
  ['accent-text', 'accent-soft'],
  ['on-accent', 'accent'],
  ['on-accent', 'accent-hover'],
  ['on-accent', 'accent-active'],
  ['on-accent', 'danger'],
  ['on-accent', 'danger-hover'],
  ['text-inverse', 'text'],
  ...['success', 'warn', 'danger', 'info'].flatMap((tone): [string, string][] => [
    [`${tone}-text`, `${tone}-soft`],
    [`${tone}-text`, 'surface'],
    [`${tone}-text`, 'bg'],
  ]),
];

const UI_PAIRS: [fg: string, bg: string][] = [
  ['border-control', 'surface'],
  ['border-control', 'bg'],
  ['focus', 'surface'],
  ['focus', 'bg'],
  ['accent', 'surface'],
  ['accent', 'bg'],
  ...['success', 'warn', 'danger', 'info'].flatMap((tone): [string, string][] => [
    [tone, 'surface'],
    [tone, `${tone}-soft`],
  ]),
];

describe('theme tokens (WCAG AA)', () => {
  it('the two dark blocks are identical (system dark and picked dark)', () => {
    expect(darkMedia).toEqual(darkPicked);
  });

  it('dark redefines every light color', () => {
    const colors = Object.keys(light).filter((k) => k.startsWith('--color-'));
    expect(colors.filter((k) => !(k in darkPicked))).toEqual([]);
  });

  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    const color = (token: string): string => {
      const value = theme[`--color-${token}`];
      if (!value) throw new Error(`missing --color-${token}`);
      return value;
    };

    it(`${name}: text pairs reach 4.5:1`, () => {
      const failing = TEXT_PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(color(fg), color(bg)) })).filter((p) => p.ratio < 4.5);
      expect(failing).toEqual([]);
    });

    it(`${name}: control borders, focus rings and status colors reach 3:1`, () => {
      const failing = UI_PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(color(fg), color(bg)) })).filter((p) => p.ratio < 3);
      expect(failing).toEqual([]);
    });
  }
});
