# 02 — Survey of 2D image→crochet generators (and what our 2D mode should do)

*Research date: 2026-09-30. Scope: requirement R1 (2D image → chart + written rows + materials + yardage per color), the 2D half of R4 (how existing generators work), and R8 (colors and patterns carried into the chart).*

---

## 0. How to read this document

- **[V]** means the claim was checked against a cited primary source. Primary sources here are a tool's own site, help center, FAQ or app-store listing; the JavaScript it ships to the browser; its GitHub source; a standards body (Craft Yarn Council); or a yarn maker's label data.
- **[I]** means it is our own inference, arithmetic on verified numbers, or a design recommendation.
- **[S]** means we saw it only through a search-engine summary or third-party page and could not open the primary page. Treat it as unconfirmed.

**Method.**
- We read help centers, FAQs and app listings for every named tool.
- We downloaded and read the client-side JavaScript of **Stitch Fiddle** and **Pixel-Stitch**. Both run their conversion in the browser, so the algorithm ships to every visitor. This gave code-level detail neither tool documents.
- We read the source of 13 GitHub projects, plus the libraries those tools use (RgbQuant.js, image-q, Color Thief, IMG.LY background removal).

**Limitations.**
- **Reddit (r/crochet, r/Tapestry_Crochet, r/c2c) could not be reached.** WebFetch refused `www.reddit.com` and `old.reddit.com`. The search API returned "domains not accessible to our user agent". A plain HTTP request got "blocked by network security".
- UX evidence therefore comes from blogs, the Ribblr community forum, App Store and Google Play reviews, and tool FAQs. A manual Reddit pass is a worthwhile follow-up.
- Some pages render only with JavaScript (Stitch Fiddle pricing).
- The shared web-search quota ran out near the end, so a few numbers are marked [S].

---

## 1. Executive summary

1. **Every generator uses the same skeleton** [V]: load → crop/rotate → resize to the stitch grid → reduce colors (often snapped to a thread or yarn palette) → map pixels to colors (sometimes dithered) → remove rare or isolated colors → render chart and legend → sometimes write row-by-row text. Tools differ in four places: cleanup, palette realism, stitch-aspect handling, and outputs. Sources: Stitch Fiddle bundle, Pixel-Stitch worker, and the GitHub projects in §3.9.
2. **Stitch Fiddle is the de-facto standard and the most complete tool.** From its shipped code [V]:
   - It quantizes with **RgbQuant.js** and does no dithering.
   - It can quantize against a **brand-yarn palette** drawn from 827 yarn lines.
   - Its cleanup removes "confetti" by 8-neighbour majority vote, removes colors used fewer than 10 times, and merges colors within **CIEDE2000 ≤ 5**.
   - It offers optional in-browser **ML background removal** (IMG.LY, AGPL-3.0).
   - Other features: physical sizing from a gauge swatch; written instructions for rows and for C2C from any corner; a row, column or diagonal progress tracker.
   - The free plan allows 300×300 stitches and 50 colors.
   - **It gives no yarn amounts** ("There's no easy formula").
   - Its crochet grid **defaults to square boxes**.
3. **Pixel-Stitch exposes the most algorithm knobs** [V]: MMCQ or RgbQuant quantization; 5 color-distance metrics up to CIEDE2000; 5 error-diffusion kernels with **Atkinson as the default**; a rare-color threshold; a thread-usage estimate. It targets cross-stitch: no crochet aspect ratio and no written rows.
4. **KnitPro is the minimal baseline** [V]: fixed grids (48×64, 96×120, 120×160), a 1:1 cell for crochet, and **no color reduction at all**. **Pic2Pat is cross-stitch only** (DMC, Aida) [V].
5. **Single crochet is not square** [V]. Yarn labels give worsted sc gauges of 12–14 sts × 13–17 rows per 4". That makes the cell height/width ratio **0.80–1.00, median ≈ 0.86**, and wider than tall. A chart with square cells therefore crochets up squat. C2C tiles are close to square: about 0.75–0.78" each in measured worsted swatches with a 5 mm hook; The Crochet Crowd's sizing guide implies about 0.86" (fact-check: added; see §3.5).
6. **Yardage is the biggest gap.** Stitch Fiddle declines to estimate it. The tools that do estimate use constants that **disagree by up to about 2.6×**:
   - C2C: 21" per tile measured, against 1–1.5 yd per tile in rules of thumb.
   - sc: 1.8–4.7" per stitch.
   - Almost none account for carried strands in tapestry. [V for the numbers; the ratio is our arithmetic, I]
