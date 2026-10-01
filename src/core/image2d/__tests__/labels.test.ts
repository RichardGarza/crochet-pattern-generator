import { describe, expect, it } from 'vitest';
import { NO_LABEL, despeckleLabels, labelComponents, poolLabels } from '../labels';
import { uniformSpans } from '../linear';

/** A label image from text rows ('.' = NO_LABEL, digits = labels). */
function labelsOf(rows: string[]): { labels: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const labels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = rows[y][x] === '.' ? NO_LABEL : Number(rows[y][x]);
  return { labels, w, h };
}

function rowsOf(labels: Uint8Array, w: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < labels.length; i += w) out.push([...labels.subarray(i, i + w)].map((l) => (l === NO_LABEL ? '.' : String(l))).join(''));
  return out;
}

/** Label image of a w × h picture: label 0 background, label 1 on a 2-px-wide circle outline of radius r. */
function outline(w: number, h: number, r: number, width = 2): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      out[y * w + x] = d <= r && d > r - width ? 1 : 0;
    }
  }
  return out;
}

/** Share of the cells of `label` in the largest 8-connected group of them. */
function connectedShare(cells: Uint8Array, cols: number, rows: number, label: number): number {
  const mask = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) mask[i] = cells[i] === label ? 1 : 2;
  const { comp, size, label: lab } = labelComponents(mask, cols, rows);
  void comp;
  let total = 0;
  let best = 0;
  for (let c = 0; c < size.length; c++) {
    if (lab[c] !== 1) continue;
    total += size[c];
    best = Math.max(best, size[c]);
  }
  return total === 0 ? 0 : best / total;
}

describe('despeckleLabels (the "3×3 median on labels")', () => {
  it('replaces isolated speckle with the window majority', () => {
    const { labels, w, h } = labelsOf(['00000', '00100', '00000', '22222', '22122']);
    expect(rowsOf(despeckleLabels(labels, w, h), w)).toEqual(['00000', '00000', '00000', '22222', '22222']);
  });

  it('keeps 1-px lines (horizontal, vertical, diagonal) apart from their loose ends', () => {
    const { labels, w, h } = labelsOf(['0000000', '1111111', '0000000', '0000000']);
    expect(rowsOf(despeckleLabels(labels, w, h), w)).toEqual(['0000000', '0111110', '0000000', '0000000']);
    const diag = labelsOf(['100000', '010000', '001000', '000100', '000010', '000001']);
    expect(rowsOf(despeckleLabels(diag.labels, diag.w, diag.h), diag.w)).toEqual(['000000', '010000', '001000', '000100', '000010', '000000']);
  });

  it('never changes or counts NO_LABEL pixels', () => {
    const { labels, w, h } = labelsOf(['...', '.1.', '...']);
    expect(rowsOf(despeckleLabels(labels, w, h), w)).toEqual(['...', '.1.', '...']);
  });

  it('breaks ties toward the lowest label', () => {
    const { labels, w, h } = labelsOf(['333', '393', '222']);
    // 9 occurs once; 3 occurs 5 times → 3.
    expect(despeckleLabels(labels, w, h)[4]).toBe(3);
    const t = labelsOf(['44', '15', '..']);
    // 2×3 window around (0,1): 4, 4, 1, 5 — 1 is speckle; 4 wins.
    expect(despeckleLabels(t.labels, t.w, t.h)[2]).toBe(4);
  });
});

describe('poolLabels — area-weighted mode', () => {
  it('takes the label with the largest area per cell; ties → lowest label', () => {
    const { labels, w, h } = labelsOf(['0011', '0011', '2222', '2233']);
    const p = poolLabels(labels, w, h, uniformSpans(2, 4), uniformSpans(2, 4), { thin: false });
    expect(rowsOf(p.labels, 2)).toEqual(['01', '22']);
    const tie = labelsOf(['12', '21']);
    expect(poolLabels(tie.labels, 2, 2, uniformSpans(1, 2), uniformSpans(1, 2)).labels[0]).toBe(1);
  });

  it('weights fractional pixel overlaps', () => {
    // 3 px → 2 cells of 1.5 px: cell 0 = pixel 0 + half of pixel 1.
    const { labels, w, h } = labelsOf(['011']);
    const p = poolLabels(labels, w, h, uniformSpans(2, 3), uniformSpans(1, 1), { thin: false });
    expect([...p.labels]).toEqual([0, 1]);
    // 4 px → 3 cells of 4/3 px: the middle cell is 2/3 of pixel 1 and 2/3 of pixel 2.
    const q = labelsOf(['0110']);
    expect([...poolLabels(q.labels, 4, 1, uniformSpans(3, 4), uniformSpans(1, 1), { thin: false }).labels]).toEqual([0, 1, 0]);
  });

  it('ignores NO_LABEL pixels; a cell with none is NO_LABEL', () => {
    const { labels, w, h } = labelsOf(['..1.', '....']);
    expect([...poolLabels(labels, w, h, uniformSpans(2, 4), uniformSpans(1, 2)).labels]).toEqual([NO_LABEL, 1]);
  });
});

