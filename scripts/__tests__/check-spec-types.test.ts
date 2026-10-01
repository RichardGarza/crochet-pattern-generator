import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/types is frozen at Step 0 (DESIGN.md §5.2, §6.1 rule 7). This test fails when a type there stops being
// identical to the text of the spec — for example when a track edits src/types, or when an S0 amendment changes
// the spec and the types in different ways. scripts/check-spec-types.mjs explains what it compares.
describe('src/types against docs/DESIGN.md', () => {
  it(
    'every declaration of §3.5.1, §3.7.1, §5.2 and §5.2.1 is identical in src/types',
    () => {
      const script = fileURLToPath(new URL('../check-spec-types.mjs', import.meta.url));
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const count = Number(/check-spec-types: (\d+) declarations/.exec(r.stdout)?.[1]);
      expect(count).toBeGreaterThanOrEqual(134);
    },
    120_000,
  );
});