7. **C2C written rows are run-length lists along diagonals** with three phases: increase, steady (rectangles only), and decrease. Several open-source generators get **rectangles or row direction wrong** [V from their code].
8. **Overlay mosaic has a hard rule: no two vertically adjacent drop-stitches.** Stitch Fiddle enforces it greedily at import [V code]. A per-column dynamic program gives the optimal result instead [I].
9. **"AI" photo-to-pattern apps are opaque subscriptions with weak reviews** [V]. Research (CrochetBench) finds vision-language model performance "sharply decreases" when output must be executable [V] (fact-check: was "collapse", softened to the paper's own wording). A leading free tool states its patterns are "never written by a language model" [V]. This supports our constraint: deterministic algorithms and no LLM calls.
10. **Recommendation** [I]:
    - **P0:** sc tapestry/graphgan (flat and in the round) and C2C.
    - **P1:** overlay mosaic, an intarsia/bobbin working mode, and an hdc graphgan option.
    - **P2:** Tunisian (tss) colorwork and filet.
    - We beat the field on: physical sizing with the true stitch aspect; a perceptual color pipeline constrained to brand or stash yarn; "crochetability" cleanup with live metrics; swatch-calibrated yardage per color that includes carried strands and tails; correct written rows for every technique; and a free PDF plus progress tracker, all running locally.

---

## 2. Landscape at a glance

| Tool | Runs where | Inputs | Color reduction / palette | Dither | Cleanup | Aspect / gauge | Outputs | Yardage | Cost |
|---|---|---|---|---|---|---|---|---|---|
| **Stitch Fiddle** | Web app, no native app ([help](https://www.stitchfiddle.com/en/help/1pe6-4yrdj8/app-android-and-ios)); conversion runs in the browser | jpg/gif/png; longest side ≤300 free / ≤1,000 premium; ≤50 / ≤200 colors ([help](https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture)); crop, rotate, brightness, contrast, background removal; brand-yarn palette | RgbQuant (method 2, luma-weighted Euclidean), brand palette passed in as a fixed palette [V code] | none [V code] | confetti (8-neighbour, ΔE00), min occurrence 10, merge ΔE00 ≤ 5 [V code] | crochet boxes square by default; gauge proportions settable ([help](https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture)) | chart PDF split over pages; PNG/JPG/GIF/SVG; legend; written rows and C2C (any corner); tracker | **none** ([help](https://www.stitchfiddle.com/en/help/1pek-c4t7aj/order-supplies)) | free / Premium (~$2.75/mo [S]) |
| **Pixel-Stitch** | In-browser ([site](https://www.pixel-stitch.net/)) | width 2–600 sts; 2–120 colors; DMC, Anchor, Sulky, RGB or custom CSV palette ([instructions](https://www.pixel-stitch.net/sites/instruction.html)) | MMCQ or RgbQuant; WED, ED, CIE76, CIE94 or CIEDE2000 [V code] | Floyd–Steinberg, **Atkinson (default)**, Stucki, Burkes, Sierra [V code] | "Remove colors below N" | none (cross-stitch) | PDF (symbols, boxes or circles; page overview), Excel, OXS | skeins = ⌊count ÷ (sts per skein ÷ ply) × (1 + extra%)⌋ + 1 [V code] | free |
| **KnitPro (Microrevolt)** | Server (PHP) ([app](http://www.microrevolt.org/knitPro/)) | jpg/gif/png < 1 MB, < 1,000 px wide | **none**: "If your image has millions of colors your knitPro pattern will too" ([FAQ](http://www.microrevolt.org/FAQ.htm)) | none | none | 1:1 (crochet, needlepoint, cross-stitch), 5:7 or 7:5 (knit) | `file.pdf` graph | none | free |
| **Pic2Pat** | Server upload ([site](https://www.pic2pat.com/index.en.html)) | almost any format ≤ 18 MB; size in cm; Aida 11/14/16/18 | DMC floss | ? | ? | n/a (cross-stitch only) | PDF chart and key | DMC skeins | free |
| **Stitchboard** | Web | image; width ≤ 150; "color sensitivity" where a high value means few colors (385–500) ([Stardust Gold](https://stardustgoldcrochet.com/5-best-graphing-programs-for-c2c-corner-to-corner-and-graphgans/)) | Red Heart colors | ? | "No way to change or clean up the image" | height cannot be set ([Illuminate Crochet](http://illuminatecrochet.blogspot.com/2014/01/stitchboard.html)) | graph and written pattern, paged | ? | free |
| **C2CGraphs (Kim Latshaw)** | Human service, Etsy ([Crochet Crowd](https://thecrochetcrowd.com/corner-corner-c2c-graph-maker/)) | your idea or a stock design | manual | – | manual | – | PDF graph plus color-coded and black-and-white **word charts** ("B7") | – | paid |
| **ArtPatt** (2025–26 wave) | Web ([page](https://artpatt.com/c2c-crochet-pattern-generator)) | 40–80 tiles wide; gauge; yarn database of 120+ | ? | Floyd–Steinberg optional | "Heavy" confetti reduction | claims are internally inconsistent (see §3.5) | numbered PDF; written color runs; balls per color | 19 cm per dc, 12 cm per sc, +15% | 1 free/wk; $2.99 per pattern; $6.99/mo |
| **Stitchmate** | Web ([page](https://stitchmate.app/photo-to-crochet-pattern)) | blocks W×H; Red Heart Super Saver, Caron One Pound, Bernat Super Value | nearest yarn shade; pixel art imported "with no resampling" | ? | confetti "folded into neighbors" | – | PNG free, PDF paid; C2C rows with RS/WS markers and counts | block counts | freemium |
| **MakeBead** | In-browser ([page](https://makebead.com/crochet-pattern-maker)) | width 60–240; Red Heart Super Saver only; 5–20 colors | nearest Red Heart Super Saver | Floyd–Steinberg toggle | ? | size from gauge | PDF with codes; legend with stitch counts | approx. skeins | free |
| **CrochetPop** | In-browser ([site](https://learn.crochetpop.app/)) | photo or templates; filet, sc pixel, C2C, granny pixel, mosaic | quantized | ? | ? | ? | written rows with foundation and turning chains; PDF; **Live Row Tracker with audio** | estimate | free; "never written by a language model" |
| **Bobble Designs** | Web ([site](https://bobbledesigns.com/)) | photo; number of colors; your swatch gauge | "smart colour matching" | ? | ? | real finished size from swatch | written "which colour, how many, which way"; PDF on Pro | +10% allowance | £3.99/mo Pro |
| **Graphghan Pattern Creator** | iOS and Android ([Google Play](https://play.google.com/store/apps/details?id=com.crochetdesigns.graphghan&hl=en_US)) | picture button, trace, 400+ stamps and borders | ? | ? | ? | ? | written instructions, "amount of thread/yarn needed", approx. size | method not disclosed | $2.99 unlock; **1.3★ (339 reviews; 309 on phones)** (fact-check: was "309 reviews") |
| **Knitting Chart** | iOS ([App Store](https://apps.apple.com/us/app/knitting-chart/id1251317736)) | photo to color chart; Pro up to 500×500 | ? | – | – | flat, in-the-round, C2C and left-handed layouts | PDF, images, written | – | $19.99 Pro; 4.3★ (1.3K) |
| **Ribblr** | Pattern platform ([help](https://ribblr.com/help/ribbuild-interactive-charts-can-i-add-charts-to-my-patterns-how-can-i-add-an-interactive-chart/)) | chart editor (no photo import); ≤ 23,000 cells ([guidelines](https://ribblr.com/epattern?wiki=1)) | – | – | – | C2C orientation option | interactive charts; mark cells as done; makers can recolor | – | platform |
| **"AI" apps** (Patternize, Crochetly, Yarniby) | iOS | a photo | opaque | – | – | – | "step-by-step" text | claimed | subscriptions (e.g. $4.99/week) |

---

## 3. Tool-by-tool findings

### 3.1 Stitch Fiddle: the reference implementation

**Product surface** [V]

- **Crochet chart types** ([create page](https://www.stitchfiddle.com/en/chart/create/crochet)): Corner 2 Corner ("Crochet colorwork in diagonal direction, e.g. 2 or 3 hdc/dc stitches"); Crochet Colorwork ("graphgan, pixel crochet, picture crochet, tunisian colorwork, tapestry"); Filet; Overlay Mosaic ("One color for one row and change color every row, starting on same side each time"); Free Form; Tunisian Colorwork; Tunisian with Return Pass; general symbol charts.
- **Import limits** ([import help](https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture)):
  - "The maximum grid size is 300 x 300 in the free version and 1,000 x 1,000 in the Premium version."
  - "The maximum number of unique colors is 50 in the free version, and 200 in the Premium version."
  - The size you enter is "the maximum number of stitches (boxes) for the longest side".
  - "For crochet, the boxes are squares by default. For knitting, the default gauge is set to 18/24."
- **Written instructions** ([help](https://www.stitchfiddle.com/en/help/1pen-80n7rh/written-instructions)):
  - Example output: `Row 1: red (1 st)`, `Row 3: 2x red, blue (3 sts)`.
  - "For c2c patterns, you can choose the corner you'd like to start from (all four corners are supported)."
  - "Where you see 'corner' … switch from increasing to decreasing (or … decreasing to increasing)."
  - Output can be copied as plaintext or Markdown. A color can be flagged as "no stitch".
  - Willow Crochet lists written instructions, fill and selection as **paid** features ([Willow Crochet](https://www.willowcrochet.com/stitch-fiddle-features-for-crochet-colorwork/)).
- **Progress tracker** ([help](https://www.stitchfiddle.com/en/help/1pdx-98nqe4/progress-tracker)): works as a "horizontal row counter, vertical row counter or diagonal row counter". It can darken work to do, work done, or everything except the current row. Progress is stored per user on shared charts.
- **Download** ([help](https://www.stitchfiddle.com/en/help/1pe3-3svb1t/download-print)): PDF up to 1,000×1,000, split over multiple pages; PNG/JPG/GIF; the legend as a separate image or embedded; SVG with editable row and column numbers.
- **Yarn**: there is a product database of **827 knitting/crochet yarn lines** with per-line color counts, e.g. "Caron One Pound 43 colors" and "Cascade 220 170 colors" ([products](https://www.stitchfiddle.com/en/products/knitting-crochet)).
- **Yarn amounts**: "There's no easy formula to calculate how much yarn you need" ([order supplies](https://www.stitchfiddle.com/en/help/1pek-c4t7aj/order-supplies)).
- **Pricing**: "$2.75 per month … $33.00 … for a whole year … up to 250 unique colors/symbols per chart" [S, search-indexed text of the JS-rendered [pricing page](https://www.stitchfiddle.com/en/premium/pricing)].
- The help pages lag the product. The import help still says that choosing your own colors is coming "later on this year", but the shipped code already supports brand and custom palettes (below).

**Import pipeline, read from the shipped bundle** [V: [`en-main-4b1191b3eb71d8a8d3ec.js`](https://www.stitchfiddle.com/rsrc/1765940698/js/en-main-4b1191b3eb71d8a8d3ec.js), read 2026-09-30; the hash in the URL changes with each release]

1. **Default import settings object:**
   `{shape:"lockAspectRatio", columnCount:200, rowCount:200, selectionX/Y/Width/Height (crop), rotate:0, gaugeHorizontal/Vertical, swatchLength*/swatchCount*, colorsSource:"", productCategoryId, productIds:[], backgroundProductId:"", colorCount:25, confetti:0, brightness:0, contrast:100, imageSmoothing:false, removeBackground:false, minColorOccurrence:10, minColorDistance:50}`.
2. **Load and composite.** The image is drawn onto a canvas pre-filled with the color of the chosen **background yarn** (`backgroundProductId`), or `#fff` if none is chosen. Transparent pixels therefore become the background yarn.
3. **Background removal** (optional). It uses `@imgly/background-removal` 1.7.0, served from `cdn.stitchfiddle.com/1/js/imgly/1.7.0/`, in a Web Worker with a main-thread fallback. That library is **AGPL-3.0** ([repo](https://github.com/imgly/background-removal-js)).
4. **Crop, rotate, resize** to the grid. The canvas resize uses `imageSmoothing` (default **false**, i.e. no smoothing).
5. **Brightness and contrast**: `v + brightness`, then `(v − 128)·contrast/100 + 128`.
6. **Palette source** (`colorsSource`):
   - `productCategory`: the colors of a yarn line, filtered to `available === "yes" && solid` (variegated yarns excluded), optionally restricted to the products the user picked. (Fact-check: the restriction applies only when **2 or more** products are picked: `productIds.length < 2 || …`. Picking one product still uses the whole line.)
   - `chart`: colors from an existing chart.
   - custom: the user's own colors.
7. **Quantize.** The call is `new RgbQuant({colors: colorCount, palette, method: 2, colorDist: "euclidean"})`, then `sample()` and `reduce()`. No dithering kernel is passed, so pixels are mapped to their nearest color.
   - In RgbQuant ([source](https://github.com/leeoniya/RgbQuant.js/blob/master/src/rgbquant.js)), "euclidean" is **luma-weighted RGB** (weights .2126 / .7152 / .0722).
   - Method 2 builds the histogram per 64×64 subregion. A color enters the global histogram only if it appears at least `boxPxls` (2) times, scaled by box area.
   - When a predefined palette is larger than `colors`, RgbQuant walks the **frequency-sorted** histogram and keeps the first `colors` distinct palette entries it hits. Brand-yarn selection is therefore greedy by frequency.
8. **Post-process** (function `_`):
   - a. **Confetti**, when the `confetti` setting is ≤ 50. The code builds a pairwise **CIEDE2000** matrix of palette colors. A cell is confetti if **none of its 8 neighbours** has a color within ΔE00 ≤ `confetti` of its own (with the default 0, that means no neighbour of the identical color). Each confetti cell is replaced by the **most frequent neighbour color**, with ties going to the color closest in ΔE00.
   - b. **Rare colors**: colors used in fewer than `minColorOccurrence` (10) cells are remapped to the nearest remaining color by ΔE00. This step is skipped if it would leave fewer than 2 colors.
   - c. **Near-duplicates**: colors within ΔE00 ≤ `minColorDistance/10` (default **5**) are merged into the more frequent one.
   - d. Unused palette entries are dropped.
9. **Technique transform** (crochet only). For `mosaicOverlay` with exactly 2 colors the code:
   - adds a start row and two end rows. (Fact-check: more precisely, it prepends one row at array index 0, appends two rows that **both** take the color of the first appended row, and prepends one more row when needed to make the row count even. Whether index 0 is the top or the bottom of the worked piece was not confirmed, so the start/end labels are (unverified).);
   - forces alternating row colors (`t % 2`);
   - for each cell that deviates from its row color while the cell in the previous array row (t − 1) also deviates, resets the cell to its row color (so no two vertically adjacent "flips"). The pass is greedy and runs in array order;
   - sets the first and last columns to the row color (edge stitches), except on the last two array rows.
10. **Chart settings per technique preset**: `direction2: "rightToLeftAlternating"`, `ignoreStitchesLeft/Right` (edge stitches left out of the written text), `maxColorsPerRow: 2` for mosaic, and grid emphasis lines every **5 and 10** cells.

**Takeaways** [I]
- Stitch Fiddle's strength is robust cleanup with perceptual merges, real yarn palettes, and breadth of techniques.
- Its weaknesses:
  - The crochet aspect is square unless the user fixes it.
  - Brand matching uses a non-perceptual distance and is greedy by frequency, so small but important colors such as eyes can lose out.
  - No yardage; no carried-yarn or bobbin awareness.
  - The written text carries no yarn names, only abbreviations.
  - Key features sit behind a paywall.

### 3.2 Pixel-Stitch (pixel-stitch.net)

Cross-stitch focused, but often used by crocheters. Everything runs in the browser: "No images are stored" ([site](https://www.pixel-stitch.net/)).

**Pipeline, read from the code** [V: [`pixel-stitch.min.js`](https://www.pixel-stitch.net/js/pixel-stitch.min.js), [`worker.min.js`](https://www.pixel-stitch.net/js/worker.min.js), [`language.js`](https://www.pixel-stitch.net/js/language.js)]

1. **Resize.** `ctx.drawImage(img, 0, 0, W, H)` with height `H = ⌊imgH·W/imgW⌋`, which is the browser's default resampler. Width 2–600, colors 2–120.
2. **Palette, in a Web Worker.**
   - MMCQ (modified median cut, the Color Thief algorithm) **skips pixels with alpha < 125 and near-white pixels (all channels > 250)**.
   - The alternative is RgbQuant (`method: 1`).
3. **Brand threads.** When a thread brand is chosen, it requests **1.1× the color count**, then snaps each palette color to the nearest thread. Duplicates collapse, which is why it over-requests.
   - Brands: "DMC", "Anchor", "Sulky", or "All colors (RGB)".
   - Individual colors can be deselected.
   - A **custom palette can be uploaded as CSV/TXT lines `#hex,description`** ([instructions](https://www.pixel-stitch.net/sites/instruction.html)).
4. **Map pixels to colors** with one of these distances:
   - Weighted Euclidean, using the "redmean" weights `(2 + r̄/256)Δr² + 4Δg² + (2 + (255 − r̄)/256)Δb²`
   - Euclidean
   - CIE76
   - CIE94
   - CIEDE2000

   Optional error diffusion uses Floyd–Steinberg, **Atkinson (default selected)**, Stucki, Burkes or Sierra, scanned in plain raster order (not serpentine).
5. **Rare colors.** Colors whose count is ≤ the threshold are merged into the nearest kept color and the image is remapped. The palette is then sorted by frequency.
6. **Thread usage.** `skeins = int(count / (stitchesPerSkein(aida) / ply) × (1 + addition/100)) + 1`.
   - Stitches per skein for 1 ply range from 1,400 (6-count) to 6,600 (32-count); 18-count is 3,800.
   - "Addition" defaults to **30%**. Its help text says: "If the stitched image has few contected [sic] areas, thread consumption will increase as well." (Fact-check: the source spells it "contected"; the old text silently corrected it to "connected".)
   - The help tooltip's own table (18-count: 2,000 stitches per skein at 2 ply, 1,300 at 3 ply) roughly matches 3,800 ÷ ply.
7. **Outputs.**
   - PDF via jsPDF with styles: Symbols; Letters/Numbers; Numbers; any of those three with colored boxes; Colored Boxes; Colored Circles.
   - "Highlighted lines" every 2–20 rows, printed thicker; a "Page order overview"; cell size 0.1–10 mm.
   - Excel and **OXS** (Open Cross Stitch XML: palette items plus `<stitch x y palindex>`).
8. **FAQ** ([faq](https://www.pixel-stitch.net/sites/faq.html)): "Pixel-Stitch does not support transparent png formats … The background can be removed using other … programs."

**Takeaway** [I]: this is the best public reference for user-selectable metrics and dithering. The white-exclusion quirk in its MMCQ path can drop pure-white backgrounds from the palette in RGB mode; stitchy, below, works around the same Color Thief behavior by force-adding white.

### 3.3 KnitPro (Microrevolt)

All [V] from the [FAQ](http://www.microrevolt.org/FAQ.htm) and [app page](http://www.microrevolt.org/knitPro/):

- Inputs: GIF, JPEG or PNG "less than 1 MB" and "under 1000 pixels wide".
- Grid presets: Regular 48w × 64h, Big 96w × 120h, XL 120w × 160h.
- Stitch size: "Needlepoint, Cross Stitch, Crochet (1:1)", "Knit Portrait (5:7)" or "Knit Landscape (7:5)". "Knit stitches are not square … the 5:7 ratio helps."
- Output is a PDF named `file.pdf` (unverified: neither the app page nor the knitPro 2.0 source sets this name; the source names server copies `<timestamp>.<name>.pdf`). The app is PHP 4 + GD; the source was released under CC-GPL 2.0 (knitPro 2.0, January 2006).
- **No color reduction**: "If your image has millions of colors your knitPro pattern will too". Downscaling "sometimes causes interpolated colors (an average shade …)". Users are told to reduce colors in Photoshop or GIMP first.
- **Indexed-color images produce an all-black or all-white grid** ("must be changed to RGB").

This is the floor a modern tool must clear.

### 3.4 Pic2Pat

[V] ([site](https://www.pic2pat.com/index.en.html)): "almost all image formats … maximum file size is 18 MB"; the picture is uploaded to the Pic2Pat server; size in cm; Aida 11, 14, 16 or 18. It calculates "which colors embroidery floss are needed and how many skeins". There is no crochet mode. Its relevance is only the materials model: automatic skein counts per color are expected by users.

### 3.5 C2C and graphgan generators (services and the 2025–26 web wave)

- **C2CGraphs / Kim Latshaw** (sold through The Crochet Crowd) [V] ([graph maker](https://thecrochetcrowd.com/corner-corner-c2c-graph-maker/)):
  - Hand-made graphs with "one [word chart] with the colours in each box and the other … without colour highlighting".
  - The word format is "**B7**", meaning color B, 7 blocks. Row 1 is worked "in up direction"; row 2 goes from the side "down to the horizontal bottom".
  - The [beginners tutorial](https://thecrochetcrowd.com/corner-corner-graphghans-beginners-tutorial/) starts at the bottom right and advises left-handers to mirror. "1 Box on the graph equals 1 box on the project."
  - Widths with a 5 mm (H/8) hook and worsted (e.g. Bernat Super Value): baby ≈ 30" ≈ 35 blocks wide; child ≈ 42" ≈ 49 blocks; throw/queen ≈ 60" ≈ 70 blocks. That implies about 0.86" per block. (Fact-check: was "baby ≈ 30–35 blocks, child ≈ 42–49, throw ≈ 60–70". The source text "about 30" - 35 Blocks Wide" pairs inches with blocks; it is not a block range.)
  - On bobbins: "Bobbins can be your best friend, or they can be your living nightmare if you have too many." Without word charts, "just count the boxes and highlight as you go."
- **Stitchboard** [V]:
  - Width ≤ 150; "you can't control how many rows"; output is "more of a starting place than a complete pattern"; a two-color picture came out with "three colors". Sources: [Illuminate Crochet](http://illuminatecrochet.blogspot.com/2014/01/stitchboard.html), [Stardust Gold Crochet](https://stardustgoldcrochet.com/5-best-graphing-programs-for-c2c-corner-to-corner-and-graphgans/).
  - Its color control runs backwards: "to limit the color palette to only a few colors … set the value very high (385-500)".
- **Winstitch / PCStitch** (desktop cross-stitch software also used for C2C) [V] ([Stardust Gold](https://stardustgoldcrochet.com/5-best-graphing-programs-for-c2c-corner-to-corner-and-graphgans/)):
  - "Importing clip-art adds extra colors that aren't even there!" This is the anti-aliasing problem.
  - Winstitch writes C2C and row-by-row instructions for right- and left-handers.
- **The 2025–26 wave** of SEO-driven web tools (ArtPatt, Stitchmate, MakeBead, CrochetPop, Bobble, CrochetPatternGen) converge on:
  - in-browser conversion;
  - named US yarn lines (Red Heart Super Saver, Caron One Pound, Bernat Super Value);
  - a **confetti cleanup** step ("finds them and folds them into their neighbors", [Stitchmate](https://stitchmate.app/photo-to-crochet-pattern));
  - an optional Floyd–Steinberg toggle ([MakeBead](https://makebead.com/crochet-pattern-maker));
  - C2C written rows with RS/WS markers and block counts;
  - per-color counts and skein estimates.

  CrochetPop is fully free and offers filet, sc pixel, C2C, granny pixel and mosaic. Its rows include "foundation chain, turning chains, real stitch abbreviations". It has a Live Row Tracker with audio, and its stitch math is "machine-validated" ([CrochetPop](https://learn.crochetpop.app/)) [V].
- **Their numbers are unreliable.** ArtPatt states both "roughly 10 C2C squares per 10cm … a 60-square-wide blanket = 60cm" and "3cm per C2C square … about 60 squares wide" ([ArtPatt](https://artpatt.com/c2c-crochet-pattern-generator)) [V]. These contradict each other. A measured worsted tile is about 0.75–0.78" (1.9–2.0 cm); The Crochet Crowd's sizing implies about 0.86" (2.2 cm) (fact-check: added) ([Blue Frog Creek](https://www.bluefrogcreek.com/blogs/all-about-the-c2c-stitch/c2c-105-yarn-guide), [Pixel Crochet](https://pixelcrochet.com/crochet-a-c2c-gauge-swatch-and-calculate-finished-dimensions/)) [V].

### 3.6 Mobile and desktop apps

- **Graphghan Pattern Creator** (Crochet Designs, iOS and Android) [V] ([Google Play](https://play.google.com/store/apps/details?id=com.crochetdesigns.graphghan&hl=en_US), [App Store](https://apps.apple.com/us/app/graphghan-pattern-creator/id6448245144)):
  - Features: a "Picture button … convert it to a pattern"; a "Trace" button; "Written Graphghan crochet instructions are automatically generated … Included are the amount of thread/yarn needed and approximate finished sizes".
  - The free download needs a $2.99 unlock. The listing discloses it ("To activate creation is $2.99"), but reviewers say they missed it. Rated **1.3★ from 339 reviews** (Google Play header; the phone-filtered review panel shows 309). (Fact-check: was "1.3★ from 309 reviews".) 50K+ downloads; listing updated Aug 30, 2026.
  - Reviews: "you have to pay 2.99 to be able to actually make your own graphghans"; "This is a bunch of preloaded options even after paying".
- **Knitting Chart** (iOS) [V] ([App Store](https://apps.apple.com/us/app/knitting-chart/id1251317736)):
  - Features: "Convert images to color charts"; Pro up to 500×500; flat, in-the-round, **corner-to-corner and left-handed** layouts; a "Working Mode" row and stitch tracker; written instructions; PDF.
  - 4.3★ from 1.3K ratings; $19.99 Pro. Complaints are about performance on large charts and the selection tools.
  - Recommended on the Ribblr forum, where its free tier is noted as limited to 50×50 ([Ribblr thread](https://meet.ribblr.com/t/free-app-for-making-tapestry-grids/587705)).
- **Crochet Chart** (iOS, symbol charts) [V] ([App Store](https://apps.apple.com/us/app/crochet-chart/id1473051046)): 70+ symbols including Tunisian; circle, rectangle, oval, spiral and triangle guides; image import for tracing. 3.7★ (75); $8.99 Pro.
- **"Stitch Fiddle Pattern Maker"** (iOS listing, [App Store](https://apps.apple.com/us/app/stitch-fiddle-pattern-maker/id6759521479)) [V]:
  - Describes "StitchCraft", a cross-stitch converter with 477 DMC colors. Free tier: 80 stitches wide, 20 colors. $39.99/yr or $59.99 lifetime. 3.7★ (33).
  - Reviews: "can't undo something without paying".
  - [I] Probably not made by stitchfiddle.com, which says it has no native app.
- **CrochetCharts** (Stitch Works Software, desktop) [V] ([repo](https://github.com/StitchworksSoftware/CrochetCharts)): open-sourced under GPL-3.0; Qt 4.8; last push 2017. It is a **symbol-chart** designer, not an image converter.
  - (unverified: the ACM page returned HTTP 403 to the fact-checker, so the two quotes below were not re-checked.) Seitz et al. describe such editors as merely "support[ing] the graphical arrangement of stitch symbols … none of these tools allows designers to explicitly define the relation between stitches" ([Onward! '22](https://dl.acm.org/doi/10.1145/3563835.3567657)).
  - The same paper defines a **crochet graph** as a grid notation usable only "for patterns that are flat and whose arrangement of stitches matches a grid".

### 3.7 Ribblr

[V] Ribblr is a platform for interactive ePatterns, not a converter.
- Its chart editor supports knitting, crochet and Tunisian symbols and colors. "Click the chart's frame for all orientation options, such as C2C." Makers "track their progress by marking specific cells" and can "customize colorwork patterns by changing the chart's colors" ([help](https://ribblr.com/help/ribbuild-interactive-charts-can-i-add-charts-to-my-patterns-how-can-i-add-an-interactive-chart/)).
- Limit: "up to 23,000 cells (i.e 150x150 or 300x75)". Yarn colors in the materials list are linked so makers can recolor charts to their own yarn ([guidelines](https://ribblr.com/epattern?wiki=1)).
- Two ideas are worth copying [I]: **recoloring a chart to "my yarn"**, and **cell-level progress marking**.

### 3.8 "AI" pattern generators

- App Store listings [V]:
  - **Patternize**: "our AI generates a detailed, step-by-step amigurumi pattern" from a photo. (Fact-check: the old text quoted "converts photos into crochet patterns using AI", which does not appear on the listing; replaced with the listing's wording.) Priced $4.99/week, $5.99/month, $29.99/year or $79.99 lifetime, plus coins ([listing](https://apps.apple.com/us/app/patternize/id6758268844)).
  - **Crochetly**: 3.5★ (6). Review: "I've taken several photos and not one was converted to pattern directions" ([listing](https://apps.apple.com/us/app/crochetly/id6755979463)).
  - **Yarniby**: 4.7★ (44). Review: "I have to what [sic] cuz I make mistakes of the pic" (fact-check: was quoted as "watch") ([listing](https://apps.apple.com/us/app/-/id6755068624)).
  - None documents its method.
- **CrochetBench** (arXiv 2511.09483) [V] evaluates vision-language models on stitch recognition, instruction grounding and image-to-DSL translation, using the CrochetPARADE DSL as an executable target. Quote: "performance sharply decreases as the evaluation shifts from surface-level similarity to executable correctness" ([abstract](https://arxiv.org/abs/2511.09483)).
- CrochetPop advertises the opposite stance: "deterministic algorithms and machine-validated … never written by a language model" ([site](https://learn.crochetpop.app/)) [V].
- [I] For a 2D chart the image-to-grid mapping is fully algorithmic. LLMs add nothing but risk and fit neither our no-paid-API rule nor validation.

### 3.9 Open-source projects (read in full)

GitHub search tip: "graphgan" returns machine-learning "GraphGAN" repos; search "graphghan" instead.

| Repo | Pipeline (what the code does) [V] | Notable / defects |
|---|---|---|
| [jamestomasino/stitchy](https://github.com/jamestomasino/stitchy/blob/master/scripts.js) (GPL-3.0, 23★) | User sets the grid and transforms the image under it by hand; **per-cell box average**; palette from Color Thief (MMCQ); nearest color by RGB Euclidean; click a cell to cycle its color; PNG export | Code comment: "force add white for backgrounds", working around Color Thief skipping white pixels |
| [bilalchaudhry03-commits/hookline](https://github.com/bilalchaudhry03-commits/hookline/blob/main/index.html) | **Gauge toggle**: row height 0.60–1.00, default **0.75**, with the note "Sc stitches are wider than tall"; `rows = round(cols·A/r)`; **centre cover-crop** to the finished aspect; brightness, contrast and saturation; **seeded k-means++ in CIELAB** (≤ 16 iterations, k 2–16); palette ordered dark to light; **run-level follow-along** cursor `{wrow, run}` with a start side | The best small reference for aspect and follow-along |
| [bishal0922/TapestryCrochet](https://github.com/bishal0922/TapestryCrochet) ("500+ monthly users") | Canvas resize; k-means on the **set of unique colors** (unweighted, random initialization, 10 iterations); "CIE76" in the code is actually weighted RGB (fixed weights 2/4/3 on ΔR²/ΔG²/ΔB² plus half the squared Rec. 709 luma difference; not redmean); exports text, HTML and JSON; progress tracker with notes | [I] Clustering unique colors lets JPEG noise outvote large flat areas |
| [infomanc3r/stitchfizzle](https://github.com/infomanc3r/stitchfizzle) (Tauri/React; open "Stitch Fiddle"-style app) | 6 chart types; frequency-weighted **median cut** plus RGB Euclidean; alpha > 128; run-length written rows; exports PNG, SVG, PDF, Excel, JSON | [I from code] Row text is not reversed on alternate rows (wrong for flat back-and-forth work); C2C rows are labeled only Inc/Dec, so a rectangle's **steady phase is mislabeled**; C2C diagonals all read in the same direction |
| [TechnicalTortoise/c2cGen](https://github.com/TechnicalTortoise/c2cGen/blob/main/c2cGen.ipynb) (MIT) | OpenCV k-means on raw pixels (`KMEANS_RANDOM_CENTERS`, 10 attempts); colors named by hand; C2C walk from bottom-right with `INC`/`DEC` and row totals | Random initialization makes color order change between runs (its README says so) |
| [ajwhitman/Crochet-Pattern-Generator](https://github.com/ajwhitman/Crochet-Pattern-Generator/blob/master/c2c_instruction_writer.py) | `np.diagonal(offset = i − H + 1)`; **W + H − 1** rows; reverses every other diagonal; run-length text such as `3A, 2B` | Minimal and correct core |
| [wolfcall/C2CImageConverter](https://github.com/wolfcall/C2CImageConverter/blob/master/Form1.cs) (MIT, C#) | Diagonal walk over a pixel-art bitmap; prompts to name each new color; Excel output | Its own comments flag logic errors when the image is not square |
| [GoestaHuppenbauer/corner2corner](https://github.com/GoestaHuppenbauer/corner2corner/blob/main/index.html) | Grid from a "block size" in source pixels; canvas smoothing set to "high"; grayscale or contrast 2.5× | **No quantization**: every cell keeps its own color |
| [jess1ex/pixel_art_crochet_pattern](https://github.com/jess1ex/pixel_art_crochet_pattern/blob/main/script.js) | Per-cell average; **"tolerance" leader clustering** (±tol per channel, first match wins); sc rows alternate RS/WS; C2C rows marked up/down with block counts and "start decreasing on both ends" | [I] Leader clustering depends on scan order |
| [tylervick/graphghan](https://github.com/tylervick/graphghan) (MIT, 2026) | **Chart format** ([spec](https://github.com/tylervick/graphghan/blob/main/docs/chart-format.md)): palette codes, run-length rows (`"1Y187G1Y"`), gauge, technique, passes, turn boundary, foundation, and cell kind (`stitch/block/tile/motif/pair`). **Validation**: rows sum to the width; foundation ≥ width + first_stitch_in − 1; one stitched span per row for shaped pieces. **Stats**: single-stitch runs, color changes per row, `yards_est`. Exports 1-px PNG, OXS, CSV and PDF; imports chart PDFs and pictures | Includes a Claude Code skill. Design rules include "No run shorter than 2 stitches" and "Lettering needs at least 11 rows per line" ([rules](https://github.com/tylervick/graphghan/blob/main/.claude/skills/graphghan/references/design-rules.md)) |
| [smach/crochet](https://github.com/smach/crochet) (MIT, R/Shiny, "a few thousand visits per month") | Overlay-mosaic designer: rows must be odd, 5–51; columns 5–50; places X marks and flags "**Danger**" when two X are vertically adjacent ([code](https://github.com/smach/crochet/blob/main/fct_create_matrix.R)) | Confirms the mosaic adjacency rule |
| [jqiao2/mosaic-crochet](https://github.com/jqiao2/mosaic-crochet/blob/main/src/algo.py) | Otsu binarization; cubic resize; **greedy per column, bottom-up**; sweeps thresholds {64…224} × first-row color and keeps the lowest MSE | An image-to-mosaic reference |
| Libraries | [RgbQuant.js](https://github.com/leeoniya/RgbQuant.js) (MIT; ships inside Stitch Fiddle). [image-q](https://github.com/ibezkrovnyi/image-quantization) (MIT, TypeScript): NeuQuant, RgbQuant, **WuQuant**; distances Euclidean through **CIEDE2000** and "CIE94Textiles"; dithering Floyd–Steinberg through **Riemersma**; SSIM | image-q is a good candidate dependency [I] |

---

## 4. Cross-cutting technical findings

### 4.1 Resampling (image → grid)

- **Browser `drawImage` scaling is the common default** [V]: Pixel-Stitch, TapestryCrochet, stitchfizzle, and hookline and corner2corner with `imageSmoothingQuality: "high"`. MDN documents only the levels "low", "medium" and "high". **The algorithm is browser-defined**, and the property applies only when `imageSmoothingEnabled` is true ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingQuality)). [I] The same image can therefore chart differently in Chrome and Safari, and big reductions alias.
- **Stitch Fiddle defaults to no smoothing** (`imageSmoothing: false`) [V]. [I] That keeps hard edges but samples one pixel per cell, so it is noisy on photos.
- **True box averaging per cell** (stitchy, jess1ex) [V] is the most faithful for photos. It does create in-between colors at edges. KnitPro's FAQ calls these "interpolated colors" and Stitchboard turned a two-color image into "three colors" [V].
- **Pixel art should not be resampled** [V]: Stitchmate imports "with no resampling". graphghan's advice for Stitch Fiddle is to upload a 1-px-per-stitch PNG with exactly N colors so "the import lands 1:1" ([note](https://github.com/tylervick/graphghan/blob/main/.claude/skills/graphghan/references/stitchfiddle.md)).

### 4.2 Color reduction and color distance

| Method seen | Where [V] | Note [I] |
|---|---|---|
| RgbQuant (histogram per subregion, then greedy merging) | Stitch Fiddle, Pixel-Stitch | Fast. Method 2 can drop small details that never reach the per-box count; its source has a FIXME saying so |
| MMCQ / median cut | Pixel-Stitch, stitchy (via Color Thief), stitchfizzle | Splits on RGB extent; the Color Thief variant **excludes near-white** |
| k-means | c2cGen (RGB, random init), TapestryCrochet (unique colors), hookline (k-means++ in Lab, seeded) | Best quality when **weighted by frequency, done in a perceptual space, and seeded** |
| Leader / tolerance | jess1ex | Depends on scan order |
| None | KnitPro, corner2corner | Unusable on photos |

Distances seen [V]:
- luma-weighted Euclidean (RgbQuant);
- "redmean" weighted Euclidean (Pixel-Stitch WED);
- fixed-weight RGB (2/4/3) plus a luma term, mislabelled "CIE76" (TapestryCrochet). Fact-check: TapestryCrochet was listed under "redmean", but its weights do not depend on mean red;
- CIE76, CIE94 and CIEDE2000 (Pixel-Stitch; Stitch Fiddle for merges and confetti);
- plain RGB Euclidean (stitchfizzle, jess1ex).

[I] Use **Oklab** for clustering. It was designed to predict lightness, chroma and hue better than CIELAB, which "predict[s] blue hues … badly" ([Ottosson](https://bottosson.github.io/posts/oklab/)) [V]. Use **CIEDE2000** for final yarn matching and merge thresholds, where it is the textile-industry norm.

### 4.3 Matching to real yarn

[V]
- **Stitch Fiddle** passes a yarn line's available solid colors into RgbQuant as a fixed palette, which keeps colors greedily by image frequency.
- **Pixel-Stitch** quantizes freely at 1.1× the requested count, then snaps each color to the nearest thread. Users can deselect threads or upload `#hex,name` palettes.
- **MakeBead** offers Red Heart Super Saver only. **Stitchmate** offers Red Heart Super Saver, Caron One Pound and Bernat Super Value.

[I] Failure modes:
- Snapping after quantization can merge two distinct image colors onto one yarn, leaving fewer colors than requested.
- Greedy-by-frequency selection drops small but salient colors.
- Hex values for yarns are approximations taken from photos. Show the ΔE of each match and warn when ΔE00 > 10.

### 4.4 Dithering

[V]
- Pixel-Stitch offers five kernels and defaults to **Atkinson**, which spreads only 6/8 of the error and so gives less speckle.
- Stitch Fiddle bundles RgbQuant's kernels (Floyd–Steinberg through SierraLite) but **calls it without a kernel**.
- ArtPatt promotes Floyd–Steinberg for C2C gradients; MakeBead has a toggle.

[I] In yarn, every dithered pixel is a color change. Dithering creates confetti: more bobbins in C2C, more carried-yarn show-through and ends in tapestry. Default dithering off. If offered, restrict it to smooth-gradient regions, use a difference threshold (RgbQuant's `dithDelta` idea) and serpentine scanning, and show its cost in color changes per row.

### 4.5 Cleanup: making a chart crochetable

- [V] Stitch Fiddle's ΔE00-aware confetti, rare-color and merge pipeline (§3.1) is the most principled shipped version.
- [V] graphghan treats **run length** and **color changes per row** as the real workload: "a 244-wide plaid row at 40 changes is fine, a braid row at 120 is not"; "No run shorter than 2 stitches in filled areas" (both from [design-rules.md](https://github.com/tylervick/graphghan/blob/main/.claude/skills/graphghan/references/design-rules.md); fact-check: they were cited to crochet.md); "Carry unused colors … for ≤ 3 colors per row; bobbins for more" ([crochet.md](https://github.com/tylervick/graphghan/blob/main/.claude/skills/graphghan/references/crochet.md)).
- [V] Stitch Fiddle presets carry `maxColorsPerRow` (2 for mosaic).
- [V] Tapestry fabric: "tight stitches produce a stiff fabric with hidden carried colors, while loose stitches show the carried colors" ([Wikipedia](https://en.wikipedia.org/wiki/Tapestry_crochet)). That is why the number of colors carried per row matters.

### 4.6 Background and transparency

- [V] Stitch Fiddle composites transparency onto a chosen background yarn, or white. It also offers ML background removal (IMG.LY, **AGPL-3.0**).
- [V] Pixel-Stitch does not support transparency.
- [V] Color Thief excludes near-white pixels.
- [V] graphghan supports "no stitch" cells for shaped pieces only if each row stays **one unbroken stitched span**: "A no-stitch cell between stitches … cannot be worked as written".

### 4.7 Stitch aspect ratio and sizing

Manufacturer label data from Yarnspirations product pages [V]. Aspect = cell height ÷ cell width = (stitches per 4") ÷ (rows per 4").

| Yarn (CYC weight) | sc × rows per 4" | Hook | Cell w × h (in) | h/w |
|---|---|---|---|---|
| [Red Heart Super Saver](https://www.yarnspirations.com/products/red-heart-super-saver-yarn) (#4) | 12 × 15 | 5.5 mm | 0.333 × 0.267 | 0.80 |
| [Red Heart Soft](https://www.yarnspirations.com/products/red-heart-soft-yarn) (#4) | 12 × 15 | 5.5 mm | 0.333 × 0.267 | 0.80 |
| [Caron Simply Soft](https://www.yarnspirations.com/products/caron-simply-soft-yarn) (#4) | 13 × 14 | 5 mm | 0.308 × 0.286 | 0.93 |
| [Caron One Pound](https://www.yarnspirations.com/products/caron-one-pound-yarn) (#4) | 12 × 13 | 5 mm | 0.333 × 0.308 | 0.92 |
| [Patons Canadiana](https://www.yarnspirations.com/products/patons-canadiana-yarn) (#4) | 14 × 17 | 5 mm | 0.286 × 0.235 | 0.82 |
| [Red Heart With Love](https://www.yarnspirations.com/products/red-heart-with-love-yarn) (#4) | 14 × 14 | 6.5 mm | 0.286 × 0.286 | 1.00 |
| [Bernat Softee Baby](https://www.yarnspirations.com/products/bernat-softee-baby-yarn) (#3) | 16 × 19 | 4 mm | 0.250 × 0.211 | 0.84 |
| [Bernat Blanket](https://www.yarnspirations.com/products/bernat-blanket-yarn) (#6) | 7 × 8 | 8 mm | 0.571 × 0.500 | 0.875 |

- Median **0.86**, mean 0.87, range 0.80–1.00 [I, arithmetic].
- graphghan's blocked worsted gauges with a 5 mm hook: sc 3.5 × 4.0 per inch (h/w 0.875); **hdc 3.25 × 2.5 (1.30)**; **dc 3.0 × 1.625 (1.85)** [V, a designer's figures, not a standard].
- Defaults elsewhere [V]: Stitch Fiddle's crochet grid is square; KnitPro's crochet cell is 1:1; hookline defaults to 0.75.
- Craft Yarn Council sc gauge ranges per 4" [V] ([CYC](https://www.craftyarncouncil.com/standards/yarn-weight-system)): Super Fine 21–32 (hook 2.25–3.5 mm); Fine 16–20 (3.5–4.5); Light 12–17 (4.5–5.5); Medium 11–14 (5.5–6.5); Bulky 8–11 (6.5–9); Super Bulky 7–9 (9–15); Jumbo ≤ 6 (≥ 15). Marked "GUIDELINES ONLY".
- C2C tiles [V]:
  - Blue Frog Creek: 5 mm hook, Red Heart yarn, ¾" × ¾" blocks.
  - Pixel Crochet: a 10×10 swatch measured 7.75", so 0.775" per tile; an 80×100 graph comes out 62" × 77.5".
  - The Crochet Crowd's sizing guide (5 mm, worsted): 30" ≈ 35 blocks, 42" ≈ 49, 60" ≈ 70, so about 0.86" per block (fact-check: added). Treat 0.75–0.86" as the plausible worsted range until a swatch is measured.
  - The Crochet Crowd also allows hdc C2C.
  - Tiles are close to square, so a square grid is acceptable for C2C.

### 4.8 Written-instruction formats in the wild

[V]
- **Stitch Fiddle** writes `Row 3: 2x red, blue (3 sts)`, marks "corner" in C2C, starts from any corner, and copies as plaintext or Markdown. Stardust Gold's complaint: "the colors are just written out without yarn descriptions or names."
- **Kim Latshaw / Crochet Crowd**: `B7` (color plus count) with up/down direction, plus color-coded and black-and-white word charts.
- **Tapestry conventions** (right-handed) ([Yarnspirations](https://www.yarnspirations.com/blogs/how-to/ultimate-beginners-guide-to-tapestry-crochet)):
  - "Odd rows are worked right-to-left and even rows are worked left-to-right."
  - Color change: "When you have 2 loops of Color A on your hook, do the last yarn over in Color B".
  - In rounds, every round is worked the same way, with no right-side/wrong-side switch.
- **Carrying** ([Carol Ventura](https://www.carolventura.com/rightstitches.html)): "Lay the additional yarn over the top two loops … crochet under and over it"; start carrying "at the beginning of a project, even if there will not be any color changes for a few rounds".
- **graphghan flat sc conventions**: chart row 1 is the bottom row; "chain W + 1"; first stitch "in the 2nd chain"; "Ch 1, turn"; the turning chain is not a stitch.

### 4.9 How tools estimate yarn

| Source | Rule | Implied amount [I] |
|---|---|---|
| graphghan ([export.py](https://github.com/tylervick/graphghan/blob/main/src/graphghan/export.py)) [V] | 1.1 yd per square inch of worsted sc, +20% (code comment: "+20% tails"; fact-check: was "for tails and carried strands", but carried strands are not mentioned); 364-yd skeins | 2.83" per sc at 0.286 × 0.25 |
| Blue Frog Creek (measured) [V] | 516" for 25 C2C dc tiles at ¾" → "almost 21" … per block"; "doesn't include yarn needed for traveling and weaving" | ≈ 1.04 yd/in² |
| stouto [V] | "1 to 1.5 yards" per C2C block (≈1 yd sport, 1.25 worsted, 1.5 bulky); buy 10–20% extra | 1.7–2.6× the measured value |
| ArtPatt [V] | "DC uses ~19cm … SC (12cm)", 6 dc per tile, +15% | 4.7" per sc; about 1.25 yd (45") per tile, ≈ 2.1× the measured value |
| Stitchsums ([calculator](https://www.stitchsums.com/calculators/tapestry-yarn-per-color)) [V] | Tapestry: "5 is a rough worsted-tapestry starting point" (yards per 100 sts), +15% buffer ("higher than plain crochet because carried strands use more"), 20% for sparse colors (unverified: not found in the page's server-rendered text) | 1.8" per stitch (looks low) |
| Pixel-Stitch [V] | stitches per skein by Aida count and ply, + "addition" (default 30%) | floss model |
| Bobble [V] | your swatch gauge plus a "10% allowance" | – |
| Stitch Fiddle [V] | no estimate | – |

Takeaway [I]: published constants spread 2–3× for the same stitch. Only a **swatch-calibrated** model is defensible. Several tools offer a calibration procedure: frog a counted swatch and measure the yarn ([Blue Frog Creek](https://www.bluefrogcreek.com/blogs/all-about-the-c2c-stitch/c2c-105-yarn-guide), [stouto](https://stouto.co.za/crochet-how-to-calculate-yarn-for-a-c2c-project), [Stitchsums](https://www.stitchsums.com/calculators/tapestry-yarn-per-color)).

### 4.10 Charts, PDFs and progress tracking

[V]
- Stitch Fiddle emphasizes grid lines every 5 and 10 cells (code defaults) and splits charts over pages.
- Pixel-Stitch highlights every Nth line (N = 2–20) and prints a page-order overview.
- graphghan's PDF is "laid out like a sold pattern (cover, key, tiled chart, written rows)".
- Trackers:
  - Stitch Fiddle: row, column or diagonal counter.
  - Ribblr: mark individual cells.
  - Knitting Chart: "Working Mode".
  - hookline: a cursor at the level of color runs.
  - graphghan: cursor `{row, run, stitch}` plus an iOS Live Activity.
  - CrochetPop: tracker with audio.

---

## 5. What crocheters praise and complain about

Reddit could not be reached (§0). All quotes below are [V] from the linked pages.

- **Paywalls, especially hidden ones**:
  - "you have to pay 2.99 to be able to actually make your own graphghans … There are TONS of free creators online" (Graphghan Pattern Creator, Google Play).
  - "can't undo something without paying" (StitchCraft listing).
  - "I would rather have ads than pay" and "Most things nowadays are locked behind a pay wall" ([Ribblr forum](https://meet.ribblr.com/t/free-app-for-making-tapestry-grids/587705)).
- **Stray colors and no cleanup**: Winstitch "adds extra colors that aren't even there!"; Stitchboard has "No way to change or clean up the image" and its result is "more of a starting place than a complete pattern".
- **Unclear controls**: Stitchboard's inverted sensitivity scale.
- **Shape problems**: Stitchboard lets you "can't control how many rows". [I] Square-cell defaults squash portraits; hookline's hint text says so explicitly.
- **Written rows**:
  - Wanted: Willow Crochet calls rows the remedy for "staring at a visual chart for 200 rows".
  - Gated behind payment.
  - Missing yarn names (Stardust Gold).
- **Bobbins and ends**: "Bobbins … can be your living nightmare if you have too many" (Crochet Crowd).
- **Tracking**: users improvise with highlighters. Apps praised for tracking: Knitting Chart's working mode ("SO worth the money"), Ribblr's cell marking.
- **AI apps**: non-delivery ("not one was converted") and costly weekly subscriptions.
- **Praise**: Stitch Fiddle's free version is "very useful" (Stardust Gold); Knitting Chart is "really easy to use" (Ribblr forum); KnitPro is valued for being free.

---

## 6. Recommendation for our 2D mode

### 6.1 Techniques to support, and why

| Priority | Technique | Why [I, building on the verified evidence above] |
|---|---|---|
| **P0** | **sc tapestry / graphgan**, worked flat or in the round, with a right- or left-handed option | Highest resolution per inch, so the most picture-like. Covers graphgans, tapestry bags and pillows. Needs the 0.80–1.00 aspect correction and carried-yarn yardage. Shares the per-stitch color grid with the 3D mode, so R8 color work is reused |
| **P0** | **C2C** (dc tile; hdc tile option) | The most popular blanket technique, with dedicated services and many tools. Near-square tiles. Written rows by diagonal are where users most need help. We can add bobbin and end counts that nobody offers |
| **P1** | **Overlay mosaic** (2 colors, alternating rows) | Popular: a dedicated Stitch Fiddle type; smach's app gets thousands of visits per month. No carrying and a strong graphic look. Needs a constraint solver (§6.4c), which is a differentiator |
| **P1** | **Intarsia / bobbin working mode** for the sc chart | Same chart, different instructions and yardage: bobbins per color region instead of carried strands. Better than carrying when a row has more than 3 colors (graphghan's threshold) |
| **P1** | **hdc graphgan** | About 62.5% of the rows for the same size (graphghan); taller cells (h/w ≈ 1.3). A cheap option once aspect is parameterized |
| **P2** | **Tunisian (tss) colorwork** | Stitch Fiddle supports it; same grid, different passes (forward plus return). Add after P0/P1 |
| **P2** | **Filet** (binary) | Trivial from a threshold; suits text and silhouettes; CrochetPop has it |
| Skip | Granny-pixel and motif grids, cross-stitch | Niche; out of scope |

### 6.2 Inputs and defaults

- **Image**: jpg, png, webp or gif; apply EXIF orientation. Crop (free or locked to the finished aspect), rotate, flip.
- **Technique**: as in §6.1, plus working direction (flat or round), handedness, start side (and start corner for C2C), and first row RS.
- **Yarn weight** (CYC 1–7): default hook and gauge come from §4.7. Default sc stitches per 4" is the CYC range midpoint, e.g. Medium 12.5. Default rows per 4" = sts per 4" ÷ **0.86**.
  - "I have a swatch" overrides with measured sts × rows per 4" (C2C: tiles per 4").
  - Optional calibration: yarn length used by 10 stitches (or 5 C2C tiles).
- **Finished size**: width and/or height in inches, with aspect lock; or stitch counts directly.
- **Colors**:
  - max colors (default 6 for tapestry, 8 for C2C);
  - palette mode: Auto / Brand line / **My stash** (yarns I own) / Custom CSV `#hex,name[,brand,code,yds_per_skein]`, the Pixel-Stitch format extended;
  - background handling: keep as a yarn, or "no stitch".
- **Detail ↔ Ease slider** mapping to the cleanup parameters:

| Preset | Confetti ΔE00 | Min run (tapestry) | Max colors per row | Rare-color minimum | Dither |
|---|---|---|---|---|---|
| Max detail | off | 1 | ∞ | 0 | optional |
| Balanced (default) | 0 (identical neighbour) | 2 | 3 | 10 cells | off |
| Easy | 10 | 3 | 2 | 0.5% of cells | off |

### 6.3 Processing pipeline (runs in a Web Worker; deterministic)

```ts
// ---------- 1. sizing (sc/hdc rows; C2C uses tiles) ----------
function gridSize(Win: number, Hin: number | null, imgAspect /* h/w after crop */: number,
                  g: { stPer4: number; rowsPer4: number }, lockAspect = true) {
  const spi = g.stPer4 / 4, rpi = g.rowsPer4 / 4;
  const r = spi / rpi;                                   // cell height / cell width (sc ≈ 0.86)
  const cols = Math.round(Win * spi);
  const rows = lockAspect ? Math.round(cols * imgAspect / r) : Math.round((Hin ?? 0) * rpi);
  return { cols, rows, finishedW: cols / spi, finishedH: rows / rpi, r };
}
// Example: 40" wide worsted (12.5 sc / 4", r = 0.86) → cols = 125; for a 3:4 portrait photo
// (A = 4/3) rows = round(125 · 1.333 / 0.86) = 194, i.e. 194 / 3.63 ≈ 53.4" tall.
// C2C: tiles = round(Win / tileIn), tileIn ≈ 0.77" worsted dc (swatch overrides).

// ---------- 2. sampling ----------
function sampleGrid(img, cols, rows): Float32Array /* Oklab per cell */ {
  if (isPixelArt(img)) return sampleBlockCentres(img, cols, rows);   // ≤64 colors + integer block size → no resampling
  // Box-average each cell's exact footprint in LINEAR sRGB (fractional edge weights), then convert to Oklab.
  // Do not rely on canvas drawImage (browser-defined filter).
  // Also store the per-cell majority color, used for graphics/logos (edge-preserving mode).
}

// ---------- 3. palette ----------
// a) Auto: weighted k-means++ in Oklab over cell colors, seed = hash(settings), ≤ 20 iterations,
//    k = maxColors. Then merge centroids within ΔE00 ≤ 5 and drop clusters < rareMin (Stitch Fiddle defaults).
//    Salience guard: a small compact cluster with ΔE00 > 20 to every other centroid is kept even if rare
//    (eyes, logos); it may replace the least important centroid.
// b) Brand / stash: choose a subset S of the allowed yarns (|S| ≤ k) minimising Σ_cells ΔE00(cell, S).
//    Greedy facility-location, then 1-swap (PAM) improvement.
//    Unlike frequency-greedy (Stitch Fiddle) or snap-after-quantize (Pixel-Stitch),
//    this optimises the total error directly and avoids two clusters collapsing onto one yarn.
//    Flag any centroid whose best yarn has ΔE00 > 10 ("no close yarn in this line").

// ---------- 4. assignment ----------
// nearest(S) by ΔE00 (cache with a 32×32×32 Oklab LUT). Optional dithering: serpentine
// Floyd–Steinberg or Atkinson in Oklab, only where the gradient mask is on,
// skipping error < δ (ΔE00 3).

// ---------- 5. cleanup (repeat until nothing changes, max 5 passes; locked cells are skipped) ----------
// 5a confetti (Stitch Fiddle rule): cell is isolated if none of its 8 neighbours has ΔE00 ≤ τ to it
//    → replace with the most frequent neighbour color; tie → smallest ΔE00 to the original.
// 5b min run (rows techniques): a horizontal run shorter than m takes the color of the adjacent run
//    with the smaller ΔE00 (tie → the longer run). Vertical 1-cell spikes are handled by 5a.
// 5c max colors per row (tapestry carry): while a row has > cMax colors, recolor its least-used
//    color to the nearest allowed color in that row.
// 5d regions (C2C / intarsia): 4-connected components smaller than aMin cells merge into the
//    neighbour with the longest shared border.
// 5e drop palette entries that are now unused.

// ---------- 6. technique back-end (§6.4) ----------
// ---------- 7. metrics, shown live ----------
// per-color stitch counts and %; color changes per row (mean / max / busiest row); single-stitch runs;
// regions = bobbins per color (C2C/intarsia); ends to weave in; time estimate (graphghan heuristic:
// ~1,100 sc/h + 3 s per color change, labelled "rough"); yardage per color (§6.5); validation status.
```

**R8 (stripes, spots and motifs carried into the chart)** [I]:
- **Thin-feature protection**: a 1-pixel-wide high-contrast line in the source maps to at least one stitch. Do this with a max-contrast vote inside each cell when a line detector fires.
- **Pattern regularisation**: detect periodic stripes or checks by autocorrelation along rows and columns. Snap the period and band widths to whole stitches or rows so stripes stay even.
- **Repeat-aware text**: `Rows 5–8: rep Rows 1–4`, and `*3 A, 2 B; rep from * 10 times` inside a row. Stitch Fiddle offers repeats only for knitting (unverified, and probably wrong: its help page says "Horizontal repeats and vertical (row) repeats are both supported" with no knitting-only limit. The bundle's `repeatsAutoDetectedEnabled` defaults to false).

### 6.4 Technique back-ends

**(a) sc tapestry or intarsia, worked in rows or rounds**

```ts
// Grid row 0 = top as displayed. Worked row k (1-based) uses grid row rows-k (bottom-up).
// Right-handed flat: RS rows (odd) read right→left, WS rows (even) left→right (Yarnspirations).
// Left-handed: mirror. In the round: every round RS, read right→left (RH) / left→right (LH).
function writeRow(k, runs /* RLE in working order */, opts) {
  // Row 1: "With A, ch {W+1}. Row 1 (RS) ←: sc in 2nd ch from hook and across …"
  // Rows ≥ 2: "Ch 1, turn." (turning chain is not a stitch: graphghan stitch config for sc)
  // Body: "A 12, B 3 (change to B in last yo of prev st), A 45 — 60 sts"
  // Tapestry cue: "carry B (and C) throughout"; intarsia cue: "join B bobbin"
  // Compress repeats: detect the smallest period p such that runs[i] === runs[i+p] …
}
// Validate: Σ runs = W on every row; foundation = W + 1; every code is in the palette.
```

**(b) C2C by diagonals.** All four start corners; rectangles get a correct steady phase.

```ts
// W×H tiles, coordinates (u, v) measured from the start corner. Diagonal row k = 1 … W+H-1 holds cells with u+v = k-1.
// len(k) = min(k, W, H, W + H - k)        // Σ len = W·H
// Change versus row k-1, at each end of the diagonal:
//   end A (runs up the start-side vertical edge, then along the far horizontal edge): inc if k ≤ H, else dec
//   end B (runs along the start-side horizontal edge, then up the far vertical edge):  inc if k ≤ W, else dec
// Phases: k ≤ min(W,H) both inc · min < k ≤ max steady (one inc, one dec) · k > max both dec.
// Row counts: min(W,H) / |W−H| / min(W,H)−1.
// "Corner" markers (as in Stitch Fiddle) at k = H+1 (end A switches) and k = W+1 (end B).
// Each row is worked from the end reached last; reading direction alternates (up/down).
for (k = 1; k <= W + H - 1; k++) {
  cells = diagonalCells(k).inWorkingOrder(k % 2 ? "up" : "down");
  emit(`Row ${k} (${dirArrow}) [${phaseText(k)}]: ` + rle(cells).map(r => `${r.n} ${r.code}`).join(", ") + ` — ${len(k)} tiles`);
}
// Stitch-level wording follows standard C2C: new tile at a row start = "ch 6, 3 dc in 4th ch from hook";
// a decrease at a row start = slip-stitch across to the next ch-3 space; a decrease at a row end = stop
// before the last space. [I: confirm wording against a reference tutorial before shipping]
// Bobbins: 4-connected regions per color; ends ≈ 2 × regions.
```

**(c) Overlay mosaic: an optimal per-column DP** [I]. The constraint itself is [V]: smach flags vertically adjacent X marks as "Danger", and Stitch Fiddle enforces the same rule greedily.

```ts
// Row colors alternate: rowColor(r) = P[(r + phase) % 2], r counted from the bottom.
// A drop-dc ("X") in row r+1 covers cell (r, c) with rowColor(r+1); X marks in the same column
// may not be in adjacent rows → the set of corrected cells in a column may not contain neighbours.
for each phase in {0, 1}, for each threshold t in thresholdSweep (Otsu ± 64, as jqiao2):
  target = binarize(gridOklabL, t)
  for each interior column c:                    // edge columns are always rowColor (edge stitches)
    w[r] = target[r][c] !== rowColor(r) ? weight(r, c) : 0    // weight = ΔE · salience
    best[r] = max(best[r-1], best[r-2] + w[r])   // maximum-weight independent set on a path, O(rows)
    backtrack → X[r+1][c] = true for chosen r    // r+1 must exist: add 2 finishing rows (Stitch Fiddle adds 1 start + 2 end rows)
  score = Σ uncorrected weights; keep the best (phase, t)
// Written rows: "Row k (color A, RS, fasten off): ch 1, sc in first st, [sc blo …, dc flo 2 rows below …], sc in last st"
// (one direction, cut yarn each row → graphghan's 'rejoin' boundary).
```

### 6.5 Yardage and materials model (per color) [I]

```ts
const w = 1 / spi, h = 1 / rpi;                    // stitch cell, inches
L_sc   = α_sc * Math.sqrt(w * h);                  // α_sc ≈ 10.6 (graphghan 1.1 yd/in² at 0.286×0.25)
L_hdc  = α_hdc * Math.sqrt(w * h);                 // no source; derive from swatch
L_tile = α_tile * tileIn;                          // α_tile ≈ 28 (Blue Frog Creek: 21" / 0.75")
// If the user measured k stitches using Lmeas inches: α = (Lmeas / k) / sqrt(w·h). This overrides the defaults.

worked[c] = count[c] * L_stitch;
carried[c] = tapestry ? Σ_rows carriedCells(row, c) * w * (1 + κ) : 0;   // κ = 0.08 slack
  // carriedCells = cells in the carry span NOT worked in c. Carry span = whole row
  // ("carry … throughout the entire project", Yarnspirations) or first→last use of c in the row (option).
tails[c] = starts[c] * 2 * 6;                       // inches; starts = 1 + joins (tapestry) or regions (C2C/intarsia)
yards[c] = (worked + carried + tails) / 36 * (1 + buffer);   // buffer 0.10 (Bobble) – 0.15 (ArtPatt, Stitchsums)
skeins[c] = Math.ceil(yards[c] / yarn.ydsPerSkein);
```

- Sanity check with defaults: a worsted sc cell 0.320" × 0.275" gives L ≈ 3.15" per sc. A 125 × 182 blanket (22,750 sc) then needs ≈ 1,990 yd before carry and buffer. graphghan's area rule gives about 2,200 yd for 40" × 50" (2,000 in² × 1.1).
- Always show a range of ±25% until the user calibrates. State the assumptions on the materials page.

### 6.6 Outputs, exports and tracker

1. **Chart view**:
   - true-aspect cells, with a toggle to square;
   - row numbers on the side where each row starts; column numbers;
   - bold lines every 5 and 10;
   - per-color symbols for black-and-white printing;
   - a "fabric preview" with a stitch texture;
   - photo, chart and fabric shown side by side.
2. **Legend and materials**: code, swatch, yarn brand, line, color name and number, stitch count, %, regions or bobbins, yards, skeins; hook; gauge; finished size.
3. **Written pattern**: per §6.4, including the color-change cue, carry or bobbin cues, and repeat compression. Export as plaintext or Markdown, like Stitch Fiddle.
4. **PDF**, free and with no watermark:
   - cover and preview; materials and gauge; legend;
   - **tiled chart with a 2-row/column overlap and a page map** (Pixel-Stitch-style overview);
   - written rows with a checkbox per row.
5. **Interop**:
   - a 1-px-per-stitch PNG, so Stitch Fiddle imports it 1:1;
   - CSV;
   - JSON in a graphghan-like format (palette codes, run-length rows, gauge, technique, and a content hash);
   - OXS.
   - Import 1-px PNG and CSV back in.
6. **Progress tracker**:
   - row, run and stitch cursor (hookline, graphghan); highlight the current row and dim done rows (Stitch Fiddle); large tap targets;
   - keep the screen awake; works offline;
   - optional speech of the next run, as CrochetPop does;
   - state saved in IndexedDB per project.
7. **Editor**: paint, fill, replace color, merge colors, **lock region** (protected from cleanup), text tool with a lettering minimum of 11 rows (graphghan), undo/redo, and recolor-to-my-yarn (Ribblr idea).

### 6.7 Edge cases and failure modes (checklist)

| # | Case | Handling [I]; evidence [V] in parentheses |
|---|---|---|
| 1 | Indexed or palette PNG, 16-bit, CMYK JPEG | Decode via `createImageBitmap` into RGBA, then normalize (KnitPro's all-black-grid bug) |
| 2 | EXIF-rotated phone photo | Respect the orientation tag; show a rotate button (Stitch Fiddle has one) |
| 3 | Transparency | Background policy: keep it as a yarn (Stitch Fiddle default: background yarn or white), or "no stitch" with the one-span-per-row check (graphghan) |
| 4 | White background lost | Never exclude near-white from clustering (Color Thief and Pixel-Stitch MMCQ skip it; stitchy works around it) |
| 5 | JPEG noise or many unique colors | Weight clustering by cell counts, not unique colors (TapestryCrochet defect) |
| 6 | Anti-aliased logos and clip-art | Majority sampling plus merges at ΔE00 ≤ 5 (Winstitch and Stitchboard extra colors) |
| 7 | Small salient features (eyes, text) | Salience guard, lock mask, thin-feature protection |
| 8 | Over-dithering | Off by default; gradient mask; show the cost in changes per row |
| 9 | Too many colors per row (tapestry) | Cap at 3, or switch the row to intarsia (graphghan rule; show-through per Wikipedia) |
| 10 | Rectangular C2C | Steady phase handled (stitchfizzle mislabels it) |
| 11 | Row direction and handedness | Boustrophedon for flat work; mirror for left-handers (stitchfizzle defect; Crochet Crowd left-hand advice) |
| 12 | Mosaic parity, edges and adjacency | Per-column DP; edge stitches; start and finishing rows (smach odd rows; Stitch Fiddle transform) |
| 13 | Non-determinism | Seeded RNG; output hash for regression tests (c2cGen and TapestryCrochet use random initialization) |
| 14 | Browser resampling differences | Own box filter in the worker (MDN: algorithm unspecified) |
| 15 | Big grids (1,000×1,000) | Worker plus OffscreenCanvas; tiled rendering; virtualized tracker (Knitting Chart performance complaints) |
| 16 | Gauge mismatch | Show the finished size from the user's swatch; "your size will vary" note; swatch wizard |
| 17 | Lettering legibility | Warn below 11 rows per text line; render text at 8× and box-filter it to the cell aspect (graphghan rule) |
| 18 | Yarn hex inaccuracy | Show ΔE00 per match; let users photograph or adjust swatch hexes |

### 6.8 Acceptance tests

- **Structure**: every row's runs sum to W; foundation = W + 1 (sc). C2C: rows = W + H − 1, Σ len = W·H, phase counts min / |W−H| / min−1. Mosaic: no vertically adjacent X; edge cells equal the row color.
- **Determinism**: same image and settings give a byte-identical chart hash.
- **Round-trip**: 1-px PNG export → import gives an identical grid. A 2-color logo yields exactly 2 colors after cleanup.
- **Aspect**: a circle photo at r = 0.86 produces a chart whose physical width and height differ by < 3%.
- **Yardage**: within ±15% of three hand-measured swatches (sc tapestry, C2C, mosaic) once calibrated.
- **Performance budget**: re-quantize plus cleanup for 200×200 in < 300 ms in the worker; 1,000×1,000 in < 5 s.

### 6.9 How the recommended feature set compares

| Capability | Stitch Fiddle | Pixel-Stitch | 2025–26 web tools | **Ours** |
|---|---|---|---|---|
| Physical sizing (inches + yarn weight) | via swatch fields | Aida count only | some (gauge input) | **CYC defaults + swatch override + calibration** |
| True sc aspect | manual; square by default | n/a | hookline-style few | **default 0.86 from label data; per-technique** |
| Perceptual color pipeline | ΔE00 merges; RGB quantization | selectable metrics | ? | **Oklab k-means + ΔE00 matching + salience guard** |
| Brand / stash palettes | 827 lines; greedy | DMC/Anchor/Sulky; CSV | 1–3 US lines | **brand + "my stash" + CSV; optimal subset** |
| Cleanup | confetti, rare, merge | rare threshold | confetti | **+ min run, max colors per row, regions; locks; live metrics** |
| Techniques | many (no yardage) | cross-stitch | C2C / sc / tapestry | **sc flat and round, C2C, mosaic (P1), intarsia, hdc** |
| Written rows | paid; no yarn names | none | basic | **free; yarn names; repeats; RS/WS; handedness; C2C phases** |
| Yardage per color | none | floss formula | constants | **calibrated: worked + carried + tails + buffer; skeins** |
| PDF and tracker | yes (split; row/col/diag) | PDF | partial | **free tiled PDF + run-level tracker, offline** |
| Privacy / cost | account; Premium | local; free | mixed | **local-only, free, no LLM** |

---

## 7. Sources

**Stitch Fiddle**
- [Import picture](https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture)
- [Pixel crochet / C2C](https://www.stitchfiddle.com/en/help/1pei-97d7bo/pixel-crochet-c2c)
- [Written instructions](https://www.stitchfiddle.com/en/help/1pen-80n7rh/written-instructions)
- [Progress tracker](https://www.stitchfiddle.com/en/help/1pdx-98nqe4/progress-tracker)
- [Download & print](https://www.stitchfiddle.com/en/help/1pe3-3svb1t/download-print)
- [Order supplies](https://www.stitchfiddle.com/en/help/1pek-c4t7aj/order-supplies)
- [App](https://www.stitchfiddle.com/en/help/1pe6-4yrdj8/app-android-and-ios)
- [Create crochet chart](https://www.stitchfiddle.com/en/chart/create/crochet)
- [Yarn products](https://www.stitchfiddle.com/en/products/knitting-crochet)
- [JS bundle](https://www.stitchfiddle.com/rsrc/1765940698/js/en-main-4b1191b3eb71d8a8d3ec.js)
- [Pricing](https://www.stitchfiddle.com/en/premium/pricing)
- [Willow Crochet review](https://www.willowcrochet.com/stitch-fiddle-features-for-crochet-colorwork/)

**Pixel-Stitch**
- [Home](https://www.pixel-stitch.net/)
- [Instructions](https://www.pixel-stitch.net/sites/instruction.html)
- [FAQ](https://www.pixel-stitch.net/sites/faq.html)
- [UI bundle](https://www.pixel-stitch.net/js/pixel-stitch.min.js)
- [Worker](https://www.pixel-stitch.net/js/worker.min.js)
- [Strings](https://www.pixel-stitch.net/js/language.js)

**KnitPro, Pic2Pat**
- [KnitPro](https://www.microrevolt.org/knitPro.htm)
- [KnitPro app](http://www.microrevolt.org/knitPro/)
- [KnitPro FAQ](http://www.microrevolt.org/FAQ.htm)
- [Pic2Pat](https://www.pic2pat.com/index.en.html)

**C2C / graphgan tools and guides**
- [Crochet Crowd C2C graph maker](https://thecrochetcrowd.com/corner-corner-c2c-graph-maker/)
- [Crochet Crowd tutorial](https://thecrochetcrowd.com/corner-corner-graphghans-beginners-tutorial/)
- [Stardust Gold Crochet review](https://stardustgoldcrochet.com/5-best-graphing-programs-for-c2c-corner-to-corner-and-graphgans/)
- [Illuminate Crochet (Stitchboard)](http://illuminatecrochet.blogspot.com/2014/01/stitchboard.html)
- [ArtPatt](https://artpatt.com/c2c-crochet-pattern-generator)
- [Stitchmate](https://stitchmate.app/photo-to-crochet-pattern)
- [MakeBead](https://makebead.com/crochet-pattern-maker)
- [CrochetPop](https://learn.crochetpop.app/)
- [CrochetPop chart maker](https://learn.crochetpop.app/chart-maker)
- [Bobble](https://bobbledesigns.com/)
- [CrochetPatternGen](https://crochetpatterngen.com/stitch-fiddle-alternative/)
- [Blue Frog Creek C2C yarn](https://www.bluefrogcreek.com/blogs/all-about-the-c2c-stitch/c2c-105-yarn-guide)
- [Pixel Crochet C2C swatch](https://pixelcrochet.com/crochet-a-c2c-gauge-swatch-and-calculate-finished-dimensions/)
- [stouto C2C yarn](https://stouto.co.za/crochet-how-to-calculate-yarn-for-a-c2c-project)
- [Stitchsums tapestry yarn](https://www.stitchsums.com/calculators/tapestry-yarn-per-color)

**Apps and platforms**
- [Graphghan Pattern Creator (Google Play)](https://play.google.com/store/apps/details?id=com.crochetdesigns.graphghan&hl=en_US)
- [Graphghan Pattern Creator (iOS)](https://apps.apple.com/us/app/graphghan-pattern-creator/id6448245144)
- [Knitting Chart](https://apps.apple.com/us/app/knitting-chart/id1251317736)
- [Crochet Chart](https://apps.apple.com/us/app/crochet-chart/id1473051046)
- ["Stitch Fiddle Pattern Maker" (StitchCraft)](https://apps.apple.com/us/app/stitch-fiddle-pattern-maker/id6759521479)
- [Patternize](https://apps.apple.com/us/app/patternize/id6758268844)
- [Crochetly](https://apps.apple.com/us/app/crochetly/id6755979463)
- [Yarniby](https://apps.apple.com/us/app/-/id6755068624)
- [Ribblr charts help](https://ribblr.com/help/ribbuild-interactive-charts-can-i-add-charts-to-my-patterns-how-can-i-add-an-interactive-chart/)
- [Ribblr guidelines](https://ribblr.com/epattern?wiki=1)
- [Ribblr forum thread](https://meet.ribblr.com/t/free-app-for-making-tapestry-grids/587705)

**Standards, technique and research**
- [Craft Yarn Council yarn weight system](https://www.craftyarncouncil.com/standards/yarn-weight-system)
- Yarnspirations label pages for [Red Heart Super Saver](https://www.yarnspirations.com/products/red-heart-super-saver-yarn) and the other yarns in §4.7
- [Yarnspirations tapestry guide](https://www.yarnspirations.com/blogs/how-to/ultimate-beginners-guide-to-tapestry-crochet)
- [Carol Ventura](https://www.carolventura.com/rightstitches.html)
- [Catherine Crochets](https://catherinecrochets.com/whats-the-best-stitch-for-tapestry-crochet/)
- [Wikipedia: Tapestry crochet](https://en.wikipedia.org/wiki/Tapestry_crochet)
- [Wikipedia: Mosaic crochet](https://en.wikipedia.org/wiki/Mosaic_crochet)
- [Seitz et al., Onward! '22](https://dl.acm.org/doi/10.1145/3563835.3567657)
- [CrochetBench](https://arxiv.org/abs/2511.09483)
- [MDN imageSmoothingQuality](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingQuality)
- [Oklab](https://bottosson.github.io/posts/oklab/)

**Code**
- [stitchy](https://github.com/jamestomasino/stitchy)
- [hookline](https://github.com/bilalchaudhry03-commits/hookline)
- [TapestryCrochet](https://github.com/bishal0922/TapestryCrochet)
- [stitchfizzle](https://github.com/infomanc3r/stitchfizzle)
- [c2cGen](https://github.com/TechnicalTortoise/c2cGen)
- [ajwhitman C2C](https://github.com/ajwhitman/Crochet-Pattern-Generator)
- [C2CImageConverter](https://github.com/wolfcall/C2CImageConverter)
- [corner2corner](https://github.com/GoestaHuppenbauer/corner2corner)
- [pixel_art_crochet_pattern](https://github.com/jess1ex/pixel_art_crochet_pattern)
- [graphghan](https://github.com/tylervick/graphghan)
- [smach/crochet](https://github.com/smach/crochet)
- [jqiao2/mosaic-crochet](https://github.com/jqiao2/mosaic-crochet)
- [CrochetCharts](https://github.com/StitchworksSoftware/CrochetCharts)
- [RgbQuant.js](https://github.com/leeoniya/RgbQuant.js)
- [image-q](https://github.com/ibezkrovnyi/image-quantization)
- [IMG.LY background removal](https://github.com/imgly/background-removal-js)

---

## Verification notes

*Adversarial fact-check, 2026-09-30. The web-search quota was used up, so checks were made by fetching primary pages and code directly (curl, WebFetch, GitHub API, npm registry). Where possible a source other than the one the report cites was used.*

### What was checked, and the result

| # | Claim | Result | How it was checked |
|---|---|---|---|
| 1 | Stitch Fiddle quantizes with RgbQuant, `method:2, colorDist:"euclidean"`, brand palette filtered to `available==="yes" && solid`, no dithering kernel | **Confirmed** | Downloaded the live bundle `en-main-4b1191b3eb71d8a8d3ec.js` and read the call site. One nuance added: the product subset applies only when 2 or more products are picked. RgbQuant source: euclidean = Rec. 709 luma weights; method 2 = 64×64 boxes with `boxPxls` 2 scaled by area; `reducePal` keeps the first `colors` palette hits in the frequency-sorted histogram; a predefined palette ≤ `colors` is used as-is (`buildPal` returns early). |
| 2 | Cleanup: confetti (8 neighbours, ΔE00), min occurrence 10, merge ΔE00 ≤ 5, default 25 colors; IMG.LY 1.7.0, AGPL-3.0 | **Confirmed** | Bundle defaults `{colorCount:25, confetti:0, minColorOccurrence:10, minColorDistance:50}`, `_` post-process, `deltaE2000` helpers, 8-neighbour table `G4`. The CDN path `cdn.stitchfiddle.com/1/js/imgly/1.7.0/` returns HTTP 200. npm shows `@imgly/background-removal` 1.7.0 (2025-07-18). The GitHub API reports the license as AGPL-3.0. |
| 3 | Import limits 300×300 / 50 colors free, 1,000×1,000 / 200 colors Premium; crochet boxes square; "no easy formula" | **Confirmed** | Help pages fetched; all quotes match. Default knit gauge 18/24 confirmed. |
| 4 | Written instructions: C2C from all four corners, "corner" marker, plaintext/Markdown, `Row 3: 2x red, blue (3 sts)` | **Confirmed** | Help page fetched. **Side finding:** the same page says "Horizontal repeats and vertical (row) repeats are both supported", which undercuts §6.3's "repeats only for knitting". That claim is now marked unverified. |
| 5 | Pixel-Stitch: MMCQ (skips alpha < 125 and RGB > 250), RgbQuant method 1, five distances, five kernels with Atkinson selected, 1.1× for brands, rare-color merge, skein formula, 30% default | **Confirmed** | Read `worker.min.js` (`createPaletteWithMMCQ`, `getNearestColorInPalette`, `dithering`, `ersetzeFarben`) and `pixel-stitch.min.js` (`parseInt(1.1*b)`, `calculateThreadUsage = parseInt(a/(b/c)*(1+f/100))+1`, Aida select 1400…6600 with 3800 selected, addition 30% selected, width 2–600, colors 2–120). The quoted help text is corrected to the source spelling ("contected"). |
| 6 | KnitPro: no color reduction; 48×64 / 96×120 / 120×160; crochet 1:1; indexed → all black or white | **Confirmed** | FAQ and app page fetched. The form posts to `index.php`, and the knitPro 2.0 source zip (PHP 4 + GD) was downloaded. **`file.pdf` could not be confirmed** and is marked unverified. |
| 7 | Label sc gauges and h/w 0.80–1.00, median 0.86 | **Confirmed** | Pulled the "Crochet Gauge" field from all 8 Yarnspirations pages: RHSS 12×15 @5.5; RH Soft 12×15 @5.5; Caron Simply Soft 13×14 @5; Caron One Pound 12×13 @5; Patons Canadiana 14×17 @5; RH With Love 14×14 @6.5; Bernat Softee Baby 16×19 @4 (#3 DK); Bernat Blanket 7×8 @8 (#6). Recomputed h/w: 0.800, 0.800, 0.929, 0.923, 0.824, 1.000, 0.842, 0.875. Sorted median = (0.842 + 0.875)/2 = 0.858 ≈ 0.86; mean = 0.874 ≈ 0.87. Cell sizes in the table all recompute correctly (4 ÷ count). |
| 8 | CYC sc gauge per 4" and hook ranges; "GUIDELINES ONLY" | **Confirmed** | CYC page fetched. (Lace is 32–42 **dc**, 1.4–2.25 mm, and is omitted from the report, which is fine.) |
| 9 | C2C tile ≈ 0.75–0.775" (5 mm, worsted); 516" / 25 tiles ≈ 21" per tile, excluding travel and weaving | **Confirmed**, with a range caveat | Blue Frog Creek and Pixel Crochet fetched. 516/25 = 20.64". **However**, The Crochet Crowd's own sizing (30" ≈ 35 blocks, 60" ≈ 70) implies about 0.86" per block, so the tile-size range was widened in §1, §3.5 and §4.7. |
| 10 | stouto 1–1.5 yd per block; ArtPatt 19 cm/dc, 12 cm/sc, 6 dc per tile, +15%; graphghan 1.1 yd/in² +20% | **Confirmed**, with one wording fix | Pages and `export.py` fetched. 36–54" ÷ 21" = 1.71–2.57× ✓ (stouto). ArtPatt 6 × 19 cm = 114 cm = 44.9" ≈ 2.1× ✓. graphghan's +20% comment says only "tails"; the "carried strands" wording was removed. Note: graphghan's 1.1 yd/in² is close to the measured C2C area rate (≈1.02–1.04 yd/in²), so the 1.7–2.6× spread applies to the per-block rules of thumb, **not** to graphghan. |
| 11 | Mosaic: smach flags "Danger" for vertically adjacent X; Stitch Fiddle enforces greedily, adds edge stitches and start/finish rows | **Confirmed**, with detail | `fct_create_matrix.R`: `Conflict` when an X has an X directly above or below → class "Danger"; rows are forced odd, 5–51; columns 5–50 (`app.R`); README says "a few thousand visits per month"; MIT. The Stitch Fiddle transform `W` was read. Its row-adding details were corrected, and which end is "start" is marked unverified. |
| 12 | Tapestry: odd rows right-to-left, even left-to-right (RH); last yarn over in the new color; carry throughout | **Confirmed** | Yarnspirations guide quotes match verbatim. Note that it also says "Some patterns say otherwise". Carol Ventura quotes are confirmed via WebFetch. |
| 13 | CrochetBench "sharply decreases … executable correctness" | **Confirmed** | arXiv abstract (Li, Huang, Hua, Chawla; 12 Nov 2025). The executive summary's "collapse" was softened to the paper's own wording. |
| 14 | Graphghan Pattern Creator 1.3★ from 309 reviews; hidden $2.99; "preloaded" | **Corrected** | The Google Play page shows "1.3 star · **339** reviews" in the header; 309 is the phone-filtered count in the ratings panel. The $2.99 is disclosed in the description ("To activate creation is $2.99"), so "hidden" is the reviewers' view, not a fact. Both review quotes are confirmed. "Over 400 stamps, inserts and borders" is confirmed in the description; the "What's new" text says "Over 100". |
| 15 | stitchfizzle labels every diagonal after min(W,H) as Dec; no alternate-row reversal; W+H−1 rows, len = min(k,W,H,W+H−k) | **Confirmed** | Read `writtenInstructions.ts`. First loop: `phase = diagonalNum <= min(H,W) ? 'Inc' : 'Dec'`; second loop is hard-coded `(Dec)`; every diagonal walks `r++, c++`; `generateRowInstructions` never reverses. ajwhitman: `c2cRows = width+height-1`, `np.diagonal(im, i-height+1)`, `flip` alternates. Hand check W=3, H=2: lengths 1,2,2,1 (sum 6 = W·H), phases inc 2 / steady 1 / dec 1 = min / \|W−H\| / min−1 ✓. W=H=5: 5/0/4, 9 rows ✓. |

### Formulas worked by hand

- `gridSize` example: 12.5 sc/4" → spi 3.125 → cols = 125; rows/4" = 12.5/0.86 = 14.53 → rpi 3.634; rows = round(125 × 1.3333 / 0.86) = round(193.8) = 194; 194/3.634 = 53.4" ✓ (40 × 4/3 = 53.3").
- Physical-aspect derivation: height = rows·h = rows·r·w, which should equal cols·w·A, so rows = cols·A/r ✓. `r = spi/rpi` = h/w ✓.
- §6.5: α_sc = 1.1 yd/in² × (0.2857 × 0.25 in²) × 36 = 2.83" per sc; ÷ √0.0714 = 10.6 ✓. α_tile = 21/0.75 = 28 ✓. Sanity check: √(0.32 × 0.275) × 10.6 = 3.14" per sc; 125 × 182 = 22,750 sc × 3.15"/36 ≈ 1,990 yd ✓; 40" × 50" × 1.1 = 2,200 yd ✓. 50" × 3.634 = 181.7 → 182 rows ✓.
- hdc rows: 2.5/4.0 = 62.5% ✓; h/w hdc 3.25/2.5 = 1.30 ✓; dc 3.0/1.625 = 1.846 ✓.
- Blue Frog Creek area rate: 20.64" / 36 / 0.5625 in² = 1.02 yd/in² (1.04 if the rounded 21" is used) ✓. Its own example: 500 blocks × 21" / 36 = 292 yd ✓.
- ArtPatt's own example: 4,800 tiles × 6 dc × 19 cm = 5,472 m; ÷ 200 m = 27.4 → 28 skeins ✓.
- Atkinson spreads 6 × 1/8 = 6/8 of the error ✓ (kernel read in the Pixel-Stitch worker).

### Other product facts re-checked (all confirmed unless noted)

- Stitch Fiddle: 827 knitting/crochet yarn lines; Caron One Pound 43 colors; Cascade 220 170 colors; grid emphasis every 5 and 10; `rightToLeftAlternating`, `ignoreStitchesLeft/Right: 1`, `maxColorsPerRow: 2` in the mosaic preset; background composite on the background-yarn color or `#fff`; `imageSmoothing` default false; brightness and contrast formulas. Pricing ($2.75/mo, $33/yr, 250 colors) is still **[S]**: it is not in the server-rendered pricing HTML or the bundle.
- App Store: Knitting Chart 4.3★ (1,289 ≈ 1.3K), $19.99, 500×500, C2C and left-handed layouts, "SO worth the money"; Crochet Chart 3.7★ (75), $8.99; StitchCraft 3.7★ (33), 477 DMC, 80 wide / 20 colors free, $39.99/yr, $59.99 lifetime, "can't undo something without paying" ✓; Patternize $4.99/wk, $5.99/mo, $29.99/yr, $79.99 lifetime ✓ (the quote was reworded); Crochetly 3.5★ (6) and its review ✓; Yarniby 4.7★ (44) (the quote was corrected).
- Pic2Pat 18 MB, Aida 11/14/16/18, skeins ✓. Pixel-Stitch FAQ on transparency ✓. Ribblr 23,000 cells (150×150 or 300×75) ✓; Ribblr forum quotes and the Knitting Chart free tier of 50×50 ✓. MakeBead widths 60/120/180/240, 5–20 colors, Floyd–Steinberg toggle ✓. Stitchmate "no resampling" and "folds them into their neighbors" ✓. CrochetPop "never written by a language model", "machine-validated", Live Row Tracker with audio ✓. Bobble 10% allowance, £3.99/mo, swatch tension input ✓. Stitchsums "5 is a rough…" and 15% ✓; "20% for sparse colors" **unverified**. Stardust Gold and Illuminate Crochet quotes ✓. Oklab "blue hues are predicted badly" ✓. MDN low/medium/high and `imageSmoothingEnabled` ✓. Wikipedia tapestry quote ✓. Willow Crochet "200 rows" ✓.
- Repos: stitchy GPL-3.0, 23★ ✓; c2cGen MIT, `cv2.kmeans(..., 10, KMEANS_RANDOM_CENTERS)` ✓; C2CImageConverter MIT ✓; graphghan MIT (created 2026-09-10) ✓; smach MIT ✓; CrochetCharts GPL-3.0, last push 2017 ✓; RgbQuant MIT ✓; image-q MIT (npm), WuQuant / NeuQuant / RgbQuant, CIEDE2000 / CIE94Textiles, Riemersma, SSIM ✓. hookline: ratio slider 60–100, default 0.75, `rows = round(cols·A/r)`, k-means++ in Lab with `mulberry32(42)` ✓. TapestryCrochet: "500+ monthly users" is in the GitHub description ✓; k-means on unique colors, random init, 10 iterations ✓.

### What changed in the report

1. Graphghan Pattern Creator review count: 309 → 339 (309 is the phone filter). "Hidden" $2.99 reframed (§2, §3.6).
2. Crochet Crowd widths misread: "baby ≈ 30–35 blocks…" → "≈ 30" ≈ 35 blocks…" (§3.5). Tile-size range widened to include ≈ 0.86" (§1, §3.5, §4.7).
3. TapestryCrochet distance is not "redmean" (§3.9, §4.2).
4. graphghan's +20% is "tails" only (§4.9). Two graphghan quotes re-cited to design-rules.md (§4.5).
5. Quotes corrected: Patternize, Yarniby, Pixel-Stitch "contected" (§3.8, §3.2).
6. CrochetBench "collapse" → "sharply decreases" (§1).
7. Stitch Fiddle: product-subset rule needs ≥ 2 picks; mosaic transform row additions described exactly (§3.1).
8. Marked (unverified): KnitPro `file.pdf`; Seitz et al. quotes (ACM 403); Stitchsums "20% for sparse colors"; Stitch Fiddle "repeats only for knitting" (likely wrong); mosaic start/end orientation.

### Remaining doubts

- **Stitch Fiddle bundle hash** changes per release. All code-level claims hold for `en-main-4b1191b3eb71d8a8d3ec.js` as fetched on 2026-09-30.
- **Mosaic orientation in Stitch Fiddle**: the code prepends 1 row and appends 2 same-colored rows. If array index 0 is the chart top (likely, since written instructions default to `bottomToTop`), the two appended rows sit at the bottom, which would make them the *starting* rows. Confirm by importing a 2-color image in the live app.
- **C2C tile size** varies between 0.75" and 0.86" in worsted on 5 mm, depending on source. Our default (0.77") should be treated as a guess until the user swatches.
- **Yardage constants** are single-swatch or rule-of-thumb figures. The ±25% uncalibrated band in §6.5 still seems warranted.
- §6 recommendations ([I]) were checked only for internal arithmetic, not for design merit.
