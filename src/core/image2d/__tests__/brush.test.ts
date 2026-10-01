import { describe, expect, it } from 'vitest';
import { fillDisc, fillRect, fromFn, solid } from '../../../test/rgba';
import type { ChartSettings, CropRect } from '../../../types/chart';
import type { RgbaImage } from '../../../types/geometry';
import { resolveBackground } from '../background';
import { BRUSH_BACKGROUND, BRUSH_SUBJECT, brushGridSize, brushKey, mapBrush, type BackgroundEdits } from '../brush';
import { ChartCache, LruCache } from '../cache';
import { applyCrop } from '../crop';
import { limitedSize, toLinearImage } from '../linear';
import { contentId, prepareKey, prepareWork, type SampleRequest } from '../sample';

const CREAM = '#f3ead8';

/** Cream background; a red disc with a dark outline and an enclosed cream hole; a blue bar touching the right edge. */
function picture(): RgbaImage {
  const img = solid(200, 160, CREAM);
  fillDisc(img, 80, 80, 44, '#202020');
  fillDisc(img, 80, 80, 40, '#d23a3a');
  fillDisc(img, 80, 80, 12, CREAM);
  fillRect(img, 150, 60, 50, 40, '#3a6fd9');
  return img;
}

function brushOf(w: number, h: number, paint: (x: number, y: number) => number): BackgroundEdits {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = paint(x, y);
  return { w, h, data };
}

const settings = (over: Partial<ChartSettings> = {}): SampleRequest['settings'] => ({
  technique: 'sc_graphgan',
  widthIn: 20,
  lockAspect: true,
  border: { widthIn: 0 },
  imageKind: 'flat',
  background: 'remove',
  ...over,
});

const transparentAt = (img: { w: number; data: Float32Array }, x: number, y: number): boolean => img.data[(y * img.w + x) * 4 + 3] === 0;

