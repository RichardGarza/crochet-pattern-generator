// The amigurumi engine is pure (DESIGN.md §0.1 determinism, §5.1): no Math.random, no Date, no DOM; it imports
// only the frozen types, Step 0 kernels and its own modules.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const T41 = ['profiles.ts', 'rounds.ts', 'poles.ts', 'classic.ts', 'oval.ts'];

describe('core/ami purity (T4.1 modules)', () => {
  for (const f of T41) {
    it(f, () => {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code.match(/Math\.random|\bDate\b|performance\.now|\bdocument\b|\bwindow\b|\bglobalThis\b|\bprocess\b/g) ?? []).toEqual([]);
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        const ok = m[1].startsWith('./') || m[1].startsWith('../gauge/') || m[1].startsWith('../kernel/') || m[1].startsWith('../model/') || m[1].startsWith('../../types/');
        expect(ok, `${f} imports ${m[1]}`).toBe(true);
      }
    });
  }
});
