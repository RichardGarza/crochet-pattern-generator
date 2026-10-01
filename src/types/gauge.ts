// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { Cyc, Inches } from './units';

export type Technique2D = 'sc_graphgan' | 'sc_tapestry' | 'sc_tapestry_round' | 'c2c' | 'hdc_graphgan' | 'mosaic_overlay';
export type TechniqueId = Technique2D | 'amigurumi_sc';

/** One stitch cell: `w` = width of one stitch, `h` = height of one row or round (§0.1). */
export interface Cell {
  w: Inches;
  h: Inches;
}

export interface GaugeSpec {
  cyc: Cyc;
  technique: TechniqueId;
  /** undefined ⇒ the Table A hook (Table E for amigurumi). */
  hookMm?: number;
  swatch?: { sts: number; rows: number; spanIn: Inches };
  c2cSwatch?: { tiles: number; spanIn: Inches };
  testBall?: { maxSts: number; circumferenceIn: Inches };
  carried?: number;
  yarnUnder?: boolean;
  lscCalibratedIn?: number;
}

export interface ResolvedGauge {
  cell: Cell;
  wSc: Inches;
  /** sc row height (border rounds, §2.7.10). */
  hSc: Inches;
  lscIn: number;
  hookMm: number;
  stretch: number;
  tol: number;
  source: 'default' | 'swatch';
  /** True when `GaugeSpec.lscCalibratedIn` set `lscIn` (§2.8: yardage band ±5%). */
  lscCalibrated?: boolean;
}
