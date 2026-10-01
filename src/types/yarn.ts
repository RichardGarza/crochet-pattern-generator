// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { Cyc } from './units';

export interface Yarn {
  id: string;
  lineId: string;
  brand: string;
  line: string;
  name: string;
  number?: string;
  /** sRGB `#rrggbb`. */
  hex: string;
  cyc?: Cyc;
  skeinYards?: number;
  skeinGrams?: number;
  ydPer100g?: number;
  textured?: boolean;
  owned?: number;
}

/** `source` and `license` are the provenance record every shipped line must carry (§5.6 "Yarn data"). */
export interface YarnLine {
  id: string;
  brand: string;
  line: string;
  cyc: Cyc;
  source: string;
  license: string;
  yarns: Yarn[];
}
