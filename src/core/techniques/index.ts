// Track T2 — builds the 2D PatternDoc from a chart: the technique writers of DESIGN.md §2.7 plus the border
// (§2.7.10, rounds from settings.border and gauge.hSc), block repeats and folding (§2.6.2), materials and yardage
// (§2.8), notes, abbreviations, skill, validation (§2.13). Called by Chart2dApi.buildPattern (§5.2.1).
//
// One piece, `panel` (a tube for `sc_tapestry_round`): the technique's lines, then the border rounds. Lines are
// written for `settings.hand` (§2.7.2). `mosaic_overlay` is written in T2.4: until then its doc has no piece and
// says so in `issues`.
import type { BuildPattern2DFn, ChartGrid, ChartSettings, ColorRef, Hand, Issue, Line, PaletteEntry, PatternDoc, Piece, ResolvedGauge, Technique2D, Terms } from '../../types';
import { gaugeText2D, docHash, hookOf } from '../pattern/doc';
import { notesWith } from '../pattern/notes';
import { computeSkill } from '../pattern/skill';
import { abbreviationsFor, specialStitchesFor } from '../pattern/terminology';
import { emptyWork, type ColorWork, type Yardage2D, yardage2D } from '../yardage/twoD';
import { type BorderPlan, borderStitches, planBorder, writeBorder } from './border';
import { type C2CWriterResult, writeC2C } from './c2c';
import { type Corner, cornerOf } from './c2cCorners';
import { applyBlockRepeat, findBlockRepeat } from './repeats';
import { type RoundWriterResult, foldRounds, roundLeanOf, writeScTapestryRound } from './scRound';
import { TURN_CHAINS, flatFoundation, foldRows, labelCode, writeFlatRows } from './scFlat';
import { type StrandPlan } from './strands';
import { type TapestryPlan, writeScTapestry } from './tapestry';
import { FLAT_ROW_TECHNIQUES, flatStitchOf, lastStitchColor, validate2D, validateChart } from './validate2d';

const CODES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface BuildPattern2DInput {
  chart: ChartGrid;
  settings: ChartSettings;
  gauge: ResolvedGauge;
  terms: Terms;
  dialect: 'compact' | 'verbose';
  title: string;
}

export interface BuildPattern2DOptions {
  /** Print the strand / tapestry / region cues (default true). */
  cues?: boolean;
  /** Fold identical lines and write block repeats (default true; block repeats also need `applyRepeats` ≠ 'off'). */
  fold?: boolean;
}

/** Everything the 2D builder computed, for views and tests. */
export interface Pattern2DBuild {
  doc: PatternDoc;
  /** Unfolded technique lines (rows, rounds or diagonals), without the border. */
  worked: Line[];
  work: Map<string, ColorWork>;
  yardage: Yardage2D;
  border: BorderPlan | null;
  /** The border color's palette entry (a new entry when the border yarn is not in the chart). */
  borderEntry?: PaletteEntry;
  strands?: StrandPlan;
  tapestry?: TapestryPlan;
  c2c?: C2CWriterResult;
  rounds?: RoundWriterResult;
}

/** The palette entry of the border color: palette A when unset, a chart color with that yarn or hex, else a new one. */
export function borderEntryOf(grid: ChartGrid, color: ColorRef | undefined): { entry: PaletteEntry; added: boolean } {
  const palette = grid.palette;
  if (color === undefined || typeof color !== 'object' || typeof color.hex !== 'string') {
    return { entry: palette.find((p) => p.code === 'A') ?? palette[0], added: false };
  }
  const hex = color.hex.toLowerCase();
  const byYarn = color.yarnId === undefined ? undefined : palette.find((p) => p.yarn?.id === color.yarnId);
  const byHex = palette.find((p) => p.hex.toLowerCase() === hex);
  const found = byYarn ?? byHex;
  if (found !== undefined) return { entry: found, added: false };
  const used = new Set(palette.map((p) => p.code));
  let code = '';
  for (let i = 0; code === '' && i < 26 * 27; i++) {
    const c = i < 26 ? CODES[i] : CODES[Math.floor(i / 26) - 1] + CODES[i % 26];
    if (!used.has(c)) code = c;
  }
  return { entry: { code, hex, name: `Border (${hex})` }, added: true };
}

function work(map: Map<string, ColorWork>, code: string | undefined): ColorWork {
  const key = code ?? '?';
  let w = map.get(key);
  if (w === undefined) {
    w = emptyWork();
    map.set(key, w);
  }
  return w;
}

/** Mean color changes per worked line (runs − 1), for the skill level. */
function meanChanges(lines: readonly Line[]): number {
  if (lines.length === 0) return 0;
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.ops.length; i++) if (line.ops[i].color !== line.ops[i - 1].color) total++;
  }
  return total / lines.length;
}