describe('poolLabels — thin-feature protection (§2.3.4)', () => {
  it('a 2-px outline in 10-px cells survives and stays connected (a plain mode loses it)', () => {
    const w = 400;
    const labels = outline(w, w, 150, 2);
    const plain = poolLabels(labels, w, w, uniformSpans(40, w), uniformSpans(40, w), { thin: false });
    const kept = poolLabels(labels, w, w, uniformSpans(40, w), uniformSpans(40, w));
    expect(plain.labels.filter((l) => l === 1).length).toBe(0);
    const ring = kept.labels.filter((l) => l === 1).length;
    // Circumference 2π·15 cells ≈ 94; every cell the outline crosses with ≥ 15% coverage is kept.
    expect(ring).toBeGreaterThan(80);
    expect(connectedShare(kept.labels, 40, 40, 1)).toBeGreaterThanOrEqual(0.95);
    // Thin cells are exactly the outline's cells.
    for (let i = 0; i < kept.labels.length; i++) expect(kept.thin[i]).toBe(kept.labels[i] === 1 ? 1 : 0);
  });

  it('keeps 1-px and 2-px outlines connected at every cell size (≥ 95%)', () => {
    const n = 600;
    for (const width of [1, 2]) {
      const labels = outline(n, n, 250, width);
      for (const [cols, rows] of [[60, 60], [50, 59], [40, 40], [34, 40], [30, 48], [20, 20]]) {
        const p = poolLabels(labels, n, n, uniformSpans(cols, n), uniformSpans(rows, n));
        const cells = p.labels.filter((l) => l === 1).length;
        expect(cells, `${width} px, ${cols} × ${rows}`).toBeGreaterThan(2 * Math.PI * 250 * (cols / n) * 0.8);
        expect(connectedShare(p.labels, cols, rows, 1), `${width} px, ${cols} × ${rows}`).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it('textures (a 1-px checker, label noise) are not thin features', () => {
    const n = 400;
    const chk = new Uint8Array(n * n);
    for (let i = 0; i < chk.length; i++) chk[i] = ((i % n) + Math.floor(i / n)) % 2;
    expect(poolLabels(chk, n, n, uniformSpans(40, n), uniformSpans(40, n)).thin.reduce((a, b) => a + b, 0)).toBe(0);
    let seed = 1;
    const noise = chk.map(() => ((seed = (seed * 1103515245 + 12345) % 2147483648) >> 16) & 1);
    // Random 50/50 label noise: a few branched specks may still pass as features, never whole regions.
    expect(poolLabels(noise, n, n, uniformSpans(40, n), uniformSpans(40, n)).thin.reduce((a, b) => a + b, 0)).toBeLessThan(0.05 * 1600);
  });

  it('rejects spans outside the label image', () => {
    const { labels, w, h } = labelsOf(['01', '10']);
    expect(() => poolLabels(labels, w, h, uniformSpans(2, 3), uniformSpans(2, 2))).toThrow(RangeError);
  });

  it('works with non-square cells', () => {
    const w = 300;
    const labels = outline(w, w, 120, 2);
    const p = poolLabels(labels, w, w, uniformSpans(30, w), uniformSpans(24, w));
    expect(connectedShare(p.labels, 30, 24, 1)).toBeGreaterThanOrEqual(0.95);
  });

  it('leaves thick regions to the mode', () => {
    const w = 200;
    const labels = outline(w, w, 80, 30);
    const p = poolLabels(labels, w, w, uniformSpans(20, w), uniformSpans(20, w));
    expect([...p.thin].every((t) => t === 0)).toBe(true);
  });

  it('ignores a thin dot that spans one cell (its skeleton must span ≥ 2 cells)', () => {
    const { labels, w, h } = labelsOf(['0000000000', '0000000000', '0000000000', '0000110000', '0000110000', '0000000000', '0000000000', '0000000000', '0000000000', '0000000000']);
    const p = poolLabels(labels, w, h, uniformSpans(1, w), uniformSpans(1, h));
    expect([...p.labels]).toEqual([0]);
  });

  it('bridges a diagonal-only link with one cell', () => {
    // A 1-px diagonal line in 4-px cells: its cells touch only at corners until bridged.
    const n = 24;
    const labels = new Uint8Array(n * n);
    for (let k = 0; k < n; k++) labels[k * n + k] = 1;
    const p = poolLabels(labels, n, n, uniformSpans(6, n), uniformSpans(6, n));
    expect(connectedShare(p.labels, 6, 6, 1)).toBe(1);
    // 4-connected: every diagonal step has a bridge.
    for (let i = 0; i < 5; i++) {
      const a = p.labels[i * 6 + i] === 1;
      const b = p.labels[(i + 1) * 6 + i + 1] === 1;
      if (a && b) expect(p.labels[i * 6 + i + 1] === 1 || p.labels[(i + 1) * 6 + i] === 1).toBe(true);
    }
  });

  it('is deterministic', () => {
    const labels = outline(240, 240, 90, 2);
    const a = poolLabels(labels, 240, 240, uniformSpans(23, 240), uniformSpans(19, 240));
    const b = poolLabels(labels, 240, 240, uniformSpans(23, 240), uniformSpans(19, 240));
    expect([...a.labels]).toEqual([...b.labels]);
    expect([...a.thin]).toEqual([...b.thin]);
  });
});
