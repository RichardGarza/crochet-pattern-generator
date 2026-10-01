# 07: Pattern Writing Conventions

*Research note for Crochet Pattern Generator. Compiled 2026-09-30.*
*Scope: how professionally written crochet patterns are structured and worded, and the formatter and validator rules our generator needs for flat colorwork (R1), C2C, and amigurumi (R2, R3, R8).*

**Legend.** Every claim carries one of two tags.

- **[V] VERIFIED**: I read it in the linked source during this research. Quotes are verbatim or near-verbatim from that page or PDF.
- **[I] INFERENCE / RECOMMENDATION**: our own reasoning, design choice or derivation. Where an inference is arithmetic (stitch counts, C2C tile counts, compression output), a script checked it, and it is marked *(machine-checked)*.

Gauge math, yardage and size conversion are covered in a separate research note in this folder. This note covers only how those numbers are *written*.

---

## 0. Summary: decisions this note supports

1. **Vocabulary.** Use the Craft Yarn Council (CYC) US abbreviation list as the canonical vocabulary. Render UK terms from the same pattern model through a terminology table, never by find-and-replace on text (§1.3).
2. **Every line ends with a stitch count.** CYC's designer guidelines ask for counts after every row or round that increases or decreases (a minimum, not an "only"; *fact-check: was "CYC requires counts only after…"*), but practitioners and tech editors recommend counts on every line. Counts are what let a maker, and our validator, check the work (§2, §7).
3. **Two output dialects from one model.** "Amigurumi compact" looks like `Rnd 3: (sc, inc) x 6 (18)`. "US verbose" looks like `Rnd 3: [Sc in next st, 2 sc in next st] 6 times. (18 sts)`.
4. **Define the ambiguous shorthand in Notes.** `N op` means *op worked into each of the next N stitches*. `inc` means *2 sc in the same stitch*. Designers genuinely disagree on what "2 sc" means (§6.4).
5. **Validate before rendering.** For every line, the stitches consumed must equal the previous count, and the stitches produced must equal the stated count (§7.3).
6. **Repeat compression** uses an O(L³) shortest-encoding dynamic program. It generalizes AmiGo's "loop folding" idea: sequences before single-stitch runs, then identical rows folded into ranges. It allows at most one level of brackets and respects *segment hints*, so geometry and color blocks stay readable (§7.4; *fact-check: cross-reference was §7.5, which is the rendering table*).
7. **Flat charts.** For right-handers, RS rows (odd) are read right to left and WS rows (even) left to right. A left-handed rendering changes the reading order, not the chart (§3).
8. **C2C.** Start at the bottom-right corner. Odd rows go ↙ (RS) and even rows go ↗ (WS). Each row's start and end action comes from W and H, over W+H−1 rows. Every row line carries an explicit action tag (§4).
9. **Amigurumi defaults.**
   - Continuous spiral, a marker, and a magic ring.
   - Invisible decrease and staggered increases.
   - Change color on the last yarn over of the previous stitch.
   - Warn about the jog in striped and BLO rounds.
   - Close with the "Ultimate Finish".
   - Give eye and limb positions as "between Rnds a and b, k sts apart" relative to the marker (§6).

---

## 1. Standards and terminology

### 1.1 CYC abbreviations (US)

