# Step 0b — gauge and sizing kernels (`src/core/gauge`)

Part of Step 0b of `DESIGN.md` §6.2 (branch `s0b/gauge`, made from the Step 0a commit `ca1a96f`). Scope: §2.2 (all),
§2.3.3, the border allowance of §2.7.10 and the gauge-level parts of §2.8. Everything here is pure TypeScript with
no DOM; it imports only `src/types` and its own files, and uses no `Math.random` or `Date` (a test enforces this).

## What was delivered

| File | Contents |
|---|---|
| `tables.ts` | Table A (base flat sc gauge), the CYC weight names and ranges, the hook mm → US table, the hook-scaling rule, Table B (technique transforms and aspects, each with its band), Table E (amigurumi), stuffing stretch, unit helpers |
| `resolve.ts` | `resolveGauge` (§2.2.5), `checkGauge` (input errors and the sanity warnings), defaults without resolving, size bands, the stuffing stretch of a piece, swatch helpers, the yardage band of a spec |
| `grid.ts` | `grid` (§2.3.3) with border rounds (§2.7.10), snapping constraints and the 1000-cell cap; `chartSize`, `gridIssues`, `snap`, `borderRounds` |
| `sphere.ts` | `sphereSizing` (§2.2.6) and `sphereDiameterIn` |
| `yarnPerStitch.ts` | The Table D model (`L_sc`, `L_ami`, stitch multipliers, C2C tile), carried strands, tails, the fixed extras of §2.8 and §2.7.10, buffer, band, skeins, grams, the 10-stitch calibration |
| `round.ts` | The rounding rule the other modules share (not named in §5.1; deviation 1) |
| `checks.ts` | Small internal checks (the barrel does not export them) |
| `index.ts` | Barrel: `import { resolveGauge, grid, … } from '…/core/gauge'` |
| `__tests__/` | 7 test files (366 tests) and `labels.ts` (the 113 label gauges of research 01 Appendix A, checked row by row against the appendix). Printed table values are typed into the tests from the spec and research 01, never read back from the implementation. |

The yardage **totals** (per color, per chart, per toy) are not here. They belong to `core/yardage/twoD.ts` (T2) and
`core/yardage/threeD.ts` (T4), which build them from the blocks below.

## Acceptance (brief items, measured)

| Item | Result | Measured |
|---|---|---|
| G2 grid sizing | pass | worsted 40 × 50 in, image 1200 × 1500 → 135 × 200 (also from the width alone or the height alone); with a 1 in border (`roundH` = `hSc` = 0.25) → 4 rounds, 128 × 192, finished 39.926 × 50.0 in ("39.9 × 50.0"), `aspectErr` 0.0125, no grid warning |
| G3 sphere sizing | pass | D = 2.35 in worsted → k 6, N_max 36, p 7, 18 rounds, 468 sts, D_actual 2.34626 in; 42 sts → 2.73731 in |
| G11, Table D part | pass | all 39 cells within ±0.01 of print, largest residue 0.005 (three cells sit exactly half a unit from print: 1.625, 9.425, 0.845); C2C tile 14.9452 in ("14.95"); `L_sc` 1.925926; the 61.9 yd example rebuilt from the blocks and checked by hand in the test: (1925.926 + 12) / 36 × 1.15 = 61.906 yd, band 46.43–77.38 yd, 1 skein of 364 yd. Also reachable: the 36-st sphere 22.796 yd (18.24–27.36) and G16's border 4 826.2 in = 134.06 yd |
| Every table of §2.2.1–2.2.4 | pass | one pinning test per table: Table A (8 rows, every column incl. names, hooks, tol, yd/100 g), CYC ranges, the 19 hook labels and the sizes without a letter, Table B (aspects, constants, bands), Table E (7 rows), Table D (8 rows × 5 columns); research 01 Table C (cells for every weight × technique) and the §5.4 sphere table (60 diameters) reproduced as well |
| `resolveGauge` | pass | defaults for 8 weights × 6 2D techniques and 7 weights of amigurumi; each measurement (swatch over any span incl. 10 cm, a W × H swatch, C2C tiles, a test ball, the calibrated yarn) overrides the defaults; `hSc` and `L_ami` checked against hand values for every weight; `tol` 0.04 measured vs the Table A tolerance by default; 41 kinds of invalid spec rejected with a `RangeError` and listed by `checkGauge`; the sanity warnings of §2.2.5 tested on the 113 label gauges |
| Grid | pass | axes independent (worsted tapestry 20 × 20 in → 68 × 59; sc → 68 × 80); `actualW = cols·w + 2B`, `actualH = rows·h + 2B` exactly; constraints (12n + 3, even rows, multiples of 6) hold on random input; `aspectErr` reported, `W_GRID_ASPECT` above 2.5%; size 0 → smallest chart + `W_GRID_NO_ROOM`; too large → capped at 1000 + `W_GRID_CAPPED`; no size or a non-finite size → `RangeError` with a message |
| Properties | pass | a larger size never gives fewer columns or rows (one size, both sizes, across the cap, with constraints and borders); count → diameter → count exact for k = 2…80; diameter → count → diameter within half a step of 6 (2000 random balls); a larger diameter never gives fewer stitches or rounds |

Checks at the final commit (Node 22.23.3): `npm run typecheck` and `npm run lint` pass; `npm test` passed twice in a
row: 27 files, 656 tests (the gauge kernel: 366 tests in 7 files — `resolve` 133, `tables` 57, `grid` 45,
`sphere` 40, `yarnPerStitch` 40, `checkGauge` 38, `round` 13). The whole kernel runs in about 2 s; the ten random
sweeps (40 ms to 0.5 s each) carry an explicit 30 s timeout (`SWEEP_TIMEOUT_MS`), so a loaded machine cannot turn
them into timeouts. No test asserts a duration.

## Public API

Import from `src/core/gauge` (the barrel). `Cell`, `GaugeSpec`, `ResolvedGauge`, `TechniqueId`, `Technique2D`
(`types/gauge.ts`), `Cyc`, `Inches` (`types/units.ts`), `Issue` (`types/issues.ts`) and `ChartResult`
(`types/chart.ts`) are the frozen types. Every function throws a `RangeError` whose message says what is wrong (and
usually the value it got) when an argument is not usable — never a `TypeError`, never a NaN result; the exceptions
are noted.

### Resolving a gauge (`resolve.ts`)

