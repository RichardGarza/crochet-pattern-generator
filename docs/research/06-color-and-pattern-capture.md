# 06: Color Reduction and Pattern Capture (2D charts and 3D amigurumi)

Status: research complete, ready for design review. Date: 2026-09-30.
Covers R1 (2D chart colors and per-color yardage inputs), R2/R3 (coloring the 3D result), R4 (the color half of the algorithm), and R8 (stripes, spots and motifs carried into 2D and 3D). It also touches R6 (color spaces of imported GLB files) and R7 (color tools in the 3D editor).

**Evidence legend.** Each claim is tagged with one of these.

- **[V] Verified.** The fact comes from the linked source, which was read for this report.
- **[M] Measured.** We measured it in a throwaway Python/numpy prototype written for this report: synthetic test images, plus the yarn hex data described in Section 7. Our CIEDE2000 code matches all 34 pairs of Sharma's published test data, with a maximum error of 5e-5. These numbers point a direction. They are not benchmarks.
- **[I] Inference.** This is our own design recommendation or reasoning.

---

## 0. Executive summary

1. **[I] Work in OKLab, with two different distances.**
   - Clustering uses Euclidean distance on `(toe(L), 2a, 2b)`. This equals CSS Color 4's ΔEOKr2, which the spec recommends for performance-sensitive code ([CSS Color 4 §20.5](https://www.w3.org/TR/css-color-4/)).
   - Matching a cluster to a yarn uses CIEDE2000, which is cheap at palette scale.
   - **[M]** On 933 yarn colors, ΔEOKr2 tracks ΔE00 better than plain ΔEOK. Spearman correlation is 0.80 vs 0.66.
2. **[I] Quantize deterministically.** Seed with a Wu-style variance split, then run weighted Lloyd k-means. This follows Celebi's finding that Wu-initialized fast k-means was the best of the methods he tested ([Celebi 2011](https://ar5iv.arxiv.org/html/1101.0395)).
   - Seed any randomness from a hash of the image and the parameters.
   - Do not copy Material Color Utilities' TypeScript k-means as-is. It calls `Math.random()` ([source](https://github.com/material-foundation/material-color-utilities/blob/main/typescript/quantize/quantizer_wsmeans.ts)).
