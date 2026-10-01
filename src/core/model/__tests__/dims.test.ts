import { describe, expect, it } from 'vitest';
import type { Part } from '../../../types/model';
import { sanePart } from '../dims';
import { readEveryType } from './helpers/everyType';
import { part, readSpecExample, samplePrimitives } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

describe('sanePart: the dims the geometry kernels work with', () => {
  it('returns a valid part as it is — the same object', () => {
    for (const model of [readSpecExample(), buildCanonicalTeddy().model, readEveryType()]) {
      for (const p of model.parts) expect(sanePart(p), p.id).toBe(p);
    }
    for (const p of samplePrimitives()) expect(sanePart(p)).toBe(p);
    // zero is a length; a profile may start below 0 and touch the axis
    const zero = part('sphere', { r: 0 });
    expect(sanePart(zero)).toBe(zero);
    const lathe = part('lathe', { profile: [[0, -1], [1, 0], [0, 2]] });
    expect(sanePart(lathe)).toBe(lathe);
  });

  it('a non-finite number becomes 0, a negative length its size; everything else on the part is kept', () => {
    const p = part('ellipsoid', { rx: -1, ry: Number.NaN, rz: Number.POSITIVE_INFINITY }, { id: 'e', position: [1, 2, 3], notes: 'kept' });
    const sane = sanePart(p);
    expect(sane).not.toBe(p);
    expect(sane.dims).toEqual({ rx: 1, ry: 0, rz: 0 });
    expect(sane.id).toBe('e');
    expect(sane.position).toBe(p.position);
    expect(sane.notes).toBe('kept');
    expect(p.dims.rx).toBe(-1); // the input is not modified
    expect(sanePart(part('capsule', { r: -0.5, length: Number.NaN })).dims).toEqual({ r: 0.5, length: 0 });
    expect(sanePart(part('cylinder', { rTop: -1, rBottom: 2, h: -3, open: 'both' })).dims).toEqual({ rTop: 1, rBottom: 2, h: 3, open: 'both' });
    expect(sanePart(part('torus', { R: 1, r: 0.2, arcDeg: Number.NaN })).dims).toEqual({ R: 1, r: 0.2 });
    expect(sanePart(part('torus', { R: -1, r: 0.2, arcDeg: 90 })).dims).toEqual({ R: 1, r: 0.2, arcDeg: 90 });
    expect(sanePart(part('box', { w: -1, h: 2, d: Number.NaN })).dims).toEqual({ w: 1, h: 2, d: 0 });
    expect(sanePart(part('mesh', { meshRef: 'm', bboxIn: [1, -2, Number.NaN] })).dims).toEqual({ meshRef: 'm', bboxIn: [1, 2, 0] });
  });

  it('profiles and polygons: radii are sized, broken points are dropped or zeroed', () => {
    expect(sanePart(part('lathe', { profile: [[-1, 0], [Number.NaN, 1], [0.5, Number.NaN]] })).dims).toEqual({ profile: [[1, 0], [0, 1], [0.5, 0]] });
    expect(sanePart(part('lathe', { profile: 'round' as unknown as [number, number][] })).dims).toEqual({ profile: [] });
    const polygon = sanePart(part('flat', { shape: 'polygon', w: 1, h: -1, thickness: 0.2, points: [[0, 0], [Number.NaN, 1], [1, 0], [1, 1]] }));
    expect(polygon.dims).toEqual({ shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0], [1, 0], [1, 1]] });
  });

  it('a part without dims becomes a zero-size shape of its type; an unknown type is left alone', () => {
    const bare = (type: string): Part => ({ id: 'x', type, position: [0, 0, 0], color: 'c1' }) as unknown as Part;
    expect(sanePart(bare('sphere')).dims).toEqual({ r: 0 });
    expect(sanePart(bare('capsule')).dims).toEqual({ r: 0, length: 0 });
    expect(sanePart(bare('lathe')).dims).toEqual({ profile: [] });
    expect(sanePart(bare('flat')).dims).toEqual({ shape: 'rect', w: 0, h: 0, thickness: 0 });
    expect(sanePart(bare('mesh')).dims).toEqual({ meshRef: '', bboxIn: [0, 0, 0] });
    const unknown = bare('egg');
    expect(sanePart(unknown)).toBe(unknown);
  });
});