| Export | What it does |
|---|---|
| `resolveGauge(g: GaugeSpec): ResolvedGauge` | §2.2.5. A measurement wins, else the tables (table below). Throws on exactly the specs `checkGauge` reports as `E_GAUGE_INPUT`. Every number returned is finite and above zero. |
| `checkGauge(g: GaugeSpec): GaugeIssue[]` | Never throws. `E_GAUGE_INPUT` for exactly what `resolveGauge` rejects (then only errors are returned), else the warnings below, in the order range, aspect, rows, hook, carried, calibration. |
| `resolveGaugeChecked(g: GaugeSpec): { gauge: ResolvedGauge \| undefined; issues: GaugeIssue[] }` | Both in one call, for forms; `gauge` is undefined when an issue is an error. Never throws. |
| `interface GaugeIssue extends Issue { code: GaugeIssueCode; field: keyof GaugeSpec; hint?: GaugeHint }` | A finding, the `GaugeSpec` field it is about and, when exactly one cause explains it, that cause. Severity `'error'` for `E_*`, `'warn'` for `W_*`. |
| `type GaugeIssueCode = 'E_GAUGE_INPUT' \| 'W_GAUGE_RANGE' \| 'W_GAUGE_ASPECT' \| 'W_GAUGE_ROWS' \| 'W_GAUGE_HOOK' \| 'W_GAUGE_CARRIED' \| 'W_GAUGE_LSC'` | The codes (request 2). |
| `type GaugeHint = 'cm-as-inches' \| 'inches-as-cm' \| 'diameter-as-circumference' \| 'half-circumference' \| 'per-2-in' \| 'stitches-not-tiles' \| 'taller-stitch' \| 'other-technique' \| 'tapestry-or-novelty' \| 'ten-stitches' \| 'whole-tile'` | The fix to offer: divide the entered length by 2.54 / multiply it by 2.54 / multiply the circumference by π / double it / a gauge stated per 2 in was typed over 4 in (enter 2 in) / a C2C swatch was counted in stitches, not tiles / a taller stitch than sc was measured or unravelled (hdc or dc, e.g. a UK pattern's "dc" worked as US dc) / the swatch is of another stitch / carried strands, a novelty yarn or hdc / divide the yarn length by the stitch count / a whole C2C tile was entered as one sc. |
| `defaultHookMm(cyc: Cyc, technique: TechniqueId): number` | Table A hook, or the Table E hook for amigurumi (throws for CYC 0 with amigurumi). |
| `defaultCell(cyc: Cyc, technique: TechniqueId, o?: { hookMm?: number; carried?: number; yarnUnder?: boolean }): Cell` | The table cell without any measurement (§2.2.5 step 2), e.g. for "difference from the default" displays. `carried` is read for tapestry only, `yarnUnder` for amigurumi only. |
| `type GaugeMeasurement = 'swatch' \| 'c2cSwatch' \| 'testBall'` | The three measurement fields of `GaugeSpec`. |
| `measurementField(technique: TechniqueId): GaugeMeasurement` | The field that holds the measured gauge of a technique: row techniques `swatch`, `c2c` `c2cSwatch`, `amigurumi_sc` `testBall`. |
| `measurementOf(g: GaugeSpec): GaugeMeasurement \| undefined` | The measurement `resolveGauge` will use, or undefined when it will use the tables (also for a spec without a known technique). Never throws. |
| `aspectWindow(technique: TechniqueId): [number, number]` | The `w/h` a swatch of a row technique may have before `W_GAUGE_ASPECT`: sc 0.75–1.5, tapestry 0.559–1.119, hdc 0.528–1.055, mosaic 0.826–1.653. Throws for `c2c` and `amigurumi_sc`. |
| `sizeBand(nominalIn: Inches, tol: number): { low: Inches; high: Inches }` | `nominal × (1 ± tol)` (§2.2.5); pass `ResolvedGauge.tol`. |
| `hookSizeRange(nominalIn: Inches, hookMm: number, refHookMm: number): { low: Inches; high: Inches }` | The size range of a hook override for p = 0.5 … 1.0 around the p = 0.75 nominal (§2.2.2); `refHookMm` = `defaultHookMm(…)`. Collapses to the nominal at the reference hook. |
| `stuffingStretch(g: Pick<ResolvedGauge, 'stretch'>, stuffing: Stuffing): number` | `s` of a piece: `g.stretch` for firm or medium, 1 for light or none. Throws on any other stuffing value (a missing one must not size a piece as unstuffed). |
| `stuffedCell(g: Pick<ResolvedGauge, 'cell' \| 'stretch'>, stuffing: Stuffing): { wS: Inches; hS: Inches }` | `wS = w·s`, `hS = h·s` of §2.10.5 (stretch is isotropic). |
| `countsPer4In(cell: Cell): { sts4: number; rows4: number }` | The gauge as it is stated: `4 / w`, `4 / h` (tiles per 4 in for C2C). |
| `swatchFromSize(o: { sts: number; rows: number; widthIn: Inches; heightIn: Inches }): NonNullable<GaugeSpec['swatch']>` | "S × R stitches measure W × H" (research 01 §7 mode b) restated for the one-span `GaugeSpec.swatch`: `{ sts, rows: rows · W / H, spanIn: W }`. |
| `yardageBandFor(g: GaugeSpec): number` | The §2.8 band of a spec: 0.05 calibrated, 0.10 with the technique's measurement, else 0.25 (2D) or 0.20 (amigurumi). Throws on a spec `resolveGauge` rejects. |
| `HOOK_LIMITS_MM = [0.1, 100]`, `STITCH_LIMITS_IN = [0.001, 100]`, `LSC_LIMITS_IN = [0.001, 1000]`, `CARRIED_LIMIT = 100` | Outside these a spec is rejected (they keep every returned number finite and positive). |
| `HOOK_USUAL_RATIO = [0.5, 2]`, `CARRIED_USUAL_MAX = 3`, `SC_ASPECT_RANGE = [0.75, 1.5]`, `LSC_SLACK = 0.35` | Thresholds of `W_GAUGE_HOOK`, `W_GAUGE_CARRIED`, `W_GAUGE_ASPECT` (flat sc) and `W_GAUGE_LSC`. |

What `resolveGauge` returns, case by case:

| Case | `cell` | `wSc`, `hSc` | `lscIn` | `stretch` | `tol` | `source` |
|---|---|---|---|---|---|---|
| 2D, no measurement | Table A × hook factor → Table B | Table A × hook factor | `6.5 · wSc` | 1 | Table A | `default` |
| row technique + `swatch` | `span/sts × span/rows` | the measured cell for `sc_graphgan`; Table A × hook factor for the others | `6.5 · wSc` | 1 | 0.04 | `swatch` |
| `c2c` + `c2cSwatch` | square tile `span/tiles` | Table A × hook factor | `6.5 · wSc` | 1 | 0.04 | `swatch` |
| amigurumi, no test ball | Table E × hook factor, `h = w/1.05` (`/1.11` yarn under) | Table A × (hook / Table A hook)^0.75 | `L_ami = 6.5 · max(wSc, w_ami)` | 1.05 | Table A | `default` |
| amigurumi + `testBall` | `w = C/N`, `h = w/1.05` (`/1.11`) | as above | as above (the test ball does not change it) | 1 | 0.04 | `swatch` |
| any + `lscCalibratedIn` | unchanged | unchanged | the calibrated value | unchanged | unchanged | unchanged |

`hookMm` is `g.hookMm` or the default hook. The hook factor is `(hook / reference hook)^0.75`; the reference is the
Table A hook for `wSc`/`hSc` and every 2D cell, and the Table E hook for the amigurumi cell. A measured cell is never
hook-scaled, and a swatch ignores `carried` (it was made with the strands carried).

**Invalid input** (`RangeError` from `resolveGauge`, `E_GAUGE_INPUT` from `checkGauge`): a weight that is not an
integer 0–7 given as a number; an unknown technique; CYC 0 with amigurumi; a hook outside 0.1–100 mm; for amigurumi,
a `yarnUnder` that is not a boolean; the technique's own measurement without positive finite numbers, or giving a stitch (or tile,
or test-ball stitch and its round height) outside 0.001–100 in; for tapestry without a swatch, `carried` outside
0–100; a calibrated yarn outside 0.001–1000 in. Fields the technique does not read are not checked (a leftover C2C
swatch in an sc project is ignored, and so is a `yarnUnder` that is not a boolean in a 2D project: only amigurumi
reads it). `null` is read as "not set" (a spec read back from JSON).

