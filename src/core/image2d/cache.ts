// Caches for the 2D pipeline (integration task 1 of Sprint 1; DESIGN.md §5.8). Track T1. Pure, no DOM.
//
// The chart2d worker keeps one `ChartCache`: the decoded `RgbaImage` by `ChartRequest.sourceId` (a Blob is
// decoded once per source, not per slider tick) and the prepared work (`prepareWork`: crop, kind, working image,
// background) under `prepareKey(sourceId, req)`, falling back to the exact content id of the decoded image when
// the request has no `sourceId`. Only the size- and color-dependent stages rerun on a size or color change.
import type { RgbaImage } from '../../types/geometry';
import { contentId, prepareKey, prepareWork, type PreparedWork, type SampleRequest } from './sample';

/** A small least-recently-used map (insertion order of a Map is the recency order). */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`LruCache: capacity must be a whole number ≥ 1, got ${capacity}`);
  }
  get size(): number {
    return this.map.size;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
  }
  clear(): void {
    this.map.clear();
  }
}

/** What `ChartCache.prepared` reports with each result (for tests and the worker's timing log). */
export interface CacheLookup<V> {
  value: V;
  key: string;
  hit: boolean;
}

/**
 * The worker's caches. Working images are large (a 2048² picture is 64 MB of floats), so both caches are small:
 * a source switch back and forth stays cached, nothing more.
 */
export class ChartCache {
  readonly decoded: LruCache<string, RgbaImage>;
  readonly prepared: LruCache<string, PreparedWork>;
  constructor(o: { decoded?: number; prepared?: number } = {}) {
    this.decoded = new LruCache(o.decoded ?? 2);
    this.prepared = new LruCache(o.prepared ?? 2);
  }

  /**
   * The decoded source: from the cache when `sourceId` is known, else `decode()` (stored under `sourceId` when
   * given). A request without `sourceId` is decoded every time (its content id needs the decoded bytes).
   */
  async image(sourceId: string | undefined, decode: () => Promise<RgbaImage>): Promise<CacheLookup<RgbaImage>> {
    if (sourceId !== undefined && sourceId !== '') {
      const cached = this.decoded.get(sourceId);
      if (cached !== undefined) return { value: cached, key: sourceId, hit: true };
      const value = await decode();
      this.decoded.set(sourceId, value);
      return { value, key: sourceId, hit: false };
    }
    const value = await decode();
    return { value, key: contentId(value), hit: false };
  }

  /** `prepareWork(req)`, cached under `prepareKey(sourceId ?? contentId(req.image), req)`. */
  prepare(req: Pick<SampleRequest, 'image' | 'crop' | 'settings' | 'stats' | 'backgroundEdits'>, sourceId?: string): CacheLookup<PreparedWork> {
    const id = sourceId !== undefined && sourceId !== '' ? sourceId : contentId(req.image);
    const key = prepareKey(id, req);
    const cached = this.prepared.get(key);
    if (cached !== undefined) return { value: cached, key, hit: true };
    const value = prepareWork(req);
    this.prepared.set(key, value);
    return { value, key, hit: false };
  }

  clear(): void {
    this.decoded.clear();
    this.prepared.clear();
  }
}
