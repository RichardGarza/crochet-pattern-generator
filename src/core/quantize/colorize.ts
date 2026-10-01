// Colors of a sampled chart (DESIGN.md §2.4, §5.5.5): palette source → background yarn → quantizer or p-median →
// merges → hand-edit colors as protected centers → anti-aliasing centers (flat art) → salience guard → the
// color budget → cell labels and the palette. Track T1, sprint T1.2. Pure, deterministic, no DOM.
//
// Modes (§2.4.4):
//   - auto: free centers (§2.4.2–2.4.3), each named by its nearest shade (ΔE00) in the reference line,
//     "(approximate)" when that is more than ΔE00 10 away;
//   - line / stash / custom: p-median over the candidate yarns (§2.4.4); the palette entries ARE yarns.
// The background is a label outside the K budget, worked in one yarn (§2.3.2).
// Hand edits (§5.5.5) are kept by color identity: every distinct override color is re-inserted as a protected
// center that counts against the budget; overridden cells take it whatever the picture says.
import type { ChartEdits, ChartGrid, ChartSettings, ColorRef, PaletteEntry } from '../../types/chart';
import type { Issue } from '../../types/issues';
import type { Yarn, YarnLine } from '../../types/yarn';
import { ciede2000, featureToHex, featureToOklab, hexToFeature, hexToLab, hexToLinearRgb, isHex, linearRgbToLab, linearRgbToOklab, oklabToFeature, oklabToLinearRgb, type Color3 } from '../kernel/color';
import { canonicalJson, createFnv1a64 } from '../kernel/hash';
import { compositeCells } from '../image2d/background';
import { NO_LABEL, despeckleLabels, poolLabels } from '../image2d/labels';
import type { CellColors, SampledImage } from '../image2d/types';
import { parseYarnCsv } from '../yarn/csv';
import { DEFAULT_REFERENCE_LINE_ID, findLine, getShippedLine } from '../yarn/lines';
import { APPROXIMATE_DE00, nearestYarnIn, nearestYarnToLab } from '../yarn/match';
import { CURVE_BIN, CURVE_MAX_POINTS, chooseK, coarsePoints, colorBudget } from './autoK';
import { isMixOf, removeBlendCenters } from './blend';
import { featureToLab } from './colors';
import { cellPoints, pixelHistogram, type PixelHistogram, type WeightedPoints } from './points';
import { pMedian } from './pmedian';
import { nearestCenter, quantize, type Quantized } from './quantize';
import { MERGE_DE00, mergeCenters, salientGroups } from './salience';

/** Hand-edit colors closer than this to a center map to that center (§5.5.5). */
export const OVERRIDE_SAME_DE00 = 2;
/** At most this many distinct hand-edit colors (labels are bytes, 255 = none). */
export const OVERRIDE_MAX_COLORS = 200;
/** A salient group may cover at most this share of the subject (eyes and dots, not regions)… */
export const SALIENT_MAX_SHARE = 0.003;
/** …but always at least this many cells. */
export const SALIENT_MAX_CELLS_MIN = 8;

export type ColorSettings = Pick<
  ChartSettings,
  'technique' | 'maxColors' | 'paletteMode' | 'lineIds' | 'customCsv' | 'referenceLineId' | 'backgroundColor'
>;

export interface ColorizeRequest {
  settings: ColorSettings;
  /** Yarn lines sent with the request (`ChartRequest.lines`); shipped lines fill in unknown ids. */
  lines?: readonly YarnLine[];
  stash?: readonly Yarn[];
  edits?: ChartEdits;
}

export interface Colorized {
  cols: number;
  rows: number;
  /** Palette index of every cell (row-major, row 0 = top). */
  labels: Uint8Array<ArrayBuffer>;
  palette: PaletteEntry[];
  /** 1 = protected from cleanup (§2.5): thin features, salient details, hand edits, locked cells. */
  protect: Uint8Array<ArrayBuffer>;
  /** Cells of salient groups (§2.4.3). */
  salient: Uint8Array<ArrayBuffer>;
  /** Flat art: cells given to thin features (§2.3.4). */
  thin?: Uint8Array<ArrayBuffer>;
  /** Cell colors composited over the background yarn (the sampled colors when it did not change). */
  colors: CellColors;
  mode: 'auto' | 'yarns';
  /** Auto-K: the curve D(K), K = 2…, and the knee. */
  autoK?: { k: number; curve: number[] };
  /** Overrides as applied (remapped to this size when the edits were made at another one). */
  overrides: { cell: number; color: ColorRef }[];
  issues: Issue[];
}

interface Center {
  f: Color3;
  /** The exact color to work (a yarn's or a hand edit's); undefined = the center's own color. */
  hex?: string;
  yarn?: Yarn;
  /** Yarn modes: index in the candidate list. */
  candidate?: number;
  protected: boolean;
  role: 'color' | 'override';
  salient: boolean;
}

