# 03 — 3D / Amigurumi Pattern Generation: Algorithms, Tools, and a Recommended Two-Path Design

Research report for **Crochet Pattern Generator** (Vite + React + TypeScript + three.js, fully client-side).
Covers requirements R2 (multi-view → 3D → pattern), R3 (single image → 3D → pattern), R4 (3D size math), R7 (3D adjustment editor) and R8 (colors on 3D patterns). Compiled 2026-09-30.

**How to read the tags**

- **[V] VERIFIED.** Read in the cited primary source: a paper PDF, source code, a tool's own output, or official docs. The URL is inline.
- **[I] INFERENCE.** Our own derivation, curve fit, prototype output or design recommendation.
- Numeric examples tagged [I] were computed with a throwaway Python prototype kept outside the repo. They were checked by the validators in §6.7 but **none has been physically crocheted yet.**

---

## 0. Executive summary

1. [V] **AmiGo** (Edelstein, Peleg, Itzhaky, Ben-Chen, SCF 2022) is the reference algorithm for turning a mesh into amigurumi ([arXiv 2211.01178](https://arxiv.org/abs/2211.01178)):
   - Compute geodesic distance from one user-chosen seed.
   - Rows are isolines spaced one stitch apart, and stitches are sampled one stitch apart along each isoline.
   - Consecutive rows are "coupled" by dynamic time warping (DTW). A linear-time transducer then emits `sc / inc(x) / dec(x)`, and loop folding makes the result readable.
   - Branching shapes are cut at saddle isolines, and the segments are joined "as you go".
2. [V] **Igarashi, Igarashi & Suzuki (2008)** is the older pipeline ([PDF](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/yuki_pg08_knit.pdf)). It uses manual segmentation, inward iso-contours of 3D Euclidean distance, and nearest-neighbour stitching. The authors themselves call its patterns irregular.
3. [V] Shape calculators all use one formula: stitches in a round = circumference at that height ÷ stitch width. In symbols, `n = 2π·r(s)/w`, sampled every row height `h` along the shape's profile. This covers Avtanski's Sphere Calculator and Crochet Lathe ([avtanski.net](http://avtanski.net/projects/crochet/)) and [crochet-cad](https://github.com/judy2k/crochet-cad).
4. [V] Tools from 2025–2026 converge on **generate → validate deterministically → simulate in 3D**. Examples are [CrochetPARADE](https://www.crochetparade.org/Manual.html) and its Remesher, [CrochetPhoto2Pattern](https://github.com/paulkooer/CrochetPhoto2Pattern) and [CrochetPop](https://learn.crochetpop.app/). Patterns written only by an LLM fail on stitch arithmetic ([CrochetBench](https://arxiv.org/abs/2511.09483), [Makyrie](https://makyrie.com/crocheting-an-ai-generated-amigurumi/)).
5. [I] **Recommendation: two input paths feeding one shared core.**
   - **Path A** is the default and also the Claude Design import path. A model made of named primitives becomes a profile per part, then stitch counts per round, then evenly staggered increases/decreases, then folded text.
   - **Path B** handles any mesh. The mesh is made watertight and segmented. Rows come from heat-method geodesics, rows are joined with constrained DTW, a transducer emits the stitches, and a smoothing pass enforces what is physically crochetable.
   - Both paths share:
     - the calibrated gauge (stitch width `w` and row height `h`);
     - one validator suite;
     - per-stitch color assignment;
     - assembly instructions in (round, stitch) coordinates;
     - a stuffed-shape preview.

---

## 1. The geometry every 3D generator rests on

### 1.1 Stitch model

- [V] AmiGo treats single crochet (sc) as "an approximately square stitch". Covering a surface with sc is therefore equivalent to a quad remesh with constant edge length `w`. Curvature is produced by `inc(x)` / `dec(x)` stitches ([AmiGo §2.1](https://arxiv.org/abs/2211.01178)).
- [V] The authors' Bridges 2024 overview adds that amigurumi row height is constant and roughly equal to the sc width. So every stitch of a round sits at the same distance from the starting ring, measured along the surface (geodesic distance). The overview also says rectangular sc can be handled ([Bridges 2024](https://archive.bridgesmathart.org/2024/bridges2024-369.pdf)).
- [V] Igarashi et al. model a regular stitch as a square cell. An increase is one stitch connected to two in the next row; a decrease is two stitches connected to one ([PG 2008](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/yuki_pg08_knit.pdf)).

### 1.2 Gauge → `w` and `h`

- [V] The Craft Yarn Council guideline table gives sc gauge per 4 in and hook range for each yarn weight. The CYC labels these "GUIDELINES ONLY" ([CYC](https://www.craftyarncouncil.com/standards/yarn-weight-system)):

  | Weight | sc per 4 in | Hook |
  |---|---|---|
  | 1 Super Fine | 21–32 | 2.25–3.5 mm |
  | 2 Fine | 16–20 | 3.5–4.5 mm |
  | 3 Light | 12–17 | 4.5–5.5 mm |
  | 4 Medium | 11–14 | 5.5–6.5 mm |
  | 5 Bulky | 8–11 | 6.5–9 mm |
  | 6 Super Bulky | 7–9 | 9–15 mm |
  | 7 Jumbo | ≤ 6 | ≥ 15 mm |

- [V] Amigurumi is worked 1–2 hook sizes *below* the label (e.g., 3.5–4 mm for a yarn labelled 5 mm) so the fabric is tight and stuffing doesn't show ([Yarn.com](https://www.yarn.com/blogs/the-yarn-diary/best-yarn-for-amigurumi-how-to-choose-yarn-for-crochet-toys)). The CYC garment ranges therefore overstate toy stitch size.
- [I] Formulas:
  - `w = 4 in / (stitches per 4 in)`
  - `h = 4 in / (rows per 4 in)`
- [I] 3D generation needs **both** `w` and `h`. A 2D chart can manage with `w` and an aspect ratio. Without a swatch, default to `h = w` and show a "low confidence" badge (see §1.4).

### 1.3 Increase rate = curvature

- [V] Formulas from [Kekkonen 2025](https://arxiv.org/html/2508.10597), with stitch height H and width W:
  - A flat disc adds `2π·H/W` stitches per round.
  - On a sphere of radius S, round ℓ has `(2πS/W)·sin(H·ℓ/S)` stitches, i.e. fewer per round than a flat disc.
  - A hyperbolic surface follows `sinh`, i.e. more per round.
- [V] Worked example: at 20 sts × 20 rows per 10 cm you need 6.28 increases per round, which rounds to the familiar "6" ([Dora Does](https://doradoes.co.uk/2020/12/12/how-to-crochet-a-flat-circle/)).
- [V] Taller stitches need more increases per round: sc 6, hdc 8, dc 12 ([Sarah Maker](https://sarahmaker.com/crochet-flat-circle/)). *(Fact-check: was "dc 10–12". Sarah Maker gives 10–12 as a starting-ring range for dc, but says to increase by 12 per round.)*
- [I] **General law for any surface of revolution** (any shape you could turn on a lathe):
  - Describe the profile by arc length `s` from the starting pole and radius `r(s)`.
  - Round `k` sits at `s_k = k·h` and holds `n_k = 2π·r(s_k)/w` stitches.
  - Between rounds, `Δn ≈ (2πh/w)·dr/ds = (2πh/w)·sin α`, where α is the angle between the profile and the axis.
  - Because `|sin α| ≤ 1`, **`|Δn| ≤ 2πh/w`** (≈ 6.28 for square stitches) on any surface of revolution.
  - If a mesh demands more than that, it has negative Gaussian curvature there (ruffles or saddles). The validator flags it (§6.7, R5).
- [I] **Cones.** "6 increases every *k* rounds" corresponds to `sin α = 6 / (2π·k·h/w)`. For `h = w`:

| 6 inc every *k* rounds | k=1 | k=2 | k=3 | k=4 | k=5 | k=6 |
|---|---|---|---|---|---|---|
| half-angle α | 72.7° | 28.5° | 18.6° | 13.8° | 11.0° | 9.2° |
| apex angle 2α | 145.5° | 57.0° | 37.1° | 27.6° | 22.0° | 18.3° |

  - [I] The k = 1 column says something useful: with square stitches, the classic "+6 every round" circle is really a very shallow cone, so it cups slightly.
  - [V] PlanetJune observed exactly this. A flat circle worked with yarn-over (YO) curls slightly at the edges, while the same circle worked with yarn-under (YU), which gives a smaller stitch, is flatter ([PlanetJune](https://www.planetjune.com/blog/yarn-over-vs-yarn-under-in-crochet/)).

### 1.4 The height/width ratio `h/w` is not universal → calibrate it

| Source | Implied h/w | Evidence |
|---|---|---|
| AmiGo | 1.0 | [V] "approximately square" sc ([arXiv](https://arxiv.org/abs/2211.01178)) |
| Kekkonen 2025 example | 0.8 | [V] H = 0.4 cm, W = 0.5 cm ([arXiv](https://arxiv.org/html/2508.10597)) |
| Avtanski Sphere Calculator | ≈ 0.91 | [I] fit to its outputs: about 0.55·C row intervals pole to pole (§3.1) |
| Avtanski Crochet Lathe | ≈ 1.1 | [I] our probe: flat discs grow +7 sts/round; a wall 10 stitch-widths long gets 9 rows (§3.2) |
| Greer & Mould raindrop | > 1 | [V] real stitches looked "slightly taller than they are wide"; the authors suggest a user swatch ([EG 2025](https://diglib.eg.org/bitstream/handle/10.2312/exw20251057/exw20251057.pdf)) |
| PlanetJune YO vs YU | YU smaller | [V] the YU swatch is smaller and its circle flatter ([PlanetJune](https://www.planetjune.com/blog/yarn-over-vs-yarn-under-in-crochet/)) |

[I] A ±10 % error in `h/w` shifts a sphere's round count, and its height, by about ±10 %. The 3D flow should therefore:

- ask for a sc swatch measured both ways (stitches and rows per 4 in, or per 10 cm);
- offer a "stitch style: yarn over / yarn under" toggle, with default `h/w` = 1.0 for YO and 0.9 for YU;
- store a calibrated `h/w` per yarn and hook.

### 1.5 Stuffing, and which shapes can be made at all

- [V] AmiGo assumes the shell is stuffed "enough to attain maximal volume, but not too much" to stretch it ([AmiGo §2.3, §7.1](https://arxiv.org/abs/2211.01178)). Under that assumption:
  - **Craters cannot be made.** Formally these are regions with positive Gaussian curvature and negative mean curvature. AmiGo removes them by locally smoothing the mesh outward (localized conformal mean-curvature flow) until mean curvature is positive everywhere.
  - **Saddles can be made** (negative Gaussian and negative mean curvature), but need modified sampling (their Table 1).
  - Too few rows for the size of a feature loses that detail.
- [V] Avtanski's generator says the sphere "is calculated to be round when the filling is tightly packed; if under-filled the shape may be elongated" ([sphere output](http://avtanski.net/projects/crochet/cgi-bin/sphere.cgi?cir=36)).
- [V] Greer & Mould aim to model stuffing as volume maximization ([EG 2025](https://diglib.eg.org/bitstream/handle/10.2312/exw20251057/exw20251057.pdf)). *(Fact-check: in practice their least-squares solver cannot maximize volume. They "instead minimize curvature which results in a sub-maximal volume", with a fixed λ.)* Other points from the paper:
  - They reproduce a needle-pulled dimple (the apple) with an extra "constraint edge".
  - Flattened, unstuffed pieces such as bunny ears were left out of scope.
  - They note that it is common to crochet a piece in rounds and then flatten it.
- [V] Stuff before sewing, because stitches stretch when filled ([PlanetJune seamless join](https://www.planetjune.com/blog/amigurumi-help/how-to-make-a-seamless-join-in-amigurumi/)).
- [I] Consequences for us:
  - (a) Concave features (eye sockets, a waist dimple) become **needle-sculpting** notes or separate pieces, never crocheted craters.
  - (b) Flat parts such as ears and fins are generated as **flattened tubes**: the round's perimeter is 2 × width, the piece is not stuffed, and it is closed flat.
  - (c) The preview needs a stuffing-firmness parameter (§6.5).

---

## 2. Academic algorithms in detail

### 2.1 Igarashi, Igarashi & Suzuki 2008 — "Knitting a 3D Model"

**Authorship and terminology.**
- [V] The brief cites "Igarashi, Mitani, Igarashi". The actual authors are **Yuki Igarashi, Takeo Igarashi and Hiromasa Suzuki** (Computer Graphics Forum 27(7), Pacific Graphics 2008, pp. 1737–1743) ([PDF](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/yuki_pg08_knit.pdf)).
- [V] The paper says "knitting", but its charts use X (regular), V (increase) and Λ (decrease) marks.
- [I] Those are the standard Japanese chart marks for sc, sc-increase and sc-decrease.
- [V] AmiGo also files this work as computational *crochet*.

**Algorithm** (all [V], same PDF):

1. **Input.** A manifold mesh of 1,000–3,000 vertices, interactive on a 1.1 GHz Pentium M. Mesh edges must be shorter than one stitch. (The paper's own Table 1 examples actually use 527–1,990 vertices.)
2. **Segmentation is manual.** The user draws cut lines on the model. Each patch must be a disk or a disk with holes. The authors rejected automatic segmentation because "different segmentations yield very different final results".
3. **Hole filling.** The longest boundary is treated as the outer edge. Inner holes are filled with a centre vertex, so the user crochets a "bowl".
4. **Wrapping (rows).**
   - Rows run from the outer boundary **inward**. Each new contour is where the distance to the previous contour equals a fixed interval d0.
   - That distance is **3D Euclidean, not geodesic**, because the stitches between rows are roughly straight.
   - Contours are traced with marching triangles.
   - If a contour splits (a branch), the largest loop continues and the others close, which leaves a visible artifact asking the user for more segmentation.
   - Finally a medial axis inside the last contour collapses to a centre vertex.
5. **Resampling.** Points are placed along every contour at the **same interval** as the contour spacing, i.e. square stitches.
6. **Meshing.**
   - Join each point on contour A to its nearest point on B, then each point on B to its nearest point on A, and take the union of these edges.
   - Quads become regular stitches; triangles become increases or decreases.
   - End points of a contour receive 5–8 connections.
7. **Pattern output.**
   - Pick a random start point on the first contour, then the nearest point on each following contour.
   - Rows are reversed, since crochet starts at the centre.
   - Each row is printed as counts of regular, increase and decrease stitches.
8. **Preview.** The static stuffing simulation from the authors' earlier Plushie system.
9. **Color and yarn.** The user paints the 3D model and stitch colors follow on the chart. The system reports total knitting time and **total yarn length**.
10. **Stated limitations.**
    - Concavity *along* a row cannot be represented, because "each row forms a circle".
    - Results are "often very different from hand-designed knitted animals".
    - Irregular stitches should appear only near patch borders.

[I] **Lessons for us.**
- Growing each contour from the previous one with Euclidean distance, and joining rows by greedy nearest neighbours, scatters and clusters the increases/decreases and causes fan-outs at contour ends.
- AmiGo's single geodesic distance field plus a globally optimal monotone row coupling removes both problems.

### 2.2 AmiGo — Edelstein, Peleg, Itzhaky, Ben-Chen (SCF '22, Seattle)

[V] Everything below comes from the paper unless noted ([arXiv](https://arxiv.org/abs/2211.01178), [ACM DOI](https://doi.org/10.1145/3559400.3562005)).

**Input and output.**
- Input: a closed manifold triangle mesh M, a seed vertex s, and a stitch width w.
- Output: a **crochet graph** G = (S, R ∪ C) plus a pattern P(G).
  - Vertices S are stitch tops/bases.
  - Row edges R join consecutive stitches in a row.
  - Column edges C are the stitch stems between rows.

**Pipeline**

1. **Row function f.**
   - f(v) = geodesic distance from v to s, computed with the **heat method**. The time step t is the mean edge length squared ([Crane et al.](https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/)).
   - If mesh detail creates neighbouring saddles or extrema, t is multiplied by increasing powers of 2 until none remain.
   - All models are first normalized to surface area 1.
2. **Cut.** Cut M along a geodesic from s to the maximum of f, so the model has the same topology as the graph. Geodesic paths come from Sharp & Crane 2020.
3. **Column function g.**
   - Solve: minimize ∫ \|⟨J∇f, ∇g⟩ − 1\|², subject to g(B) = 0.
   - J rotates a vector 90° in the tangent plane. B is the longest boundary path of the cut model along which f is strictly monotone.
   - Result: \|g(p) − g(q)\| equals the length of the isoline between p and q.
4. **Sampling.** Sample (f, g) on a 2D grid of spacing w; vertex indices are (f/w, g/w), mapped back onto M. This places rows w apart and stitches w apart along each row.
5. **Row edges.** Connect consecutive samples within a row.
6. **Column edges (coupling).**
   - For each pair of consecutive rows, find a **minimal coupling**.
   - Definition 2.1: a coupling is an ordered sequence of pairs whose steps are (+1, 0), (0, +1) or (+1, +1), with both endpoints fixed.
   - It minimizes Σ‖X(p) − X(q)‖ over coupled pairs.
   - It is found with **DTW** (Sakoe & Chiba 1978; Gold & Sharir 2018).
7. **Guarantee (Observation 2.3).** If every pair of consecutive rows is coupled, valid instructions exist that use only `sc`, `inc(x)` and `dec(x)`.
8. **Transducer.**
   - Read two rows together: one-to-one gives `sc`; x > 1 old-row vertices joined to one new vertex give `dec(x)`; one old vertex joined to x > 1 new ones gives `inc(x)`.
   - Runs in linear time.
   - It is effectively deterministic, because a coupling never lets a vertex have multiple connections in both directions.
9. **Loop folding** (after Lee et al. 1994).
   - Fold repeated sequences first, then repeated stitches, then identical rows.
   - Example: `rows 2-3: (sc, inc, 2sc)*3`.
10. **Preview.**
    - A ShapeUp embedding: row edges and sc stems are held at length w, the seed is pinned, and a smoothness term is added.
    - Even without physics, the result is "quite similar" to the crocheted object (paper §6). The Bridges 2024 overview words it as "very similar". *(Fact-check: the quote was attributed to the paper as "very similar".)*

**Obstructions**

- *Craters* (positive Gaussian, negative mean curvature): localized conformal mean-curvature flow until mean curvature is positive everywhere.
- *Saddles* (negative Gaussian and mean curvature):
  - The stitch density along the row becomes ⟨∇g, J∇f⟩ = h(k), where k is the surface curvature measured along the row direction.
  - `h(x) = tanh(−x/α)/2 + 1` with **α = 10**, which keeps the rate inside (0.5, 1.5).
  - The Bridges overview describes this as using fewer stitches in saddle-like areas.
- *Creases*:
  - Crease vertices have a large maximum absolute curvature whose principal direction is orthogonal to the crochet direction.
  - Stitches between consecutive crease vertices in a row become **BLO** (back loop only) for convex creases or **FLO** (front loop only) for concave ones.
  - The user can switch this off.

**Branching (§7.2)**

- Saddle points of f are sorted by f-value. At each saddle, the isoline through it is sliced, giving one new segment per connected component.
- A directed acyclic graph links adjacent segments in order of increasing f. Segments are crocheted in topological-sort order.
- Very thin segments are not sampled and are skipped.
- Every segment is either a half-sphere or a cylinder.
  - g is solved separately per segment.
  - Its cut runs from the segment's maximum of f to the closest point on its boundary, or to the other boundary if the maximum lies on one.
- The last row of a parent segment must be coupled to the first row of its child.
- The child's "previous row" is a **joint row**: the last rows of all attached parents, filtered down to vertices that actually connect to it.
- The transducer reports where the work skips stitches, splits a segment, skips a segment, or spans several parents.
- This is the **join-as-you-go** method ([Bennett 2020](https://www.crochet365knittoo.com/joining-amigurumi-limbs-an-easy-technique)): no sewing, and seams are not visible.

**Implementation and validation**

- Matlab + C++.
- Eleven models were physically crocheted (Table 2): 30–60 rows, 1–8 segments, 365–3,670 stitches, and 0.2–6.9 minutes per model on an Intel Core i7.
- One model was crocheted at two stitch widths with the same seed, yarn and hook. This demonstrates automatic resizing (Teddy at 60 rows / 3,670 sts and at 30 rows / 880 sts).
- Validation is **visual only**: input mesh vs. crochet graph vs. ShapeUp embedding vs. crocheted toy. No quantitative error metric is reported.
- Bridges 2024 adds crochets made by recruited testers.

**Limitations (as stated)**

- [V] From the paper:
  - Closed surfaces only, since toys are stuffed.
  - Thin segments are hard to crochet.
  - **No symmetry handling**: "discretization errors … may lead to non-symmetric crocheted models".
  - A single seed gives limited control over crochet direction.
- [V] Added by Bridges 2024 ([PDF](https://archive.bridgesmathart.org/2024/bridges2024-369.pdf)):
  - AmiGo patterns **join and turn at the end of every round instead of working in a spiral**, because spiral slant conflicts with the shortest-stem optimisation.
  - Color, taller stitches and yarn-amount reporting are future work.
  - Standardised instructions are needed so crochet tools can interoperate.

**The paper's own sphere example (Fig. 2)**
- [V] Round counts: 7, 12, 17, 21, 23, 24, 24, 21, 17, 12, 7.
- [I] Our profile formula (§5) for circumference C = 24 and `h = w` gives 6, 12, 17, 21, 23, 24, 23, 21, 17, 12, 6.

### 2.3 Other research, 2017–2026

| Work | What matters for us |
|---|---|
| Guo, Lin, Narayanan, McCann, *Representing Crochet with Stitch Meshes*, SCF 2020 ([DOI](https://doi.org/10.1145/3424630.3425409)) | [V, as described in AmiGo] Stitch-mesh faces for crochet stitches plus a "current loop" edge type. Generates instructions for 3D models, but the crocheted result "can differ greatly" from the input. |
| Narayanan et al., *AutoKnit* (Automatic Machine Knitting of 3D Meshes), TOG 2018 | [V, as described in AmiGo] Machine knitting driven by a user time function plus constraints (two or more seeds), followed by tracing and scheduling. Takes tens of minutes. Its isolines-of-a-time-function idea is the knitting ancestor of AmiGo. |
| Igarashi et al., *Knitty*, EG 2008 short paper; Nakjan et al. 2018; Çapunaman et al. 2017 | [V, as described in AmiGo and Greer & Mould] Sketch → toy pattern; 2D sketch → simple symmetric shapes only; stitches inferred from a surface's (u,v) parameterization. |
| Seitz, Rein, Lincke, Hirschfeld 2021/2022, *Digital Crochet: Toward a Visual Language for Pattern Description* ([Onward! 2022](https://dl.acm.org/doi/10.1145/3563835.3567657)) | [V] Graph-based domain-specific language and visual notation for crochet patterns. *(Fact-check: author order corrected from "Seitz, Lincke, Rein, Hirschfeld", per Crossref.)* |
| Greer & Mould, *Modeling crochet patterns with a force-directed graph layout*, EG Expressive 2025 ([PDF](https://diglib.eg.org/bitstream/handle/10.2312/exw20251057/exw20251057.pdf)) | [V] Turns a written pattern into a stitch graph, then into a 3D shape with an Isenburg-style layout that minimizes (1−λ)·E_L + λ·C (edge length 1; uniform-Laplacian curvature). λ = 0.65, or 0.9 for the bunny head and body. Legs and arms (318 and 264 stitches) converge in under 5 s; head and body (798 and 708) had not converged after more than 2 min (Ceres solver). They call AmiGo's segmentation "unintuitive". Code: `github.com/EnbyMonkey/modeling-amigurumi`. |
| Li et al., *CrochetBench*, ACL 2026 ([arXiv](https://arxiv.org/abs/2511.09483)) | [V] 6,085 Yarnspirations patterns. Tasks run up to compiling into the CrochetPARADE DSL. Model performance drops sharply when scoring moves from text similarity to executable correctness. |
| Dias & Karim, AAAI 2025 Summer Symposium ([OJS](https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054)) | [V] A fine-tuned DeepSeek-R1-Distill-Llama-8B translates user-written patterns into CrochetPARADE syntax with 74 % accuracy. |
| Luo & Umetani, *CT2Yarn*, Pacific Graphics 2026 ([arXiv](https://arxiv.org/html/2609.06950v1)) | [V] Recovers yarn paths from micro-CT scans. Amigurumi, which uses several yarns, is explicitly future work. |
| Kekkonen, *Crocheting Mathematics*, 2025 ([arXiv](https://arxiv.org/abs/2508.10597)) | [V] Curvature formulas (§1.3). |
| Storck et al. 2022 (J. Industrial Textiles); Marciniak et al., *StitchFlow*, UIST 2025; Smith et al., *Loom-Based Mechanized Crochet*, SCF Adjunct 2025 | [V] Respectively: meso-scale finite-element models, a sensor hook that captures the process, and robotic crochet. Not needed for pattern generation. |

### 2.4 "Branched amigurumi" and follow-ups

- [V] We found no separate "branched amigurumi" paper (searched before our search budget ran out).
  - Branching is handled inside AmiGo §7.2.
  - The only follow-up by the same authors that we found is the Bridges 2024 overview.
- [V] The Python port [karinsifri/AmiGo](https://github.com/karinsifri/AmiGo) (CC BY-NC-SA 4.0). Whether it is a community port or comes from the authors' group is (unverified): its README says "please cite our paper".
  - It states "Branching meshes are not supported yet" (limbs, ears, appendages).
  - It exposes `stitch_size` (e.g., 0.04 model units) and `use_creases`.
  - It opens an interactive 3D seed picker *unless* a seed is configured (e.g. `--seed 82`). *(Fact-check: was "requires an interactive seed pick".)*
- [I] So a production-quality pipeline for branched shapes is still an open problem.
  - Path B therefore uses AmiGo's machinery *within* each part, combined with semantic part segmentation (head, body, limbs), which is how designers actually build toys.
  - It keeps AmiGo's seamless saddle segmentation as an option.

---

## 3. Existing tools and how they compute

### 3.1 Avtanski Crochet Sphere Calculator (2012)

- [V] Input: the sphere's circumference in stitches (10–1000).
- [V] Output for C = 36: start with 5 st in a magic circle, then rounds producing 11, 16, 21, 25, 29, 32, 34, 36, 36, 36, 34, 32, 29, 25, 21, 16, 11, 5 ([output](http://avtanski.net/projects/crochet/cgi-bin/sphere.cgi?cir=36)).
- [V] Details of the output:
  - Increases are staggered, e.g. `4sc, inc, 15sc, inc, 11sc`.
  - `inc2` / `dec2` (three stitches in one / three together) appear at the poles.
  - It says to work in a spiral, use invisible decreases, and stuff tightly.
- [I] We fetched outputs for C = 12, 24, 36, 60 and 100. All of them fit `n_k = round(C·sin(πk/N))` exactly, except the poles, which are clamped to 5 where the formula gives 6. C = 100 is one stitch lower than the fit in five interior rounds per hemisphere (10 rounds in all). *(Fact-check: re-fetched and re-fit independently. Was "five interior rounds", without saying per hemisphere.)*
  - For C ≥ 24, N, the number of row intervals from pole to pole, is ≈ 0.55·C (N = 13, 20, 33, 55). That implies `h ≈ 0.91·w`. C = 12 instead fits N = 6 = 0.5·C (h = w) with no clamping.
  - Our generic profile algorithm (§6.6) run with `h = 0.9w` reproduces its C = 36 sphere (we get 6 instead of 5 at the poles).

### 3.2 Avtanski Crochet Lathe

- [V] The user draws a profile polyline whose points are flagged round or sharp; a server CGI returns a spiral pattern ([lathe](http://avtanski.net/projects/crochet/lathe/)).
- [I] Our probe with a flat-ended cylinder of profile radius 5 units:
  - Rounds had 31 stitches (= round(2π·5)), so the radius is measured in stitch widths.
  - The end discs grew 8 → 15 → 22 → 29, i.e. **+7 per round**. *(Fact-check: we re-ran `lathe.cgi` and could not reproduce the exact counts (unverified). With a start radius of 1 we got 13 → 20 → 27 → 31, and with 0.5 we got 10 → 16 → 23 → 30. The roughly +7 per round and the −7 per round on the closing disc (31 → 24 → 17 → 10) were confirmed. A profile point at radius 0 is rejected with "Error validating data".)*
  - The note "Stitch next row inserting the hook under the BACK loops only" appeared at **both sharp corners**: before the first wall round and before the first decrease round.
  - Closing used `dec2` / `dec3`.

### 3.3 crochet-cad (Mark Smith, 2010–11, GPL-3)

[V] From the [source](https://github.com/judy2k/crochet-cad):
- **Ball:** `rad = (rows+1)/π`, `stitches_k = 2π·rad·sin(k·π/(rows+1))`. The circumference is 2·(rows+1), so this assumes `h = w`.
- **Donut** (torus) — starts at the hole and works "up and around":
  - `xrad = rows/2π`
  - `stitches_k = 2π·(hole_rad + xrad·(1 − cos(2πk/rows)))`
- **Cone:** linear interpolation from 6 stitches to the base count.
- Counts snap to multiples of 6 unless `--accurate` is set.
- Increases/decreases are placed by repeating a block `gcd(prev, next)` times. This spaces them evenly but does **not stagger** them.

### 3.4 fibertools.app Amigurumi Shapes

- [V] The only input is the total number of rounds (6–30).
  - The sphere "builds from six stitches, adds six per increase round, works one center round for an even requested total or two for an odd total, then removes six per decrease round".
  - The site disclaims any guarantee of "a finished geometric shape" ([fibertools](https://fibertools.app/amigurumi-shapes)).
- [I] With only 1–2 plain middle rounds, the ball comes out flattened unless it is over-stuffed (§4.1).

### 3.5 CrochetPARADE and the CrochetPARADE Remesher (Svetlin Tassev)

**CrochetPARADE** [V] ([manual](https://www.crochetparade.org/Manual.html), [repo](https://github.com/crochetparade/CrochetPARADE)):
- A pattern language that runs in the browser. Key syntax:
  - `ring` (magic ring), `sc2inc`, `sc2tog`, `scbl` / `scfl` (back/front loop);
  - labels `.A` / `@A`, and stitch addresses `@[row,stitch]`;
  - `COLOR:` for color;
  - `TRANSFORM_OBJECT:` to place separate pieces.
- The 3D shape comes from a force-directed layout:
  - `iterations` defaults to 500 and `learning_rate` to 0.1.
  - An `inflate` repulsion stands in for stuffing; its typical range is 0.5–3.0.
  - `inflate` defaults to infinity, which means off.
- Exports: GLTF, an STL/OBJ periphery mesh, an SVG chart, and DOT.
- License:
  - **GPL-3** for the website and its computational code;
  - **CC BY-NC-SA 4.0** for the manual;
  - the grammar itself is stated to be public domain (repo README).

**Remesher** [V] (2026, GPL-3.0-or-later, Rust/WASM; [repo](https://github.com/stassev/CrochetPARADE_Remesher)). It is an **advancing-front** method, not an isoline method:
- It grows a triangulated stitched patch outward from a magic ring or a starting chain.
- At each corner of the patch's growing edge (frontier) it looks at the angle θ and applies one of three operations:
  - θ ≤ 65° → decrease (op0);
  - θ ≥ 120° → increase (op2);
  - anything in between → sc (op1);
  - θ ≤ 35° → a slip-stitch-like closure.
- Stitch length L defaults to the bounding-box diagonal / 50.
- It searches with backtracking over saved snapshots (that the order is strictly depth-first is unverified), and rejects bad triangles with geometric guards (area, altitude, normal, overlap).
- "Zips" sew facing parts of the frontier together (`max_zip_dist` = 1.5·L).
- It uses multiple yarns and a ladder of progressively relaxed rules when stuck.

[I] Powerful but heuristic-heavy: dozens of parameters and search budgets. Its seams and multiple yarns are hard to explain in a beginner pattern. Not our first choice, but useful as an external cross-check.

### 3.6 CrochetPhoto2Pattern (MIT)

- [V] Pipeline ([repo](https://github.com/paulkooer/CrochetPhoto2Pattern)): photo → observations → user's target size → **part structure** → gauge-aware round generation → **deterministic validation**.
  - The part structure records part instances, mirrored pairs, attachment anchors and inference confidence.
  - If stitch arithmetic or gauge-based shaping limits are violated, the CLI exits with code 2.
- [V] It exports CrochetPARADE DSL "as a second-tier executable-correctness check" and ships physical-trial tooling.
- [V] It states openly that:
  - photo generalization and physical crochetability are *not established*;
  - a single photo cannot recover depth, hidden attachments or absolute scale.
- [I] This is the closest existing project to ours, and its part-template approach supports our Path A.

### 3.7 Commercial and AI apps

- [V] **Patternize** (iOS) promises photo → "complete crochet pattern" with no accuracy disclaimer in its listing. Subscriptions run from $4.99/week to $79.99 lifetime ([App Store](https://apps.apple.com/us/app/patternize/id6758268844)).
- [V] **CrochetPop** says its patterns are "produced by deterministic algorithms and machine-validated for stitch-count accuracy — never written by a language model" ([site](https://learn.crochetpop.app/)).
- [V] **Amigurumake 3D Studio** goes the other way: it previews *existing* written patterns in 3D from their stitch counts ([site](https://amigurumake-studio.com/features/3d-studio)).
- [V] **Amigurum.io** (template shapes mixed and matched, with complex shapes paywalled) and **Plushify** (3D model → *sewing* pattern) are described by Greer & Mould.
- [V] A ChatGPT-5 duckling pattern asked for 20 stitches in a round where only 18 existed ([Makyrie](https://makyrie.com/crocheting-an-ai-generated-amigurumi/)).
- [I] Lesson: we have no paid AI, and we don't need it for the arithmetic. Every stitch count must come from geometry plus a validator, never from free text.

### 3.8 Licensing implications

- [I] Licenses:
  - the AmiGo port is CC BY-NC-SA (non-commercial use only);
  - CrochetPARADE, the Remesher and crochet-cad are GPL-3; the Remesher is GPL-3.0-or-later.
  - The CrochetPARADE manual is CC BY-NC-SA 4.0. Writing exporter text in its grammar is fine, but we should not copy the manual's prose.
- [I] We should re-implement the algorithms from the papers and formulas, which carry no copyright on the math, and not copy their code into a permissive-licensed app.
- [I] Interoperability is fine. Export CrochetPARADE text so users can paste it into crochetparade.org for an independent 3D check, as CrochetPhoto2Pattern does.

---

## 4. Practitioner techniques the generator must emit

### 4.1 The classic sphere

- [V] The standard recipe ([zamiguz](https://zamiguz.com/crochet-sphere/), [fibertools](https://fibertools.app/amigurumi-shapes)):
  - 6 sc in a magic ring, then +6 per round;
  - some plain rounds;
  - mirrored −6 rounds, with as many decrease rounds as increase rounds.
  - zamiguz says to add at least half as many plain rounds as increase rounds; fibertools uses only 1–2.
- [I] Geometry of the classic sphere:
  - With a maximum of 6n stitches, the radius is R = 6n·w/2π.
  - The pole-to-pole arc is πR = 3n·w, i.e. 3n·(w/h) rounds.
  - The pattern uses n + p + (n − 1) rounds plus the closing gather, so the right number of plain rounds is **p ≈ n·(3w/h − 2)**.
  - That gives p = n for h = w, 1.33·n for h = 0.9w, and 0.5·n for h = 1.2w. The "half as many" rule only fits tall stitches.
- [I] Why it still comes out round:
  - Because "+6 per round" is a shallow 72.7° cone (§1.3), the unstuffed classic shell is drum-shaped. For n = 6, h = w and p = 6 (the table row below), its height is about 0.83 × its diameter (≈ 9.6 w vs 11.5 w). *(Fact-check: was "about 0.92". We recomputed it as the sum of row-to-row rises √(h² − Δr²) plus the two pole rises. The value 0.92 only comes out with p = 7 plain rounds.)*
  - Its pole-to-pole arc length still matches a sphere's, so firm stuffing rounds it out.

| C = 36 (n = 6) | Rounds | Stitch counts |
|---|---|---|
| Classic (+6 per round, p = 6) | 17 | 6 12 18 24 30 36 36 36 36 36 36 36 30 24 18 12 6 |
| Geodesic profile, h = w [I] | 17 | 6 12 18 23 28 31 34 35 36 35 34 31 28 23 18 12 6 |
| Geodesic profile, h = 0.9w [I] (= Avtanski except the poles) | 19 | 6 11 16 21 25 29 32 34 36 36 36 34 32 29 25 21 16 11 6 |

### 4.2 Flat circles and staggering

- [V] Stacking six increases in the same place every round produces a hexagon. The fix is to split one sc run in half on alternate rounds; the same trick applied to decreases keeps holes smaller ([and she laughs](https://www.andshelaughsblog.com/crocheting-perfect-circle-staggered-increases-decreases/)).
- [V] Greer & Mould's simulation reproduced the "6-point spiral" visible in real amigurumi.

### 4.3 Invisible decrease

- [V] Steps: insert into the front loop of the next stitch, then the front loop of the following one; yarn over and pull through 2; yarn over and pull through 2. It looks like a normal sc ([PlanetJune](https://www.planetjune.com/blog/amigurumi-help/invisible-decrease/)).
- [V] PlanetJune also has an invisible-increase tutorial ([index](https://www.planetjune.com/blog/amigurumi-help/)).

### 4.4 Ovals worked around a chain

- [V] Work along both sides of the foundation chain and add the increases at the two ends only ([Hooked by Kati](https://www.hookedbykati.com/ovals-around-a-chain/)).
- [V] All About Ami's example: ch 7, then 6 sc in the back loops plus 6 sc in the front loops = 12 stitches, then `(sc, inc) x6` = 18 ([All About Ami](https://www.allaboutami.com/foundationchain/)). *(Fact-check: this example spreads its increases evenly around the round, not only at the ends. It was cited as an ends-only example.)*
- [I] Math:
  - `n_k = 2S + 2π·r_k/w`, where `S = (L − W)/w` is the number of stitches along each straight side and `r_k = (k − ½)·h`.
  - That is about 6.28 extra stitches per round, ≈ 3 at each end.
  - Example: a 3 × 1.6 in oval at 5 sts/in gives S = 7 and rounds of 17, 23, 30, 36.

### 4.5 Flat bottoms and creases

- [V] BLO stitches turn sharper corners but leave gaps when stuffed; the "better BLO" variant also catches the back bar ([PlanetJune](https://www.planetjune.com/blog/tutorial-better-blo-stitches-for-amigurumi/)).
- [V] The Lathe emits BLO at sharp profile corners (§3.2).
- [V] AmiGo uses BLO for convex creases and FLO for concave ones (§2.2).

### 4.6 Color changes and stripes

- [V] Change color on the last pull-through of the *previous* stitch ([PlanetJune colour](https://www.planetjune.com/blog/amigurumi-help/changing-colour/)).
- [V] Spirals show a "jog" at color changes, so switch to joined rounds there.
- [V] PlanetJune compared five round-join methods for stripes and recommends combining two of her own: Invisible Join and No-Cut Join ([comparison](https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/)).
- [V] Her "Ultimate Stripes" method cuts the yarn every round and moves the join so seams don't stack ([ultimate stripes](https://www.planetjune.com/blog/amigurumi-help/ultimate-stripes-for-amigurumi/)).
- [V] Short spans of the unused color can be carried behind the work. Dark yarn shows through light stitches.

### 4.7 Joining pieces

- [V] **Seamless join (open piece to closed piece)** ([PlanetJune](https://www.planetjune.com/blog/amigurumi-help/how-to-make-a-seamless-join-in-amigurumi/)):
  1. Hold the open piece in its final position and pin it. (The pinning step is unverified; the tutorial's positioning guidance was not re-read word for word.)
  2. Stitch through both loops of the open edge.
  3. Pull "very tightly".
- [V] **Join-as-you-go legs** ([Bennett](https://www.crochet365knittoo.com/joining-amigurumi-limbs-an-easy-technique)):
  1. Leave leg 2 live and sc around it until you reach the marker.
  2. Continue around leg 1, then finish leg 2.
  3. Optional: chain 2 between the legs, and in later rounds work into both sides of that chain.

### 4.8 Placement conventions

- [V] Eyes go roughly halfway up the head, or level with the top of the muzzle, with centres at least half the face width apart ([PlanetJune](https://www.planetjune.com/blog/positioning-amigurumi-eyes/)).
- [V] "6 stitches apart" means 6 stitches between the eye posts.

---

## 5. Primitive formula library  [I]

**Notation.**
- `w` and `h` are in inches; `s` is arc length along the profile from the start pole.
- Rounds sit at `s_k = k·h′`, where `h′ = L / round(L/h)` stretches the row height slightly so the profile length L holds a whole number of rounds.
- Ideal count: `n_k = 2π·r(s_k)/w`, then rounded per §6.6.

| Primitive | Profile `r(s)` / rule | Notes |
|---|---|---|
| Sphere ⌀D | `r = R·sin(s/R)`, `L = πR` | "Classic" style = changes batched in sixes (§6.6) |
| Hemisphere / dome | same formula, `s ≤ πR/2` | Leave the edge open for sewing, or add a flat BLO base |
| Ellipsoid (equatorial radius a, polar c) | `(z, r) = (−c·cos t, a·sin t)`, arc length computed numerically | For an asymmetric egg, use a lathe profile |
| Cylinder ⌀D × H, flat ends | disc `r = s` (up to R), wall `r = R`, top disc | **BLO** on the first round after each sharp corner |
| Cone (closed apex) | `r = s·sin α` | Magic ring ≥ 5; work even until the ideal count passes the ring count ("apex rule") |
| Capsule | quarter arc + straight wall + quarter arc | — |
| Torus (major R, tube a) | `n_k = 2π(R − a·cos(2πk/K))/w`, `K = round(2πa/h)` | Start on a chain ring at the hole; seam the last round to the first (crochet-cad form) |
| Flat circle | `n_k = 2π·k·h/w` | "+6 per round" is right when h ≈ 0.95w |
| Flat oval L × W | `n_k = 2S + 2π(k−½)h/w` | Increase only at the two ends |
| Flattened tube (ear, fin) | `n_k = 2·width(k)/w` | Not stuffed; pressed flat, then closed with sc through both layers |
| Lathe (any profile) | Polyline `[z, r, sharp]` supplied by the user or Claude Design | The general case; every row above is a special case |

**Computed examples** at 5 sts/in and 5 rows/in [I]:

- **3 in sphere, exact mode** (symmetric hysteresis, 23 rounds):
  `6 12 18 24 29 33 37 41 44 46 46 47 46 46 44 41 37 33 29 24 18 12 6`
- **Same sphere, classic batching:**
  `6 12 18 24 30 36 36 42 42 48 48 48 48 48 42 42 36 36 30 24 18 12 6`
- **Ellipsoid, a = 1 in, c = 1.4 in:**
  `6 12 17 21 25 27 29 31 31 31 31 29 27 25 21 17 12 6`
- **Cone, 3 in tall, 2 in base, classic:**
  - Counts: `6 6 6 6 12 12 12 18 18 18 24 24 24 30 30 30` — 6 increases every 3rd round.
  - Half-angle α = 18.4°, consistent with the k = 3 column of the cone table in §1.3.
- **Closed cylinder ⌀1.5 × 2 in:**
  `6 12 18 24 | BLO 24, then 24 ×9 | BLO 18, then 12 6`
  - *(Fact-check: the counts are reproduced: N = 18, h′ = 0.194 in, 17 rounds. But §6.6's `crossesSharpCorner((k−1)h′, k·h′)` would flag round 4 as BLO, since it spans s = 0.58–0.78 in and the corner is at 0.75. That is the 18→24 increase round, not round 5. Decide which convention is intended (BLO on the first full wall round is the usual practice, as in the Lathe) and make the code and this example agree.)*
- **Torus, R = 1.5 in, a = 0.5 in:**
  `31 33 36 41 47 53 58 62 63 62 58 53 47 41 36 33`, then seam the last round to the first.
- **Flat-circle increases per round by h/w:** 0.8 → 5.0, 0.9 → 5.7, 1.0 → 6.3, 1.1 → 6.9. The last value matches the Lathe's +7.

**Example of generated text** [I] (3 in sphere, classic batching):

```
Rnd 1: 6 sc in magic ring (6)
Rnd 2: inc x6 (12)
Rnd 3: (inc, sc) x6 (18)
Rnd 4: (2 sc, inc) x6 (24)
Rnd 5: (sc, inc, 2 sc) x6 (30)
Rnd 6: (4 sc, inc) x6 (36)
Rnd 7: sc around (36)
Rnd 8: (2 sc, inc, 3 sc) x6 (42)
Rnd 9: sc around (42)
Rnd 10: (6 sc, inc) x6 (48)
Rnds 11-14: sc around (48)
Rnd 15: (2 sc, dec, 4 sc) x6 (42)
Rnd 16: sc around (42)
Rnd 17: (5 sc, dec) x6 (36)
Rnd 18: sc around (36)
Rnd 19: (sc, dec, 3 sc) x6 (30)
Rnd 20: (3 sc, dec) x6 (24)
Rnd 21: (dec, 2 sc) x6 (18)
Rnd 22: (sc, dec) x6 (12)
Rnd 23: dec x6 (6). Fasten off; weave through front loops and pull closed.
```

**How staggering is applied** [I]:
- The stagger phase alternates **per round that has changes**, not per round number.
- With per-round-number alternation, rounds 6 and 8 above (separated by a plain round) would stack their increases. The prototype caught this; validator R8 checks for it.

---

## 6. Recommended design: two paths into one core

### 6.0 Shared core  [I]

Both paths produce `PartPattern[]` and then run the same steps:

1. Validate (§6.7).
2. Fold the stitches into readable text.
3. Assign color runs.
4. Write assembly instructions.
5. Compute yardage.
6. Render the preview.

The 2D generator (other research docs) shares the gauge, palette quantization, validator style and notation. A 2D chart is just the special case "rows of constant count, turned at the end of each row".

```ts
type Op = 'sc' | 'inc' | 'inc3' | 'dec' | 'dec3';          // inc3 = 3 sc in one st; dec3 = sc3tog
const CONS: Record<Op, number> = { sc: 1, inc: 1, inc3: 1, dec: 2, dec3: 3 };
const PROD: Record<Op, number> = { sc: 1, inc: 2, inc3: 3, dec: 1, dec3: 1 };

interface Round { n: number; ops: Op[]; loop: 'both' | 'blo' | 'flo'; color?: number[] /* palette id per produced st */ }
interface PartPattern {
  id: string; makeCount: 1 | 2; mirrorOf?: string;
  start: { kind: 'magicRing'; n: number } | { kind: 'chainOval'; chain: number }
       | { kind: 'chainRing'; n: number } | { kind: 'joint'; from: StitchRef[]; chains: number };
  rounds: Round[];
  finish: 'gatherClose' | 'openForSewing' | 'flattenAndClose' | 'seamToStart';
  stuffing: 'firm' | 'light' | 'none';
  hEff: number;                                   // row pitch actually used (in)
}
interface StitchRef { part: string; round: number; stitch: number }   // 1-based
```

**Convention.** The start-of-round marker sits at **centre back**, which hides jogs and seams. Stitch numbers count from the marker, so centre front is stitch `⌊n/2⌋ + 1`.

### 6.1 Path A — primitive-part model (best quality; the Claude Design import path)

[I] **Schema `ami-parts/1`** (JSON, inches). This is what the R5 Q&A prompt should ask Claude Design to produce or embed.
- The container Claude Design actually returns is covered in a separate research doc.
- If it is glTF, the JSON can ride on each node's `extras`, which the spec allows on nodes and meshes. Node `name`s are not guaranteed unique, so don't use them as IDs ([glTF 2.0 spec](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)).

```json
{ "schema": "ami-parts/1", "units": "in", "name": "Bear",
  "parts": [
    { "id": "head", "primitive": { "type": "ellipsoid", "a": 1.5, "c": 1.35 },
      "transform": { "position": [0, 0, 3.1], "rotationDeg": [0, 0, 0] },
      "start": "top", "stuffing": "firm",
      "color": { "base": "#C68B59",
                 "regions": [ { "type": "band", "from": 0.55, "to": 0.70, "color": "#F2D3B3" },
                              { "type": "spot", "u": 0.5, "v": 0.62, "radius": 0.12, "color": "#222222", "as": "embroidery" } ] } },
    { "id": "earL", "primitive": { "type": "flattenedCup", "width": 0.9, "depth": 0.5 },
      "attach": { "to": "head", "u": 0.36, "v": 0.18, "method": "sewOpen" } },
    { "id": "earR", "mirrorOf": "earL" },
    { "id": "body", "primitive": { "type": "lathe",
      "profile": [[0,0,1],[0,1.0,1],[1.6,1.2,0],[2.2,0.7,0],[2.3,0,0]] }, "start": "bottom" }
  ] }
```

Field meanings:
- `u` is the longitude fraction measured from centre back.
- `v` is the fraction of the parent's profile arc length from its start pole.
- Each profile triple is `[z, r, sharp]`, where `sharp = 1` marks a corner that gets a BLO round.

**Steps**

1. Validate the schema and resolve `mirrorOf` into "make 2".
2. Build each part's profile with `profileOf(primitive)`.
3. Compute counts with `roundsFromProfile`, in the style the user picks: classic (batches of 6) or exact (hysteresis).
4. Place stitches with `distribute`, then `fold` into text.
5. Assign colors (§6.3).
6. Write assembly from each `attach` entry (§6.4).
7. Render the preview (§6.5).

**Mesh imported without `extras`** — fit primitives to each node:
1. Find the axis with PCA.
2. Slice along the axis and measure radii.
3. Pick the best of sphere / ellipsoid / cylinder / cone / lathe by residual error.
4. If the residual is above about 12 % of the radius, send the node to Path B.

**3D editor (R7) for Path A:**
- Sliders for each primitive's parameters, plus a transform gizmo.
- Attach anchors that drag along the parent's surface (closest-point projection).
- Stitch counts update live, and validator badges show problems.

### 6.2 Path B — general mesh (R2 multi-view, R3 single-image inflation, R7 sculpt edits)  [I]

1. **Pre-process the mesh.**
   - Make it watertight and manifold with a voxel remesh. Reconstruction and inflation meshes often aren't.
   - Scale it to the target size in inches.
   - Remesh to even triangles with edge length ≈ `min(w, h)/3`.
   - Detect craters (positive Gaussian, negative mean curvature). Either inflate them locally (AmiGo §7.1.1) or keep them and emit needle-sculpting notes.
2. **Segment the mesh** (the user chooses the mode).
   - **B1 "seamless".** AmiGo-style saddle segmentation from a single seed, joined as you go.
   - **B2 "classic parts" (default).** Segment into head / body / limbs by skeleton or shape-diameter-function (SDF) segmentation, and let the user edit cuts by drawing lines (Igarashi-style).
     - Reference parameters from CGAL's SDF segmentation: 2π/3 cone, 25 rays per face, k = 5 Gaussian-mixture clusters, graph cut with λ = 0.26 ([CGAL](https://doc.cgal.org/latest/Surface_mesh_segmentation/index.html)).
     - CGAL's mean-curvature skeleton keeps vertex-to-skeleton correspondences that can drive segmentation ([CGAL](https://doc.cgal.org/latest/Surface_mesh_skeletonization/index.html)).
     - In the browser: ray casting with a BVH library (e.g., three-mesh-bvh) for SDF, then region growing or a graph cut.
3. **Build rows for each part.**
   - **Seed:** for a limb, the tip geodesically farthest from where it attaches; for head and body, the top or bottom pole. The user can drag it, as in AmiGo.
   - **Distance field:** heat-method geodesics f with `t = (mean edge length)²`, doubled while adjacent critical points remain ([Crane](https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/)). geometry-processing-js is an MIT-licensed browser reference.
   - **Rows:** isolines at `k·h′`, traced with marching triangles.
   - If any level has more than one connected loop, the part contains a saddle: split it.
4. **Stitches per round.**
   - `n_k = isoline length / w`. Optionally apply AmiGo's curvature-adapted stitch rate.
   - Round with hysteresis, then slope-limit (validator rules R4 and R5).
5. **Stitch placement.**
   - Take uniform arc-length samples starting at the seam, which is the geodesic from the seed to the maximum of f (AmiGo).
   - Couple consecutive rounds with **constrained DTW**: at most 2 stitches worked into one (or 2 together), falling back to 3; if still infeasible, insert a half-row.
   - Run the AmiGo transducer.
6. **Readability pass.**
   - If the part is near-axisymmetric (radial residual < 10 %), replace the DTW positions with `distribute()`, i.e. even, staggered spacing.
   - Otherwise keep the geometric positions, which encode off-axis shaping. For example, an elliptical body needs its increases concentrated at the sides.
7. **Symmetry** (AmiGo's stated gap):
   - Detect mirror symmetry.
   - Put the seam on the symmetry plane and mirror counts and change positions.
   - Generate one copy of each paired part with "make 2".
8. **Bridge from B to A.** A "fit primitive" button turns a Path B part into a lathe primitive, giving a classic-looking pattern. This is also the R7 editor's simplification tool.

### 6.3 Colors on the 3D pattern (R8)  [I]

1. **Stitch centres.**
   - Path A: the point `(s_k, φ_j)` on the primitive, where `φ_j = 2π(j + ½ + offset_k)/n_k`.
   - Path B: the centroid of the stitch's quad on the mesh, using the two stitch positions in round k and the stitches they connect to in the next round.
2. **Color field.** Any of:
   - the mesh's texture or vertex colors;
   - the photo projected through the reconstruction cameras (R2) or by front/back projection (R3);
   - the region specs in `ami-parts` (bands, spots, decals).
3. **Palette.**
   - Choose k ≤ 6 yarn colors by k-means in CIELAB, merging any two closer than ΔE ≈ 10.
   - Assign each stitch to its nearest palette color.
4. **Clean-up** on the round × stitch grid (stitches wrap around):
   - 3×3 majority filter;
   - minimum run of 2 stitches;
   - at most 2–3 colors per round, the limit for carrying yarn inside (tapestry).
5. **Technique per region.**
   - Whole-round color change → stripe. Use joined rounds or a jogless join from that round on (§4.6).
   - Region of at least 3 stitches × 2 rounds → tapestry crochet in the round, carrying the unused yarn inside. Warn when light yarn is carried behind dark.
   - Features under 3 stitches → surface embroidery. Eyes → safety eyes.
   - Large spots → offer a separate **appliqué** flat circle or oval, sewn on at computed coordinates.
6. **Notation.**
   - Example line: `Rnd 12: [A] 10 sc, [B] 4 sc, [A] 22 sc (36)`.
   - Every color change is written as "change to B in the last pull-through of the previous stitch" (PlanetJune).
7. **Yardage.**
   - Yards per color = stitches in that color × yards per stitch (calibrated from a swatch) × (1 + waste).
   - Igarashi's 2008 system already reported total yarn length.

### 6.4 Assembly in (round, stitch) coordinates  [I]

1. **Project the child's anchor onto the parent.** The anchor is the centre of the child's open edge, or a contact point.
   - For a primitive, compute the closest `(s, φ)` analytically.
   - For a mesh, take the closest surface point and read its `(f, g)`.
2. **Convert to coordinates.**
   - `round = round(s / h′)`
   - `stitch = 1 + round(φ/2π · n_round) mod n_round`
3. **Size of the opening.** A child with m open stitches has an opening of diameter ≈ `m·w/π`. It therefore spans about `m·w/(π·h)` rounds and `m/π` stitches.
4. **Output text.** Example: "Stuff the arm lightly. Sew its open edge (12 sts) to the body between Rnds 14–17, centred on st 9 counted from the marker (centre back)."
5. **Mirrored pairs.** `stitch_R = 1 + (2·(front − 1) − (stitch_L − 1)) mod n`.
6. **Join-as-you-go** (legs → body, or B1 segments).
   - Joint-row count = live stitches of all parents + 2·c, where c is the number of bridging chains (both sides of each chain get worked).
   - The child's first round must consume exactly that many stitches.
7. **Spiral drift.** Spirals drift, so the instructions say "place a marker at centre front on Rnd X" and "pin before sewing" (PlanetJune).
8. **Placement image.** Render the parent with round numbers and the target stitch highlighted.

### 6.5 Preview and stuffing (closing the loop on size)  [I]

**Simulation.**
- Simulate the crochet graph with position-based dynamics:
  - row edges held at length `w`, stems at `h`;
  - a pressure term for stuffing: firm = high, light = low, ears = 0 plus a flattening plane;
  - Laplacian smoothing, with the seed pinned.
- This is the lightweight equivalent of AmiGo's ShapeUp preview, Greer & Mould's λ-weighted force-directed layout, and CrochetPARADE's `inflate`.
- Run about 300 iterations in a Web Worker.

**Closing the loop on size.**
- Compare the stuffed dimensions with the target inches.
- If they are more than 5 % off, rescale the part and regenerate, at most twice.
- Keep a user-calibrated "stuffing stretch" factor, default 1.0.

### 6.6 Pseudo-code (core functions)

```ts
// ---------- units ----------
const w = 4 / gauge.stitchesPer4in, h = 4 / gauge.rowsPer4in;

// ---------- Path A: profile -> stitch counts ----------
function roundsFromProfile(P: { z: number; r: number; sharp?: boolean }[], o: Opts) {
  const s = cumulativeArcLength(P), L = s.at(-1)!;
  const N = Math.max(2, Math.round(L / h)), hEff = L / N;          // whole number of row pitches
  const last = o.closedEnd ? N - 1 : N;                             // closed end = gather, not a round
  const ideal = range(1, last).map(k => 2 * Math.PI * radiusAt(P, s, k * hEff) / w);
  const round1 = (x: number[]) => o.style === 'classic' ? batchCounts(x, o.sym ?? 6)
                                                       : hysteresis(x, o.deadband ?? 0.75);
  let n = o.symmetric ? mirrorHalf(ideal, round1) : round1(ideal);  // hysteresis is direction-dependent
  n = clampFeasible(n, o);
  const loop = range(1, last).map(k => crossesSharpCorner(P, s, (k - 1) * hEff, k * hEff) ? 'blo' : 'both');
  return { n, loop, hEff };
}
function hysteresis(x: number[], band: number): number[] {          // stops 23/24/23 flicker on cylinders
  const out: number[] = [];
  for (const v of x) { const p = out.at(-1); out.push(p === undefined || Math.abs(v - p) > band ? Math.round(v) : p); }
  return out;
}
function batchCounts(x: number[], sym = 6, first = 6): number[] {    // classic look: changes in multiples of 6
  const out = [first];
  for (const v of x.slice(1)) {
    const p = out.at(-1)!;
    out.push([p - sym, p, p + sym].filter(c => c >= sym)
      .reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), p));  // ties keep p
  }
  return out;
}
function clampFeasible(n: number[], o: Opts): number[] {
  n[0] = clamp(n[0], o.ringMin ?? 5, o.ringMax ?? 8);
  for (let k = 1; k < n.length; k++) n[k] = clamp(n[k], Math.ceil(n[k - 1] / 2), 2 * n[k - 1]);  // fan 2
  if (o.convex) {                                                    // apex rule (sphere/cone/egg only)
    const pk = argmax(n);
    for (let k = 1; k <= pk; k++) n[k] = Math.max(n[k], n[k - 1]);
    for (let k = n.length - 2; k >= pk; k--) n[k] = Math.max(n[k], n[k + 1], o.closeMin ?? 5);
  }
  return n;
}

// ---------- even, staggered placement ----------
// changeIdx counts only rounds that HAVE changes (see §5 note)
function distribute(P: number, N: number, changeIdx: number, mode: 'alternate' | 'golden' = 'alternate'): Op[] {
  if (N === P) return Array(P).fill('sc');
  const phase = mode === 'golden' ? frac(changeIdx * 0.6180339887) : (changeIdx % 2) * 0.5;
  let kinds: Op[];
  if (N > P) {
    const d = N - P; if (d > 2 * P) throw new Infeasible('needs >3 sts in one: insert a round');
    const n3 = Math.max(0, d - P);                     // sites that must take 3 sc
    kinds = interleave('inc3', n3, 'inc', d - 2 * n3);  // sites = d - n3
  } else {
    const d = P - N; if (3 * N < P) throw new Infeasible('needs more than sc3tog: insert a round');
    const k3 = Math.max(0, 2 * d - P);                  // sc3tog count so consumption fits
    kinds = interleave('dec3', k3, 'dec', d - 2 * k3);
  }
  const m = kinds.length, start = (j: number) => Math.floor((j + phase) * P / m);
  const seq: (Op | '-')[] = new Array(P);
  for (let j = 0; j < m; j++) {                         // group j = stitches [start(j), start(j+1)) (wraps)
    const size = (j + 1 < m ? start(j + 1) : start(0) + P) - start(j), c = CONS[kinds[j]];
    for (let t = 0; t < size - c; t++) seq[(start(j) + t) % P] = 'sc';
    seq[(start(j) + size - c) % P] = kinds[j];          // change at the end of its group
    for (let t = 1; t < c; t++) seq[(start(j) + size - c + t) % P] = '-';  // consumed by a dec
  }
  return rotateSoNoDecStraddlesMarker(seq).filter(x => x !== '-') as Op[];
}

// ---------- loop folding (AmiGo order: sequences first, then stitches) ----------
function fold(ops: Op[]): string {
  let best: { a: number; L: number; r: number } | null = null;     // maximise r*L, then prefer small L
  for (let L = 2; L <= ops.length >> 1; L++)
    for (let a = 0; a + 2 * L <= ops.length; a++) {
      let r = 1; while (a + (r + 1) * L <= ops.length && sameBlock(ops, a, a + r * L, L)) r++;
      if (r > 1 && runCount(ops.slice(a, a + L)) > 1 && better({ a, L, r }, best)) best = { a, L, r };
    }
  if (!best) return rle(ops);                          // e.g. "21 sc, inc, 22 sc"
  const { a, L, r } = best;
  return [rle(ops.slice(0, a)), `(${rle(ops.slice(a, a + L))}) x${r}`, rle(ops.slice(a + r * L))]
    .filter(Boolean).join(', ');
}

// ---------- Path B: constrained DTW coupling + transducer ----------
// State (i, j, fa, fb): fa = tops already on A[i], fb = bases already on B[j].
//   D (i+1, j+1)            -> fa = fb = 1                 (sc)
//   H (i, j+1) if fb == 1 && fa < maxFan -> fa + 1         (A[i] is an increase)
//   V (i+1, j) if fa == 1 && fb < maxFan -> fb + 1         (B[j] is a decrease)
// cost += |A[i] - B[j]| (+ fanPenalty on H/V steps); endpoints (0,0) and (n-1,m-1) fixed at the seam.
// Returns null when infeasible -> caller retries with maxFan = 3, else inserts an isoline at (k - 0.5)·h'.
function coupleRows(A: Vec3[], B: Vec3[], maxFan = 2, fanPenalty = 0.15 * w): [number, number][] | null { /* DP */ }

function transduce(pairs: [number, number][], n: number, m: number): Op[] {
  const da = degreeA(pairs, n), db = degreeB(pairs, m); const ops: Op[] = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (da[i] > 1)      { ops.push(da[i] === 2 ? 'inc' : 'inc3'); j += da[i]; i += 1; }
    else if (db[j] > 1) { ops.push(db[j] === 2 ? 'dec' : 'dec3'); i += db[j]; j += 1; }
    else                { ops.push('sc'); i++; j++; }
  }
  return ops;                                          // validators R1/R6 re-check conservation
}

// ---------- Path B driver (per part) ----------
function partPattern(part: Part, o: Opts): PartPattern {
  const seed = part.seed ?? chooseSeed(part);                      // tip far from the attachment boundary
  let t = meanEdge(part.mesh) ** 2, f = heatGeodesic(part.mesh, seed, t);
  while (adjacentCriticalPoints(f) && t < o.tMax) f = heatGeodesic(part.mesh, seed, t *= 2);  // AmiGo §9.1
  const L = max(f), N = Math.round(L / h), hEff = L / N;
  const rows = range(1, N - 1).map(k => isoline(part.mesh, f, k * hEff));
  if (rows.some(r => r.loops > 1)) throw new NeedsSplit(part);      // saddle inside the part
  const seam = geodesicPath(part.mesh, seed, argmaxVertex(f));
  const n = slopeLimit(hysteresis(rows.map(r => r.length / w), 0.75), o);
  const pts = rows.map((r, k) => sampleUniform(r, n[k], intersect(r, seam)));
  const rounds = pts.slice(1).map((B, k) => {
    const pairs = coupleRows(pts[k], B, 2) ?? coupleRows(pts[k], B, 3) ?? splitRowAndRetry(k);
    return { n: B.length, ops: transduce(pairs, pts[k].length, B.length), loop: creaseLoop(part, k) };
  });
  return regularizeIfAxisymmetric(part, rounds);       // swap in distribute() when radial residual < 10 %
}
```

[I] **What the prototype confirmed** (on noisy concentric rings):
- With max fan 2, the constrained DTW gives 18→24 = 12 sc + 6 inc, 36→34 = 32 sc + 2 dec, and 6→12 = 6 inc.
- With max fan 3, 6→12 degrades to `2 sc + 2 inc3 + 2 inc`. That is why we try fan 2 first and add a fan penalty.
- Unconstrained minimum-sum DTW never produced a "corner", i.e. a stitch that is both an increase and a decrease. This is expected: when all costs are positive, a corner can always be replaced by a cheaper diagonal step.

### 6.7 Validity rules (unit-testable)  [I]

| # | Rule | Test |
|---|---|---|
| R1 | Conservation | Σ CONS(op) = n_{k−1} and Σ PROD(op) = n_k for every round |
| R2 | Start | Magic ring: 5 ≤ n₁ ≤ 8 (classic 6). Chain oval: n₁ = 2·(chain − 1) + end extras. Joint start: Σ live parent stitches + 2·chains. |
| R3 | Fan | At most 2 sts worked into one stitch and 2 together by default; inc3 / sc3tog only with a warning |
| R4 | Growth bounds | ⌈n_{k−1}/2⌉ ≤ n_k ≤ 2·n_{k−1} |
| R5 | Curvature plausibility | \|n_k − n_{k−1}\| ≤ ⌈2πh/w⌉ (7 for h = w); beyond that, warn "ruffle / negative curvature" unless intended |
| R6 | No corner | No stitch is part of both an inc and a dec |
| R7 | Even spacing | Gaps between changes within a round differ by ≤ 1 stitch (Path A and the readability pass) |
| R8 | Stagger | Between consecutive *change* rounds, the minimum angular offset of change sites is ≥ 1/(4·d) of a round |
| R9 | Closure | A closed end finishes at n ≤ 8, followed by "gather through front loops"; never below 4 |
| R10 | Round trip | `expand(fold(ops))` deep-equals `ops`; the printed "(n)" equals Σ PROD |
| R11 | Size | \|N·h′ − L\| ≤ h/2; \|max(n)·w − 2π·r_max\| ≤ w; stuffed preview within 5 % of target |
| R12 | Color | Runs ≥ 2 stitches (or flagged as embroidery); ≤ 3 colors per round; a change instruction precedes every color boundary |
| R13 | Assembly | Each non-root part attaches exactly once; the coordinate exists (1 ≤ round ≤ N, 1 ≤ stitch ≤ n_round); mirrored pairs satisfy the mirror formula; attachments form a tree |
| R14 | Minimum part | Circumference ≥ 5 stitches; otherwise use a chain / I-cord or embroidery |
| R15 | Sanity | Integers ≥ 1; fewer than 200 rounds and 20,000 stitches per part (UI limits) |

**Golden tests**
- The classic n = 6 sphere reproduces the counts in §4.1.
- With `h = 0.9w`, we reproduce Avtanski's C = 36 sphere except the clamped poles.
- The crochet-cad ball and donut formulas match to ±1 stitch.
- The §5 examples round-trip through R1–R10.

### 6.8 Failure modes and mitigations  [I]

| Failure | Mitigation |
|---|---|
| Noisy mesh creates spurious saddles | Raise heat-method t (as AmiGo does) and/or smooth f; merge segments thinner than 2 rows or 5 stitches (AmiGo skips them) |
| Seed placed on a feature gives warped rows | Auto-seed at extremal tips; the user can drag it |
| Hexagon look / visible increase lines | Staggered or golden-ratio phase (R8) |
| Holes at stacked decreases | Stagger the decreases; invisible decrease; hook 1–2 sizes smaller |
| Piece cups or ruffles | R5 warning; recalibrate h/w (yarn over vs. yarn under) |
| Craters | Inflate them, or emit needle-sculpt notes |
| Thin long parts (tails, antennae) | R14 |
| Symmetric input, asymmetric result (AmiGo's stated limit) | Mirror parts, seam on the symmetry plane |
| Jog in striped spirals | Joined rounds for the striped section |
| Depth errors from a single image (R3) | Prefer primitive fitting and the editable model over raw mesh fidelity |

### 6.9 Default parameters  [I]

| Parameter | Default |
|---|---|
| h/w without a swatch | 1.0 (yarn over), 0.9 (yarn under) |
| Magic ring | 6 (allowed 5–8) |
| Hysteresis band | 0.75 st |
| Max fan | 2 (fallback 3 with a warning) |
| Stagger | alternate ½ group per change round (classic); golden-ratio phase (exact) |
| Classic batch size | 6 (4 for parts with n < 18) |
| BLO trigger | profile turn ≥ 45° |
| Heat t | (mean edge length)² × 2ᵏ |
| Remesh edge | min(w, h)/3 |
| Minimum segment | 2 rows / 5 sts |
| Colors | k ≤ 6, ΔE merge 10, minimum run 2, ≤ 3 colors per round |
| Preview | position-based dynamics, 300 iterations, pressure set by stuffing firmness |

---

## 7. Validation plan and open questions  [I]

1. **Unit tests.** R1–R15 on every generator, plus the golden outputs in §6.7.
2. **Property tests.**
   - Random lathe profiles must satisfy R1–R11.
   - Random meshes (sphere, capsule, bent tube, Y-shape) must give valid Path B segments.
3. **Physical calibration set:**
   - a 20 × 20 swatch;
   - a C = 36 sphere, classic vs. geodesic;
   - a cone with 6 increases every 3 rounds;
   - a cylinder with a BLO base;
   - a 3-part bear from Path A.
   - Measure the stuffed dimensions against the target (goal ±10 %). Log h/w and the stretch factor for each yarn and hook.
4. **Open questions.**
   - How to compensate spiral slant (AmiGo sidestepped it with joined rounds).
   - Good default amigurumi gauges per yarn weight (the CYC ranges are garment gauges).
   - Which automatic segmentation best matches the parts a designer would choose.
   - The exact file format Claude Design returns (covered in a separate doc).

---

## Sources

**Papers**
- AmiGo — Edelstein, Peleg, Itzhaky, Ben-Chen, SCF 2022: https://arxiv.org/abs/2211.01178 · https://doi.org/10.1145/3559400.3562005
- Ben-Chen & Edelstein, *Amigurumi Crochet Patterns from Geodesic Distances*, Bridges 2024: https://archive.bridgesmathart.org/2024/bridges2024-369.pdf
- Igarashi, Igarashi & Suzuki, *Knitting a 3D Model*, Pacific Graphics 2008: https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/yuki_pg08_knit.pdf
- Greer & Mould, EG Expressive 2025: https://diglib.eg.org/bitstream/handle/10.2312/exw20251057/exw20251057.pdf
- Kekkonen, *Crocheting Mathematics*, 2025: https://arxiv.org/html/2508.10597
- CrochetBench: https://arxiv.org/abs/2511.09483
- Dias & Karim, AAAI Summer Symposium 2025: https://ojs.aaai.org/index.php/AAAI-SS/article/view/36054
- CT2Yarn: https://arxiv.org/html/2609.06950v1
- Guo et al., SCF 2020: https://doi.org/10.1145/3424630.3425409
- Seitz et al., Onward! 2022: https://dl.acm.org/doi/10.1145/3563835.3567657

**Algorithms and geometry libraries**
- Heat method (Crane): https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/
- CGAL surface mesh segmentation: https://doc.cgal.org/latest/Surface_mesh_segmentation/index.html
- CGAL mean-curvature skeleton: https://doc.cgal.org/latest/Surface_mesh_skeletonization/index.html
- glTF 2.0 specification: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html

**Tools and code**
- Avtanski Sphere Calculator: http://avtanski.net/projects/crochet/ (sample output: http://avtanski.net/projects/crochet/cgi-bin/sphere.cgi?cir=36)
- Avtanski Crochet Lathe: http://avtanski.net/projects/crochet/lathe/
- crochet-cad: https://github.com/judy2k/crochet-cad
- fibertools Amigurumi Shapes: https://fibertools.app/amigurumi-shapes
- CrochetPARADE manual: https://www.crochetparade.org/Manual.html
- CrochetPARADE repo: https://github.com/crochetparade/CrochetPARADE
- CrochetPARADE Remesher: https://github.com/stassev/CrochetPARADE_Remesher
- CrochetPhoto2Pattern: https://github.com/paulkooer/CrochetPhoto2Pattern
- AmiGo Python port: https://github.com/karinsifri/AmiGo
- Patternize: https://apps.apple.com/us/app/patternize/id6758268844
- CrochetPop: https://learn.crochetpop.app/
- Amigurumake 3D Studio: https://amigurumake-studio.com/features/3d-studio
- Makyrie (ChatGPT duckling test): https://makyrie.com/crocheting-an-ai-generated-amigurumi/

**Craft technique and standards**
- Craft Yarn Council yarn weights: https://www.craftyarncouncil.com/standards/yarn-weight-system
- Yarn.com (hook size for amigurumi): https://www.yarn.com/blogs/the-yarn-diary/best-yarn-for-amigurumi-how-to-choose-yarn-for-crochet-toys
- PlanetJune:
  - invisible decrease: https://www.planetjune.com/blog/amigurumi-help/invisible-decrease/
  - better BLO: https://www.planetjune.com/blog/tutorial-better-blo-stitches-for-amigurumi/
  - changing colour: https://www.planetjune.com/blog/amigurumi-help/changing-colour/
  - stripes comparison: https://www.planetjune.com/blog/the-cleanest-stripes-in-amigurumi-a-comparison/
  - ultimate stripes: https://www.planetjune.com/blog/amigurumi-help/ultimate-stripes-for-amigurumi/
  - seamless join: https://www.planetjune.com/blog/amigurumi-help/how-to-make-a-seamless-join-in-amigurumi/
  - positioning eyes: https://www.planetjune.com/blog/positioning-amigurumi-eyes/
  - yarn over vs yarn under: https://www.planetjune.com/blog/yarn-over-vs-yarn-under-in-crochet/
  - amigurumi help index: https://www.planetjune.com/blog/amigurumi-help/
- Staggered increases: https://www.andshelaughsblog.com/crocheting-perfect-circle-staggered-increases-decreases/
- Flat-circle math: https://doradoes.co.uk/2020/12/12/how-to-crochet-a-flat-circle/ · https://sarahmaker.com/crochet-flat-circle/
- Classic sphere: https://zamiguz.com/crochet-sphere/
- Ovals around a chain: https://www.allaboutami.com/foundationchain/ · https://www.hookedbykati.com/ovals-around-a-chain/
- Join-as-you-go limbs: https://www.crochet365knittoo.com/joining-amigurumi-limbs-an-easy-technique

---

## Verification notes

Adversarial fact-check run on 2026-09-30. Where possible we used sources other than the ones the report cites: the PDFs were re-extracted locally with pypdf, repos were read through the GitHub API, DOIs were checked on Crossref, the Avtanski CGIs were re-queried, and every numeric example was recomputed in Python.

**Confirmed against the primary text or code**

- **AmiGo** (arXiv PDF, re-extracted):
  - Authors and venue: SCF '22, Seattle; DOI 10.1145/3559400.3562005.
  - Rows and stitches: geodesic isolines from one seed; the (f, g) grid of width w; minimal coupling by DTW (Gold & Sharir; Sakoe & Chiba).
  - Transducer: linear-time and "essentially deterministic". Loop folding goes sequences first, then stitches, then rows (Lee et al. 1994).
  - Heat method: t = mean edge length², multiplied by increasing powers of 2 until no neighbouring saddles or extrema remain (§9.1). Models are normalized to surface area 1 (§7.1).
  - Craters (K > 0, H < 0) are removed by localized conformal MCF.
  - Saddles: h(x) = tanh(−x/α)/2 + 1 with α = 10, so h stays in (0.5, 1.5).
  - Creases: BLO for positive curvature, FLO for negative; the user can turn this off.
  - Branching (§7.2): saddles are sorted by f, segments form a DAG worked in topological-sort order, thin segments are skipped, and there is a "joint" previous row and join-as-you-go.
  - Table 2: 11 models, 30–60 rows, 1–8 segments, 365–3,670 stitches, 0.2–6.9 min on an Intel Core i7. The Teddy appears at 60 rows / 3,670 sts and 30 rows / 880 sts.
  - Fig. 2 sphere counts: 7, 12, 17, 21, 23, 24, 24, 21, 17, 12, 7.
  - Stated limits: closed surfaces only, thin segments, no symmetry, single seed. No quantitative error metric is reported.
- **Bridges 2024**:
  - authors Ben Chen & Edelstein;
  - row height ≈ sc width; rectangular sc "can also" be handled;
  - joins and turns each round instead of spiralling, because of slant;
  - "fewer stitches" in saddle-like areas;
  - future work: color, taller stitches, yarn amount;
  - standardisation is needed for interoperability;
  - recruited testers.
- **Igarashi, Igarashi & Suzuki, PG 2008** (CGF 27(7); pp. 1737–1743 per the AmiGo bibliography):
  - 1,000–3,000 vertices on a 1.1 GHz Pentium M;
  - manual segmentation, with the "different segmentations yield very different final results" quote;
  - hole filling into a "bowl";
  - inward iso-contours of 3D Euclidean distance, traced with marching triangles;
  - at a branch the largest loop continues;
  - medial axis collapse at the end;
  - resampling at the contour interval;
  - nearest-neighbour union meshing; end points get 5–8 connections; quads = regular, triangles = inc/dec;
  - random start point; rows reversed;
  - Plushie preview; painting; total knitting time and yarn length;
  - X/V/Λ marks in the standard Japanese format;
  - limitation quotes ("each row forms a circle", "very different from hand-designed").
- **Kekkonen 2025**: 2πH/W per round; (2πS/W)·sin(Hℓ/S); the sinh case; the H = 0.4 cm, W = 0.5 cm example.
- **Dora Does**: 20 sts × 20 rows per 10 cm → 31.4 / 5 = 6.28 → 6.
- **Avtanski Sphere C = 36** (re-fetched):
  - 5 in the magic circle, then 11 … 36 36 36 … 11, then 5;
  - `4sc, inc, 15sc, inc, 11sc`;
  - inc2/dec2 at the poles; spiral working; invisible decreases; the "tightly packed" note.
  - Our fit with N = 20 (h = 0.9w) reproduces every round except the poles (6 vs 5).
- **Avtanski Lathe** (re-probed):
  - rounds of 31 = round(2π·5);
  - about +7 per round on the discs and −7 when closing;
  - 9 wall rounds for a wall 10 units long (h ≈ 1.11w);
  - "BACK loops only" before the first wall round and before the first decrease round;
  - dec2/dec3 at the close.
- **crochet-cad** (source read through the GitHub API): the ball, donut and cone formulas exactly as stated; snapping to multiples of 6 unless `--accurate`; `gcd(count, prev)` repeats with no stagger; GPL-3; © 2010–2011 Mark Smith.
- **CrochetPARADE Remesher**:
  - GPL-3.0-or-later; Rust; created 2026-05;
  - defaults θ_slip 35°, θ_dec 65°, θ_inc 120°;
  - `auto_l` = bbox diagonal / 50; `max_zip_dist` 1.5·L;
  - magic ring or starting-chain seeds; multiple yarns; relaxation ladder; snapshot backtracking.
- **CrochetPARADE manual**:
  - iterations 500, learning_rate 0.1;
  - inflate "reasonable values 0.5–3.0" (default infinity);
  - GLTF / STL / OBJ / SVG / DOT exports;
  - the listed syntax and `TRANSFORM_OBJECT:`.
- **CrochetPhoto2Pattern** (MIT; README):
  - the pipeline order;
  - part instances, mirrored pairs and anchors with confidence;
  - exit code 2;
  - CrochetPARADE export as a "second-tier" check;
  - photo generalization and physical crochetability "not established";
  - no depth, hidden attachments or absolute scale from a single photo.
- **AmiGo Python port**: CC BY-NC-SA 4.0; "Branching meshes are not supported yet"; `stitch_size 0.04`; `use_creases`.
- **CrochetBench** (Li, Huang, Hua, Chawla; ACL 2026): 6,085 Yarnspirations patterns across 55 categories; NL/image → CrochetPARADE DSL; the "performance sharply decreases…" finding.
- **Makyrie**: ChatGPT-5 duck pattern; round 5 needs 20 sts, but "there are only 18".
- **Dias & Karim** (Heriot-Watt): DeepSeek-R1-Distill-Llama-8B, 74 %.
- **CT2Yarn** (Luo & Umetani, PG 2026): amigurumi named as a further challenge, because of multiple strands plus filling.
- **Greer & Mould**:
  - (1−λ)E_L + λC; λ = 0.65, and 0.9 for the bunny head and body;
  - Ceres solver;
  - legs 318 and arms 264 sts in < 5 s; head 798 and body 708 not converged after "well over two minutes";
  - "unintuitive segmentation";
  - taller-than-wide stitches and the swatch suggestion;
  - 6-point spiral; apple constraint edge;
  - flattened ears out of scope;
  - Amigurum.io and Plushify descriptions;
  - EnbyMonkey repository.
- **Guo et al. SCF 2020** and **Seitz et al. Onward! 2022**: DOIs resolve, via Crossref. Storck et al. 2022 (meso-scale, FEM in LS-DYNA), StitchFlow (UIST 2025) and Loom-Based Mechanized Crochet (SCF Adjunct 2025) all exist.
- **CYC table** (all 7 rows and "GUIDELINES ONLY"): matches. **Yarn.com**: "Go down 1–2 hook sizes. If your yarn label says 5mm, use a 3.5mm or 4mm."
- **Practitioner pages**:
  - and she laughs: stacking gives hexagons; split the run on alternate rows; decreases leave smaller holes;
  - PlanetJune invisible decrease: front loops, yo through 2, yo through 2;
  - PlanetJune colour change: last loop of the previous stitch, plus the jog and dark-behind-light notes;
  - PlanetJune stripes comparison: 5 methods, recommending Invisible Join + No-Cut Join;
  - Ultimate Stripes: cut every round, move the join;
  - seamless join: both loops, "very tightly", stuff first because stitches stretch;
  - YO vs YU: the YU sample is smaller and its circle flatter;
  - better BLO: catches the back bar;
  - eye placement and the "6 stitches between posts" meaning.
- **Other tools and pages**: Bennett's join-as-you-go legs; zamiguz's "at least half" plain rounds; fibertools (6–30 rounds, plus the disclaimer); Patternize ($4.99/week to $79.99 lifetime; no accuracy disclaimer); CrochetPop quote; Amigurumake 3D Studio.
- **Libraries and standards**: CGAL SDF defaults (2π/3, 25 rays, 5 clusters, λ = 0.26); glTF `extras` and non-unique names; geometry-processing-js and three-mesh-bvh are both MIT.

**Formulas recomputed by hand or script (all match unless listed under "Changed")**

- Cone table: asin(6/(2πk)) gives 72.7 / 28.5 / 18.6 / 13.8 / 11.0 / 9.2°.
- Flat-circle increases: 2πh/w gives 5.0 / 5.7 / 6.3 / 6.9; "+6" ⇔ h ≈ 0.955w.
- Classic-sphere plain rounds: p = n(3w/h − 2). This is exact if the pole-to-round-1 and last-round-to-pole gaps each count as one interval.
- Geodesic C = 36 rows (h = w and h = 0.9w), and the AmiGo C = 24 comparison.
- §5 examples:
  - 3 in sphere: exact and classic (N = 24, hysteresis 0.75);
  - ellipsoid a = 1, c = 1.4 (N = 19);
  - cone: 16 rounds, α = 18.4°;
  - cylinder counts;
  - torus with K = 16;
  - oval 17 / 23 / 30 / 36.
- Every repeat in the 3 in sphere text (R1 conservation).
- The `distribute` inc3/dec3 algebra.
- The prototype's DTW stitch counts.
- Opening size m·w/π; the mirror formula; ⌈2πh/w⌉ = 7.

**Changed**

1. §1.3: dc increases "10–12" → 12 per round (10–12 is the starting count).
2. §1.5: Greer & Mould do not actually maximize volume; they minimize curvature with a fixed λ.
3. §2.2: the ShapeUp preview quote "very similar" → "quite similar" in the paper ("very similar" is the Bridges wording).
4. §2.3: Seitz et al. author order corrected (Seitz, Rein, Lincke, Hirschfeld).
5. §2.4: the AmiGo port does not *require* an interactive seed pick (`--seed` works). Its "community" status is unverified.
6. §3.1: the C = 100 mismatch is five rounds per hemisphere; C = 12 fits h = w, not 0.91w.
7. §3.2: the Lathe disc counts 8 → 15 → 22 → 29 could not be reproduced exactly. The +7 trend and the BLO behaviour were confirmed.
8. §3.5 / §3.8: CrochetPARADE's manual is CC BY-NC-SA 4.0 and `inflate` defaults to off. Depth-first search in the Remesher is unverified.
9. §4.1: the unstuffed classic n = 6 shell has height/diameter ≈ 0.83, not 0.92.
10. §4.4: All About Ami's oval example increases evenly around the round, not only at the ends.
11. §5: the closed-cylinder example and the `crossesSharpCorner` code disagree by one round on where BLO goes. This needs a design decision.

**Remaining doubts**

- The exact Lathe probe numbers in §3.2 (unverified).
- The PlanetJune seamless-join "pin" step (unverified).
- Whether the karinsifri port is author-affiliated (unverified).
- App prices change over time; Patternize's prices are as of 2026-09-30.
- The heat-method recommendation t = h² was confirmed only through AmiGo's text; Crane's project page does not state it.
- None of the §5 / §6 prototype outputs have been physically crocheted, so every h/w-dependent number still needs the §7 swatch calibration.