describe('the background brush (§2.3.2, integration task T1-2)', () => {
  it('the brush grid is limitedSize of the uncropped source (roundHalfUp)', () => {
    expect(brushGridSize(200, 160)).toEqual({ w: 200, h: 160 });
    expect(brushGridSize(4000, 3000)).toEqual({ w: 2048, h: 1536 });
    // 2048 · 1001 / 4096 = 500.5 → 501 (a tie rounds up).
    expect(limitedSize(4096, 1001)).toEqual({ w: 2048, h: 501 });
  });

  it('a brushed hole stays background; without the brush the enclosed hole is subject', () => {
    const img = picture();
    const without = prepareWork({ image: img, settings: settings() });
    expect(without.bg.source).toBe('plain');
    expect(transparentAt(without.work, 80, 80)).toBe(false);
    expect(transparentAt(without.work, 2, 2)).toBe(true);
    const edits = brushOf(200, 160, (x, y) => (Math.hypot(x - 80, y - 80) < 10 ? BRUSH_BACKGROUND : 0));
    const withBrush = prepareWork({ image: img, settings: settings(), backgroundEdits: edits });
    expect(transparentAt(withBrush.work, 80, 80)).toBe(true);
    // Only the brushed pixels: the brush does not start a fill (the hole's rim at r = 11 stays subject).
    expect(transparentAt(withBrush.work, 80 + 11, 80)).toBe(false);
    expect(withBrush.bg.subjectShare).toBeLessThan(without.bg.subjectShare);
    expect(withBrush.issues.map((i) => i.code)).not.toContain('W_BG_EDITS_STALE');
  });

  it('a brushed subject pixel next to the border stays subject and walls the fill', () => {
    const img = picture();
    // A cream patch at the left border, brushed as subject.
    const edits = brushOf(200, 160, (x, y) => (x < 6 && y >= 70 && y < 90 ? BRUSH_SUBJECT : 0));
    const r = prepareWork({ image: img, settings: settings(), backgroundEdits: edits });
    expect(transparentAt(r.work, 0, 75)).toBe(false);
    expect(transparentAt(r.work, 5, 89)).toBe(false);
    expect(transparentAt(r.work, 0, 60)).toBe(true);
    expect(transparentAt(r.work, 6, 75)).toBe(true); // reached around the patch
  });

  it('a brushed background pixel lets a fill that reaches it pass (a brushed channel opens an enclosed hole)', () => {
    const img = picture();
    // A channel from the left border to the hole, through the disc: background brushed only on the outline and
    // the red (the cream hole itself is not brushed, but is reached through the channel).
    const edits = brushOf(200, 160, (x, y) => (y >= 78 && y <= 82 && x >= 30 && x <= 69 ? BRUSH_BACKGROUND : 0));
    const r = prepareWork({ image: img, settings: settings(), backgroundEdits: edits });
    expect(transparentAt(r.work, 80, 80)).toBe(true);
    expect(transparentAt(r.work, 80, 70)).toBe(true);
    expect(transparentAt(r.work, 80, 100)).toBe(false); // red disc stays subject
  });

  it('maps the brush through every rotation and flip of a crop (nearest neighbour, pixel exact at full size)', () => {
    const src = fromFn(37, 23, () => '#ffffff');
    // A brush with a distinct value pattern: compare the mapping with applyCrop applied to the brush itself.
    const edits = brushOf(37, 23, (x, y) => ((x * 7 + y * 3) % 5 === 0 ? BRUSH_BACKGROUND : (x + 2 * y) % 7 === 0 ? BRUSH_SUBJECT : 0));
    const brushImg = fromFn(37, 23, (x, y) => [edits.data[y * 37 + x], 0, 0, 255]);
    for (const rotate of [0, 90, 180, 270] as const) {
      for (const flipX of [false, true]) {
        const crop: CropRect = { x: 5, y: 3, w: 25, h: 17, rotate, flipX };
        const cropped = applyCrop(src, crop);
        const expected = applyCrop(brushImg, crop);
        const { map, issues } = mapBrush(edits, src, crop, cropped);
        expect(issues).toEqual([]);
        expect(map).toBeDefined();
        for (let i = 0; i < cropped.w * cropped.h; i++) expect(map![i], `rotate ${rotate} flip ${flipX} pixel ${i}`).toBe(expected.data[i * 4]);
      }
    }
  });

  it('maps a large source through its reduced brush grid and a scaled-down working image', () => {
    // 4096 × 1024 source → brush grid 2048 × 512; the right half brushed as background; crop the middle and turn it.
    const src = { w: 4096, h: 1024 };
    const grid = brushGridSize(src.w, src.h);
    expect(grid).toEqual({ w: 2048, h: 512 });
    const edits = brushOf(grid.w, grid.h, (x) => (x >= 1024 ? BRUSH_BACKGROUND : 0));
    const crop: CropRect = { x: 1024, y: 0, w: 2048, h: 1024, rotate: 90, flipX: false };
    // After a 90° turn the crop is 1024 wide and 2048 tall: the source's left part (x < 2048) is at the TOP.
    const work = { w: 512, h: 1024 };
    const { map } = mapBrush(edits, src, crop, work);
    expect(map).toBeDefined();
    expect(map![10 * 512 + 100]).toBe(0); // top rows: source x ≈ 1024 + 20
    expect(map![1000 * 512 + 100]).toBe(BRUSH_BACKGROUND); // bottom rows: source x ≈ 3024
    // Row 511 (source x = 1024 + 1022 = 2046) is still automatic; row 513 (2050) is brushed.
    expect(map![511 * 512]).toBe(0);
    expect(map![513 * 512]).toBe(BRUSH_BACKGROUND);
  });

  it('a brush of another size is ignored with W_BG_EDITS_STALE (warn)', () => {
    const img = picture();
    const stale = brushOf(100, 80, () => BRUSH_BACKGROUND);
    const r = prepareWork({ image: img, settings: settings(), backgroundEdits: stale });
    const issue = r.issues.find((i) => i.code === 'W_BG_EDITS_STALE');
    expect(issue?.severity).toBe('warn');
    expect(transparentAt(r.work, 80, 80)).toBe(false); // nothing of the stale brush applied
    // A malformed brush (data length off) is stale too, never a crash.
    const broken = { w: 200, h: 160, data: new Uint8Array(10) };
    expect(prepareWork({ image: img, settings: settings(), backgroundEdits: broken }).issues.map((i) => i.code)).toContain('W_BG_EDITS_STALE');
  });

  it('the brush applies only with "remove"', () => {
    const img = picture();
    const edits = brushOf(200, 160, () => BRUSH_BACKGROUND);
    const keep = prepareWork({ image: img, settings: settings({ background: 'keep' }), backgroundEdits: edits });
    expect(keep.bg.source).toBe('none');
    expect(transparentAt(keep.work, 2, 2)).toBe(false);
    expect(keep.issues).toEqual([]);
    const stale = prepareWork({ image: img, settings: settings({ background: 'keep' }), backgroundEdits: brushOf(3, 3, () => 1) });
    expect(stale.issues).toEqual([]);
  });

  it('without a plain background the brushed pixels are the background, in their mean color, with no W_BG_NOT_FOUND', () => {
    const img = fromFn(120, 90, (x, y) => [(x * 2) % 256, (y * 3) % 256, 128]); // no plain ring
    const none = prepareWork({ image: img, settings: settings() });
    expect(none.issues.map((i) => i.code)).toContain('W_BG_NOT_FOUND');
    const edits = brushOf(120, 90, (x) => (x < 20 ? BRUSH_BACKGROUND : 0));
    const r = prepareWork({ image: img, settings: settings(), backgroundEdits: edits });
    expect(r.issues.map((i) => i.code)).not.toContain('W_BG_NOT_FOUND');
    expect(r.bg.source).toBe('plain');
    expect(r.bg.hexFrom).toBe('brush');
    expect(transparentAt(r.work, 5, 50)).toBe(true);
    expect(transparentAt(r.work, 25, 50)).toBe(false);
  });

  it('on a transparent picture brushed background joins the transparency', () => {
    const img = fromFn(60, 60, (x, y) => (x < 10 ? [0, 0, 0, 0] : y < 30 ? '#ff0000' : '#0000ff'));
    const edits = brushOf(60, 60, (_x, y) => (y >= 50 ? BRUSH_BACKGROUND : 0));
    const work = toLinearImage(img);
    const r = resolveBackground(work, { background: 'remove' }, edits.data);
    expect(r.info.source).toBe('alpha');
    expect(transparentAt(r.image, 30, 55)).toBe(true);
    expect(transparentAt(r.image, 30, 45)).toBe(false);
  });
});

