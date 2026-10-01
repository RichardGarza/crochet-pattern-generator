import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { attachGraph, isOneTree } from '../attach';
import { overlapAlongRay } from '../place';
import { scaleMesh, scaleModel, scalePartDims } from '../scale';
import { validateModel } from '../schema';
import { boundsSize, groundCenter, modelBounds, modelHeight, worldBounds } from '../transforms';
import { readEveryType, readEveryTypeMeshes } from './helpers/everyType';
import { modelOf, part, readSpecExample } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

const teddy = buildCanonicalTeddy().model;
const everyType = readEveryType();

/** Every number in a dims object, flattened. */
function numbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbers);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbers);
  return [];
}

describe('scaleModel (§4.2 "Scale model to height": uniform, about the ground center)', () => {
  it('the height scales by the factor; so do the width, the depth and finishedSize', () => {
    for (const factor of [0.5, 1.5, 2, 1.2345]) {
      const { model } = scaleModel(teddy, factor);
      expect(modelHeight(model)).toBeCloseTo(modelHeight(teddy) * factor, 5);
      const before = boundsSize(modelBounds(teddy));
      const after = boundsSize(modelBounds(model));
      for (let k = 0; k < 3; k++) expect(after[k]).toBeCloseTo(before[k] * factor, 5);
      expect(model.finishedSize.height).toBeCloseTo(teddy.finishedSize.height * factor, 5);
      expect(Math.abs(modelBounds(model).min[1])).toBeLessThan(2e-6); // still grounded
    }
    const scaled = scaleModel(everyType, 2).model;
    expect(scaled.finishedSize).toEqual({
      height: everyType.finishedSize.height * 2,
      width: (everyType.finishedSize.width as number) * 2,
      depth: (everyType.finishedSize.depth as number) * 2,
    });
  });

  it('scales every dimension and every position: a grounded model has every coordinate multiplied by the factor', () => {
    const { model } = scaleModel(teddy, 1.5);
    model.parts.forEach((p, i) => {
      const q = teddy.parts[i];
      expect(p.id).toBe(q.id);
      expect(p.type).toBe(q.type);
      for (let k = 0; k < 3; k++) expect(p.position[k]).toBeCloseTo(q.position[k] * 1.5, 5);
      expect(numbers(p.dims)).toEqual(numbers(q.dims).map((v) => Math.round(v * 1.5 * 1e6) / 1e6));
      expect(p.rotationDeg).toEqual(q.rotationDeg);
      expect(p.attach).toEqual(q.attach);
      expect(p.color).toBe(q.color);
      // the world box of every part scales about the ground center
      const a = worldBounds(p);
      const b = worldBounds(q);
      for (let k = 0; k < 3; k++) {
        expect(a.min[k]).toBeCloseTo(b.min[k] * 1.5, 4);
        expect(a.max[k]).toBeCloseTo(b.max[k] * 1.5, 4);
      }
    });
    expect(model.palette).toBe(teddy.palette);
    expect(model.name).toBe(teddy.name);
  });

  it('scales lathe profiles, polygon points, mesh boxes, region lengths, feature sizes and seeds — not angles, fractions, indices or paint', () => {
    const { model } = scaleModel(everyType, 2);
    const by = (m: CrochetModelV1): Record<string, Part> => Object.fromEntries(m.parts.map((p) => [p.id, p]));
    const a = by(model);
    const b = by(everyType);
    expect(a.body.dims).toEqual({
      profile: [
        [0, 0],
        [2, 0],
        [2.9, 1.32],
        [3, 2.52],
        [2.46, 4.2],
        [1.64, 5.52],
        [0, 6],
      ],
      sharp: [1],
    });
    expect(a.body.regions).toEqual([
      { kind: 'band', from: 0, to: 0.15, color: 'c2' },
      { kind: 'stripes', from: 0.2, to: 0.5, colors: ['c2', 'c3'], widthIn: 0.5 },
      { kind: 'patch', azimuthDeg: 0, spanDeg: 90, from: 0.5, to: 0.8, color: 'c4' },
      { kind: 'spot', azimuthDeg: 120, elevationDeg: 10, radiusIn: 0.6, color: 'c5' },
      { kind: 'pattern', pattern: 'spots', colors: ['c3'], scaleIn: 0.8, coverage: 0.3, from: 0.8, to: 1 },
    ]);
    expect(a.star.type === 'flat' && a.star.dims.points?.[0]).toEqual([0, 0.5]);
    expect(a.star.type === 'flat' && a.star.dims).toMatchObject({ shape: 'polygon', w: 1, h: 0.96, thickness: 0.16 });
    expect(a.tail.dims).toEqual({ R: 1, r: 0.3, arcDeg: 200 });
    expect(a.leg_l.dims).toEqual({ rTop: 0.8, rBottom: 1, h: 2.4, open: 'top' });
    expect(a.blob.dims).toEqual({ meshRef: 'every-type-blob', bboxIn: [1.6, 1.2, 1.4] });
    expect(a.blob.crochet).toEqual({ make: 'piece', seed: [0, 0.6, 0] });
    expect(a.head.paint).toBe(b.head.paint);
    expect(a.belly.flatten).toBe(0.5);
    expect(a.snout.crochet).toEqual(b.snout.crochet);
    expect(a.body['x-note']).toBe(b.body['x-note']);
    expect(model['x-cpg']).toEqual(everyType['x-cpg']);
    const feature = (m: CrochetModelV1, id: string) => m.features?.find((f) => f.id === id);
    expect(feature(model, 'eye_l')).toEqual({ ...feature(everyType, 'eye_l'), sizeMm: 18 });
    expect(feature(model, 'nose')).toEqual({ ...feature(everyType, 'nose'), sizeIn: 0.3 });
    expect(feature(model, 'mouth')).toEqual(feature(everyType, 'mouth'));
    expect(model.yarn).toBe(everyType.yarn);
  });

  it('keeps the shape: a valid model stays valid, one tree, with every overlap scaled', () => {
    const { model } = scaleModel(everyType, 1.3);
    expect(validateModel(model).ok).toBe(true);
    expect(isOneTree(model)).toBe(true);
    const g = attachGraph(model.parts);
    model.parts.forEach((p, i) => {
      const parent = g.parent[i];
      if (parent !== null) expect(overlapAlongRay(model.parts[parent], p), p.id).toBeCloseTo(0.13, 4);
    });
    expect(validateModel(scaleModel(readSpecExample(), 0.75).model).ok).toBe(true);
  });

  it('the ground center is (0, lowest y, 0): the lowest point and the mirror plane x = 0 stay where they are', () => {
    // an ungrounded, off-center model
    const m = modelOf([
      part('sphere', { r: 1 }, { id: 'body', position: [4, 3, -2] }),
      part('sphere', { r: 0.5 }, { id: 'ear_l', position: [5, 4.2, -2] }),
      part('sphere', { r: 0.5 }, { id: 'ear_r', position: [-5, 4.2, -2], mirrorOf: 'ear_l' }),
    ]);
    expect(groundCenter(m)).toEqual([0, 2, 0]);
    const { model } = scaleModel(m, 2);
    expect(modelBounds(model).min[1]).toBe(2); // the lowest point did not move
    expect(model.parts[0].position).toEqual([8, 4, -4]);
    expect(model.parts[1].position).toEqual([10, 6.4, -4]);
    expect(model.parts[2].position).toEqual([-10, 6.4, -4]); // still the mirror image across x = 0
    expect(modelHeight(model)).toBe(2 * modelHeight(m));
  });

  it('mirror twins stay exact mirrors, and the results are rounded to 1e-6', () => {
    const { model } = scaleModel(teddy, 1.2345678);
    const by = Object.fromEntries(model.parts.map((p) => [p.id, p]));
    for (const p of model.parts) {
      for (const v of [...p.position, ...numbers(p.dims)]) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
      if (!p.mirrorOf) continue;
      const twin = by[p.mirrorOf];
      expect(p.position).toEqual([-twin.position[0], twin.position[1], twin.position[2]]);
      expect(p.dims).toEqual(twin.dims);
    }
    expect(JSON.stringify(model)).not.toContain('-0,');
  });

  it('scales the mesh buffers when they are passed — as new arrays, part-local, about the local origin', () => {
    const meshes = readEveryTypeMeshes();
    const key = Object.keys(meshes)[0];
    const snapshot = Array.from(meshes[key].positions);
    const result = scaleModel(everyType, 2, meshes);
    expect(result.meshes).toBeDefined();
    const scaled = (result.meshes as typeof meshes)[key];
    expect(Object.keys(result.meshes as typeof meshes)).toEqual([key]);
    expect(scaled.positions).not.toBe(meshes[key].positions);
    expect(scaled.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(scaled.positions)).toEqual(snapshot.map((v) => Math.fround(v * 2)));
    expect(Array.from(meshes[key].positions)).toEqual(snapshot); // the input is not modified
    expect(scaled.indices).toBe(meshes[key].indices);
    expect(scaled.labels).toBe(meshes[key].labels);
    // the mesh still fits its part
    const blob = result.model.parts.find((p) => p.type === 'mesh') as Extract<Part, { type: 'mesh' }>;
    const size = boundsSize(worldBounds({ ...blob, rotationDeg: undefined }, scaled));
    for (let k = 0; k < 3; k++) expect(size[k]).toBeCloseTo(blob.dims.bboxIn[k], 5);
    // without meshes: none are returned
    expect(scaleModel(everyType, 2)).not.toHaveProperty('meshes');
    expect(scaleModel(everyType, 2, {}).meshes).toEqual({});
    // the height is measured on the mesh vertices when they are passed
    expect(modelHeight(result.model, result.meshes)).toBeCloseTo(2 * modelHeight(everyType, meshes), 5);
  });

  it('a factor of 1 returns the model itself; a bad factor throws', () => {
    expect(scaleModel(teddy, 1).model).toBe(teddy);
    const meshes = readEveryTypeMeshes();
    expect(scaleModel(everyType, 1, meshes)).toEqual({ model: everyType, meshes });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => scaleModel(teddy, bad)).toThrow(RangeError);
    expect(() => scaleModel(teddy, '2' as unknown as number)).toThrow('factor must be a finite number above 0');
  });

  it('does not modify its input; scaling there and back returns to the start (within the rounding)', () => {
    const snapshot = JSON.stringify(teddy);
    const there = scaleModel(teddy, 1.37).model;
    expect(JSON.stringify(teddy)).toBe(snapshot);
    const back = scaleModel(there, 1 / 1.37).model;
    back.parts.forEach((p, i) => {
      for (let k = 0; k < 3; k++) expect(p.position[k]).toBeCloseTo(teddy.parts[i].position[k], 5);
      numbers(p.dims).forEach((v, j) => expect(v).toBeCloseTo(numbers(teddy.parts[i].dims)[j], 5));
    });
    expect(modelHeight(back)).toBeCloseTo(modelHeight(teddy), 5);
  });
});