3. **[V]+[M] Dithering is off by default.** Crochet tools warn that dithering scatters stitches, which is exactly what confetti cleanup removes ([ArtPatt FAQ](https://artpatt.com/tapestry-crochet-pattern-generator)).
   - **[M]** In our tests, Floyd–Steinberg raised confetti 2.3–3.5× and color changes per row 1.5–1.9×.
   - **[I]** For gradients, offer crochet-native options instead: row "fade" stripes, or dithering with a minimum run length.
4. **[I] Downsample according to the image type.**
   - Photos: area-average in linear light.
   - Flat art: quantize at source resolution, then take the mode (most common label) per stitch cell.
   - Pixel art: detect the native grid and do not resample. Stitchmate does the same ([Stitchmate](https://stitchmate.app/photo-to-crochet-pattern)).
5. **[I] Clean up in crochet terms, along the working path** (rows, C2C diagonals, or rounds):
   1. a protect mask for outlines and eyes;
   2. confetti removal;
   3. merging of small components;
   4. a 1-D Potts/Viterbi pass with a color-switch penalty λ and a minimum run length;
   5. a per-row color cap for tapestry.
   - **[M]** On test images this reduced confetti from about 1% to 0% and changes per row by 23–39%.
6. **[V] Yarn hex values are approximations everywhere.** No manufacturer publishes sRGB ([Stitchmate RHSS chart](https://stitchmate.app/tools/red-heart-super-saver-color-chart)).
   - **[M]** Two community sources for Red Heart Super Saver disagree by a median of ΔE00 3.7 (90th percentile 8.9) across 61 shades with the same name.
   - Use temperature-blanket.com's CC BY 4.0 data ([API terms](https://temperature-blanket.com/api/yarn-colorways)) and ship a "calibrate from my yarn photo" flow.
7. **[I] Capture patterns on the quantized label grid.**
   - Categorical autocorrelation finds repeats.
   - Consensus regularization makes detected repeats exact. **[M]** At 3% noise it restored a tiled chart with zero errors.
   - The prefix function compresses each row's run-length tokens into `*…; rep from *`.
   - Row hashing finds `Rows 13–24: rep Rows 1–12`.
8. **[I] 3D coloring.**
   1. Vote per stitch from visible, view-weighted samples. Waechter et al. assume most views see the true color ([paper](https://download.hrz.tu-darmstadt.de/pub/FB20/GCC/paper/Waechter-2014-LTB.pdf)).
   2. Smooth each round with a circular Potts DP. **[M]** In a Monte Carlo test, λ=0.3–0.6 cut errors about 3× and color changes about 2× versus argmax.
   3. Snap near-horizontal boundaries to whole rounds so they become stripes.
   4. Hide the spiral jog at the back, or switch striped sections to joined rounds ([PlanetJune](https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/)).
   5. Turn tiny details into embroidery or appliqué.
9. **[M] Use shading-robust features for photos of 3D objects.** OKLab scales exactly as `s^(1/3)` under pure intensity scaling, so `a/L` and `b/L` cancel Lambertian shading.
   - On a shaded red sphere with black spots, the fraction of red stitches mislabeled fell from 21% to 4.6%.
10. **[V] The academic crochet-pattern generators we found do not handle color.** AmiGo lists color as future work ([AmiGo](https://arxiv.org/abs/2211.01178)). The surfaces-of-revolution generator never mentions color ([arXiv 2302.02205](https://arxiv.org/abs/2302.02205)). Our color pipeline for R2/R3/R8 has little prior art to copy.

---

## 1. Color-science foundations

### 1.1 Decoding and linear light

- **[V] sRGB decoding.** If `c ≤ 0.04045`, linear = `c/12.92`. Otherwise linear = `((c+0.055)/1.055)^2.4`. Encoding back uses the 0.0031308 threshold and the 1/2.4 exponent ([CSS conversions.js](https://drafts.csswg.org/css-color-4/conversions.js)).
- **[V] Why linearize first.** Error diffusion should run on values that are "linearized first, rather than operating directly on sRGB values" ([Wikipedia: Floyd–Steinberg](https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering)).
- **[M] Gamma error in practice.** A 50/50 black-and-white mix averaged in linear light encodes to sRGB 187.5. Averaged on gamma-encoded values it gives 127.5, which is only 21.4% of the light. A red/green edge cell gives (188, 188, 0) in linear light vs (128, 128, 0) on gamma values.
  - Gamma-space averaging therefore produces muddy edge colors that become extra clusters.
  - On our flat-art test it raised changes per row from 3.3 to 4.0 and the component count from 47 to 58.

### 1.2 OKLab

- **[V] Definition.** OKLab is `(L,a,b) = M2 · cbrt(M1 · linRGB)`. It was designed to predict lightness, chroma and hue, and to blend evenly. The code is public domain or MIT ([Ottosson 2020](https://bottosson.github.io/posts/oklab/)). CSS ships the reference matrices ([conversions.js](https://drafts.csswg.org/css-color-4/conversions.js)).
- **[M] Scale-equivariance.** M1 and M2 are linear and the cube root is homogeneous, so `OKLab(s·rgb) = s^(1/3)·OKLab(rgb)` exactly. Numerically the maximum error was 6.6e-16 over 1,000 random colors.
  - Consequence: under pure intensity scaling (Lambertian shading under white light), the hue angle and the ratios `a/L` and `b/L` stay constant. Section 9.4 uses this.

### 1.3 Distances and JNDs

| Metric | Definition | Notes |
|---|---|---|
| ΔE76 | Euclidean in CIELAB | **[V]** JND revised to about 2.3 ([Wikipedia: Color difference](https://en.wikipedia.org/wiki/Color_difference)). |
| CIE94 (textiles) | kL=2, K1=0.048, K2=0.014 | **[V]** Graphic arts uses kL=1, K1=0.045, K2=0.015 ([Wikipedia](https://en.wikipedia.org/wiki/Color_difference)). kL divides ΔL, so kL=2 halves the weight of lightness. |
| CIEDE2000 | Sharma et al. 2005 | **[V]** "Implementations are often incorrect"; CSS gives code "validated to five significant figures" against Sharma's test suite (§20.2). The "using deltaE2000, one JND is 2" note is in the gamut-mapping section (§14.2.1 area), not §20.2 ([CSS Color 4](https://www.w3.org/TR/css-color-4/); [Sharma test data](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)). *(Corrected: the JND note was previously attributed to §20.2.)* |
| ΔEOK | Euclidean in OKLab | **[V]** 1 JND = 0.02 in the CSS gamut-mapping algorithm ([CSS Color 4 §14.2.1](https://www.w3.org/TR/css-color-4/)). |
| ΔEOK2 | a and b scaled ×2 | **[V]** "ΔEOK under-estimates differences in colorfulness"; scaling by 2 "greatly increased the predictive accuracy … compared to ΔE2000" ([§20.4](https://www.w3.org/TR/css-color-4/)). |
| ΔEOKr2 | toe(L), 2a, 2b | **[V]** "agrees significantly better with ΔE2000 … performance-sensitive [implementations] are encouraged to use ΔEOKr2". The toe uses K1=0.206 and K2=0.03 ([§20.5](https://www.w3.org/TR/css-color-4/)). |

**[M] Agreement with ΔE00** on 933 unique yarn hex values from 16 lines: the 14 lines in the §7.3 import list minus Bernat Softee Cotton, plus Hobby Lobby I Love This Yarn, Loops & Threads Impeccable and **Paintbox Cotton Aran**. CIELAB here uses a D65 white, not CSS's D50. *(Corrected: this was described as "16 lines, Section 7". The listed 16 lines, with Softee Cotton and without Cotton Aran, give 876 unique colors. On that set Spearman (≤ 25) is 0.796 / 0.662 / 0.775, so the conclusion is unchanged.)*

| Metric | Spearman vs ΔE00, pairs ≤ 25 (n=117,161) | Spearman, pairs ≤ 10 (n=13,337) | Nearest neighbor same as ΔE00 |
|---|---|---|---|
| ΔEOK | 0.664 | 0.577 | 55.7% |
| **ΔEOKr2** | **0.798** | 0.698 | 70.6% |
| ΔE76 | 0.776 | 0.705 | 73.1% |

- **[M]** The median ratio ΔEOKr2/ΔE00 is 0.0100. So ΔE00 = 2 (one JND) is about ΔEOKr2 = 0.02, which matches the CSS JND for ΔEOK.

**[I] Decision.**
- Clustering, smoothing and flood fill use features `f = (toe(L), 2a, 2b)`, where a plain Euclidean distance equals ΔEOKr2. k-means stays exact because centroids are means in that space.
- Every user-facing match (cluster → yarn, "nearest shade", calibration) uses CIEDE2000, via `culori.differenceCiede2000(Kl, Kc, Kh)`, which implements Sharma's version ([culori API](https://culorijs.org/api/)).
- ΔE76 is about as good as ΔEOKr2 for nearest-neighbor lookup. We still prefer OKLab for the shading math in §1.2 and for interpolation.

---

## 2. Quantization: algorithms, competitors, and our choice

### 2.1 Algorithm survey [V]

| Algorithm | How it works | Source |
|---|---|---|
| Median cut | Put pixels in a bucket, split on the channel with the largest range at the median, repeat, then average each bucket. "The most popular algorithm by far." | Heckbert, *Computer Graphics* 16(3):297–307, 1982 *(corrected from 297–303, which comes from the WPI list; Crossref DOI 10.1145/965145.801294 gives 297–307)* ([WPI refs](https://web.cs.wpi.edu/~matt/courses/cs563/talks/color_quant/CQref.html); [Wikipedia](https://en.wikipedia.org/wiki/Median_cut), [Wikipedia CQ](https://en.wikipedia.org/wiki/Color_quantization)) |
| Octree | A tree indexed by RGB bits (top level uses `4r+2g+b`), with leaves pruned and merged up to the target count | Gervautz & Purgathofer 1988; reprinted in *Graphics Gems* 1990 ([Wikipedia](https://en.wikipedia.org/wiki/Octree), [WPI](https://web.cs.wpi.edu/~matt/courses/cs563/talks/color_quant/CQref.html)) |
| Wu | Variance-minimizing box splits over cumulative color moments | *Graphics Gems II*, pp. 126–133, 1991 ([WPI](https://web.cs.wpi.edu/~matt/courses/cs563/talks/color_quant/CQref.html)) |
| k-means / k-means++ | Lloyd iterations. k-means++ seeds with D² sampling, with `E[φ] ≤ 8(ln k + 2)·φ_OPT`, and "improves both the speed and the accuracy" | Arthur & Vassilvitskii, SODA 2007 ([PDF](https://theory.stanford.edu/~sergei/papers/kMeansPP-soda.pdf)) |
| Celebi 2011 | Compared 14 initializers. "WSM-WU is the best method". Convergence `ΔSSE/SSE ≤ 0.001`; 2:1 subsampling and unique-color dedupe help; WSM is 12–20× faster than plain k-means; MSE is 18–50% better than the preclustering initializers alone | [arXiv 1101.0395](https://ar5iv.arxiv.org/html/1101.0395) |
| NeuQuant | A self-organizing map; "high-quality but slow", good for gradients | [Wikipedia CQ](https://en.wikipedia.org/wiki/Color_quantization) |
| libimagequant (pngquant) | Modified median cut that minimizes variance, followed by "Voronoi iteration (K-means)". Premultiplied alpha. Dithers "only … where several neighboring pixels quantize to the same value, and which are not edges". Licensed GPL v3+ or commercial | [pngquant.org](https://pngquant.org/), [lib docs](https://pngquant.org/lib/) |
| image-q (npm) | NeuQuant, RGBQuant and WuQuant, with CIEDE2000, CIE94 and other distances and a dozen error-diffusion kernels. MIT, v4.0.0 | [GitHub](https://github.com/ibezkrovnyi/image-quantization) |

### 2.2 What the crochet and craft tools actually do [V]

| Tool | Color reduction | Distance | Dither | Cleanup | Palettes / limits |
|---|---|---|---|---|---|
| crochetpatterngen engine (MIT) | LANCZOS resize to the grid, then Pillow `MEDIANCUT` with `Dither.NONE`, 2–16 colors, default 8 | RGB | none | Replaces a cell whose 4 neighbors all differ with the most common neighbor (needs ≥ 3 neighbors), up to 3 passes | hex only. C2C cell ratio 0.7 (h:w). Optional `rembg` u2net background removal (transparent → white) that warns when < 15% of pixels are non-white ([source](https://github.com/dengyu123456/crochet-engine)) |
| Stitchmate | "groups neighboring pixels into stitchable color regions before matching". The vendor claims about 79% less confetti | "CIEDE2000 in CIELAB" | Detail/dither control | Confetti cleanup with strength, a "Keep details brush" that protects eyes, text and lines, and a FLOW score | Red Heart Super Saver 72, Caron One Pound 46, Bernat Super Value 60. Pixel art is imported "with no resampling" ([crochet page](https://stitchmate.app/photo-to-crochet-pattern), [cross-stitch page](https://stitchmate.app/photo-to-cross-stitch), [handbook](https://stitchmate.app/handbook/image-import)) |
| ArtPatt | not disclosed | "CIEDE2000 perceptual color matching" | Optional error diffusion | "majority-vote filter"; "Heavy mode targets under 3% confetti" | [graphghan](https://artpatt.com/graphghan-pattern-generator), [tapestry](https://artpatt.com/tapestry-crochet-pattern-generator) |
| Stitch Fiddle | Colors "automatically selected based on your image" | not disclosed | not mentioned | manual editing | 50 colors free / 200 Premium; 300×300 / 1000×1000 grids ([help](https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture)). Brand palettes include Red Heart Super Saver 64 and Stylecraft Special DK 120 ([palettes](https://www.stitchfiddle.com/en/chart/create/crochet/colors)) |
| knitPro | **none.** "If your image has millions of colors your knitPro pattern will too." | — | — | — | Knit ratio 5:7 ([FAQ](https://www.microrevolt.org/FAQ.htm)) |
| Paint-by-numbers generator (MIT, not crochet) | k-means, 16 clusters by default, RGB/HSL/Lab | Euclidean | — | Removes facets under 20 px, then "narrow pixel strip cleanup" × 3 runs | `randomSeed = new Date().getTime()`, so not reproducible by default ([source](https://github.com/drake7707/paintbynumbersgenerator)) |
| Material Color Utilities `QuantizerCelebi` (Apache-2.0) | Wu on an RGB 5-bit (32³) histogram, then WSMeans in CIELAB | squared ΔE76 | — | — | `MAX_ITERATIONS=10` and `MIN_MOVEMENT_DISTANCE=3.0`. The initial point-to-cluster assignment uses `Math.random()`. A point is reassigned only when the move improves its distance by more than 3.0, so the random assignment persists and results are **nondeterministic**. (`Math.random()` also generates random Lab centers, but only when no Wu seeds are given.) ([source](https://github.com/material-foundation/material-color-utilities/blob/main/typescript/quantize/quantizer_wsmeans.ts)) |

### 2.3 Our quantizer [I]

- **Input.** Deduplicated feature points `(toe L, 2a, 2b)` with pixel counts as weights. At a 200×200 grid that is at most 40k points, so this runs in milliseconds inside a Web Worker.
- **Init.** A Wu-style deterministic variance split: repeatedly split the cluster with the largest weighted SSE along its principal axis, at the SSE-optimal cut.
  - Fallback: k-means++ with `mulberry32(seed)`, where `seed = FNV-1a(imageBytes ‖ params)`. Run 4 fixed seeds and keep the lowest SSE.
- **Refine.** Weighted Lloyd for at most 30 iterations. Stop when `(SSE_prev − SSE)/SSE < 1e-3`; this is Celebi's ε.
- **Determinism rules.**
  - Use stable sorts.
  - Break ties by lowest index.
  - Re-seed an empty cluster at the point with the largest weighted error.
  - Output clusters sorted by population, so A is the main color, matching CYC's MC/CC naming ([CYC abbreviations](https://www.craftyarncouncil.com/standards/crochet-abbreviations)).

```ts
// features: Float32Array (n*3); w: Float32Array (n); returns centers + labels
function quantize(P, w, K, opts) {
  let C = varianceSplitInit(P, w, K);             // deterministic, Wu-style
  let prev = Infinity;
  for (let it = 0; it < 30; it++) {
    const lab = assignNearest(P, C);              // ties -> lower index
    const { C2, sse, empty } = weightedMeans(P, w, lab, K);
    for (const k of empty) C2[k] = P[argmaxWeightedError(P, w, lab, C)];
    C = C2;
    if ((prev - sse) / sse < 1e-3) break;
    prev = sse;
  }
  return sortByPopulation(C, P, w);
}
function varianceSplitInit(P, w, K) {
  const clusters = [allIndices(P)];
  while (clusters.length < K) {
    const c = argmax(clusters, weightedSSE);       // worst cluster
    const axis = principalAxis(c, P, w);           // power iteration, start [1,1,1]
    const order = stableSortBy(c, i => dot(P[i], axis));
    const t = bestSplitByPrefixSums(order, P, w);  // min SSE(left)+SSE(right)
    clusters.splice(indexOf(c), 1, order.slice(0, t), order.slice(t));
  }
  return clusters.map(c => weightedMean(c, P, w));
}
```

### 2.4 Choosing K [V guidance + I algorithm]

**Vendor guidance [V]:**
- Graphghans: 8–12 colors in most cases, 6–10 for simple graphics, 15–20 for portraits ([ArtPatt](https://artpatt.com/graphghan-pattern-generator)).
- Stitchmate: "most graphghans work best somewhere between 4 and 10 colors" ([Stitchmate](https://stitchmate.app/photo-to-crochet-pattern)).
- Tapestry: 8–10 for bags, 6–8 for wearables, 10–12 for blankets. "At 8 colors, you're crocheting over 7 carried strands"; more than 12 makes the fabric "too thick" ([ArtPatt tapestry](https://artpatt.com/tapestry-crochet-pattern-generator)).

**Our defaults [I]:**

| Technique | Default K | Max K | Per-row / per-round cap |
|---|---|---|---|
| Graph / single-crochet graphghan | 8 | 16 | warn when a row has more than 6 strands |
| C2C | 8 | 16 | per diagonal, same rule |
| Tapestry (carried) | 5 | 8 | 3 colors per row (2 carried) |
| Amigurumi (3D) | 6 for the whole toy | 8 | 3 per piece, 2 per round (3 with warning) |

**Auto-K [I]:**
1. Run the quantizer for K = 2..Kmax.
2. Compute the distortion `D(K) = sqrt(SSE/W)` in ΔEOKr2 units.
3. Choose the Kneedle knee (Satopää et al., ICDCSW 2011 ([ref](https://www.researchgate.net/publication/224249192_Finding_a_Kneedle_in_a_Haystack_Detecting_Knee_Points_in_System_Behavior))). Cap it with the technique's maximum.
4. Then apply the two rules below.

- **Salience protection.** A cluster smaller than 0.3% of cells survives if its nearest-center ΔE00 is at least 20 and it has at least 2 cells. Eyes, a red nose, and small logos depend on this.
- **Merge rule.** Merge centers that are closer than ΔE00 5.
  - **[M]** Within one yarn line, the median nearest-shade spacing is ΔE00 6.0–10.7. Finer palette differences cannot be bought as yarn.

---

## 3. Dithering: why we keep it off, and what we offer instead

- **[V] Kernels.**
  - Floyd–Steinberg diffuses 7/16, 3/16, 5/16 and 1/16, often in serpentine order ([Wikipedia](https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering)).
  - Bayer ordered dithering applies `c' = nearest(c + r·(M(x mod n, y mod n) − ½))` with `M₄ = (1/16)[0 8 2 10; 12 4 14 6; 3 11 1 9; 15 7 13 5]`. It produces cross-hatch patterns ([Wikipedia](https://en.wikipedia.org/wiki/Ordered_dithering)).
- **[V] Why crochet tools avoid it.** ArtPatt answers "Should I turn on dithering for tapestry crochet?" with: "Usually no. Dithering creates scattered alternating color pixels — exactly what confetti reduction removes. The two features work against each other." Its exception is a deliberately "stippled/heathered effect" ([ArtPatt](https://artpatt.com/tapestry-crochet-pattern-generator)).
  - In graphghans every isolated stitch "means picking up and dropping a bobbin for one stitch" ([ArtPatt graphghan](https://artpatt.com/graphghan-pattern-generator)).
  - The crochetpatterngen engine uses `Dither.NONE` ([source](https://github.com/dengyu123456/crochet-engine)).
- **[M] Measured cost.** Floyd–Steinberg, serpentine, error carried in linear RGB, on a 60×60 grid:

| Image | Confetti (plain → FS) | Changes per row | 4-connected components |
|---|---|---|---|
| Flat art, K=7 | 0.8% → 1.8% | 3.3 → 4.9 | 47 → 102 |
| Shaded "ladybug", K=4 | 1.2% → 4.2% | 4.7 → 9.1 | 62 → 214 |

  - Running cleanup (confetti pass + small-component merge, no Potts) after dithering left 3.4 and 4.5 changes per row. The same two stages without dithering reached 2.6 and 3.9. Cleanup cannot fully undo dithering. *(Corrected: the no-dither figures were previously given as 2.0 and 3.6. Those include the Potts pass, which the dithered run did not get, so the comparison was not like-for-like.)*
- **[V] Where dithering helps.** Photographic gradients turn into bands without it; ArtPatt suggests dithering "to simulate the gradient" ([ArtPatt](https://artpatt.com/graphghan-pattern-generator)). pngquant dithers only flat, non-edge regions ([pngquant](https://pngquant.org/)).
- **[I] What we offer:**
  1. **Off** (default for every technique).
  2. **Row fade.** 1-D error diffusion between rows only: each row segment inside a gradient region takes a single color, and the diffused error goes to the next row. Gradients become varying-width stripes with no extra color changes within a row.
  3. **Run-constrained diffusion.** Floyd–Steinberg at 0.75 strength in linear RGB, restricted to the two nearest palette colors, and only where the 3×3 neighborhood has ΔEOKr2 < 0.03 (pngquant's idea). It is followed by the Potts pass with a minimum run of 3, so the speckle becomes short dashes.
  4. **Heathered (Bayer 4×4)** for users who want the stippled look. Confetti cleanup is disabled for that region.

---

## 4. Downsampling and image-type detection

### 4.1 Grid geometry

- **[V] Stitch cells are not square.**
  - C2C blocks are "wider than tall (0.7:1 h:w)" ([crochet-engine](https://github.com/dengyu123456/crochet-engine)).
  - Single crochet is "about 14 stitches and 16 rows to 10 cm in worsted" ([ArtPatt](https://artpatt.com/tapestry-crochet-pattern-generator)).
- **[I]** Each cell maps to a source rectangle of `(W/cols) × (H/rows)` source pixels, with rows chosen so the finished piece keeps the image's aspect ratio. The gauge math lives in the gauge-research doc. Our sampler takes exact fractional-area box coverage, so non-integer ratios work.

### 4.2 Three modes [I unless noted]

| Mode | Use when | How |
|---|---|---|
| Photo | photos, paintings | Decode to linear RGB (premultiplied by alpha), box-average each cell, convert to OKLab features, quantize. Never use LANCZOS or bicubic before quantizing: their ringing invents new colors. |
| Flat art | logos, cartoons, clip art | Light denoise (3×3 median on labels, below), quantize at **source** resolution, then per cell take the area-weighted label **mode**, protecting thin features (below). JPEG halos get absorbed instead of creating clusters. |
| Pixel art | sprites, AI "pixel art" | Detect the native grid; one cell = one native pixel; no resampling. **[V]** Stitchmate: "a 40×40 sprite becomes a 40×40 graph" ([Stitchmate](https://stitchmate.app/photo-to-crochet-pattern)). If the user wants a different size, offer only integer multiples, and warn. |

**[V] Prior art for grid detection.**
- Exact pixel art: try common divisors of W and H, largest first, and accept the first block size where every block is a solid color ([duniul/pixel-scale](https://github.com/duniul/pixel-scale), ISC license) (unverified). This fails on JPEG noise and off-grid crops.
- Noisy or AI pixel art:
  - Canny edges, morphological closing, probabilistic Hough, median line spacing, then "the most common color in the cell" ([proper-pixel-art](https://github.com/KennethJAllen/proper-pixel-art)).
  - FFT magnitude to get the grid size, Sobel alignment, then center/median/majority sampling ([perfectPixel](https://github.com/Mashiro0619/perfectPixel)).
  - Both repositories are MIT (unverified).

**[I] Our detector.**
1. Build `ex[x] = Σ_y [ΔEOKr2(p(x,y), p(x−1,y)) > 0.05]`, and `ey[y]` the same way along columns.
2. The fundamental period of `ex` and `ey` (autocorrelation peak, period ≥ 3 px) gives the block size `s` and phase `φ`.
3. Accept if at least 90% of blocks have a within-block ΔEOKr2 standard deviation below 0.03.

**[I] Photo, flat or pixel art.** Prior work separates photographs from graphics using "color variation, color saturation, and color transition strength" ([survey, PicToSeek](https://twiki.di.uniroma1.it/pub/Estrinfo/Materiale/web_image_retrieval.pdf)). Our proposed rules, to be tuned on a test set:

- `uniqueColors ≤ 256` and the top 16 colors cover ≥ 90% of pixels → flat candidate.
- `flatness` = share of pixels whose 4-neighbors are all within ΔEOKr2 0.01. A value ≥ 0.75 means flat.
- Pixel art if the detector above accepts.
- Otherwise photo. The user can always override.

**[I] Thin features in mode pooling.** A 2 px outline in a 10 px cell covers 20% of the cell, so a plain mode always deletes it. At source resolution:
1. Mark as **thin** any label component whose maximum distance-transform value is below half a cell and whose skeleton spans at least 2 cells.
2. In each cell its skeleton crosses, assign the thin label if its coverage is ≥ 15%.
3. Repair 8-connectivity afterwards: a diagonal-only link gets one bridging cell.

Thin cells join the protect mask (§6.3).

**[I] Edge-preserving smoothing (optional, photo mode).** A bilateral filter at 4× grid resolution with σ_s = 0.5 cell and σ_r = ΔEOKr2 0.05, applied before the box average. Area averaging already removes most noise, so ship it behind a toggle.

---

## 5. Background and transparency

- **[V] Alpha.** pngquant "works in premultiplied alpha color space to give less weight to transparent colors" ([pngquant](https://pngquant.org/)).
- **[I] Alpha rules.**
  1. Average premultiplied linear RGB together with alpha.
  2. A cell with coverage α < 0.5 becomes **background**.
  3. Otherwise un-premultiply and composite over the chosen background yarn in linear light.
  4. Background is a label outside the quantizer (it uses no K budget). It renders either as a chosen yarn or as "no stitches" when the cutout shape is the piece.
- **[I] Opaque images: border flood fill.**
  1. Take a ring that is 2% of the width on each side.
  2. If one color cluster covers ≥ 60% of the ring with a ΔEOKr2 standard deviation < 0.03, flood-fill (4-connected) from the border with a tolerance of ΔEOKr2 0.05 (about ΔE00 5).
  3. Do not cross strong edges: Sobel magnitude at or above the 90th percentile.
  4. Show the mask for the user to confirm.
- **[V] In-browser options and licenses.**
  - **Interactive:** OpenCV.js `cv.grabCut(image, mask, rect, bgdModel, fgdModel, iterCount, mode)`. The user drags a rectangle; GMM plus graph cut iterates ([OpenCV.js tutorial source](https://github.com/opencv/opencv/blob/4.x/doc/js_tutorials/js_imgproc/js_grabcut/js_grabcut.markdown)).
  - **ML models:**
    - `@imgly/background-removal` is AGPL ([repo](https://github.com/imgly/background-removal-js)) (unverified here; the leecy.me write-up independently reports an AGPL model being removed for licensing).
    - BRIA RMBG-1.4 is "non-commercial use"; commercial use needs an agreement ([HF card](https://huggingface.co/briaai/RMBG-1.4)).
    - One developer reports that BiRefNet (MIT) crashed WASM memory and that **ormbg-ONNX (Apache-2.0)** ran reliably ([write-up](https://leecy.me/four-models-to-remove-one-background-a-browser-ml-war-story/)).
  - **Sanity guard:** the crochetpatterngen engine warns when background removal leaves under 15% subject ([source](https://github.com/dengyu123456/crochet-engine)).
- **[I] Our recommendation.** The heuristic plus GrabCut are the core. An optional, lazily loaded Apache-licensed model (ormbg) can come later. Avoid AGPL and non-commercial models, because the repository is public and its license must stay clean.

---

## 6. Crochet-specific cleanup

### 6.1 Workability metrics, computed after every stage

- **[V] Confetti.** "Single stitches of a color with no same-colored neighbor."
  - Stitchmate's cross-stitch tiers: under 2% is barely noticeable; 5–10% is tedious; over 10% hurts ([Stitchmate guide](https://stitchmate.app/guides/what-is-confetti-cross-stitch)).
  - ArtPatt's heavy mode targets under 3% for tapestry ([ArtPatt](https://artpatt.com/tapestry-crochet-pattern-generator)).
  - Stitchmate's FLOW score covers "Fragmentation (confetti), Locality (color clustering), Optimization (palette efficiency), and Workability" ([Stitchmate](https://stitchmate.app/photo-to-cross-stitch)).
- **[I] Our metric panel** (all along the working path):
  - confetti %;
  - color changes per row (mean and max);
  - strands started (= bobbins), and ends to weave ≈ 2 × strands;
  - carried colors per row (tapestry);
  - fidelity, as mean ΔE00 between source cells and the final label colors.
  - Publish it as a 0–100 "Workability" score with sub-scores, so users see the tradeoff like FLOW.

### 6.2 Technique constraints that shape cleanup

- **[V] Tapestry.**
  - "If done correctly, the carried yarn will not be visible"; "Each yarn carried will slightly increase the height of the single crochet stitch" ([Carol Ventura](https://www.carolventura.com/rightstitches.html)).
  - ArtPatt counts 12 cm per worked stitch plus 3 cm per carried stitch, with a 15% buffer, for tapestry yardage ([ArtPatt](https://artpatt.com/tapestry-crochet-pattern-generator)). Yardage details are in the gauge doc. Our color stage exports `worked[c]`, `carried[c]` and `strands[c]` as inputs.
- **[V] Graphghan carry vs bobbins.** One designer carries "anytime I have two or less of a new color" and otherwise uses bobbins, because carried yarn "tends to show" ([Kari's Crafts](https://www.kariscraftsonline.com/2015/10/crochet-graphghans-how-to-change-color.html)).
- **[V] Reading order.** Flat charts: Row 1 starts bottom right; odd (right-side) rows run right to left and even rows left to right. Rounds go anticlockwise for right-handed crocheters and clockwise for left-handed ([Simply Yarn](https://simply-yarn.com/guides/how-to-crochet/how-to-read-crochet-charts)).
- **[I] Consequence.** Every 1-D operation (runs, Potts, caps, RLE) walks the **working path**:
  - boustrophedon rows for flat work;
  - anti-diagonals `i+j = const` for C2C;
  - circular rounds for work in the round and amigurumi.
  - A left-handed mode mirrors the path.

### 6.3 Cleanup algorithms, in order [I; prior art noted]

0. **Protect mask.** Covers thin-feature cells (§4.2), "salient" labels (small, with ΔE00 ≥ 20 to every neighbor), and user-painted cells.
   - **[V]** Stitchmate's "Keep details brush" protects "eyes, text or fine lines from Clean up" ([handbook](https://stitchmate.app/handbook/image-import)).
1. **Confetti pass.** The crochetpatterngen rule replaces a cell when all 4 neighbors differ ([source](https://github.com/dengyu123456/crochet-engine)).
   - Our version requires 0 same-label 4-neighbors and at most 1 in the 8-neighborhood.
   - The replacement is the most frequent 8-neighbor label; ties go to the closest ΔE.
   - Up to 3 passes, skipping protected cells.
2. **Small components.** **[V]** The paint-by-numbers generator removes facets under 20 px ([settings.ts](https://github.com/drake7707/paintbynumbersgenerator)).
   - Our threshold is `A_min` = 3 cells for tapestry and 2 for graph and C2C.
   - A small component merges into the neighbor with the longest shared border (ties go to the closest color), smallest component first.
3. **Narrow strips (optional).** **[V]** The paint-by-numbers generator replaces a pixel that differs from both its top and bottom neighbors with the closer of those two, and does the same horizontally, for 3 runs ([source](https://github.com/drake7707/paintbynumbersgenerator)). **[I]** This erases outlines, so only run it on unprotected cells.
4. **Mode filter / morphology (use sparingly).** **[V]** `skimage.filters.rank.majority` assigns "the most common value within its neighborhood" ([docs](https://scikit-image.org/docs/stable/api/skimage.filters.rank.html)).
   - **[I]** A 3×3 mode filter rounds corners and kills 1-cell lines. Use it only in photo mode, before step 1.
   - Label-wise closing (3×3) is used only to repair broken outlines in the protected label.
5. **Working-path Potts DP.** For each line, minimize `Σ_i d(f_i, C[k_i])/s + λ·[k_i ≠ k_{i−1}]` with Viterbi.
   - `s` is the median distance between centers.
   - Add a minimum-run constraint by expanding the states to `(k, runLength ≤ r_min)`.
   - Default λ = 0.4 for graph and C2C and 0.6 for tapestry; `r_min` = 2 for tapestry and 1 for graph and C2C (table in §6.5).
   - Protected cells get unary cost +∞ for every label except their own.
6. **Per-row color cap (tapestry).** If a row has more than `C_row` = 3 distinct labels:
   1. Keep the top 3 by `count × importance`, where importance is 3 for protected labels and 1 otherwise.
   2. Rerun step 5 with the other labels forbidden.
7. **Strands and bobbins.**
   - A run starts a new strand unless the previous row has a same-color run overlapping `[x0−g, x1+g]`.
   - Same-color runs separated by at most `g = 2` stitches count as one carried strand (Kari's rule).
   - Report strands, ends, and the busiest rows.

```ts
function rowPotts(unary /* W×K */, lambda, rMin, allowed /* K bools */) {
  // state (k, r) with r in 1..rMin (r capped); switching from k only when r === rMin
  // cost[k][r] = min cost of prefix ending in label k with current run length r
  // O(W · K² · rMin); W ≤ 300, K ≤ 16, rMin ≤ 3  →  < 1 ms per row
}
```

### 6.4 Measured effect [M]

On 60×60 grids:
- **Flat art (K=7):** confetti 0.8% → 0.0%. Changes per row 3.3 → 2.8 (confetti pass) → 2.6 (small-component merge) → **2.0** (Potts λ=0.6). Components 47 → 13.
- **Shaded ladybug (K=4):** confetti 1.2% → 0.0%. Changes per row 4.7 → 4.0 → 3.9 → **3.6**. Components 62 → 11.
- These used a plain argmax without protection. Expect a smaller reduction in rows that contain protected outlines.

### 6.5 Default cleanup parameters by technique [I]

| | Graph | C2C | Tapestry | Amigurumi (per round) |
|---|---|---|---|---|
| Confetti passes | 3 | 3 | 3 | 2 (stitch graph) |
| `A_min` (cells) | 2 | 2 | 3 | 3 |
| λ (Potts) | 0.4 | 0.4 | 0.6 | 0.4 |
| `r_min` | 1 | 1 | 2 | 2 |
| Color cap per line | warn at > 6 strands | warn at > 6 | 3 | 2 (3 with warning) |
| Confetti target | < 2% | < 2% | < 1% | 0 (details become embroidery) |

---

## 7. Palette matching to real yarn lines

### 7.1 Sources

- **[V] temperature-blanket.com Yarn Colorways.**
  - Data license: "CC BY 4.0 … Example Attribution: Yarn colorways from temperature-blanket.com licensed under CC BY 4.0 DEED."
  - "HTML hex colors are approximations of fiber colors."
  - Hex values are added by the developer at users' request.
  - The API is served through RapidAPI and needs a key; the free plan allows 500 calls per month ([API terms](https://temperature-blanket.com/api/yarn-colorways)).
  - The repository is GPL-3.0 code; each yarn's `colorways.ts` cites the retailer page and access date ([repo](https://github.com/jdvlpr/Temperature-Blanket-Web-App)).
- **[V] Stitchmate's Red Heart Super Saver chart.** 72 shades with official numbers. Hex values were measured "by sampling the pixels of the manufacturer's own studio photo of the skein — an uncalibrated, JPEG-compressed image of one dye lot". The page says that "across all three yarn palettes" the sampling "runs about 2.6 L* darker and 4.8 chroma units duller than a person reading the same photo". It adds that deep greens and teals (Real Teal, Hunter Green, Paddy Green) are off by "up to about 16 CIEDE2000 units". It also warns: "do not buy yarn from them" ([Stitchmate](https://stitchmate.app/tools/red-heart-super-saver-color-chart)).
- **[V] Other sources.**
  - `makebead/craft-color-codes`: Red Heart Super Saver, 44 colors, data under CC BY 4.0, with a CIEDE2000 `nearest()` function ([repo](https://github.com/makebead/craft-color-codes)).
  - An open-source alpha-pattern editor already vendored Stylecraft Special DK, Paintbox Simply DK and Scheepjes Colour Crafter from temperature-blanket at a pinned commit, with CC BY credit ([PR #15](https://github.com/matejmojemeno/alpha-pattern-editor/pull/15)) (unverified).
  - Stitch Fiddle palettes: Red Heart Super Saver 64, Stylecraft Special DK 120, Caron Simply Soft 41, Bernat Super Value 49, Caron One Pound 43 ([Stitch Fiddle](https://www.stitchfiddle.com/en/chart/create/crochet/colors)).

### 7.2 Accuracy [M]

- **Two sources disagree.** Comparing Red Heart Super Saver hex values from temperature-blanket and Stitchmate over 61 shades with the same name: median ΔE00 3.7, mean 4.6, 90th percentile 8.9, maximum 13.5 (Light Periwinkle). 20 of 61 differ by more than 5, and 4 by more than 10. These figures use CIELAB with a D65 white. With CSS's D50 Lab they are median 3.7, 90th percentile 9.0, maximum 13.8, and 19 shades over 5. (Grenadine, Rosy, Flame and Gray have no same-name match.)
- **Line resolution.** The median nearest-neighbor ΔE00 within a line is 6.0 (Bernat Blanket) to 10.7 (Lion Brand Pound of Love); Red Heart Super Saver is 6.6 and Stylecraft Special DK 6.9.
- **Likely data errors.** Some near-duplicate pairs are probably sampling errors. Red Heart Super Saver "Hunter Green" and "Paddy Green" are ΔE00 1.0 apart in the dataset, although they are sold as separate shades; Stitchmate's independent sample of Paddy Green is also very dark (`#0d3628`). Stylecraft "Pomegranate" and "Bright Pink" are 0.7 apart.
- **[I] Rule.** Flag every same-line pair under ΔE00 2 for manual QA. Ship a user calibration flow:
  1. The user photographs their skein next to a white card.
  2. We white-balance on the card and sample the median of the skein mask.
  3. That color overrides the stored hex value for that user.

### 7.3 Core shades per requested line (snapshot)

Snapshot: temperature-blanket data at commit `d22f7d9`, CC BY 4.0.

**[I] Selection method.** For each of 28 reference hues, take the nearest shade by ΔE00, unique within the line, and drop any match farther than ΔE00 22.

**Numbers.** Red Heart numbers are name-matched to Stitchmate's list. Paintbox "Aran nnn" numbers come from LoveCrafts' Simply Aran listing (100% acrylic, 201 yd (184 m) per 100 g; [LoveCrafts](https://www.lovecrafts.com/en-us/p/paintbox-yarns-simply-aran)), which uses the same shade names as Simply DK. The hex values for Paintbox are Simply DK samples, used as a proxy for Aran.

**Weights:** w = worsted, d = DK, s = sport, sb = super bulky.

**Red Heart Super Saver solids** (w; 65 in dataset; [source](https://www.yarnspirations.com/red-heart-super-saver-yarn/E300.html), accessed 2022-03-07):
Aran 0313 `#f0f0ec` · Soft White 0316 `#e5e6e1` · Oatmeal 0326 `#d6d1cd` · Gray Heather 0400 `#7a7e83` · Charcoal 3950 `#46484f` · Black 0312 `#0e0e12` · Cornmeal 0320 `#e4cea1` · Gold 0321 `#dbaa65` · Café Latte 0360 `#6d5f52` · Coffee 0365 `#342421` · Hot Red 0390 `#a22c3d` · Burgundy 0376 `#571324` · Pumpkin 0254 `#d8824f` · Rosy `#d29c9d` · Bright Yellow 0324 `#edd354` · Saffron 0234 `#eeac4d` · Spring Green 0672 `#8bb96c` · Tea Leaf 0624 `#7e9467` · Hunter Green 0389 `#1e4136` · Jade 3862 `#436c6a` · Turqua 0512 `#5eb1bb` · Country Blue 0382 `#97b8c5` · Blue 0886 `#3b6cb2` · Soft Navy 0387 `#2d3253` · Light Jasmine 0115 `#bbb0d3` · Dark Orchid 0776 `#502759` · Baby Pink 0724 `#f5d1d8` · Pretty N' Pink 0722 `#eb7d9f`

**Lion Brand Basic Stitch Anti-Pilling** (w; 55; [source](https://www.lionbrand.com/products/basic-stitch-anti-pilling-yarn), accessed 2023-11-05):
Summit `#e1ecee` · Ecru `#ebe7d6` · White `#d5d7db` · Deep Denim Heather `#828da1` · Charcoal Heather `#474a4c` · Black `#181a1b` · Peachy `#ebd0b8` · Beech `#c3a477` · Russet Heather `#754631` · Cocoa `#322118` · Pumpkin `#a0452e` · Red Heather `#6f2727` · Sienna `#9e7e5b` · Birch `#c1b3a7` · Lemonade `#f6ebbc` · Mustard `#b59646` · Volt Yellow `#daf18f` · Grass `#2c6645` · Pine Heather `#3c4f41` · Neptune Green `#3d8991` · Frost `#a5c7c1` · Pure Platinum `#aac0ca` · Stonewash `#5b6d87` · Purple `#271a3e` · Deco Rose `#aa999f` · Royal Blue `#1b3269` · Baby Pink `#ddb8c3` · Atomic Pink `#df3285`

**Lion Brand Vanna's Choice** (w; 43; [source](https://www.lionbrand.com/collections/all-yarns/products/vannas-choice-yarn), accessed 2022-03-07):
White `#f9f9f9` · Fisherman `#ded4c4` · Silver Heather `#c6c7c7` · Pale Grey `#9f9fa1` · Dark Gray Heather `#363536` · Black `#0b0d13` · Beige `#e8d6b9` · Honey `#c1833f` · Chocolate `#744b3e` · Cranberry `#5f1013` · Scarlet `#d13531` · Brick `#9f312a` · Terracotta `#b5593b` · Pink `#efd2cd` · Mustard `#d2ab4c` · Pea Green `#a29652` · Seaspray Mist `#d0d995` · Kelly Green `#687543` (looks mis-sampled) · Sage `#566b61` · Dusty Blue `#7192a4` · Sea Glass `#bdd2c6` · Silver Blue `#cdd8de` · Colonial Blue `#3e64a8` · Midnight Blue `#0c1a33` · Rose Mist `#c27e96` · Purple `#584572` · Vanilla Twist `#b0a8a2` · Pink Grapefruit `#e96f6e`

**Lion Brand Pound of Love** (w; 32; [source](https://www.lionbrand.com/products/pound-of-love-yarn), accessed 2023-12-20):
White `#dcded9` · Antique White `#f1e8ca` · Elephant Grey `#bfc0c0` · Oxford Grey `#828282` · Charcoal `#231e24` · Black `#161112` · Sugar Cookie `#d0c1ab` · Pumpkin Pie `#c59766` · Pumpkin Spice `#7e3926` · Cinnabar `#542f2d` · Terracotta `#9b615c` · Cherry `#6e141e` · Pink Salt `#dab8a4` · Honey Bee `#f7e979` · Straw `#bdb275` · Vanilla `#cfd1b5` · Olive `#677f5c` · Wintergreen `#295e3c` · Fern `#457360` · Pastel Blue `#abd2e4` · Cadet `#8da0b1` · Denim `#4b6ea5` · Thistle `#48456c` · Quartz `#c3bdc4` · Cascade `#193e53` · Pastel Pink `#e6d5d0` · Cerise `#ae4065`

**Paintbox Simply DK / Simply Aran** (d / aran; 63; [source](https://www.lovecrafts.com/en-gb/p/paintbox-yarns-simply-dk), accessed 2023-07-13):
Paper White (Aran 200) `#e8e8ea` · Champagne White (202) `#f1e9df` · Elephant Grey (61) `#c8c6c5` · Slate Grey (205) `#7f7a7c` · Granite Grey (206) `#3d383a` · Pure Black (201) `#1b191a` · Light Caramel (208) `#d8b488` · Soft Fudge (209) `#ad8160` · Coffee Bean (210) `#4f3628` · Red Wine (215) `#621221` · Rose Red (213) `#c52b2f` · Pillar Red (214) `#781723` · Blood Orange (219) `#d76d32` · Peach Orange (254) `#f0b69d` · Buttercup Yellow (222) `#f4c64f` · Mustard Yellow (223) `#e6ad41` · Spearmint Green (225) `#93c292` · Grass Green (229) `#387946` · Racing Green (227) `#243223` · Jewel (72) `#347186` · Marine Blue (233) `#57b8d0` · Duck Egg Blue (235) `#c5cfe1` · Kingfisher Blue (234) `#3575b7` · Midnight Blue (237) `#1f2047` · Dusty Lilac (246) `#998cb4` · Pansy Purple (247) `#5b3a7f` · Candyfloss Pink (249) `#e9cfd9` · Lipstick Pink (251) `#c6324e`

**Stylecraft Special DK** (d; 125; [source](https://www.stylecraft-yarns.co.uk/yarns/special-dk), accessed 2024-12-31):
Hint of Silver 1807 `#e9e6e4` · Cream 1005 `#e9e0cd` · White 1001 `#e2e2e3` · Silver 1203 `#a8a8a5` · Charcoal 1128 `#504f4c` · Black 1002 `#121011` · Toy 1844 `#e7c4a1` · Camel 1420 `#c29452` · Gingerbread 1806 `#9d5826` · Walnut 1054 `#462b1e` · Tomato 1723 `#c82d23` · Carnation 1204 `#6c1431` · Spice 1711 `#e85c1b` · Apricot 1026 `#f7bcab` · Citron 1263 `#f9c748` · Mustard 1823 `#d1a10b` · Spring Green 1316 `#b7d8a6` · Kelly Green 1826 `#06783a` · Bottle 1009 `#1c3c29` · Storm Blue 1722 `#4d7884` · Aquamarine 2187 `#61c3d3` · Nigella 2179 `#97bedc` · Aster 1003 `#296db5` · French Navy 1854 `#0b1a41` · Wisteria 1432 `#9c83b3` · Proper Purple 1855 `#55276d` · Powder Pink 1843 `#dfbdc2` · Fondant 1241 `#ea7196`

**Bernat Softee Baby** (d; 22; [source](https://www.yarnspirations.com/products/bernat-softee-baby-yarn), accessed 2024-03-05). This line has fewer than 20 core shades; Softee Cotton adds 14 more in the dataset.
White `#eeecf3` · Antique White `#ece5dd` · Gray Marl `#d0d0db` · Flannel `#a1a2ad` · Baby Gray `#636267` · Lemon `#f3edc7` · Little Mouse `#a18a80` · Soft Red `#d15a63` · Cantaloupe `#efa588` · Soft Peach `#dda59e` · Grass Green `#6e9661` · Aqua `#5f93a0` · Mint `#c8e2dc` · Pale Blue `#bccde9` · Navy `#2f4169` · Lavender `#a498bc` · Baby Pink Marl `#e9cfde` · Petunia `#db75a8`

**Bernat Blanket** (sb; 64; [source](https://www.yarnspirations.com/products/bernat-blanket-yarn-300g-10-5oz-1), accessed 2026-06-20):
White `#e3e4e5` · Vintage White `#ede6d6` · Beach Foam `#dad2d1` · Frosted Blue `#878d93` · Lead `#47474d` · Coal `#171717` · Birch `#dbd2c7` · Gold `#b88c52` · Pumpkin Spice `#8c492e` · Taupe `#3e3021` · Weathered Red `#bf5b4f` · Crimson `#793642` · Burnt Mustard `#bc8846` · Pink Dust `#dec2c2` · Sunsoaked `#d0a155` · Sand `#bb9b76` · Spring Grass `#b5c4af` · Fern `#88915f` · Malachite `#21493c` · Aquatic `#367173` · Light Teal `#6d9aa2` · Overcast `#a8aab1` · Cobalt `#4c5987` · Lapis `#17203e` · Floret `#b6a6c3` · Deep Grape `#51405f` · Tan Pink `#ccb0b2` · Terracotta Rose `#b96466`

**Caron Simply Soft solids** (w; 50; [source](https://www.joann.com/caron-simply-soft-yarn/prd23209.html), accessed 2022-03-07):
White `#f2f2f2` · Off White `#f6efdc` · Soft Blue `#c9d9e7` · Soft Gray Heather `#909194` · Charcoal Heather `#3d3c3c` · Black `#12110f` · Bone `#dbceb2` · Sunshine `#d4a956` · Taupe `#664c45` · Chocolate `#52261a` · Harvest Red `#ba2b26` · Burgundy `#561c2f` · Neon Orange `#eb7f41` · Soft Pink `#edcdc6` · Lemonade `#ead568` · Gold `#e2ac46` · Chartreuse `#c0c967` · Kelly Green `#4da37e` · Dark Sage `#364730` · Pagoda `#2a5771` · Robins Egg `#92c6c7` · Light Country Blue `#96b1c4` · Royal Blue `#4166bb` · Dark Country Blue `#2c314e` · Lavender Blue `#9290c2` · Purple `#3f2b5f` · Plum Wine `#d098a3` · Neon Pink `#e84790`

**WeCrochet/Knit Picks Brava Worsted** (w; 50; [source](https://www.knitpicks.com/yarn/brava-worsted/c/5420219), accessed 2023-01-16):
White `#ececed` · Custard `#e6c698` · Dove Heather `#cccdd1` · Silver `#7a7f86` · Cobblestone Heather `#555b5d` · Black `#272529` · Cream `#cdb19b` · Almond `#c2977a` · Espresso `#7b513b` · Carob `#2e1f16` · Paprika `#bb402f` · Wine `#651922` · Orange `#ed6f41` · Seashell `#f2b2ac` · Canary `#f9c54c` · Caution `#ea9d41` · Alfalfa `#b3d595` · Grass `#3e9a66` · Dublin `#3d4c31` · Tidepool `#297076` · Cornflower `#49b6ca` · Sky `#cbe4f2` · Denim `#6188ac` · Solstice Heather `#122858` · Seraphim `#a88f9d` · Mulberry `#572a57` · Blush `#ecd4da` · Rouge `#e74e7e`

**WeCrochet/Knit Picks Brava Sport** (s; 45; [source](https://www.knitpicks.com/yarn/brava-sport-yarn/c/5420218), accessed 2026-01-14):
White `#f7f6fb` · Cream `#e6ceb3` · Dove Heather `#cdccd1` · Silver `#979a9b` · Umber Heather `#493830` · Black `#2a272b` · Almond `#c3a790` · Fig `#a29767` · Brindle `#805436` · Sienna `#543228` · Red `#c54545` · Wine `#632734` · Orange `#e08257` · Seashell `#e49d8b` · Canary `#efc165` · Caution `#e7a450` · Alfalfa `#caddab` · Grass `#528e59` · Hunter `#213f3b` · Tidepool `#497681` · Cornflower `#83c3cb` · Sky `#99beda` · Denim `#6989a7` · Solstice Heather `#162d59` · Lady Slipper `#bb7eaf` · Mulberry `#5d3966` · Cotton Candy `#e9c4ce` · Rouge `#d95e7c`

**Also in the snapshot:** Caron One Pound (54), Bernat Super Value (50), Hobby Lobby I Love This Yarn (70) and Loops & Threads Impeccable (75).

**[I] Build-time import** (dev only; the shipped JSON carries the CC BY credit line). Before shipping, confirm the data license with the maintainer, or pull the same data through the CC BY API.

```ts
const SHA = 'd22f7d9eb0cdf32aad9595931f01a33333b8d95a';
const LINES = ['red-heart/super-saver-solids','lion-brand/basic-stitch-anti-pilling','lion-brand/vannas-choice',
  'lion-brand/pound-of-love','paintbox-yarns/simply-dk','stylecraft/special-dk','bernat/softee-baby','bernat/softee-cotton',
  'bernat/blanket','caron/simply-soft-solids','caron/one-pound','bernat/super-value','knit-picks/brava-worsted','knit-picks/brava-sport'];
for (const p of LINES) {
  const ts = await (await fetch(`https://raw.githubusercontent.com/jdvlpr/Temperature-Blanket-Web-App/${SHA}/src/lib/data/yarns/${p}/colorways.ts`)).text();
  const colors = [...ts.matchAll(/\{([^{}]*hex:[^{}]*)\}/g)].map(m => ({   // field order varies: parse per object
    hex: /hex:\s*'(#[0-9a-fA-F]{6})'/.exec(m[1])![1].toLowerCase(),
    name: /name:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]*)")/.exec(m[1])!.slice(1).find(Boolean)!.replace(/\\'/g, "'"),
  }));
  // + source href/accessed, weightId from yarn.ts; attribution string per CC BY 4.0
}
```

### 7.4 Matching algorithms [I, with PAM V]

1. **Free palette, then snap.** Map each center to its nearest yarn by ΔE00.
   - If two centers snap to the same yarn, either merge them (default when ΔE00 between the centers is under 8), or solve an injective assignment with the Hungarian algorithm on ΔE00 to keep the contrast.
2. **Choose directly from a yarn line** (recommended when a line is selected). Treat it as p-median selection over a fixed candidate set:
   - **BUILD:** greedily add the yarn that most reduces `Σ_pixels w·ΔEOKr2(pixel, nearest chosen yarn)`.
   - **SWAP:** try chosen↔unchosen swaps until nothing improves.
   - **[V]** This is PAM's BUILD/SWAP (Kaufman & Rousseeuw 1990) with the candidates restricted to yarns ([Wikipedia: k-medoids](https://en.wikipedia.org/wiki/K-medoids)).
   - Cost: 125 candidates × ~5k histogram bins × K is trivial.
3. **Heathers, marls and flecks** ("Gray Heather", "Aran Fleck", "Baby Pink Marl") are matched on their mean color, flagged "reads textured", and kept away from protected detail labels.
4. **Display.** Show the matched ΔE00 for each color. Above 10, show "approximate".

---

## 8. Pattern capture in 2D: runs, repeats, stripes, symmetry

### 8.1 Run-length encoding in working order

- **[V] Notation.** CYC symbols: `*` "repeat the instructions following the single asterisk as directed"; `[ ]` and `( )` "work instructions within … as many times as directed"; MC/CC for main and contrasting color ([CYC](https://www.craftyarncouncil.com/standards/crochet-abbreviations)).
- **[V] Precedent.** Stitch Fiddle writes rows as "4 stitches in Color A, 7 stitches in Color B, 3 stitches in Color A" ([Willow Crochet](https://www.willowcrochet.com/stitch-fiddle-features-for-crochet-colorwork/)).
- **[I] Our output format:**

  `Row 12 (RS, ←): 4 A, *2 B, 3 A; rep from * 5 more times, 1 B, 4 A. (36 sts; carry B)`

### 8.2 Repeats in 1-D (within a row) [V algorithm + I use]

- **Exact token repeats.** The prefix-function period: `k = n − π[n−1]`. If k divides n, the token string is k-periodic. It runs in O(n) ([cp-algorithms](https://cp-algorithms.com/string/prefix-function.html)).
- **Partial repeats.** For each period `p ≤ n/2` and start `s`, extend `m` while `tokens[s+t] == tokens[s+t+p]`. Choose the `(s, p, m)` with the greatest saving `(m−1)·p` tokens. Repeat recursively on the prefix and suffix. Rows have at most about 100 tokens, so O(n²) is fine.

### 8.3 Repeats in 2-D (motifs, all-over patterns) [V theory + I algorithm + M test]

- **[V] Theory.** Periodic patterns form lattices: 7 frieze groups for patterns that repeat in one direction and 17 wallpaper groups for patterns that repeat in two. Liu, Collins & Tsin recover the lattice with a peak-detection method based on "regions of dominance" and classify the pattern into a group ([TPAMI 2004](https://dl.acm.org/doi/10.1109/TPAMI.2004.1262332)) (unverified).
- **[I] Categorical autocorrelation.** On a label grid, the match count at shift `d` is `Σ_c (I_c ⋆ I_c)(d)`, where `I_c` is the 0/1 indicator of label c. Divide by the overlap to get `match(d)`.
  - Compute it with FFTs per label (O(K·N log N)), or directly for 1-D shifts.
  - Period `p_x` = the smallest `dx` with `match(0, dx) ≥ 0.92`. Find `p_y` the same way.
  - Confirm the 2-D lattice with `match(p_y, p_x)`.
- **[I] Consensus regularization.** For each tile position `(i, j)`, set every cell `(i + a·p_y, j + b·p_x)` to the mode of those cells, skipping protected cells. Repeats become exact, so `rep from *` is truthful.
  - Apply automatically when match ≥ 0.95; between 0.92 and 0.95, ask the user.
- **[M] Test.** A 6×8 motif tiled into 40×45 with 3% random noise: the detector found period (6, 8) with match 0.967; the half period scored 0.248. Regularization restored the clean chart with **0** residual errors.
- **[I] Vertical repeats.** Hash each row's label vector. Find the repeated block of maximal length L with at least 2 occurrences, and emit `Rows 13–24: rep Rows 1–12`.

### 8.4 Stripes and spots [I]

- **Horizontal stripes.** Row dominance is `d_r = max_c share`. If `d_r ≥ 0.85` for at least 70% of rows, use stripe mode:
  1. Snap those rows to their dominant label.
  2. Run-length encode the stripe sequence.
  3. Apply the 1-D period finder to the row-label sequence (`Rows 1–4 A, 5–6 B; rep ×5`).
- **Vertical and diagonal stripes.** A high `match(0, p)` alone means vertical stripes; a high `match(1, 1)` or `match(1, −1)` means diagonal stripes. Emit column-repeat tokens.
- **Spots.** Connected components of a minority label that are compact (area / bounding-box area ≥ 0.6), similar in size (coefficient of variation ≤ 0.3), and at least 3 in number. Tag them as a "spot motif". The 3D stage may emit them as appliqué (§9.8).

### 8.5 Symmetry [I]

- Mirror agreement: `A(axis) = mean[L(y, x) == L(y, 2·axis − x)]` over valid columns. Scan axes at half-cell steps.
- If the best `A ≥ 0.92`, report "symmetric about col X" and offer symmetrization: replace each mirrored pair with its mode, with ties going to the original. This removes noise from faces and logos.
- In 3D, bilateral symmetry of the shape plus `A ≥ 0.92` on the colors lets us say "Make 2 (mirror)" for ears, arms and legs.

---

## 9. 3D: mapping image colors onto amigurumi stitches

### 9.1 Inputs and color spaces

- **[V] glTF/GLB (relevant to Claude Design import, R6).**
  - `COLOR_n` is an "RGB or RGBA vertex color linear multiplier".
  - The first three channels of `baseColorTexture` "MUST be encoded with the sRGB transfer function".
  - Factors are linear multipliers ([glTF 2.0 spec](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)).
- **[I] Albedo** = `decode_sRGB(texel) × baseColorFactor × COLOR_0`, computed in linear light, then converted to OKLab.
- **[I] Three source kinds:**
  - A textured or vertex-colored mesh (Claude Design or a reconstruction). Usually albedo-like.
  - Multi-view photos with estimated cameras (R2). Shaded.
  - A single photo with depth (R3). Shaded, and the back is unseen.

### 9.2 Per-stitch voting [I, grounded in V]

**[V] Background from Waechter et al.**
- They select views with a data term equal to the gradient magnitude integrated over the face's projection. It is large for "close, orthogonal images with a high resolution" and for in-focus images.
- Their smoothness term is a Potts model.
- The photo-consistency check assumes "the majority of views see the correct color" ([Waechter, Moehrle, Goesele, ECCV 2014](https://download.hrz.tu-darmstadt.de/pub/FB20/GCC/paper/Waechter-2014-LTB.pdf)).
- Graph-cut α-expansion solves multi-label Potts energies within a known factor of the optimum (factor 2 for Potts; unverified against the paper) ([Boykov, Veksler, Zabih, TPAMI 2001](https://www.cs.cornell.edu/rdz/Papers/BVZ-pami01-final.pdf)).

**[V] Tooling.** `three-mesh-bvh` (MIT) accelerates raycasts and closest-point queries: "500 rays against an 80,000 polygon model at 60fps" ([repo](https://github.com/gkjohnson/three-mesh-bvh)).

**[I] Voting procedure.**
1. **Joint palette first.** Quantize together the pixels from every source that fall in the object mask. Every view then uses the same labels, so votes are comparable.
2. **Votes per stitch.** Each stitch `s` has round `r`, index `i`, center `p`, normal `n`, area `A`, and neighbors.

```ts
for (const s of stitches) {
  const votes = new Float32Array(K);
  for (const v of views) {
    for (const q of samplePatch(s, 7)) {                 // center + 6 on a 0.35·width disc, projected to surface
      const cos = dot(q.normal, dirTo(v.camera, q.pos));
      if (cos < 0.2 || !visible(q.pos, v, 0.5 * s.height)) continue;   // BVH raycast; eps = half stitch height
      const w = cos * cos * v.pixelsPerStitch(s) * v.maskConfidence(q);
      votes[nearestLabel(feature(v.colorAt(q.pos)))] += w;
    }
  }
  s.share = normalize(votes);                              // empty -> unseen
  s.label = argmax(s.share); s.confident = max(s.share) >= 0.5;
}
```

3. **Unseen and low-confidence stitches.** Use one of:
   - the symmetric counterpart's share, when the user confirms "back looks like front";
   - the part's dominant label, from the 3D editor's part segmentation;
   - Jacobi diffusion of share vectors over the stitch graph for 20 iterations.

   The editor's paint and protect brushes override all of these (R7).

### 9.3 Spots, motifs, and details on the stitch graph [I]

- Connected components per label, on the stitch adjacency graph (same round, plus parent/child links).
- **Around-the-round motifs.** For a round of `n` stitches, the smallest divisor `p` of `n` with `(1/n)·Σ[L_i == L_{(i+p) mod n}] ≥ 0.9` gives `n/p` repeats: `*(3 sc A, 2 sc B); rep from * 6 times`.
  - In the common 6-increase circle (6, 12, 18 … stitches), 2-, 3- and 6-fold motifs stay aligned across rounds. When the 3D stage uses that increase scheme and the match is close, snap detected motif counts to divisors of 6. Other starts (e.g. 8-sc rings, or AmiGo's geometry-driven rounds, which start from a single seed vertex) need the general divisor search. *(Corrected: this previously said "AmiGo's 8-sc ring". The AmiGo paper's first row "contains only the seed", and we found no 8-sc ring in it.)*

### 9.4 Shading robustness [M]

- **Feature.** For photo sources use `f = (wL·L, a/max(L, 0.25), b/max(L, 0.25))` with `wL = 0.35`. It follows from the scale law in §1.2.
- **[M] Test.** A synthetic shaded red sphere with black spots, K=3, 60×60:

| Features | Overall label accuracy | Red-body stitches mislabeled |
|---|---|---|
| Plain ΔEOKr2 features | 91.7% | 21.0% (shadows went to "black") |
| Shading-robust features | **96.7%** | **4.6%** |

- **[I] Limits.** Specular highlights and colored light break the scale law. Clip the top 2% of L before clustering, and consider a gray-world or user-picked white balance per photo. Textures from GLB files use plain features.
- **[V] Alternative.** The CIE94 textile setting kL=2 down-weights lightness ([Wikipedia](https://en.wikipedia.org/wiki/Color_difference)). **[M]** In our test, halving the L weight in plain features did not stop the shadow split at K=4. The ratio features did not stop it either: when K is larger than the true number of colors, any quantizer has to split something. The ratio features help at the right K (3 here), where shadows stop being absorbed into the black cluster. So auto-K (§2.4) and a "merge colors" tool are still needed.

### 9.5 Per-round smoothing: circular Potts DP [I + M]

- **Problem.** Minimize `Σ_i (1 − share_i[k_i]) + λ·#changes` on a circular sequence.
- **Method.** For each fixed first label `k0`, run a linear Viterbi pass and add `λ·[k_last ≠ k0]`. Keep the best result. Cost is O(K²·n).
- **Minimum run.** Extend the states with run length, as in §6.3, using `r_min` = 2.
- **Size rule.** A patch of m stitches with per-stitch margin δ survives only when `m·δ > 2λ`. So `λ ≈ δ·m_min/2`.
- **Vertical coherence.** After the per-round pass, do 2 ICM sweeps that add `μ = 0.2·[label ≠ parent's label]`.
- **[M] Monte Carlo test.** 200 trials; 36-stitch round; K = 3; truth has a 6-stitch patch and a 3-stitch patch. Each stitch's vote shares are 0.8 for the true label and 0.1 for the others, plus N(0, 0.3) noise; they are then clipped at 0 and renormalized. Unary cost = 1 − share.
  - Fact-check rerun (2,000 trials, independent seed): argmax 3.14 errors / 8.86 changes; λ=0.3 0.82 / 4.38; λ=0.4 0.76 / 4.13; λ=0.6 0.98 / 3.72; λ=1.0 2.53 / 2.60; λ=2.0 7.50 / 0.52. These agree with the table within Monte Carlo noise. The saved prototype `exp5.py` is a single-trial σ = 0.18 variant, so the 200-trial script itself was not archived. Rows that clip to all zeros give NaN shares, so guard that division.

| Method | Mean errors (of 36) | Mean color changes (truth: 4) |
|---|---|---|
| argmax | 3.04 | 8.71 |
| λ = 0.3 | **0.96** | 4.36 |
| λ = 0.6 | 1.05 | **3.70** |
| λ = 1.0 | 2.41 | 2.71 (starts deleting the 3-stitch patch) |
| λ = 2.0 | 7.70 | 0.45 |

**[I] Default λ = 0.4.**

### 9.6 Stripe snapping to whole rounds [I]

```ts
for (const r of rounds) {                       // solid rounds
  const [k, sh] = dominant(r);
  if (sh >= 0.85) r.fill(k), r.solid = true;
}
for (const b of boundariesBetween(A, B)) {      // near-horizontal boundaries
  const h = azimuthBins(24).map(theta => firstRoundWhere(theta, B));   // undefined if none
  const ok = defined(h) >= 0.8 * 24 && std(h) <= 0.5 && maxAbsDev(h, median(h)) <= 1;
  if (ok) assignBand(A, B, median(h));          // rounds < m -> A, >= m -> B, within the band
  // else: keep as colorwork (diagonal sash, spiral, tilted boundary)
}
```

"Horizontal" means relative to the piece's own axis, because rounds follow the piece.

### 9.7 Color-change technique selection [V rules + I placement]

- **[V] PlanetJune's rules** ([color changes](https://www.planetjune.com/blog/amigurumi-help/how-to-change-colour-in-amigurumi/), [stripe comparison](https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/), [Ultimate Stripes](https://www.planetjune.com/blog/amigurumi-help/ultimate-stripes-for-amigurumi/)):
  - "Always pull through the last loop of the stitch before the colour change with the new colour."
  - Strand for brief switches of 1–2 stitches.
  - Tapestry crochet is **not recommended** for amigurumi: it distorts patterns, dark yarn shows through, and the shape changes.
  - Never strand dark yarn behind light yarn.
  - Spirals leave a "jog" where stripes meet. Travelling joins shift the seam one stitch per round. Invisible Join and No-Cut Join give the cleanest stripes.
  - Ultimate Stripes requires cutting "at the end of **every** round", and a round cannot start with an increase or decrease.
  - When moving back to spirals, start the round "on [the less visible] side".
- **[V] A cheaper fix for single-crochet spirals.** Pull the new color through the last 2 loops of the old round's last stitch, then work a slip stitch instead of the first sc of the new round. It reduces the jog without removing it ([Crochet Arcade](https://www.crochetarcade.co.uk/jogless-stripes-color-change-for-single-crochet-worked-in-a-spiral/)).
- **[I] Generator policy.**
  - Pieces with snapped stripes are written in **joined rounds** for the striped section (invisible join), or with the jogless slip-stitch trick if the user picks "spiral".
  - The round start (seam) goes at the azimuth facing away from the main photo or front view.
  - Mixed rounds with runs of 2 stitches or fewer strand the inactive yarn inside the piece, unless the inactive yarn is darker than the stitches it would sit behind (ΔL > 0.15). Then cut-and-tie is used.

### 9.8 Tiny details are not colorwork [V + I]

- **[V] Common practice.** Embroidered eyes are the safer option for young children, because safety-eye backs "are not always very secure" ([CB Fiberworks](https://cbfiberworks.com/everything-you-need-to-know-about-amigurumi-eyes/)). Surface crochet adds details "with no need for sewing" ([Pocket Yarnlings](https://www.pocketyarnlings.com/blog/using-surface-crochet-to-do-amigurumi-detailing)).
- **[I] Rule.** A component under 6 stitches, or under 2 rounds tall and 3 stitches wide, or any third color in a round, leaves the colorwork.
  - It becomes an instruction such as "eyes: embroider / safety eyes at Rnd 12, sts 9 and 16", "spots: make 5 appliqué circles", or "mouth: surface slip stitch".
  - The stitch grid then uses the surrounding label.

### 9.9 Prior art gap [V]

AmiGo's conclusion says: "we plan to add colors and texture" ([AmiGo, arXiv 2211.01178](https://arxiv.org/abs/2211.01178)). It colors segments only to visualize them. Martinez & Lipnicki's surfaces-of-revolution generator never mentions color ([arXiv 2302.02205](https://arxiv.org/abs/2302.02205)). Our search was limited, but we found no academic method for per-stitch amigurumi colorwork, so §9 is our own design.

---

## 10. Failure modes and edge cases

| Symptom | Cause | Mitigation |
|---|---|---|
| Extra "dark red" or "light red" colors on 3D photos | shading and highlights | Ratio features (§9.4), clip highlights, white balance, user "merge colors" |
| Muddy edge colors become clusters | gamma averaging, LANCZOS ringing, JPEG halos | Linear-light box filter; flat mode quantizes at source and mode-pools |
| Outline or whisker disappears | mode pooling, confetti pass, narrow-strip pass | Thin-feature detection, protect mask, outline closing |
| Eyes or nose dropped from the palette | K selection by SSE | Salience rule (≥ 2 cells, ΔE00 ≥ 20) |
| Two clusters become the same yarn | coarse line spacing (median ΔE00 6–10) | Merge, or Hungarian assignment |
| Real yarn looks different from the screen | photo-sampled hex, dye lots; sources differ by ΔE00 3.7 median | "Approximate" badge, calibration from a skein photo, show ΔE |
| Checkerboard or speckle | dithering | Off by default; row fade or run-constrained options |
| Pixel art blurred or stretched | resampling non-integer grids | Native-grid detection; integer multiples only |
| Background leaks into the subject | similar colors, weak edges | Edge barrier, tolerance 0.05, user confirmation, GrabCut |
| Fake "repeats" forced onto a non-periodic image | low threshold | Threshold 0.92, auto-apply only at ≥ 0.95, otherwise ask |
| Visible jog on striped amigurumi | spiral rounds | Joined rounds or slip-stitch trick, seam at the back |
| Dark yarn shows through light stitches | stranding or tapestry | Cut-and-tie rule (ΔL > 0.15), PlanetJune warning in the pattern |
| Run-to-run differences | `Math.random`, unstable sorts | Seeded PRNG, stable sorts, ties to lowest index, golden-output tests |
| Views disagree on color | auto white balance, lighting | Joint palette, per-view gain normalization (Waechter global adjustment), majority vote |

---

## 11. Implementation notes for our stack [I]

**Modules.** All are pure TypeScript and run in a Web Worker on typed arrays:
- `color/` — sRGB ↔ linear ↔ OKLab, toe, ΔE00
- `quantize/` — variance split and Lloyd
- `grid/` — box, mode and pixel-art sampling
- `cleanup/` — protect, confetti, components, Potts
- `yarn/` — palettes, matching, PAM, calibration
- `capture/` — RLE, periods, symmetry
- `color3d/` — votes, diffusion, circular Potts, stripes, details

**Libraries and licenses** (checked on npm):

| Library | Version | License | Use |
|---|---|---|---|
| `culori` | 4.0.2 | MIT | conversions, `differenceCiede2000` |
| `three-mesh-bvh` | 0.9.15 | MIT | visibility raycasts |
| `image-q` | 4.0.0 | MIT | optional: kernels and distance formulas to borrow |
| `@material/material-color-utilities` | 0.4.0 | Apache-2.0 | port its Wu code, but not its random k-means init |
| OpenCV.js | — | Apache-2.0 | GrabCut, optional and lazily loaded |
| libimagequant | — | GPL / commercial | **avoid** |
| `@imgly/background-removal` | — | AGPL | **avoid** |
| RMBG-1.4 | — | non-commercial | **avoid** |

**Determinism contract.** `hash(output) = f(imageBytes, params, codeVersion)`. Golden tests check the label grid hash, palette hex values and stitch counts.

**Performance budget.** A 200×200 grid with K ≤ 16 should take < 150 ms for quantize plus cleanup in a worker. 3D: about 10k stitches × 7 samples × 6 views ≈ 420k BVH raycasts, which should take < 1 s.

**Exports to other stages:**
- Per label: `worked`, `carried` and `strands` counts (for yardage, see the gauge doc), yarn ID, ΔE00 to source, and protected flags.
- Per row or round: an RLE token list with detected repeats.
- For 3D: a detail list (embroidery or appliqué) and the stripe table.

---

## 12. Test plan

**Golden images [I]:**
1. A flat logo with 2 px outlines, as JPEG at quality 70.
2. A 32×32 sprite upscaled 8× with JPEG noise.
3. A portrait photo.
4. A photo of a striped mug.
5. A tiled motif with 3% noise.
6. A shaded ladybug render (§9.4).
7. A GLB with a baseColor texture and vertex colors.

**Assertions:**
- Determinism: bit-identical output over 10 runs.
- Confetti ≤ 2% (graph/C2C) and ≤ 1% (tapestry).
- The thin outline is ≥ 95% connected after cleanup.
- Pixel art reproduced 1:1.
- Motif period found and repeats written as `rep from *`.
- 3D: on the ladybug, red-body mislabels ≤ 6% and every snapped stripe is round-aligned.
- Yarn match ΔE00 is reported for every color.
- The CIEDE2000 implementation passes all 34 Sharma pairs within 1e-4 ([test data](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)).

---

## 13. Sources (primary first)

- **Color science**
  - CSS Color Module Level 4: conversions, ΔE2000, ΔEOK, ΔEOK2, ΔEOKr2, JND. https://www.w3.org/TR/css-color-4/ and https://drafts.csswg.org/css-color-4/conversions.js
  - Ottosson, "A perceptual color space for image processing" (2020). https://bottosson.github.io/posts/oklab/
  - Sharma, Wu & Dalal, CIEDE2000 implementation notes and test data (CR&A 30(1), 2005). https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
  - Wikipedia: Color difference. https://en.wikipedia.org/wiki/Color_difference
- **Quantization**
  - Arthur & Vassilvitskii, k-means++ (SODA 2007). https://theory.stanford.edu/~sergei/papers/kMeansPP-soda.pdf
  - Celebi, "Improving the performance of k-means for color quantization" (2011). https://ar5iv.arxiv.org/html/1101.0395
  - Wikipedia: Color quantization, Median cut, Octree. https://en.wikipedia.org/wiki/Color_quantization · https://en.wikipedia.org/wiki/Median_cut · https://en.wikipedia.org/wiki/Octree
  - WPI reference list (Heckbert 1982; Gervautz & Purgathofer; Wu 1991). https://web.cs.wpi.edu/~matt/courses/cs563/talks/color_quant/CQref.html
  - pngquant and libimagequant. https://pngquant.org/ · https://pngquant.org/lib/
  - image-q. https://github.com/ibezkrovnyi/image-quantization
  - Material Color Utilities (Wu and WSMeans source). https://github.com/material-foundation/material-color-utilities
- **Dithering**
  - Wikipedia: Floyd–Steinberg dithering; Ordered dithering. https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering · https://en.wikipedia.org/wiki/Ordered_dithering
- **Crochet tools**
  - crochetpatterngen engine source (MIT). https://github.com/dengyu123456/crochet-engine
  - Stitchmate pages. https://stitchmate.app/photo-to-crochet-pattern · https://stitchmate.app/tools/red-heart-super-saver-color-chart · https://stitchmate.app/handbook/palette-tools · https://stitchmate.app/handbook/image-import · https://stitchmate.app/guides/what-is-confetti-cross-stitch · https://stitchmate.app/photo-to-cross-stitch
  - ArtPatt. https://artpatt.com/graphghan-pattern-generator · https://artpatt.com/tapestry-crochet-pattern-generator
  - Stitch Fiddle. https://www.stitchfiddle.com/en/help/1pej-wc93j/import-picture · https://www.stitchfiddle.com/en/chart/create/crochet/colors · https://www.willowcrochet.com/stitch-fiddle-features-for-crochet-colorwork/
  - knitPro FAQ. https://www.microrevolt.org/FAQ.htm
  - Paint-by-numbers generator (MIT). https://github.com/drake7707/paintbynumbersgenerator
- **Pixel-art grid detection**
  - https://github.com/duniul/pixel-scale · https://github.com/KennethJAllen/proper-pixel-art · https://github.com/Mashiro0619/perfectPixel
- **Background removal**
  - OpenCV.js GrabCut tutorial source. https://github.com/opencv/opencv/blob/4.x/doc/js_tutorials/js_imgproc/js_grabcut/js_grabcut.markdown
  - imgly. https://github.com/imgly/background-removal-js
  - RMBG-1.4. https://huggingface.co/briaai/RMBG-1.4
  - Browser model write-up. https://leecy.me/four-models-to-remove-one-background-a-browser-ml-war-story/
- **Yarn data**
  - temperature-blanket.com API terms and repository. https://temperature-blanket.com/api/yarn-colorways · https://github.com/jdvlpr/Temperature-Blanket-Web-App
  - craft-color-codes. https://github.com/makebead/craft-color-codes
  - alpha-pattern-editor PR #15. https://github.com/matejmojemeno/alpha-pattern-editor/pull/15
  - LoveCrafts Paintbox Simply Aran. https://www.lovecrafts.com/en-us/p/paintbox-yarns-simply-aran
- **Crochet technique**
  - Craft Yarn Council abbreviations. https://www.craftyarncouncil.com/standards/crochet-abbreviations
  - Carol Ventura. https://www.carolventura.com/rightstitches.html
  - Kari's Crafts. https://www.kariscraftsonline.com/2015/10/crochet-graphghans-how-to-change-color.html
  - Simply Yarn (chart reading). https://simply-yarn.com/guides/how-to-crochet/how-to-read-crochet-charts
  - PlanetJune. https://www.planetjune.com/blog/amigurumi-help/how-to-change-colour-in-amigurumi/ · https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/ · https://www.planetjune.com/blog/amigurumi-help/ultimate-stripes-for-amigurumi/
  - Crochet Arcade. https://www.crochetarcade.co.uk/jogless-stripes-color-change-for-single-crochet-worked-in-a-spiral/
  - CB Fiberworks (eyes). https://cbfiberworks.com/everything-you-need-to-know-about-amigurumi-eyes/
  - Pocket Yarnlings (surface crochet). https://www.pocketyarnlings.com/blog/using-surface-crochet-to-do-amigurumi-detailing
- **Pattern capture and 3D**
  - cp-algorithms, prefix function. https://cp-algorithms.com/string/prefix-function.html
  - Liu, Collins & Tsin (TPAMI 2004). https://dl.acm.org/doi/10.1109/TPAMI.2004.1262332
  - Wikipedia: k-medoids. https://en.wikipedia.org/wiki/K-medoids
  - Kneedle (ICDCSW 2011). https://www.researchgate.net/publication/224249192
  - Waechter et al., ECCV 2014. https://download.hrz.tu-darmstadt.de/pub/FB20/GCC/paper/Waechter-2014-LTB.pdf
  - Boykov, Veksler & Zabih, TPAMI 2001. https://www.cs.cornell.edu/rdz/Papers/BVZ-pami01-final.pdf
  - three-mesh-bvh. https://github.com/gkjohnson/three-mesh-bvh
  - glTF 2.0 specification. https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
  - AmiGo. https://arxiv.org/abs/2211.01178
  - Martinez & Lipnicki, surfaces-of-revolution crochet patterns. https://arxiv.org/abs/2302.02205
  - culori API. https://culorijs.org/api/
  - scikit-image rank filters. https://scikit-image.org/docs/stable/api/skimage.filters.rank.html
  - Survey on web image retrieval (photo vs graphics features). https://twiki.di.uniroma1.it/pub/Estrinfo/Materiale/web_image_retrieval.pdf

---

## Verification notes

Adversarial fact-check, 2026-09-30. Sources were re-fetched directly (curl or raw GitHub), and every measured number was recomputed where we had the data. Our own CIEDE2000 implementation, written for this check, matched Sharma test pairs to 4 decimals.

**Confirmed against the source**
1. CSS Color 4 confirmed: ΔEOK2 (a and b ×2, §20.4) and ΔEOKr2 (toe K1=0.206, K2=0.03, §20.5). Quotes confirmed: "agrees significantly better with ΔE2000" and "performance-sensitive … encouraged to use ΔEOKr2". The gamut-mapping pseudocode has "let JND be 0.02" (§14.2.1). The ΔE2000 "one JND is 2" note sits in §14, not §20.2 (fixed in §1.3).
2. Celebi (ar5iv 1101.0395) confirmed: "WSM-WU is the best method"; ε=0.001 on (SSE_{i−1}−SSE_i)/SSE_i; "12–20 times faster than KM"; MSE improvement of 18–50%; 2:1 subsampling. There are 14 WSM variants: 7 generic initializers plus 7 preclustering methods.
3. Material Color Utilities confirmed (`quantizer_wsmeans.ts`, `quantizer_wu.ts`, `lab_point_provider.ts`, `quantizer_celebi.ts` on main): MAX_ITERATIONS=10, MIN_MOVEMENT_DISTANCE=3.0, `Math.random()` initial assignment, Wu INDEX_BITS=5, and Lab squared Euclidean distance. The nondeterminism is real because points move only when the gain exceeds 3.0.
4. ArtPatt confirmed: the dithering FAQ quote is verbatim; "Heavy mode targets under 3% confetti"; 12 cm per worked stitch + ~3 cm per carried stitch + 15% buffer; 14 sts × 16 rows per 10 cm; colors per project type; the "too thick" wording. The graphghan page's 8–12, 6–10, 15–20 colors, "majority-vote filter", "simulate the gradient" and bobbin quote are also confirmed.
5. crochet-engine confirmed (cloned, MIT): `Image.Resampling.LANCZOS`; `quantize(method=MEDIANCUT, dither=Dither.NONE)`; 4-neighbor rule with `len(neighbors) >= 3`; `max_passes=3`; C2C `cell_yx_ratio` 0.7; rembg default `u2net`; warning when the share of pixels with luminance < 245 is under 15%.
6. Stitchmate confirmed: "No yarn manufacturer publishes sRGB"; 2.6 L* / 4.8 chroma ("across all three yarn palettes"); "do not buy yarn from them"; CIEDE2000 on the palette-tools handbook page; 72/46/60 palettes; "no resampling" 40×40; ~79% confetti claim; FLOW components; confetti tiers.
7. temperature-blanket.com API terms confirmed: CC BY 4.0 DEED; the example attribution string is verbatim; "approximations of fiber colors"; RapidAPI key; free plan 500 calls/month. The repository is GPL-3.0 and commit `d22f7d9` exists (2026-09-24). All 297 hex values in the §7.3 tables match that commit by name (the source spells it "Vanila Twist"). Red Heart numbers match Stitchmate, Paintbox Aran numbers match LoveCrafts, and the access dates and source links match the `colorways.ts` files.
8. Claim 10 reproduced exactly with D65 Lab: median 3.7, p90 8.9, max 13.5 (Light Periwinkle), 20 > 5, 4 > 10, 61 matched shades. Line spacing ran from 6.0 (Bernat Blanket) to 10.7 (Pound of Love), with RHSS 6.6 and Stylecraft 6.9. Hunter/Paddy Green 1.0 and Pomegranate/Bright Pink 0.7 are confirmed.
9. Claim 2 reproduced on the corrected 933-color set (see §1.3): Spearman 0.798 / 0.664 / 0.776 and 0.698 / 0.577 / 0.705; nearest-neighbor agreement 70.6 / 55.7 / 73.1%; median ratio 0.0100.
10. OKLab scale law: it holds algebraically, since cbrt(s·x) = cbrt(s)·cbrt(x) and M2 is linear. The prototype gives a maximum error of 6.6e-16. The sphere test re-ran to 91.7% → 96.7% accuracy and 21.0% → 4.6% red mislabels. Ottosson's code is public domain, with an MIT option.
11. Floyd–Steinberg numbers re-ran from the prototype exactly. The ratios are 2.25× and 3.5× (confetti) and 1.48× and 1.94× (changes per row). Cleanup cuts changes per row by 39% (3.3 → 2.0) and 23% (4.7 → 3.6). The gamma-averaging numbers (3.3 → 4.0, 47 → 58) are confirmed.
12. Gamma math checked by hand: linear 0.5 encodes to sRGB 0.7354, i.e. 187.5. sRGB 127.5 decodes to linear 0.214.
13. PlanetJune confirmed (all three pages): the "last loop" rule; stranding "for one or two stitches"; tapestry not recommended (colors skew, carried yarn shows through, shape changes); the jog; travelling joins move one stitch per round; Invisible Join and No-Cut Join; Ultimate Stripes "cut the yarn at the end of every round" and no inc/dec on the first stitch; the "less visible" side.
14. glTF 2.0 confirmed: COLOR_n is an "RGB or RGBA vertex color linear multiplier", and baseColorTexture RGB "MUST be encoded with the sRGB transfer function".
15. AmiGo confirmed: "we plan to add colors and texture". Martinez & Lipnicki (2302.02205) abstract page: no mention of color.
16. Other checks: CIE94 textile constants and the ΔE76 JND of 2.3 (Wikipedia); the Floyd–Steinberg "linearized first" quote; Bayer M₄ (the standard matrix); pngquant quotes and libimagequant GPL v3+ or commercial; knitPro "millions of colors" and 5:7; Stitch Fiddle 50/200 colors, 300×300 / 1,000×1,000 grids, and palette counts (64/120/41/49/43); CYC `*`, `[ ]`, `( )` and MC; Carol Ventura, Kari's Crafts, Simply Yarn, Crochet Arcade, CB Fiberworks and Pocket Yarnlings quotes; paint-by-numbers settings (16 clusters, facets < 20, 3 strip runs, `randomSeed = new Date().getTime()`, MIT); three-mesh-bvh "500 rays … 80,000 polygon … 60fps"; RMBG-1.4 non-commercial; the leecy.me BiRefNet/ormbg account; craft-color-codes (RHSS 44, CC BY 4.0 data, CIEDE2000 ranking); Willow Crochet quote; Waechter quotes; Wu, *Graphics Gems II* pp. 126–133 (Crossref); npm versions and licenses (culori 4.0.2 MIT, three-mesh-bvh 0.9.15 MIT, image-q 4.0.0 MIT, @material/material-color-utilities 0.4.0 Apache-2.0).

**Changed**
- §1.3 CIEDE2000 row: JND note section attribution (§20.2 → §14).
- §1.3 agreement table: the yarn set behind "933 colors" (Paintbox Cotton Aran, not Bernat Softee Cotton), and the D65 Lab note.
- §2.1: Heckbert pages 297–303 → 297–307.
- §2.2 MCU row: why the random initial assignment persists.
- §3: the dither-then-cleanup comparison (no-dither baseline 2.0 / 3.6 → 2.6 / 3.9 for the same stages).
- §7.1: Stitchmate quote context added.
- §7.2: D50 vs D65 sensitivity added.
- §9.3: "AmiGo's 8-sc ring" removed (not in the paper).
- §9.5: noise model specified, and an independent 2,000-trial rerun added.

**Remaining doubts**
- Marked "(unverified)" inline: the pixel-art repository licenses; alpha-pattern-editor PR #15; imgly AGPL; the Liu/Collins/Tsin method details; the Boykov approximation factor. Also not re-checked: the Kneedle reference, the culori `differenceCiede2000(Kl, Kc, Kh)` signature, the OpenCV.js grabCut signature, the PicToSeek survey wording, and the k-means++ bound (it matches the paper as commonly cited).
- The [M] prototype results (§3, §6.4, §9.4) were re-run from the author's own scripts, not rebuilt independently. They show the numbers are reported faithfully, not that they generalize. All are single synthetic images.
- The Potts Monte Carlo varies by about ±0.3 errors between seeds at 200 trials, so "≈ 3× fewer errors" is a rough figure (2.4–3.8× across our runs).
- The Stitchmate "79% less confetti" figure is a vendor claim with no published method.
