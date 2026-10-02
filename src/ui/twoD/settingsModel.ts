// Track T2.3 — the chart settings as data (DESIGN.md §1.3 F1 step 3, §2.2.5, §2.3.3): defaults of a new chart,
// the gauge rules of the settings sidebar, and the chart size the settings ask for, computed at once (before the
// worker answers) with the Step 0 gauge kernel. Pure; unit-tested in node.
import { DEFAULT_REFERENCE_LINE_ID } from '../../core/yarn/lines';
import { borderRounds, defaultHookMm, grid, gridIssues, hookUsLabel, HOOK_SIZES_MM, resolveGaugeChecked, TABLE_A, type GridSize } from '../../core/gauge';
import type { ChartSettings, CropRect, Cyc, GaugeSpec, Hand, Issue, ProjectDoc, ResolvedGauge, Technique2D } from '../../types';

export interface TechniqueInfo {
  id: Technique2D;
  label: string;
  /** One line for the picker's hint. */
  description: string;
  /** Behind `features.mosaic` (P1). */
  flag?: 'mosaic';
}

/** The 2D techniques in the order the picker lists them (§2.7.1). */
export const TECHNIQUES: readonly TechniqueInfo[] = [
  { id: 'sc_graphgan', label: 'Single crochet graphgan', description: 'Rows of sc, a bobbin for each color area. Stitches a little wider than tall.' },
  { id: 'sc_tapestry', label: 'Tapestry crochet (flat)', description: 'Rows of sc with the other colors carried inside. Dense fabric, taller stitches.' },
  { id: 'sc_tapestry_round', label: 'Tapestry in the round', description: 'Joined rounds of sc for bags, hats and cozies. Width = circumference.' },
  { id: 'c2c', label: 'Corner to corner (C2C)', description: 'Square tiles worked on the diagonal. Quick, blocky, great for blankets.' },
  { id: 'hdc_graphgan', label: 'Half double crochet graphgan', description: 'Rows of hdc: faster than sc, stitches taller than wide.' },
  { id: 'mosaic_overlay', label: 'Overlay mosaic', description: 'Two colors per row with long stitches dropped onto the row below.', flag: 'mosaic' },
];

export function techniqueInfo(id: Technique2D): TechniqueInfo {
  return TECHNIQUES.find((t) => t.id === id) ?? TECHNIQUES[0];
}

/** Flat techniques take a border (§2.7.10); tapestry in the round does not. */
export function takesBorder(t: Technique2D): boolean {
  return t !== 'sc_tapestry_round';
}

/** CYC weights for the picker: "4 · Medium (worsted)". */
export const WEIGHTS: readonly { cyc: Cyc; label: string }[] = ([0, 1, 2, 3, 4, 5, 6, 7] as const).map((cyc) => ({ cyc, label: `${cyc} · ${TABLE_A[cyc].name}` }));

/** Hook choices: "5 mm (H-8)". */
export function hookLabel(mm: number): string {
  const us = hookUsLabel(mm);
  const n = Number.isInteger(mm) ? String(mm) : String(Math.round(mm * 100) / 100);
  return us ? `${n} mm (${us})` : `${n} mm`;
}

export const HOOKS: readonly number[] = HOOK_SIZES_MM;

/** The default C2C start corner of a hand (§2.7.6): bottom right for right-handers, bottom left for left. */
export function defaultCornerFor(hand: Hand): ChartSettings['startCorner'] {
  return hand === 'left' ? 'BL' : 'BR';
}

/** The settings of a new chart (F1 step 3; §2.4.4: RHSS names the colors and is the default yarn line). */
export function defaultChartSettings(doc: Pick<ProjectDoc, 'hand' | 'gauge'>): ChartSettings {
  const technique = TECHNIQUES.some((t) => t.id === doc.gauge?.technique) ? (doc.gauge.technique as Technique2D) : 'sc_graphgan';
  const hand: Hand = doc.hand === 'left' ? 'left' : 'right';
  return {
    technique,
    hand,
    startCorner: defaultCornerFor(hand),
    lockAspect: true,
    border: { widthIn: 0 },
    maxColors: 'auto',
    paletteMode: 'auto',
    lineIds: [DEFAULT_REFERENCE_LINE_ID],
    referenceLineId: DEFAULT_REFERENCE_LINE_ID,
    detail: 'balanced',
    dither: 'off',
    imageKind: 'auto',
    background: 'keep',
    applyRepeats: 'auto',
    roundLean: { mode: 'note', stPerRnd: 0.5 },
  };
}

/**
 * The gauge after a technique change (§2.2.5): the measurement belongs to the technique it was taken in, so it
 * is cleared when the technique changes (the swatch of a graphgan does not size a tapestry); the hook stays.
 */
export function gaugeWithTechnique(g: GaugeSpec, technique: Technique2D): GaugeSpec {
  if (g.technique === technique) return g;
  const { swatch: _s, c2cSwatch: _c, testBall: _t, ...rest } = g;
  return { ...rest, technique };
}

/**
 * The gauge after a yarn weight change (§2.2.5, §4.5): each weight scales from its own reference hook, so the
 * hook and every measurement are cleared, and so is a calibrated yarn per stitch (another yarn).
 */
export function gaugeWithWeight(g: GaugeSpec, cyc: Cyc): GaugeSpec {
  if (g.cyc === cyc) return g;
  return { cyc, technique: g.technique, ...(g.carried !== undefined ? { carried: g.carried } : {}), ...(g.yarnUnder !== undefined ? { yarnUnder: g.yarnUnder } : {}) };
}