describe('scalePartDims and scaleMesh', () => {
  it('scalePartDims scales about the local origin: the position is untouched (a lathe grows from its base)', () => {
    const lathe = part('lathe', { profile: [[0, 0], [1, 1], [0, 2]] }, { position: [1, 2, 3] });
    const scaled = scalePartDims(lathe, 3);
    expect(scaled.position).toEqual([1, 2, 3]);
    expect(scaled.dims.profile).toEqual([[0, 0], [3, 3], [0, 6]]);
    expect(lathe.dims.profile).toEqual([[0, 0], [1, 1], [0, 2]]);
    const cases: [Part, unknown][] = [
      [part('sphere', { r: 1 }), { r: 3 }],
      [part('ellipsoid', { rx: 1, ry: 2, rz: 3 }), { rx: 3, ry: 6, rz: 9 }],
      [part('capsule', { r: 1, length: 4 }), { r: 3, length: 12 }],
      [part('cylinder', { rTop: 1, rBottom: 2, h: 3, open: 'both' }), { rTop: 3, rBottom: 6, h: 9, open: 'both' }],
      [part('cone', { r: 1, h: 2 }), { r: 3, h: 6 }],
      [part('torus', { R: 2, r: 0.5, arcDeg: 90 }), { R: 6, r: 1.5, arcDeg: 90 }],
      [part('box', { w: 1, h: 2, d: 3 }), { w: 3, h: 6, d: 9 }],
      [part('flat', { shape: 'rect', w: 1, h: 2, thickness: 0.1 }), { shape: 'rect', w: 3, h: 6, thickness: 0.3 }],
      [part('mesh', { meshRef: 'm', bboxIn: [1, 2, 3] }), { meshRef: 'm', bboxIn: [3, 6, 9] }],
    ];
    for (const [p, expected] of cases) expect(scalePartDims(p, 3).dims).toEqual(expected);
  });

  it('scaleMesh multiplies the vertices and shares the rest', () => {
    const mesh = { positions: new Float32Array([1, 2, 3, -1, 0, 0.5]), indices: new Uint32Array([0, 1, 0]), labels: new Uint8Array([1, 255]) };
    const scaled = scaleMesh(mesh, 2);
    expect(Array.from(scaled.positions)).toEqual([2, 4, 6, -2, 0, 1]);
    expect(Array.from(mesh.positions)).toEqual([1, 2, 3, -1, 0, 0.5]);
    expect(scaled.indices).toBe(mesh.indices);
    expect(scaled.labels).toBe(mesh.labels);
  });

  it('a rotated part keeps its place on the model when the model is scaled', () => {
    const leg = teddy.parts.find((p) => p.id === 'leg_l') as Part;
    const pad = teddy.parts.find((p) => p.id === 'foot_pad_l') as Part;
    const { model } = scaleModel(teddy, 2);
    const leg2 = model.parts.find((p) => p.id === 'leg_l') as Part;
    const pad2 = model.parts.find((p) => p.id === 'foot_pad_l') as Part;
    const offset = (a: Part, b: Part): Vec3 => [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
    const before = offset(leg, pad);
    const after = offset(leg2, pad2);
    for (let k = 0; k < 3; k++) expect(after[k]).toBeCloseTo(before[k] * 2, 5);
  });
});