**Warnings** (`checkGauge`):

| Code | When | `hint` |
|---|---|---|
| `W_GAUGE_RANGE` | A count per 4 in of the measurement in use (stitches, rows, tiles, test-ball stitches) more than 35% outside the CYC range carried to that count, or a count inside that range that a cm/inch slip explains clearly better than the yarn does. | the slip, when one fits clearly better (by more than 15%) than every other candidate. Candidates: swatch `cm-as-inches`, `inches-as-cm`, `per-2-in`; C2C swatch the same and `stitches-not-tiles`; test ball `cm-as-inches`, `inches-as-cm`, `diameter-as-circumference`, `half-circumference`. Only the cm/inch slips raise the warning by themselves (inside the accepted range); the others only explain a count that is already off, or compete for the hint. `stitches-not-tiles` (÷ 2.6) and `inches-as-cm` (÷ 2.54) always tie, so a C2C swatch counted in stitches, or converted as centimetres, gets the generic advice, which names both. |
| `W_GAUGE_ASPECT` | A swatch whose `w/h` is outside 0.75–1.5 (flat sc) or outside the technique's own window (tapestry, hdc, mosaic). | `taller-stitch` (sc, too tall), `other-technique` |
| `W_GAUGE_ROWS` | An `sc_graphgan` swatch with fewer rows than stitches. | `tapestry-or-novelty` |
| `W_GAUGE_HOOK` | A hook more than 2× or less than ½ the default hook of the weight and technique. | — |
| `W_GAUGE_CARRIED` | Tapestry without a swatch and more than 3 carried strands. | — |
| `W_GAUGE_LSC` | A calibrated yarn per stitch more than 35% from the model. | `cm-as-inches`, `inches-as-cm`, `ten-stitches`; for C2C also `taller-stitch` and `whole-tile`, for hdc `taller-stitch` |

Checked against the 113 published label gauges of research 01 Appendix A (`__tests__/labels.ts`): entered with
their hook, none raises a range, aspect or hook warning (one novelty yarn, Cover Story 300g, has fewer rows than
stitches); entered without the hook, only the two 2-stitch Jumbo yarns worked on 25 mm hooks are questioned;
measured over 10 cm and typed as 10 in, all 113 are flagged — with the hook 66 named `cm-as-inches`, 45 without a
hint, 2 tight yarns named `per-2-in` (without the hook 86 / 23 / 4); measured over 4 in and converted as
centimetres, 111 are flagged (2 sts × 2.54 is an ordinary Jumbo gauge), 109 with `inches-as-cm`. Stated per 2 in
and typed over 4 in, with the hook 58 are named `per-2-in`, 25 get no hint, 5 loose yarns are named `cm-as-inches`
and 25 tight ones stay inside the accepted range (without the hook 70 / 21 / 8 / 14). The factors 2 and 2.54 are
24% apart and label gauges spread about as much around Table A, so the hint is named only where the yarn's gauge is
close enough to the table to tell the two apart; before `per-2-in` was a candidate, 84 of the halved gauges were
named `cm-as-inches`. A plain sc
swatch left over in a tapestry project is caught for 72 of the 113, in an hdc project for 101, in a mosaic project
for none.

### Tables (`tables.ts`)