function emptyDoc(i: BuildPattern2DInput, hand: Hand, issues: Issue[]): PatternDoc {
  const doc: Omit<PatternDoc, 'hash'> = {
    kind: '2d',
    title: i.title,
    terms: i.terms,
    hand,
    dialect: i.dialect,
    skill: computeSkill({ colors: 0, meanChangesPerLine: 0, technique: i.settings?.technique ?? 'sc_graphgan' }),
    finishedSize: { wIn: 0, hIn: 0, tolPct: 0 },
    gaugeText: '',
    hook: hookOf(i.gauge?.hookMm ?? 0),
    materials: [],
    notions: [],
    notes: [],
    abbreviations: [],
    specialStitches: [],
    pieces: [],
    assembly: [],
    finishing: [],
    issues,
  };
  return { ...doc, hash: docHash(doc) };
}

/** `buildPattern2D` with its working data (see `Pattern2DBuild`). Never throws on a bad chart: the doc says why. */
export function buildPattern2DWith(i: BuildPattern2DInput, o: BuildPattern2DOptions = {}): Pattern2DBuild {
  const settings = i.settings;
  const hand: Hand = settings?.hand === 'left' ? 'left' : 'right';
  const technique: Technique2D = settings?.technique ?? 'sc_graphgan';
  const grid = i.chart;
  const gauge = i.gauge;
  const chartIssues = validateChart(grid);
  const empty = (issues: Issue[]): Pattern2DBuild => ({
    doc: emptyDoc(i, hand, issues),
    worked: [],
    work: new Map(),
    yardage: { materials: [], parts: [], buffer: 0, band: 0, strands: 0 },
    border: null,
  });
  if (chartIssues.some((x) => x.code === 'E_SANITY')) return empty(chartIssues);
  if (technique === 'mosaic_overlay') {
    return empty([{ code: 'E_SANITY', severity: 'error', message: 'overlay mosaic patterns are not written yet (they come with the mosaic writer)' }]);
  }
  const cues = o.cues !== false;
  const fold = o.fold !== false;
  const repeats = fold && settings?.applyRepeats !== 'off';
  const code = (label: number): string => labelCode(grid, label);
  const W = grid.cols;
  const R = grid.rows;
  const works = new Map<string, ColorWork>();
  for (const p of grid.palette) works.set(p.code, emptyWork());
  for (let x = 0; x < grid.labels.length; x++) work(works, code(grid.labels[x])).cells++;

  let worked: Line[];
  let lines: Line[];
  let notes: string[];
  const build: Partial<Pattern2DBuild> = {};
  const roundLean = roundLeanOf(settings?.roundLean);
  const corner: Corner = cornerOf(settings?.startCorner, hand);

  if (FLAT_ROW_TECHNIQUES.has(technique)) {
    const stitch = flatStitchOf(technique);
    let rows: Line[];
    if (technique === 'sc_tapestry') {
      const r = writeScTapestry(grid, { hand, cues, fold: false });
      rows = r.rows;
      build.tapestry = r.plan;
      r.plan.startsPerColor.forEach((n, label) => (work(works, code(label)).starts += n));
      r.plan.carriedPerColor.forEach((n, label) => (work(works, code(label)).carried += n));
      for (const [c, w] of works) if (w.cells > 0 && c !== '?') w.bobbins = 1;
      notes = notesWith('tapestry', { terms: i.terms, hand, stitch });
    } else {
      const r = writeFlatRows(grid, { hand, stitch, cues, fold: false });
      rows = r.rows;
      build.strands = r.plan;
      r.plan.strandsPerColor.forEach((n, label) => (work(works, code(label)).starts += n));
      r.plan.bobbinsPerColor.forEach((n, label) => (work(works, code(label)).bobbins = Math.max(work(works, code(label)).bobbins, n)));
      for (const row of r.plan.rows) for (const seg of row.segments) work(works, code(seg.label)).carried += seg.carried;
      notes = notesWith('flat-graph', { terms: i.terms, hand, stitch, strandCues: cues });
    }
    // Chains: the foundation in Row 1's first color, each turning chain in its row's first color (§2.7.2).
    for (const row of rows) {
      const first = row.ops[0]?.color;
      work(works, first).chains += row.n === 1 ? flatFoundation(W, stitch).chains : TURN_CHAINS[stitch];
    }
    worked = rows;
    const rep = repeats ? findBlockRepeat(rows, { even: true }) : null;
    const kept = rep === null ? rows : applyBlockRepeat(rows, rep);
    lines = fold ? foldRows(kept) : kept;
  } else if (technique === 'sc_tapestry_round') {
    const r = writeScTapestryRound(grid, { hand, roundLean, cues, fold: false });
    build.rounds = r;
    r.plan.startsPerColor.forEach((n, label) => (work(works, code(label)).starts += n));
    r.plan.carriedPerColor.forEach((n, label) => (work(works, code(label)).carried += n));
    for (const [c, w] of works) if (w.cells > 0 && c !== '?') w.bobbins = 1;
    // The ring (ch C + sl st) and each round's ch 1 and joining sl st, in the round's first color.
    for (const rnd of r.rounds) {
      const w = work(works, rnd.ops[0]?.color);
      w.chains += 1 + (rnd.n === 1 ? W : 0);
      w.slsts += 1 + (rnd.n === 1 ? 1 : 0);
    }
    worked = r.rounds;
    const rep = repeats ? findBlockRepeat(r.rounds, { even: roundLean.mode === 'turn' }) : null;
    const kept = rep === null ? r.rounds : applyBlockRepeat(r.rounds, rep);
    lines = fold && roundLean.mode !== 'turn' ? foldRounds(kept) : kept;
    notes = notesWith('tapestry-round', { terms: i.terms, hand, roundLean, rounds: R });
  } else {
    const r = writeC2C(grid, { hand, corner, cues });
    build.c2c = r;
    r.regions.regionsPerColor.forEach((n, label) => (work(works, code(label)).starts += n));
    r.regions.bobbinsPerColor.forEach((n, label) => (work(works, code(label)).bobbins = Math.max(work(works, code(label)).bobbins, n)));
    worked = r.lines;
    lines = r.lines;
    notes = notesWith('c2c', { terms: i.terms, hand, corner, arrows: r.arrows });
  }

  // Border (§2.7.10).
  const borderSetting = settings?.border;
  const { entry: borderEntry, added } = borderEntryOf(grid, borderSetting?.color);
  const border =
    borderSetting !== undefined && typeof borderSetting.widthIn === 'number' && borderSetting.widthIn > 0
      ? planBorder({ technique, hand, cols: W, rows: R, gauge, widthIn: borderSetting.widthIn, color: borderEntry.code, lastColor: lastStitchColor(grid, technique, hand) })
      : null;
  const all = [...lines];
  if (border !== null) {
    all.push(...writeBorder(border));
    const w = work(works, borderEntry.code);
    w.borderSts += borderStitches(border);
    w.borderRounds += border.rounds;
    notes.push(...notesWith('border', { terms: i.terms, hand }));
  }

  // Materials and yardage (§2.8): palette order, then a border yarn that is not in the chart.
  const entries: PaletteEntry[] = [...grid.palette];
  if (border !== null && added) entries.push(borderEntry);
  const yardage = yardage2D({ technique, gauge, colors: entries.map((entry) => ({ entry, work: works.get(entry.code) ?? emptyWork() })) });

  // Size (§2.7.10: the border is n·hSc per side).
  const B = border === null ? 0 : border.rounds * gauge.hSc;
  const finishedSize: PatternDoc['finishedSize'] =
    technique === 'sc_tapestry_round'
      ? { wIn: W * gauge.cell.w, hIn: R * gauge.cell.h, dIn: (W * gauge.cell.w) / Math.PI, tolPct: gauge.tol * 100 }
      : { wIn: W * gauge.cell.w + 2 * B, hIn: R * gauge.cell.h + 2 * B, tolPct: gauge.tol * 100 };

  const notions = ['Tapestry needle'];
  const bobbins = yardage.materials.reduce((a, m) => a + m.strands, 0);
  if ((technique === 'sc_graphgan' || technique === 'hdc_graphgan' || technique === 'c2c') && bobbins > yardage.materials.length) {
    notions.push(`Yarn bobbins (${bobbins} in all; see Materials)`);
  }
  if (technique === 'sc_tapestry_round') notions.push('Stitch marker (for the first stitch of each round)');

  const piece: Piece = {
    id: 'panel',
    title: technique === 'sc_tapestry_round' ? 'Tube' : 'Panel',
    makeCount: 1,
    partIds: [],
    intro: [],
    lines: all,
    finish: { kind: 'open', tailIn: 6, text: 'Fasten off and weave in ends.' },
  };

  const issues = validate2D({
    chart: grid,
    technique,
    hand,
    lines: all,
    piece: piece.id,
    plan: build.strands,
    roundLean,
    startCorner: corner,
    gauge,
    border: borderSetting === undefined ? undefined : { widthIn: borderSetting.widthIn, color: borderEntry.code },
    extraCodes: added ? [borderEntry.code] : [],
  });

  const doc: Omit<PatternDoc, 'hash'> = {
    kind: '2d',
    title: i.title,
    terms: i.terms,
    hand,
    dialect: i.dialect,
    skill: computeSkill({ colors: yardage.materials.length, meanChangesPerLine: meanChanges(worked), technique }),
    finishedSize,
    gaugeText: gaugeText2D(technique, gauge.cell, i.terms),
    hook: hookOf(gauge.hookMm),
    materials: yardage.materials,
    notions,
    notes,
    abbreviations: abbreviationsFor(all, i.terms),
    specialStitches: specialStitchesFor(all, i.terms),
    pieces: [piece],
    assembly: [],
    finishing: ['Weave in all ends on the WS, each within its own color area.', 'Block to the finished size.'],
    chart: { grid, cell: gauge.cell, technique },
    issues,
  };
  return {
    ...build,
    doc: { ...doc, hash: docHash(doc) },
    worked,
    work: works,
    yardage,
    border,
    ...(border !== null ? { borderEntry } : {}),
  };
}

/** §5.2.1: the 2D PatternDoc of a chart (see `buildPattern2DWith`). */
export const buildPattern2D: BuildPattern2DFn = (i) => buildPattern2DWith(i).doc;
