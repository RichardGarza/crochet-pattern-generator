// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { ChartGrid } from './chart';
import type { Cell, Technique2D } from './gauge';
import type { Issue } from './issues';
import type { Hand, Terms } from './units';
import type { Yarn } from './yarn';

export type Loop = 'both' | 'BLO' | 'FLO';

export type Op =
  | { k: 'st'; st: 'sc' | 'hdc' | 'dc' | 'slst'; loop?: Loop; color?: string; into?: 'flo2below' }
  | { k: 'inc'; n: 2 | 3; color?: string; loop?: Loop }
  | { k: 'dec'; n: 2 | 3; color?: string; loop?: Loop }
  | { k: 'tile'; color: string };

export type LineStart =
  | { k: 'foundation'; chains: number; firstInto: number }
  | { k: 'turn'; chains: number }
  | { k: 'mr'; n: number }
  | { k: 'chainOval'; chains: number }
  | { k: 'chainRing'; chains: number }
  /** Joined round: "ch 1, sc in same st as join". */
  | { k: 'join' }
  /** Border Rnd 1, worked into the panel edges (E_CONSUME-exempt). */
  | { k: 'edge' }
  | { k: 'c2c'; start: 'first' | 'inc' | 'dec'; end: 'first' | 'inc' | 'dec' };

/** Printed after the line. */
export interface Cue {
  kind: 'eyes' | 'stuff' | 'note' | 'color';
  text: string;
}

export interface Line {
  kind: 'row' | 'rnd' | 'c2c' | 'border';
  n: number;
  nEnd?: number;
  side?: 'RS' | 'WS';
  arrow?: '←' | '→' | '↙' | '↗' | '↖' | '↘';
  start?: LineStart;
  ops: Op[];
  prevCount: number | null;
  stated: number;
  /** Op index where each oval segment starts (§2.10.8, §2.13). */
  segments?: { at: number; kind: 'side' | 'end' }[];
  /** The round ends "join with sl st in first sc" (§2.11.3). */
  join?: { changeTo?: string; drop?: 'carry' | 'cut' };
  colorHeader?: string;
  cues?: Cue[];
  notes?: string[];
}

/** Tails per §2.10.6. */
export interface PieceFinish {
  kind: 'gather' | 'open' | 'flattenSc' | 'whipstitch' | 'seamToStart';
  tailIn: number;
  sewTailIn?: number;
  text: string;
}

export interface Piece {
  id: string;
  title: string;
  makeCount: number;
  partIds: string[];
  intro: string[];
  lines: Line[];
  finish: PieceFinish;
  stuffing?: 'firm' | 'medium' | 'light' | 'none';
}

export interface AssemblyStep {
  order: number;
  kind: 'open-edge' | 'closed' | 'feature-ref';
  child: string;
  parent: string;
  rounds: [number, number];
  centerStitch: number;
  ofStitches: number;
  openSts?: number;
  apart?: number;
  text: string;
  landmark?: string;
}

export interface MaterialsLine {
  code: string;
  hex: string;
  name: string;
  yarn?: Yarn;
  deltaE00?: number;
  stitches: number;
  strands: number;
  yards: number;
  yardsLow: number;
  yardsHigh: number;
  meters: number;
  skeins?: number;
  grams?: number;
}

export interface PatternDoc {
  kind: '2d' | '3d';
  title: string;
  terms: Terms;
  hand: Hand;
  dialect: 'compact' | 'verbose';
  skill: { level: 1 | 2 | 3 | 4; name: 'Basic' | 'Easy' | 'Intermediate' | 'Complex'; reasons: string[] };
  finishedSize: { wIn: number; hIn: number; dIn?: number; tolPct: number };
  gaugeText: string;
  hook: { mm: number; us?: string };
  materials: MaterialsLine[];
  notions: string[];
  notes: string[];
  abbreviations: { abbr: string; meaning: string }[];
  specialStitches: { name: string; text: string }[];
  pieces: Piece[];
  assembly: AssemblyStep[];
  finishing: string[];
  chart?: { grid: ChartGrid; cell: Cell; technique: Technique2D };
  issues: Issue[];
  hash: string;
}
