// Crochet cleanup of a colorized chart (DESIGN.md §2.5), with the metrics after every stage. Track T1, sprint
// T1.3. Pure, deterministic, no DOM.
//
// Stages along the working path: colors (the input) → confetti → small components → Potts DP → per-row cap
// (tapestry) → rare colors. Every pass skips the protected cells of `colorize` (thin features, salient details,
// hand edits, locked cells). Afterwards palette entries left without cells are dropped and the codes re-assigned
// by population (§2.4.2), and the ΔE00 shown for cluster-mean entries is measured again (§2.4.4).
import type { ChartMetrics, ChartSettings, PaletteEntry } from '../../types/chart';
import { canonicalJson, createFnv1a64 } from '../kernel/hash';
import { ciede2000, hexToFeature, hexToLab, linearRgbToLab } from '../kernel/color';
import { paletteCode, type Colorized } from '../quantize/colorize';
import { APPROXIMATE_DE00 } from '../yarn/match';
import { chartMetrics, fidelityCache, type FidelityCache } from './metrics';
import { type CleanupParams, cleanupParams, workingPath, type WorkingPath } from './params';
import { capLine, confettiPass, type LabelGrid, medianCenterDistance, mergeSmallComponents, pottsLine, type PottsInput, remapRareColors } from './passes';

export type CleanupSettings = Pick<ChartSettings, 'technique' | 'detail' | 'startCorner'>;

export type CleanupStageName = 'colors' | 'confetti' | 'components' | 'potts' | 'rowCap' | 'rare';

/** One stage of the cleanup with the metrics after it (`strandsPerColor` indexes the FINAL palette). */
export interface CleanupStage {
  stage: CleanupStageName;
  /** Cells this stage changed. */
  changed: number;
  metrics: ChartMetrics;
}

/** A cleaned chart: the colorized chart with cleaned labels and palette, its metrics and every stage's. */
export interface Cleaned extends Colorized {
  params: CleanupParams;
  stages: CleanupStage[];
  /** Metrics of the final chart (= the last stage's). */
  metrics: ChartMetrics;
}

/** Cleans a colorized chart (see the file header). The input is not modified. */
export function cleanupChart(c: Colorized, settings: CleanupSettings): Cleaned {
  const { cols, rows } = c;
  const n = cols * rows;
  const params = cleanupParams(settings.technique, settings.detail, n);
  const path: WorkingPath = workingPath(settings.technique, cols, rows, settings.startCorner);
  const labels = new Uint8Array(c.labels);
  const g: LabelGrid = { cols, rows, labels, protect: c.protect, wrap: path.wrap };
  const K = c.palette.length;
  const paletteLab = c.palette.map((p) => hexToLab(p.hex));
  const centers = Float64Array.from(c.palette.flatMap((p) => hexToFeature(p.hex)));
  const cellLab = new Float64Array(n * 3);
  const lin = c.colors.lin;
  for (let i = 0; i < n; i++) cellLab.set(linearRgbToLab(lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2]), i * 3);
  const protectedLabel = (l: number): boolean => c.palette[l]?.protected === true;

  const fid: FidelityCache = fidelityCache(n);
  const measure = (): ChartMetrics => chartMetrics({ cols, rows, labels, palette: c.palette }, { technique: settings.technique, path, cellLab, paletteLab, fidelity: fid });
  const raw: { stage: CleanupStageName; changed: number; metrics: ChartMetrics }[] = [];
  let last = measure();
  raw.push({ stage: 'colors', changed: 0, metrics: last });
  const stage = (name: CleanupStageName, changed: number): void => {
    if (changed > 0) last = measure();
    raw.push({ stage: name, changed, metrics: last });
  };

  // 1. confetti
  let changed = 0;
  for (let pass = 0; pass < params.confettiPasses; pass++) {
    const k = confettiPass(g, cellLab, paletteLab);
    changed += k;
    if (k === 0) break;
  }
  stage('confetti', changed);

  // 2. small components
  stage('components', mergeSmallComponents(g, params.aMin, paletteLab));

  // 3. Potts DP per line
  const used = (): number[] => {
    const seen = new Uint8Array(K);
    for (let i = 0; i < n; i++) seen[labels[i]] = 1;
    return [...seen.keys()].filter((l) => seen[l]);
  };
  const potts: PottsInput = { feat: c.colors.feat, centers, sigma: medianCenterDistance(centers, used()), lambda: params.lambda, rMin: params.rMin };
  changed = 0;
  if (K >= 2 && (params.lambda > 0 || params.rMin > 1)) for (const line of path.lines) changed += pottsLine(g, line, potts, path.circular);
  stage('potts', changed);

  // 4. per-row cap (tapestry)
  if (params.rowCap !== undefined) {
    changed = 0;
    for (const line of path.lines) changed += capLine(g, line, params.rowCap, potts, path.circular, protectedLabel);
    stage('rowCap', changed);
  }

  // 5. rare colors
  stage('rare', remapRareColors(g, params.rareMin, paletteLab, protectedLabel));

  // ---- palette: drop unused entries, codes by population again
  const { palette, map } = repalette(c, labels);
  for (let i = 0; i < n; i++) labels[i] = map[labels[i]];
  const remap = (m: ChartMetrics): ChartMetrics => {
    const strands = new Array<number>(palette.length).fill(0);
    m.strandsPerColor.forEach((s, l) => {
      if (map[l] < palette.length) strands[map[l]] = s;
    });
    return { ...m, strandsPerColor: strands };
  };
  const stages = raw.map((s) => ({ ...s, metrics: remap(s.metrics) }));
  const out: Cleaned = { ...c, labels, palette, params, stages, metrics: stages[stages.length - 1].metrics };
  out.issues = [...c.issues];
  return out;
}

