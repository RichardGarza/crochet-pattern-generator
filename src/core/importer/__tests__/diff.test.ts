// §3.7.7 after import: the diff (added/removed, dims > 2%, moved > 0.1 in, colors), the paint carry rule (type
// unchanged and every dim within 10%, else "photo colors not carried" with "Carry anyway"), and the accept plan
// (carry by the import itself; features Claude Design removed from the seed stay removed; mesh labels re-pointed).
import { describe, expect, it } from 'vitest';
import type { ColoredMesh } from '../../../types/geometry';
import type { CrochetModelV1, Feature, Part } from '../../../types/model';
import { encodeUv64 } from '../../model/builder';
import { keptMeshRefs, labelRemap, planImportAccept, remapMeshLabels, yarnPrefill } from '../accept';
import { diffModels } from '../diff';
import { CANONICAL_TEDDY } from './helpers/fixtures';

const teddy = (): CrochetModelV1 => JSON.parse(CANONICAL_TEDDY) as CrochetModelV1;
const part = (m: CrochetModelV1, id: string): Part => m.parts.find((p) => p.id === id) as Part;
const paint = { kind: 'uv64' as const, data: encodeUv64(new Uint8Array(64 * 64).fill(1)) };
const withParts = (m: CrochetModelV1, f: (p: Part) => Part): CrochetModelV1 => ({ ...m, parts: m.parts.map(f) });

describe('diffModels (§3.7.7)', () => {
  it('the same model: nothing to list', () => {
    const d = diffModels(teddy(), teddy());
    expect(d.same).toBe(true);
    expect(d.summary).toEqual([]);
  });

  it('first import (no previous model): every part is added', () => {
    const d = diffModels(undefined, teddy());
    expect(d.added).toHaveLength(17);
    expect(d.summary[0]).toBe('parts added: body, head, muzzle, nose, eye_l, eye_r and 11 more');
  });

  it('added / removed; dims over 2% (not 1%); moves over 0.1 in (not 0.05); turns; colors by hex', () => {
    const prev = teddy();
    let next = withParts(prev, (p) => {
      if (p.id === 'ear_l' && p.type === 'ellipsoid') return { ...p, dims: { ...p.dims, rx: p.dims.rx * 1.2 } };
      if (p.id === 'ear_r' && p.type === 'ellipsoid') return { ...p, dims: { ...p.dims, rx: p.dims.rx * 1.01 } };
      if (p.id === 'tail') return { ...p, position: [p.position[0], p.position[1] + 0.2, p.position[2]] };
      if (p.id === 'nose') return { ...p, position: [p.position[0], p.position[1] + 0.05, p.position[2]] };
      if (p.id === 'arm_l') return { ...p, rotationDeg: [-28, 0, 30] };
      if (p.id === 'muzzle') return { ...p, color: 'caramel_yarn' };
      return p;
    });
    next = { ...next, parts: [...next.parts.filter((p) => p.id !== 'foot_pad_r'), { id: 'bow', type: 'torus', dims: { R: 0.5, r: 0.1 }, position: [0, 6, 1], color: 'cream_yarn' } as Part] };
    // a palette id renamed with the same hex is not a color change
    next = { ...next, palette: next.palette.map((c) => (c.id === 'dark_brown_yarn' ? { ...c, id: 'brown' } : c)), parts: next.parts.map((p) => (p.color === 'dark_brown_yarn' ? { ...p, color: 'brown' } : p)) };
    const d = diffModels(prev, next);
    expect(d.added).toEqual(['bow']);
    expect(d.removed).toEqual(['foot_pad_r']);
    expect(d.changed.map((c) => c.part).sort()).toEqual(['arm_l', 'ear_l', 'muzzle', 'tail']);
    expect(d.changed.find((c) => c.part === 'ear_l')?.dims).toEqual([{ key: 'rx', from: 0.85, to: 1.02 }]);
    expect(d.changed.find((c) => c.part === 'tail')?.movedIn).toBeCloseTo(0.2, 6);
    expect(d.changed.find((c) => c.part === 'arm_l')?.turnedDeg).toBe(8);
    expect(d.changed.find((c) => c.part === 'muzzle')?.color).toEqual({ from: '#F2E3C6', to: '#B07A4A' });
    expect(d.summary).toEqual(['parts added: bow', 'parts removed: foot_pad_r', 'shape changed: ear_l', 'moved: arm_l, tail', 'colors changed: muzzle']);
  });

  it('paint carry rule: same type and every dim within 10% carries; otherwise "photo colors not carried"', () => {
    const prev = withParts(teddy(), (p) => (['body', 'head', 'tail', 'arm_l'].includes(p.id) ? { ...p, paint } : p));
    const next = withParts(teddy(), (p) => {
      if (p.id === 'body' && p.type === 'ellipsoid') return { ...p, dims: { ...p.dims, ry: p.dims.ry * 1.09 } }; // within 10%
      if (p.id === 'head' && p.type === 'ellipsoid') return { ...p, dims: { ...p.dims, rx: p.dims.rx * 1.11 } }; // beyond
      if (p.id === 'tail') return { id: 'tail', type: 'ellipsoid', dims: { rx: 0.5, ry: 0.5, rz: 0.5 }, position: p.position, color: p.color } as Part; // other type
      return p;
    });
    const d = diffModels(prev, next);
    expect(d.paintCarried).toEqual(['body', 'arm_l']);
    expect(d.paintNotCarried).toEqual(['head', 'tail']);
    expect(d.summary).toContain('photo colors not carried: head, tail');
    expect(d.changed.find((c) => c.part === 'tail')?.type).toEqual({ from: 'sphere', to: 'ellipsoid' });
  });

  it('features: removed by Claude (in the seed) vs added in the editor (kept by Accept), and new ones', () => {
    const f = (id: string): Feature => ({ id, kind: 'mouth', on: 'muzzle', azimuthDeg: 0, elevationDeg: -10 });
    const d = diffModels({ ...teddy(), features: [f('mouth'), f('smile'), f('freckle')] }, { ...teddy(), features: [f('mouth'), f('brow')] }, { seedFeatureIds: ['mouth', 'smile'] });
    expect(d.features).toEqual({ removed: ['smile'], kept: ['freckle'], added: ['brow'] });
    expect(d.summary).toEqual(['face details removed: smile', 'face details you added are kept: freckle', 'face details added: brow']);
  });
});