- [V] The CYC master list states: "These definitions reflect U.S. crochet terminology." It also says that "designers and publishers may use special abbreviations in a pattern … Generally, a definition of special abbreviations is given at the beginning of a book or pattern." ([CYC Standards & Guidelines PDF, 2018, p.1](https://media.craftyarncouncil.com/sites/default/files/images/standards/CYC_YarnStandards-2018-11-06.pdf); [CYC crochet abbreviations page](https://www.craftyarncouncil.com/standards/crochet-abbreviations))
- [V] The table below is the subset of that list our generator will emit. Meanings are CYC's.

| Abbr | CYC meaning | Our use |
|---|---|---|
| approx | approximately | sizes, yardage |
| beg | begin/beginning | C2C, notes |
| bet | between | assembly ("bet Rnds 10 and 11") |
| BL or BLO / FL or FLO | back / front loop (only) | flat-bottom and edge rounds |
| CC / MC | contrasting / main color | prefer letters A, B, C… (see note) |
| ch / ch- / ch-sp | chain stitch / "refer to chain or space previously made, e.g., ch-1 space" / chain space | C2C "ch-3 sp" |
| cont | continue | |
| dc | double crochet | C2C tiles |
| dec / inc | decrease / increase | amigurumi (we define precisely, §6.5) |
| hdc | half double crochet | |
| lp | loop | |
| m, pm, sm | marker, place marker, slip marker | spiral rounds |
| rem, rep | remaining, repeat | |
| rnd | round | |
| RS / WS | right side / wrong side | flat rows, C2C |
| sc / sc2tog | single crochet / single crochet 2 stitches together | |
| sk | skip | |
| sl st | slip stitch | |
| sp, st(s) | space, stitch(es) | |
| tch or t-ch | turning chain | |
| tog, yo | together, yarn over | |

- [V] "MC" means "main colour" in some patterns and "magic circle" in others. Hookabee warns: "MC can mean 'main colour' or 'magic circle', so be aware!" ([Hookabee, How to read amigurumi patterns, Part 1](https://hookabee.com/2016/03/01/how-to-read-amigurumi-patterns-abbreviations/))
- [I] To avoid that clash we use **MR** for magic ring and **A/B/C…** for colors, and never print "MC".
- [I] Terms that are *not* on the CYC list and must appear under "Special stitches": **MR** (magic ring), **invdec** (invisible decrease), **C2C tile**, **sc BLO round**.

### 1.2 Punctuation

- [V] The CYC "Terms" table in the 2018 PDF (p.2) defines these marks:
  - `*`: "repeat the instructions following the single asterisk as directed"
  - `* *`: "repeat instructions between asterisks as many times as directed or repeat at specified locations"
  - `{ }` and `[ ]`: "work instructions within brackets as many times as directed"
  - `( )`: "work instructions within parentheses as many times as directed **or** work a group of stitches all in the same stitch or space"
- [V] CYC's "How to Read a Crochet Pattern" page gives these examples ([CYC](https://www.craftyarncouncil.com/standards/how-to-read-crochet-pattern)):
  - `[sk next dc, shell in next dc] 4 times`
  - `Row 3: Dc in next 3 sts; *ch 1, skip next st, dc in next st; rep from * across row`
  - End-of-row counts written as "14 sc", "(14 sc)" or "—14 sc".
- [V] Kim Werker advises: "use (parentheses) to group a set of instructions to be worked together one time, and [square brackets] to indicate a set of instructions that's to be repeated." ([kimwerker.com, Part 3: The Language](https://www.kimwerker.com/2015/11/24/write-crochet-pattern-part-3-language/))
  - Her examples: `(dc, ch 1, dc) in next ch-1 sp` and `[(v-st, ch 1) in each ch-1 space] 2 times`.
  - Her stitch counts follow an em dash ("turn—2 v-sts").
  - She says to put `turn` *consistently* at either the end or the start of rows.
- [V] Amigurumi designers mostly use parentheses with a multiplier:
  - PlanetJune: `(2 sc in next st, sc in next st) six times. (18 st)` ([PlanetJune balloons](https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-balloons/))
  - Hookabee: `(3sc, Inc) *6` (unverified: not found on re-fetch of Hookabee Part 2, which shows `(inc, 1 sc) 6 times (18)`)
  - AmiGo: `(sc, inc, 2sc)*3`, with counts as `[22]` ([AmiGo, SCF '22](https://arxiv.org/abs/2211.01178))
- [I] **Our rule.** CYC lets `( )` mean either "repeat" or "all in the same stitch".
  - The amigurumi dialect never puts a same-stitch group in parentheses. It uses named stitches (`inc`, `inc3`) instead, so `( ) x n` always means a repeat there.
  - The US-verbose dialect follows Werker: `[ ] n times` for repeats and `( ) in next st` for same-stitch groups.
  - In both dialects, the stitch count is always the last token on the line.

### 1.3 US vs UK terminology

- [V] CYC's table of term differences between the U.S., U.K. and Canada (2018 PDF p.2; the same table is on the [abbreviations page](https://www.craftyarncouncil.com/standards/crochet-abbreviations#term-differences)):

| U.S./Canada | U.K. |
|---|---|
| slip stitch (sl st) | slip stitch (ss) |
| single crochet (sc) | double crochet (dc) |
| half double crochet (hdc) | half treble (htr) |
| double crochet (dc) | treble (tr) |
| treble (tr) | double treble (dtr) |
| double treble (dtr) | triple treble (trtr) |
| gauge | tension (U.K./Canada) |
| yarn over (yo) | yarn over hook (yoh) (U.K./Canada) |

- [V] Wikipedia lists the same ladder. It says U.S. terminology is "used in America and Canada" and U.K. terminology is used "across Europe, India, Australia, and others." ([List of crochet stitches](https://en.wikipedia.org/wiki/List_of_crochet_stitches))
- [I] Common UK terms *not* in CYC's table, which we did not verify against a primary source (keep them configurable):
  - skip → "miss"
  - yo → "yrh" (yarn round hook)
  - trtr → "quadruple treble"
- [I] The decrease names follow the ladder: sc2tog→dc2tog, hdc2tog→htr2tog, dc2tog→tr2tog. Post stitches follow it too: FPdc→FPtr, FPsc→FPdc.
- [I] **Implementation.** Render from the pattern model with a `Terminology` dictionary (`us`, `uk`). For imported text, the only safe conversion is a one-pass, longest-match tokenizer. Sequential find-and-replace corrupts the result. *(machine-checked)*

```
US input:   Row 2: Ch 3 (counts as dc), dc in next st, sc2tog, hdc in next 2 sts, sl st in last st. Gauge: 16 sc = 4".
One-pass:   Row 2: Ch 3 (counts as tr), tr in next st, dc2tog, htr in next 2 sts, ss in last st. Tension: 16 dc = 4".
            (fact-check: was "Gauge: 16 dc"; CYC's table maps gauge→tension, so a full one-pass converter changes it too)
Naive sc→dc then dc→tr:  ... tr in next st, tr2tog, ... 16 tr = 4"    <-- WRONG (double-converted)
```

- [I] Always print "US terms" or "UK terms" in the pattern header. A UK "dc" is a US "sc", so an unlabeled pattern is unusable.

### 1.4 Skill levels

- [V] The **current CYC Project Levels** cover knit and crochet together ([CYC project levels](https://www.craftyarncouncil.com/standards/project-levels); 2018 PDF p.12):
  - **1 Basic**: "Projects using basic stitches. May include basic increases and decreases."
  - **2 Easy**: "Projects may include simple stitch patterns, color work, and/or shaping."
  - **3 Intermediate**: "Projects may include involved stitch patterns, color work, and/or shaping."
  - **4 Complex**: "Projects may include complex stitch patterns, color work, and or/shaping using a variety of techniques and stitches simultaneously."
- [V] **Legacy crochet-specific levels** (CYC 2015 PDF p.3) still appear on many published patterns ([CYC 2015 PDF](http://media.craftyarncouncil.com/files/CYC_YS_s_and_g_rev2015_6.pdf)):
  - **Beginner**: "Projects for first-time crocheters using basic stitches. Minimal shaping."
  - **Easy**: "Projects using yarn with basic stitches, repetitive stitch patterns, simple color changes, and simple shaping and finishing."
  - **Intermediate**: "Projects using a variety of techniques, such as basic lace patterns or color patterns, mid-level shaping and finishing."
  - **Experienced**: "Projects with intricate stitch patterns, techniques and dimension, such as non-repeating patterns, multi-color techniques, fine threads, small hooks, detailed shaping and refined finishing."
- [V] The 2015 designer standards say to "indicate what skill level you think the project requires and insert the appropriate symbol at the beginning of the pattern."
- [V] CYC asks anyone using its symbol artwork to give the credit line "Source: Craft Yarn Council's www.YarnStandards.com". The 2018 PDF also asks publishers to e-mail CYC.
  - [I] So we draw our own level and yarn-weight icons. If we ever embed CYC artwork, we add the credit line.
- [I] **Level heuristic.** Each feature adds points. The app shows the reasons and the user can override the result.

| Feature | Points |
|---|---|
| Colors: 2 / 3–4 / ≥5 | 0 / 1 / 2 |
| Mean color changes per row or round: ≤2 / 3–6 / >6 | 0 / 1 / 2 |
| Technique: stripes / tapestry carry / intarsia bobbins / C2C / mosaic | 0 / 1 / 2 / 1 / 2 |
| Amigurumi pieces: 1 / 2–4 / ≥5 | 0 / 1 / 2 |
| Irregular shaping (non-6-multiple rounds, ovals), BLO/FLO details | +1 each |

Map the total: 0–1 → Basic, 2–3 → Easy, 4–5 → Intermediate, ≥6 → Complex.

### 1.5 CYC chart symbols

- [V] The CYC key says "For the most part each symbol represents a stitch as it looks on the right side of the work. Always refer to the pattern key for additional symbol definitions." ([CYC Crochet Chart Symbols PDF](https://media.craftyarncouncil.com/files/CYCACrochetChartSymbols.pdf); [web page](https://www.craftyarncouncil.com/standards/crochet-chart-symbols))
- [V] Glyphs as drawn in the key:

| Stitch | Glyph |
|---|---|
| chain (ch) | small horizontal oval |
| slip stitch (sl st) | small filled dot |
| single crochet (sc) | **X or +** ("Both symbols are commonly used for single crochet") |
| hdc | "T" (vertical stem with a top bar) |
| dc | T with **one** diagonal tick across the stem |
| tr / dtr | T with **two** / **three** ticks |
| sc2tog / sc3tog | two / three sc legs meeting at one top point |
| dc2tog / dc3tog | two / three dc stems meeting under one top bar |
| 3-dc cluster | three dc stems inside an oval outline |
| 3-hdc cluster / puff st / bobble | oval outline enclosing stems |
| 5-dc popcorn | five stems inside a rounded outline |
| 5-dc shell | five dc fanning out from one base point |
| ch-3 picot | small closed loop with a dot |
| FPdc / BPdc | dc whose foot is a hook curving one way / the other way |
| worked in BLO / FLO | small arc ⌒ / ⌣ "at base of stitch being worked" |

- [V] Charts in rounds: "you follow the symbols around in an anti-clockwise direction"; left-handers "work the same stitches in a clockwise direction instead." ([Simply Crochet / simply-yarn guide](https://simply-yarn.com/guides/how-to-crochet/how-to-read-crochet-charts))
- [I] The CYC key has no glyph for **inc** (2 sc in one stitch), **MR** or **invdec**, so our key must define them:
  - inc: two sc glyphs fanning from one base, consistent with how the key draws the 5-dc shell.
  - invdec: the sc2tog glyph.
  - MR: a ring at the chart center.
  - Color graphs use filled squares with a legend, not stitch glyphs.

### 1.6 Materials vocabulary: yarn weights and hook sizes

- [V] The CYC yarn weight system ([web](https://www.craftyarncouncil.com/standards/yarn-weight-system)). The crochet gauge column is the number of sc in 4 in / 10 cm.

| # | Name | Typical yarns | sc / 4" | Hook (metric) | Hook (US) |
|---|---|---|---|---|---|
| 0 | Lace | fingering, 10-count thread | 32–42 dc | steel 1.6–1.4 mm / regular 2.25 mm | steel 6–8 / B-1 |
| 1 | Super Fine | sock, fingering, baby | 21–32 | 2.25–3.5 mm | B-1 to E-4 |
| 2 | Fine | sport, baby | 16–20 | 3.5–4.5 mm | E-4 to 7 |
| 3 | Light | DK, light worsted | 12–17 | 4.5–5.5 mm | 7 to I-9 |
| 4 | Medium | worsted, afghan, aran | 11–14 | 5.5–6.5 mm | I-9 to K-10½ |
| 5 | Bulky | chunky, craft, rug | 8–11 | 6.5–9 mm | K-10½ to M-13 |
| 6 | Super Bulky | super bulky, roving | 7–9 | 9–15 mm | M-13 to Q |
| 7 | Jumbo | jumbo, roving | ≤6 | ≥15 mm | Q and larger |

- [V] The 2018 PDF (p.22) differs from the web table only for category 1, where the hook range is 2.25–3.25 mm (while still listing US B-1 to E-4; E-4 is 3.5 mm). It also names category 6's yarns "Bulky, Roving". CYC calls all of these "GUIDELINES ONLY". *(fact-check: was "slightly narrower ranges, for example…", which implied several categories differ)*
- [V] Hook letters (2018 PDF p.27):

| mm | 2.25 | 2.75 | 3.25 | 3.5 | 3.75 | 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| US | B-1 | C-2 | D-3 | E-4 | F-5 | G-6 | 7 | H-8 | I-9 | J-10 | K-10½ | L-11 | M/N-13 | N/P-15 |

- [V] CYC adds: "Because letter and number sizing vary from company to company, rely on the package millimeter (mm) sizing."
- [V] Published amigurumi patterns use hooks smaller than the CYC range for the yarn:
  - Red Heart's Lion amigurumi uses worsted Super Saver with a US H/8 (5 mm) hook ([Yarnspirations](https://www.yarnspirations.com/products/red-heart-lion-amigurumi)).
  - PlanetJune's balloons use worsted yarn with an E hook.
  - [I] So amigurumi mode should default the hook below the CYC range for the chosen weight. The gauge note owns the exact offset.

---

## 2. Structure of the pattern document

- [V] **CYC Designer Guidelines, "The pattern"** (2018 PDF pp.33–34). The guidance that applies to us:
  - "Indicate the type of yarn used, put-up (skein/ball yardage and weight), fiber content, the number of skeins/balls required … and yarn amounts for each size."
  - "Indicate Yarn Weight Symbols using the Yarn Standards."
  - "If the yarn is used doubled, make sure to note this in the gauge as well as in the pattern."
  - "note all needle or hook sizes in millimeter and U.S. sizes."
  - "List all materials required … (… stitch markers, buttons [number and size], crochet hooks, tapestry needle) … with specific sizes and quantities noted."
  - "Use standard abbreviations, punctuations, and pattern language whenever possible. If you use a technique that is not widely known, make sure to provide a definition and/or a good online reference."
  - "For accessories, list the finished dimensions of the project. Make sure the measurements match the gauge(s) given in the pattern."
  - "Use the Standards & Guidelines Project Level chart … to determine the difficulty level."
  - **"Provide stitch counts after every row/round that contains an increase or decrease."**
  - "Indicate pattern repeats on charts. Number chart rows."
  - "If a project … has sides that are mirror images of one another, write out complete shaping directions for both sides."
  - "Be sure to mention finishing details such as … fasten off … If the piece is assembled in an unusual way, provide sketches, a diagram or step-by-step photos."
  - "Use the recommended industry symbols to create charts for stitch or color (intarsia) patterns."
- [V] The CYC 2015 version adds:
  - "Indicate right side/wrong side, right side/left side."
  - "ALWAYS DOUBLE CHECK YOUR MATH!"
  - The gauge convention for motifs: "Usually with motifs, rounds are listed. For example, a motif that requires 9 rounds would be stated as: Rounds 1–9 = 5"."
- [V] CYC's sample supply list (2018 PDF p.29) shows the expected format:
  - "Size U.S. E/4 (3.5 mm) crochet hook or size needed to obtain gauge"
  - "Stuffing"
  - "Tapestry needle"
- [V] Amigurumi practice ([cbfiberworks, How to Write Your Own Amigurumi Patterns](https://cbfiberworks.com/how-to-start-creating-your-own-crochet-patterns/)):
  - A title page, then "Materials, Stitch Abbreviations, Gauge (if applicable), and Project Notes."
  - "Break your pattern into logical sections … Head, Body, Arms x2, Legs x2."
  - A dedicated assembly section.
  - "include your stitch counts at the end in parentheses."
- [V] A tech editor's list of required sections: "Materials & Tools", "Gauge & Size Information", "Abbreviations", "Instructions by section", and "Finishing & Assembly". The editor adds: "Always include stitch counts at the end of each row/round." ([Artisan Tech Editor](https://techeditor.co.uk/write-clear-crochet-patterns/))
- [V] The finished-size format on a major publisher's pattern: "Approx 9" [23 cm] tall by 5" [12.5 cm] wide, including Legs." (Red Heart Lion, Yarnspirations)

[I] **Our section order and field rules.** Each section is a typed block in the export.

| # | Section | Rules |
|---|---|---|
| 1 | Title + "US terms" / "UK terms" | always state the terminology |
| 2 | Skill level | CYC 1–4 name and the heuristic's reasons (§1.4) |
| 3 | Finished size | `Approx W" (cm) wide × H" (cm) tall`. Amigurumi gives height and widest width. Round inches to ¼ and cm to 0.5. |
| 4 | Materials | **Yarn**: weight category + name, per color: `A (Cream): approx 145 yd (133 m)`. Include a buy-quantity line (yardage × 1.15, rounded up to whole skeins once the user enters the put-up). **Hook**: `US G-6 (4 mm), or size needed to obtain gauge`. **Notions**, only those used: fiberfill stuffing, safety eyes (pair, size in mm), stitch marker(s), tapestry/yarn needle, pins, bobbins (count per color for intarsia/C2C), embroidery thread. |
| 5 | Gauge | Flat: `N sc and M rows = 4" (10 cm)`. C2C: `N tiles = 4" (10 cm)`. Amigurumi: `Rnds 1–6 = 2" (5 cm) diameter`, CYC's motif convention, plus "work tightly so stuffing does not show". |
| 6 | Notes | Mode-specific boilerplate (§3.6, §4.7, §6.12), each line linked to a help page |
| 7 | Abbreviations + Special stitches | only those used. Definitions of `N op`, `inc`, `dec`/`invdec`, `MR`, `BLO`, C2C tile |
| 8 | Instructions | per piece; `Arm (make 2)`; round numbering restarts per piece |
| 9 | Assembly | positions as "between Rnds a and b, k sts apart" plus a 3D diagram |
| 10 | Finishing | fasten off, weave in ends, closing technique, embroidery |
| 11 | Chart(s) + key | numbered rows, legend, repeats marked |

---

## 3. Flat colorwork: graphghan, tapestry, intarsia (R1)

### 3.1 Reading direction and RS/WS

- [V] Lion Brand: "The key to reading charts is to go from bottom to top." RS rows are "read right to left" and WS rows are "worked left to right." ([Lion Brand](https://www.lionbrand.com/community/blog/using-reading-knit-crochet-charts/))
- [V] Lilla Björn (an inset mosaic pattern, worked in turned rows): "Rows on the right side (RS) are read from right to left, and rows on WS are read back across from left to right." ([Lilla Björn, Nya mosaic](https://www.lillabjorncrochet.com/2019/07/nya-infinity-mosaic-blanket.html))
- [V] CrochetPop's tapestry generator: "Row 1 is the bottom row, worked right to left; return rows read left to right." Arrows beside the row numbers show the direction. ([CrochetPop](https://learn.crochetpop.app/design/sc))
- [V] Simply Crochet: "Odd-numbered rows … are usually right-side rows, while even-numbered rows … are usually wrong side rows."
- [V] One graph tutorial: "Row 1 will be considered the right side (RS) and row 2 is wrong side (WS)." ([Crochet It Creations](https://www.crochetitcreations.com/how-to-follow-a-graph-crochet-pattern/))
  - *Fact-check caveat:* the same tutorial says "Graphs are worked left to right (if right-handed) for 1 row, then turned and worked right to left for the next", and "Row 8 will be working on the WS, from right to left". That is the **opposite** reading direction to Lion Brand, Lilla Björn and CrochetPop. Conventions are not universal, which is one more reason to print a direction arrow on every row.
- [I] **Default: Row 1 is RS.** Odd rows read the chart right→left and even rows left→right. Row numbers go on the edge where each row *starts*: odd numbers on the right, even on the left. This is our layout choice; we found no standard for it.
- [I] The orchestration brief's sample line `Row 12 (RS)` only happens if a designer makes Row 1 a WS row. Our model stores `side` explicitly per row, so either convention renders correctly.

### 3.2 Foundation and turning chains

- [V] CYC's example: "Row 1: Ch 15; sc in 2nd ch from hook and in each ch across", which gives 14 sc. Then "Row 2: Ch 1, turn; sc in each sc across."
- [V] CYC on dc: "Dc in 4th ch from hook…", and the three skipped chains "count as first double crochet of the row." For dc "you need to make 3 chains and then turn. And this time the 3 chains count as a stitch."
- [V] A graph tutorial (Crochet It Creations, linked in §3.1): for a 30-stitch-wide graph, "chain 31, sc in 2nd chain from hook and each chain across."
- [V] Edie Eckman's turning-chain table ([edieeckman.com](https://www.edieeckman.com/2019/08/28/where-to-put-the-first-stitch-of-a-crochet-row/)):

| Stitch | Turning chain | Counts as a stitch? |
|---|---|---|
| sc | ch 1 | usually not |
| hdc | ch 2 | sometimes |
| dc | ch 3 | usually |
| tr | ch 4 | usually |

- [V] Eckman on where stitches go:
  - If the turning chain counts, the first stitch goes one stitch over and the last stitch goes "into the top of the turning chain."
  - If it doesn't count, "ignore it completely," work into the base stitch, and end in the last real stitch.
- [V] Lilla Björn spells it out: "Ch1 in the beginning of each row doesn't count as a st." PlanetJune says the same of the magic ring's ch 1 (§6.2).
- [I] **General foundation formula** (machine-checked): `chains = W + h − c`.
  - W is the target stitch count, h is the turning-chain height (1, 2, 3, 4), and c is 1 if the skipped chains count as a stitch.
  - The first stitch goes in the (h+1)th chain from the hook.
  - Checks: sc gives W+1 and "2nd ch". dc (counting) gives W+2 and "4th ch". hdc (counting) gives W+1 and "3rd ch". tr (counting) gives W+3 and "5th ch".
- [I] Graphs use sc only, so `ch W+1`.
- [I] Make the foundation chain in the color of Row 1's first run. That is the rightmost cell of chart row 1.

### 3.3 Written row format

[V] What generators emit today:

- **Stitch Fiddle**: `Row 1: red (1 st)` and `Row 3: 2x red, blue (3 sts)`, with counts in parentheses. It supports horizontal and vertical repeats. ([Stitch Fiddle help](https://www.stitchfiddle.com/en/help/1pen-80n7rh/written-instructions))
- **CrochetPop**: `Row 2: Ch 1, turn. 5 sc(White (BG)), sc(Orange-Red (A)), 5 sc(White (BG)) (11)` (unverified: this sample line was not on the CrochetPop page re-fetched during fact-checking; the reading-direction and colour-change quotes were)
- **Word charts**: `5 white, 10 blue, 3 white` or `5 W, 10 B, 3 W`. ([Craftematics](https://www.craftematics.com/crochet/corner-to-corner))

[I] **Our formats.** All three come from the same row model.

```
Compact (default):  Row 11 (RS) ←: 4 sc A, 3 sc B, 33 sc A (40 sts)
Verbose (beginner): Row 11 (RS): Ch 1, turn. With A, sc in first 4 sts; change to B, sc in next 3 sts;
                    change to A, sc in last 33 sts. (40 sc)
Word chart:         11 ← | 4A 3B 33A | 40
```

- [I] **Runs are listed in working order**, already reversed for WS rows. Single runs are written `1 sc B` or `sc B`, never omitted.
- [I] **Validation**: Σ run lengths = W for every row. All rows have the same W, since graphs have no shaping. Each run's color must be in the palette.

**Worked example** (machine-checked). The chart is shown top-down as seen from the RS. Row 1 is the bottom row, W=5.

```
row 3:  B A A A A
row 2:  A B B B A
row 1:  A A B A A
```

```
Foundation: with A, ch 6.
Row 1 (RS) ←: 2 sc A, 1 sc B, 2 sc A (5 sts)
Row 2 (WS) →: Ch 1, turn. 1 sc A, 3 sc B, 1 sc A (5 sts)
Row 3 (RS) ←: Ch 1, turn. 4 sc A, 1 sc B (5 sts)
Left-handed rendering, Row 3 (RS) →: Ch 1, turn. 1 sc B, 4 sc A (5 sts)
```

[I] A left-hander following the right-handed line for Row 3 would get a mirrored image. Text and logos would come out backwards. So the app must ask which hand the maker uses, or print both versions.

### 3.4 Color-change technique

- [V] Yarnspirations: "Work to last 2 loops on hook. Draw loop of next color through 2 loops on hook to complete stitch." ([Yarnspirations](https://www.yarnspirations.com/blogs/how-to/blog-20160216-how-to-change-colors-tutorial))
- [V] Lion Brand: "stop one step early and finish with the new color." For sc, finish with two loops on the hook. For hdc, "switch colors on the final pull-through." For dc, work until two loops remain. ([Lion Brand](https://www.lionbrand.com/community/blog/change-colors-crochet/))
- [V] CrochetPop: the change happens "in the last pull-through of the stitch BEFORE the chart shows the new color."
- [I] **Rules for the generator.**
  - The instruction belongs to the stitch *before* each color boundary, in working order.
  - **Row-boundary case**: if Row n+1 starts in color X and Row n ended in another color, change to X on the final yo of Row n's last stitch, so the turning chain is already in X.
  - Compact lines don't spell out this mechanic; Notes states it once.

### 3.5 Carrying vs intarsia

- [V] Tapestry: "the tapestry crochet method is where a contrast color yarn is carried along the back of the work, buried into your stitches, until the moment it is needed." ([LoveCrafts / Helen Anderson](https://www.lovecrafts.com/en-us/blogs/articles-us/tapestry-crochet-how-to))
  - The same article on intarsia: "pictures are created in sections … using lots of different yarn bobbins."
- [V] Wikipedia: "Most tapestry crochet is done with single crochet stitches." Inactive yarns are "either carried inside the stitches, dropped and picked up when needed (also called intarsia), or they run along the back of the stitches." ([Tapestry crochet](https://en.wikipedia.org/wiki/Tapestry_crochet))
- [V] Lion Brand: use separate bobbins (intarsia) "when a color block runs wider than roughly 8 to 10 stitches." (The page is dated 2026-09-16, so it is very recent and may still change.)
- [V] Banana Moon Studio, on intarsia: drop the working strand "to the WRONG SIDE of my fabric"; "I do NOT make a slip knot." ([Banana Moon](https://bananamoonstudio.com/intarsia-crochet-photo-tutorial/))
- [I] **Method choice, per color and per row.**
  - **Carry** (tapestry) when a color reappears within T stitches. The default is T = 8, the low end of Lion Brand's range.
  - Otherwise give each separated region its own **bobbin** (intarsia).
  - Bobbin count per color = the number of 4-connected regions of that color in the chart. Print it under Materials.
  - When three or more non-working colors would be carried at once, warn and suggest intarsia for the rarest color. Carried strands add bulk and can show through.

### 3.6 Notes block for flat graphs

[I] Boilerplate. Every sentence restates a [V] source above.

> Each square = 1 sc. Odd rows are RS and are read right to left; even rows are WS and are read left to right (left-handed: reverse). Ch 1 at the beginning of a row does not count as a stitch. Change color on the last yarn over of the stitch before the new color. Work over the color(s) not in use (tapestry), or use a separate bobbin for each area marked in the chart (intarsia). Drop the inactive yarn to the WS.

---

## 4. Corner-to-corner (C2C)

### 4.1 The tile and its four operations

- [V] Craftematics: a block is "a ch 3 loop and 3 dcs anchored to the neighboring square."
- [V] The four operations, as worded by Sarah Maker ([sarahmaker.com](https://sarahmaker.com/c2c-crochet/)):
  - **Increase (row start)**: "Chain 6. Dc in the 4th chain from the hook. Dc in each of the two remaining chains." *(fact-check: wording corrected to the page's text; meaning unchanged)*
  - **Decrease (row start)**: "Slip stitch in each dc across, and slip stitch into the ch-3-space. Chain 3, and work 3 dc into the ch-3-sp of the previous row."
  - **Decrease (row end)**: "work the last tile of the row, and slip stitch into the next ch-3-space. Don't chain 3 to start a new tile – instead, turn your work."
  - **Rectangles**: "You'll increase on both sides until you reach one corner of the rectangle. You then begin decreasing on that side, while still increasing on the other side."
- [V] Dora Does gives the two alternating "steady" rectangle rows in US terms ([Dora Does](https://doradoes.co.uk/2021/08/05/how-to-crochet-a-rectangle-using-the-corner-to-corner-c2c-stitch/)):
  - *Decrease start, increase end*: "Ss into the 3 dc from the end of the last row (making your decrease), *ss into ch3-sp in next block, ch3, 3dc in the same ch3-sp; rep from * to end, turn."
  - *Increase start, decrease end*: "Ch6, 1dc in 4th ch from hook and next 2 ch, ss into next ch3-sp, *ch3, 3dc in ch3-sp, ss into next ch3 sp, rep from * to the end of the row turn."

### 4.2 Reading conventions differ, so state them

- [V] Sarah Maker: "C2C graphs are most commonly worked from the bottom-right corner to the top-left corner."
- [V] Craftematics' patterns are "worked from the bottom left corner to the upper right corner."
- [V] CrochetFrog starts "in the bottom-right corner." RS rows are marked ↙ and read right-to-left; WS rows are marked ↗. ([CrochetFrog](https://crochetfrog.com/tools/c2c-graphgan-blanket-pattern-maker/))
- [V] Kim Latshaw's C2C Graphs, as described by The Crochet Crowd: "Row 1 … B1 … Going in **up** direction". Row 2 goes down. ([Crochet Crowd](https://thecrochetcrowd.com/corner-corner-c2c-graph-maker/))
- Stitch Fiddle: "you can choose the corner you'd like to start from (all four corners are supported)." (unverified as a quote: the C2C help page has no such sentence; its written-instructions help page only says you can choose starting corners for C2C.) [V] Where its output says "corner", "you need to switch from increasing to decreasing (or from decreasing to increasing)." ([Stitch Fiddle C2C](https://www.stitchfiddle.com/en/help/1pei-97d7bo/pixel-crochet-c2c))
- [I] **Default**: start bottom-right, odd rows ↙ (RS), even rows ↗ (WS). Every row line prints an arrow and side. The start corner is a user option, and the other three corners are handled by mirroring the chart.

### 4.3 Rectangle math

- [V] Stitchmate: for W×H blocks, "Total rows: W + H − 1." The increase phase is "min(W, H) rows", the steady phase "exactly |W − H| rows", and the decrease phase "min(W, H) − 1 rows". Their example is 100×60: "Rows 1 to 60 increase … Rows 61 to 100 hold at 60 blocks … Rows 101 to 159 decrease." ([Stitchmate](https://stitchmate.app/guides/c2c-increase-decrease))
- [I] **Derivation** (machine-checked for 4×4, 5×3, 3×5, 10×7, 7×10, 1×5, 5×1 and 100×60).
  - Index diagonals d = n − 1, where n is the row number.
  - `tiles(n) = min(n−1, W−1) − max(0, n−H) + 1`
  - The **bottom/left end** of row n increases iff `n ≤ W`; otherwise it decreases.
  - The **right/top end** increases iff `n ≤ H`; otherwise it decreases.
  - Odd rows (↙) **start** at the right/top end; even rows (↗) start at the bottom/left end.
  - Then `tiles(n) = tiles(n−1) + [start increases] − [end decreases]`. This matches the closed form for every n.

### 4.4 Algorithm: chart → C2C rows

```ts
// chart[r][c], r = 0 bottom row, c = 0 left column, viewed from RS. Start = bottom-right.
function c2cRows(chart: Color[][]): C2CRow[] {
  const H = chart.length, W = chart[0].length, rows: C2CRow[] = [];
  for (let n = 1; n <= W + H - 1; n++) {
    const d = n - 1, odd = n % 2 === 1;
    const cells: [number, number][] = [];
    for (let r = Math.max(0, d - (W - 1)); r <= Math.min(d, H - 1); r++) {
      const x = d - r;                       // distance from right edge
      cells.push([r, W - 1 - x]);
    }
    cells.sort((a, b) => odd ? b[0] - a[0] : a[0] - b[0]); // ↙: from top/right end; ↗: from bottom/left end
    const blInc = n <= W, rtInc = n <= H;
    const [startInc, endInc] = odd ? [rtInc, blInc] : [blInc, rtInc];
    rows.push({ n, side: odd ? 'RS' : 'WS', arrow: odd ? '↙' : '↗',
                start: n === 1 ? 'first' : startInc ? 'inc' : 'dec',
                end:   n === 1 ? 'first' : endInc ? 'inc' : 'dec',
                colors: cells.map(([r, c]) => chart[r][c]) });
  }
  return rows;
}
```

Wording is chosen from the start and end actions:

| start \ end | end inc (work last tile into last ch-3 sp) | end dec ("sl st in last ch-3 sp, turn"; no tile) |
|---|---|---|
| **start inc** ("Ch 6, dc in 4th ch from hook and next 2 ch") | increase row (+1) | steady row (0) |
| **start dec** ("Sl st in next 3 dc and in ch-3 sp, ch 3, 3 dc in same sp") | steady row (0) | decrease row (−1) |

### 4.5 Written format

- [V] Generator wording collected:
  - Stitch Fiddle: `Row 4: red, 2x blue, red (4 sts)`
  - CrochetFrog: `↙ Row 1 [RS]: (#F5EE14)x1 [1 block]`
  - Stitchmate's guide: `← Row 59 [RS]: (Cream) x 12, (Teal) x 47 (59 blocks)`
  - Kim Latshaw: `B7` (color letter followed by a count)
  - Craftematics: `5 W, 10 B, 3 W`
- [I] **Our format** puts the row-shape tag inside the line, so no separate "corner" lookup is needed:

```
↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)
```

**Worked example** (machine-checked), using the same 5×3 chart as §3.3:

```
↙ Row 1 (RS) [first tile]:          1 A        (1 tile)
↗ Row 2 (WS) [inc beg · inc end]:   2 A        (2 tiles)
↙ Row 3 (RS) [inc beg · inc end]:   1 A, 2 B   (3 tiles)
↗ Row 4 (WS) [inc beg · dec end]:   1 A, 1 B, 1 A (3 tiles)   ← top edge reached (H = 3)
↙ Row 5 (RS) [dec beg · inc end]:   1 A, 1 B, 1 A (3 tiles)
↗ Row 6 (WS) [dec beg · dec end]:   2 A        (2 tiles)      ← left edge reached (W = 5)
↙ Row 7 (RS) [dec beg · dec end]:   1 B        (1 tile)       ← top-left corner = chart cell (row 3, col 1)
```

### 4.6 Color changes and yarn management

- [V] Sarah Maker: "In C2C, you'll most often switch colors right before you complete the third double crochet stitch of the tile."
- [V] Craftematics: "Change colors on the second half of the last double crochet of the square previous."
- [I] A color change counts at every tile boundary in working order, including across rows.
- [I] Each connected same-color region needs its own bobbin. Count regions with **6-connectivity** on the chart and print the totals. *(fact-check: was "8-connectivity, because tiles that touch at a corner are adjacent across diagonal rows".)* With the bottom-right start, C2C row index is d = r + (W−1−c). Orthogonal chart neighbours sit in consecutive rows and are joined. The (r±1, c±1) diagonal has the same d, so those are consecutive tiles of one row and are joined. The other diagonal (r±1, c∓1) is two rows apart and does not touch, so 8-connectivity would merge separate regions and under-count bobbins. For other start corners, mirror the chart first.

### 4.7 C2C notes block

[I] Boilerplate drawn from the [V] wording above.

> Each square = 1 tile (ch 3 + 3 dc). Start at the bottom-right corner. Odd rows (RS) run ↙, even rows (WS) run ↗; turn at the end of every row. *Increase at beginning*: ch 6, dc in 4th ch from hook and next 2 ch. *Decrease at beginning*: sl st in next 3 dc and in the ch-3 sp, ch 3, 3 dc in same sp. *Decrease at end*: sl st in last ch-3 sp and turn without making a tile. Change color on the last yo of the last dc of the tile before.

---

## 5. Mosaic and Tunisian (brief)

### Mosaic

- [V] Mosaic "typically uses only one color per row." "The patterns are formed by dropping stitches down into previous rows." "Mosaic crochet charts often include X symbol to indicate where longer stitches should be placed." ([Wikipedia: Mosaic crochet](https://en.wikipedia.org/wiki/Mosaic_crochet))
- [V] **Overlay mosaic**, per Juniper & Oakes ([Juniper & Oakes](https://juniperandoakes.com/blog/how-to-crochet-overlay-mosaic-patterns/)):
  - "worked from right to left on Right Side only", with no turning; you "fasten off at the end of each row" and alternate colors every row.
  - Stitches are BLO sc and dc "worked in FLO of stitch 2 rows below."
  - Written format: `Row 5: BBS, *BLOsc x1, FLOdc x1,* repeat, EBS`, where BBS/EBS are beginning and ending border stitches.
- [V] **Inset mosaic**, per Lilla Björn:
  - Rows are worked back and forth. "Each row in chart represents two rows of same color", and the yarn is carried up the side.
  - Off-color cells are made by chaining and skipping, with the chain count "always 1 ch more than a number of skipped sts."
  - The mosaic dc is "always made in front of your work, in front of chains of previous rows."
  - CrochetPop summarizes inset as "2-row color bands" with "ch-skip + DC dropped 3 rows down". ([CrochetPop learn](https://learn.crochetpop.app/learn/mosaic-crochet))
- [I] Mosaic is a stretch goal. Image→mosaic needs its own quantizer: two colors, plus the constraint that each long stitch must have a same-color stitch 2 rows below (overlay) or 3 rows below (inset). We cannot simply reuse the tapestry run-length writer.

### Tunisian

- [V] CYC's Tunisian abbreviations: etss, **FwP** (forward pass), **RetP** (return pass), tdc, tfs, thdc, **tks**, **tps**, trs, tsc, **tss** (Tunisian simple stitch), tslst, ttr, ttw.
- [V] "The work is never turned in Tunisian crochet." "The forward pass is worked from right to left across the piece … then a return pass is worked from left to right." ([The Crochet Project](https://thecrochetproject.com/blogs/blog-the-crochet-project/tunisian-crochet-the-basics))
- [V] The standard return pass: "Yarn over and pull through the first loop on the hook", then yarn over and draw through two loops until one remains.
- [V] On the forward pass you skip the first vertical bar: "you already have your first loop on the hook." One row = forward pass + return pass. ([Morale Fiber](https://moralefiber.blog/2019/01/25/tunisian-simple-stitch-tutorial/))
- [I] Because the RS always faces you, every row of a Tunisian color chart is read in the forward-pass direction (right→left for right-handers). That differs from turned sc graphs. Write rows as `Row 7: FwP: 3 tss A, 4 tss B, …; RetP: standard.`

---

## 6. Amigurumi conventions (R2, R3, R8)

### 6.1 Spiral vs joined rounds

- [V] PlanetJune on spirals: "you shouldn't join with a slip stitch at the end of each round, or chain to begin the next round, or turn your work between rounds." ([PlanetJune Amigurumi Troubleshooter](https://www.planetjune.com/blog/amigurumi-troubleshooter/))
  - "Use a stitch marker to mark the beginning of each round. Move the marker up each time you start a new round."
  - On counting: "The loop on your hook is called the working loop and you should never include that in your stitch count."
  - On loops: unless told otherwise "you should always work into both loops of the stitch below."
- [V] Joined rounds "join to the first st (sc) with a sl st". The chain that starts the next round "does not count as a stitch if you are using sc." The resulting seam can creep. ([Look At What I Made](https://lookatwhatimade.net/crafts/yarn/crochet/crochet-tutorials/how-to-crochet-in-the-round-spiral-vs-joining/))
- [V] Stripes in a spiral give "perfect stripes from the front … but a 'jog' at the back."
  - PlanetJune compares the travelling join and the stacked join, and recommends her Invisible Join and No-Cut Join for "any pattern where you need to single crochet in joined rounds and/or make stripes." ([PlanetJune stripes comparison](https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/))
- [I] **Defaults.**
  - Spiral, with the round start (marker) placed at center back so the jog is hidden.
  - Switch a piece to joined rounds only if the user asks for crisp stripes. Otherwise, any full-round color change gets a jog note.

### 6.2 Magic ring

- [V] PlanetJune: the magic ring "leaves **no hole** in the centre of your starting round."
  - "if it starts with a chain, just replace the starting 'Ch 2, X sc in 2nd chain from hook' with 'Make a magic ring, ch 1, X sc in magic ring'."
  - The ch 1 "does NOT count as a stitch." ([PlanetJune magic ring](https://www.planetjune.com/blog/amigurumi-help/how-to-crochet-a-magic-ring/))
- [I] Render `Rnd 1: 6 sc in MR (6)`. In Notes: "MR = magic ring (ch 1 does not count). Alternative: ch 2, 6 sc in 2nd ch from hook."

### 6.3 Round lines, counts, ranges

- [V] Examples from published amigurumi patterns:
  - PlanetJune: `(2 sc in next st, sc in next st) six times. (18 st)` and `(invdec, sc in next 2 st) six times. (18 st)`
  - Owie the Voodoo Doll: `Rnd 1: work 6 sc in magic ring (6 sts)` and `Rnd 2: inc in each st around (12 sts)` ([Hello Yellow Yarn](https://helloyellowyarn.com/2018/10/22/owie-the-voodoo-doll-free-amigurumi-pattern/))
  - Hookabee: `rnd 5-8: sc in each st around (18, 4 rnds)` ([Hookabee Part 2](https://hookabee.com/2016/03/15/how-to-read-amigurumi-patterns-written-instructions/))
  - AmiGo (Fig. 1): `1: 8sc in a ring [8]`, `2: 6inc,sc,inc [15]`, `3: sc,(inc,sc)*2,(sc,inc)*5 [22]`, and folded rows `rows 2-3: (sc, inc, 2sc)*3`
  - *Fact-check caveat:* the `rows 2-3` example (Sec. 5.2) is schematic. Each row consumes 12 and produces 15, so two consecutive identical rows fail a consumed/produced check (row 3 would consume 12 but row 2 left 15). Only rounds with no shaping (consumed = produced) can be folded into a range. Our E_CONSUME rule would correctly reject the literal pair.
- [I] **Our amigurumi-compact dialect:**

```
Rnd 1: 6 sc in MR (6)
Rnd 2: inc in each st around (12)
Rnd 3: (sc, inc) x 6 (18)
Rnds 7–10 (4 rnds): sc in each st around (36)
```

### 6.4 The "2 sc" ambiguity

- [V] Hookabee: "For some patterns '2 sc' means 'make 1 single crochet into the next 2 stitches', but for others it means 'make 2 single crochet stitches into the next stitch'." ([Hookabee Part 3](https://hookabee.com/2016/04/26/how-to-read-amigurumi-patterns-written-instructions-cont/))
- [V] Dias & Karim's 2025 AAAI Summer Symposium paper, "Translation of User Crochet Patterns to CrochetPARADE Syntax Using Large Language Models" (not a paper by the CrochetPARADE authors; *fact-check: was "The AAAI 2025 CrochetPARADE paper"*), agrees: "Abbreviations and terminology can vary between pattern designers, with the same terms sometimes indicating different techniques." ([Dias & Karim](https://ojs.aaai.org/index.php/AAAI-SS/article/download/36054/38209/40142))
- [I] **Our definitions**, printed in Notes:
  - `N op` = work *op* N times, into N consecutive stitches. So `3 sc` means sc in each of the next 3 sts, and `2 inc` means inc in each of the next 2 sts.
  - Several stitches into *one* stitch are never written as `N op`. They are always named (`inc`, `inc3`) or spelled out ("3 sc in last ch").
  - The US-verbose dialect sidesteps the problem by writing "sc in next 3 sts" and "2 sc in next st".

### 6.5 inc, dec, and the invisible decrease

- [V] Hookabee: "An increase means you make two single crochet stitches into the same stitch." "A decrease, 'dec', is when you single crochet the next two stitches together (same as sc2tog)."
- [V] PlanetJune's invisible decrease (abbreviated invdec), step by step ([PlanetJune invdec](https://www.planetjune.com/blog/amigurumi-help/invisible-decrease/)):
  1. "Insert the hook into the front loop of the first stitch … DO NOT YARN OVER."
  2. "Insert the hook into the front loop of the next stitch."
  3. "Yarn over and draw through the first two loops."
  4. "Yarn over and draw through both loops."
  - It "groups the previous stitches together at its base, so the stitch itself looks identical to a regular single crochet."
  - It is linkable as www.planetjune.com/invdec.
- [V] AmiGo generalizes the operations to `inc(x)` and `dec(x)`: "If all the pairs of consecutive rows of G are coupled, then there exist valid crochet instructions P(G) that use only the instructions sc, inc(x) and dec(x)."
- [I] In the model, `dec` is a single op with `method: 'invdec' | 'sc2tog'` (a user preference). It renders as `dec` in compact output and as `invdec` or `sc2tog` in verbose output. `inc3` (3 sc in one st) and `dec3` (sc3tog) exist for steep shaping.

### 6.6 Distributing and staggering increases and decreases

- [V] And She Laughs explains why stacking fails: "all of increases (and decreases) happen at the same point in every round," which produces hexagonal or octagonal shapes. Their staggered schedule for an 8-stitch start: `Round 3: inc, sc around (24)`, `Round 4: *sc, inc, sc* repeat around (32)`, `Round 6: *2sc, inc, 2sc* repeat around (48)`. ([And She Laughs](https://www.andshelaughsblog.com/crocheting-perfect-circle-staggered-increases-decreases/))
- [V] fibertools: "round 1 ends with p stitches and round r ends with p × r stitches." Its generator "alternates increase placement as a counting aid." Output looks like `Round 3: *2 sc in next st, sc in next 1 st* repeat 6 times. (18 sc)`. ([fibertools](https://fibertools.app/circle-calculator))
- [I] The brief's example `sc, inc, (2 sc, inc) x5, sc` and `(sc, inc, sc) x 6` are the **same stitch sequence** (machine-checked). Both consume 18 and produce 24. Our compressor emits the shorter `(sc, inc, sc) x 6`.

[I] **Distribution algorithm.** To go from P stitches to T stitches in one round:

- **Increase** (T > P): k = T − P incs and n = P − k plain sc. This is feasible iff k ≤ P; otherwise use `inc3` or add a round.
- **Decrease** (T < P): k = P − T decs and n = T − k plain sc. This is feasible iff 2k ≤ P; otherwise use `dec3` or add a round.
- **Grouped (readable) layout**: `g, r = divmod(n, k)`. Emit r groups of `(g+1) sc, special` followed by k − r groups of `g sc, special`.
  - Example: 37→30 gives `(4 sc, dec) x 2, (3 sc, dec) x 5 (30)`.
  - Example: 29→37 gives `(3 sc, inc) x 5, (2 sc, inc) x 3 (37)`.
- **Stagger**: rotate each round's sequence by about ⌊g/2⌋ stitches relative to the previous round. Then the special stitches of round r sit between those of round r−1. Emit a warning if any special stitch lands within 1 stitch of one in the previous round for 3 or more consecutive rounds.

**Example** (machine-checked: the sphere generator with alternating phase):

```
Rnd 1: 6 sc in MR (6)
Rnd 2: inc in each st around (12)
Rnd 3: (sc, inc) x 6 (18)
Rnd 4: (sc, inc, sc) x 6 (24)
Rnd 5: (3 sc, inc) x 6 (30)
Rnd 6: (2 sc, inc, 2 sc) x 6 (36)
Rnds 7–8 (2 rnds): sc in each st around (36)
Rnd 9: (4 sc, dec) x 6 (30)
Rnd 10: (sc, dec, 2 sc) x 6 (24)
Rnd 11: (2 sc, dec) x 6 (18)
Rnd 12: (dec, sc) x 6 (12)
Rnd 13: dec around (6)
```

- [I] Contrast with AmiGo. It follows geometry stitch by stitch, so its rows are irregular, for example `sc,inc,2sc,(inc,sc)*2,(2sc,inc)*2,(2sc,inc,sc)*2 [29]`.
- [I] **Recommendation**: take per-round *counts* from geometry, but lay out the shaping with the grouped/staggered method. Exception: when the shape is asymmetric (a belly bump, a snout), place the shaping in the arc that needs it and let the compressor do its best.

### 6.7 Color changes inside rounds (R8)

- [V] PlanetJune's rule: "Always pull through the **last loop** of the stitch **before** the colour change with the new colour." ([PlanetJune changing colour](https://www.planetjune.com/blog/amigurumi-help/changing-colour/))
- [V] PlanetJune lists three ways to handle the unused yarn:
  - cut and tie;
  - stranding (dropping the yarn inside), best for 1–2 stitches;
  - carrying it inside over wider spans, optionally catching the float behind an occasional stitch to prevent puckering (paraphrased).
- [I] **Format.**
  - A round in one color puts the color in the header: `Rnd 9 (B): sc in each st around (36)`. The change is noted on the previous round: "…; change to B on the last yo".
  - A multicolor round tags every run, including inside repeats: `Rnd 12: (4 sc A, 2 sc B) x 6 (36)`.
  - Folding rounds into ranges requires identical colors, loops and notes.
- [I] Floats are hidden inside stuffed pieces, so carrying is acceptable. When a color is absent for 6 or more consecutive stitches, add a "catch the carried strand every ~5 sts" note (an inference from PlanetJune's advice above).

### 6.8 BLO/FLO rounds and flat bottoms

- [V] PlanetJune: BLO and FLO rounds are used for "turning a sharp corner in either direction; using the unworked loops as attachment points to crochet back into later" and similar purposes. "sc and sc in BLO/FL only are **never** interchangeable." Patterns should "specify anywhere that you use non-standard stitches." ([PlanetJune loops](https://www.planetjune.com/blog/front-loops-back-loops-both-loops/))
- [V] The jogless BLO round: "the **only** modification you need to make to your pattern is to replace the single crochet **before** the first BLO stitch with a slip stitch." ([PlanetJune jogless BLO](https://www.planetjune.com/blog/amigurumi-help/jogless-back-loop-only-round-for-amigurumi-video/))
- [I] **Flat-bottom template** (machine-checked counts; a sl st consumes 1 and produces 1):

```
Rnds 1–5: as the sphere in §6.6 (30)
Rnd 6: (2 sc, inc, 2 sc) x 5, 2 sc, inc, sc, sl st (36)   ← last st is a sl st (jogless BLO prep)
Rnd 7: sc in BLO of each st around (36)                    ← base edge turns up
Rnds 8–12 (5 rnds): sc in each st around (36)
```

### 6.9 Ovals worked around a chain

- [V] Airali Design: work along the chain until 1 ch remains, then "Work 3 single crochet into that last chain (it may vary depending on the pattern, usually it's 3 or 5)". Rotate, work back along the other side, and finish with "2 single crochet … into this last loop."
  - A reply on the same page suggests "3 inc on both 'round sides' of the oval – so you get 6 inc in each round." ([Airali](https://airalidesign.com/en/how-to-crochet-oval-shape/))
- [I] **Formulas** for ch N (machine-checked for N = 6, 10, 15):
  - Rnd 1 uses 2N−3 chain loops and produces **2N** sts.
  - Each later round adds 6 at the two ends.

```
Ch 10.
Rnd 1: sc in 2nd ch from hook, sc in next 7 ch, 3 sc in last ch; working along the other side of the chain,
       sc in next 7 ch, 2 sc in last ch (20)
Rnd 2: inc, 7 sc, inc in next 3 sts, 7 sc, inc in next 2 sts (26)
Rnd 3: sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2 (32)
```

- [I] **Segment hints matter here** (machine-checked).
  - A whole-round shortest encoding of Rnd 3 is `(sc, inc, 8 sc, inc, sc, inc) x 2 (32)`. It is valid, but it hides the oval.
  - Compressing *per segment* (end / side / end / side / end), as above, keeps the structure readable.

### 6.10 Stuffing, fastening off, closing

- [V] PlanetJune's "Ultimate Finish" ([PlanetJune Ultimate Finish](https://www.planetjune.com/blog/amigurumi-help/ultimate-finish-for-amigurumi/)):
  1. It starts with "6 sc remaining."
  2. "Cut the yarn, leaving a long yarn end. Draw the end through the final loop on the hook."
  3. Thread "the front loops only", going "from the centre of the hole to the outside."
  4. "Pull the yarn tight", and "the hole will close up just like a magic ring."
  5. Then go "through the middle of the ring … bring it out an inch or two away" and snip, so the end retracts.
- [V] AmiGo assumes the piece is "stuffed enough to attain maximal volume, but not too much to cause the yarn to stretch and generate gaps."
  - AmiGo also notes that surface "craters" (positive Gaussian, negative mean curvature) "cannot be realized by crocheting and stuffing alone". This is relevant to R7 sculpting limits.
- [I] **Template lines.**
  - "Begin stuffing after Rnd {first dec rnd + 1}; stuff firmly as you go."
  - "Rnd n: dec around (6). Fasten off, leaving a 6" (15 cm) tail; close with the Ultimate Finish."
  - Open pieces end: "Fasten off, leaving a 12" (30 cm) tail for sewing. Stuff lightly / do not stuff the top 2 rnds."
  - These tail lengths are inferences, not sourced.

### 6.11 Safety eyes and assembly positions

- [V] The Woobles: "Safety eyes aren't safe for children younger than 3 years old, or pets." "If you don't want to use safety eyes, simply embroider them on instead." To place the second eye, count the gaps between stitches. "Use pins to hold Piece A in place as you sew it on." ([Woobles eyes](https://thewoobles.com/pages/how-to-use-safety-eyes); [Woobles joining](https://thewoobles.com/pages/how-to-join-amigurumi-pieces))
- [V] Published placement wording, from Owie the Voodoo Doll:
  - eyes "between Rounds 12 & 13, 6 stitches apart"
  - arms "between Rounds 19 & 20, 4 stitches apart at the front"
- [V] PlanetJune's joining tutorial covers sewing open-ended pieces to closed ones with a near-invisible whipstitch. ([PlanetJune joining](https://www.planetjune.com/blog/joining-amigurumi/))
- [I] **Placement model.** Each attachment is
  `{piece, between:[rA, rA+1], centerStitch: s (0 = marker, counting in working direction), apart?: g}`.
  - Text: "Insert 9 mm safety eyes between Rnds 10 and 11, 6 sts apart, centered on the front (st 18 of 36, opposite the marker). Insert eyes before stuffing and closing."
  - Symmetric pairs are computed as mirror offsets around the front center.
  - Validate that 1 ≤ rA < rounds(piece) and that `apart < count(rA)`.
  - Add a landmark-relative phrase as a fallback, such as "2 rnds below the eyes", because a maker's round count can drift.

### 6.12 Amigurumi notes block

[I] Boilerplate drawn from the [V] sources above.

> Work in continuous rounds (spiral); do not join or turn. Mark the first st of each round and move the marker up every round. Stitch counts are in parentheses at the end of each round. `N sc` = sc in each of the next N sts; inc = 2 sc in the same st; dec = invisible decrease (or sc2tog). Work through both loops unless BLO/FLO is stated. Change color on the last yarn over of the stitch before the new color. Safety eyes are not suitable for children under 3; embroider eyes instead.

---

## 7. Formatter and validator specification

### 7.1 Data model

```ts
type Color = string;                       // palette key: 'A', 'B', ...
type Loop = 'both' | 'BLO' | 'FLO';
type Op =
  | { k: 'st';   st: 'sc'|'hdc'|'dc'|'tr'|'slst'; loop?: Loop; color?: Color }
  | { k: 'inc';  n: 2 | 3; color?: Color }                    // n sc in same st
  | { k: 'dec';  n: 2 | 3; method: 'invdec' | 'tog'; color?: Color }
  | { k: 'skip'; n: number }
  | { k: 'ch';   n: number; counts: boolean }                 // chain inside a row (ch-sp)
  | { k: 'mr';   n: number }                                  // n sc into magic ring
  | { k: 'tch';  h: 1|2|3|4; countsAs?: 'hdc'|'dc'|'tr' }     // turning chain
  | { k: 'group'; into: 'sameSt'; ops: Op[] }                 // e.g. (dc, ch 1, dc) in next st
  | { k: 'fnd';  side: 'top'|'bottom'; n: number };           // n sts along a foundation-chain side (ovals)
interface Line {
  kind: 'row' | 'rnd'; n: number; side?: 'RS' | 'WS';
  ops: Op[]; stated: number;               // stated stitch count
  segments?: number[];                     // indices where compression must not cross (§6.9)
  colorHeader?: Color; notes?: string[]; partial?: boolean;
}
```

### 7.2 Stitch semantics: consumed and produced

| Op | consumes | produces | Notes |
|---|---|---|---|
| sc, hdc, dc, tr; any loop (BLO/FLO); post stitch; spike/mosaic long dc | 1 | 1 | BLO changes shape, not counts [V PlanetJune] |
| sl st (inside a counted round) | 1 | 1 | jogless BLO prep |
| inc (n=2) / inc3 | 1 | 2 / 3 | [V Hookabee; AmiGo inc(x)] |
| dec (sc2tog, invdec) / dec3 | 2 / 3 | 1 | [V AmiGo dec(x)] |
| skip n | n | 0 | |
| ch n (counted as sts) | 0 | n | most patterns count ch-sps separately [I] |
| MR with n sc | 0 (ring) | n | [V PlanetJune: ch 1 does not count] |
| tch, not counting (sc ch 1) | 0 | 0 | [V CYC, Eckman] |
| tch counting (dc ch 3) | 1 | 1 | sits on the first stitch, so the row starts in the 2nd st [V Eckman] |
| group into same st `(…) in next st` | 1 | Σ produced | |
| oval Rnd 1 on ch N | 2N−3 loops | 2N | [I] machine-checked |
| C2C tile / ch-6 increase tile | 1 ch-3 sp / 0 | 1 tile | per-row tile formula §4.3 |

### 7.3 Validation rules

| Code | Rule | Severity |
|---|---|---|
| E_CONSUME | Σ consumed ≠ previous count, unless `partial` with an explicit "leave rem sts unworked" | error |
| E_PRODUCE | Σ produced ≠ stated count | error |
| E_INC_INFEASIBLE | T > 2P using only `inc(2)` | error. Suggest inc3 or an extra round. |
| E_DEC_INFEASIBLE | T < P/2 using only `dec(2)` | error. Suggest dec3 or an extra round. |
| E_RUN_SUM | flat graph row: Σ runs ≠ W | error |
| E_C2C_TILES | tiles ≠ `tiles(n)` or colors.length ≠ tiles | error |
| E_SPIRAL_CHAIN | spiral round begins with `tch`/`ch` | error. PlanetJune spiral rule (§6.1). |
| E_FOLD | folded range has non-identical ops, colors, loops or notes | error |
| E_COLOR | color not in palette | error |
| W_STACKED | shaping positions in round r within 1 st of round r−1 for ≥3 consecutive rounds | warn (hexagon) |
| W_LONG_CARRY | flat row: color absent > T (8) then reappears | warn → bobbin |
| W_JOG | full-round color change or BLO round in a spiral piece | info → jog note |
| W_CLOSE | closed piece ends with > 6 sts | warn → add a dec round |
| W_ASSEMBLY | referenced round or stitch outside the piece | error |

### 7.4 Compressing repeats

- [V] AmiGo's raw trace `row 2: sc, inc, sc, sc, sc, inc, sc, sc, sc, inc, sc, sc` (and an identical `row 3`) becomes `rows 2-3: (sc, inc, 2sc)*3` (schematic: see the caveat in §6.3) through "loop folding [Lee et al. 1994], which finds maximal repetitions."
  - "the order in which loops are folded must be: sequences first, and then repeating stitches … Finally, identical rows are folded together."
  - Folding the stitch runs first would have produced `sc, inc, 3sc, inc, 3sc, inc, 2sc`, which hides the repetition.
- [I] A shortest-encoding DP subsumes both levels.
  - A run of one op is a period-1 repeat rendered as `N op`.
  - Sequences are found because the DP considers every period.

```ts
// tokens: Op[] normalized to comparable keys (op + loop + color). O(L^3); L ≤ ~200 per round is fine.
function encode(t: Key[], i = 0, j = t.length - 1, depth = 0): Enc {
  if (allSame(t, i, j)) return { cost: 1, items: [run(t[i], j - i + 1)] };       // "7 sc", "inc"
  let best = null;
  for (let k = i; k < j; k++) {                                                    // concatenation
    const a = encode(t, i, k, depth), b = encode(t, k + 1, j, depth);
    best = better(best, { cost: a.cost + b.cost, items: [...a.items, ...b.items] });
  }
  if (depth === 0) {                                                               // max 1 bracket level
    const n = j - i + 1;
    for (let p = 2; p <= n / 2; p++) if (n % p === 0 && periodic(t, i, j, p)) {
      const inner = encode(t, i, i + p - 1, depth + 1);
      best = better(best, { cost: inner.cost + 1, items: [`(${inner.items.join(', ')}) x ${n / p}`] });
    }
  }
  return best;   // memoize on (i, j, depth)
}
// better(): lower cost; tie → fewer top-level items. E.g. "(4 sc, dec) x 2, (3 sc, dec) x 5"
// beats "4 sc, dec, sc, (3 sc, dec) x 6" (equal cost 6).
```

[I] **Post-rules.**

1. If the whole round is one op, write `sc in each st around` / `inc in each st around` / `dec around`.
2. Respect `segments`: encode each segment separately and join the results (§6.9).
3. Fold consecutive identical lines into `Rnds a–b (k rnds)`. Never fold across a color change, a BLO round, a note, or an attachment reference.
4. Never emit `( ) x 1`. Never nest brackets in compact mode. In verbose mode, nest only a same-stitch group inside a repeat.
5. **Rotation search** (spiral only). If the generator has freedom of phase, also try rotating the sequence by 0…(group length − 1). Keep the lowest-cost rotation that still satisfies W_STACKED.

### 7.5 Rendering dialects

| Model | Compact (ami) | US verbose | UK verbose |
|---|---|---|---|
| sc ×1 / ×N | `sc` / `N sc` | `sc in next st` / `sc in next N sts` | `dc in next st` / `dc in next N sts` |
| inc ×1 / ×N | `inc` / `N inc` | `2 sc in next st` / `2 sc in each of next N sts` | `2 dc in …` |
| dec | `dec` | `invdec` or `sc2tog` | `dc2tog` (or invdec) |
| BLO sc ×N | `N sc BLO` | `sc in back loop only of next N sts` | `dc in back loop only …` |
| repeat | `(A, B) x n` | `[A, B] n times` | `[A, B] n times` |
| count | `(18)` | `(18 sts)` | `(18 sts)` |
| colors | `4 sc A` | `with A, sc in next 4 sts` | `with A, dc in next 4 sts` |

### 7.6 Unit-test vectors (all machine-checked)

| # | prev | Line body | stated | Expect |
|---|---|---|---|---|
| 1 | — | `6 sc in MR` | 6 | ok |
| 2 | 6 | `inc in each st around` | 12 | ok |
| 3 | 18 | `sc, inc, (2 sc, inc) x 5, sc` | 24 | ok; compresses to `(sc, inc, sc) x 6` |
| 4 | 12 | raw `sc inc sc sc sc inc sc sc sc inc sc sc` | 15 | encodes `(sc, inc, 2 sc) x 3` |
| 5 | 8 | `6 inc, sc, inc` (AmiGo) | 15 | ok |
| 6 | 15 | `sc, (inc, sc) x 2, (sc, inc) x 5` (AmiGo) | 22 | ok |
| 7 | 22 | `sc, inc, 2 sc, (inc, sc) x 2, (2 sc, inc) x 2, (2 sc, inc, sc) x 2` | 29 | ok |
| 8 | 29 | `2 sc, inc, sc, (2 sc, inc, 3 sc, inc) x 2, 2 sc, (sc, inc, sc) x 3` | 37 | ok |
| 9 | 37 | grouped dec to 30 | 30 | `(4 sc, dec) x 2, (3 sc, dec) x 5` |
| 10 | 15 | grouped inc to 22 | 22 | `sc, (sc, inc) x 7` |
| 11 | 24 | `(invdec, 2 sc) x 6` (PlanetJune) | 18 | ok |
| 12 | 12 | `dec around` | 6 | ok |
| 13 | ch 10 | oval Rnd 1 | 20 | ok (consumes 17 loops) |
| 14 | 26 | `sc, inc, 7 sc, (sc, inc) x 3, 7 sc, (sc, inc) x 2` with segments | 32 | renders unchanged |
| 15 | 30 | `(2 sc, inc, 2 sc) x 5, 2 sc, inc, sc, sl st` | 36 | ok |
| 16 | 12 | `(sc, inc) x 6` | 20 | **E_PRODUCE** (18 ≠ 20) |
| 17 | 20 | `(sc, inc) x 6` | 18 | **E_CONSUME** (12 ≠ 20) |
| 18 | 10 | target 25 with inc(2) | 25 | **E_INC_INFEASIBLE** |
| 19 | C2C 5×3 | rows 1–7 | 1,2,3,3,3,2,1 | ok; actions as §4.5 |
| 20 | C2C 100×60 | — | 159 rows | rows 61–100 = 60 tiles; row 101 = 59 |
| 21 | graph W=5 | Row 3, RH vs LH | 5 | `4 sc A, 1 sc B` vs `1 sc B, 4 sc A` |
| 22 | US→UK | `sc2tog` | — | `dc2tog`, not `tr2tog` |

### 7.7 Failure modes and edge cases

[I] Each item comes from the sources above or from the scripted checks.

- **Turning-chain off-by-one.** Mixing "ch 3 counts" and "doesn't count" between rows changes W by ±1 per row. Store `countsAs` on every `tch` and validate it.
- **Mirrored images for left-handers**, and for any reader who misses the RS/WS reading direction (§3.3). Always show arrows.
- **Parity drift.** A chart with an even number of rows ends on a WS row. Never assume the last row is RS.
- **Ambiguous `N sc`** (§6.4). Print the definition, or switch to verbose.
- **Rounding from geometry** makes count jumps impossible (T > 2P or T < P/2). Split the jump over two rounds or use inc3/dec3.
- **Hexagon or octagon shapes** from stacked shaping. Stagger and warn.
- **Unreadable folding.** The compressor can be valid yet unhelpful (oval example). Use segment hints and the tie-breaker. Cap nesting at one level.
- **Jogs** at stripes and BLO rounds in spirals. Add notes or the jogless techniques.
- **Range folding across hidden differences** (a color, a loop, an eye-placement round). E_FOLD prevents this.
- **US/UK double conversion**. Render from the model, not from text.
- **Assembly references** to rounds that no longer exist after the user edits the 3D shape (R7). Re-resolve attachments by 3D position after every regeneration.
- **C2C with W = 1 or H = 1** is a strip of single tiles. Every row is steady, and the formula still holds (machine-checked).
- **Many bobbins.** Many small regions make C2C or intarsia impractical. Report the bobbin count and suggest merging tiny regions in the image step.

---

## 8. How existing generators word their output (summary)

| Tool | Domain | Wording | Notable conventions |
|---|---|---|---|
| Stitch Fiddle [V] | graphs, C2C, knit | `Row 3: 2x red, blue (3 sts)` | counts in parentheses; any C2C start corner; "corner" marks the shaping switch; horizontal and vertical repeats |
| CrochetPop [V] | tapestry, mosaic | `Row 2: Ch 1, turn. 5 sc(White (BG)), sc(Orange-Red (A)), 5 sc(White (BG)) (11)` | odd rows right→left; direction arrows; color change on the last pull-through |
| CrochetFrog [V] | C2C, graphgan | `↙ Row 1 [RS]: (#F5EE14)x1 [1 block]` | bottom-right start; arrows; yarn-brand shade names |
| Stitchmate guide [V] | C2C | `← Row 59 [RS]: (Cream) x 12, (Teal) x 47 (59 blocks)` | W+H−1 rows; corner notes |
| C2C Graphs / Kim Latshaw [V] | C2C | `B7` | up/down direction per row; colored and B/W versions |
| fibertools [V] | circles | `Round 3: *2 sc in next st, sc in next 1 st* repeat 6 times. (18 sc)` | p×r counts; alternating placement |
| AmiGo [V] | 3D → amigurumi | `3: sc,(inc,sc)*2,(sc,inc)*5 [22]`; `rows 2-3: (sc, inc, 2sc)*3` | loop folding; join-as-you-go segments, no sewing (unverified); code under CC BY-NC-SA 4.0; "Branching meshes are not supported yet" ([GitHub](https://github.com/karinsifri/AmiGo)) |
| CrochetPARADE [V] | pattern language | `10*sc`, `3*[sc,dc]`, `sc2inc`, `sc2tog`, `turn` | "Each new line is a new row/round"; parses and checks patterns; site and code GPLv3, the user manual (grammar description) CC BY-NC-SA ([manual](https://www.crochetparade.org/Manual.html), [GitHub](https://github.com/crochetparade/CrochetPARADE)) |

- [I] **Licensing.** AmiGo's code is non-commercial share-alike and CrochetPARADE is GPLv3. Re-implement their ideas (loop folding, validation) instead of copying their code.

---

## 9. Recommendations for our design

1. **Use one pattern model with several renderers.** `Pattern → Piece[] → Line[] → Op[]` (§7.1). The renderers are amigurumi-compact, US-verbose and UK-verbose, plus word-chart and chart views. UK output comes from a terminology table, never from text replacement.
2. **Gate exports on the validator.** No export when E_* rules fail. W_* rules appear as inline notes in the editor (R7), so a user's 3D edit immediately shows the stitch-count consequences.
3. **Always print counts and define shorthand.** End every line with a count. Every pattern's Notes defines `N op`, inc, dec, MR, BLO and RS/WS reading (§3.6, §4.7, §6.12).
4. **Flat graphs.** Make the foundation `ch W+1`. Row 1 is RS. Print arrows. Include a left-handed toggle. Recommend carry vs bobbin per color with T = 8 and list bobbin counts in Materials.
5. **C2C.** Generate rows with the §4.4 algorithm. Print the action tag (`inc beg · dec end`) on every row, and add a one-time "Rectangle: from Row H+1 the top edge decreases…" note. Support all four start corners by transforming the chart.
6. **Amigurumi.** Use spiral + marker at center back, MR, invdec, and grouped + staggered shaping. Color runs are tagged per run. Add jog notes, the jogless-BLO prep stitch, the Ultimate-Finish close, a safety-eye warning, and assembly positions in round/stitch coordinates plus a landmark fallback.
7. **Compressor.** Use the DP from §7.4, with a one-level bracket cap, a tie-break toward fewer top-level items, segment hints from the generator (oval ends, color blocks, asymmetric arcs), and identical-round folding. Snapshot-test it with the §7.6 vectors.
8. **Skill level.** Compute CYC 1–4 from the §1.4 heuristic and show the reasons. Draw our own icons, or add CYC's credit line if we use their artwork.
9. **Materials.** Show hooks in US and mm. Show yarn per color in yd and m with a buy margin, plus notions actually used: stuffing, eye size, markers, tapestry needle, bobbins. Show gauge in CYC style, including `Rnds 1–6 = 2"` for amigurumi.
10. **Defer mosaic and Tunisian.** They need different quantizers (§5). Keep their abbreviations in the vocabulary so the model can represent them later.

---

## Sources

Craft Yarn Council (primary):
- CYC Standards & Guidelines PDF (2018): https://media.craftyarncouncil.com/sites/default/files/images/standards/CYC_YarnStandards-2018-11-06.pdf
- CYC Standards & Guidelines PDF (2015 rev.): http://media.craftyarncouncil.com/files/CYC_YS_s_and_g_rev2015_6.pdf
- CYC Crochet Chart Symbols PDF: https://media.craftyarncouncil.com/files/CYCACrochetChartSymbols.pdf
- CYC web pages:
  - https://www.craftyarncouncil.com/standards/crochet-abbreviations
  - https://www.craftyarncouncil.com/standards/project-levels
  - https://www.craftyarncouncil.com/standards/crochet-chart-symbols
  - https://www.craftyarncouncil.com/standards/how-to-read-crochet-pattern
  - https://www.craftyarncouncil.com/standards/yarn-weight-system

Papers and tools:
- AmiGo (SCF '22): https://arxiv.org/abs/2211.01178 (code: https://github.com/karinsifri/AmiGo)
- Dias & Karim, AAAI Summer Symposium 2025 (AAAI-SS Vol. 6 No. 1): https://ojs.aaai.org/index.php/AAAI-SS/article/download/36054/38209/40142
- CrochetPARADE: https://www.crochetparade.org/Manual.html and https://github.com/crochetparade/CrochetPARADE
- Stitch Fiddle:
  - https://www.stitchfiddle.com/en/help/1pen-80n7rh/written-instructions
  - https://www.stitchfiddle.com/en/help/1pei-97d7bo/pixel-crochet-c2c
- CrochetPop: https://learn.crochetpop.app/design/sc and https://learn.crochetpop.app/learn/mosaic-crochet
- CrochetFrog: https://crochetfrog.com/tools/c2c-graphgan-blanket-pattern-maker/
- Crochet Crowd / C2C Graphs: https://thecrochetcrowd.com/corner-corner-c2c-graph-maker/
- fibertools: https://fibertools.app/circle-calculator
- Stitchmate: https://stitchmate.app/guides/c2c-increase-decrease

Technique references:
- PlanetJune:
  - https://www.planetjune.com/blog/amigurumi-troubleshooter/
  - https://www.planetjune.com/blog/amigurumi-help/invisible-decrease/
  - https://www.planetjune.com/blog/amigurumi-help/how-to-crochet-a-magic-ring/
  - https://www.planetjune.com/blog/amigurumi-help/changing-colour/
  - https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/
  - https://www.planetjune.com/blog/front-loops-back-loops-both-loops/
  - https://www.planetjune.com/blog/amigurumi-help/jogless-back-loop-only-round-for-amigurumi-video/
  - https://www.planetjune.com/blog/amigurumi-help/ultimate-finish-for-amigurumi/
  - https://www.planetjune.com/blog/joining-amigurumi/
  - https://www.planetjune.com/blog/free-crochet-patterns/amigurumi-balloons/
- Lion Brand:
  - https://www.lionbrand.com/community/blog/using-reading-knit-crochet-charts/
  - https://www.lionbrand.com/community/blog/change-colors-crochet/
- Yarnspirations:
  - https://www.yarnspirations.com/blogs/how-to/blog-20160216-how-to-change-colors-tutorial
  - https://www.yarnspirations.com/products/red-heart-lion-amigurumi
- Kim Werker: https://www.kimwerker.com/2015/11/24/write-crochet-pattern-part-3-language/
- Edie Eckman: https://www.edieeckman.com/2019/08/28/where-to-put-the-first-stitch-of-a-crochet-row/
- Artisan Tech Editor: https://techeditor.co.uk/write-clear-crochet-patterns/
- cbfiberworks: https://cbfiberworks.com/how-to-start-creating-your-own-crochet-patterns/
- Hookabee:
  - https://hookabee.com/2016/03/01/how-to-read-amigurumi-patterns-abbreviations/
  - https://hookabee.com/2016/03/15/how-to-read-amigurumi-patterns-written-instructions/
  - https://hookabee.com/2016/04/26/how-to-read-amigurumi-patterns-written-instructions-cont/
- Sarah Maker C2C: https://sarahmaker.com/c2c-crochet/
- Dora Does: https://doradoes.co.uk/2021/08/05/how-to-crochet-a-rectangle-using-the-corner-to-corner-c2c-stitch/
- Craftematics: https://www.craftematics.com/crochet/corner-to-corner
- Simply Crochet / simply-yarn: https://simply-yarn.com/guides/how-to-crochet/how-to-read-crochet-charts
- Crochet It Creations: https://www.crochetitcreations.com/how-to-follow-a-graph-crochet-pattern/
- Lilla Björn: https://www.lillabjorncrochet.com/2019/07/nya-infinity-mosaic-blanket.html
- Juniper & Oakes: https://juniperandoakes.com/blog/how-to-crochet-overlay-mosaic-patterns/
- The Crochet Project (Tunisian): https://thecrochetproject.com/blogs/blog-the-crochet-project/tunisian-crochet-the-basics
- Morale Fiber (Tunisian): https://moralefiber.blog/2019/01/25/tunisian-simple-stitch-tutorial/
- LoveCrafts (tapestry): https://www.lovecrafts.com/en-us/blogs/articles-us/tapestry-crochet-how-to
- Banana Moon (intarsia): https://bananamoonstudio.com/intarsia-crochet-photo-tutorial/
- Wikipedia:
  - https://en.wikipedia.org/wiki/Tapestry_crochet
  - https://en.wikipedia.org/wiki/Mosaic_crochet
  - https://en.wikipedia.org/wiki/List_of_crochet_stitches
- And She Laughs (staggering): https://www.andshelaughsblog.com/crocheting-perfect-circle-staggered-increases-decreases/
- Airali (ovals): https://airalidesign.com/en/how-to-crochet-oval-shape/
- Look At What I Made (spiral vs joined): https://lookatwhatimade.net/crafts/yarn/crochet/crochet-tutorials/how-to-crochet-in-the-round-spiral-vs-joining/
- The Woobles:
  - https://thewoobles.com/pages/how-to-use-safety-eyes
  - https://thewoobles.com/pages/how-to-join-amigurumi-pieces
- Hello Yellow Yarn (Owie): https://helloyellowyarn.com/2018/10/22/owie-the-voodoo-doll-free-amigurumi-pattern/

*Research limits:*
- *The session's web-search budget ran out before I could find a primary source for the UK "miss" and "yrh" terms or for chart row-number placement. Those are marked [I].*
- *The Interweave and crochet.com pages returned HTTP 403, so they are not cited.*

---

## Verification notes

*Adversarial fact-check, 2026-09-30. I re-read primary sources (CYC 2018 and 2015 PDFs as extracted text, plus a render of the chart-symbol page), re-fetched the cited pages, and re-ran the arithmetic with my own scripts rather than relying on the author's.*

**Load-bearing claims 1–15: all confirmed.**

1. CYC "These definitions reflect U.S. crochet terminology" and the special-abbreviations sentence appear verbatim (2018 PDF printed p.1, and on the web page).
2. The punctuation definitions are verbatim (2018 PDF printed p.2). `( )` = "as many times as directed or work a group of stitches all in the same stitch or space". The web page's table leaves out the second meaning, so cite the PDF.
3. The US/UK ladder matches the PDF and web table, plus gauge→tension and yo→yoh. The naive double conversion (sc2tog→dc2tog→tr2tog) reproduces exactly.
4. Project levels 1 Basic / 2 Easy / 3 Intermediate / 4 Complex are confirmed on the web and in the 2018 PDF (printed p.12). The legacy crochet levels Beginner/Easy/Intermediate/Experienced are in the 2015 PDF (printed p.3). The 2015 PDF also has a separate knitting ladder.
5. The designer guidelines (2018 printed pp.33–34) and 2015 items a/b/d/e are verbatim. The motif gauge "Rounds 1–9 = 5"" is in the 2015 PDF, printed p.18.
6. The chart key was checked visually: sc as + or X, hdc as T, dc/tr/dtr with 1/2/3 ticks, BLO ⌒ and FLO ⌣ "at base of stitch being worked". Shell, picot, clusters, popcorn and FP/BP descriptions match the drawing.
7. Lion Brand (rows) and Simply Yarn/Simply Crochet (anti-clockwise; clockwise for left-handers) are verbatim. **But** Crochet It Creations, cited in §3.1, states the opposite flat-row direction (caveat added there).
8. Yarnspirations, Lion Brand ("roughly 8 to 10 stitches") and PlanetJune ("last loop of the stitch before") are confirmed.
9. Sarah Maker's increase/decrease wording, Dora Does' rows and Stitchmate's W+H−1 / min / |W−H| / min−1 split are confirmed. My own script verified per-row tiles and the start/end actions for 4×4, 5×3, 3×5, 10×7, 7×10, 1×5, 5×1 and 100×60 (row 101 = 59 tiles), and the §4.5 worked example including its colours.
10. PlanetJune's spiral, marker and ch-1 quotes are verbatim.
11. Hookabee's "2 sc" ambiguity sentence is verbatim.
12. PlanetJune's invdec steps and the jogless BLO sentence are verbatim. planetjune.com/invdec is mentioned.
13. The AmiGo quotes are verbatim: loop-folding order, inc(x)/dec(x) coupling, "stuffed enough", craters, venue SCF '22. The Fig. 1 rows check out: 8→15→22 consumed/produced. **Caveat added:** the `rows 2-3` folding example cannot be literally valid (12→15 twice).
14. And She Laughs' quote and the full staggered schedule 8→16→24→…→64 are confirmed. `sc, inc, (2 sc, inc) x5, sc` and `(sc, inc, sc) x 6` are the identical token sequence (18→24).
15. The Owie placements ("between Rounds 12 & 13, 6 stitches apart"; arms "19 & 20, 4 stitches apart at the front") and the Woobles under-3 warning are verbatim.

**Other numbers and facts re-checked**

- CYC yarn-weight web table (all 8 rows).
- CYC hook table, 2.25 mm B-1 through 10 mm N/P-15 (2018 PDF printed p.27), and the "rely on the package millimeter" sentence.
- The CYC credit line and e-mail request.
- The supply-list sample (printed p.29).
- Eckman's turning-chain table. Her "counts?" column is fuller on the page: hdc "sometimes; you can decide", dc/tr "usually but not always".
- Kim Werker's ( ) vs [ ] quote and examples.
- Red Heart Lion: Super Saver, H/8 5 mm, the finished-size sentence.
- PlanetJune balloons: worsted, "E US/3.5mm".
- The Ultimate Finish steps.
- The fibertools quotes and sample line.
- CrochetPARADE syntax (`10*sc`, `3*[sc,dc]`, `sc2inc`, `sc2tog`, `turn`) and its GPLv3 licence (README).
- AmiGo: CC BY-NC-SA 4.0 and "Branching meshes are not supported yet" (README).
- Craftematics, CrochetFrog, Crochet Crowd/Kim Latshaw (B1 up, B2 down).
- Stitch Fiddle's "corner" sentence and `Row 4: red, 2x blue, red (4 sts)`.
- Stitchmate's sample row.
- Juniper & Oakes, Lilla Björn, Airali, cbfiberworks, Artisan Tech Editor, Look At What I Made, PlanetJune loops and stripes, The Crochet Project (Tunisian), Woobles joining.
- Wikipedia's US/UK regions sentence.

**Arithmetic re-run with independent scripts. Everything matched.**

- Foundation formula `W + h − c` for sc/hdc/dc/tr.
- The §3.3 graph example, both RH and LH.
- Every §6.6 sphere round.
- Flat-bottom Rnd 6: 30→36.
- Oval ch 10: 17 loops → 20 → 26 → 32. Its whole-round encoding is valid and identical in tokens.
- Grouped distributions 37→30 and 29→37.
- §7.6 vectors 3–10, 15–18 and 22.
- A shortest-encoding DP of my own reproduced the compressor outputs for vectors 3, 4, 9 and 10 and the oval's `(sc, inc, 8 sc, inc, sc, inc) x 2`.

**What changed in this edit**

- Summary item 2: "requires counts only after…" → "asks for counts after…".
- Summary item 6: cross-reference §7.5 → §7.4.
- §1.3 example: the one-pass output now converts "Gauge" → "Tension", as CYC's table requires.
- §1.6: the 2018 PDF differs only for category 1 (2.25–3.25 mm). It was described as several narrower ranges.
- §3.1: added the Crochet It Creations contrary-direction caveat.
- §3.2: credited the "chain 31" quote to its source.
- §4.1: Sarah Maker's increase wording made verbatim.
- §4.6: C2C bobbin regions use 6-connectivity, not 8-connectivity. 8 would merge tiles that are two rows apart and under-count bobbins.
- §6.3 and §7.4: added the AmiGo `rows 2-3` caveat.
- §6.4 and Sources: the AAAI paper is a 2025 **Summer** Symposium paper by Dias & Karim about translating patterns *into* CrochetPARADE syntax. It is not "the CrochetPARADE paper".
- §8: CrochetPARADE's manual is CC BY-NC-SA, while the code is GPLv3.

**Marked (unverified)**

- Hookabee's `(3sc, Inc) *6`.
- CrochetPop's sample row line.
- Stitch Fiddle's "all four corners are supported" quote. Its written-instructions help only says starting corners can be chosen.
- AmiGo's "join-as-you-go segments, no sewing". The README's "branching meshes are not supported yet" makes multi-segment output doubtful.

**Remaining doubts / not re-checked**

- Not re-fetched: Wikipedia's mosaic and tapestry quotes, LoveCrafts, Banana Moon, Morale Fiber, PlanetJune joining, CrochetPop's mosaic page, and the CYC chart-symbol web page. They are low-stakes and left as the author tagged them.
- The re-fetched PlanetJune colour page summarises the unused-yarn options slightly differently: it ties "catch the float" to stranding over longer spans. §6.7 already flags its version as a paraphrase.
- The UK terms "miss", "yrh" and "quadruple treble" remain unsourced [I]. CYC's own list uses **yoh**, so default to yoh.
- The Lion Brand 8–10-stitch threshold comes from a page dated two weeks before this check. Re-verify before shipping copy that cites it.