/**
 * The palette after cleanup: entries with cells, in descending population (ties → the earlier entry), codes
 * A, B, … again; ΔE00 measured from the cluster mean again where §2.4.4 shows that (every yarn-mode entry; auto
 * entries of role 'color'), with the "(approximate)" suffix updated. `map[old label]` = new label (255 = gone).
 */
function repalette(c: Colorized, labels: Uint8Array): { palette: PaletteEntry[]; map: Uint8Array } {
  const K = c.palette.length;
  const pop = new Float64Array(K);
  const sumLin = new Float64Array(K * 3);
  const lin = c.colors.lin;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    pop[l]++;
    sumLin[l * 3] += lin[i * 3];
    sumLin[l * 3 + 1] += lin[i * 3 + 1];
    sumLin[l * 3 + 2] += lin[i * 3 + 2];
  }
  const order = [...pop.keys()].filter((l) => pop[l] > 0).sort((a, b) => pop[b] - pop[a] || a - b);
  const map = new Uint8Array(256).fill(255);
  order.forEach((l, r) => (map[l] = r));
  const palette = order.map((l, r) => {
    const e: PaletteEntry = { ...c.palette[l], code: paletteCode(r) };
    if (e.name === `Color ${c.palette[l].code}`) e.name = `Color ${e.code}`;
    const measured = c.mode === 'yarns' ? e.yarn !== undefined : e.role === 'color' && e.yarn !== undefined;
    if (measured) {
      const p = pop[l];
      const meanLab = linearRgbToLab(sumLin[l * 3] / p, sumLin[l * 3 + 1] / p, sumLin[l * 3 + 2] / p);
      const de = ciede2000(meanLab, hexToLab(e.yarn!.hex));
      e.deltaE00 = Math.round(de * 100) / 100;
      if (c.mode === 'auto' && e.name.startsWith(e.yarn!.name)) e.name = e.yarn!.name + (de > APPROXIMATE_DE00 ? ' (approximate)' : '');
    }
    return e;
  });
  return { palette, map };
}

/** Hash of a cleaned chart (§5.8: integer labels, masks and the palette; never raw floats). */
export function cleanupHash(c: Cleaned): string {
  const h = createFnv1a64();
  h.update(canonicalJson({ cols: c.cols, rows: c.rows, palette: c.palette.map((p) => [p.code, p.hex, p.yarn?.id ?? null, p.role ?? null, p.protected ?? false, p.deltaE00 ?? null]) }));
  h.update(c.labels);
  h.update(c.protect);
  h.update(new Int32Array(c.stages.map((s) => s.changed)));
  return h.hex();
}
