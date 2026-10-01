# 04 — Photos → 3D mesh in the browser (multi-view, single image, segmentation)

**Scope.** This doc covers how the app turns photos into a 3D shape:

- R2: several photos → 3D.
- R3: one photo plus a "3D-ifier".
- The geometry inputs for R7 (the 3D editor) and R8 (colors and patterns).

Everything runs client-side: Vite + React + TypeScript + three.js / react-three-fiber. There is no server and no paid API.

**Date:** 2026-09-30.

**Evidence labels:**

- **[V]** verified against the linked primary source.
- **[M]** measured by us during this research (method and raw numbers in §11).
- **[I]** inference, design choice or recommendation.

**Coordinates** (same as `05-claude-design-roundtrip.md` §4.1):

- Units are inches. The frame is right-handed and **+Y is up**.
- The object's **front faces +Z**. The **object's own left is +X** (which is the viewer's right when facing it).
- The lowest point sits at y = 0.

**Related docs:**

- `01-gauge-and-sizing.md` — stitch size.
- `03-3d-amigurumi-generation.md` — mesh → rounds. This is the consumer of this doc's output.
- `05-claude-design-roundtrip.md` — the import path.
- `06-color-and-pattern-capture.md` — palette and per-stitch color voting.

---

## 0. TL;DR — decisions this research supports

1. **Use one canonical representation [I].** Store shape as a signed-distance volume (SDF, positive inside) on an N³ grid, plus per-view palette-label images. These all write into it:
   - multi-view carving;
   - single-image inflation;
   - depth fusion;
   - imported meshes (Claude Design);
   - editor brushes.

   One mesher reads it: marching cubes → cleanup → Taubin smoothing → validation. This gives us one code path to make watertight and debug.

2. **Multi-view uses a visual hull computed as an SDF.**
   - Take the minimum of per-view 2D signed-distance fields (exact EDT). With axis-aligned orthographic views this is separable: **38 ms at 128³ and 143 ms at 256³ [M]**.
   - Then round the depth (front–back) axis, which the views constrain least, using the **front-view inflation profile**. On a synthetic striped teddy, IoU rises from **0.841 to 0.922 [M]**.
   - **Never** apply the inflation profile from side or top views. On the same teddy, IoU collapses to **0.37 [M]**.
3. **Minimum photo set for geometry: front, one side, top [M].** Under the orthographic assumption, the back and the other side add **zero** carving information (IoU is identical with 3 or 5 views). They are still needed for **colors**, and as redundancy against bad masks.
4. **Single image: start from inflation, optionally add depth.**
   - Distance-transform inflation with *local thickness* takes about 45 ms per 512² mask **[M]**. It gives a closed, rounded shape instantly and offline.
   - Depth Anything V2 Small (Apache-2.0, 19–99 MB depending on dtype [V]) adds relief.
   - In our synthetic test, IoU went from **0.79 (inflation) to 0.85 (depth + inflation)**, and to **0.89** with the right "thickness" factor **[M]**. Expose that factor as a slider.
5. **Depth model speed in the browser.**
   - Depth Anything V2 Small on onnxruntime-web WASM at 518²: **≈2.7 s on 1 thread, ≈0.8 s on 4 threads** (Apple M3 Pro) **[M]**.
   - WebGPU: "under 200ms" was reported by the transformers.js author for Depth Anything (V1) Small, which has the same backbone size [V]. Re-measure in our app (§13).
   - Multi-threaded WASM needs cross-origin isolation (COOP/COEP headers) [V].
6. **Segmentation fallback ladder.**
   - A zero-download classical path is always available: border flood fill + color-distance threshold + user brush, optionally refined with OpenCV.js GrabCut (123 ms at 512² [M]).
   - Small models: SlimSAM / MediaPipe MagicTouch (click-to-segment) and MODNet (portraits).
   - The best automatic models (BiRefNet_lite, BEN2; both MIT) are **effectively WebGPU-only**. BiRefNet_lite fails on WASM with `std::bad_alloc` **[M]**.
   - **Do not ship `@imgly/background-removal` (AGPL-3.0)**. **Do not bundle BRIA RMBG weights** (non-commercial licenses) [V].
7. **Generative image-to-3D is not practical in-browser in 2026.** TripoSR, SF3D, Hunyuan3D-2.1, TRELLIS.2 and SHARP need:
   - GB-scale weights;
   - 6–29 GB of VRAM;
   - CUDA/Linux;
   - or have research-only licenses [V].

   The only browser port we found (TripoSplat-WebGPU) is a **6.47 GB** download and takes **≈248 s per image on an M3 Max with 128 GB** [V]. The "high-quality" path is the Claude Design round trip (`05`).
8. **Mesh hygiene.**
   - Clamp the marching-cubes interpolation parameter to `t ∈ [0.01, 0.99]`. This removes the zero-area triangles that made manifold-3d split a valid closed mesh into 4–14 parts **[M]**.
   - Validate with manifold-3d (genus and parts count).
   - Keep decimation moderate. A 9× reduction with meshoptimizer created non-manifold edges **[M]**.
9. **Project palette labels, not RGB, with an occlusion test [M].** On the striped teddy, the best-facing *visible* view gets **96.6 %** of vertices right. Without the occlusion test it gets **93.1 %**.
10. **Resolution defaults [M + I].**
    - **N = 128** by default. Carve → rounding → MC → smoothing → validation takes ≈0.25 s in a worker. Including 2D prep, cleanup and label projection it is ≈0.5 s end-to-end.
    - N = 64 for live previews.
    - N = 192 for "high".
    - All ML models are optional, lazy-loaded and cached.

---

## 1. What "good enough" means for crochet

**Detail below one stitch is useless [I].** For an item of height `H` (in) at row gauge `g` (rows/in), there are about `H·g` rounds from bottom to top. The object occupies about 80 % of the grid (10 % padding per side keeps marching cubes closed). So:

```
voxels_per_round ≈ 0.8·N / (H·g)
```

- **Example:** an 8 in plush at an illustrative 5 rounds/in has 40 rounds. Take actual gauges from `01`.
  - N = 96 gives 1.9 voxels per round.
  - N = 128 gives 2.6.
  - N = 192 gives 3.8.
- **Sizing N from doc 03.** Doc 03's Path B wants triangle edges of about `min(w, h)/3`, where w and h are the stitch width and height. MC edge lengths are about 0.5–1.4 voxels.
  - So pick `N ≈ H / (0.8 · min(w, h)/3)` and the MC mesh is already the right density [I].
  - Example: an 8 in item with `min(w, h) ≈ 0.2 in` needs N ≈ 150. Voxel size is 0.078 in at N = 128 and 0.0625 in at N = 160.
  - Clamp N to [64, 192] and scale it with item size.
  - This also argues against aggressive decimation, which makes triangles irregular [I].

**Output contract for doc 03 (Path B) [I]:**

- Watertight, 2-manifold, outward-oriented triangle mesh.
- Ideally **one genus-0 shell per crochetable part**. AmiGo's reference implementation states "Branching meshes are not supported yet. Shapes with limbs, ears, or other appendages … will not produce a correct pattern" ([AmiGo repo](https://github.com/karinsifri/AmiGo)) [V]. So we also output a **part decomposition** (§6.6).
- Scaled to inches using the requested finished size, in the shared axis convention.
- Per-vertex **palette label** (`Uint8`), plus the per-view label images and view definitions, so doc 06 can re-vote per stitch.

---

## 2. Architecture: everything becomes an SDF volume

```
 photos ──► [ml.worker] segmentation (classical | SlimSAM | MODNet | BiRefNet/BEN2 on WebGPU)
            [ml.worker] monocular depth (optional, Depth Anything V2 Small)
                 │ masks (Uint8), label images (Int8 palette ids), disparity (Float32)
                 ▼
 [geom.worker] 2D: signed EDT per view, local thickness, inflation height T(u,v)
               3D: SDF volume f(x,y,z) on N³ (positive inside)
                    ├─ R2 multi-view: separable carving + front-view rounding
                    ├─ R3 single view: inflation (+ depth relief)
                    ├─ R6 imported mesh (Claude Design GLB/OBJ/STL): mesh → SDF (BVH) or voxel remesh
                    └─ R7 editor: SDF brushes, smooth union, part scaling
               cleanup (largest component, cavity fill, optional closing)
               marching cubes (indexed, t-clamped) → Taubin → (moderate) decimation
               validate (manifold-3d: parts, genus) → parts (opening) → label projection
                 │ ColoredMesh { positions, indices, labels, partId }  (transferable buffers)
                 ▼
 main thread: R3F viewer/editor; pattern generator (doc 03); colors (doc 06)
```

```ts
type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | { yawDeg: number; pitchDeg: number };
interface ViewInput { id: string; dir: ViewDir; mask: Uint8Array; labels: Int8Array; w: number; h: number; }
interface Volume { N: number; bmin: [number, number, number]; voxel: number; sdf: Float32Array; }
interface ColoredMesh {
  positions: Float32Array; indices: Uint32Array;
  labels: Uint8Array;       // palette id per vertex (255 = unknown)
  partId: Uint8Array;       // part per vertex (0 = body)
  unitsPerInch: number;
}
```

The SDF is the editable source of truth for R7 [I]. A brush stroke changes the field and re-meshes a dirty sub-block. At N = 128, the whole field re-meshes in about 0.1 s (MC 91 ms [M]), which is interactive enough for "fix the shape" edits. Fine sculpting can operate on the mesh with three-mesh-bvh, whose examples include a sculpting demo ([three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)) [V].

---

## 3. Step A — foreground segmentation in the browser

### 3.1 Model options (sizes from the HF file trees; licenses from model cards)

WASM times are **[M]**: Node 20.18, onnxruntime-web 1.30.0 WASM EP, Apple M3 Pro, random input, warm runs.

| Model | HF id | License [V] | ONNX files [V] | Input | WASM 4 threads / 1 thread [M] | Notes |
|---|---|---|---|---|---|---|
| MODNet | `Xenova/modnet` ([card](https://huggingface.co/Xenova/modnet)) | Apache-2.0 | fp32 25.9 MB, fp16 13 MB, q8 6.63 MB ([tree](https://huggingface.co/Xenova/modnet/tree/main/onnx)) | shortest edge 512 | **0.24 s / 0.83 s** (fp32) | Portrait matting ("Remove background from portraits") [V]. A practitioner's "light CNN, Apache-2.0, optimized for people" default (probably this class of model; the article does not name it) was poor on "illustrations, dark indoor scenes, cluttered framing" ([dev.to](https://dev.to/androve2k/removing-a-photos-background-in-the-browser-with-no-upload-ai-licenses-onnx-models-and-a-1cc0)). Not for plush or objects [I]. |
| RMBG-1.4 | `briaai/RMBG-1.4` ([card](https://huggingface.co/briaai/RMBG-1.4)) | **bria-rmbg-1.4: non-commercial; commercial use needs a paid agreement** | fp32 176 MB, fp16 88.2 MB, q8 44.4 MB ([tree](https://huggingface.co/briaai/RMBG-1.4/tree/main/onnx)) | 1024² | **2.05 s / 7.2 s** (q8) | IS-Net based, 44.1 M params [V]. Opt-in only, never bundled [I]. |
| RMBG-2.0 | `briaai/RMBG-2.0` ([card](https://huggingface.co/briaai/RMBG-2.0)) | **CC BY-NC 4.0, gated** | — | 1024² | not tested | BiRefNet-based, 0.2 B params [V]. Excluded [I]. |
| BiRefNet_lite | `onnx-community/BiRefNet_lite-ONNX` ([card](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)) | MIT | fp32 224 MB, fp16 115 MB ([tree](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/tree/main/onnx)) | **fixed 1024²** | **fails: `std::bad_alloc`** (1 and 4 threads) | WebGPU-only in practice [M]. The input dims are fixed: running at 512 errors with "invalid dimensions" [M]. The 512² variant is the full BiRefNet: 940 MB fp32 / 473 MB fp16 ([API](https://huggingface.co/api/models/onnx-community/BiRefNet_512x512-ONNX/tree/main/onnx)). |
| BEN2 | `onnx-community/BEN2-ONNX` ([card](https://huggingface.co/onnx-community/BEN2-ONNX)) | MIT (base model [PramaLLC/BEN2](https://huggingface.co/PramaLLC/BEN2): MIT, 94.6 M params) | **fp16 only, 219 MB** | 1024² | not tested (fp16 → WebGPU) | This is the example model of the `background-removal` pipeline added in transformers.js **3.4.0** (npm: 2025-03-07) ([release](https://github.com/huggingface/transformers.js/releases/tag/3.4.0)). |
| SlimSAM | `Xenova/slimsam-77-uniform` ([card](https://huggingface.co/Xenova/slimsam-77-uniform)) | Apache-2.0 | encoder q8 8.88 MB + decoder q8 4.9 MB ([tree](https://huggingface.co/Xenova/slimsam-77-uniform/tree/main/onnx)) | 1024² | encoder **1.05 s** (4 threads) | Click prompts (`input_points`). Encode once; each click only runs the small decoder [V]. |
| MediaPipe MagicTouch | `@mediapipe/tasks-vision` 1.0.1 | Code Apache-2.0 [V]. Weights: read the model card before shipping (not verified here). | 6.2 MB tflite ([file](https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/latest/magic_touch.tflite)) | — | Google: Pixel 10 CPU 208 ms ([guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter)) | Point or stroke prompt; returns a float confidence mask. Its calls "run synchronously and block the user interface thread", so run it in a worker ([web guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)) [V]. |
| ISNet via `@imgly/background-removal` 1.7.0 | npm | **AGPL-3.0** (LICENSE.md in the package) | "small (~40 MB)" quantized; "medium (~80MB) is the default" (package README) | 1024 | ISNet on an M4 Mac: WASM 1,960–2,133 ms vs WebGPU 209–359 ms ([dev.to](https://dev.to/yue_shu_c621a4a637f22396f/webgpu-vs-wasm-in-onnxruntime-web-14x-to-94x-faster-on-the-same-mac-depending-on-the-model-li5)) | The README asks for COOP/COEP headers for speed [V]. **Excluded unless the whole app becomes AGPL [I].** |

**WebGPU vs CPU for these models [V]:**

- img.ly measured ISNet on an M3 Max:
  - single-threaded, no SIMD: about **53 s**;
  - 16 threads + SIMD: about **2.0 s**;
  - WebGPU fp16: about **100 ms**.
- Session start-up adds about **200–400 ms**.
- They rejected QUINT8 for visible artifacts.

Source: [img.ly blog, 2024-06-11](https://img.ly/blog/browser-background-removal-using-onnx-runtime-webgpu/).

### 3.2 Classical fallback (zero download, always available) [I]

Most plush and product photos are shot on a plain surface. A border-seeded color model handles them; the brush fixes the rest.

```ts
function classicalMask(img: ImageData, opts = { band: 0.04, tauLab: 14, closeR: 2 }): Uint8Array {
  const lab = toOKLabOrCIELab(img);                  // doc 06 uses OKLab
  const bg = kmeans(sampleBorderBand(lab, opts.band), 3); // 1–3 background clusters (walls, floor, shadow)
  const bgLike = (i) => minDist(lab[i], bg) < opts.tauLab;
  const isBg = floodFillFromBorder(bgLike);          // connected background only, so the object's own
                                                     // white/cream areas are not removed
  let fg = not(isBg);
  fg = keepLargestComponent(fg);
  fg = fillHoles(fg);                                // default ON (see the hole caveat in §12)
  fg = morphClose(morphOpen(fg, 1), opts.closeR);
  return fg;                                         // then the user brush: +/− strokes, re-run the last 3 steps
}
```

- **Optional refinement.** OpenCV.js `cv.grabCut(src, mask, rect, bgd, fgd, iters, cv.GC_INIT_WITH_MASK)` is available in `@techstark/opencv-js` 5.0.0-release.1 (Apache-2.0).
  - We verified `grabCut`, `distanceTransform`, `floodFill`, `watershed` and `connectedComponentsWithStats` exist **[M]**.
  - Runtime init took 136 ms. GrabCut on 512² with 3 iterations took **123 ms** **[M]**.
  - Cost: the bundle is **13.3 MB (3.76 MB gzipped)** **[M]**, so lazy-load it only when the user clicks "refine".
- **GrabCut itself:** Rother, Kolmogorov & Blake, SIGGRAPH 2004 ([PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2004/08/siggraph04-grabcut.pdf)).
- **Shadow heuristic [I].** On the floor near the object, pixels darker than the local background but with similar chroma are probably shadow. Move them to background when `ΔL < −10` and `Δchroma < 6`, and only inside the bottom 25 % of the bounding box.

### 3.3 Recommended cascade [I]

| Order | Method | Speed | Behavior |
|---|---|---|---|
| 1 | Classical mask | instant | Always run first. |
| 2 | Automatic ML upgrade | — | If WebGPU is available and the user opted into the larger download: **BiRefNet_lite fp16 (115 MB)** or **BEN2 fp16 (219 MB)**. |
| 3 | Interactive ML | — | Otherwise offer "click the object": **SlimSAM q8 (≈14 MB)** or **MagicTouch (6.2 MB)**. |
| 4 | Portrait model | — | **MODNet** only when the subject is a person or doll. |
| 5 | Brush | — | Always editable. |

- **Masks are the single biggest quality lever** for the hull. Spend UX effort here, e.g. an overlay of the reprojected hull outline on each photo (§4.6).

---

## 4. Step B1 — multi-view: silhouette visual hull

### 4.1 Background facts [V]

- **Laurentini 1994 defines the visual hull** as "the maximal object silhouette-equivalent to the object". It is "the closest approximation … obtained with the volume intersection approach". *IEEE TPAMI* 16(2):150–162 ([Semantic Scholar](https://www.semanticscholar.org/paper/The-Visual-Hull-Concept-for-Silhouette-Based-Image-Laurentini/033cc3784a60115d758a11a765e764b86aca336c)).
  - Consequence: **concavities that never show up in any silhouette cannot be recovered**. Examples: the inside of a cup, or the gap between legs seen only from the front and side.
- **Probabilistic silhouette fusion** treats each pixel as a statistical occupancy sensor, borrowing the occupancy grid from robotics. Franco & Boyer, ICCV 2005 ([mlanthology](https://mlanthology.org/iccv/2005/franco2005iccv-fusion/)).
- **The three-view hull of a sphere** is the Steinmetz tricylinder, volume (16 − 8√2) r³ ([Wikipedia](https://en.wikipedia.org/wiki/Steinmetz_solid)). That is **11.9 % larger** than the sphere.
  - **[M]** Our carve of an r = 0.8 sphere from front + side + top at N = 128 measured **volume ratio 1.1193** against the theoretical **1.1188**. This validates both the implementation and the "boxy hull" problem.

### 4.2 View conventions (user-labelled photos, orthographic) [I]

Each label maps to world axes as follows. "u" is image right, "v" is image up, "d" is depth toward the camera.

| Photo label (what the user sees) | Camera at | u = | v = | d = | Constrains |
|---|---|---|---|---|---|
| front | +Z | +X | +Y | +Z | X, Y |
| back | −Z | −X (mirror) | +Y | −Z | X, Y (same information as front) |
| object's left side (viewer's right) | +X | −Z | +Y | +X | Z, Y |
| object's right side | −X | +Z | +Y | −X | Z, Y (same as the other side) |
| top (object's front at the bottom of the photo) | +Y | +X | −Z | +Y | X, Z |
| bottom (object's front at the top of the photo) | −Y | +X | +Z | −Y | X, Z |
| diagonal / any yaw θ (optional) | rotated about Y | x cosθ − z sinθ | +Y | x sinθ + z cosθ | adds new constraints (not separable) |

- **Naming in code [I].** `'left'` means "photo of the object's own left side" (camera at +X), and `'right'` means camera at −X. This matches doc 05, where `ear_l` has x > 0. The UI should show a little turntable icon instead of the words left and right.
- **[M] Opposite views carry identical silhouettes** under orthographic projection. Carving with {front, side, top} gave exactly the same IoU (0.8407) as with all five views. Use opposite views for colors and to repair a bad mask (§4.6), not for shape.
- **[I] To improve shape beyond 3 views,** add 45° yaw photos. Each costs about N³ bilinear samples (~0.1 s at 128³).

### 4.3 Aligning the photos (scale, centring, consistency) [I]

The cameras are unknown, so align with the axes the views share:

```ts
// bbox of each mask in pixels: {cx, cy, w, h}
// Heights must agree between front (X,Y) and side (Z,Y): normalize to world height H = 1.
s.front = bbox.front.h;            // px per world unit
s.side  = bbox.side.h;
const X = bbox.front.w / s.front;  // world width
const Z = bbox.side.w  / s.side;   // world depth
if (top) {                         // top constrains (X,Z): two scale estimates must agree
  const sx = bbox.top.w / X, sz = bbox.top.h / Z;
  s.top = Math.sqrt(sx * sz);
  mismatch = Math.abs(sx / sz - 1);        // warn above 0.08: wrong label or rotation, or strong perspective
}
// Back/other side: own height-based scale + mirror. Centre every view at its bbox centre
// (world origin = bbox centre). Later, shift so min y = 0 and scale to the user's finished size (inches).
```

**Perspective [I, derived].** For a camera at distance Z₀ from the object's centre, a point Δ nearer is magnified by Z₀/(Z₀ − Δ).

- A 15 cm deep toy (Δ = ±7.5 cm) shot from 1 m has about ±7.5 % scale variation.
- Shot from 2 m it has about ±3.75 %.
- **Capture guidance:** step back to 1.5–2 m and use the 2–3× lens; rotate the object 90° between shots; keep the camera at the object's mid-height.
- The UI should show per-view sliders (scale ±10 %, offset, 90° rotate, mirror) with a live overlay.

### 4.4 Carving as an SDF intersection (fast, sub-voxel accurate)

For each view, compute the **exact signed Euclidean distance transform** of the mask: inside positive, in world units. Use Felzenszwalb & Huttenlocher's linear-time lower-envelope algorithm, *Theory of Computing* 8 (2012) 415–428 ([PDF](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf)) [V]. It costs **21 ms per 512² mask [M]**.

The visual hull is then:

```
f_hull(p) = min_k sd_k( project_k(p) )        // ≤ 0 outside any silhouette ⇒ carved
```

- Because each orthographic axis-aligned view ignores its depth coordinate, sample each `sd_k` **once per (u, v) column** into an N×N table. Then do a broadcast `min` over N³.
- **[M]:** 9 ms (tables) + 29 ms (min) at N = 128; 6 + 137 ms at N = 256.
  - A naïve per-voxel bilinear sample of every view, computing hard and soft-min fields together, took 522 ms and 3.98 s respectively.
- Running MC directly on `f_hull` (not on a 0/1 occupancy) gives **smooth, sub-voxel silhouettes with no stair-steps**.
- Occupancy + blur + MC at 0.5 reached the same IoU (0.842 vs 0.841) but loses sub-voxel information [M].

**Soft intersection [M].** A log-sum-exp soft-min `−s·log Σ exp(−sd_k/s)` rounds the hull's creases. Measured at N = 128:

| Object | Hard hull | Soft-min |
|---|---|---|
| Sphere | IoU 0.893 → | IoU 0.906 (s = 0.04) |
| Teddy | IoU 0.841 (volume 1.19×) → | IoU 0.860 (volume 0.94×; s = 0.03) |

It is a modest gain, and it thins thin parts. Prefer §4.5.

### 4.5 Rounding the boxy hull with front-view inflation (the big win)

The depth axis is constrained only by side and top silhouettes, so cross-sections come out rectangular-ish. Add the front view's **inflation height** T(x, y) (§5.1) as a depth bound centred on the hull's own z-interval:

```
z_c(x,y)  = midpoint of the hull's occupied z-interval along the ray (x,y)   // from the side view
f(p)      = min( f_hull(p),  κ·T_front(x,y) − |z − z_c(x,y)| )               // κ = thickness factor, default 1
```

Results at N = 128 [M] (synthetic union of nine ellipsoids: body, head, ears, snout, arms, legs; ground truth analytic):

| Variant | Sphere (3 views) IoU | Teddy IoU (volume ratio) |
|---|---|---|
| Hard hull (front+side+top or all 5) | 0.893 | 0.841 (1.19) |
| Hard occupancy + blur | — | 0.842 |
| Soft-min hull | 0.906 | 0.860 (0.94) |
| **Hull ∩ front-view inflation (recommended)** | **0.989** | **0.922 (1.05)**, 1 component |
| Hull ∩ inflation from **all** views | 0.989 | **0.370** (ears detached; top-view profile chops the height) |
| Hull ∩ all-view inflation, single-interval rays only | — | 0.628 |
| Only front + side (2 photos): hard / front-rounded | — | 0.702 / **0.878** |
| Single front photo, inflation only (§5) | — | 0.787 |

**Why side and top rounding fail [I, from the numbers].**

- The inflation profile assumes **one blob per ray**.
- From the side, the two ears and the head overlap, so the "centre" and "radius" are wrong.
- From the top, the profile describes the plan-view width, but it is applied to the vertical axis.
- The front view is the one where parts are most separated, so it is the right view to take the profile from.

### 4.6 Robustness to imperfect silhouettes

| Technique | Purpose | Measured effect [M] |
|---|---|---|
| Fill holes + `morphClose(r = 2 px)` on every mask | Remove segmentation pinholes, which would carve tunnels | Hole fill + pair union restored IoU 0.759 → 0.841 (see next row) |
| **Mirrored-pair union** (front ∪ mirror(back), side ∪ mirror(other side)) | A hole or error in one photo is overruled by its twin | Corrupted side view (5 % scale error, 4 px shift, 30×130 px hole): IoU **0.759 → 0.841** (= clean) |
| Tolerance τ (treat `sd > −τ` as inside) | Small misalignment | Global dilation of 0.02 world units, without hole fill: IoU **0.666** (worse; it bloats everything). Use only τ ≤ 1 % of size, and only on views flagged by the next row. |
| **Consistency check**: reproject the hull into each view; IoU with that view's mask | Detect a bad mask, wrong label or misalignment | [I] Warn when the IoU is below 0.9 and highlight the offending photo |
| Probabilistic fusion (log-odds per view), Franco & Boyer [V] | Principled soft carving | [I] Not needed with ≤ 6 user photos; revisit for video turntables |

### 4.7 Optional: depth-assisted carving (concavities) [I]

The hull cannot see concavities. If the user wants a concave face or a scooped back, add depth carving:

1. Run the depth model on the front (and back) photo.
2. Fit an affine map `z = a·disparity + b` to the hull's front surface by robust least squares over the mask interior. The model output is affine-invariant (§5.2).
3. Carve voxels in front of the fitted surface by more than 2 voxels.

This is usually unnecessary for amigurumi, which are stuffed and convex-ish.

### 4.8 Projecting colors and patterns onto the mesh (R8)

1. **Quantize each photo to the shared palette first** (doc 06, OKLab). Project **label images**, not RGB. This keeps stripes and spots crisp and avoids blending different views' shading [I].
2. **For each vertex `v` with normal `n`, choose the label of the view `k` that maximizes `w_k = (n · c_k)²`**, where `c_k` is the unit vector toward camera k. Only consider views where:
   - the vertex is **visible** (its depth is within 2.5 voxels of the view's first-hit depth map, computed from the SDF by scanning along the view axis);
   - the pixel is inside the mask (optionally eroded 2 px to avoid rim and background contamination).
3. **Fill unlabeled vertices** (e.g., the bottom without a bottom photo) by BFS from labeled neighbours. Or use the "mirror front" / "dominant color" options for the unseen back (§5.4).
4. **Hand off to doc 06.** Pass the label images and view definitions so it can do per-stitch voting and smoothing. The Waechter et al. 2014 view-selection data term favours "close, orthogonal images", plus a Potts smoothness term ([Springer PDF](https://link.springer.com/content/pdf/10.1007/978-3-319-10602-1_54.pdf)) [V].

**[M] Accuracy on the synthetic teddy** (striped body, N = 128, 21,316 vertices, 5 views):

- **96.6 %** correct with the visibility test.
- **93.1 %** with the normal-only rule.
- Projection took 77 ms.

---

## 5. Step B2 — single image "3D-ifier"

### 5.1 Silhouette inflation methods

| Method | How it works | Notes |
|---|---|---|
| **Teddy** (Igarashi, Matsuoka, Tanaka, SIGGRAPH 99) | Find the spine with the chordal axis. "Each vertex of the spine is elevated proportionally to the average distance between the vertex and the external vertices that are directly connected to the vertex." Edges become "quarter ovals". "The elevated mesh is copied to the other side to make the mesh closed and symmetric" ([PDF](https://www.cs.toronto.edu/~jacobson/seminar/igarashi-et-al-1999.pdf)) [V]. | Mesh-based; needs a constrained Delaunay triangulation. Historical reference. |
| **Monster Mash** (Dvorožňák et al., ACM TOG 39(6):214, 2020) | Following Ink-and-Ray (Sýkora et al. 2014): solve **`Δh̃ = c`** with Dirichlet `h̃ = 0` on drawn contours and a cotangent Laplacian. `c < 0` inflates toward the viewer and `c > 0` away. Then **`h = s·√|h̃|`**, which turns the "parabolic profile" into a "semi-elliptical" one. Front and back regions are inflated with `c` and `−c` and **stitched along the contour** into a manifold ([PDF](https://dcgi.fel.cvut.cz/home/sykorad/Dvoroznak20-SA.pdf)) [V]. | Implemented in C++ with libIGL and Eigen; the web demo runs on WebAssembly + WebGL ([monstermash.zone](https://monstermash.zone/)). Source (Apache-2.0 for `src/`): [github.com/google/monster-mash](https://github.com/google/monster-mash) [V]. |
| **Distance-transform "circular profile" with local thickness (recommended)** [I] | `T(p) = √( d(p)·(2·R_loc(p) − d(p)) )`. `d` is the inside EDT. `R_loc(p)` is the radius of the largest inscribed disc containing p: paint ridge discs (medial axis) in increasing radius order. | **Exact** for a disc (gives the hemisphere) and for a constant-width strip (gives a semicircular tube) [I, derived]. Measured 21 ms EDT + 23 ms local thickness + 2 ms map at 512² [M]. |

**Poisson + √ profile, derived [I].**

- On a disc of radius R: `h̃ = (c/4)(R² − r²)`, so `h = (√c/2)·√(R² − r²)`. With c = 4 this is an exact hemisphere.
- On a strip of half-width a: `h̃ = (c/2)(a² − s²)`, so `h = √(c/2)·√(a² − s²)`. With c = 4 it is **√2 ≈ 1.41× too thick**.
- So one constant c cannot make both blobs and tubes round. The local-thickness DT profile can.
- Poisson also costs more: conjugate gradient took **143 ms at 256²** and **1.3 s at 512²** [M].
- Keep Poisson only if we later want Monster-Mash-style part layering.

**Single-image volume:**

```
f(p) = min( sd_front(x,y),  κ·T(x,y) − |z| )
```

Use `κ` (the thickness factor) as a UI slider. A plush seen from the front is usually less deep than wide.

### 5.2 Monocular depth in the browser

**Depth Anything V2 Small** — Hugging Face id **`onnx-community/depth-anything-v2-small`** ([card](https://huggingface.co/onnx-community/depth-anything-v2-small)), run through `pipeline('depth-estimation', …)` [V].

- **License:** Small is **Apache-2.0**. **Base, Large and Giant are CC-BY-NC-4.0** ([GitHub](https://github.com/DepthAnything/Depth-Anything-V2)) [V]. Use Small only.
- **Parameters:** 24.8 M (Small), 97.5 M, 335.3 M, 1.3 B [V].
- **Files** ([tree](https://huggingface.co/onnx-community/depth-anything-v2-small/tree/main/onnx)) [V]:
  - `model.onnx` 99.1 MB;
  - `model_fp16.onnx` 49.6 MB;
  - `model_quantized` / `int8` / `uint8` 27.3 MB;
  - `model_q4` 27.4 MB;
  - `model_q4f16` 19.1 MB;
  - `model_bnb4` 26.1 MB.
- **Pre-processing** (`preprocessor_config.json`) [V]:
  - 518×518 with `keep_aspect_ratio`;
  - `ensure_multiple_of: 14`;
  - bicubic resampling;
  - ImageNet mean and standard deviation.
- **Outputs:** `predicted_depth` (float tensor) and `depth` (8-bit image) ([pipelines docs](https://huggingface.co/docs/transformers.js/api/pipelines)) [V].
- **Semantics:** the model is trained in **disparity space**. "The depth value is first transformed into the disparity space by d = 1/t and then normalized to 0∼1 on each depth map", with an affine-invariant (scale + shift) loss ([Depth Anything paper](https://arxiv.org/html/2401.10891v1)) [V]. So the output is **relative inverse depth, larger = nearer, with unknown scale and shift**. It never gives absolute thickness.
- **Speed [M] (WASM, M3 Pro, 518²):**
  - q8 1 thread: 2.70 s;
  - fp32 1 thread: 2.75 s;
  - q8 or fp32 with 4 threads: **0.79–0.80 s**;
  - q8 at 364², 1 thread: 1.12 s;
  - session creation: about 0.3 s.
  - Quantization **does not speed up WASM** here; it only shrinks the download.
- **WebGPU speed [V].** Xenova reported Depth Anything (V1 Small) "in under 200ms" with WebGPU ([X](https://x.com/xenovacom/status/1766284534901887406)), and V2 Small as "real-time" at "~50MB (@ fp16)" ([X](https://x.com/xenovacom/status/1801672335830798654)).
  - The official video example uses `device: 'webgpu'` and `dtype: fp16` only when `adapter.features.has('shader-f16')`, with input size 504 ([example](https://github.com/huggingface/transformers.js-examples/tree/main/depth-estimation-video)).

**Other candidates:**

| Candidate | Status | Recommendation |
|---|---|---|
| **Depth Anything 3** | `onnx-community/depth-anything-v3-small` exists: Apache-2.0, created 2025-11-14, fp32 only, 0.6 MB graph + 104.7 MB data. It has **no model card or transformers.js tag** ([HF](https://huggingface.co/onnx-community/depth-anything-v3-small)) [V]. Upstream DA3-SMALL is Apache-2.0 ([HF](https://huggingface.co/depth-anything/DA3-SMALL)). | Experimental; skip for v1 [I]. |
| **Depth Pro** (Apple) | `onnx-community/DepthPro-ONNX`: 600 MB (q4f16) to 3.8 GB, Apple ASCL license, 1536 input ([tree](https://huggingface.co/onnx-community/DepthPro-ONNX/tree/main/onnx)) [V]. | Too big [I]. |
| **Existence proof** | `neurangelo-web` turns a single photo into a mesh in-browser with transformers.js depth, WebGPU→WASM fallback ([GitHub](https://github.com/kushsmhsmh/neurangelo-web)) [V]. | Reference only. |

### 5.3 Fusing depth with the silhouette into a closed volume [I]

```ts
// Inputs: mask M, inside EDT d (px), inflation T (world), disparity D from the model (resized to the mask)
const D1 = robustNormalize(D, M, 0.02, 0.98);                // percentiles inside the mask
const inner = M & (d >= 3);                                   // ignore rim pixels: depth "bleeds" at edges
const [a, b] = leastSquares(D1[inner], κ * T[inner]);         // scale/shift from the inflation prior
for each pixel p in M:
  const w = smoothstep(2, 14, d[p]);                          // 0 at the rim → 1 inside (px)
  zFront[p] = w * (a * D1[p] + b) + (1 - w) * κ * T[p];       // relief inside, round rim
  zBack[p]  = backMode === 'mirror' ? -zFront[p] : -κ * T[p]; // mirror | inflate | (user photo → 2-view)
f(x,y,z) = min( sd(x,y), zFront(x,y) − z, z − zBack(x,y) );  // closed, watertight after MC
```

**[M] Synthetic teddy, N = 128.** The "prediction" is the true front depth through an affine map, normalized, with optional low-frequency noise.

| Single-image variant | IoU vs ground truth |
|---|---|
| Oracle (true front + back depth) | 0.987 |
| Inflation only (κ = 1) | 0.787 |
| Depth front + inflated back (κ = 1), noise 0 / 0.3 | 0.846 / 0.819 |
| Depth front + mirrored back (κ = 1), noise 0 / 0.3 | 0.850 / 0.811 |
| **κ = 0.9**: inflation only / depth + inflated back | 0.842 / **0.893** |
| κ = 0.7 / 1.1 (depth + inflated back) | 0.753 / 0.775 |

**Takeaways [I]:**

- Depth helps mainly through **relief** (snout, limbs in front of the body).
- The **thickness factor matters as much as the model**. Ask for it in the Q&A (R5: "about how deep is it compared to its width?"), default κ = 0.9 for plush, and show a live slider.
- Perfectly affine synthetic depth is an optimistic stand-in; real predictions are smoother.

### 5.4 Back side and colors (single image) [I]

| Back mode | Shape | Colors |
|---|---|---|
| Mirror (default) | `zBack = −zFront` | Mirror the front labels |
| Inflate | `zBack = −κ·T` | Dominant front label, or mirror |
| Solid | — | One user-chosen color |
| Upload a back photo | — | Mirror-registered by bounding box; becomes a 2-view hull with front+back colors |

- **Rim pixels:** sample colors 2–4 px inside the mask boundary. Edge pixels mix with the background.

---

## 6. Step C — mesh extraction, cleanup, smoothing, decimation, parts

### 6.1 Marching cubes [V + M]

- **Tables.** `three/addons/objects/MarchingCubes.js` (three 0.186.1) ends with `export { MarchingCubes, edgeTable, triTable }` ([unpkg](https://unpkg.com/three@0.186.1/examples/jsm/objects/MarchingCubes.js)) [V].
  - The `MarchingCubes` class itself is a metaball renderer: constructor `(resolution, material, enableUvs, enableColors, maxPolyCount = 10000)`, default `isolation = 80`, non-indexed buffers. It is a port of the WebGL blob sample. **Use the tables, write our own indexed MC.** It is about 120 lines with Bourke corner and edge order.
- **Indexing.** Give each edge one vertex, keyed by `(axis, lower-corner index)`, so the result is watertight with no welding pass.
  - **[M]** 0 boundary or non-manifold edges and χ = 2 at every resolution tested.
- **Degenerate triangles.** Clamp `t = (iso − f0)/(f1 − f0)` to `[0.01, 0.99]` and avoid exact zeros in f.
  - **[M]** Without the clamp, MC produced 298 (N = 128) to 2,860 (N = 256) zero-area triangles. manifold-3d then decomposed a single-shell mesh into **4 parts (14 after Taubin)**. With the clamp: 1 part, genus 0.
- **Memory.** A naïve implementation keeps three `Int32Array(N³)` edge-vertex maps: 201 MB at N = 256. Process **two z-slices at a time** to make memory O(N²) [I].
- **Throughput [M]** (single thread, Node 20 / V8):

  | N | Time | Vertices / triangles |
  |---|---|---|
  | 64 | 25 ms | 5.2 k / 10.5 k |
  | 128 | 91 ms | 21 k / 42.6 k |
  | 192 | 248 ms | 48 k / 96 k |
  | 256 | 562 ms | 90 k / 179 k |

**Alternatives:**

| Option | Facts | Assessment |
|---|---|---|
| Surface nets / `isosurface` npm (MIT, 2014; `surfaceNets`, `marchingCubes`, `marchingTetrahedra`, function-callback API) | 0fps measured in 2012 JS that surface nets produced about half the triangles of MC and ran about twice as fast. They "may sometimes get non-manifold vertices" ([0fps](https://0fps.net/2012/07/12/smooth-voxel-terrain-part-2/)) [V]. | — |
| **manifold-3d `Manifold.levelSet(sdf, bounds, edgeLength, level, tolerance)`** | Marching tetrahedra on a **body-centred cubic grid**, "better for manifoldness", positive-inside SDF (package typings) [V]. Guaranteed manifold. | **[M]** 777 ms at edge = 2.2/128 with a JS trilinear callback, giving 78 k triangles, genus 0. ≈8× slower than our MC. Good as a "safe mode" fallback. |
| meshoptimizer `remesh(indices, positions, stride, resolution, flags)` | **Experimental** voxel remesher, resolution [4, 256]. "The output of the remesher is closed, with every edge matched by an opposite edge"; small gaps get closed ([README](https://github.com/zeux/meshoptimizer)) [V]. | Useful to repair **imported** meshes (R6). |

### 6.2 Volume cleanup before meshing [I + M]

- **Keep the largest 6-connected inside component.**
- **Fill enclosed cavities** by flood-filling the outside from the grid border. This costs 65 ms at 128³ and 1.2 s at 256³ [M].
- **Optional morphological closing** (EDT-based) with radius r removes handles narrower than 2r. This keeps genus 0 when an arm touches the body in a photo. Check the genus with manifold-3d `genus()` (§6.5).

### 6.3 Smoothing — Taubin λ|μ [V + M]

- **Taubin 1995** (SIGGRAPH) alternates a shrinking step (λ > 0) with an un-shrinking step (μ < −λ).
  - Pass-band `k_PB = 1/λ + 1/μ`. "Values from 0.01 to 0.1 produce good results."
  - The paper's examples, **including a voxel CT surface**, use **k_PB = 0.1, λ = 0.6307**, which gives μ ≈ −0.6732 ([PDF](http://mesh.brown.edu/taubin/pdfs/taubin-sg95.pdf)) [V].
- **[M]** 10 λ/μ pairs: 33 ms on 21 k vertices and 99 ms on 90 k. Topology is unchanged with the MC clamp.
- **Run it after MC on the SDF result.** Plain Laplacian smoothing shrinks the shape and should not be used.

### 6.4 Decimation — moderate, then validate [V + M]

- **meshoptimizer 1.3.0** `MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, targetError, flags)`.
  - Flags include `LockBorder`, `ErrorAbsolute`, `Prune`, `Regularize`, `Permissive`, `PreserveFolds` ([README](https://github.com/zeux/meshoptimizer)) [V].
  - `simplifyWithAttributes(..., vertex_attributes, attribute_weights, vertex_lock, ...)` can protect color boundaries: lock vertices on label boundaries so stripes stay sharp [V/I].

  | Run [M] | Time | Result |
  |---|---|---|
  | N = 128 (42.6 k → 20 k triangles) | 10 ms | manifold, genus 0 |
  | N = 192 (96 k → 20 k) | 23 ms | manifold, 0 bad edges (default flags, and also with `['PreserveFolds', 'Regularize']`) |
  | **N = 256 (179 k → 20 k)** | 48 ms | **4 non-manifold edges** with default flags; 81 with `PreserveFolds`; 55 with `PreserveFolds + Regularize` |

  An earlier run without the MC clamp also had 1 bad edge at N = 192 [M].
- **manifold-3d 3.5.4** `simplify(tolerance)` gave 2.5 k triangles at N = 64 (8 ms) and 6.4 k at N = 128 (26 ms), both genus 0 [M]. At N = 256 (tolerance 0.25 voxel) it split off 17 tiny sliver parts of 4–20 triangles [M].
- **Rule [I]:**
  - Choose N so MC output is already close to the needed density (§1).
  - Decimate ≤ 3×, with `Regularize` to keep triangles even for doc 03.
  - Always run `new Manifold(mesh)` → `decompose()` → keep the largest part → check `genus() === 0`.

### 6.5 Validation (per part) [I]

| Check | Requirement |
|---|---|
| Manifold import status | `NoError` |
| `decompose().length` | 1 |
| `genus()` | 0, or the user accepted a handle |
| Volume | > 0 |
| Thin features | Thinner than 2 voxels → flag ("crochet flat: ear/tail") |

Inputs for doc 03's "stuffable" checks: the bounding box in inches, and the minimum local thickness (from the 3D EDT).

### 6.6 Part decomposition for amigurumi (first pass) [I + M]

Doc 03 (and AmiGo) need non-branching pieces. A cheap first pass uses **morphological opening on the voxel volume**:

1. Body = opening of the volume with a ball of radius r (two 3D EDT passes).
2. Limbs = connected components of volume − body larger than 0.4 % of the volume.

**[M] Teddy, N = 128, r = 0.12 world (≈10 % of height), about 0.2 s per radius:**

- 5 parts found: 2 arms, 2 ears and one leg region. **Both legs merged** because their residues touch along the body's base shell.
- r = 0.16–0.20 gave the same 5.

**Known failure [I].** Adjacent limbs merge, and the body/head neck is not split. Follow up with:

- a 2D skeleton split on the front silhouette (narrow necks are local minima of `R_loc` along the medial axis);
- user cut strokes in the editor (doc 03 §6.2 B2).

### 6.7 Geodesics / heat method in JS (for doc 03's rows) [V]

- **The heat method** has three steps ([Crane, Weischedel, Wardetzky PDF](https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Crane12.pdf)):
  1. Integrate heat flow for time t.
  2. Normalize the gradient into `X = −∇u/|∇u|`.
  3. Solve `Δφ = ∇·X`.
- **Time step.** That PDF gives `t* = A_M/|F|` (total area over face count), and says "simply using c = 5 works remarkably well". Doc 03 uses `t = (mean edge length)²`, which is the same order: for equilateral triangles `A/|F| ≈ 0.43 h²` [I].
- **Mesh quality.** CGAL builds an intrinsic Delaunay triangulation first to handle "highly elongated triangles" ([CGAL](https://doc.cgal.org/latest/Heat_method_3/index.html)).

**JS options:**

| Option | Facts |
|---|---|
| geometry-processing-js | MIT. Eigen compiled to asm.js with emscripten; **not on npm** ([GitHub](https://github.com/GeometryCollective/geometry-processing-js)) [V]. |
| `flip-threejs` 0.2.5 | MIT. FlipOut geodesic **paths**, not distance fields (npm) [V]. |
| `mesh-geodesic` | Unmaintained since 2013 [V]. |

**Recommendation [I]:** write our own heat method in TypeScript.

- Cotan Laplacian plus mass matrix.
- Two solves with Jacobi-preconditioned conjugate gradient, warm-started. Meshes are 5–40 k vertices, so this is fine in a worker.
- If repeated queries per mesh are needed, add a sparse Cholesky later.

---

## 7. Generative image-to-3D in the browser — 2026 status

| Model | Size / runtime | License | Browser? |
|---|---|---|---|
| **TripoSR** | "less than 0.5 seconds on an NVIDIA A100", about 6 GB VRAM, CUDA + torchmcubes ([GitHub](https://github.com/VAST-AI-Research/TripoSR)) [V]. An ONNX export is about 3.4 GB, host-side only; marching cubes at 256³ runs outside the graph ([brodatech/triposr-onnx](https://huggingface.co/brodatech/triposr-onnx)) [V]. | MIT ([HF](https://huggingface.co/stabilityai/TripoSR)) | No working port found. SpawnDev.ILGPU.ML lists TripoSR (≈840 MB fp16) as planned: "the reconstruction model path is not wired" ([GitHub](https://github.com/LostBeard/SpawnDev.ILGPU.ML)) [V]. |
| **SF3D** (Stability) | 0.5 s, about 6 GB VRAM ([GitHub](https://github.com/Stability-AI/stable-fast-3d), [blog](https://stability.ai/news-updates/introducing-stable-fast-3d)) [V] | Stability AI Community License (free under US $1 M annual revenue) | No |
| **Hunyuan3D-2.1** | Shape 3.3 B params / 10 GB; texture 2 B / 21 GB; both 29 GB ([GitHub](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)) [V] | Tencent Hunyuan 3D 2.1 Community License; **"does not apply in the European Union, United Kingdom and South Korea"** ([LICENSE](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE)) [V] | No |
| **TRELLIS.2** | 4 B params; ≥ 24 GB VRAM (A100/H100); Linux; about 3 s at 512³ on H100 ([GitHub](https://github.com/microsoft/TRELLIS.2)) [V] | MIT (some dependencies are separately licensed) | No |
| **TripoSplat** (Gaussian splats) | WebGPU port: **≈6.47 GB** in 10 ONNX graphs; on an M3 Max with 128 GB, **247,901 ms** end-to-end (4 steps); only tested on Chrome; not qualified for 16 GB Macs or mobile ([HF](https://huggingface.co/Yosun/TripoSplat-WebGPU)) [V] | MIT | Technically yes; practically no. The output is splats, not a closed mesh. |
| **SHARP** (Apple) | Monocular **view synthesis** to metric 3D Gaussians, under 1 s on a GPU ([GitHub](https://github.com/apple/ml-sharp)) [V]. A WebGPU ONNX export is 0.66 GB int8 ([HF](https://huggingface.co/sm079/sharp-onnx-webgpu)) [V]. | Weights "non-commercial research purposes only" | Runs, but only the visible surface, and the license blocks it. |
| **VGGT** (multi-view feed-forward) | VGGT-1B; outputs cameras, depth and point maps ([GitHub](https://github.com/facebookresearch/vggt)) [V] | Original non-commercial; the separate "VGGT-1B-Commercial" checkpoint is gated | No (1 B params) |

**Verdict [I].** Not for v1. Offer the **Claude Design round trip (doc 05)** as the "better 3D" route instead. Imported meshes re-enter our pipeline through mesh → SDF:

- three-mesh-bvh has "SDF generation" and voxelization examples [V];
- or meshoptimizer `remesh` (experimental).

Either way, the result goes through the same cleanup, validation and labelling.

---

## 8. Library shortlist (npm registry, queried 2026-09-30) [V]

| Package | Version (published) | License | Role | Notes |
|---|---|---|---|---|
| `@huggingface/transformers` | 4.3.0 (2026-09-16) | Apache-2.0 | ML pipelines (segmentation, depth) | Depends on `onnxruntime-web` 1.31.0-dev. v4 has a new C++ WebGPU runtime, `ModelRegistry` (`is_pipeline_cached`, `get_available_dtypes`) and `env.useWasmCache` ([blog](https://huggingface.co/blog/transformersjs-v4); 4.0.0 on npm 2026-03-30). |
| `onnxruntime-web` | 1.30.0 (2026-09-14) | MIT | Direct ONNX use (DA3, custom models) | Threads need `crossOriginIsolated`. Default threads: "half of `navigator.hardwareConcurrency` or 4, whichever is smaller". The proxy worker "cannot work with WebGPU EP" ([docs](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)). |
| `three` | 0.186.1 (2026-09-24) | MIT | Rendering; MC tables; `BufferGeometryUtils.mergeVertices` | |
| `three-mesh-bvh` | 0.9.15 (2026-09-09) | MIT | Raycast / visibility, closest point, sculpt, mesh→SDF | "500 rays against an 80,000 polygon model at 60fps"; `GenerateMeshBVHWorker` / `ParallelMeshBVHWorker` ([GitHub](https://github.com/gkjohnson/three-mesh-bvh)). |
| `manifold-3d` | 3.5.4 (2026-09-25) | Apache-2.0 | Validation, genus, decompose, booleans (editor), `levelSet`, `simplify`, `smoothOut` | WASM 532 KB [M]. |
| `meshoptimizer` | 1.3.0 (2026-09-25) | MIT | Simplification (attribute-aware), experimental remesh | |
| `@gltf-transform/core` + `functions` | 4.5.1 (2026-09-28) | MIT | GLB import/export, weld, simplify wrapper | |
| `three-bvh-csg` | 0.0.18 | MIT | Mesh CSG (manifold-3d preferred) | |
| `@mediapipe/tasks-vision` | 1.0.1 (2026-07-31) | Apache-2.0 | MagicTouch interactive segmenter | |
| `@techstark/opencv-js` | 5.0.0-release.1 (2026-06-24) | Apache-2.0 | GrabCut / morphology (lazy) | 13.3 MB JS [M]. |
| `comlink` | 4.4.2 | Apache-2.0 | Worker RPC | |
| `isosurface` / `surface-nets` | 1.0.0 / 1.0.2 | MIT | Reference implementations | Old API; we write our own MC. |
| `flip-threejs` | 0.2.5 | MIT | Geodesic paths (not distance) | |
| `@imgly/background-removal` | 1.7.0 (2025-07-18) | **AGPL-3.0** | — | **Excluded.** |
| `coi-serviceworker` | 0.1.7 | MIT | COOP/COEP on static hosts ([GitHub](https://github.com/gzuidhof/coi-serviceworker)) | |

---

## 9. Runtime architecture: workers, backends, caching, offline

### 9.1 Workers [I, grounded in V]

**`ml.worker.ts`** runs transformers.js and onnxruntime-web.

- WebGPU is available in workers through `WorkerNavigator.gpu` (secure contexts only) ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)) [V].
- Decode images with `createImageBitmap` inside the worker.
- One pipeline instance per model.

**`geom.worker.ts`** runs pure TypeScript (EDT, carving, MC, Taubin, labels, parts) plus `meshoptimizer` and `manifold-3d` WASM.

- It returns `ColoredMesh` buffers as **transferables** (zero-copy).
- Cancel stale jobs with a monotonically increasing job id. On "cancel ML", `terminate()` the worker and respawn it.

The main thread renders only (R3F). A practitioner reported the whole UI freezing when ONNX Runtime Web ran WASM on the main thread, and fixed it with a dedicated worker ([dev.to](https://dev.to/androve2k/removing-a-photos-background-in-the-browser-with-no-upload-ai-licenses-onnx-models-and-a-1cc0)) [V].

### 9.2 Backend selection

```ts
async function pickBackend() {
  const gpu = (self as any).navigator?.gpu;
  if (gpu) {
    const adapter = await gpu.requestAdapter();
    if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  }
  const threads = self.crossOriginIsolated ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)) : 1;
  return { device: 'wasm', dtype: 'q8', threads };   // q8 = smaller download; same speed as fp32 on WASM [M]
}
```

**Browser support for WebGPU [V]:**

- Chrome and Edge 113+.
- Safari 26 (macOS Tahoe, iOS/iPadOS 26).
- Firefox 141 on Windows and 145 on macOS Tahoe ARM64.
- Linux and Firefox on Android are still in progress.

Sources: [web.dev, 2025-11-25](https://web.dev/blog/webgpu-supported-major-browsers). transformers.js reported global support "around 85%" in March 2026 ([guide](https://huggingface.co/docs/transformers.js/guides/webgpu)); caniuse shows 87.35 % ([caniuse](https://caniuse.com/webgpu)).

### 9.3 Cross-origin isolation (multi-threaded WASM) [V + I]

ONNX Runtime Web needs `crossOriginIsolated` for threads. Otherwise it warns and falls back to 1 thread ([docs](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)). The difference is **2.7 s vs 0.8 s** for depth [M].

- **Dev:** `vite.config.ts` → `server.headers` and `preview.headers`:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

  `server.headers` is documented as "Specify server response headers" ([Vite](https://vite.dev/config/server-options)).
- **Static hosting without header control:** use `coi-serviceworker` (MIT) [V]. All model and CDN fetches must then be CORS/CORP-compatible. Self-hosting the models avoids surprises [I].

### 9.4 Model caching and offline [V + I]

**transformers.js `env` settings** ([docs](https://huggingface.co/docs/transformers.js/api/env)) [V]:

| Setting | Default / behavior |
|---|---|
| `allowRemoteModels` | `true` |
| `allowLocalModels` | `false` in the browser |
| `localModelPath` | `/models/` |
| `useBrowserCache` | Cache API |
| `cacheKey` | `'transformers-cache'` |
| `useWasmCache` (v4) | Pre-loads and caches the ORT WASM binaries; "enables offline usage" |
| `env.backends.onnx` | Passes ORT settings through, e.g., `wasm.wasmPaths` for self-hosted WASM. |

**Fully offline build [I]:**

- Place the chosen ONNX files under `public/models/<repo-id>/…`.
- Set `env.allowLocalModels = true` and `env.allowRemoteModels = false`.
- Point `wasmPaths` at copies from `node_modules/onnxruntime-web/dist`.
- **Bundle only permissive weights** (DA V2 Small, MODNet, SlimSAM, BiRefNet_lite/BEN2 if size allows). Fetch BRIA models only on explicit opt-in, with a license notice.

**Storage [V]** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)):

| Browser | Quota / eviction |
|---|---|
| Chrome | Up to 60 % of disk per origin. |
| Firefox (best-effort) | Up to min(10 % of disk, 10 GiB). |
| Safari (browser apps) | About 60 %. Also a **7-day cap on script-writable storage** for origins without user interaction, when tracking prevention is on. |

Call `navigator.storage.persist()` after the first model download. Check `ModelRegistry.is_pipeline_cached()` before offering the ML buttons offline.

### 9.5 Progressive fallback ladder [I]

| Level | Needs | Segmentation | Single-image 3D | Multi-view 3D |
|---|---|---|---|---|
| **L0 (offline, no models)** | nothing | Classical + brush (+ OpenCV GrabCut if cached) | DT inflation (κ slider) | SDF hull + front rounding |
| **L1** (+6–14 MB) | WASM | + MagicTouch / SlimSAM clicks; MODNet for people | same | same, better masks |
| **L2** (+19–50 MB) | WASM (threads preferred) | same | + DA V2 Small relief | + optional depth carving |
| **L3** (+115–219 MB) | WebGPU | + BiRefNet_lite / BEN2 automatic masks | same, faster | same |
| **L4** | User + Claude Design | — | Claude Design route (05) → import → same mesher | same |

The UI shows which level is active and why (e.g., "WebGPU unavailable", "not cross-origin isolated", "offline, model not cached").

### 9.6 Performance budget (target: under 2 s from "Build 3D" to preview) [M + I]

Measured on an Apple M3 Pro in Node 20, single thread. Values marked "~" are interpolated estimates, not measurements. Budget about 2–3× slower on mid-range laptops and 3–5× slower on phones [I].

| Stage | N = 64 | N = 128 (default) | N = 192 | N = 256 |
|---|---|---|---|---|
| 2D prep at 512² (front: EDT + local thickness 45 ms; each other view: EDT 21 ms) | ~130 ms (5 views) | ~130 ms | ~130 ms | ~130 ms |
| Fast separable carve | ~5 ms | 38 ms | ~70 ms | 143 ms |
| Front rounding | 15 ms | 61 ms | 212 ms | 639 ms |
| Cleanup (components + cavities) | ~10 ms | 65 ms | ~0.4 s | 1.2 s |
| Marching cubes (clamped) | 25 ms | 91 ms | 248 ms | 562 ms |
| Taubin × 10 | 8 ms | 33 ms | 47 ms | 99 ms |
| Decimation (meshopt) / validation (manifold) | 2 / 15 ms | 10 / 30 ms | 23 / 65 ms | not recommended |
| Label projection (5 views) | ~20 ms | 77 ms | ~0.2 s | ~0.4 s |
| **Geometry total** (sum of rows) | **≈0.25 s** | **≈0.55 s** | **≈1.4 s** | **≈3.2 s** (no decimation) |
| ML (once per photo; WASM 4 threads) | Masks: SlimSAM encode 1.05 s / MODNet 0.24 s / RMBG q8 2.05 s. Depth: 0.8 s at 518². | | | |

Use N = 64 while the user drags alignment sliders, N = 128 on release, and N = 192 behind a "High detail" toggle.

---

## 10. End-to-end pseudo-code (geometry worker)

```ts
export async function buildFromPhotos(views: ViewInput[], opt: BuildOptions): Promise<ColoredMesh> {
  // 1) masks are ready (ml.worker). Repair masks and exploit redundancy.
  for (const v of views) v.mask = morphClose(fillHoles(keepLargest(v.mask)), 2);
  pairUnionMirrored(views, ['front', 'back']); pairUnionMirrored(views, ['left', 'right']);

  // 2) align (scale from shared axes, centre on bbox), warn on mismatch > 8%
  const cams = alignOrthographic(views);                     // §4.3

  // 3) per-view signed EDT (world units) + front local thickness / inflation
  const sd = views.map(v => signedEDT(v.mask).scale(cams[v.id].worldPerPx));
  const T  = inflationHeight(sdOf('front'), localRadius(sdOf('front')));   // §5.1

  // 4) SDF volume
  const N = opt.N ?? 128;
  let f = separableHull(N, views, sd, cams);                 // §4.4, min over views
  if (views.length === 1) f = singleViewField(N, sd[0], T, opt.kappa ?? 0.9, opt.depth); // §5.1/5.3
  else f = roundDepthAxis(f, N, T, opt.kappa ?? 1.0);        // §4.5, FRONT view only
  f = cleanVolume(f, N);                                     // §6.2

  // 5) mesh
  let mesh = marchingCubes(f, N, 0, { clampT: 0.01 });       // §6.1
  taubin(mesh, 10, 0.6307, -0.6732);                         // §6.3
  mesh = moderateSimplify(mesh, { maxRatio: 3, flags: ['Regularize'] });   // §6.4
  const report = validateWithManifold(mesh);                 // parts = 1, genus = 0, else repair or warn

  // 6) labels, parts, units
  const labels = projectLabels(mesh, views, cams, f, { visibility: true, erodePx: 2 }); // §4.8
  const partId = segmentPartsByOpening(f, N, opt.openingRadius ?? 0.12);              // §6.6
  return toInches(mesh, labels, partId, opt.finishedHeightIn);   // lowest point y = 0, +Y up, front +Z
}
```

---

## 11. Benchmark methodology and raw numbers [M]

**Setup.**

- Hardware: Apple **M3 Pro**, 12 cores, 18 GB RAM, macOS (Darwin 25.6).
- Runtime: **Node 20.18.0 (V8)**, single-threaded JS. This is a proxy for a Chrome Web Worker; Safari's JavaScriptCore will differ.
- ML: **onnxruntime-web 1.30.0** WASM EP in Node, with random inputs and warm runs. The WebGPU EP cannot be measured in Node.
- Scratch scripts were not committed: `geom_bench.mjs`, `carve_fast.mjs`, `depth_fusion.mjs`, `parts.mjs`, `depth_bench.mjs`, `seg_bench.mjs`, `ocvtest.cjs`.

**Synthetic scenes.**

- **Ground truth** is a sphere (r = 0.8), and a "teddy" made of nine axis-aligned ellipsoids (body, head, 2 ears, snout, 2 arms, 2 legs) in [−1.1, 1.1]³.
- **Labels:**
  - the body has 8 horizontal stripes per unit height (cream / red);
  - the head, arms and legs are brown;
  - the ears are dark;
  - the snout is tan.
- **Views** are exact orthographic renders at 512² (analytic ellipse projections), with label images from the first hit.

**Metric.** IoU and volume ratio of `field > 0` against analytic inside/outside at voxel centres.

**Raw lines from the final run:**

```
[2D] 512x512 signed EDT: 21.1 ms; local-thickness (ridge=720) 23.4 ms; thickness map 1.6 ms
[2D] Poisson inflation 256x256 CG: 142.7 ms, 318 iterations; 512x512: 1281.3 ms, 634 iterations
[A sphere r=0.8, 3 views, N=128] hard VH iou 0.8927 volRatio 1.1193 | soft-min iou 0.9065 vol 1.0738 | rounded iou 0.9890 vol 0.9890 | theory 1.1188
[B N=128] carve(sdf+lse, naive) 522 ms | rounding 61 ms | MC 91 ms -> V=21316 F=42628 badEdges=0 chi=2 | Taubin x10 33 ms | meshopt->20000 10 ms OK | manifold build 29 + simplify 26 ms -> 6358 tris genus 0
[B N=256] carve 3978 ms | rounding 639 ms | MC 562 ms -> V=89600 F=179196 | Taubin 99 ms | meshopt->19990: badEdges=4 (PreserveFolds: 81) | manifold simplify -> 18 parts
fast separable carve: N=128 9+29 ms, N=256 6+137 ms (same IoU 0.8407)
labels: visibility 96.6% vs normal-only 93.1% (21,316 verts, 77 ms)
manifold.levelSet edge=0.0172: 777 ms, 77,950 tris, genus 0
DA-V2-S 518²: q8 1T 2.70 s | fp32 1T 2.75 s | q8 4T 0.79 s | fp32 4T 0.80 s | q8 364² 1T 1.12 s
MODNet 512²: 4T 0.24 s, 1T 0.83 s | RMBG-1.4 q8 1024²: 4T 2.05 s, 1T 7.2 s | SlimSAM enc q8: 4T 1.05 s | BiRefNet_lite 1024²: std::bad_alloc
OpenCV.js init 136 ms; grabCut 512² ×3 iters 123 ms
```

---

## 12. Failure modes and edge cases [I unless marked]

| Situation | Symptom | Mitigation |
|---|---|---|
| Object touches the photo border | Truncated silhouette, flat cut | Detect a mask touching the border, and ask for a re-shoot with a 10 % margin. |
| White or cream plush on a white background | Classical mask fails | Click-segment (SlimSAM/MagicTouch), brush, or ask for a contrasting backdrop. |
| Floor shadow in the mask | A "skirt" at the base | Shadow heuristic (§3.2) and brush; the hull intersection also removes shadows not seen in the side view. |
| One bad mask or misalignment | Tunnel or chop in the hull | Pair union, hole fill, consistency IoU warning (measured recovery 0.759 → 0.841 [M]). |
| Real through-holes (mug handle, arm loop) | Filled by default | "Keep holes" toggle; manifold `genus()` shows the result. |
| Strong perspective (phone close-up) | View scales disagree; bulging hull | Telephoto capture tip; mismatch warning; per-view scale slider. |
| Thin ears or tails (< 2 voxels) | Vanish or pinch | Raise N locally, or classify as **flat appendage** (crochet flat) from the 2D EDT. |
| Concavities (bowl, open mouth) | Filled in | Accept for amigurumi; depth carving (§4.7) or editor. |
| Parts overlapping in the side view | Rounding artefacts | Round from the front view only (measured 0.37 vs 0.92 IoU [M]). |
| Arm touching the body in the photo | Merged parts, handles | Morphological closing; editor cut tool. |
| Specular highlights, prints, motifs | Label noise | Quantize in OKLab with highlight handling (doc 06); per-vertex majority vote over a 1-ring before stitch voting. |
| Huge images (48 MP) | Memory | Downscale to 1024 px for models and 512 px for masks; keep full resolution only for color sampling. |
| No WebGPU and no isolation | Slow ML (1 thread) | Prefer classical masks + DT inflation; show an estimated time; depth stays optional. |

---

## 13. Open questions

1. **Real photos.** Synthetic numbers are optimistic. Before freezing defaults (κ, τ, N), collect about 10 real plush photo sets (front/side/top/back) under `fixtures/` and re-measure IoU against a hand-modelled reference, or at least do visual review.
2. **WebGPU timings.** Measure depth and BiRefNet/BEN2 in the real app in Chrome and Safari 26. This is a 1-day spike, using the `depth-estimation-video` example settings.
3. **Diagonal views.** Do 45° views beat front-rounding in practice? They are cheap to support with the yaw-angle view type.
4. **Part segmentation.** Compare opening + 2D skeleton against shape-diameter-function segmentation (doc 03 §6.2) on real meshes.
5. **MagicTouch weights license.** Confirm from the model card before bundling.

---

## Sources

**Models and runtimes**

- [Depth Anything V2 (GitHub)](https://github.com/DepthAnything/Depth-Anything-V2)
- [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small) and its [file tree](https://huggingface.co/onnx-community/depth-anything-v2-small/tree/main/onnx)
- [Depth Anything paper (arXiv 2401.10891)](https://arxiv.org/html/2401.10891v1)
- [onnx-community/depth-anything-v3-small](https://huggingface.co/onnx-community/depth-anything-v3-small)
- [depth-anything/DA3-SMALL](https://huggingface.co/depth-anything/DA3-SMALL)
- [onnx-community/DepthPro-ONNX](https://huggingface.co/onnx-community/DepthPro-ONNX)
- [Xenova: Depth Anything (V1) with WebGPU](https://x.com/xenovacom/status/1766284534901887406)
- [Xenova: Depth Anything V2](https://x.com/xenovacom/status/1801672335830798654)
- [briaai/RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4)
- [briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0)
- [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)
- [onnx-community/BEN2-ONNX](https://huggingface.co/onnx-community/BEN2-ONNX)
- [PramaLLC/BEN2](https://huggingface.co/PramaLLC/BEN2)
- [Xenova/modnet](https://huggingface.co/Xenova/modnet)
- [Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform)
- [MediaPipe interactive segmenter guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter) and [web guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- [transformers.js v4 blog](https://huggingface.co/blog/transformersjs-v4)
- [transformers.js `env` docs](https://huggingface.co/docs/transformers.js/api/env)
- [transformers.js dtypes guide](https://huggingface.co/docs/transformers.js/guides/dtypes)
- [transformers.js WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu)
- [transformers.js pipelines docs](https://huggingface.co/docs/transformers.js/api/pipelines)
- [transformers.js 3.4.0 release](https://github.com/huggingface/transformers.js/releases/tag/3.4.0)
- [transformers.js examples](https://github.com/huggingface/transformers.js-examples)
- [ONNX Runtime Web env flags and session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [img.ly: WebGPU background removal](https://img.ly/blog/browser-background-removal-using-onnx-runtime-webgpu/)
- [dev.to: WebGPU vs WASM in onnxruntime-web](https://dev.to/yue_shu_c621a4a637f22396f/webgpu-vs-wasm-in-onnxruntime-web-14x-to-94x-faster-on-the-same-mac-depending-on-the-model-li5)
- [dev.to: background removal in the browser (licenses, models, frozen tab)](https://dev.to/androve2k/removing-a-photos-background-in-the-browser-with-no-upload-ai-licenses-onnx-models-and-a-1cc0)

**Web platform**

- [web.dev: WebGPU supported in major browsers](https://web.dev/blog/webgpu-supported-major-browsers)
- [caniuse: WebGPU](https://caniuse.com/webgpu)
- [MDN: WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [MDN: storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
- [Vite server options](https://vite.dev/config/server-options)

**Geometry**

- [Laurentini 1994, the visual hull](https://www.semanticscholar.org/paper/The-Visual-Hull-Concept-for-Silhouette-Based-Image-Laurentini/033cc3784a60115d758a11a765e764b86aca336c)
- [Franco & Boyer, ICCV 2005](https://mlanthology.org/iccv/2005/franco2005iccv-fusion/)
- [Steinmetz solid (Wikipedia)](https://en.wikipedia.org/wiki/Steinmetz_solid)
- [Teddy (Igarashi et al. 1999)](https://www.cs.toronto.edu/~jacobson/seminar/igarashi-et-al-1999.pdf)
- [Monster Mash paper](https://dcgi.fel.cvut.cz/home/sykorad/Dvoroznak20-SA.pdf), [code](https://github.com/google/monster-mash) and [web demo](https://monstermash.zone/)
- [Felzenszwalb & Huttenlocher 2012, distance transforms](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf)
- [Taubin 1995](http://mesh.brown.edu/taubin/pdfs/taubin-sg95.pdf)
- [Geodesics in Heat (PDF)](https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Crane12.pdf)
- [CGAL heat method](https://doc.cgal.org/latest/Heat_method_3/index.html)
- [geometry-processing-js](https://github.com/GeometryCollective/geometry-processing-js)
- [0fps: smooth voxel terrain, part 2](https://0fps.net/2012/07/12/smooth-voxel-terrain-part-2/)
- [three.js MarchingCubes addon (0.186.1)](https://unpkg.com/three@0.186.1/examples/jsm/objects/MarchingCubes.js)
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
- [meshoptimizer](https://github.com/zeux/meshoptimizer)
- [manifold](https://github.com/elalish/manifold)
- [AmiGo](https://github.com/karinsifri/AmiGo)
- [Waechter et al. 2014, "Let There Be Color!"](https://link.springer.com/content/pdf/10.1007/978-3-319-10602-1_54.pdf)
- [GrabCut (Rother et al. 2004)](https://www.microsoft.com/en-us/research/wp-content/uploads/2004/08/siggraph04-grabcut.pdf)

**Generative 3D**

- [TripoSR (GitHub)](https://github.com/VAST-AI-Research/TripoSR) and [stabilityai/TripoSR](https://huggingface.co/stabilityai/TripoSR)
- [brodatech/triposr-onnx](https://huggingface.co/brodatech/triposr-onnx)
- [SpawnDev.ILGPU.ML](https://github.com/LostBeard/SpawnDev.ILGPU.ML)
- [Yosun/TripoSplat-WebGPU](https://huggingface.co/Yosun/TripoSplat-WebGPU)
- [Stable Fast 3D (GitHub)](https://github.com/Stability-AI/stable-fast-3d) and [announcement](https://stability.ai/news-updates/introducing-stable-fast-3d)
- [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) and its [license](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE)
- [TRELLIS.2](https://github.com/microsoft/TRELLIS.2)
- [Apple ml-sharp](https://github.com/apple/ml-sharp) and [sm079/sharp-onnx-webgpu](https://huggingface.co/sm079/sharp-onnx-webgpu)
- [VGGT](https://github.com/facebookresearch/vggt)
- [neurangelo-web](https://github.com/kushsmhsmh/neurangelo-web)

**Package metadata:** npm registry (`npm view <pkg> version license time`), queried 2026-09-30.
