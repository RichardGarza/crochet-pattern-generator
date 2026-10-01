// Test helper: ops from the compact notation the spec writes (`(sc, inc, sc) × 5, sc, inc, sl st`, `3 inc`,
// `BLO` not supported) — for comparing the generator's ops with ops DESIGN.md states.
import type { Op } from '../../../../types/pattern';

function token(t: string): Op[] {
  const m = t.trim().match(/^(?:(\d+) )?(sc|inc3|inc|dec3|dec|sl st)$/);
  if (!m) throw new Error(`parseOps: unknown token "${t}"`);
  const n = m[1] ? Number(m[1]) : 1;
  const op: Op =
    m[2] === 'sc' ? { k: 'st', st: 'sc' } : m[2] === 'sl st' ? { k: 'st', st: 'slst' } : { k: m[2].startsWith('inc') ? 'inc' : 'dec', n: m[2].endsWith('3') ? 3 : 2 };
  return Array.from({ length: n }, () => ({ ...op }));
}

export function parseOps(text: string): Op[] {
  const out: Op[] = [];
  const re = /\(([^)]*)\)\s*[x×]\s*(\d+)|([^,()]+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      const inner = m[1].split(',').flatMap(token);
      for (let i = 0; i < Number(m[2]); i++) out.push(...inner.map((o) => ({ ...o })));
    } else if (m[3].trim()) out.push(...token(m[3]));
  }
  return out;
}