describe('planImportAccept (§3.7.7, integration S1 task T7.5)', () => {
  const f = (id: string, on = 'head'): Feature => ({ id, kind: 'cheek', on, azimuthDeg: 30, elevationDeg: -10, color: 'cream_yarn' });

  it('carries crochet hints and paint; features the editor added come back, the ones Claude removed from the seed do not', () => {
    const prev: CrochetModelV1 = {
      ...withParts(teddy(), (p) => (p.id === 'body' ? { ...p, paint, crochet: { start: 'top' } } : p)),
      features: [f('blush_l'), f('editor_freckle'), f('mouth', 'muzzle')],
    };
    // Claude removed blush_l (it was in the seed) and kept mouth itself
    const next: CrochetModelV1 = { ...teddy(), features: [{ ...f('mouth', 'muzzle'), azimuthDeg: 5 }] };
    const plan = planImportAccept(prev, next, { seedFeatureIds: ['blush_l', 'mouth'] });
    expect(plan.droppedFeatures).toEqual(['blush_l']);
    expect(plan.model.features?.map((x) => [x.id, x.azimuthDeg])).toEqual([
      ['mouth', 5],
      ['editor_freckle', 30],
    ]);
    expect(plan.report).toEqual({ crochet: ['body'], paint: ['body'], paintDropped: [], features: ['editor_freckle'] });
    expect(part(plan.model, 'body').crochet).toEqual({ start: 'top' });
  });

  it('"Carry anyway" carries paint across a changed shape', () => {
    const prev = withParts(teddy(), (p) => (p.id === 'head' ? { ...p, paint } : p));
    const next = withParts(teddy(), (p) => (p.id === 'head' && p.type === 'ellipsoid' ? { ...p, dims: { ...p.dims, rx: 3 } } : p));
    expect(planImportAccept(prev, next).report.paintDropped).toEqual(['head']);
    const anyway = planImportAccept(prev, next, { carryPaintAnyway: ['head'] });
    expect(anyway.report.paint).toEqual(['head']);
    expect(part(anyway.model, 'head').paint).toEqual(paint);
  });

  it('no previous model: the import as it is', () => {
    const next = teddy();
    expect(planImportAccept(undefined, next)).toEqual({ model: next, report: { crochet: [], paint: [], paintDropped: [], features: [] }, droppedFeatures: [] });
  });

  it('mesh labels of kept mesh parts follow the palette by color identity', () => {
    const prevPalette = [
      { id: 'a', hex: '#111111' },
      { id: 'b', hex: '#ff0000' },
      { id: 'c', hex: '#00ff00' },
    ];
    const nextPalette = [
      { id: 'c', hex: '#00ff00' },
      { id: 'red', hex: '#FF0000' },
      { id: 'black', hex: '#000000' },
    ];
    const table = labelRemap(prevPalette, nextPalette);
    expect([table[0], table[1], table[2], table[255]]).toEqual([2, 1, 0, 255]);
    const mesh: ColoredMesh = { positions: new Float32Array(12), indices: new Uint32Array([0, 1, 2]), labels: new Uint8Array([0, 1, 2, 255]) };
    expect([...remapMeshLabels(mesh, table).labels]).toEqual([2, 1, 0, 255]);
    expect([...mesh.labels]).toEqual([0, 1, 2, 255]);
    const m = (palette: typeof prevPalette, ref: string): CrochetModelV1 => ({
      ...teddy(),
      palette,
      parts: [{ id: 'blob', type: 'mesh', dims: { meshRef: ref, bboxIn: [1, 1, 1] }, position: [0, 0.5, 0], color: palette[0].id } as Part],
    });
    expect(keptMeshRefs(m(prevPalette, 'm1'), m(nextPalette, 'm1'))).toEqual(['m1']);
    expect(keptMeshRefs(m(prevPalette, 'm1'), m(prevPalette, 'm1'))).toEqual([]);
    expect(keptMeshRefs(m(prevPalette, 'm1'), m(nextPalette, 'm1'), { m1: mesh })).toEqual([]);
  });
});

describe('yarnPrefill (integration S1 task T7.6)', () => {
  it('CYC 0 is offered as CYC 1 (no note of its own: the panel shows LACE_NOTE); other weights as they are; no yarn → nothing', () => {
    expect(yarnPrefill({ weightCYC: 0, hookMm: 2 })).toEqual({ weightCYC: 1, hookMm: 2 });
    expect(yarnPrefill({ weightCYC: 4, hookMm: 3.5, stsPerIn: 5.1, fiber: 'cotton' })).toEqual({ weightCYC: 4, hookMm: 3.5, stsPerIn: 5.1, fiber: 'cotton' });
    expect(yarnPrefill(undefined)).toBeUndefined();
    expect(yarnPrefill({})).toBeUndefined();
  });
});