| Export | What it is |
|---|---|
| `TABLE_A: Readonly<Record<Cyc, Readonly<TableARow>>>`, `interface TableARow { name: string; hookMm: number; sts4: number; rows4: number; tol: number; ydPer100g: number }` | §2.2.1, frozen: the CYC name as printed ("Medium (worsted)"), default hook, sc per 4 in, rows per 4 in, the 1σ-ish size tolerance, fallback yards per 100 g. `w = 4/sts4`, `h = 4/rows4`. |
| `CYCS: readonly Cyc[]` | `[0 … 7]`. |
| `CYC_RANGE: Readonly<Record<Cyc, Readonly<CycRange>>>`, `interface CycRange { lo?: number; hi: number; stitch: 'sc' \| 'dc' }` | The published CYC gauge ranges per 4 in (Jumbo has no `lo`; Lace is in dc). Used only for the sanity warnings. |
| `RANGE_SLACK = 0.35` | The ±35% of §2.2.5. |
| `HOOK_LABELS: readonly Readonly<HookLabel>[]`, `interface HookLabel { mm: number; us: string }` | The 19 labelled sizes of §2.2.1, ascending. |
| `HOOK_SIZES_MM: readonly number[]` | The labelled sizes plus 2.0 and 2.5 mm: every size §2.2.1 names (a hook picker's list; any size in mm is valid input). |
| `hookUsLabel(mm: number): string \| undefined` | `'H-8'` for 5; undefined for a size without a letter (2.0, 2.5, 7 mm, NaN). Never throws. |
| `HOOK_EXPONENT = 0.75`, `HOOK_EXPONENT_RANGE = [0.5, 1.0]` | §2.2.2 and its ±0.25 band. |
| `hookFactor(hookMm: number, refHookMm: number, p?: number): number` | `(hook / ref)^p`, p defaults to 0.75; exactly 1 at the reference hook. |
| `scCell(cyc: Cyc, hookMm?: number): Cell` | The Table A cell × hook factor: `w_sc(CYC, hook)` of §2.2.4. |
| `TABLE_B: Readonly<Record<TechniqueId, Readonly<TableBRow>>>`, `interface TableBRow { aspect: number; constant: { name: 'aspect' \| 'heightMult' \| 'tileMult'; value: number; lo: number; hi: number }; note: string }` | §2.2.2: the printed aspect of each technique and the constant its formula uses with that constant's observed band (sc 1.10–1.25, tapestry 0.84–1.0, hdc height ×1.45–1.65, C2C tile 2.0–2.9 × w, mosaic 1.0–1.5, amigurumi 0.82–1.11). |
| `TAPESTRY_ASPECT = 0.88`, `TAPESTRY_EXTRA_PER_STRAND = 0.05`, `HDC_WIDTH_MULT = 1.05`, `HDC_HEIGHT_MULT = 1.5`, `C2C_TILE_WIDTH_MULT = 2.6`, `MOSAIC_ASPECT = 1.3` | The constants of Table B. |
| `techniqueCell(sc: Cell, technique: Technique2D, carried?: number): Cell` | Table B: the cell of a 2D technique from the sc cell of the same yarn and hook; `carried` (default 1) for tapestry only. |
| `TABLE_E: Readonly<Record<AmiCyc, Readonly<TableERow>>>`, `interface TableERow { hookMm: number; wIn: Inches }`, `type AmiCyc = Exclude<Cyc, 0>`, `AMI_CYCS: readonly AmiCyc[]` | §2.2.3, frozen: amigurumi hook and stitch width before stuffing, CYC 1–7. |
| `AMI_ASPECT = { yarnOver: 1.05, yarnUnder: 1.11 }` | `h = w / aspect` (D17). |
| `type Stuffing = 'firm' \| 'medium' \| 'light' \| 'none'`, `STUFFING_STRETCH: Readonly<Record<Stuffing, number>>` | `{ firm: 1.05, medium: 1.05, light: 1, none: 1 }` (§2.2.3). |
| `amiHookMm(cyc: Cyc): number` | Table E hook; throws for CYC 0. |
| `amiCell(cyc: Cyc, o?: { hookMm?: number; yarnUnder?: boolean }): Cell` | Table E cell × hook factor, before stuffing: `w_ami(CYC, hook)`. Throws for CYC 0. |
| `SWATCH_TOL = 0.04` | `tol` once the gauge is measured. |
| `CM_PER_IN = 2.54`, `GAUGE_SPAN_IN = 4`, `inToCm(inches: Inches): number`, `cmToIn(cm: number): Inches` | Units (§0.1). The two converters do not validate. |

### Grid (`grid.ts`)

| Export | What it does |
|---|---|
| `grid(c: Cell, req: GridRequest): GridSize` | §2.3.3: finished size → chart size. `c` = `ResolvedGauge.cell` (C2C: the tile). |
| `interface GridRequest { wIn?: Inches; hIn?: Inches; imgW: number; imgH: number; border?: { widthIn: Inches; roundH: Inches }; colsMult?: Mult; rowsMult?: Mult }` | As §2.3.3. Sizes include the border; `wIn` is the circumference for tapestry in the round; `imgW × imgH` = the image after the crop (only the ratio matters); `roundH` = `ResolvedGauge.hSc`; omit `border` for `sc_tapestry_round`. `null` fields read as missing. |
| `interface Mult { m: number; plus: number }` | Counts of the form `m·n + plus` (integers, m ≥ 1, plus ≥ 0): mosaic `{ m: 12, plus: 3 }`, even rows `{ m: 2, plus: 0 }`, multiples of 6 `{ m: 6, plus: 0 }`. |
| `type GridSize = ChartResult['size']` | `{ cols, rows, borderRounds, actualW, actualH, aspectErr }`; `actualW = cols·w + 2B`, `actualH = rows·h + 2B` (B = rounds × roundH), `aspectErr = (rows·h / cols·w) / (imgH / imgW) − 1`. |
| `chartSize(c: Cell, cols: number, rows: number, o: { imgW: number; imgH: number; border?: { widthIn: Inches; roundH: Inches } }): GridSize` | The finished size and aspect error of counts that are already known (the "±1 row" offers, an edited or imported chart); equals `grid`'s result for `grid`'s counts. |
| `gridIssues(c: Cell, req: GridRequest): GridIssue[]` | The warnings of the same request (table below); throws where `grid` throws. |
| `type GridIssueCode = 'W_GRID_NO_ROOM' \| 'W_GRID_CAPPED' \| 'W_GRID_LARGE' \| 'W_GRID_PROPORTIONS' \| 'W_GRID_ASPECT'`, `interface GridIssue extends Issue { code: GridIssueCode }` | All severity `'warn'` (request 2). |
| `snap(x: number, k?: Mult): number` | The nearest count, ties up (`roundHalfUp`); with `k` the nearest `m·n + plus`; never 0. Throws for a non-finite `x` or a broken `k`. |
| `borderRounds(widthIn: Inches, roundH: Inches): number` | §2.7.10: `max(1, round(widthIn / hSc))`, 0 when `widthIn` ≤ 0 (then `roundH` is not read). The border writer should call this so chart and border agree (request 4). |
| `GRID_WARN_CELLS = 300`, `GRID_MAX_CELLS = 1000`, `ASPECT_ERR_OFFER = 0.025` | §2.3.3 limits. |

`grid` throws when it cannot answer: no width and no height, a non-finite size, a cell or image without positive
sides, a broken `Mult` or one that allows no count from 1 to 1000, a border with a positive width and no positive
round height, or a size whose arithmetic overflows.

| Grid warning | When | What the UI offers |
|---|---|---|
| `W_GRID_NO_ROOM` | the size is 0 or less, or the border is as wide as the piece: the smallest chart is used | a larger size or a narrower border |
| `W_GRID_CAPPED` | more than 1000 cells on a side were needed | a smaller size or a thicker yarn |
| `W_GRID_LARGE` | more than 300 cells on a side | — |
| `W_GRID_PROPORTIONS` | both sizes were given and, inside the border, differ from the picture's proportions by more than 2.5% (after a cap: the chart that is left) | crop to fit, or pad (§2.3.3 "crop must match") |
| `W_GRID_ASPECT` | otherwise `\|aspectErr\| > 0.025`, from rounding to whole cells | ±1 row or column (`chartSize` gives the alternatives' sizes) |

### Sphere (`sphere.ts`)

| Export | What it does |
|---|---|
| `sphereSizing(dIn: Inches, cell: Cell, stretch: number): SphereSizing` | §2.2.6: `k = max(2, round(π·D / (6·wS)))`, `p = max(0, round(3k·w/h) − 2k)`. `cell` = the amigurumi cell before stuffing (`ResolvedGauge.cell`), `stretch` = `s` (`ResolvedGauge.stretch` for a firm ball, `stuffingStretch(…)` otherwise). The stretch is required: leaving it out would size a stuffed ball 5% large. |
| `interface SphereSizing { k: number; nMax: number; plainRounds: number; rounds: number; stitches: number; dActualIn: Inches }` | `nMax = 6k`, `plainRounds = p`, `rounds = 2k − 1 + p`, `stitches = 6k² + 6kp`, `dActualIn = 6k·wS/π`. |
| `sphereDiameterIn(nMax: number, wS: Inches): Inches` | `N · wS / π` with `wS = w·s` the stuffed width; `nMax` need not be a multiple of 6. |
| `SPHERE_MIN_K = 2` | The smallest ball returned (12 stitches around). |

### Yarn per stitch (`yarnPerStitch.ts`)

| Export | What it does |
|---|---|
| `K_SC = 6.5`, `MULT = { sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 }`, `type StitchKind = 'sc' \| 'hdc' \| 'dc' \| 'ch' \| 'slst'` | §2.2.4. |
| `C2C_TILE_YARN_MULT` (= 7.76) | `3·dc + 3·ch + slst`. |
| `YARN_PER_STITCH_TOL = { sc: 0.15, hdc: 0.15, dc: 0.15, c2cTile: 0.35, amigurumi: 0.2 }` | The bands of Table D. |
| `lSc(wScIn: Inches, lscCalibratedIn?: number): number` | `L_sc = lscCalibratedIn ?? 6.5 · wSc`. |
| `lAmi(cyc: Cyc, hookMm?: number, lscCalibratedIn?: number): number` | `L_ami = lscCalibratedIn ?? 6.5 · max(w_sc(CYC, hook), w_ami(CYC, hook))`; the hook defaults to Table E's. Throws for CYC 0, also with a calibrated value. |
| `stitchYarnIn(lscIn: number, kind: StitchKind): number` | `MULT[kind] · lscIn` (chains, sl sts, a mosaic X = dc). |
| `c2cTileYarnIn(lscIn: number): number` | `7.76 · lscIn`. |
| `TAPESTRY_WORKED_MULT = 1.1` | A worked tapestry stitch uses `1.1 · L_sc`. |
| `yarnPerCellIn(technique: Technique2D, lscIn: number): number` | §2.8 `worked_c` per chart cell: sc graphgan and mosaic `L`, tapestry `1.1 L`, hdc `1.45 L`, C2C `7.76 L` per tile. |
| `yarnPerStitchDefaults(cyc: Cyc): YarnPerStitchRow`, `interface YarnPerStitchRow { sc: number; hdc: number; dc: number; c2cTile: number; amigurumi?: number }` | One row of Table D computed from the formulas at the table's hooks (`amigurumi` undefined for CYC 0). |
| `CARRIED_PER_WIDTH = 1.1`, `carriedYarnIn(cells: number, wCellIn: Inches): number` | Carried strands, short carries and floats: `cells · 1.1 · w`. |
| `TAIL_IN = 6`, `tailsIn(starts: number): number` | `starts · 2 · 6 in`. |
| `JOINED_ROUND_YARN_MULT` (= 0.92), `DEC_EXTRA_YARN_MULT = 0.2`, `MAGIC_RING_IN = 3`, `EMBROIDERY_IN = { eyePair: 24, feature: 12 }` | The fixed extras of §2.8 and §2.7.10: a joined round's ch 1 + sl st, a decrease's extra yarn, a magic ring, embroidery. |
| `YARDAGE_BUFFER = { singleColor: 0.1, standard: 0.15, complex: 0.2 }`, `MANY_STRANDS = 50`, `yardageBuffer(o: { technique: TechniqueId; colors: number; strands?: number }): number` | §2.8 buffer: amigurumi 0.15; C2C, tapestry or > 50 strands 0.20; otherwise one color 0.10, else 0.15. |
| `YARDAGE_BAND = { default2d: 0.25, default3d: 0.2, measured: 0.1, calibrated: 0.05 }`, `yardageBand(o: { technique: TechniqueId; source: 'default' \| 'swatch'; calibrated?: boolean }): number` | §2.8 band from a resolved gauge's `source` (see request 1 for ±5%). |
| `inchesToYards(inches: number, buffer?: number): number` | `inches / 36 × (1 + buffer)`, buffer default 0. |
| `yardRange(yards: number, band: number): { low: number; high: number }` | `yards × (1 ∓ band)`. |
| `skeinsToBuy(yardsHigh: number, skeinYards: number): number` | `ceil(yardsHigh / skeinYards)` (`ceilTolerant`): pass the high end of the band (D9). |
| `gramsFor(yards: number, ydPer100g: number): number` | `yards / ydPer100g × 100`; without ball-band data use `TABLE_A[cyc].ydPer100g`. |
| `yardsToMeters(yards: number): number` | `yards × 0.9144` (does not validate). |
| `CALIBRATION_STITCHES = 10`, `lscFromUnravel(lengthIn: Inches, count?: number, unit?: StitchKind \| 'c2cTile'): number` | `GaugeSpec.lscCalibratedIn` from "unravel 10 stitches: __ in" = `length / count / multiplier` (`MULT[unit]`, or 7.76 for `'c2cTile'`); `count` defaults to 10, `unit` to `'sc'` and says what was unravelled when it is not sc (an hdc or C2C swatch has no sc; deviation 9). |
| `IN_PER_YD = 36`, `M_PER_YD = 0.9144` | |

### Rounding (`round.ts`)

| Export | What it does |
|---|---|
| `roundHalfUp(x: number): number` | `Math.round`'s rule (ties up), with a tie decided as in exact arithmetic (deviation 1); never −0; NaN and ±∞ pass through. |
| `ceilTolerant(x: number): number` | `Math.ceil` that does not count a few ulps above a whole number (2.0000000000000004 skeins is 2). |

## How the other tracks use it

- **T1 (chart sizing).** `ChartResult.size = grid(gauge.cell, { wIn: settings.widthIn, hIn: settings.heightIn, imgW,
  imgH, border: technique === 'sc_tapestry_round' ? undefined : { widthIn: settings.border.widthIn, roundH:
  gauge.hSc }, colsMult, rowsMult })`; push `gridIssues(…)` with the same arguments into `ChartResult.issues`. `grid`
  throws when neither size is set, so choose the default size before calling it. With `lockAspect` on, pass one size
  (with both, each axis is sized from its own number).
- **T2 (border, yardage, materials).** Border rounds: `borderRounds(settings.border.widthIn, gauge.hSc)` — the call
  `grid` makes, so chart and border cannot disagree. Per color: `inchesToYards(cells · yarnPerCellIn(technique,
  gauge.lscIn) + carriedYarnIn(carriedCells, gauge.cell.w) + tailsIn(starts) + extra, yardageBuffer({ technique,
  colors, strands }))`, then `yardRange(yards, yardageBand({ technique, source: gauge.source }))` and
  `skeinsToBuy(range.high, yarn.skeinYards)`. Chains and sl sts: `stitchYarnIn(gauge.lscIn, 'ch' | 'slst')`; a
  mosaic X: `stitchYarnIn(gauge.lscIn, 'dc')`. Border yarn: stitches × `gauge.lscIn` + rounds ×
  `JOINED_ROUND_YARN_MULT · gauge.lscIn` + `tailsIn(1)` (G16 is rebuilt this way in the tests). Hook label:
  `hookUsLabel(gauge.hookMm)`. Gauge line: `countsPer4In(gauge.cell)`. Finished size band: `sizeBand(size.actualW,
  gauge.tol)`. Round counts with `roundHalfUp` (request 4).
- **T4 (amigurumi).** `const { wS, hS } = stuffedCell(gauge, piece.stuffing)` is the `wS`, `hS` of §2.10.5 — use it
  (or `stuffingStretch`) rather than a literal 1.05: with a test ball the stretch is already in `cell.w` and
  `gauge.stretch` is 1. Yarn: `gauge.lscIn` is already `L_ami`; decreases `DEC_EXTRA_YARN_MULT`, magic ring
  `MAGIC_RING_IN`, chains `stitchYarnIn(gauge.lscIn, 'ch')`, joined rounds `JOINED_ROUND_YARN_MULT`, floats
  `carriedYarnIn(n, gauge.cell.w)`, tails `TAIL_IN`, embroidery `EMBROIDERY_IN`, buffer `yardageBuffer({ technique:
  'amigurumi_sc', colors })` (G11's 36-st sphere is rebuilt this way in the tests).
- **T6 (Yarn & size panel) and T2 (gauge form).** Validate with `checkGauge` (or `resolveGaugeChecked`) before
  writing `ProjectDoc.gauge`: `resolveGauge` throws on an invalid spec. Field defaults: `defaultHookMm`,
  `HOOK_SIZES_MM`, `AMI_CYCS`, `TABLE_A[cyc].name`. "Unravel 10 sc: __ in" → `lscFromUnravel(length)`. When the
  **yarn weight** changes, clear `hookMm`, the measurements and `lscCalibratedIn` (they belong to the old yarn;
  request 7); when the **technique** changes between row techniques, clear `swatch` or swap the stored gauge
  profile — `checkGauge` catches a leftover swatch only when the stitch proportions give it away.
- **T7 (prompt).** `STS_PER_IN = 1 / gauge.cell.w` (§3.4: "1/w from Table E or the test ball").

## Deviations from the spec, with reasons

1. **Rounding ties (`round.ts`, used by `snap`, `borderRounds`, `sphereSizing`).** The normative code says
   `Math.round`. A count is a quotient of decimal inputs, and a quotient that is a tie on paper can come out a few
   ulps short in binary, which `Math.round` then rounds down. Measured against exact rational arithmetic on every
   Table A weight × the 7 Table B cell sides × sizes in ¼ in up to 120 in and ½ cm up to 300 cm: `Math.round` gets
   18 of the 60 480 counts wrong, all exact ties (35 in of super bulky hdc is 62.5 stitches on paper,
   62.49999999999999 in a double, 62 with `Math.round`; 39 in of lace C2C is 127.5 tiles); `roundHalfUp` gets all
   60 480 right. `roundHalfUp(x) = floor(x + 0.5 + ε)`, ε = 1e-12 relative and at most 1e-6, is `Math.round` for
   every other value (checked against `Math.round` on 40 000 random values up to 3·10^15). In the sphere formula
   `3k·(w/h)` is a tie for w/h = 1.15 at k = 30 and comes out 103.49999999999999.
2. **`snap` never returns 0.** The normative `snap` gives 0 for `{ m, plus: 0 }` when x < m/2 (a size of 0 with
   "even rows" would be a chart with no rows; `E_SANITY` requires integers ≥ 1). The smallest count of the
   constraint (`m`) is returned instead.
3. **Hard cap.** §2.3.3 says "hard cap 1000" without saying how. With one size given (the other follows the
   picture), a request above the cap returns the largest chart of the picture's proportions that fits: the axis
   that binds gets its largest allowed count and the other axis is scaled by the same factor, so a growing request
   never loses a stitch on the way to the cap. With both sizes given each axis is cut at its own cap (each follows
   its own number; `gridIssues` then reports any distortion as `W_GRID_PROPORTIONS`). With a constraint the cap is
   the largest `m·n + plus` ≤ 1000; a constraint that allows no count from 1 to 1000 throws. Below the cap the
   result is the normative formula.
4. **`grid` rejects what it cannot answer** (the normative code would return NaN): neither `wIn` nor `hIn`, a
   non-finite size, a cell or image without positive sides, a broken `Mult`, a border without a positive round
   height. A size of 0 or below, and a border as wide as the piece, are answered as the normative code answers them
   (the smallest chart), with `W_GRID_NO_ROOM` from `gridIssues`.
5. **`resolveGauge` throws on invalid input** (list above); §2.2.5 does not say what an invalid spec gives. CYC 0
   with amigurumi is rejected rather than sized from the CYC 1 row (research 01 §9 falls back silently, which would
   size lace toys as fingering). The numeric limits (hook 0.1–100 mm, stitch 0.001–100 in, …) are there so that no
   accepted spec can produce 0, NaN or Infinity.
6. **The sanity warnings are a separate function** — the frozen signature `resolveGauge(g): ResolvedGauge` has no
   room for issues — and go beyond the three rules of §2.2.5 in four ways:
   - *the CYC range is carried to each count* (rows, tiles, test-ball stitches, other techniques) by the ratio of
     the table value to the Table A stitch count, and a count is accepted when it fits the range at the default hook
     **or** at the hook the spec names (the hook rule is too rough to overrule CYC's own range: 12.5 sts of worsted
     on a 9 mm hook is Ventura's real tapestry gauge);
   - *a unit slip inside the accepted range is flagged*: ±35% around the CYC range is wider than the factor 2.54, so
     "cm entered as inches" can land inside it (it does for 6 of the 113 label gauges); the slip is flagged when
     undoing it leaves every count acceptable and brings the stitch count closer to the table value by more than
     15%;
   - *a hint names the slip that explains a range finding*, when one candidate fits clearly better than the others:
     the cm/inch slips, a gauge stated per 2 in (research 01 §10.2), a C2C swatch counted in stitches (§2.2.5
     "wrong technique"), and for the test ball the width across or half the way around;
   - *`W_GAUGE_ASPECT` for tapestry, hdc and mosaic swatches*, with the sc window 0.75–1.5 moved to each
     technique's aspect;
   - *`W_GAUGE_HOOK`, `W_GAUGE_CARRIED`, `W_GAUGE_LSC`*: plausibility of the hook (beyond 2× the default the 0.75
     power is an extrapolation, and 35 for 3.5 lands there), of the carried strands, and of the calibrated yarn per
     stitch (a unit slip there multiplies every yardage while narrowing its band to ±5%).
7. **`hookFactor` uses square roots for p = 0.75** (`√r · √√r`; `√r` for 0.5, `r` for 1): IEEE 754 rounds `sqrt`
   correctly, so the factor is the same on every engine; `Math.pow` is not required to be (they agree to within
   1e-15 relative).
8. **Table B carries bands the spec does not print** for tapestry, hdc, mosaic and amigurumi (from research 01 §8
   Table B); the spec prints only the sc IQR and the worsted C2C tile range.
9. **`lscFromUnravel` accepts hdc, dc and C2C tiles.** §2.8 calibrates on "10 sc of the swatch"; an hdc or C2C
   swatch has no sc. The helper converts with the §2.2.4 multipliers, so the yardage of the stitch that was
   unravelled comes out exactly as measured.
10. **Extra files:** `round.ts`, `checks.ts` and `index.ts` beside the five files of §5.1.

## Conformance and verification

- `grid.test.ts` and `sphere.test.ts` hold the normative code blocks of §2.3.3 and §2.2.6 verbatim and compare them
  with the implementation on random input: on 6 000 random grid requests the results are identical wherever the
  normative result is a chart of 1–1000 cells a side, and on 5 000 random balls `sphereSizing` is identical to the
  formulas. The differences (deviations 1–3) are each pinned by their own test.
- `__tests__/labels.ts` was compared row by row with research 01 Appendix A (113 rows, every field equal).
- Two review passes recomputed the kernel from the spec text alone (their scripts are outside the repository). The
  first found no wrong table value or formula; what it did find is fixed in `27273ce`. The second recomputed
  Tables A–E, Table D (formula and print), the goldens G2, G3, G11 and G16 and 1 288 `resolveGauge` cases (every
  weight × technique × 23 option sets) and compared them with a dump of the code; re-run on the final code, every
  value matches. Its two dump files (`zz-review-*.test.ts`) were not tests (no assertions, output to a scratch
  path) and were deleted; every value they printed is asserted in the test files.

## Ambiguities resolved

| Where | Reading |
|---|---|
| §2.2.5 step 1: three measurement fields, one technique | Each technique family reads only its own field: row techniques `swatch`, C2C `c2cSwatch`, amigurumi `testBall`. A field of another family is ignored (and not validated), so a leftover swatch cannot be misread as tiles. `measurementOf(g)` says which one applies. |
| §2.2.5 step 3: "an `sc_graphgan` swatch sets [`wSc`, `hSc`] directly" | Only `sc_graphgan`. A tapestry, hdc or mosaic swatch sets `cell`; `wSc`, `hSc` and therefore `L_sc` stay at Table A × hook factor, as written ("independent of technique"). See request 6. |
| §2.2.5: `L_sc` with an sc swatch | `6.5 ·` the measured `wSc` (the comment in §2.2.4, "`w_sc` = Table A sc width after hook scaling", describes the default). |
| §2.2.4/§2.2.5: `L_ami` with a test ball | Unchanged by the test ball: the formula is defined on the tables and the hook ("the hook, not the stitch width, scales the yarn"). The test ball still narrows the yardage band to ±10% (§2.8). |
| §2.2.5 step 4: `tol` for amigurumi defaults | The Table A tolerance of the weight, as written (0.12 for worsted). Table E prints no band of its own; research 01 §5.4 suggests ±10% for worsted and ±20% for the other weights (request 9). |
| §2.2.5: test ball and `stretch` | `cell.w = C/N`, `stretch = 1` ("s := 1"); `h = w/1.05` (`/1.11` yarn under). Lightly stuffed and unstuffed pieces then also use the stuffed width (request 8). |
| `ResolvedGauge.stretch` | The stretch of a firm or medium piece (1.05 from the tables, 1 with a test ball). `stuffingStretch(gauge, stuffing)` gives 1 for light/none. 2D gauges have stretch 1. |
| §2.2.3: CYC 0 and amigurumi | Rejected: there is no Table E row to size from. |
| `GaugeSpec.carried` | Strands carried inside the stitches; 0 and 1 are the same (`max(0, carried − 1)`); fractions are accepted (a mean over rows); read only for tapestry without a swatch (a swatch is made with the strands carried). |
| CYC ranges for Lace and Jumbo | Lace is published in dc (32–42): used as is (a dc is about 6% wider than an sc, inside the slack). Jumbo is "≤ 6": no lower limit for the range rule (the unit-slip rule still catches 1 st per 4 in). |
| §2.2.5 "flat sc" | The `rows < stitches` rule is for `sc_graphgan` only (tapestry is taller than wide by design). |
| §2.2.5 "UK terms" | A UK pattern's "dc" is US sc; a swatch worked in US dc or hdc shows as `W_GAUGE_ASPECT` below 0.75 (`hint: 'taller-stitch'`, with the UK wording) and/or `W_GAUGE_ROWS`, and the generic range advice names UK terms. |
| §2.2.6 `k = max(2, …)` vs §2.10.5 `k = max(1, …)` | `sphereSizing` follows §2.2.6 (k ≥ 2). T4's classic generator has its own minimum (request 10). |
| §2.2.6 "p" vs research 01 §5.1 "E" | The spec's interval-correct form (one round fewer than research 01), as the spec decides. |
| §2.3.3 size of 0 / border wider than the piece | The normative `snap` floor applies: the smallest chart, reported by `gridIssues`. |
| §2.3.3 "crop must match" vs "offer ±1 row/column" | Two warnings: `W_GRID_PROPORTIONS` when both sizes are given and the request itself is more than 2.5% off the picture; `W_GRID_ASPECT` when only rounding causes the error. |
| §2.3.3, width only with a border | The chart inside the border keeps the picture's aspect (normative `Hg = Wg · a`); the finished piece with its border does not (40 in wide, 1 in border, 4:5 picture → 128 × 190, 39.9 × 49.5 in). |
| §2.8 buffer precedence | The higher buffer wins: C2C and tapestry use 0.20 even with one color; > 50 strands 0.20; otherwise one color 0.10, else 0.15. Amigurumi is always 0.15. The 61.9 yd golden states its buffer (0.15) itself, i.e. it is one color of a multi-color piece; as a one-color piece it would be 59.2 yd (request 14). |
| §2.8 "single-color piece" | `colors ≤ 1`, passed by the caller. |
| §2.2.4 "6.5 · 0.2267 = 1.47 in" | `w_sc` is 0.226751 (0.2267 is cut, not rounded); the products 1.47 and 1.474 are right (request 12). |
| Table D, residue | Three printed cells sit exactly half a unit from the computed value and are printed inconsistently (1.625 → 1.62, 9.425 → 9.42, 0.845 → 0.85); all are inside the ±0.01 the spec asks the tests for. |
| `HOOK_SIZES_MM` | The sizes §2.2.1 names. Common metric sizes without a US letter that it does not name (3, 7, 12 mm) are not listed; any size in mm is valid input. |

## Requests for integration

1. **`ResolvedGauge` cannot say whether the yarn was calibrated.** §2.8 narrows the yardage band to ±5% once
   `lscCalibratedIn` is set, but workers receive only a `ResolvedGauge` (`ChartRequest`, `buildPattern2D`,
   `AmiRequest`), which carries `source` but not that fact: `resolveGauge({ cyc: 4, technique: 'sc_graphgan',
   lscCalibratedIn: 1.8 })` has `source: 'default'`. Until the type changes, `core/yardage` can reach ±25/20% and
   ±10% (`yardageBand({ technique, source: gauge.source })`) but never ±5%. Request: an additive field, e.g.
   `ResolvedGauge.lscCalibrated?: boolean` (set by `resolveGauge`). `yardageBandFor(spec)` already gives the right
   band wherever the `GaugeSpec` is at hand. (Pinned by a test in `resolve.test.ts`.)
2. **Issue codes.** §2.13 lists no code for the §2.2.5 sanity warnings or the §2.3.3 limits. Used here:
   `E_GAUGE_INPUT` (error); `W_GAUGE_RANGE`, `W_GAUGE_ASPECT`, `W_GAUGE_ROWS`, `W_GAUGE_HOOK`, `W_GAUGE_CARRIED`,
   `W_GAUGE_LSC`; `W_GRID_NO_ROOM`, `W_GRID_CAPPED`, `W_GRID_LARGE`, `W_GRID_PROPORTIONS`, `W_GRID_ASPECT` (warn).
   Please add them to the table or rename them.
3. **§2.3.3:** say how the hard cap is applied (deviation 3), that `snap` never returns 0 (deviation 2) and what
   `grid` does without a size (deviation 4).
4. **Rounding, all tracks.** §2.10.5 says "`Math.round` = JS half-up rounding everywhere". Ties broken by binary
   noise are real (deviation 1), and two tracks computing the same count with slightly different expressions can
   disagree by one. Suggest: counts are rounded with `roundHalfUp` of `core/gauge` — in particular
   `S_side = round(rows · h_cell / w_sc)` (§2.7.10), the classic sphere's `wall = round(3k·w/h) − 2k` (§2.10.5) and
   `N = round(L / hS)`. Border rounds should come from `borderRounds`.
5. **§2.2.5:** state which measurement each technique reads, the extensions of deviation 6, and that the UI clears
   or swaps the swatch when the technique changes (gauge profiles are stored per yarn + hook + technique).
6. **§2.2.5, optional improvement:** a tapestry or mosaic swatch measures the sc width directly (`w = w_sc` in
   Table B), an hdc swatch `w / 1.05`, a C2C swatch `tile / 2.6`. Deriving `wSc` (and `L_sc`) from them would make
   the ±10% "with a swatch" band of §2.8 true for every technique, not only `sc_graphgan`. Not done: the spec says
   "independent of technique".
7. **Changing the yarn weight with a fixed hook (§4.5, §3.7.7).** Each weight scales from its own reference hook, so
   at one fixed hook a finer yarn does not always give a narrower stitch: with `hookMm: 3.5`, worsted is 0.195 in and
   DK 0.204 in, and a 3 in ball goes from 48 to 42 stitches around when CYC 4 → 3. The §4.5 E2E ("changing CYC 4 → 3
   increases the round counts") holds with default hooks but fails when `hookMm` is set explicitly, which the import
   pre-fill does. The panel should clear `hookMm` (and the measurements) when the weight changes; and a model with
   `weightCYC: 0` must be mapped to 1 before it reaches the gauge, because CYC 0 is rejected for amigurumi.
8. **Test ball and unstuffed pieces.** With "s := 1" the measured width includes the stuffing, and light/none pieces
   use that same width, about 5% too wide. Storing `cell.w = C/N / 1.05` with `stretch = 1.05` would keep both
   right; the spec's choice was followed.
9. **Table E tolerance.** §2.2.5 gives amigurumi defaults the Table A tolerance (±12% for worsted, ±15% for CYC 1).
   Research 01 §5.4 estimates ±10% for worsted (calibrated) and ±20% for every other weight, and §2.8 uses ±20% for
   the yardage. A `tol` column in Table E would make the size band match.
10. **§2.2.6 vs §2.10.5:** `k = max(2, …)` here, `max(1, …)` in the classic generator; pick one.
11. **§2.8 calibration for hdc and C2C:** say what to unravel (deviation 9), or keep "10 sc" and ask for an sc strip
    beside the swatch.
12. **§2.2.4:** "6.5 · 0.2267" → 0.2268 (or 0.22675).
13. **`entryPoints.check.ts` (0c):** `resolveGauge(g: GaugeSpec): ResolvedGauge` and `grid(c, req)` could be added to
    the signature guard; their shapes are those of §2.2.5 and §2.3.3.
14. **G11 (§2.8, §2.13): "1000 sc of one color with one strand (2 tails), buffer 0.15 ⇒ 61.9 yd".** §2.8 also says
    "buffer 0.10 single-color piece". Built as a one-color chart, with the buffer taken from the piece's own rule
    (`yardageBuffer({ technique: 'sc_graphgan', colors: 1, strands: 1 })` = 0.10), the same stitches give
    (1925.926 + 12) / 36 × 1.10 = **59.2 yd**, and T2's acceptance test of G11 would fail. This kernel reads the
    golden as one color of a multi-color piece (both readings are pinned in `yarnPerStitch.test.ts`). Request: reword
    G11 to "one color of a multi-color chart: 1000 sc … buffer 0.15 ⇒ 61.9 yd", or keep the one-color piece and
    change the result to buffer 0.10 ⇒ 59.2 yd.

## Not done (outside this kernel)

- The yardage totals per color, chart and toy (T2 `core/yardage/twoD.ts`, T4 `core/yardage/threeD.ts`) and the
  materials-page formatting (gauge line, finished size to ¼ in / 0.5 cm).
- Research 01 §7's second calibration mode ("swatch weighs __ g; label says __ yd per __ g"): the spec uses the
  unravel calibration only.
