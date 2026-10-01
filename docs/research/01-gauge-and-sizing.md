# 01 · Gauge & Size Conversion Math

Research for **Crochet Pattern Generator** (R1 2D charts, R2/R3 3D amigurumi, R4 size math, R8 per-color yarn).
Researched 2026-09-30.

**Evidence labels used throughout**

- **[VERIFIED]**: stated by the linked source (quoted or transcribed).
- **[COMPUTED]**: we calculated it from verified numbers. The method is shown and the raw data is in Appendix A.
- **[INFERENCE]**: our own model or recommendation. Validate it with real swatches before trusting it.

All gauges are given **per 4 in** (≈10 cm; exactly 4 in = 10.16 cm). For a gauge of **S stitches × R rows per 4 in**, stitch width is `w = 4/S` in, row height is `h = 4/R` in, and the **stitch aspect is `w/h = R/S`**: values above 1 mean the stitch is wider than it is tall.

---

## 0. Summary of the decisions for the code

1. **Never chart single crochet on square cells.** We read the published sc gauges of 113 commercial yarns. Across the 91 smooth (non-novelty) ones, a 4 in square holds a median of **1.18× more rows than stitches** (IQR 1.10 to 1.25). That makes an sc stitch about 18% wider than it is tall. For comparison, the same labels give **1.33** for knit stockinette. [COMPUTED, §2]
2. **Tapestry crochet goes the other way.** When yarn is carried inside the stitches, they come out **taller than wide (w/h ≈ 0.88)**. Carol Ventura's tapestry gauges are 38×32/4 in, 8×7/in, 10×9/in and 12.5×11/4 in, and she says "the stitches will become taller with each additional yarn that is carried". [VERIFIED + COMPUTED, §3.4]
3. **C2C tiles are square**, with side ≈ **2.6 × the sc stitch width** (≈1.5 × the dc row height). Worsted on a 5 mm hook gives about **0.67 to 0.77 in per tile** (Red Heart: "6 blocks = 4"; 6 rows = 4""). [VERIFIED + COMPUTED, §3.3]
4. **Amigurumi uses hooks about 2 mm smaller than the CYC minimum hook (1.25 to 2 mm smaller than the median ball-band hook), not 0.5 to 1 mm smaller as the brief assumed.** PlanetJune uses 2.75 mm for DK, 3.5 mm for worsted and 4.5 mm for bulky. Tiny Curl's rule: "take the smallest recommended hook size and subtract 2 mm". Amigurumi sc worked in rounds is close to square (w/h ≈ 1.0 to 1.1). The standard "+6 per round" flat-circle rule implies exactly that: 2π/6 = 1.047. [VERIFIED + INFERENCE, §3.7]
5. **Sphere size:** `D ≈ N_max · w · s / π`. Worsted on a 3.5 mm hook gives **D ≈ 0.065 in × N_max**. So a 36-st sphere is about **2.35 in (6.0 cm)**, and a 42-st sphere is about 2.74 in, which matches PlanetJune's 42-st beach ball: "Approx 2.75″ (7cm)". [COMPUTED, calibrated, §5]
6. **Yarn per stitch:** `L_sc ≈ 6.5 × w_sc` (±15%). Relative to sc, hdc uses ≈1.45× and dc ≈2.0× (Interweave and Stacey Trock measurements). A C2C tile uses ≈7.8 × L_sc. Each strand carried through a tapestry stitch adds ≈1.1 × w. Add a buffer of 10 to 20% plus 6 in tails. [VERIFIED data + INFERENCE model, §6]
7. **Defaults are only a starting point; put swatch calibration up front.** Ten designers using the *same* yarn and hook measured **12 to 15 hdc and 9 to 11 rows per 4 in**, a spread of about ±11% ([sincerelypam](https://www.sincerelypam.com/gauge-swatches-a-comparison/)). The app should show the resulting size uncertainty and let one measured swatch override everything. [VERIFIED, §7]

---

## 1. The yarn weight system

### 1.1 Craft Yarn Council (CYC) Standard Yarn Weight System [VERIFIED]

Source: [CYC: Standard Yarn Weight System](https://www.craftyarncouncil.com/standards/yarn-weight-system). The table row headers read "Knit Gauge Range* in Stockinette Stitch to 4 inches" and "**Crochet Gauge* Ranges in Single Crochet to 4 inch**". The footnote says "*GUIDELINES ONLY: The above reflect the most commonly used gauges and needle or hook sizes for specific yarn categories."

| CYC | Name | Yarn types (CYC wording) | Knit gauge, st st /4 in | Needles mm (US) | **Crochet gauge, sc /4 in** | Hook mm | Hook US |
|---|---|---|---|---|---|---|---|
| 0 | Lace | Fingering, 10-count crochet thread | 33–40 | 1.5–2.25 (000–1) | **32–42 *double crochets*** | steel 1.6–1.4; regular 2.25 | steel 6, 7, 8; regular B-1 |
| 1 | Super Fine | Sock, Fingering, Baby | 27–32 | 2.25–3.25 (1–3) | 21–32 | 2.25–3.5 | B-1 to E-4 |
| 2 | Fine | Sport, Baby | 23–26 | 3.25–3.75 (3–5) | 16–20 | 3.5–4.5 | E-4 to 7 |
| 3 | Light | DK, Light Worsted | 21–24 | 3.75–4.5 (5–7) | 12–17 | 4.5–5.5 | 7 to I-9 |
| 4 | Medium | Worsted, Afghan, Aran | 16–20 | 4.5–5.5 (7–9) | 11–14 | 5.5–6.5 | I-9 to K-10½ |
| 5 | Bulky | Chunky, Craft, Rug | 12–15 | 5.5–8 (9–11) | 8–11 | 6.5–9 | K-10½ to M-13 |
| 6 | Super Bulky | Super Bulky, Roving | 7–11 | 8–12.75 (11–17) | 7–9 | 9–15 | M-13 to Q |
| 7 | Jumbo | Jumbo, Roving | ≤6 | ≥12.75 (≥17) | ≤6 | ≥15 | Q and larger |

Notes from the same page [VERIFIED]:
- On lace: "Lace weight yarns are usually knitted or crocheted on larger needles and hooks to create lacy, openwork patterns. Accordingly, a gauge range is difficult to determine."
- On steel hooks: "the higher the number, the smaller the hook".

What this means for us:
- **CYC publishes stitch counts only, never row counts.** Row gauge, and therefore stitch aspect, has to come from other data (§2). [VERIFIED]
- The lace category is given in dc, not sc. [VERIFIED]
- Manufacturers' own labels mostly put the hook **at or below the low end of the CYC hook range** [COMPUTED, Appendix A]. Median label hooks are DK 4.0 mm (CYC 4.5–5.5), worsted 5.0 mm (CYC 5.5–6.5), bulky 6.5 mm (CYC 6.5–9, i.e. at the minimum) and super bulky 8.5 mm (CYC 9–15). *(Fact-check: was "super bulky 8 mm"; the Appendix A median is 8.5 mm, matching §2.1.)* Examples:
  - Red Heart Super Saver: "12 sc x 15 r with 5.5 mm" ([Yarnspirations](https://www.yarnspirations.com/products/red-heart-super-saver-yarn))
  - Caron Simply Soft: "13 sc x 14 r with 5 mm" ([Yarnspirations](https://www.yarnspirations.com/products/caron-simply-soft-yarn))
  - Lion Brand Vanna's Choice: "12 sc x 15 r on J-10 (6mm)" ([Lion Brand](https://www.lionbrand.com/products/vannas-choice-yarn))

### 1.2 Wraps per inch (WPI) [VERIFIED]

| CYC | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| CYC WPI range ([CYC](https://www.craftyarncouncil.com/standards/how-measure-wraps-inch-wpi)) | 30–40+ | 14–30 | 12–18 | 11–15 | 9–12 | 6–9 | 5–6 | 1–4 |
| Ravelry point value ([Ravelry](https://www.ravelry.com/help/yarn/weights)) | — (no WPI listed for Thread/Cobweb/Lace/Light Fingering)* | 14 (Fingering) | 12 (Sport) | 11 (DK) | 9 (Worsted) / 8 (Aran) | 7 (Bulky) | 5–6 | 0–4 |

\* *Fact-check: was "32–34 (Lace)". Ravelry's table gives no WPI for Lace; "32-34 stitches" is its **knit gauge** for Lace. For CYC 0, use CYC's own 30–40+ WPI.*

CYC's measuring method: wrap the yarn around something of constant circumference, such as a pencil, so that "The yarn should be snug, and the wraps should lay side by side without any over lapping, or large gaps", then count the wraps in one inch and "Measure a few places as you would a gauge swatch" ([CYC](https://www.craftyarncouncil.com/standards/how-measure-wraps-inch-wpi)).

**[INFERENCE]** The CYC WPI ranges overlap: 3 is 11–15 and 4 is 9–12. If the user only knows WPI, classify by the **nearest Ravelry point value** and ask them to confirm when the result is ambiguous.

### 1.3 Regional names [VERIFIED, with one conflict]

| CYC | US / common names | UK | AU/NZ | Ravelry |
|---|---|---|---|---|
| 0 | lace, thread, cobweb | 1–2 ply (Ravelry also puts 3 ply here) | 2 ply | Thread / Cobweb / Lace / Light Fingering |
| 1 | fingering, sock, baby | 4 ply (Wikipedia also puts 3 ply / light fingering here) | 4 ply | Fingering |
| 2 | sport, baby | sport / 5 ply | 5 ply | Sport |
| 3 | DK, light worsted | DK | 8 ply | DK |
| 4 | worsted, afghan, aran | aran (heavier end) | 10 ply | Worsted / Aran |
| 5 | chunky, craft, rug | chunky | 12 ply | Bulky |
| 6 | super bulky, roving | super chunky | — | Super Bulky |
| 7 | jumbo, roving | jumbo | — | Jumbo |

Sources:
- Ply equivalents: Fingering = 4 ply, Sport = 5 ply, DK = 8 ply, Worsted and Aran = 10 ply, Bulky = 12 ply ([Ravelry](https://www.ravelry.com/help/yarn/weights)).
- Lion Brand describes #4 as "Medium weight yarns, which include worsted and aran weight yarns ... 11-14 stitches over 4 inches in single crochet" (product description on [Lion Brand](https://www.lionbrand.com/products/vannas-choice-yarn)).
- **Conflict (corrected by fact-check):** the earlier text said [Wikipedia's table](https://en.wikipedia.org/wiki/Yarn_weight) shifts UK/AU by one category ("UK 4 ply → CYC 2"). That is wrong for the current page: Wikipedia maps UK 4 ply → CYC 1, AU 5 ply → CYC 2, 8 ply → 3, "10 or 12 ply" → 4 and "12 or 16 ply" → 5. The real disagreement is narrower. Ravelry's table maps **Light Fingering (3 ply) → CYC 0 Lace**, while Wikipedia puts 3 ply / Light Fingering in CYC 1. **[INFERENCE]** Follow Ravelry for named weights, and ask the user when a yarn is labelled "light fingering" or "3 ply".

**US vs UK stitch names** [VERIFIED, [CYC](https://www.craftyarncouncil.com/standards/crochet-abbreviations)]: US sc = UK dc, US hdc = UK htr, US dc = UK tr, and US "gauge" = UK "tension". So a gauge string such as "18 dc × 20 rows" in a UK pattern means **sc**. The importer must ask which terminology the pattern uses.

### 1.4 Hook sizes [VERIFIED]

From [CYC: Hooks](https://www.craftyarncouncil.com/standards/hooks-and-needles), mm → US: 2.25 B-1 · 2.75 C-2 · 3.25 D-3 · 3.5 E-4 · 3.75 F-5 · 4 G-6 · 4.5 7 · 5 H-8 · 5.5 I-9 · 6 J-10 · 6.5 K-10½ · 8 L-11 · 9 M/N-13 · 10 N/P-15 · 11.5 P-16 · 15 P/Q · 15.75 Q · 19 S · 25 T/U/X. Steel hooks: "The smallest steel hook is a #14 or .9 mm; the largest is a 00 or 2.7 mm."

### 1.5 Yards per 100 g [COMPUTED + VERIFIED ranges]

We computed this from the ball-band length and weight of 113 yarns (Appendix A; solid colourways).

| CYC | n | Median yd/100 g | IQR | Published rough guides |
|---|---|---|---|---|
| 0 | 0 | — | — | Lace 550–800 ([Paper Moon Knits](https://www.papermoonknits.com/musings/math-mondays-yarn-weight-category-vs-yardage)); 600+ ([Purple Lamb](https://www.purplelambfiberarts.com/nerding-out-about-yarn-weights-and-measures/)) |
| 1 | 3 | 332 | 239–438 | Fingering 380–460 (PMK); 380–600 (PL) |
| 2 | 0 | — | — | Sport 300–360 (PMK); 300–380 (PL) |
| 3 | 20 | 286 | 241–359 | DK 240–280 (PMK); 230–300 (PL) |
| 4 | 45 | 190 | 175–216 | Worsted 200–240, Aran 120–180 (PMK); 170–230 (PL) |
| 5 | 22 | 121 | 109–159 | Bulky 100–120 (PMK); 100–170 (PL) |
| 6 | 18 | 71 | 62–89 | <100 (both) |
| 7 | 5 | 12 | 11–32 | — |

*Fact-check:* we re-scraped the 113 pages, taking the first listed (usually solid) put-up. That gives medians of CYC1 332, CYC3 296 (n=19), CYC4 190.5 (n=44), CYC5 120 (n=21), CYC6 70.5 and CYC7 12. Three pages had no parseable length. The medians agree to within about 3.5%. The IQRs differ somewhat (DK 250–342, bulky 109–127), because the result depends on which colourway's put-up is used. Treat the IQR columns as approximate.

Fibre matters a lot. Cotton and chenille are dense: Lily Sugar'n Cream gives 169 yd/100 g and Bernat Blanket 72, against 232 for Lion Wool-Ease. Purple Lamb notes its chart is "most accurate with yarn that is made mostly of wool." **[INFERENCE]** Use these only as fallbacks when the user hasn't entered a ball band. Always prefer the label's actual yards per skein, which can differ by colourway: Red Heart Super Saver solids are "198 g/7 oz, 333 meters/364 yards" but prints are "141 g/5 oz ... 236 yards" ([Yarnspirations](https://www.yarnspirations.com/products/red-heart-super-saver-yarn)).

---

## 2. The single crochet aspect ratio, from real data

### 2.1 113 manufacturer labels [COMPUTED from VERIFIED]

**Method.** On 2026-09-30 we read the published crochet gauge field ("Crochet Gauge (4in x 4in) 12 sc x 15 r on J-10 (6mm)" and similar) from:
- 48 Lion Brand product pages
- 65 Yarnspirations product pages (Red Heart, Caron, Bernat, Patons, Lily, Peaches & Crème, Phentex)

That gives 113 yarns with both stitch and row counts. We dropped two entries as apparent typos: Red Heart It's a Wrap "22 sc x 15 r" and Red Heart Chic Sheep "16 sc x 28 r". Every row with its link is in Appendix A.

| CYC | n | sc/4 in, median (range) | rows/4 in, median (range) | **w/h median** (range) | Label hook median |
|---|---|---|---|---|---|
| 1 | 3 | 22 (22–24) | 24 (24–30) | 1.09 (1.09–1.25) | 3.25 mm |
| 3 | 20 | 16 (13–21) | 20 (16–25) | **1.19** (1.06–1.47) | 4.0 mm |
| 4 | 45 | 13.2 (11–17) | 16 (13–20) | **1.18** (1.00–1.43) | 5.0 mm |
| 5 | 22 | 10.5 (6–13) | 12 (6–16) | **1.15** (1.00–1.27) | 6.5 mm |
| 6 | 18 | 7 (6–9) | 8 (6–10) | **1.13** (0.92–1.21) | 8.5 mm |
| 7 | 5 | 3 (2–5.5) | 3 (2–6.5) | 1.00 (1.00–1.18) | 15 mm |

Summary statistics:
- **All 113:** median w/h 1.143, mean 1.161, IQR 1.09 to 1.22.
- **Smooth yarns (n = 91):** median **1.176**, IQR 1.10 to 1.25, p10 to p90 1.08 to 1.29. We excluded faux fur, sherpa, chenille "blanket" yarns, bouclé, velvet and fleece.
- **Novelty textures alone:** median 1.13, with many exactly 1.00. Their stitches are hard to see, so labels round the numbers.
- **Knit stockinette from the same 113 labels:** median w/h **1.333** (p10 to p90 1.25 to 1.44). For comparison, KnitPro's knit papers use 5:7 ([KnitPro](https://www.microrevolt.org/knitPro/)).

### 2.2 Independent swatches [VERIFIED]

- **Interweave experiment** (Amy Gunderson, 2023): Universal Yarn Deluxe Chunky (bulky, 120 yd/100 g, [Ravelry](https://www.ravelry.com/yarns/library/universal-yarn-deluxe-chunky)) on a 6 mm hook, every swatch 20 sts × 20 rows:
  - sc: 6.25 × 5.75 in (w/h = 1.09)
  - hdc: 6.75 × 9.25 in
  - dc: 7 × 13 in
  - The author noticed that "each taller stitch [is] a bit wider overall"

  Source: [Interweave, archived copy](http://web.archive.org/web/20250117034756/https://www.interweave.com/article/knitting/yarn-usage-knitting-vs-crochet-experiment/).
- **Overlay mosaic (sc-based), LillaBjörn:** DK on a 4 mm hook gives "19 sc and 24 rows = 10 x 10 cm" (w/h = 1.26) ([Nya Mosaic](https://www.lillabjorncrochet.com/2017/07/nya-mosaic-blanket-free-crochet-pattern.html)).
- **Bernat Daisy C2C** (Baby Blanket Tiny, 4 mm): "15 sc and 16 rows = 4"" (1.07) ([pattern PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-002575M.pdf)).
- **Bernat Checkerboard C2C** (Fluffee, 8 mm): "10 sc and 12 rows = 4"" (1.20) ([PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-36889M.pdf)).
- Practitioners agree: "Crochet stitches aren't square. Single crochets for example, are wider than they are tall" ([Willow Crochet on Stitch Fiddle](https://www.willowcrochet.com/stitch-fiddle-features-for-crochet-colorwork/)). Stitch Fiddle's gauge setting exists for this reason: "The gauge is used (and only need to be used) in Stitch Fiddle when your stitches aren't exactly square" ([Stitch Fiddle help](https://www.stitchfiddle.com/en/help/1pe1-ftobtg/gauge-proportions)).
- **Counter-examples to avoid:**
  - KnitPro offers "Needlepoint, Cross Stitch, Crochet (1:1)", i.e. square crochet cells ([KnitPro](https://www.microrevolt.org/knitPro/)).
  - StitchSums' calculator states "Single crochet is close to square (aspect ≈ 1.0)" *(fact-check: quote was paraphrased as "Single crochet: aspect ≈ 1.0")* ([StitchSums](https://www.stitchsums.com/calculators/stitch-aspect-ratio)), while its own article says "A single crochet stitch is clearly wider than it is tall" ([StitchSums](https://www.stitchsums.com/articles/crochet-graph-maker/)). Treat that site as unreliable.

### 2.3 What this means for the grid [INFERENCE]

Drawing sc colorwork on square cells makes the finished motif **about 15% shorter than intended** (at w/h 1.18, 1/1.18 = 0.85): circles come out as ovals wider than tall. The renderer and the resampler must both use cells of `w × h`. §4 has a worked example.

---

## 3. Other stitches and techniques

All multipliers are relative to **flat sc in the same yarn and hook**.

### 3.1 Half double crochet (hdc)

- Red Heart Soft on a 5.5 mm hook, ten designers: 12 to 15 hdc and 9 to 11 rows per 4 in ([sincerelypam](https://www.sincerelypam.com/gauge-swatches-a-comparison/)). The label sc gauge for the same yarn and hook is "12 sc x 15 r" ([Yarnspirations](https://www.yarnspirations.com/products/red-heart-soft-yarn)), so an **hdc row ≈ 1.5 sc rows**. [VERIFIED → COMPUTED]
- In the Interweave swatches, an hdc row is 9.25/20 = 0.4625 in against 0.2875 in for sc (**1.61×**), and the width is 1.08×. [COMPUTED]
- **Defaults:** width ×1.05, height ×1.5. Worsted then comes out at about 12.9 hdc × 10.7 rows per 4 in. [INFERENCE]

### 3.2 Double crochet (dc)

- Interweave: dc row height is **2.26×** sc and width 1.12×. [COMPUTED]
- Yarnspirations patterns that give a dc gauge for a yarn whose label gives the sc gauge on the same hook: [VERIFIED → COMPUTED]

  | Yarn, hook | Label sc gauge | Pattern dc gauge | dc row ÷ sc row | dc width ÷ sc width |
  |---|---|---|---|---|
  | Bernat Baby Blanket, 8 mm | 7 sc × 8 r | 7 dc × 4 rows ([PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-38271M.pdf)) | 2.0 | 1.0 |
  | Red Heart Hygge, 6.5 mm | 11 sc × 13 r | 11 dc × 6 rows ([PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/RHC0502-027934M.pdf)) | 2.17 | 1.0 |
  | Bernat Softee Chunky, 8 mm | 8 sc × 9 r | 8 dc × 4.5 rows ([PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-027725M.pdf)) | 2.0 | 1.0 |

- **Defaults:** width ×1.06, height ×2.1, so a dc is about 0.56 to 0.6 as wide as it is tall. [INFERENCE]
- **Turning chains** [VERIFIED, [Wikipedia](https://en.wikipedia.org/wiki/List_of_crochet_stitches)]: slip stitch 0, sc 1, hdc 2, dc 3, tr 4, dtr 5.
- **Flat circles in the round** [INFERENCE]: they lie flat when the increases per round ≈ `2π·h/w`. That gives ≈6 for sc, ≈8 to 9 for hdc and ≈12 to 13 for dc. It is consistent with Bernat's dc motif, which starts "9 dc in 4th ch from hook (counts as 10 dc)" ([Blooming Blossom PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0334-035451M.pdf)).

### 3.3 Corner-to-corner (C2C) tiles

The standard construction is "Ch 6. 1 dc in 4th ch from hook (counts as 2 dc). 1 dc in each of last 2 ch" for the first block, then "Sl st to next ch-3 sp. Ch 3. 3 dc in same ch-3 sp" for each block after that ([Bernat Daisy C2C](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-002575M.pdf)). Tiles are square: "6 blocks = 4"; 6 rows = 4" in pattern" ([Red Heart C2C Throw](https://www.favecrafts.com/Crochet-Afghans/Crochet-Corner-to-Corner-Throw-Pattern-from-Red-Heart-Yarn)). [VERIFIED]

| Pattern | Yarn (CYC) | Hook | Stated gauge [VERIFIED] | Tile (in) | Tile ÷ label sc width [COMPUTED] | Tile ÷ dc row height |
|---|---|---|---|---|---|---|
| [Red Heart C2C Throw](https://www.favecrafts.com/Crochet-Afghans/Crochet-Corner-to-Corner-Throw-Pattern-from-Red-Heart-Yarn) | Super Saver (4) | 5 mm | 6 blocks = 4"; 6 rows = 4" | 0.667 | ≈2.0 (label w at 5.5 mm) | — |
| [Bernat Chevron C2C](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-034559M.pdf), [Do the Wave](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-38271M.pdf) | Blanket / Baby Blanket (6) | 8 mm | 7 dc × 4 rows; 2.5 blocks = 4" | 1.6 | 2.8 | 1.6 |
| [Bernat Striped C2C](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRN0502-029810M.pdf) | Blanket Stripes (6) | 8 mm | 7 dc × 4 rows; 1 Block = Approx 1½" | 1.5 | 2.6 | 1.5 |
| [Bernat Checkerboard C2C](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-36889M.pdf) | Fluffee (5) | 8 mm | 10 sc × 12 rows; 4 blocks = Approx 4" | 1.0 | 2.5 | — |
| [Red Heart Geometric Steps](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/RHC0502-027934M.pdf) | Hygge (5) | 6.5 mm | 11 dc × 6 rows; 4 blocks = 4" | 1.0 | 2.75 | 1.5 |
| [Bernat Daisy C2C](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-002575M.pdf) | Baby Blanket Tiny | 4 mm | 15 sc × 16 rows; 39 blocks; 32" incl. edging | ≈0.77 | ≈2.9 | — |

**Default [INFERENCE]:** tile side = **2.6 × w_sc** (observed 2.0 to 2.9, so about ±15%). That is equivalent to about 1.5 × the dc row height. A C2C grid has cols = round(W/tile) and rows = round(H/tile), with no aspect correction.

### 3.4 Tapestry crochet (sc with carried strands)

Carol Ventura's tapestry gauges [VERIFIED]:

| Pattern | Yarn | Hook | Gauge | w/h [COMPUTED] |
|---|---|---|---|---|
| [Tapestry Crochet Wallet](https://www.ravelry.com/patterns/library/tapestry-crochet-wallet) | Aunt Lydia's Fashion 3 thread (fingering) | 2.25 mm | 38 sts & 32 rows = 4" | 0.84 |
| [Tapestry Laptop Bag](https://www.ravelry.com/patterns/library/tapestry-laptop-bag) | DMC Senso cotton (fingering) | 2.25 mm (B) | 8 sts & 7 rows = 1" in sc *(fact-check: was "7 rnds" and "steel"; Ravelry lists "8 stitches and 7 rows = 1 inch", hook "2.25 mm (B)")* | 0.875 |
| [Reversible Basket](https://www.tapestrycrochet.com/CreativeLivingTapestryCrochet.pdf) | Aunt Lydia's size 3 | 2 mm steel | 10 sts = 1"; 9 rows = 1" | 0.90 |
| [Tapestry Crochet Heart](https://www.ravelry.com/patterns/library/tapestry-crochet-heart) | worsted | 9 mm | 12.5 sts & 11 rows = 4" | 0.88 |
| [Felted Amulet](https://www.carolventura.com/amulet.html) | worsted wool (felted) | "K" | 4 sts = 1", 4 rows = 1" | 1.00 |

Median **w/h ≈ 0.88**: tapestry stitches are **taller than wide**, the reverse of plain sc. From [Ventura's graph-paper article](https://www.tapestrycrochet.com/CreativeLivingTapestryCrochet.pdf) [VERIFIED quotes]:
- "The actual stitch height, or rows per inch measurement, will depend on the yarn, tension, and the number of carried yarns ... **The stitches will become taller with each additional yarn that is carried.** To determine which graph paper to use for your project, tapestry crochet a sample (while carrying the yarns), then measure the stitches and rows per inch."
- "For pieces worked in rounds, the stitches stack up diagonally. On flat pieces, all of the stitches slant to the right on one row, then on the next row they all slant to the left."
- "tapestry crochet stitches are not square and do not fall directly over one another."
- "The base of the piece should be a multiple of the horizontal measurement if you want the motifs to butt together."

**Defaults [INFERENCE]:**
- Tapestry sc: `w = w_sc`, `h = w / 0.88`, which is about 1.34 × the plain sc row height.
- Add 5% to h for each additional carried strand beyond the first. Ventura only says "taller", so this percentage is unvalidated.
- Keep a separate **"graphgan/intarsia sc"** technique, where nothing is carried, that uses the plain sc aspect of 1.18.
- v1 renders straight columns. v2 can show the half-stitch slant per round.

### 3.5 Tunisian simple stitch (Tss)

| Source [VERIFIED] | Yarn | Hook | Gauge | w/h |
|---|---|---|---|---|
| [TL Yarn Crafts temperature blanket](https://tlycblog.com/how-to-make-a-tunisian-crochet-temperature-blanket/) | DK | 6 mm | 16 sts × 15 rows = 4" | 0.94 |
| [Winding Road Crochet](https://www.windingroadcrochet.com/how-to-tunisian-crochet-gauge/) | worsted | 6.5 mm | 11 Tss × 10 rows = 3" | 0.91 |
| Winding Road Crochet | worsted | 8 mm | 3 Tss × 3 rows = 1" | 1.00 |
| Winding Road Crochet (generic example) | — | — | 4 Tss × 5 rows = 1" | 1.25 |
| [Jen Hayes Creations bag](https://www.jenhayescreations.com/diamonds-in-tunisian-crochet-bag/) | worsted (Super Saver) | 5 mm | 5 sts × 4 rows = 1" (blocked) | 0.80 |

Median about 0.93, so Tss is roughly square: "With proper tension and the right hook size, you can create perfectly square Tunisian simple stitches ... each stitch corresponds to a pixel in a graph" ([YarnAndy](https://yarnandy.com/tunisian-simple-stitch-detailed-tutorial/)). [VERIFIED]

**Defaults [INFERENCE]:**
- Hook = the sc default + 1.5 mm. TL used 6 mm for DK and Winding Road 6.5 to 8 mm for worsted.
- Stitches per 4 in = 1.05 × the sc default.
- `h = w / 0.93`, with a wide uncertainty band of 0.8 to 1.25.

### 3.6 Mosaic crochet

- **Overlay mosaic** [VERIFIED, [Wikipedia](https://en.wikipedia.org/wiki/Mosaic_crochet)]: "colors change every row", "worked on the right side of fabric only", back loop only, and it leaves a "large number of yarn ends on each side".
- **Inset mosaic** [same source] "uses one color for two rows at a time" and carries the yarn up the sides.
- LillaBjörn gauges [VERIFIED]:
  - DK, 4 mm: "19 sc and 24 rows = 10 x 10 cm" (1.26). Repeat: "multiple 12 (one repeat) +3 sts" ([Nya](https://www.lillabjorncrochet.com/2017/07/nya-mosaic-blanket-free-crochet-pattern.html)).
  - Scheepjes Whirl, 3.5 to 3.75 mm: "20 sts and 30 rows = 10 x 10 cm" (1.5). Repeat: "multiple of 12 sts + 3 sts (ch4)" ([Nya Infinity](https://www.lillabjorncrochet.com/2019/07/nya-infinity-mosaic-blanket.html)).
- **Defaults [INFERENCE]:** overlay mosaic `w = w_sc`, `h = w / 1.3` (range 1.0 to 1.5). Rows come in colour pairs, so row counts should be even. Each row costs 2 yarn tails (§6.3).

### 3.7 Amigurumi (tight sc in spiral rounds)

**Hooks** [VERIFIED]:
- [PlanetJune](https://www.planetjune.com/blog/amigurumi-help/resizing-amigurumi/): "DK weight (#3) yarn: C US/2.75mm hook; worsted weight (#4) yarn: E US/3.5mm hook; bulky weight (#5) yarn: G7 US/4.5mm hook".
- [Tiny Curl](https://www.tinycurl.co/amigurumi-hook-size/): "hooks for amigurumi need to be smaller than the recommended crochet hook for the yarn" and, for weights 2 to 5, "take the smallest recommended hook size and subtract 2 mm".
- [PlanetJune's tension study](https://www.planetjune.com/blog/stitch-tension-in-amigurumi-an-investigation/) recommends "the smallest size you can manage without starting to have problems from splitting your yarn".

The brief assumed amigurumi hooks are 0.5 to 1 mm smaller than the ball band. **The evidence says they are about 1.75 to 2 mm below the CYC minimum hook, or 1.25 to 2 mm below the median ball-band hook** (DK 4.0 → 2.75, worsted 5.0 → 3.5, bulky 6.5 → 4.5). *(Fact-check: the earlier sentence said the CYC minimum is "1.5 to 2 mm below typical label hooks". That is backwards: label hooks sit at or below the CYC minimum, see §1.1.)* Tiny Curl's own table gives a wider worsted range of 2.75–3.75 mm.

**Gauges** [VERIFIED, Lion Brand pattern pages]:

| Pattern | Yarn weight | Hook | Gauge per 4 in | w/h |
|---|---|---|---|---|
| [Amigurumi Armadillo](https://www.lionbrand.com/products/amigurumi-armadillo-crochet) | 4 | — | 20 sc + 20 rows | 1.00 |
| [Mini Elephant](https://www.lionbrand.com/products/mini-elephant-amigurumi-crochet), [Axolotl](https://www.lionbrand.com/products/axolotl-amigurumi-crochet) | 4 (plush) | — | 10 sc × 11 rows per 2" → 20 × 22 | 1.10 |
| [Baby Gator](https://www.lionbrand.com/products/baby-gator-amigurumi-crochet) | 4 (24/7 Cotton) | F, 3.75 mm | 9 sc = 2", 10 rows = 2" → 18 × 20 | 1.11 |
| [Amigurumi Fish](https://www.lionbrand.com/products/amigurumi-fish-crochet) | 3 | — | 24 × 24 | 1.00 |
| [Amigurumi S'mores](https://www.lionbrand.com/products/amigurumi-smores-crochet) | 3 | — | 28 sc × 28 rows | 1.00 |
| [Amigurumi Submarine](https://www.lionbrand.com/products/amigurumi-submarine-crochet) | 6 | — | 12 sc + 12 rnds | 1.00 |
| [Fox](https://www.lionbrand.com/products/fox-amigurumi-crochet), [Panda](https://www.lionbrand.com/products/panda-amigurumi-crochet), [Penguin](https://www.lionbrand.com/products/penguin-amigurumi-crochet) | 5 (Feels Like Bliss plush) | 4 mm | 11 sc × 9 rows per 2" → 22 × 18 | 0.82 |

**Geometry check [INFERENCE]:** sc rounds increasing by 6 lie flat only if `6 = 2π·h/w`, i.e. **w/h = 2π/6 = 1.047**. That matches the measured median of about 1.0 to 1.1.

**Defaults [INFERENCE, calibrated in §5]:** amigurumi stitch width per weight, in inches: 1: 0.13 · 2: 0.155 · 3: 0.17 · 4: **0.195** · 5: 0.26 · 6: 0.33 · 7: 0.50. Use `h = w/1.05`. For worsted that is 20.5 sts × 21.5 rnds per 4 in.

---

## 4. Converting finished size to stitch and row counts, and resampling the image

### 4.1 Core formulas

```
w = 4 / S ;  h = 4 / R                     (inches per stitch / per row)
W_grid = W_target − 2·B ;  H_grid = H_target − 2·B      (B = border width per side)
cols = snap( W_grid / w ) ;  rows = snap( H_grid / h )
actual W = cols·w + 2B ;  actual H = rows·h + 2B
```

**Preserving the item's aspect** [INFERENCE]:
1. Crop the image to the subject's bounding box first.
2. Let `a = H_px / W_px`.
3. If the user gives only a width: `H_grid = W_grid · a`. If only a height: `W_grid = H_grid / a`.
4. Compute `cols` and `rows` **independently from w and h**. Never compute `rows = cols · a`; that bakes in a square-cell assumption.
5. Report `aspectErr = (rows·h / (cols·w)) / a − 1`. If |aspectErr| > 2 to 3%, offer ±1 row or column.

The maximum rounding error is ±w/2 horizontally and ±h/2 vertically. For worsted sc that is ±0.15 in × ±0.125 in.

### 4.2 Resampling onto non-square cells [INFERENCE]

Cell (row i, col j) samples the source rectangle `[j·W_px/cols, (j+1)·W_px/cols) × [i·H_px/rows, (i+1)·H_px/rows)`.

These rectangles are **not square in pixel space**, and that is intended: the stitches themselves are not square. Use one of:
- an area-average (box filter) in linear RGB or CIELAB, or
- if colours are quantised first, a **majority vote** of palette labels per cell, which keeps thin stripes and outlines crisp.

The preview must draw each cell at `w × h` (scaled to the screen) so the user sees the true proportions.

**Worked example (sc, worsted, S = 13.5, R = 16; 40 × 50 in blanket; 1200 × 1500 px image):**
- cols = round(40 × 13.5/4) = **135** and rows = round(50 × 16/4) = **200**.
- Each cell samples about 8.9 × 7.5 px.
- A square-cell generator would produce 135 × 169 cells, which crochet up to 40 × 42.3 in: the design comes out **15.5% too short**.

### 4.3 Rounding and snapping conventions

| Situation | Rule | Basis |
|---|---|---|
| Pattern repeats | `cols = m·k + e`, e.g. mosaic "multiple 12 + 3"; snap to the nearest feasible value | [VERIFIED LillaBjörn](https://www.lillabjorncrochet.com/2017/07/nya-mosaic-blanket-free-crochet-pattern.html) |
| Tapestry worked in the round | cols (round count) = a multiple of the motif width | [VERIFIED Ventura](https://www.tapestrycrochet.com/CreativeLivingTapestryCrochet.pdf) |
| Flat rows, colorwork | Row 1 is the right side (RS) and odd rows are read right to left. Keep track of whether the last row is RS or WS | convention [INFERENCE] |
| Overlay mosaic | rows even (colour pairs) | [INFERENCE] from Wikipedia's description |
| C2C | No parity rule. Diagonal rows = cols + rows − 1; the increase phase lasts min(cols, rows) rows | [INFERENCE] |
| Foundation chain, sc | ch N+1, sc in 2nd ch from hook (turning ch 1 not counted) | turning-chain heights [VERIFIED Wikipedia](https://en.wikipedia.org/wiki/List_of_crochet_stitches); counting convention [INFERENCE] |
| Foundation chain, hdc | ch N+1, hdc in 3rd ch (the 2 skipped ch count as a stitch); or N+1 with hdc in 2nd ch if the turning ch is not counted | same |
| Foundation chain, dc | ch N+2, dc in 4th ch (the 3 skipped ch count as the first dc) | same; Yarnspirations states "Ch 3 at beg of row counts as dc" |
| Tss foundation | ch N; the loop on the hook counts as the first stitch | convention [INFERENCE] |
| C2C start | ch 6, dc in 4th ch from hook, dc in each of the last 2 ch | [VERIFIED Bernat](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0502-002575M.pdf) |
| Amigurumi | N_max a multiple of 6 for clean +6 rounds | [INFERENCE] §3.7 |
| Border allowance | Size the grid inside the border. Example: 96 blocks × ⅔ in = 64 in, and the finished throw is "Approximately 67" x 67" square, including edging", so about 1.5 in per side | [VERIFIED Red Heart](https://www.favecrafts.com/Crochet-Afghans/Crochet-Corner-to-Corner-Throw-Pattern-from-Red-Heart-Yarn) → [COMPUTED] |

Foundation chains tend to work up tight. Suggest a foundation-sc row or a hook one size up for the chain. This is common practice [INFERENCE].

### 4.4 When the user picks a different hook but has not made a swatch [INFERENCE]

Scale both dimensions: `w = w0·(hook/hook0)^p`, `h = h0·(hook/hook0)^p` with **p = 0.75 ± 0.25**.
- [That Crochet Life](https://thatcrochetlife.com/why-hook-size-matters/) measured, for one crocheter with #3 yarn, 16 / 19 / 21 / 23 dc per 4 in at 6 / 5 / 4 / 3 mm. A log-log least-squares fit gives p ≈ 0.50 *(fact-check: was "≈ 0.55"; the endpoints alone give 0.52)*.
- Amigurumi practice (worsted at 3.5 mm vs 5 mm) implies p close to 1.
- Show the resulting size range rather than a single number.

---

## 5. Amigurumi sizing

### 5.1 Formulas [INFERENCE: geometry, calibrated on verified patterns]

- **Circumference ↔ stitches:** `C = N · w · s`, where `s` is the stuffing stretch factor. Diameter `D = C/π`.
- **Sphere from a target diameter:** `k = round(π·D / (6·w·s))`, then `N_max = 6k`.
- **Classic sphere layout:**
  - k increase rounds: 6, 12, …, 6k
  - E even rounds
  - k−1 decrease rounds: 6(k−1) down to 6, then close
- **Even rounds:** the meridian must be half the circumference, `π·D/2 = rounds·h`, so `E = round(3k·(w/h) − (2k−1)) ≈ round(1.15k + 1)` when w/h = 1.05.
- **Totals:** `2k−1+E` rounds and `6k² + 6kE` stitches.
- Real patterns use fewer or more even rounds depending on the look they want:
  - 4 even rounds for a 24-st ball ([Mrs Crochet World](https://mrscrochetworld.com/blogs/crochet-blog/how-to-crochet-a-perfect-sphere-amigurumi-ball-formula-2026))
  - 2 for PlanetJune's Fuzzball ([PlanetJune](https://www.planetjune.com/blog/free-crochet-patterns/fuzzballs/))
  - 6 for Lily's 24-st peach ([PDF](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/SCC0334-030366M.pdf))

  Expose a "roundness / squash" parameter.
- **Any surface of revolution** (hand-off to the 3D research):
  - `N_i = round(2π·r(s_i) / (w·s))` at arc length `s_i = (i − ½)·h` along the meridian.
  - Constrain `N_i ≤ 2·N_{i−1}`, since a round can at most double.
  - Keep `|ΔN|` small and evenly distributed. Start from a 6-st magic ring.

### 5.2 Validation against verified patterns

Model: worsted at 3.5 mm, w = 0.195 in, s = 1.05.

| Pattern [VERIFIED] | Yarn, hook | N_max | Stated size | Model D |
|---|---|---|---|---|
| [PlanetJune Beach Ball](https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-beach-ball/) | worsted, 3.5 mm | 42 | "Approx 2.75″ (7cm) diameter" | **2.74 in** ✓ |
| [PlanetJune Citrus](https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-citrus-collection/) | worsted, 3.5 mm | 27 (lime) to 54 (grapefruit); lemon 30, clementine 36, orange 42 | "Approx 2 – 3.5″ (5 – 9cm) diameter" | 1.76 to **3.52 in**: the top end matches, the lime end is 12% under 2″ *(fact-check: was marked ✓ for the whole range)*. Lime and lemon may not be true spheres (unverified). |
| PlanetJune Beach Ball, sport cotton | sport, 2.75 mm | 42 | 2.5″ (6.5 cm) | 2.18 in (−13%). Lighter-weight defaults are less certain. |

So **"a 36-stitch sphere in worsted with a 3.5 mm hook" ≈ 2.35 in (6.0 cm) across**, with 19 rounds and about 504 stitches. [COMPUTED]

### 5.3 How much stuffing stretches the fabric [COMPUTED from VERIFIED patterns, thin evidence]

| Pattern | Gauge and construction | Unstuffed equator | Stated finished | Implied s |
|---|---|---|---|---|
| [Lily "Squeeze a Peach"](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/SCC0334-030366M.pdf) | 13 sc × 14 rows/4 in, 5 mm, cotton worsted; max 24 sc in joined rounds; "Stuff Peach firmly" | 24 × 0.308 = 7.4 in | "Approx 3" [7.5 cm] diameter" (9.4 in) | **≈1.28** |
| [Bernat Beach Ball Toy](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/BRC0234-033203M.pdf) | 10 sc × 9 rows/4 in, 6 mm; 6 panels × 10 sc, mattress-stitched | 24 in less seams (≈21.6) | "Approx 7¾" [19.5 cm] diameter" (24.3 in) | **≈1.01 to 1.13** |
| [Red Heart Baby's First Beach Ball](https://cdn.shopify.com/s/files/1/0711/5132/1403/files/RHC0234-015136M.pdf) | "4 sc = 1"; 4 rows = 1"", 4 mm; 6 panels × 10 sc, back-stitched; "stuff firmly" | 15 in less seams | "13" (33 cm) circumference" | **≈0.87 to 1.0** |

**Defaults [INFERENCE]:**
- `s = 1.05` for tight amigurumi gauge. This is the value that makes PlanetJune's sizes match.
- 1.10 to 1.25 for looser, ball-band-gauge fabric that is firmly stuffed.
- 0.9 to 1.05 for seamed panel constructions, because seams eat width.

Ask users to calibrate with a test ball (§7).

### 5.4 Sphere size table [COMPUTED]

`D = N·w·1.05/π`. Amigurumi widths per weight are from §3.7. Worsted yardage uses L = 6.5·w per stitch and excludes tails.

| N_max | k | Even rnds E | Total rnds | CYC1 D (in) | CYC2 | CYC3 | **CYC4** | CYC5 | CYC6 | Total sts | Worsted yd |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 12 | 2 | 3 | 6 | 0.52 | 0.62 | 0.68 | 0.78 | 1.04 | 1.32 | 60 | 2 |
| 18 | 3 | 4 | 9 | 0.78 | 0.93 | 1.02 | 1.17 | 1.56 | 1.99 | 126 | 4 |
| 24 | 4 | 6 | 13 | 1.04 | 1.24 | 1.36 | 1.56 | 2.09 | 2.65 | 240 | 8 |
| 30 | 5 | 7 | 16 | 1.30 | 1.55 | 1.70 | 1.96 | 2.61 | 3.31 | 360 | 13 |
| 36 | 6 | 8 | 19 | 1.56 | 1.86 | 2.05 | **2.35** | 3.13 | 3.97 | 504 | 18 |
| 42 | 7 | 9 | 22 | 1.82 | 2.18 | 2.39 | **2.74** | 3.65 | 4.63 | 672 | 24 |
| 48 | 8 | 10 | 25 | 2.09 | 2.49 | 2.73 | 3.13 | 4.17 | 5.29 | 864 | 30 |
| 54 | 9 | 11 | 28 | 2.35 | 2.80 | 3.07 | 3.52 | 4.69 | 5.96 | 1080 | 38 |
| 60 | 10 | 12 | 31 | 2.61 | 3.11 | 3.41 | 3.91 | 5.21 | 6.62 | 1320 | 46 |
| 72 | 12 | 15 | 38 | 3.13 | 3.73 | 4.09 | 4.69 | 6.26 | 7.94 | 1944 | 68 |

Uncertainty is about ±10% for CYC 4 (calibrated) and ±20% for the other weights. Scaling sanity check from PlanetJune: a worsted piece at 3.5 mm "is about 3/4 of the size" of the bulky piece at 4.5 mm (here 0.195/0.26 = 0.75 ✓), and doubled yarn on a hook at least 1.7× larger gives "a turtle that's about 1.5 times the size" ([PlanetJune](https://www.planetjune.com/blog/amigurumi-help/resizing-amigurumi/); [Little World of Whimsy](https://littleworldofwhimsy.com/my-foolproof-guide-to-resizing-amigurumi-no-math-required/) repeats this "according to Planet June").

---

## 6. Yarn consumption

### 6.1 Measured data [VERIFIED]

**Stacey Trock (FreshStitches / Shiny Happy World), inches of yarn per single crochet** ([2014 post, chart image](https://www.shinyhappyworld.com/2014/03/how-much-yarn-do-i-need.html)):

| Yarn | Hook | in / sc |
|---|---|---|
| Fingering | 2.75 mm (C) | 1.0 |
| DK | 3.5 mm (E) | 1.5 |
| Worsted | 5.0 mm (H) | 1.8 |
| Bulky | 6.0 mm (J) | 2.5 |
| Bulky | 8.0 mm (L) | 2.75 |
| Super bulky | 25 mm (U) | 7.5 |

From the [2017 follow-up](https://www.shinyhappyworld.com/2017/05/how-much-yarn-does-crochet-use-single-vs-double-crochet.html), with worsted on a 5.0 mm hook working through both loops: **sc 1.8 in/stitch and dc 3.75 in/stitch**, so dc uses 2.08× sc. Her method: "multiply the number of stitches in your pattern by the number of inches each stitch uses". In her example, 1656 sts × 1 in = "46 yards" in fingering.

**Interweave**, all 20 × 20 sts, bulky yarn at 120 yd/100 g, 6 mm hook:

| Stitch | Weight | Size | Area per gram |
|---|---|---|---|
| sc | 19 g | 6.25 × 5.75 in | 1.89 sq in/g |
| hdc | 28 g | 6.75 × 9.25 in | 2.23 sq in/g |
| dc | 38 g | 7 × 13 in | 2.39 sq in/g |
| Stockinette | 9 g | 5.75 × 4.75 in | 3.03 sq in/g |

The article concludes that "stockinette uses about 60% as much yarn as single crochet to cover the same area" ([archived article](http://web.archive.org/web/20250117034756/https://www.interweave.com/article/knitting/yarn-usage-knitting-vs-crochet-experiment/)). Per stitch, after allowing about 0.4 sc-equivalent for each foundation and turning chain, that works out to **sc ≈ 1.97 in, hdc ≈ 2.86 in, dc ≈ 3.81 in**, i.e. hdc/sc ≈ 1.45 and dc/sc ≈ 1.93. [COMPUTED]

**A warning about geometric yarn-path models:** a key-point crochet model predicted 700 mm against a measured "(533 ± 32) mm", and 4026 against "(3621 ± 110) mm". Hand-crocheted fabric used about "(17 ± 8)%" less yarn than the model calculated ([Storck, Gerber, Steenbock & Kyosev, "Topology based modelling of crochet structures", J. Industrial Textiles 52, 2022, CC BY-NC](https://dx.doi.org/10.1177/15280837221139250)). **(unverified)**: the fact-check confirmed the paper, its authors and that the abstract says the model "allows for estimation of the required yarn length". The full text was not reachable (publisher returned 403), so the specific numbers and the "hand-crocheted" detail could not be checked. They are internally consistent: 533/700 is −24%, 3621/4026 is −10%, and the mean is about −17%. **[INFERENCE]** Use empirical constants, not a 3D path length.

### 6.2 The model [INFERENCE fitted to the verified data]

```
L_sc  = K · w_sc,   K = 6.5 in per in of stitch width   (Interweave 6.3; Trock ≈6.0–6.6 against Table A widths — fact-check: was "6.1–7.2", which could not be reproduced) ±15 %
L_hdc = 1.45·L_sc   L_dc = 2.0·L_sc   L_ch ≈ 0.42·L_sc   L_slst ≈ 0.5·L_sc     (ch, sl st: inferred)
L_tile(C2C) = 3·L_dc + 3·L_ch + L_slst ≈ 7.8·L_sc
yd per sq in (sc) = K / (36 · h_sc)
```

**Checking the C2C tile estimate against published patterns.** Blocks are counted from the finished size, so these pattern figures include borders and safety margin:

| Pattern | yd/block from pattern | Model | Pattern ÷ model |
|---|---|---|---|
| Bernat Striped C2C | 0.80 | 0.80 | 1.00 |
| Bernat Do the Wave | 0.99 | 0.80 | 1.23 |
| Red Heart Geometric Steps | 0.72 | 0.51 | 1.41 |
| Bernat Checkerboard (Fluffee) | 0.91 | 0.56 | 1.62 |
| Red Heart C2C Throw (upper bound: whole skeins, 4,928 yd / 9,216 blocks) | 0.53 | 0.47 | 1.14 |

A blogger unravelled one sample block and measured "around 13"" ([Stardust Gold Crochet](https://stardustgoldcrochet.com/c2c-yardage-calculator-how-much-yarn-do-i-need-for-my-c2c-blanket/)); the yarn isn't stated. **Conclusion:** the model is a reasonable *net* estimate. Use a 20% buffer for C2C, plus the border computed separately.

**Do not adopt** the fixed "1 yard (sport), 1.25 (worsted), 1.5 (bulky) per block" rule ([stouto](https://stouto.co.za/crochet-how-to-calculate-yarn-for-a-c2c-project)). It is about 2 to 3× the measured and modelled values.

**Pattern yardages for small items are padded.** Lily's 3 in peach lists "34 yds" for about 243 stitches, roughly 5 in/stitch against 1.8 to 2 in measured. [COMPUTED] So comparing our estimates with published patterns will often show ours as lower. Users need to understand this is expected.

### 6.3 Yardage per colour (R8) [INFERENCE]

```
yards_c = ( Σ_type n_{c,type}·L_type  +  carried_c  +  tails_c·T ) / 36  × (1 + buffer)
```

- **Tapestry (carried strands):** every stitch a strand passes through, worked or not, adds `1.1·w` for each carried colour. Worked tapestry stitches are taller, so use `1.1·L_sc`. With 2 colours this comes to about **+27%** over plain sc, and with 3 colours about **+44%**. The Makebead generator claims "Carrying strands eats 25–40% more yarn than plain single crochet" *(fact-check: the quote was paraphrased as "uses roughly 25–40% more yarn ...")* ([Makebead](https://makebead.com/tapestry-crochet-pattern-maker)); that is their claim, not a measurement.
- **Overlay mosaic:** 2 tails per row, because the yarn is cut at both ends.
- **Intarsia/graphgan bobbins and C2C colour blocks:** 2 tails per colour region per row or diagonal.
- **Tail length** T = 6 in, a common convention.
- **Buffer:** 10% for single-colour plain fabric, 15% as the default, 20% for C2C, tapestry and many small colour areas. Other calculators use 10 to 20% ([stouto](https://stouto.co.za/crochet-how-to-calculate-yarn-for-a-c2c-project)), and StitchSums uses 15% for tapestry and 10% for mosaic **(unverified)**: neither percentage appears in the StitchSums graph-maker article, and no other StitchSums page was checked.
- **Skeins:** `ceil(yards_c / skeinYards(colourway))`. Show grams as well, using `yards ÷ (yd/100 g) × 100`.

### 6.4 How existing tools estimate yarn [VERIFIED descriptions]

| Approach | Example | What it needs |
|---|---|---|
| Per stitch × count | Shiny Happy World (above); [Highland Hickory](https://highlandhickorydesigns.com/yarn-calculator-for-sc-hdc-dc-projects/): "what is the length of yarn used in 5 stitches" | per-stitch length |
| Per C2C block | [Stardust Gold](https://stardustgoldcrochet.com/c2c-yardage-calculator-how-much-yarn-do-i-need-for-my-c2c-blanket/), [MyStress](https://mystressbydesign.weebly.com/c2cyarncalc.html): "Crochet one C2C block ... measure the length of it" | one unravelled block |
| Per area by weighing | Interweave sq in per gram | a swatch weight and the yarn's yd/g |
| Swatch → size only | [Stitch Fiddle calculator](https://www.stitchfiddle.com/en/calculator/chart-size/crochet): swatch size and stitch counts give the chart dimensions | swatch |

---

## 7. Swatch-calibration UX [INFERENCE / design]

**Why it matters:**
- Inter-crocheter spread with the same yarn and hook is about ±11% ([sincerelypam](https://www.sincerelypam.com/gauge-swatches-a-comparison/)).
- Label gauges within one weight category span roughly ±20% (§2.1).
- Stitch Fiddle warns that "Someone else may end up with something different using the same yarn and needles" ([Stitch Fiddle](https://www.stitchfiddle.com/en/calculator/chart-size/crochet)).

**Panel: "Use my gauge"** (one profile per yarn + hook + technique):

1. **Pre-fill** the predicted gauge from Tables A and B, and show the uncertainty band, e.g. "40 in → 36 to 45 in".
2. **Instructions:**
   - Crochet a 6 × 6 in swatch in the *same technique*. For tapestry, carry all the strands you will carry in the project, as Ventura advises.
   - Block it the way the finished item will be treated.
   - Count over the middle 4 in, in a few places.
3. **Input modes** (any one):
   - (a) "__ stitches and __ rows in 4 in or 10 cm"
   - (b) "my swatch of __ sts × __ rows measures __ × __ in or cm" (Stitch Fiddle style)
   - (c) C2C: "__ tiles measure __ in"
   - (d) Amigurumi: "test ball with max __ sts has a circumference of __ in". This gives `w·s` directly, stuffing included.
   - (e) Optional yarn calibration: "unravel 10 stitches: __ in", or "swatch weighs __ g; label says __ yd per __ g".
4. **Derived and displayed:** w, h, stitch aspect, the finished size with exact counts, and the difference from the defaults in %.
5. **Sanity checks:**
   - Warn if a value is outside the CYC range by more than 35%: it may be cm entered as inches, the wrong technique or hook, or UK terms.
   - Warn if `w/h` is outside 0.75 to 1.5 for sc.
   - Warn if rows < stitches for flat sc. That is unusual unless the yarn is a novelty texture or tapestry.
6. **Storage:** save profiles locally, keyed by yarn + hook + technique. A measured swatch overrides every default for that profile. Once measured, show a narrower error band (±3 to 5%: ±0.5 stitch over 4 in at 13 sts is ±3.8%).
7. **Converting a pattern's stated gauge:** normalise spans such as "9 sc = 2"" or "10 cm". Remember that UK "dc" means US sc.

---

## 8. Final default tables to hardcode

### Table A: Base flat sc gauge by CYC weight

| CYC | Default hook | **sc S × R per 4 in** | w × h (in) | w/h | ± (1σ-ish) | Basis | yd/100 g default (range) |
|---|---|---|---|---|---|---|---|
| 0 Lace | 2.25 mm (B-1) | 34 × 40 | 0.118 × 0.100 | 1.18 | ±25% | CYC 32–42 *dc*; no label data, extrapolated | 700 (550–800) |
| 1 Super Fine | 3.25 mm (D-3) | 24 × 28 | 0.167 × 0.143 | 1.17 | ±15% | CYC 21–32; labels 22–24 × 24–30 (n=3) | 400 (330–460) |
| 2 Fine | 4.0 mm (G-6) | 18 × 21 | 0.222 × 0.190 | 1.17 | ±20% | CYC 16–20; aspect from neighbours | 330 (300–380) |
| 3 Light | 4.0 mm (G-6) | 16 × 19 | 0.250 × 0.211 | 1.19 | ±12% | labels n=20, median 16 × 20 | 280 (240–360) |
| 4 Medium | 5.0 mm (H-8) | 13.5 × 16 | 0.296 × 0.250 | 1.19 | ±12% | labels n=45, median 13.2 × 16 | 190 (175–216) |
| 5 Bulky | 6.5 mm (K-10½) | 10.5 × 12 | 0.381 × 0.333 | 1.14 | ±15% | labels n=22, median 10.5 × 12 | 120 (109–159) |
| 6 Super Bulky | 8.0 mm (L-11; CYC says 9–15) | 7.5 × 8.5 | 0.533 × 0.471 | 1.13 | ±15% | labels n=18, median 7 × 8 | 70 (62–89) |
| 7 Jumbo | 15 mm (P/Q) | 4 × 4.2 | 1.00 × 0.95 | 1.05 | ±35% | labels n=5, 2–5.5 sts | 15 (11–32) |

### Table B: Technique transforms (relative to flat sc, same yarn and hook)

| Technique | Width | Height | Aspect w/h | Hook | Evidence | Range |
|---|---|---|---|---|---|---|
| sc (flat rows) / graphgan sc | w | h | 1.18 | base | 91 labels | 1.10–1.25 IQR |
| hdc | 1.05w | 1.5h | ≈0.83 | base | Interweave; 10 designers | h ×1.45–1.65 |
| dc | 1.06w | 2.1h | ≈0.60 | base | Interweave; 3 Yarnspirations pairs | h ×2.0–2.3 |
| C2C tile | 2.6w (square) | = width | 1.0 | base | 6 patterns | 2.0–2.9 × w |
| Tapestry sc, 1 carried strand | w | w/0.88 | 0.88 | base (often smaller) | Ventura, n=5 | 0.84–1.0 |
| + each extra carried strand | — | +5% | — | — | Ventura (qualitative) | unvalidated |
| Tunisian simple stitch | 4/(1.05·S) | w/0.93 | 0.93 | base + 1.5 mm | 5 gauges | 0.80–1.25 |
| Overlay mosaic | w | w/1.3 | 1.3 | base | LillaBjörn ×2 | 1.0–1.5 |
| Amigurumi sc (spiral) | Table E | w/1.05 | 1.05 | CYC min − 2 mm | Lion Brand ×7; PlanetJune; 2π/6 | 0.82–1.11 |

### Table C: Resulting cell sizes in inches (width × height) [COMPUTED from A and B]

| CYC | sc | hdc | dc | C2C tile | Tapestry sc | Tss (hook) | Mosaic | Amigurumi (hook) |
|---|---|---|---|---|---|---|---|---|
| 0 | 0.118 × 0.100 | 0.124 × 0.150 | 0.125 × 0.210 | 0.31 | 0.118 × 0.134 | 0.112 × 0.120 (3.75) | 0.118 × 0.090 | n/a |
| 1 | 0.167 × 0.143 | 0.175 × 0.214 | 0.177 × 0.300 | 0.43 | 0.167 × 0.189 | 0.159 × 0.171 (4.75) | 0.167 × 0.128 | 0.130 × 0.124 (2.0) |
| 2 | 0.222 × 0.190 | 0.233 × 0.286 | 0.236 × 0.400 | 0.58 | 0.222 × 0.253 | 0.212 × 0.228 (5.5) | 0.222 × 0.171 | 0.155 × 0.148 (2.5) |
| 3 | 0.250 × 0.211 | 0.263 × 0.316 | 0.265 × 0.442 | 0.65 | 0.250 × 0.284 | 0.238 × 0.256 (5.5) | 0.250 × 0.192 | 0.170 × 0.162 (2.75) |
| 4 | 0.296 × 0.250 | 0.311 × 0.375 | 0.314 × 0.525 | 0.77 | 0.296 × 0.337 | 0.282 × 0.303 (6.5) | 0.296 × 0.228 | 0.195 × 0.186 (3.5) |
| 5 | 0.381 × 0.333 | 0.400 × 0.500 | 0.404 × 0.700 | 0.99 | 0.381 × 0.433 | 0.363 × 0.390 (8) | 0.381 × 0.293 | 0.260 × 0.248 (4.5) |
| 6 | 0.533 × 0.471 | 0.560 × 0.706 | 0.565 × 0.988 | 1.39 | 0.533 × 0.606 | 0.508 × 0.546 (9.5) | 0.533 × 0.410 | 0.330 × 0.314 (6.0) |
| 7 | 1.000 × 0.952 | 1.050 × 1.429 | 1.060 × 2.000 | 2.60 | 1.000 × 1.136 | 0.952 × 1.024 (16.5) | 1.000 × 0.769 | 0.500 × 0.476 (9.0) |

Spot checks against verified data:
- Worsted C2C 0.77 in vs Red Heart's 0.667 (−13%).
- Bulky C2C 0.99 vs Hygge and Fluffee 1.0 ✓.
- Super bulky C2C 1.39 vs Bernat 1.5 to 1.6 (−10%).
- Worsted hdc 12.9 × 10.7 per 4 in vs 12–15 × 9–11 measured ✓.

### Table D: Yarn per stitch in inches [COMPUTED from the model, ±15% for sc/hdc/dc, ±35% for C2C]

| CYC | sc | hdc | dc | C2C tile | yd per sq in (sc fabric) |
|---|---|---|---|---|---|
| 0 | 0.76 | 1.11 | 1.53 | 5.9 | 1.81 |
| 1 | 1.08 | 1.57 | 2.17 | 8.4 | 1.26 |
| 2 | 1.44 | 2.09 | 2.89 | 11.2 | 0.95 |
| 3 | 1.62 | 2.36 | 3.25 | 12.6 | 0.86 |
| 4 | 1.93 | 2.79 | 3.85 | 14.9 | 0.72 |
| 5 | 2.48 | 3.59 | 4.95 | 19.2 | 0.54 |
| 6 | 3.47 | 5.03 | 6.93 | 26.9 | 0.38 |
| 7 | 6.50 | 9.42 | 13.0 | 50.4 | 0.19 |

Cross-checks: worsted sc 1.93 vs Trock's 1.8 ✓; bulky sc 2.48 vs Trock's 2.5 (6 mm) ✓; worsted dc 3.85 vs Trock's 3.75 ✓. For amigurumi, use `6.5 × w_ami`, about 1.27 in for worsted at 3.5 mm.

### Table E: Amigurumi defaults

| CYC | Hook | w (in) | sts/4 in | h = w/1.05 | rnds/4 in | Stuffing s | Basis |
|---|---|---|---|---|---|---|---|
| 1 | 2.0–2.25 mm | 0.130 | 30.8 | 0.124 | 32.3 | 1.05 | inference; [Tiny Curl](https://www.tinycurl.co/amigurumi-hook-size/) hook |
| 2 | 2.5 mm | 0.155 | 25.8 | 0.148 | 27.1 | 1.05 | PlanetJune sport beach ball (model −13%) |
| 3 | 2.75 mm | 0.170 | 23.5 | 0.162 | 24.7 | 1.05 | Lion Brand DK 24 × 24, 28 × 28 |
| 4 | 3.5 mm | **0.195** | 20.5 | 0.186 | 21.5 | 1.05 | PlanetJune 42 → 2.75 in, 54 → 3.5 in; Lion Brand 18–20 × 20–22 |
| 5 | 4.5 mm | 0.260 | 15.4 | 0.248 | 16.2 | 1.05 | PlanetJune "3/4 of the size" ratio |
| 6 | 6.0 mm | 0.330 | 12.1 | 0.314 | 12.7 | 1.05 | Lion Brand Submarine 12 × 12 |
| 7 | 8–10 mm | 0.500 | 8.0 | 0.476 | 8.4 | 1.05 | low confidence |

The stuffing factor `s` ranges from 0.9 (seamed panels) to 1.28 (loose gauge, firmly stuffed).

---

## 9. Exact formulas (TypeScript sketch)

```ts
// ===== units =====
export const CM_PER_IN = 2.54;
export const per4in = (countPer10cm: number) => countPer10cm * 10.16 / 10; // exact

// ===== Table A =====
export type Cyc = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface Base { sts4: number; rows4: number; hookMm: number; ydPer100g: number; tol: number }
export const CYC_BASE: Record<Cyc, Base> = {
  0: { sts4: 34,   rows4: 40,  hookMm: 2.25, ydPer100g: 700, tol: 0.25 },
  1: { sts4: 24,   rows4: 28,  hookMm: 3.25, ydPer100g: 400, tol: 0.15 },
  2: { sts4: 18,   rows4: 21,  hookMm: 4.0,  ydPer100g: 330, tol: 0.20 },
  3: { sts4: 16,   rows4: 19,  hookMm: 4.0,  ydPer100g: 280, tol: 0.12 },
  4: { sts4: 13.5, rows4: 16,  hookMm: 5.0,  ydPer100g: 190, tol: 0.12 },
  5: { sts4: 10.5, rows4: 12,  hookMm: 6.5,  ydPer100g: 120, tol: 0.15 },
  6: { sts4: 7.5,  rows4: 8.5, hookMm: 8.0,  ydPer100g: 70,  tol: 0.15 },
  7: { sts4: 4,    rows4: 4.2, hookMm: 15,   ydPer100g: 15,  tol: 0.35 },
};
// ===== Table E =====
export const AMI: Record<Exclude<Cyc, 0>, { wIn: number; hookMm: number }> = {
  1: { wIn: 0.13, hookMm: 2.25 }, 2: { wIn: 0.155, hookMm: 2.5 }, 3: { wIn: 0.17, hookMm: 2.75 },
  4: { wIn: 0.195, hookMm: 3.5 }, 5: { wIn: 0.26, hookMm: 4.5 }, 6: { wIn: 0.33, hookMm: 6.0 }, 7: { wIn: 0.5, hookMm: 9 },
};
export const AMI_ASPECT = 1.05, AMI_STRETCH = 1.05;

export type Technique = 'sc' | 'graphgan_sc' | 'hdc' | 'dc' | 'c2c' | 'tapestry_sc' | 'tss' | 'mosaic_overlay' | 'amigurumi_sc';
export interface Cell { w: number; h: number }            // inches per stitch (w) and per row/round (h)
export interface Swatch { sts: number; rows: number; spanIn: number } // user-measured, same technique

export function cell(cyc: Cyc, tech: Technique, o: { hookMm?: number; carried?: number; swatch?: Swatch } = {}): Cell {
  if (o.swatch) return { w: o.swatch.spanIn / o.swatch.sts, h: o.swatch.spanIn / o.swatch.rows }; // measured wins
  const b = CYC_BASE[cyc];
  // default hook per technique: Tss = base + 1.5 mm; amigurumi = Table E; others = base
  const refHook = tech === 'tss' ? b.hookMm + 1.5 : b.hookMm;
  const f = o.hookMm && tech !== 'amigurumi_sc' ? Math.pow(o.hookMm / refHook, 0.75) : 1; // §4.4, inference
  const w = (4 / b.sts4) * f, h = (4 / b.rows4) * f;
  switch (tech) {
    case 'sc': case 'graphgan_sc': return { w, h };
    case 'hdc': return { w: w * 1.05, h: h * 1.5 };
    case 'dc':  return { w: w * 1.06, h: h * 2.1 };
    case 'c2c': { const t = 2.6 * w; return { w: t, h: t }; }
    case 'tapestry_sc': return { w, h: (w / 0.88) * (1 + 0.05 * Math.max(0, (o.carried ?? 1) - 1)) };
    case 'tss': { const wt = (4 / (1.05 * b.sts4)) * f; return { w: wt, h: wt / 0.93 }; }
    case 'mosaic_overlay': return { w, h: w / 1.3 };
    case 'amigurumi_sc': {
      const a = AMI[(cyc || 1) as Exclude<Cyc, 0>];
      const fa = o.hookMm ? Math.pow(o.hookMm / a.hookMm, 0.75) : 1;
      return { w: a.wIn * fa, h: (a.wIn * fa) / AMI_ASPECT };
    }
    default: throw new Error(`unknown technique ${tech}`);
  }
}

// ===== grid sizing (2D) =====
export interface Mult { m: number; plus: number }          // e.g. mosaic {m:12, plus:3}
const snap = (x: number, k?: Mult) =>
  !k ? Math.max(1, Math.round(x)) : Math.max(0, Math.round((x - k.plus) / k.m)) * k.m + k.plus;

export function grid(c: Cell, req: { wIn?: number; hIn?: number; imgW: number; imgH: number; borderIn?: number;
                                     cols?: Mult; rows?: Mult }) {
  const a = req.imgH / req.imgW, B = req.borderIn ?? 0;   // a = subject aspect AFTER cropping
  let Wg = req.wIn !== undefined ? req.wIn - 2 * B : undefined;
  let Hg = req.hIn !== undefined ? req.hIn - 2 * B : undefined;
  if (Wg !== undefined && Hg === undefined) Hg = Wg * a;
  if (Hg !== undefined && Wg === undefined) Wg = Hg / a;
  const cols = snap(Wg! / c.w, req.cols), rows = snap(Hg! / c.h, req.rows); // independent axes!
  const actualW = cols * c.w + 2 * B, actualH = rows * c.h + 2 * B;
  const aspectErr = ((rows * c.h) / (cols * c.w)) / a - 1;
  return { cols, rows, actualW, actualH, aspectErr };
}
// Resample: cell (i,j) <- box-average / palette-majority of src rect
// [j*imgW/cols,(j+1)*imgW/cols) x [i*imgH/rows,(i+1)*imgH/rows)  (non-square in px: intended)

// ===== yarn =====
export const K_SC = 6.5;                                     // in of yarn per in of sc width (±15 %)
export const MULT = { sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 } as const;
export const Lsc = (wScIn: number, calibratedLscIn?: number) => calibratedLscIn ?? K_SC * wScIn;
export const c2cTileIn = (lsc: number) => lsc * (3 * MULT.dc + 3 * MULT.ch + MULT.slst); // ≈ 7.76·Lsc
export function colourYards(o: { stitches: Partial<Record<keyof typeof MULT, number>>; lsc: number;
  carriedStitchPasses?: number; wIn?: number; tails?: number; tailIn?: number; buffer?: number; tapestry?: boolean }) {
  let inches = 0;
  for (const [t, n] of Object.entries(o.stitches)) inches += (n ?? 0) * o.lsc * MULT[t as keyof typeof MULT] * (o.tapestry ? 1.1 : 1);
  inches += (o.carriedStitchPasses ?? 0) * 1.1 * (o.wIn ?? 0);  // tapestry: stitches this colour is carried through
  inches += (o.tails ?? 0) * (o.tailIn ?? 6);
  return (inches / 36) * (1 + (o.buffer ?? 0.15));
}
export const skeins = (yards: number, skeinYards: number) => Math.ceil(yards / skeinYards);

// ===== amigurumi =====
export function sphere(dIn: number, wIn: number, aspect = AMI_ASPECT, s = AMI_STRETCH) {
  const k = Math.max(2, Math.round((Math.PI * dIn) / (6 * wIn * s)));
  const E = Math.max(0, Math.round(3 * k * aspect - (2 * k - 1)));
  return { Nmax: 6 * k, k, evenRounds: E, rounds: 2 * k - 1 + E, stitches: 6 * k * k + 6 * k * E,
           dActualIn: (6 * k * wIn * s) / Math.PI };
}
export function roundsForProfile(radiusAtArc: (sIn: number) => number, meridianIn: number, c: Cell, s = AMI_STRETCH) {
  const n = Math.max(2, Math.round(meridianIn / c.h));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let N = Math.round((2 * Math.PI * radiusAtArc(((i + 0.5) * meridianIn) / n)) / (c.w * s));
    N = Math.max(i === 0 ? 6 : 3, N);
    if (i > 0) N = Math.min(N, 2 * out[i - 1]);              // a round can at most double
    out.push(N);
  }
  return out;  // then distribute inc/dec evenly and stagger them (3D research)
}
```

---

## 10. Edge cases and failure modes

1. **Square-cell assumption** gives ±15 to 18% distortion for sc and about 33% for knit-like rendering. Using the sc aspect for **tapestry** is off by 1.18/0.88, about 34%, in the *opposite* direction. Technique must be part of the gauge key.
2. **Unit and terminology mistakes:** cm entered as inches; "per 2 in" gauges; UK "dc" meaning US sc. Normalise and range-check against Table A ±35%.
3. **Novelty yarns** (chenille, faux fur, bouclé, velvet, plush): labels often show square gauges (w/h ≈ 1.0) and stitches are hard to see. Warn that detail will blur, and suggest fewer cells and colours.
4. **Small charts:** fewer than about 20 cells across a motif loses features. Show a "detail at this size" preview, and suggest a larger size or a finer yarn.
5. **Rounding near snapping constraints** such as "multiple 12 + 3" can move the size by up to half a repeat (about 1.8 in in worsted). Show the actual size, and let the user choose between the two neighbouring counts.
6. **Tapestry in the round:** the half-stitch slant per round makes diagonals look different (Ventura's Star of David example). Note it in v1 and model it in v2. Extra carried strands make stitches taller (Ventura).
7. **Amigurumi:**
   - Stretch depends on how firmly the piece is stuffed and on the gauge; loose gauge gives up to +28% (Lily peach).
   - Spiral colour changes produce a jog.
   - Stacking increases in the same place produces hexagons, so stagger them.
   - The +6 rule assumes w/h ≈ 1.05. Taller stitches need more increases per round (§3.2).
8. **Yardage:**
   - Colourway-dependent skein sizes (Super Saver 364 vs 236 yd).
   - Pattern yardages include padding (§6.2).
   - Geometric models overestimate. Storck reports measured yarn about 17 ± 8% *below* the model (unverified, §6.1). The old "+17%" wording reversed the reference: 17% below the model is about +20% over the measurement.
   - Tails dominate in mosaic and intarsia.
9. **Blocking and relaxation** change gauge. Ask users to measure a swatch treated the way the item will be.
10. **Very large charts:** C2C diagonal count is cols + rows − 1. Warn above about 300 columns for render time and practicality.

---

## 11. Open questions to check with real swatches

- Tapestry height increase per additional carried strand: is it about 5% per strand? Swatch with 1, 2 and 3 carried strands.
- Tss aspect when hook +1 mm vs +2 mm; and Tss yarn per stitch (no measurement found; assume ≈1.35 × L_sc ± 30%).
- Amigurumi stretch `s` at tight gauge: crochet 24-, 36- and 48-st balls in worsted at 3.5 mm, stuff them to "firm", and measure the circumference.
- C2C yarn per tile in DK and worsted: unravel 5 tiles.
- CYC 0 and CYC 2 crochet label data: none was found, and both rows of Table A are interpolated.

---

## Appendix A: Manufacturer sc gauge dataset (113 yarns, read 2026-09-30)

Each yarn name links to its product page; the gauge is the page's "Crochet Gauge (4in x 4in)" field. w/h = rows ÷ sts.

| CYC | Brand | Yarn | sc/4in | rows/4in | w/h | Hook mm |
|---|---|---|---|---|---|---|
| 1 | Lion Brand | [Sock-Ease](https://www.lionbrand.com/products/sock-ease-yarn) | 24 | 30 | 1.25 | 3.25 |
| 1 | Patons | [Kroy Socks](https://www.yarnspirations.com/products/patons-kroy-socks-yarn) | 22 | 24 | 1.09 | 3.25 |
| 1 | Red Heart | [Amigurumi](https://www.yarnspirations.com/products/red-heart-amigurumi-yarn) | 22 | 24 | 1.09 | 2.25 |
| 3 | Bernat | [Baby Sport](https://www.yarnspirations.com/products/bernat-baby-sport-yarn) | 16 | 19 | 1.19 | 4 |
| 3 | Bernat | [Softee Baby](https://www.yarnspirations.com/products/bernat-softee-baby-yarn) | 16 | 19 | 1.19 | 4 |
| 3 | Bernat | [Softee Cotton](https://www.yarnspirations.com/products/bernat-softee-cotton-yarn) | 16 | 20 | 1.25 | 4 |
| 3 | Caron | [Simply Me Merino](https://www.yarnspirations.com/products/caron-simply-me-merino-100g-3-5oz) | 16 | 17 | 1.06 | 5 |
| 3 | Lion Brand | [Babysoft](https://www.lionbrand.com/products/babysoft-yarn) | 16 | 20 | 1.25 | 4 |
| 3 | Lion Brand | [Coboo](https://www.lionbrand.com/products/coboo-yarn) | 18 | 20 | 1.11 | 4 |
| 3 | Lion Brand | [Comfy Cotton Blend](https://www.lionbrand.com/products/comfy-cotton-blend-yarn) | 13 | 16 | 1.23 | 6 |
| 3 | Lion Brand | [Cottino](https://www.lionbrand.com/products/cottino-yarn) | 17 | 25 | 1.47 | 4 |
| 3 | Lion Brand | [Ice Cream](https://www.lionbrand.com/products/ice-cream-yarn) | 16 | 20 | 1.25 | 5 |
| 3 | Lion Brand | [Ice Cream Big Scoop](https://www.lionbrand.com/products/ice-cream-big-scoop-yarn) | 16 | 20 | 1.25 | 5 |
| 3 | Lion Brand | [LB Collection Superwash Merino](https://www.lionbrand.com/products/lb-collection-superwash-merino-yarn) | 16 | 20 | 1.25 | 5 |
| 3 | Lion Brand | [Mandala](https://www.lionbrand.com/products/mandala-yarn) | 16 | 20 | 1.25 | 5 |
| 3 | Lion Brand | [Modern Baby](https://www.lionbrand.com/products/modern-baby-yarn) | 16 | 19 | 1.19 | 6 |
| 3 | Lion Brand | [Truboo](https://www.lionbrand.com/products/truboo-yarn) | 18 | 20 | 1.11 | 4 |
| 3 | Lion Brand | [Wool-Ease DK](https://www.lionbrand.com/products/wool-ease-dk-yarn) | 16 | 18 | 1.12 | 4 |
| 3 | Patons | [Astra](https://www.yarnspirations.com/products/patons-astra-yarn) | 15 | 16 | 1.07 | 4 |
| 3 | Patons | [Beehive Baby Sport](https://www.yarnspirations.com/products/patons-beehive-baby-sport-yarn) | 16 | 19 | 1.19 | 3.75 |
| 3 | Patons | [Grace](https://www.yarnspirations.com/products/patons-grace-yarn) | 21 | 24 | 1.14 | 3.75 |
| 3 | Patons | [Linen](https://www.yarnspirations.com/products/patons-linen-yarn) | 17 | 22 | 1.29 | 4 |
| 3 | Red Heart | [Cotton Breeze](https://www.yarnspirations.com/products/red-heart-cotton-breeze-yarn-155g-5-5oz) | 17 | 20 | 1.18 | 4.5 |
| 4 | Bernat | [Future Recycled Cotton](https://www.yarnspirations.com/products/bernat-future-recycled-cotton-yarn-170g-6oz) | 14 | 16 | 1.14 | 5 |
| 4 | Bernat | [Handicrafter Cotton](https://www.yarnspirations.com/products/bernat-handicrafter-cotton-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Bernat | [Super Value](https://www.yarnspirations.com/products/bernat-super-value-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Caron | [All Day Cotton](https://www.yarnspirations.com/products/caron-all-day-cotton-yarn-100g-3-5oz) | 14 | 17 | 1.21 | 5 |
| 4 | Caron | [Big Cakes](https://www.yarnspirations.com/products/caron-big-cakes-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Caron | [Cakes](https://www.yarnspirations.com/products/caron-cakes-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Caron | [Cotton Cakes](https://www.yarnspirations.com/products/caron-cotton-cakes-yarn-250g-8-8oz) | 14 | 17 | 1.21 | 5 |
| 4 | Caron | [Jumbo](https://www.yarnspirations.com/products/caron-jumbo-yarn) | 12 | 13 | 1.08 | 5 |
| 4 | Caron | [One Pound](https://www.yarnspirations.com/products/caron-one-pound-yarn) | 12 | 13 | 1.08 | 5 |
| 4 | Caron | [Simply Soft](https://www.yarnspirations.com/products/caron-simply-soft-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Lily | [Sugar'n Cream Original](https://www.yarnspirations.com/products/lily-sugarn-cream-the-original-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Lion Brand | [Basic Stitch Anti-Pilling](https://www.lionbrand.com/products/basic-stitch-anti-pilling-yarn) | 16 | 18 | 1.12 | 5 |
| 4 | Lion Brand | [Basic Stitch Premium](https://www.lionbrand.com/products/basic-stitch-premium-yarn) | 11 | 14 | 1.27 | 6 |
| 4 | Lion Brand | [Color Theory](https://www.lionbrand.com/products/color-theory-yarn) | 14 | 20 | 1.43 | 5.5 |
| 4 | Lion Brand | [Cotton-Hemp](https://www.lionbrand.com/products/cotton-hemp-yarn) | 13 | 15.5 | 1.19 | 4 |
| 4 | Lion Brand | [DIY Glow Cozy](https://www.lionbrand.com/products/diy-glow-cozy-yarn) | 14 | 16 | 1.14 | 5.5 |
| 4 | Lion Brand | [Feels Like Butta](https://www.lionbrand.com/products/feels-like-butta) | 16 | 19 | 1.19 | 4 |
| 4 | Lion Brand | [Ferris Wheel](https://www.lionbrand.com/products/ferris-wheel-yarn) | 14 | 20 | 1.43 | 5 |
| 4 | Lion Brand | [Fishermen's Wool](https://www.lionbrand.com/products/fishermens-wool-yarn) | 16 | 16 | 1.00 | 5 |
| 4 | Lion Brand | [Heartland](https://www.lionbrand.com/products/heartland-yarn) | 12 | 15 | 1.25 | 6 |
| 4 | Lion Brand | [Jeans](https://www.lionbrand.com/products/jeans-yarn) | 14 | 20 | 1.43 | 5.5 |
| 4 | Lion Brand | [Kitchen Cotton](https://www.lionbrand.com/products/kitchen-cotton) | 14 | 16 | 1.14 | 5 |
| 4 | Lion Brand | [Local Grown Cotton](https://www.lionbrand.com/products/local-grown-cotton-yarn) | 14 | 20 | 1.43 | 5.5 |
| 4 | Lion Brand | [Mandala Gradient](https://www.lionbrand.com/products/mandala-gradient-yarn) | 14 | 18 | 1.29 | 5.5 |
| 4 | Lion Brand | [Mandala Ombre](https://www.lionbrand.com/products/mandala-ombre-yarn) | 14 | 20 | 1.43 | 5.5 |
| 4 | Lion Brand | [Nuboo](https://www.lionbrand.com/products/nuboo-yarn) | 17 | 20 | 1.18 | 5.5 |
| 4 | Lion Brand | [Pound of Love](https://www.lionbrand.com/products/pound-of-love-yarn) | 14 | 18 | 1.29 | 6 |
| 4 | Lion Brand | [Re-Make](https://www.lionbrand.com/products/re-make-yarn) | 13 | 16 | 1.23 | 5 |
| 4 | Lion Brand | [Re-Up](https://www.lionbrand.com/products/re-up-yarn) | 15 | 16 | 1.07 | 5.5 |
| 4 | Lion Brand | [Schitt's Creek](https://www.lionbrand.com/products/schitts-creek-yarn) | 16 | 18 | 1.12 | 5 |
| 4 | Lion Brand | [Vanna's Choice](https://www.lionbrand.com/products/vannas-choice-yarn) | 12 | 15 | 1.25 | 6 |
| 4 | Lion Brand | [Wool-Ease](https://www.lionbrand.com/products/wool-ease-yarn) | 13.2 | 16 | 1.21 | 6 |
| 4 | Lion Brand | [Wool-Ease Roving Origins](https://www.lionbrand.com/products/wool-ease-roving-origins-yarn) | 12 | 16 | 1.33 | 6 |
| 4 | Patons | [Canadiana](https://www.yarnspirations.com/products/patons-canadiana-yarn) | 14 | 17 | 1.21 | 5 |
| 4 | Patons | [Evermore](https://www.yarnspirations.com/products/patons-evermore-yarn-100g-3-5oz) | 15 | 16 | 1.07 | 4 |
| 4 | Peaches & Creme | [Solids](https://www.yarnspirations.com/products/peaches-creme-solids-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Phentex | [Worsted](https://www.yarnspirations.com/products/phentex-worsted-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Red Heart | [Baby Hugs Medium](https://www.yarnspirations.com/products/red-heart-baby-hugs-medium-yarn) | 14 | 14 | 1.00 | 6.5 |
| 4 | Red Heart | [Classic](https://www.yarnspirations.com/products/red-heart-classic-yarn) | 12 | 15 | 1.25 | 5.5 |
| 4 | Red Heart | [Comfort](https://www.yarnspirations.com/products/red-heart-comfort-yarn) | 13 | 17 | 1.31 | 5.5 |
| 4 | Red Heart | [Mini](https://www.yarnspirations.com/products/red-heart-mini-yarn) | 13 | 14 | 1.08 | 5 |
| 4 | Red Heart | [Scrubby](https://www.yarnspirations.com/products/red-heart-scrubby-yarn) | 13 | 15 | 1.15 | 5.5 |
| 4 | Red Heart | [Soft](https://www.yarnspirations.com/products/red-heart-soft-yarn) | 12 | 15 | 1.25 | 5.5 |
| 4 | Red Heart | [Super Saver](https://www.yarnspirations.com/products/red-heart-super-saver-yarn) | 12 | 15 | 1.25 | 5.5 |
| 4 | Red Heart | [With Love](https://www.yarnspirations.com/products/red-heart-with-love-yarn) | 14 | 14 | 1.00 | 6.5 |
| 5 | Bernat | [Cottage](https://www.yarnspirations.com/products/bernat-cottage-yarn-200g-7oz) | 9 | 10 | 1.11 | 8 |
| 5 | Bernat | [Maker](https://www.yarnspirations.com/products/bernat-maker-yarn-250g-8-8oz) | 10 | 11 | 1.10 | 8 |
| 5 | Bernat | [Pipsqueak](https://www.yarnspirations.com/products/bernat-pipsqueak-yarn) | 7 | 8 | 1.14 | 8 |
| 5 | Bernat | [Velvet](https://www.yarnspirations.com/products/bernat-velvet-yarn) | 10 | 11 | 1.10 | 6.5 |
| 5 | Caron | [Colorama Halo](https://www.yarnspirations.com/products/caron-colorama-halo-yarn-220g-8oz) | 12 | 14 | 1.17 | 6 |
| 5 | Caron | [Simply Me](https://www.yarnspirations.com/products/caron-simply-me-160g-5-64oz) | 13 | 16 | 1.23 | 5.5 |
| 5 | Lion Brand | [Feels Like Cuddles](https://www.lionbrand.com/products/feels-like-cuddles-yarn) | 12 | 14 | 1.17 | 6 |
| 5 | Lion Brand | [Feels Like Sherpa](https://www.lionbrand.com/products/feels-like-sherpa-yarn) | 6 | 6 | 1.00 | 10 |
| 5 | Lion Brand | [Feels Like a Dream](https://www.lionbrand.com/products/feels-like-a-dream-yarn) | 12 | 14 | 1.17 | 6 |
| 5 | Lion Brand | [Homespun](https://www.lionbrand.com/products/homespun-yarn) | 10 | 10 | 1.00 | 6.5 |
| 5 | Lion Brand | [Hue + Me](https://www.lionbrand.com/products/hue-me-yarn) | 10 | 11 | 1.10 | 6.5 |
| 5 | Lion Brand | [Jiffy](https://www.lionbrand.com/products/jiffy-yarn) | 10 | 12 | 1.20 | 6.5 |
| 5 | Lion Brand | [Scarfie](https://www.lionbrand.com/products/scarfie-yarn) | 11 | 14 | 1.27 | 6.5 |
| 5 | Lion Brand | [Wool-Ease Chunky](https://www.lionbrand.com/products/wool-ease-chunky-yarn) | 10 | 11 | 1.10 | 6.5 |
| 5 | Patons | [Classic Wool Roving](https://www.yarnspirations.com/products/patons-classic-wool-roving-yarn) | 10 | 11 | 1.10 | 6 |
| 5 | Patons | [Lincoln Fog](https://www.yarnspirations.com/products/patons-lincoln-fog-yarn) | 11.5 | 14 | 1.22 | 5.5 |
| 5 | Red Heart | [Comfort Chunky](https://www.yarnspirations.com/products/red-heart-comfort-chunky-yarn) | 11 | 12 | 1.09 | 6.5 |
| 5 | Red Heart | [Dreamy](https://www.yarnspirations.com/products/red-heart-dreamy-yarn) | 11 | 13 | 1.18 | 6.5 |
| 5 | Red Heart | [Hygge](https://www.yarnspirations.com/products/red-heart-hygge-yarn) | 11 | 13 | 1.18 | 6.5 |
| 5 | Red Heart | [Soft Essentials](https://www.yarnspirations.com/products/red-heart-soft-essentials-yarn) | 11 | 13 | 1.18 | 6.5 |
| 5 | Red Heart | [Super Saver Chunky](https://www.yarnspirations.com/products/red-heart-super-saver-chunky-yarn) | 10 | 11 | 1.10 | 8 |
| 5 | Red Heart | [With Love Chunky](https://www.yarnspirations.com/products/red-heart-with-love-chunky-yarn) | 11 | 13 | 1.18 | 6.5 |
| 6 | Bernat | [Baby Blanket](https://www.yarnspirations.com/products/bernat-baby-blanket-yarn) | 7 | 8 | 1.14 | 8 |
| 6 | Bernat | [Big Ball Chunky](https://www.yarnspirations.com/products/bernat-big-ball-chunky-400g-14oz) | 8 | 9 | 1.12 | 8 |
| 6 | Bernat | [Blanket](https://www.yarnspirations.com/products/bernat-blanket-yarn) | 7 | 8 | 1.14 | 8 |
| 6 | Bernat | [Forever Fleece](https://www.yarnspirations.com/products/bernat-forever-fleece-yarn) | 8 | 9 | 1.12 | 9 |
| 6 | Bernat | [Softee Chunky](https://www.yarnspirations.com/products/bernat-softee-chunky-yarn-100g-3-5oz) | 8 | 9 | 1.12 | 8 |
| 6 | Bernat | [Velvet Plus](https://www.yarnspirations.com/products/bernat-velvet-plus-yarn) | 7 | 7 | 1.00 | 9 |
| 6 | Caron | [All Day Wool](https://www.yarnspirations.com/products/caron-all-day-wool-yarn-170g-6oz) | 7 | 8 | 1.14 | 9 |
| 6 | Caron | [Chunky Cakes](https://www.yarnspirations.com/products/caron-chunky-cakes-yarn) | 8 | 9 | 1.12 | 8 |
| 6 | Lion Brand | [Cover Story 300g](https://www.lionbrand.com/products/cover-story-300g-yarn) | 6.5 | 6 | 0.92 | 9 |
| 6 | Lion Brand | [Cover Story Favorite Blanket](https://www.lionbrand.com/products/cover-story-favorite-blanket-yarn) | 7 | 8 | 1.14 | 8 |
| 6 | Lion Brand | [Go For Faux](https://www.lionbrand.com/products/go-for-faux-yarn) | 8 | 8 | 1.00 | 9 |
| 6 | Lion Brand | [Hometown](https://www.lionbrand.com/products/hometown-yarn) | 6.6 | 8 | 1.21 | 9 |
| 6 | Lion Brand | [Wool-Ease Aire](https://www.lionbrand.com/products/wool-ease-aire-yarn) | 9 | 10 | 1.11 | 6 |
| 6 | Lion Brand | [Wool-Ease Thick & Quick](https://www.lionbrand.com/products/wool-ease-thick-and-quick-yarn) | 6.6 | 8 | 1.21 | 9 |
| 6 | Patons | [Cobbles](https://www.yarnspirations.com/products/patons-cobbles-yarn) | 6 | 7 | 1.17 | 10 |
| 6 | Patons | [Highland Bulky](https://www.yarnspirations.com/products/patons-highland-bulky-yarn) | 8 | 9 | 1.12 | 8 |
| 6 | Red Heart | [Evermore](https://www.yarnspirations.com/products/red-heart-evermore-yarn) | 9 | 10 | 1.11 | 8 |
| 6 | Red Heart | [Sweet Home](https://www.yarnspirations.com/products/red-heart-sweet-home-yarn) | 7 | 8 | 1.14 | 10 |
| 7 | Bernat | [Blanket Big](https://www.yarnspirations.com/products/bernat-blanket-big-yarn-300g-10-5oz) | 2 | 2 | 1.00 | 25 |
| 7 | Bernat | [Blanket Extra](https://www.yarnspirations.com/products/bernat-blanket-extra-yarn-300g-10-5oz) | 4 | 4 | 1.00 | 15 |
| 7 | Bernat | [Blanket Extra Thick](https://www.yarnspirations.com/products/bernat-blanket-extra-thick-yarn-600g-21-2oz) | 2 | 2 | 1.00 | 25 |
| 7 | Red Heart | [Grande](https://www.yarnspirations.com/products/red-heart-grande-yarn) | 5.5 | 6.5 | 1.18 | 11.5 |
| 7 | Red Heart | [Irresistible](https://www.yarnspirations.com/products/red-heart-irresistible-yarn) | 3 | 3 | 1.00 | 15 |

Notes:
- Yarnspirations writes decimals with a hyphen, e.g. "11-5 sc" = 11.5. CYC categories are as each page labels them.
- Excluded as typos: Red Heart It's a Wrap (22 sc × 15 r), Red Heart Chic Sheep (16 sc × 28 r).

## Appendix B: Primary sources consulted

- Craft Yarn Council: [yarn weight system](https://www.craftyarncouncil.com/standards/yarn-weight-system), [hooks](https://www.craftyarncouncil.com/standards/hooks-and-needles), [WPI](https://www.craftyarncouncil.com/standards/how-measure-wraps-inch-wpi), [abbreviations / UK terms](https://www.craftyarncouncil.com/standards/crochet-abbreviations)
- [Ravelry yarn weights](https://www.ravelry.com/help/yarn/weights) · Wikipedia: [Yarn weight](https://en.wikipedia.org/wiki/Yarn_weight), [List of crochet stitches](https://en.wikipedia.org/wiki/List_of_crochet_stitches), [Mosaic crochet](https://en.wikipedia.org/wiki/Mosaic_crochet)
- Lion Brand and Yarnspirations product and pattern pages and pattern PDFs (linked inline and in Appendix A)
- [Interweave yarn-usage experiment (archived)](http://web.archive.org/web/20250117034756/https://www.interweave.com/article/knitting/yarn-usage-knitting-vs-crochet-experiment/) · Shiny Happy World [2014](https://www.shinyhappyworld.com/2014/03/how-much-yarn-do-i-need.html) and [2017](https://www.shinyhappyworld.com/2017/05/how-much-yarn-does-crochet-use-single-vs-double-crochet.html) · [Storck et al. 2022](https://dx.doi.org/10.1177/15280837221139250)
- [sincerelypam gauge comparison](https://www.sincerelypam.com/gauge-swatches-a-comparison/) · [That Crochet Life](https://thatcrochetlife.com/why-hook-size-matters/)
- Carol Ventura: [graph papers article](https://www.tapestrycrochet.com/CreativeLivingTapestryCrochet.pdf), Ravelry patterns ([wallet](https://www.ravelry.com/patterns/library/tapestry-crochet-wallet), [laptop bag](https://www.ravelry.com/patterns/library/tapestry-laptop-bag), [heart](https://www.ravelry.com/patterns/library/tapestry-crochet-heart)), [amulet](https://www.carolventura.com/amulet.html)
- LillaBjörn [Nya](https://www.lillabjorncrochet.com/2017/07/nya-mosaic-blanket-free-crochet-pattern.html), [Nya Infinity](https://www.lillabjorncrochet.com/2019/07/nya-infinity-mosaic-blanket.html)
- Tunisian: [TL Yarn Crafts](https://tlycblog.com/how-to-make-a-tunisian-crochet-temperature-blanket/), [Winding Road](https://www.windingroadcrochet.com/how-to-tunisian-crochet-gauge/), [Jen Hayes](https://www.jenhayescreations.com/diamonds-in-tunisian-crochet-bag/), [YarnAndy](https://yarnandy.com/tunisian-simple-stitch-detailed-tutorial/)
- PlanetJune: [beach ball](https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-beach-ball/), [citrus](https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-citrus-collection/), [fuzzballs](https://www.planetjune.com/blog/free-crochet-patterns/fuzzballs/), [resizing](https://www.planetjune.com/blog/amigurumi-help/resizing-amigurumi/), [tension](https://www.planetjune.com/blog/stitch-tension-in-amigurumi-an-investigation/) · [Tiny Curl](https://www.tinycurl.co/amigurumi-hook-size/) · [Little World of Whimsy](https://littleworldofwhimsy.com/my-foolproof-guide-to-resizing-amigurumi-no-math-required/)
- Generators and calculators, checked for how they handle gauge and yarn: [Stitch Fiddle help](https://www.stitchfiddle.com/en/help/1pe1-ftobtg/gauge-proportions) and [calculator](https://www.stitchfiddle.com/en/calculator/chart-size/crochet), [KnitPro](https://www.microrevolt.org/knitPro/), [Makebead](https://makebead.com/tapestry-crochet-pattern-maker), [StitchSums](https://www.stitchsums.com/calculators/stitch-aspect-ratio), [Stardust Gold](https://stardustgoldcrochet.com/c2c-yardage-calculator-how-much-yarn-do-i-need-for-my-c2c-blanket/), [MyStress](https://mystressbydesign.weebly.com/c2cyarncalc.html), [stouto](https://stouto.co.za/crochet-how-to-calculate-yarn-for-a-c2c-project), [Highland Hickory](https://highlandhickorydesigns.com/yarn-calculator-for-sc-hdc-dc-projects/)

---

## Verification notes

Adversarial fact-check, 2026-09-30. Sources were re-read directly by fetching the live page, the PDF text or the raw Wikipedia source. Every formula and table was recomputed by hand or by script.

### What was checked and held up

- **Claim 1 (CYC):** the whole §1.1 table was re-read from craftyarncouncil.com, including the row header "Crochet Gauge* Ranges in Single Crochet to 4 inch", the "GUIDELINES ONLY" footnote, lace given as "32–42 double crochets", the lace and steel-hook quotes, and the fact that no row gauges are given. The CYC hook table (§1.4) and the WPI table and quotes (§1.2) also match.
- **Claim 2 (label dataset):** all **113/113** Appendix A rows were re-scraped from the live Lion Brand and Yarnspirations pages. Every stitch count, row count and hook matches. The two excluded "typos" are real page values: It's a Wrap is 22 sc × 15 r at 3.25 mm, and Chic Sheep is 16 sc × 28 r. Recomputed: all-113 median w/h 1.143, mean 1.161, IQR 1.09–1.22. Excluding novelty yarns gives a median of about 1.18 and an IQR of 1.10–1.25. The per-CYC medians and ranges in §2.1 match exactly. The knit stockinette ratio was recomputed from the same 113 pages: median **1.333**, p10–p90 1.25–1.44 ✓. The Super Saver, Simply Soft, Vanna's Choice and Red Heart Soft quotes ✓. The Super Saver colourway put-ups are 364 yd solids and 236 yd prints ✓.
- **Claim 3 (Ventura):** the gauges, hooks and yarns of the wallet, laptop bag and heart were confirmed on Ravelry, and Ventura is the designer of all three. The Reversible Basket gauge (10 sts / 9 rows per inch, 2 mm steel, Aunt Lydia's size 3) and all four quotes were confirmed in the Creative Living PDF. The amulet gauge (4 × 4 per inch, felted, "K" hook) ✓. The median w/h of 0.88 is recomputed ✓.
- **Claim 4 (C2C):** confirmed the Red Heart C2C Throw ("6 blocks = 4"; 6 rows = 4" in pattern", H/8 5 mm, 96 blocks, 67" incl. edging, 4+5 solid + 7 print skeins = 4,928 yd), Bernat Striped ("1 Block = Approx 1½"", 8 mm), Chevron / Do the Wave ("2.5 blocks = 4"", 7 dc × 4 rows, 8 mm), Hygge ("4 blocks = 4" in pat", 11 dc × 6 rows, 6.5 mm), Fluffee ("4 blocks = Approx 4"", 10 sc × 12 rows, 8 mm), Daisy (15 sc × 16 rows, 4 mm, 39 blocks, 32") and the C2C start wording, all from the PDFs. The tile/w ratios 2.0, 2.8, 2.6, 2.5, 2.75 and 2.9 were recomputed ✓. The yd/block figures (0.80, 0.99, 0.72, 0.91, 0.53) were recomputed from the pattern yardages ✓.
- **Claim 5 (Interweave):** the archived article by Amy Gunderson (22 May 2023) was fetched. It used Universal Yarn Deluxe Chunky at 6 mm, 20 × 20. The sc, hdc, dc and stockinette sizes, grams and sq in/g all match, and so do the "about 60%" and "each taller stitch to be a bit wider" quotes. Ravelry confirms 120 yd/100 g. Ratios 1.61× and 2.26× ✓. The per-stitch back-calculation (1.97 / ≈2.86 / 3.81 in) reproduces to within about 2% with 0.4 sc-equivalents per chain.
- **Claim 6 (sincerelypam):** ten crocheters, Red Heart Soft, I/5.5 mm, hdc. Results were 12–15 sts and 9–11 rows ✓, which is ±11% around 13.5 ✓.
- **Claim 7 (Trock):** the 2014 chart image was read: 1 / 1.5 / 1.8 / 2.5 / 2.75 / 7.5 in at C / E / H / J / L / U ✓. The 2017 image gives sc 1.8 and dc 3.75 in/stitch, using an "H (5.0mm) hook, worsted weight yarn and crocheting through both loops" ✓. 1656 sts × 1 in = 46 yd ✓.
- **Claim 8 (hooks):** the PlanetJune and Tiny Curl quotes were confirmed verbatim. Tiny Curl's rule applies to weights 2–5 ✓.
- **Claim 9 (amigurumi gauges):** confirmed on the Lion Brand pattern pages: Armadillo 20+20, Gator 9 sc = 2" / 10 rows = 2" with an F hook in 24/7 Cotton, Fish 24 × 24, S'mores 28 × 28, Submarine 12+12 rnds, Elephant/Axolotl 10 sc × 11 rows per 2", and Fox/Panda/Penguin 11 sc × 9 rows per 2" with a 4 mm hook in Feels Like Bliss. The identity w/h = 2π/6 = 1.047 holds for a circular flat disc.
- **Claim 10 (PlanetJune spheres):** confirmed: beach ball "Approx 2.75″ (7cm)", max 42 sts, E/3.5 mm; sport-cotton version 2.5″ at C/2.75 mm; citrus "Approx 2 – 3.5″", maxima 27–54. Model: 42 × 0.195 × 1.05 / π = 2.737 in ✓ and 36 → 2.346 in ✓.
- **Claim 11 (stuffing stretch):** confirmed from the PDFs. Peach: 13 sc × 14 rows, 5 mm, max 24 sc, 6 even rounds, "Stuff Peach firmly", 34 yds, and 243 stitches by count. Bernat ball: 10 sc × 9 rows, 6 mm, Blanket O'Go, 6 panels at 10 sc max, mattress st, 7¾″. Red Heart ball: 4 sc / 4 rows per inch, 4 mm, 6 sections at 10 sc max, back stitch, "stuff firmly", 13″ circumference. The implied s values 1.28, 1.01–1.13 and 0.87–1.0 were recomputed ✓.
- **Claim 12 (yardage):** the Paper Moon Knits and Purple Lamb ranges were confirmed verbatim, including the wool caveat. The medians were re-derived from the live pages (see the note under §1.5).
- **Claim 14 (tools):** KnitPro offers "Needlepoint, Cross Stitch, Crochet (1:1)", "Knit Portrait (5:7)" and "Knit Landscape (7:5)" ✓. The Stitch Fiddle help and calculator quotes ✓, and the Willow Crochet quote ✓.
- **Other sources:** LillaBjörn's Nya and Nya Infinity gauges and multiples ✓. The four Tunisian gauges and the YarnAndy quotes ✓. Wikipedia's turning-chain counts and mosaic quotes ✓. The CYC US/UK terms ✓. Mrs Crochet World (4 even rounds at 24) ✓ and PlanetJune Fuzzball (2 even rounds at 24) ✓. The PlanetJune tension quote ✓. Bernat Blooming Blossom "9 dc in 4th ch from hook (counts as 10 dc)" ✓. The stouto per-block rule and 10–20% buffer ✓. Stardust "around 13″" with no yarn stated ✓. The MyStress and Highland Hickory method quotes ✓. That Crochet Life's #3 yarn and 16/19/21/23 sts ✓.
- **Arithmetic recomputed:** the §4.2 worked example (135 × 200; 169 rows, 42.25 in, 15.5% short). The §5.1 E formula and the whole §5.4 table (k, E, total rounds, total stitches, D for every weight, worsted yards). Tables C and D cell by cell for CYC 0, 4 and 7. The C2C tile multiplier 7.76, the tapestry +27% / +44%, and yd per sq in = K/(36h). Also ±3.8%, 1.18/0.88 = 1.34, and the half-repeat of 1.78 in. All are consistent.

### What changed

1. §1.1: the super bulky median label hook was "8 mm"; it is now **8.5 mm**, matching Appendix A and §2.1.
2. §1.2: the Ravelry Lace WPI was "32–34". Ravelry lists no WPI for Lace; 32–34 is its knit gauge.
3. §1.3: the "Wikipedia shifts UK 4 ply → CYC 2" conflict was **wrong**, because Wikipedia maps UK 4 ply → CYC 1. The real conflict is that Ravelry maps Light Fingering (3 ply) → CYC 0, while Wikipedia maps it → CYC 1. The table rows were corrected to match.
4. §2.2: the StitchSums quote was corrected to verbatim.
5. §3.4: the laptop-bag gauge was "8 sc = 1"; 7 rnds = 1"", "steel". Ravelry gives "8 stitches and 7 rows = 1 inch", 2.25 mm (B).
6. §3.7 and §0.4: the hook-offset sentence said the CYC minimum is below the label hooks, which is backwards. It now reads 1.75–2 mm below the CYC minimum and 1.25–2 mm below the median label hook.
7. §4.4: the That Crochet Life exponent was p ≈ 0.55; the fit gives **≈ 0.50**.
8. §5.2: the citrus row was marked ✓ for the whole range. The low end (lime, 1.76 in) is 12% under the stated 2″.
9. §5.4: the "1.5 times the size" quote is PlanetJune's, so it is now attributed to PlanetJune, with Little World of Whimsy as a secondary source.
10. §6.1: the Storck figures are marked **(unverified)**, and the full citation was added.
11. §6.2: the Trock K range "6.1–7.2" could not be reproduced; it is now ≈6.0–6.6.
12. §6.3: the Makebead quote was corrected to verbatim. The StitchSums 15% / 10% buffers are marked **(unverified)**.
13. §10.8: the Storck direction was fixed. Measured is about 17% *below* the model, which is not the same as the model being "+17%".
14. §1.5: added the yd/100 g re-derivation note. The IQRs are approximate.

### Remaining doubts

- **Storck et al. numbers** (533 ± 32 mm vs 700, 3621 ± 110 vs 4026, 17 ± 8%) and the "hand-crocheted" detail are unverified, because the publisher returned 403.
- **The "91 smooth yarns" split** cannot be reproduced exactly, because the exclusion list is not published. A plausible 23-yarn exclusion gave n = 90, median 1.179 and IQR 1.10–1.25, which is consistent. Publish the exact list in Appendix A.
- **The §1.5 yardage IQRs** depend on which colourway put-up is used. The medians are robust.
- **Geometry, §3.7:** w/h = 2π/6 assumes the flat piece stays circular. When increases are stacked the piece turns hexagonal, and then the perimeter is 6 × side = 4√3 × apothem ≈ 6.93 × apothem. That implies w/h ≈ 1.15. The true value for real work is between 1.05 and 1.15.
- **§5.1, E formula:** it assumes stuffing stretch `s` acts equally in both directions; if stretch is mainly circumferential, rounds should scale by `s` too (≈ +1 round at k = 6). [INFERENCE]
- **§3.5 Tss median:** the median of the five listed values is 0.94, not 0.93. This does not matter in practice.
- **Inferences still unvalidated against swatches:** the hdc/dc width and height multipliers, the +5% per extra carried strand, L_ch and L_slst, Tss yarn use, the amigurumi widths for CYC 1/2/5/6/7 (CYC 5 rests only on PlanetJune's "3/4 of the size" ratio), and the hook-scaling exponent p (a single crocheter).
- Several Ventura gauges are for thread or fingering cotton, so the 0.88 aspect may not transfer to worsted acrylic tapestry work. Only one worsted example (the heart) gives 0.88.
