// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { ResolvedGauge, Technique2D } from './gauge';
import type { RgbaImage } from './geometry';
import type { Issue } from './issues';
import type { Hand, Inches } from './units';
import type { Yarn, YarnLine } from './yarn';

export type ImageKind = 'photo' | 'flat' | 'pixel';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: 0 | 90 | 180 | 270;
  flipX: boolean;
}

export interface PaletteEntry {
  code: string;
  hex: string;
  name: string;
  yarn?: Yarn;
  deltaE00?: number;
  protected?: boolean;
  /** 'override' = re-inserted from a hand edit (§5.5.5). */
  role?: 'color' | 'background' | 'override';
}

export interface ChartGrid {
  cols: number;
  rows: number;
  /** Row-major, row 0 = top. */
  labels: Uint8Array<ArrayBuffer>;
  palette: PaletteEntry[];
}

/** Stable color identity (never a palette index). */
export interface ColorRef {
  hex: string;
  yarnId?: string;
}

export interface ChartEdits {
  baseCols: number;
  baseRows: number;
  /** `cell` = row-major index at baseCols × baseRows. */
  overrides: { cell: number; color: ColorRef }[];
  /** Cells protected from cleanup. */
  locked: number[];
}

export interface ChartSettings {
  technique: Technique2D;
  hand: Hand;
  startCorner: 'BR' | 'BL' | 'TR' | 'TL';
  /** Finished size, border included. */
  widthIn?: Inches;
  heightIn?: Inches;
  lockAspect: boolean;
  /** `widthIn` 0 = none; `color` undefined = palette A. */
  border: { widthIn: Inches; color?: ColorRef };
  maxColors: number | 'auto';
  paletteMode: 'auto' | 'line' | 'stash' | 'custom';
  lineIds: string[];
  customCsv?: string;
  referenceLineId: string;
  detail: 'max' | 'balanced' | 'easy';
  dither: 'off' | 'rowFade';
  imageKind: ImageKind | 'auto';
  /** No 'noStitch' in v1. */
  background: 'keep' | 'remove';
  backgroundColor?: ColorRef;
  applyRepeats: 'auto' | 'ask' | 'off';
  /** sc_tapestry_round only (§2.7.5). */
  roundLean: { mode: 'note' | 'preskew' | 'turn'; stPerRnd: number };
}

export interface ChartMetrics {
  confettiPct: number;
  changesPerRowMean: number;
  changesPerRowMax: number;
  busiestRows: number[];
  strandsPerColor: number[];
  ends: number;
  carriedPerRowMax: number;
  fidelityDE00: number;
  workability: number;
}

export interface RepeatInfo {
  lattice?: { px: number; py: number; match: number; applied: boolean };
  verticalBlocks: { from: number; to: number; repeatOf: [number, number] }[];
  stripePeriod?: number;
  symmetryCol?: number;
  spotMotif?: { count: number; label: number };
}

export interface ChartRequest {
  jobId: number;
  /** A Blob is decoded by workers/decode.ts (§2.3.1); core functions only ever receive an RgbaImage. */
  image: Blob | RgbaImage;
  crop?: CropRect;
  settings: ChartSettings;
  gauge: ResolvedGauge;
  edits?: ChartEdits;
  lines: YarnLine[];
  stash: Yarn[];
}

export interface ChartResult {
  jobId: number;
  grid: ChartGrid;
  kind: ImageKind;
  source: { w: number; h: number };
  size: { cols: number; rows: number; borderRounds: number; actualW: Inches; actualH: Inches; aspectErr: number };
  metrics: ChartMetrics;
  repeats: RepeatInfo;
  issues: Issue[];
  hash: string;
}
