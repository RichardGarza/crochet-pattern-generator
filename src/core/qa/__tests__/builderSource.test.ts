// Integration S1 task T7.4: `builderSource` embeds the v1.4 §3.4.1 builder (null-prototype `pal`/`mats`; a polygon
// without points draws as a rectangle), byte for byte.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILDER_V1_SOURCE } from '../builderSource';

describe('builderSource (§3.4.1)', () => {
  it('is the DESIGN.md §3.4.1 block byte for byte', () => {
    const design = readFileSync(new URL('../../../../docs/DESIGN.md', import.meta.url), 'utf8');
    const at = design.indexOf('#### 3.4.1');
    const start = design.indexOf('```js\n', at) + 6;
    const end = design.indexOf('\n```', start);
    expect(BUILDER_V1_SOURCE).toBe(design.slice(start, end));
  });

  it('has the v1.4 fixes: null-prototype pal and mats; a polygon needs 3 points, else the rectangle', () => {
    expect(BUILDER_V1_SOURCE).toContain('pal = Object.assign(Object.create(null)');
    expect(BUILDER_V1_SOURCE).toContain('mats = Object.create(null)');
    expect(BUILDER_V1_SOURCE).toContain("d.shape === 'polygon' && d.points?.length >= 3");
    expect(BUILDER_V1_SOURCE).toMatch(/export function buildModel\(spec, unitScale = 0\.0254\)/);
  });
});
