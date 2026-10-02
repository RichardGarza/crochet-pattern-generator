// Test helpers for T3.3: orthographic, flat-colored "photos" of crochet models, rendered in code (DESIGN.md §6.3 T3:
// the teddy view fixtures are rendered in code until scripts/make-fixtures.mjs exists; §6.1 rule 5: nothing is
// downloaded). Every part is tessellated by the builder and drawn with a depth buffer (core/recon/raster.ts), so the
// silhouettes, the occlusions and the colors are exact; the background is a plain off-white.
import { readFileSync } from 'node:fs';
import type { ResolvedGauge } from '../../../../types/gauge';
import type { PhotoView, ReconRequest, ReconSettings, RgbaImage, Vec3, ViewLabel } from '../../../../types/geometry';
import type { CrochetModelV1, Part } from '../../../../types/model';
import { parseHex } from '../../../kernel/color';
import { tessellatePart } from '../../../model/builder';
import { localToWorld, modelBounds } from '../../../model/transforms';
import { emptyRaster, projectPoints, rasterize, viewCoords, type OrthoCamera } from '../../raster';
import { GAUGE, SETTINGS } from './requests';

/** The canonical Claude Design teddy (17 parts, eyes, nose, muzzle; 9.88 in tall). */
export const TEDDY_MODEL = JSON.parse(readFileSync(new URL('../../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;

export const BACKGROUND = '#f4f1ea';

export interface RenderOptions {
  w?: number;
  h?: number;
  /** Pixels per inch (default: the model fills 80% of the image's height or width). */
  pxPerIn?: number;
  /** The color of a surface point (world inches) of part `part`; default the part's palette color. */
  colorAt?: (part: Part, p: Vec3) => string;
  /** Lambert shading strength 0 … 1 (0 = flat colors, the "ortho" fixtures). */
  shade?: number;
}

export interface RenderedView {
  label: ViewLabel;
  image: RgbaImage;
  /** 1 = object. */
  mask: Uint8Array<ArrayBuffer>;
  w: number;
  h: number;
  /** Per pixel: the index of the part seen there, −1 = background. */
  partAt: Int32Array<ArrayBuffer>;
  /** Per pixel: the color drawn (hex), '' = background. */
  hexAt: string[];
  /** The world position of each pixel's visible surface point (NaN = background). */
  pointAt: Float64Array<ArrayBuffer>;
  pxPerIn: number;
}

/** Every part's builder tessellation in model space (inches). */
export function modelTriangles(model: CrochetModelV1): { positions: Float64Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer>; partOfTri: Int32Array<ArrayBuffer> } {
  const pos: number[] = [];
  const idx: number[] = [];
  const partOfTri: number[] = [];
  model.parts.forEach((p, k) => {
    const t = tessellatePart(p);
    const base = pos.length / 3;
    for (let i = 0; i < t.positions.length; i += 3) pos.push(...localToWorld(p, [t.positions[i], t.positions[i + 1], t.positions[i + 2]]));
    for (let i = 0; i < t.indices.length; i++) idx.push(base + t.indices[i]);
    for (let i = 0; i < t.indices.length / 3; i++) partOfTri.push(k);
  });
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx), partOfTri: Int32Array.from(partOfTri) };
}

/** An orthographic view of a model (§2.9.2 conventions), the model's projected box centered in the image. */
export function renderModelView(model: CrochetModelV1, label: ViewLabel, o: RenderOptions = {}): RenderedView {
  const w = o.w ?? 400;
  const h = o.h ?? 400;
  const b = modelBounds(model);
  const lo = viewCoords(label, b.min);
  const hi = viewCoords(label, b.max);
  const aMin = Math.min(lo[0], hi[0]);
  const aMax = Math.max(lo[0], hi[0]);
  const bMin = Math.min(lo[1], hi[1]);
  const bMax = Math.max(lo[1], hi[1]);
  const s = o.pxPerIn ?? 0.8 * Math.min(w / (aMax - aMin), h / (bMax - bMin));
  const cam: OrthoCamera = { label, w, h, s, cx: w / 2, cy: h / 2, a0: (aMin + aMax) / 2, b0: (bMin + bMax) / 2 };
  const tris = modelTriangles(model);
  const { xy, z } = projectPoints(cam, tris.positions);
  const r = rasterize(emptyRaster(w, h), xy, z, tris.indices);
  const data = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  const partAt = new Int32Array(w * h).fill(-1);
  const hexAt: string[] = new Array<string>(w * h).fill('');
  const pointAt = new Float64Array(3 * w * h).fill(Number.NaN);
  const bg = parseHex(BACKGROUND);
  const palette = new Map(model.palette.map((c) => [c.id, c.hex]));
  for (let k = 0; k < w * h; k++) {
    const t = r.tri[k];
    if (t < 0) {
      data.set([bg[0], bg[1], bg[2], 255], 4 * k);
      continue;
    }
    const part = model.parts[tris.partOfTri[t]];
    const i0 = tris.indices[3 * t];
    const i1 = tris.indices[3 * t + 1];
    const i2 = tris.indices[3 * t + 2];
    const b1 = r.bary[2 * k];
    const b2 = r.bary[2 * k + 1];
    const b0 = 1 - b1 - b2;
    const p: Vec3 = [0, 1, 2].map((c) => b0 * tris.positions[3 * i0 + c] + b1 * tris.positions[3 * i1 + c] + b2 * tris.positions[3 * i2 + c]) as Vec3;
    const hex = o.colorAt ? o.colorAt(part, p) : (palette.get(part.color) ?? '#808080');
    let rgb = parseHex(hex);
    if (o.shade) {
      const e1 = [0, 1, 2].map((c) => tris.positions[3 * i1 + c] - tris.positions[3 * i0 + c]);
      const e2 = [0, 1, 2].map((c) => tris.positions[3 * i2 + c] - tris.positions[3 * i0 + c]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const cn = Math.abs(viewCoords(label, n as Vec3)[2]) / (Math.hypot(...n) || 1);
      const f = 1 - o.shade + o.shade * cn;
      rgb = [rgb[0] * f, rgb[1] * f, rgb[2] * f];
    }
    data.set([Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), 255], 4 * k);
    mask[k] = 1;
    partAt[k] = tris.partOfTri[t];
    hexAt[k] = hex;
    pointAt.set(p, 3 * k);
  }
  return { label, image: { w, h, data }, mask, w, h, partAt, hexAt, pointAt, pxPerIn: s };
}

/** A ReconRequest from rendered views (their images and their exact masks). */
export function requestFromRenders(views: readonly RenderedView[], settings: Partial<ReconSettings> = {}, o: { gauge?: ResolvedGauge; jobId?: number; ids?: string[] } = {}): ReconRequest {
  return {
    jobId: o.jobId ?? 1,
    settings: { ...SETTINGS, ...settings },
    gauge: o.gauge ?? GAUGE,
    views: views.map((v, i) => {
      const id = o.ids?.[i] ?? v.label;
      const view: PhotoView = { id, imageKey: `img:${id}`, label: v.label, align: { scale: 1, dx: 0, dy: 0, rot90: 0, mirror: false } };
      return { view, image: v.image, mask: v.mask, maskW: v.w, maskH: v.h };
    }),
  };
}

/** A cylinder with three horizontal stripes (§6.3 T3 "striped-cylinder"): radius 1.5 in, 6 in tall, base at y = 0. */
export const STRIPES = ['#c8372d', '#f2e3c6', '#2f5aa8'] as const;
export const STRIPED_CYLINDER: CrochetModelV1 = {
  schema: 'crochet-model',
  version: '1.0',
  revision: 1,
  units: 'in',
  axes: { up: '+Y', front: '+Z', left: '+X' },
  name: 'Striped cylinder',
  finishedSize: { height: 6 },
  palette: STRIPES.map((hex, i) => ({ id: `s${i}`, hex })),
  parts: [{ id: 'body', type: 'cylinder', dims: { rTop: 1.5, rBottom: 1.5, h: 6 }, position: [0, 3, 0], color: 's0' }],
};
/** The stripe (0 bottom … 2 top) of a height on the striped cylinder. */
export const stripeOf = (y: number): number => Math.max(0, Math.min(2, Math.floor(y / 2)));
export const stripedColorAt = (_: Part, p: Vec3): string => STRIPES[stripeOf(p[1])];

export { GAUGE, SETTINGS };
