// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).

/** Lengths are inches internally (§0.1). The UI shows in or cm (1 in = 2.54 cm). */
export type Inches = number;
/** Craft Yarn Council weight: 0 Lace … 7 Jumbo (§2.2.1). */
export type Cyc = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Right-handed is the default; left-handed mirrors the reading order, never the chart (§0.1). */
export type Hand = 'right' | 'left';
/** US terms in the model; UK is rendered only through a terminology table (§0.1). */
export type Terms = 'us' | 'uk';
export type UnitPref = 'in' | 'cm';