describe('caching the prepared image (integration task T1-1)', () => {
  it('the cache key changes with the brush (by key, else by its bytes) and ignores it with "keep"', () => {
    const base = { crop: undefined, settings: settings() };
    const a = brushOf(4, 4, () => 0);
    const b = brushOf(4, 4, (x) => (x === 0 ? 1 : 0));
    expect(prepareKey('S', base)).not.toBe(prepareKey('S', { ...base, backgroundEdits: a }));
    expect(prepareKey('S', { ...base, backgroundEdits: a })).not.toBe(prepareKey('S', { ...base, backgroundEdits: b }));
    expect(prepareKey('S', { ...base, backgroundEdits: { ...a, key: 'sha-1' } })).not.toBe(prepareKey('S', { ...base, backgroundEdits: { ...a, key: 'sha-2' } }));
    // The asset key is the identity: the same key means the same brush.
    expect(prepareKey('S', { ...base, backgroundEdits: { ...a, key: 'sha-1' } })).toBe(prepareKey('S', { ...base, backgroundEdits: { ...b, key: 'sha-1' } }));
    expect(brushKey(a)).toBe(brushKey(brushOf(4, 4, () => 0)));
    const keep = { crop: undefined, settings: settings({ background: 'keep' }) };
    expect(prepareKey('S', keep)).toBe(prepareKey('S', { ...keep, backgroundEdits: b }));
    expect(prepareKey('S', base)).not.toBe(prepareKey('T', base));
  });

  it('contentId is exact: one changed byte changes it', () => {
    const img = picture();
    const other = picture();
    expect(contentId(img)).toBe(contentId(other));
    other.data[200 * 80 * 4 + 4 * 199 + 2] ^= 1;
    expect(contentId(img)).not.toBe(contentId(other));
  });

  it('ChartCache: prepared work is cached by sourceId, else by content; a new crop or brush recomputes', () => {
    const cache = new ChartCache();
    const img = picture();
    const req = { image: img, settings: settings() };
    const first = cache.prepare(req, 'asset-1');
    expect(first.hit).toBe(false);
    const second = cache.prepare(req, 'asset-1');
    expect(second.hit).toBe(true);
    expect(second.value).toBe(first.value);
    // Without a sourceId the content id is the identity.
    const c1 = cache.prepare(req);
    expect(c1.hit).toBe(false);
    expect(c1.key.startsWith(contentId(img))).toBe(true);
    expect(cache.prepare({ ...req, image: picture() }).hit).toBe(true);
    // Another crop, another brush: misses.
    expect(cache.prepare({ ...req, crop: { x: 0, y: 0, w: 100, h: 100, rotate: 0, flipX: false } }, 'asset-1').hit).toBe(false);
    expect(cache.prepare({ ...req, backgroundEdits: brushOf(200, 160, () => 0) }, 'asset-1').hit).toBe(false);
  });

  it('ChartCache: a source is decoded once per sourceId', async () => {
    const cache = new ChartCache();
    let decodes = 0;
    const decode = async (): Promise<RgbaImage> => {
      decodes++;
      return solid(4, 4, '#123456');
    };
    const a = await cache.image('sha-a', decode);
    const b = await cache.image('sha-a', decode);
    expect(decodes).toBe(1);
    expect(b.hit).toBe(true);
    expect(b.value).toBe(a.value);
    await cache.image(undefined, decode);
    await cache.image(undefined, decode);
    expect(decodes).toBe(3);
  });

  it('ChartCache: concurrent requests share one decode; a failed decode is not cached', async () => {
    const cache = new ChartCache();
    let decodes = 0;
    const slow = (): Promise<RgbaImage> => {
      decodes++;
      return new Promise((resolve) => setTimeout(() => resolve(solid(2, 2, '#000000')), 5));
    };
    const [a, b] = await Promise.all([cache.image('s', slow), cache.image('s', slow)]);
    expect(decodes).toBe(1);
    expect(a.value).toBe(b.value);
    await expect(cache.image('bad', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.decoded.has('bad')).toBe(false);
  });

  it('LruCache evicts the least recently used entry', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(2);
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});