const identity = (c: ColorRef): string => `${c.hex.toLowerCase()}|${c.yarnId ?? ''}`;

/** Spreadsheet-style codes: A…Z, AA, AB, … (never "MC"). */
export function paletteCode(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Hand edits made at another chart size, moved by relative position (cell centers; §5.5.5). Later edits of
 * the same target cell win.
 */
export function remapEdits(edits: ChartEdits, cols: number, rows: number): ChartEdits {
  if (edits.baseCols === cols && edits.baseRows === rows) return edits;
  const map = (cell: number): number => {
    const c = cell % edits.baseCols;
    const r = Math.floor(cell / edits.baseCols);
    const nc = Math.min(cols - 1, Math.floor(((c + 0.5) * cols) / edits.baseCols));
    const nr = Math.min(rows - 1, Math.floor(((r + 0.5) * rows) / edits.baseRows));
    return nr * cols + nc;
  };
  const valid = (cell: number): boolean => Number.isInteger(cell) && cell >= 0 && cell < edits.baseCols * edits.baseRows;
  const byCell = new Map<number, ColorRef>();
  for (const o of edits.overrides ?? []) if (valid(o.cell)) byCell.set(map(o.cell), o.color);
  return {
    baseCols: cols,
    baseRows: rows,
    overrides: [...byCell.entries()].sort((a, b) => a[0] - b[0]).map(([cell, color]) => ({ cell, color })),
    locked: [...new Set((edits.locked ?? []).filter(valid).map(map))].sort((a, b) => a - b),
  };
}

/** The candidate yarns of a palette mode, or undefined for 'auto' (or when the mode has none, with a warning). */
export function paletteCandidates(settings: ColorSettings, lines: readonly YarnLine[] = [], stash: readonly Yarn[] = []): { yarns?: Yarn[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const mode = settings.paletteMode;
  if (mode === 'auto') return { issues };
  let yarns: Yarn[] = [];
  let what = '';
  if (mode === 'line') {
    what = 'the chosen yarn lines';
    const unknown: string[] = [];
    for (const id of new Set(settings.lineIds ?? [])) {
      const line = findLine(id, lines);
      if (line === undefined) unknown.push(id);
      else yarns.push(...line.yarns);
    }
    if (unknown.length > 0) {
      issues.push({
        code: 'W_YARN_LINE_UNKNOWN',
        severity: 'warn',
        message: `Yarn line${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not available in this version, so ${unknown.length > 1 ? 'they were' : 'it was'} left out.`,
      });
    }
  } else if (mode === 'stash') {
    what = 'your stash';
    yarns = [...stash];
  } else if (mode === 'custom') {
    what = 'the custom palette';
    const parsed = parseYarnCsv(settings.customCsv ?? '');
    yarns = parsed.yarns;
    issues.push(...parsed.issues);
  } else {
    throw new RangeError(`colorize: unknown paletteMode ${String(mode)}`);
  }
  const seen = new Set<string>();
  yarns = yarns.filter((y) => isHex(y.hex) && !seen.has(y.id) && (seen.add(y.id), true)).map((y) => ({ ...y, hex: y.hex.toLowerCase() }));
  if (yarns.length === 0) {
    issues.push({
      code: 'W_PALETTE_EMPTY',
      severity: 'warn',
      message: `There are no yarns in ${what}, so the colors were chosen freely (named after the reference line).`,
    });
    return { issues };
  }
  return { yarns, issues };
}

/** The reference line's shades (naming in auto mode; the white of a transparent background). */
export function referenceYarns(settings: Pick<ChartSettings, 'referenceLineId'>, lines: readonly YarnLine[] = []): Yarn[] {
  const line = findLine(settings.referenceLineId, lines) ?? getShippedLine(DEFAULT_REFERENCE_LINE_ID);
  return line?.yarns.filter((y) => isHex(y.hex)) ?? [];
}

const notTextured = (y: Yarn): boolean => y.textured === true;

/** Colors a sampled chart (see the file header). */
export function colorize(s: SampledImage, req: ColorizeRequest): Colorized {
  const { settings } = req;
  const issues: Issue[] = [];
  const cols = s.cols;
  const rows = s.rows;
  const n = cols * rows;
  const { cap, auto } = colorBudget(settings.technique, settings.maxColors);
  const source = paletteCandidates(settings, req.lines, req.stash);
  issues.push(...source.issues);
  const cand = source.yarns;
  const mode: 'auto' | 'yarns' = cand === undefined ? 'auto' : 'yarns';
  const reference = referenceYarns(settings, req.lines);
  const candFeat = cand === undefined ? new Float64Array(0) : Float64Array.from(cand.flatMap((y) => hexToFeature(y.hex)));
  const candIndex = new Map((cand ?? []).map((y, j) => [y.id, j]));

  // ---- background yarn (§2.3.2)
  let bgCells = 0;
  for (let i = 0; i < n; i++) bgCells += s.background[i];
  let bg: { hex: string; yarn?: Yarn; from: string } | undefined;
  if (bgCells > 0) {
    const chosen = settings.backgroundColor;
    const target = chosen !== undefined && isHex(chosen.hex) ? chosen.hex.toLowerCase() : s.bg.source === 'alpha' ? '#ffffff' : s.bg.hex;
    if (mode === 'yarns') {
      const own = chosen?.yarnId !== undefined ? candIndex.get(chosen.yarnId) : undefined;
      const y = own !== undefined ? cand![own] : nearestYarnIn(target, cand!)!.yarn;
      bg = { hex: y.hex, yarn: y, from: target };
    } else if (chosen !== undefined && isHex(chosen.hex)) {
      bg = { hex: chosen.hex.toLowerCase(), from: target };
    } else if (s.bg.source === 'alpha') {
      // A transparent background is worked in the reference line's white.
      const w = nearestYarnIn('#ffffff', reference);
      bg = w !== null ? { hex: w.yarn.hex, yarn: w.yarn, from: target } : { hex: '#ffffff', from: target };
    } else {
      bg = { hex: s.bg.hex.toLowerCase(), from: target };
    }
  }
  const colors = bg !== undefined && bg.hex !== s.bg.hex.toLowerCase() ? compositeCells(s.cells, s.background, bg.hex) : s.colors;
  const cellLab = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) cellLab.set(linearRgbToLab(colors.lin[i * 3], colors.lin[i * 3 + 1], colors.lin[i * 3 + 2]), i * 3);

  // ---- hand edits (§5.5.5)
  let edits = req.edits;
  if (edits !== undefined && (edits.baseCols !== cols || edits.baseRows !== rows)) {
    if (edits.baseCols >= 1 && edits.baseRows >= 1 && Number.isInteger(edits.baseCols) && Number.isInteger(edits.baseRows)) {
      edits = remapEdits(edits, cols, rows);
      if (edits.overrides.length > 0 || edits.locked.length > 0) {
        issues.push({ code: 'I_EDITS_REMAPPED', severity: 'info', message: `The hand edits were made on a ${req.edits!.baseCols} × ${req.edits!.baseRows} chart and moved to ${cols} × ${rows} by position.` });
      }
    } else {
      issues.push({ code: 'W_EDITS_INVALID', severity: 'warn', message: `The hand edits name an invalid chart size (${String(edits.baseCols)} × ${String(edits.baseRows)}) and were ignored.` });
      edits = undefined;
    }
  }
  const overrides: { cell: number; color: ColorRef }[] = [];
  let invalid = 0;
  for (const o of edits?.overrides ?? []) {
    if (!Number.isInteger(o.cell) || o.cell < 0 || o.cell >= n || !o.color || !isHex(o.color.hex)) {
      invalid++;
      continue;
    }
    overrides.push({ cell: o.cell, color: { hex: o.color.hex.toLowerCase(), ...(o.color.yarnId !== undefined ? { yarnId: o.color.yarnId } : {}) } });
  }
  if (invalid > 0) issues.push({ code: 'W_EDITS_INVALID', severity: 'warn', message: `${invalid} hand edit${invalid > 1 ? 's were' : ' was'} outside the chart or had no valid color and ${invalid > 1 ? 'were' : 'was'} ignored.` });
  // Distinct override colors, in a fixed order (by identity, so the paint order does not matter), at most
  // OVERRIDE_MAX_COLORS of them (the most used; the rest take the nearest kept color).
  const overrideCell = new Int32Array(n).fill(-1); // index into overrideRefs
  const byKey = new Map<string, { ref: ColorRef; uses: number }>();
  const cellKey = new Map<number, string>();
  for (const o of overrides) {
    const key = identity(o.color);
    const e = byKey.get(key);
    if (e === undefined) byKey.set(key, { ref: o.color, uses: 1 });
    else e.uses++;
    cellKey.set(o.cell, key);
  }
  const keys = [...byKey.keys()].sort();
  const kept = [...keys].sort((p, q) => byKey.get(q)!.uses - byKey.get(p)!.uses || (p < q ? -1 : 1)).slice(0, OVERRIDE_MAX_COLORS).sort();
  const overrideRefs: ColorRef[] = kept.map((k) => byKey.get(k)!.ref);
  const refIndex = new Map(kept.map((k, r) => [k, r]));
  if (keys.length > kept.length) {
    const keptLab = overrideRefs.map((r) => hexToLab(r.hex));
    for (const k of keys) {
      if (refIndex.has(k)) continue;
      const lab = hexToLab(byKey.get(k)!.ref.hex);
      let best = 0;
      let bd = Infinity;
      keptLab.forEach((l, r) => {
        const d = ciede2000(lab, l);
        if (d < bd) {
          bd = d;
          best = r;
        }
      });
      refIndex.set(k, best);
    }
    issues.push({ code: 'W_OVERRIDE_COLORS', severity: 'warn', message: `The hand edits use ${keys.length} colors; only ${OVERRIDE_MAX_COLORS} fit in one chart, so the rarest were replaced by the nearest kept color.` });
  }
  for (const [cell, key] of cellKey) overrideCell[cell] = refIndex.get(key)!;

  // ---- points
  const flat = s.kind === 'flat';
  let hist: PixelHistogram | undefined;
  let points: WeightedPoints;
  if (flat) {
    hist = pixelHistogram(s.work);
    points = hist.points;
  } else {
    const include = new Uint8Array(n);
    for (let i = 0; i < n; i++) include[i] = s.background[i] ? 0 : 1;
    points = cellPoints(colors.feat, include).points;
  }

  // Linear colors of the histogram points (flat art), computed when first needed.
  let pointLinCache: Color3[] | undefined;
  const pointLin = (p: number): Color3 => {
    pointLinCache ??= Array.from({ length: hist!.points.n }, (_, q) => linFromFeature([hist!.points.f[q * 3], hist!.points.f[q * 3 + 1], hist!.points.f[q * 3 + 2]]));
    return pointLinCache[p];
  };

  // ---- assignment of cells to centers
  let thin: Uint8Array<ArrayBuffer> | undefined;
  const assign = (centers: Center[], blend: boolean): { cell: Int32Array; pop: Float64Array; removed: number[] } => {
    const k = centers.length;
    const cf = Float64Array.from(centers.flatMap((c) => c.f));
    const cell = new Int32Array(n).fill(-1);
    let removed: number[] = [];
    if (k > 0) {
      if (flat && hist !== undefined) {
        const pc = new Int32Array(hist.points.n);
        for (let p = 0; p < hist.points.n; p++) pc[p] = nearestCenter(hist.points.f, p, cf, k)[0];
        const w = s.work.w;
        const h = s.work.h;
        let px = new Uint8Array(w * h).fill(NO_LABEL);
        for (let i = 0; i < px.length; i++) {
          const b = hist.pixelBin[i];
          if (b >= 0) px[i] = pc[hist.binPoint[b]];
        }
        if (blend) {
          const lin = centers.map((c) => linFromFeature(c.f));
          // Spread of a center's own colors along the mix a → b (linear light), from the histogram bins.
          const spread = (c: number, ea: number, eb: number): number => {
            const A = lin[ea];
            const B = lin[eb];
            const AB = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const len2 = AB[0] ** 2 + AB[1] ** 2 + AB[2] ** 2;
            if (!(len2 > 0)) return 0;
            let sw = 0;
            let st = 0;
            let stt = 0;
            for (let p = 0; p < hist!.points.n; p++) {
              if (pc[p] !== c) continue;
              const L = pointLin(p);
              const tt = ((L[0] - A[0]) * AB[0] + (L[1] - A[1]) * AB[1] + (L[2] - A[2]) * AB[2]) / len2;
              const wp = hist!.points.w[p];
              sw += wp;
              st += wp * tt;
              stt += wp * tt * tt;
            }
            return sw > 0 ? Math.sqrt(Math.max(0, stt / sw - (st / sw) ** 2)) : 0;
          };
          removed = removeBlendCenters(px, w, h, lin, (q) => centers[q].protected, spread);
          if (removed.length > 0) return { cell, pop: new Float64Array(k), removed };
        }
        const keep = new Set<number>();
        centers.forEach((c, q) => c.protected && keep.add(q));
        px = despeckleLabels(px, w, h, keep);
        const pooled = poolLabels(px, w, h, s.xs, s.ys);
        thin = pooled.thin;
        for (let i = 0; i < n; i++) cell[i] = pooled.labels[i] === NO_LABEL ? -1 : pooled.labels[i];
      }
      for (let i = 0; i < n; i++) {
        if (s.background[i]) {
          cell[i] = -1;
          continue;
        }
        if (!flat || cell[i] < 0) cell[i] = nearestCenter(colors.feat, i, cf, k)[0];
      }
    }
    const pop = new Float64Array(k);
    for (let i = 0; i < n; i++) if (cell[i] >= 0) pop[cell[i]]++;
    return { cell, pop, removed };
  };

  /** Drops the least populous unprotected centers until at most `cap` remain (ties → the later one). */
  const enforceCap = (centers: Center[], pop: Float64Array): Center[] => {
    const alive = centers.map(() => true);
    let count = centers.length;
    while (count > cap) {
      let drop = -1;
      for (let c = 0; c < centers.length; c++) {
        if (!alive[c] || centers[c].protected) continue;
        if (drop < 0 || pop[c] <= pop[drop]) drop = c;
      }
      if (drop < 0) break;
      alive[drop] = false;
      count--;
    }
    return centers.filter((_, c) => alive[c]);
  };

  // Yarn modes: every hand-edit color maps to its own yarn when the candidates have it, else to the nearest shade.
  // A hand edit without its own yarn is protected, so it never maps to a textured shade (§2.4.4).
  const overrideYarns: number[] =
    mode === 'yarns'
      ? overrideRefs.map((ref) => (ref.yarnId !== undefined ? candIndex.get(ref.yarnId) : undefined) ?? (nearestYarnIn(ref.hex, cand!, notTextured) ?? nearestYarnIn(ref.hex, cand!)!).index)
      : [];

  // p-median sums over bins (§2.4.4): the points pooled to ΔEOKr2 0.02 cubes when there are many.
  let pooled: WeightedPoints | undefined;
  const binned = (): WeightedPoints => (pooled ??= points.n > CURVE_MAX_POINTS ? coarsePoints(points, CURVE_BIN) : points);

  let centers: Center[] = [];
  /** Auto mode: the center each override color went to (objects survive filtering). */
  const overrideTarget: Center[] = [];
  let autoK: Colorized['autoK'];
  let autoQ: Quantized | undefined;
  const freeK = (): number => {
    if (!auto) return cap;
    const a = chooseK(points, cap);
    autoK = { k: a.k, curve: a.curve };
    autoQ = a.result;
    return Math.max(1, a.k);
  };

  if (mode === 'auto') {
    // ---- free centers, merged (§2.4.2–2.4.3)
    if (points.n > 0) {
      const k = freeK();
      const q = autoQ ?? quantize(points, k);
      const labs: Color3[] = [];
      for (let c = 0; c < q.k; c++) labs.push(featureToLab(q.centers[c * 3], q.centers[c * 3 + 1], q.centers[c * 3 + 2]));
      const keep = mergeCenters(labs, q.weights, () => false);
      centers = keep.map((c) => ({ f: [q.centers[c * 3], q.centers[c * 3 + 1], q.centers[c * 3 + 2]], protected: false, role: 'color', salient: false }));
    }
    // ---- hand-edit colors as protected centers: an existing center within ΔE00 2, or one named by the same
    // yarn (its nearest reference shade), takes the edit; otherwise the edit's exact color is inserted.
    const namedId = centers.map((c) => nearestYarnToLab(featureToLab(...c.f), reference)?.yarn.id);
    overrideRefs.forEach((ref, r) => {
      const lab = hexToLab(ref.hex);
      const refYarn = ref.yarnId !== undefined ? (findYarn(ref.yarnId, req.lines, reference) ?? undefined) : undefined;
      let hit = -1;
      for (let c = 0; c < centers.length && hit < 0; c++) {
        const cc = centers[c];
        // Any existing center — an inserted hand-edit color too — within ΔE00 2 or of the same yarn.
        if (ciede2000(lab, featureToLab(...cc.f)) < OVERRIDE_SAME_DE00 || (ref.yarnId !== undefined && (cc.yarn?.id ?? namedId[c]) === ref.yarnId)) hit = c;
      }
      if (hit >= 0 && centers[hit].role === 'color' && !centers[hit].protected) {
        centers[hit] = { ...centers[hit], protected: true, ...(refYarn !== undefined && centers[hit].yarn === undefined ? { yarn: refYarn } : {}) };
      } else if (hit < 0) {
        centers.push({ f: hexToFeature(ref.hex), hex: ref.hex, ...(refYarn ? { yarn: refYarn } : {}), protected: true, role: 'override', salient: false });
        hit = centers.length - 1;
      }
      overrideTarget[r] = centers[hit];
    });
  } else {
    // ---- p-median over the candidates (§2.4.4); hand-edit yarns are always chosen
    const fixed = [...new Set(overrideYarns)].sort((x, y) => x - y);
    if (points.n > 0 || fixed.length > 0) {
      // A custom CSV is a fixed palette: with max colors 'auto' every row is a candidate color (unused ones drop
      // out); p-median picks a subset only when the budget is smaller than the palette (§2.4.4).
      const want = points.n === 0 ? 1 : settings.paletteMode === 'custom' && auto ? cap : freeK();
      const k = Math.max(fixed.length, Math.min(want, cand!.length));
      centers = yarnCenters(pMedian(binned(), candFeat, k, { fixed }).chosen, fixed);
    }
  }

  function yarnCenters(chosen: readonly number[], fixed: readonly number[]): Center[] {
    return chosen.map((j) => ({
      f: [candFeat[j * 3], candFeat[j * 3 + 1], candFeat[j * 3 + 2]],
      hex: cand![j].hex,
      yarn: cand![j],
      candidate: j,
      protected: fixed.includes(j),
      role: overrideYarns.includes(j) ? 'override' : 'color',
      salient: false,
    }));
  }

  // ---- anti-aliasing centers (flat art only)
  let a = assign(centers, flat);
  while (a.removed.length > 0) {
    const gone = new Set(a.removed);
    centers = centers.filter((_, c) => !gone.has(c));
    a = assign(centers, flat);
  }
  // Reassign only when the centers changed (a flat-art assignment pools a ≤ 2048 px label image).
  const centersKey = (cs: readonly Center[]): string => cs.map((c) => `${c.f.join(',')}|${c.protected ? 1 : 0}`).join(';');
  let assignedKey = centersKey(centers);
  const reassign = (): void => {
    const key = centersKey(centers);
    if (key === assignedKey) return;
    a = assign(centers, false);
    assignedKey = key;
  };

  // ---- salience guard (§2.4.3)
  const salient = new Uint8Array(n);
  const salientTargets: { cells: number[]; center?: Center; candidate?: number }[] = [];
  if (centers.length > 0 && cap >= 2) {
    const centerLab = centers.map((c) => featureToLab(...c.f));
    // A detail is measured against the solid colors: a cell given a textured yarn counts as given the nearest
    // solid one (heathers are never assigned to protected labels, §2.4.4).
    const solids = centers.map((c, k) => (c.yarn?.textured ? -1 : k)).filter((k) => k >= 0);
    const solidOf = (k: number, i: number): number => {
      if (!centers[k].yarn?.textured || solids.length === 0) return k;
      let best = solids[0];
      let bd = Infinity;
      for (const s2 of solids) {
        const d = ciede2000(cellLab.subarray(i * 3, i * 3 + 3), centerLab[s2]);
        if (d < bd) {
          bd = d;
          best = s2;
        }
      }
      return best;
    };
    const assignedLab = new Float64Array(n * 3);
    const eligible = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (a.cell[i] < 0 || overrideCell[i] >= 0) continue;
      eligible[i] = 1;
      assignedLab.set(centerLab[solidOf(a.cell[i], i)], i * 3);
    }
    // Mixes of two colors — the background yarn included — are edge cells, not details.
    const centerLin = centers.map((c) => linFromFeature(c.f));
    if (bg !== undefined) centerLin.push(hexToLinearRgb(bg.hex));
    const mixed = (i: number): boolean => isMixOf([colors.lin[i * 3], colors.lin[i * 3 + 1], colors.lin[i * 3 + 2]], centerLin);
    // Details are small: a group larger than 0.3% of the subject (at least 8 cells) is a region the palette
    // simply does not cover, not an eye (research 06 §2.4).
    let subject = 0;
    for (let i = 0; i < n; i++) if (a.cell[i] >= 0) subject++;
    const maxCells = Math.max(SALIENT_MAX_CELLS_MIN, Math.ceil(SALIENT_MAX_SHARE * subject));
    let groups = salientGroups(cols, rows, cellLab, assignedLab, colors.lin, eligible, mixed).filter((g) => g.cells.length <= maxCells);
    if (mode === 'yarns') {
      // A group whose nearest solid yarn is the one most of its cells already have gains nothing.
      groups = groups.filter((g) => {
        const m = nearestYarnToLab(g.lab, cand!, notTextured);
        if (m === null) return false;
        const counts = new Map<number, number>();
        for (const i of g.cells) counts.set(a.cell[i], (counts.get(a.cell[i]) ?? 0) + 1);
        const [top] = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
        return centers[top]?.candidate !== m.index;
      });
    }
    if (groups.length > 0) {
      const protectedCount = centers.filter((c) => c.protected).length;
      const room = Math.max(0, cap - 1 - protectedCount);
      const take = groups.slice(0, room);
      for (const g of take) for (const i of g.cells) salient[i] = 1;
      if (take.length > 0) {
        if (mode === 'auto') {
          for (const g of take) {
            const center: Center = { f: linToFeature(g.lin), protected: true, role: 'color', salient: true };
            centers.push(center);
            salientTargets.push({ cells: g.cells, center });
          }
          reassign();
          centers = enforceCap(centers, a.pop);
        } else {
          const fixed = centers.filter((c) => c.protected).map((c) => c.candidate!);
          const salientYarns: number[] = [];
          for (const g of take) {
            const m = nearestYarnToLab(g.lab, cand!, notTextured);
            if (m === null) continue;
            salientTargets.push({ cells: g.cells, candidate: m.index });
            if (!fixed.includes(m.index) && !salientYarns.includes(m.index)) salientYarns.push(m.index);
          }
          // A solid already chosen becomes protected; missing ones are forced into a new p-median.
          centers = centers.map((c) => (salientYarns.includes(c.candidate!) ? { ...c, protected: true, salient: true } : c));
          const fresh = salientYarns.filter((j) => !centers.some((c) => c.candidate === j));
          if (fresh.length > 0) {
            const allFixed = [...fixed, ...fresh].sort((x, y) => x - y);
            // The detail is added within the budget; a chosen yarn is displaced only when the budget is full.
            const k = Math.max(allFixed.length, Math.min(cap, centers.length + fresh.length));
            centers = yarnCenters(pMedian(binned(), candFeat, Math.min(k, cand!.length), { fixed: allFixed }).chosen, fixed).map((c) =>
              fresh.includes(c.candidate!) ? { ...c, protected: true, salient: true } : c,
            );
          }
        }
      }
    }
  }
  if (centers.length > cap) {
    reassign();
    centers = enforceCap(centers, a.pop);
  }
  reassign();

  // ---- salient details keep their protected color (whatever a nearer textured or blended center says)
  for (const g of salientTargets) {
    const k = g.center !== undefined ? centers.indexOf(g.center) : centers.findIndex((c) => c.candidate === g.candidate);
    if (k < 0) continue;
    const fk = centers[k].f;
    for (const i of g.cells) {
      if (a.cell[i] < 0 || a.cell[i] === k) continue;
      // Only when the detail's color is nearer than the cell's own (or the cell's own is a textured yarn).
      const old = centers[a.cell[i]];
      const dNew = (colors.feat[i * 3] - fk[0]) ** 2 + (colors.feat[i * 3 + 1] - fk[1]) ** 2 + (colors.feat[i * 3 + 2] - fk[2]) ** 2;
      const dOld = (colors.feat[i * 3] - old.f[0]) ** 2 + (colors.feat[i * 3 + 1] - old.f[1]) ** 2 + (colors.feat[i * 3 + 2] - old.f[2]) ** 2;
      if (!(dNew < dOld || old.yarn?.textured === true)) continue;
      a.pop[a.cell[i]]--;
      a.cell[i] = k;
      a.pop[k]++;
    }
  }

  // ---- hand edits win their cells
  const overrideCenter = overrideRefs.map((ref) => {
    if (mode === 'yarns') return centers.findIndex((c) => c.candidate === overrideYarns[overrideRefs.indexOf(ref)]);
    const target = overrideTarget[overrideRefs.indexOf(ref)];
    const k = target !== undefined ? centers.indexOf(target) : -1;
    if (k >= 0) return k;
    const lab = hexToLab(ref.hex);
    let best = -1;
    let bd = Infinity;
    centers.forEach((c, k) => {
      const d = ciede2000(lab, featureToLab(...c.f));
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    return best;
  });
  for (let i = 0; i < n; i++) {
    const r = overrideCell[i];
    if (r < 0 || overrideCenter[r] < 0) continue;
    if (a.cell[i] >= 0) a.pop[a.cell[i]]--;
    a.cell[i] = overrideCenter[r];
    a.pop[a.cell[i]]++;
  }
  const protectedColors = centers.filter((c) => c.protected).length;
  if (protectedColors > cap) {
    issues.push({
      code: 'W_OVERRIDE_COLORS',
      severity: 'warn',
      message: `Your hand edits and small details use ${protectedColors} colors, more than the ${cap} allowed; all of them are kept.`,
    });
  }

  // ---- palette (§2.4.2 codes by population; background outside the budget)
  interface Entry {
    center?: number;
    background: boolean;
    pop: number;
  }
  const entries: Entry[] = [];
  const entryOf = new Int32Array(centers.length).fill(-1);
  centers.forEach((_, c) => {
    if (a.pop[c] > 0) {
      entryOf[c] = entries.length;
      entries.push({ center: c, background: false, pop: a.pop[c] });
    }
  });
  let bgEntry = -1;
  let bgFinal = 0;
  for (let i = 0; i < n; i++) if (a.cell[i] < 0) bgFinal++;
  if (bg !== undefined && bgFinal > 0) {
    // The background shares an entry with a color center of the same yarn (or, in auto mode, within ΔE00 5).
    const bgLab = hexToLab(bg.hex);
    let share = -1;
    entries.forEach((e, q) => {
      if (share >= 0 || e.center === undefined) return;
      const c = centers[e.center];
      if (mode === 'yarns' ? c.yarn?.id === bg!.yarn?.id : !c.protected && ciede2000(bgLab, featureToLab(...c.f)) < MERGE_DE00) share = q;
    });
    if (share >= 0) {
      bgEntry = share;
      entries[share].background = true;
      entries[share].pop += bgFinal;
    } else {
      bgEntry = entries.length;
      entries.push({ background: true, pop: bgFinal });
    }
  }
  const order = entries.map((_, q) => q).sort((p, q) => entries[q].pop - entries[p].pop || p - q);
  const rank = new Int32Array(entries.length);
  order.forEach((q, r) => (rank[q] = r));
  const labels = new Uint8Array(n);
  const sumLin = new Float64Array(entries.length * 3);
  for (let i = 0; i < n; i++) {
    const q = a.cell[i] >= 0 ? entryOf[a.cell[i]] : bgEntry;
    labels[i] = rank[q];
    sumLin[q * 3] += colors.lin[i * 3];
    sumLin[q * 3 + 1] += colors.lin[i * 3 + 1];
    sumLin[q * 3 + 2] += colors.lin[i * 3 + 2];
  }
  const palette: PaletteEntry[] = order.map((q, r) => {
    const e = entries[q];
    const code = paletteCode(r);
    const meanLab = linearRgbToLab(sumLin[q * 3] / e.pop, sumLin[q * 3 + 1] / e.pop, sumLin[q * 3 + 2] / e.pop);
    const c = e.center !== undefined ? centers[e.center] : undefined;
    const role: PaletteEntry['role'] = c === undefined || (e.background && !c.protected) ? 'background' : c.role;
    if (e.background && (c === undefined || !c.protected)) {
      // The background yarn (or color) wins a shared entry.
      const hex = bg!.hex;
      const named = bg!.yarn ?? nearestYarnIn(hex, mode === 'yarns' ? cand! : reference)?.yarn;
      const out: PaletteEntry = { code, hex, name: named?.name ?? 'Background', role };
      if (named !== undefined) {
        out.yarn = named;
        out.deltaE00 = round2(ciede2000(mode === 'yarns' ? meanLab : hexToLab(hex), hexToLab(named.hex)));
      }
      return out;
    }
    const cc = c!;
    if (mode === 'yarns') {
      const out: PaletteEntry = { code, hex: cc.hex!, name: cc.yarn!.name, yarn: cc.yarn, deltaE00: round2(ciede2000(meanLab, hexToLab(cc.hex!))), role };
      if (cc.protected) out.protected = true;
      return out;
    }
    const hex = cc.hex ?? featureToHex(...cc.f);
    const lab = hexToLab(hex);
    // Named by the center's nearest shade; the ΔE00 shown is the cluster mean's (§2.4.4) — a hand edit's own
    // color for an override (its cells' picture colors are what it replaced).
    const named = cc.yarn !== undefined ? { yarn: cc.yarn } : nearestYarnToLab(lab, reference, cc.protected ? notTextured : undefined);
    const shownDe = named !== null ? ciede2000(cc.role === 'override' ? lab : meanLab, hexToLab(named.yarn.hex)) : 0;
    const out: PaletteEntry = { code, hex, name: named !== null ? named.yarn.name + (shownDe > APPROXIMATE_DE00 ? ' (approximate)' : '') : `Color ${code}`, role };
    if (named !== null) {
      out.yarn = named.yarn;
      out.deltaE00 = round2(shownDe);
    }
    if (cc.protected) out.protected = true;
    return out;
  });

  // ---- protect mask for cleanup (§2.5)
  const protect = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (salient[i] || overrideCell[i] >= 0 || (thin !== undefined && thin[i])) protect[i] = 1;
  for (const l of edits?.locked ?? []) if (Number.isInteger(l) && l >= 0 && l < n) protect[l] = 1;

  const out: Colorized = { cols, rows, labels, palette, protect, salient, colors, mode, overrides, issues };
  if (thin !== undefined) out.thin = thin;
  if (autoK !== undefined) out.autoK = autoK;
  return out;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function findYarn(id: string, lines: readonly YarnLine[] | undefined, reference: readonly Yarn[]): Yarn | undefined {
  for (const l of lines ?? []) {
    const y = l.yarns.find((q) => q.id === id);
    if (y !== undefined) return y;
  }
  const lineId = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
  return getShippedLine(lineId)?.yarns.find((q) => q.id === id) ?? reference.find((q) => q.id === id);
}

function linFromFeature(f: Color3): Color3 {
  const [L, a, b] = featureToOklab(f[0], f[1], f[2]);
  return oklabToLinearRgb(L, a, b);
}

function linToFeature(lin: Color3): Color3 {
  const [L, a, b] = linearRgbToOklab(lin[0], lin[1], lin[2]);
  return oklabToFeature(L, a, b);
}

/** The chart grid of a colorized chart (`ChartResult.grid`). */
export function toChartGrid(c: Colorized): ChartGrid {
  return { cols: c.cols, rows: c.rows, labels: c.labels, palette: c.palette };
}

/** A hash of the colors decided (§5.8): labels, protect and salient masks, and the palette (ΔE00 rounded to 0.01). */
export function colorizeHash(c: Colorized): string {
  const h = createFnv1a64();
  h.update(canonicalJson({ cols: c.cols, rows: c.rows, palette: c.palette.map((p) => [p.code, p.hex, p.yarn?.id ?? null, p.role ?? null, p.protected ?? false, p.deltaE00 ?? null]) }));
  h.update(c.labels);
  h.update(c.protect);
  h.update(c.salient);
  return h.hex();
}