/** The gauge spec the chart uses: the project's, with the chart's technique. */
export function chartGaugeSpec(doc: Pick<ProjectDoc, 'gauge'>, technique: Technique2D): GaugeSpec {
  return doc.gauge.technique === technique ? doc.gauge : gaugeWithTechnique(doc.gauge, technique);
}

/** The default hook of the project's weight. */
export function defaultHook(g: GaugeSpec): number {
  return defaultHookMm(g.cyc, g.technique === 'amigurumi_sc' ? 'sc_graphgan' : g.technique);
}

/** Width × height of the picture after the crop and the rotation (what the chart covers), in source pixels. */
export function croppedSize(src: { w: number; h: number }, crop?: CropRect): { w: number; h: number } {
  let w = src.w;
  let h = src.h;
  if (crop) {
    const x0 = Math.max(0, Math.min(src.w, Math.round(Math.min(crop.x, crop.x + crop.w))));
    const x1 = Math.max(0, Math.min(src.w, Math.round(Math.max(crop.x, crop.x + crop.w))));
    const y0 = Math.max(0, Math.min(src.h, Math.round(Math.min(crop.y, crop.y + crop.h))));
    const y1 = Math.max(0, Math.min(src.h, Math.round(Math.max(crop.y, crop.y + crop.h))));
    if (x1 > x0 && y1 > y0) {
      w = x1 - x0;
      h = y1 - y0;
    }
  }
  const turned = crop?.rotate === 90 || crop?.rotate === 270;
  return turned ? { w: h, h: w } : { w, h };
}

/** Default width when neither size is given (§2.3.4 "Default size"): 60 stitches (+ border). */
export const DEFAULT_COLS = 60;

export interface ChartPlan {
  gauge: ResolvedGauge;
  size: GridSize;
  /** Size issues (W_GRID_*) and gauge findings (W_GAUGE_*). */
  issues: Issue[];
  /** True when neither size was given and the chart is the default 60 stitches wide. */
  defaultSize: boolean;
}

/**
 * The chart size the settings ask for (§2.3.3), or the gauge errors that stop it. Pixel art has its own size
 * (one cell per native pixel, found by the worker): the plan is then the worker's to say.
 */
export function planChart(doc: Pick<ProjectDoc, 'gauge'>, settings: ChartSettings, picture: { w: number; h: number }): { plan: ChartPlan } | { errors: Issue[] } {
  const spec = chartGaugeSpec(doc, settings.technique);
  const { gauge, issues } = resolveGaugeChecked(spec);
  if (!gauge) return { errors: issues.filter((i) => i.severity === 'error') };
  const roundH = gauge.hSc;
  const border = takesBorder(settings.technique) && settings.border.widthIn > 0 ? { widthIn: settings.border.widthIn, roundH } : undefined;
  const nB = border ? borderRounds(border.widthIn, roundH) : 0;
  let wIn = settings.widthIn !== undefined && settings.widthIn > 0 ? settings.widthIn : undefined;
  let hIn = settings.heightIn !== undefined && settings.heightIn > 0 ? settings.heightIn : undefined;
  if (settings.lockAspect && wIn !== undefined && hIn !== undefined) hIn = undefined;
  const defaultSize = wIn === undefined && hIn === undefined;
  if (defaultSize) wIn = DEFAULT_COLS * gauge.cell.w + 2 * nB * roundH;
  const req = { wIn, hIn, imgW: Math.max(1, picture.w), imgH: Math.max(1, picture.h), ...(border ? { border } : {}) };
  try {
    const size = grid(gauge.cell, req);
    return { plan: { gauge, size, issues: [...issues, ...gridIssues(gauge.cell, req)], defaultSize } };
  } catch (e) {
    return { errors: [{ code: 'E_SIZE', severity: 'error', message: e instanceof Error ? e.message : String(e) }] };
  }
}

/** The panel's aspect (width / height, border excluded) when both sizes are fixed (the crop can lock to it). */
export function finishedAspect(settings: ChartSettings, gauge: ResolvedGauge | undefined): number | null {
  if (settings.lockAspect || !gauge) return null;
  const w = settings.widthIn;
  const h = settings.heightIn;
  if (!(w !== undefined && w > 0 && h !== undefined && h > 0)) return null;
  const nB = takesBorder(settings.technique) && settings.border.widthIn > 0 ? borderRounds(settings.border.widthIn, gauge.hSc) : 0;
  const B = nB * gauge.hSc;
  const pw = w - 2 * B;
  const ph = h - 2 * B;
  return pw > 0 && ph > 0 ? pw / ph : null;
}

/** "135 × 200 stitches", "17 × 25 tiles", "120 sts × 40 rounds". */
export function countsText(technique: Technique2D, cols: number, rows: number): string {
  if (technique === 'c2c') return `${cols} × ${rows} tiles`;
  if (technique === 'sc_tapestry_round') return `${cols} sts × ${rows} rounds`;
  return `${cols} sts × ${rows} rows`;
}

/** §2.4.3: the technique's default and largest color count. */
export function colorBudget(technique: Technique2D): { defaultK: number; maxK: number } {
  return technique === 'sc_tapestry' || technique === 'sc_tapestry_round' ? { defaultK: 5, maxK: 8 } : { defaultK: 8, maxK: 16 };
}

/** The C2C start corners as the picker names them. */
export const CORNERS: readonly { value: ChartSettings['startCorner']; label: string }[] = [
  { value: 'BR', label: 'Bottom right' },
  { value: 'BL', label: 'Bottom left' },
  { value: 'TR', label: 'Top right' },
  { value: 'TL', label: 'Top left' },
];
