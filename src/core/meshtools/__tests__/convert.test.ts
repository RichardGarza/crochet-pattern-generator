import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { isWatertight, meshBounds, signedVolume } from '../../kernel/geom/meshMeasures';
import { partVolume } from '../../model/sdf';
import { fitPart } from '../../recon/fit';
import { isImplemented, NotImplementedError } from '../../stub';
import { convertPrimitive, fitMeshPart, isClosedSurface, meshFromPart, paletteIndex, primitiveColoredMesh, recenterMesh, weldIndices } from '../convert';
import { MeshToolError } from '../volume';
import { colored, HEAVY, uvSphere } from './helpers';
import type { CrochetModelV1, Part } from '../../../types/model';

const teddy = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const palette = teddy.palette.map((c) => c.id);

const base = { position: [0, 0, 0] as [number, number, number], rotationDeg: [0, 0, 0] as [number, number, number], color: 'caramel_yarn' };

describe('convert primitive → mesh (§2.9.8)', HEAVY, () => {
  it('every teddy part: a watertight genus-0 mesh in the part frame, volume within 2% of the analytic part, its color as labels', async () => {
    for (const part of teddy.parts) {
      const r = convertPrimitive(part, { paletteIds: palette });
      expect(r.source).toBe('voxelized');
      expect(isWatertight(r.mesh.indices)).toBe(true);
      const ratio = signedVolume(r.mesh) / partVolume(part);
      expect(ratio, part.id).toBeGreaterThan(0.98);
      expect(ratio, part.id).toBeLessThan(1.01);
      expect(new Set(r.mesh.labels), part.id).toEqual(new Set([palette.indexOf(part.color)]));
      // part-local: centered on the origin for these types
      const b = meshBounds(r.mesh.positions);
      for (let a = 0; a < 3; a++) expect(Math.abs((b.min[a] + b.max[a]) / 2)).toBeLessThan(0.02 * (b.max[a] - b.min[a]) + 1e-3);
      expect(r.bboxIn[1]).toBeCloseTo(b.max[1] - b.min[1], 9);
    }
    const head = teddy.parts.find((p) => p.id === 'head') as Part;
    const report = await manifoldReport(meshFromPart(head, { paletteIds: palette }));
    expect(report).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
  });

  it('regions become labels (a band around the middle)', () => {
    const part: Part = { ...base, id: 'ball', type: 'sphere', dims: { r: 1 }, regions: [{ kind: 'band', from: 0.4, to: 0.6, color: 'cream_yarn' }] };
    const m = meshFromPart(part, { paletteIds: palette, N: 64 });
    // Labels come from the nearest builder vertex, so a boundary is as sharp as the builder's rings (0.05 in t
    // at the equator of a 32-ring sphere).
    let wrong = 0;
    for (let v = 0; v < m.labels.length; v++) {
      const t = (m.positions[3 * v + 1] + 1) / 2;
      if (t > 0.45 && t < 0.55 && m.labels[v] !== 1) wrong++;
      if ((t < 0.35 || t > 0.65) && m.labels[v] !== 0) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('open builder solids (open cylinder, torus arc) are sampled from the analytic SDF', () => {
    const tube: Part = { ...base, id: 'tube', type: 'cylinder', dims: { rTop: 0.5, rBottom: 0.5, h: 2, open: 'both' } };
    const arc: Part = { ...base, id: 'arc', type: 'torus', dims: { R: 1, r: 0.2, arcDeg: 180 } };
    const ring: Part = { ...base, id: 'ring', type: 'torus', dims: { R: 1, r: 0.25 } };
    const t = convertPrimitive(tube, { N: 64 });
    expect(t.source).toBe('analytic');
    expect(isWatertight(t.mesh.indices)).toBe(true);
    expect(signedVolume(t.mesh) / partVolume(tube)).toBeCloseTo(1, 1);
    expect(convertPrimitive(arc, { N: 64 }).source).toBe('analytic');
    const r = convertPrimitive(ring, { N: 64 });
    expect(r.source).toBe('voxelized');
    expect(signedVolume(r.mesh) / partVolume(ring)).toBeGreaterThan(0.97);
  });

  it('a lathe keeps its frame (origin at the base); recenterMesh gives the bbox-centered form', () => {
    const lathe: Part = { ...base, id: 'vase', type: 'lathe', dims: { profile: [[0, 0], [0.6, 0.2], [0.7, 1], [0.3, 1.8], [0, 2]] } };
    const r = convertPrimitive(lathe, { N: 64 });
    const b = meshBounds(r.mesh.positions);
    expect(b.min[1]).toBeGreaterThan(-0.05);
    expect(b.max[1]).toBeLessThan(2.05);
    const c = recenterMesh(r.mesh);
    expect(c.center[1]).toBeCloseTo((b.min[1] + b.max[1]) / 2, 6);
    const cb = meshBounds(c.mesh.positions);
    expect(cb.min[1] + cb.max[1]).toBeCloseTo(0, 5);
    expect(c.mesh.indices).toBe(r.mesh.indices);
  });

  it('refuses mesh parts, unknown types and parts too thin for the lattice', () => {
    const meshPart: Part = { ...base, id: 'm', type: 'mesh', dims: { meshRef: 'm', bboxIn: [1, 1, 1] } };
    expect(() => convertPrimitive(meshPart)).toThrow(MeshToolError);
    expect(() => convertPrimitive({ ...base, id: 'x', type: 'blob' } as unknown as Part)).toThrow(MeshToolError);
    const sheet: Part = { ...base, id: 's', type: 'box', dims: { w: 10, h: 10, d: 0.001 } };
    expect(() => convertPrimitive(sheet, { N: 16 })).toThrow(/too thin/);
    expect(() => convertPrimitive({ ...base, id: 'b', type: 'sphere', dims: { r: 1 } }, { N: 4 })).toThrow(RangeError);
  });

  it('helpers: palette indices, welding, closed-surface test', () => {
    expect(paletteIndex(palette, 'cream_yarn')).toBe(1);
    expect(paletteIndex(palette, 'nope')).toBe(255);
    expect(paletteIndex(undefined, 'cream_yarn')).toBe(255);
    const sphere: Part = { ...base, id: 'b', type: 'sphere', dims: { r: 1 } };
    const m = primitiveColoredMesh(sphere);
    expect(m.labels.every((l) => l === 255)).toBe(true);
    expect(isClosedSurface(m.positions, m.indices)).toBe(true);
    const w = weldIndices(m.positions, m.indices);
    expect(new Set(w).size).toBeLessThan(m.positions.length / 3);
    const s = uvSphere(1, 8, 4);
    expect(isClosedSurface(s.positions, s.indices.slice(3))).toBe(false);
  });
});

describe('fit primitive (T3 fitPart)', () => {
  it.runIf(isImplemented(fitPart))('fits a sphere mesh as a sphere', () => {
    const r = fitMeshPart(colored(uvSphere(1, 48, 24)));
    expect(r.type).toBe('sphere');
    expect(r.residual).toBeLessThan(0.05);
  });

  it.runIf(!isImplemented(fitPart))('passes the Step 0 stub through until T3 lands', () => {
    expect(() => fitMeshPart(colored(uvSphere(1, 16, 8)))).toThrow(NotImplementedError);
  });

  it('refuses an empty mesh', () => {
    expect(() => fitMeshPart({ positions: new Float32Array(0), indices: new Uint32Array(0), labels: new Uint8Array(0) })).toThrow(MeshToolError);
  });
});
