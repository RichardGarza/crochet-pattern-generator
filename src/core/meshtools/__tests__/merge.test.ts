import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { countComponents, eulerCharacteristic, isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { decodeSdfVolume } from '../../kernel/geom/sdfVolume';
import { overlapVolume, partVolume } from '../../model/sdf';
import { convertPrimitive, recenterMesh } from '../convert';
import { mergeParts, MERGE_MAX_GAP_IN } from '../merge';
import { MeshToolError, volumeToSdf } from '../volume';
import { bestOf, HEAVY } from './helpers';
import { bestOfAsync, budget, PERF } from '../../../test/timing';
import type { CrochetModelV1, Part } from '../../../types/model';

const teddy = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const palette = teddy.palette.map((c) => c.id);
const byId = (id: string): Part => {
  const p = teddy.parts.find((q) => q.id === id);
  if (!p) throw new Error(id);
  return p;
};
const body = byId('body');
const head = byId('head');
const moved = (p: Part, dy: number): Part => ({ ...p, position: [p.position[0], p.position[1] + dy, p.position[2]] });

describe('merge — G24 kernel half (§2.9.8, §2.13)', HEAVY, () => {
  it('teddy head + body: one watertight genus-0 mesh within 2% of the analytic union volume, labels from both parts', async () => {
    // Paint the head cream so the two parts' labels differ (the fixture has both in caramel).
    const creamHead: Part = { ...head, color: 'cream_yarn' };
    const r = await mergeParts([{ part: body }, { part: creamHead }], { paletteIds: palette });
    const union = partVolume(body) + partVolume(head) - overlapVolume(body, head); // 43.455 + 47.551 − 0.065
    expect(union).toBeCloseTo(90.94, 1);
    expect(isWatertight(r.mesh.indices)).toBe(true);
    expect(eulerCharacteristic(r.mesh.indices)).toBe(2);
    expect(countComponents(r.mesh.indices)).toBe(1);
    expect(r.genus).toBe(0);
    const report = await manifoldReport(r.mesh);
    expect(report).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    expect(Math.abs(r.volumeIn3 / union - 1)).toBeLessThan(0.02);
    expect(Math.abs(r.unionVolumeIn3 / union - 1)).toBeLessThan(0.005);
    expect(r.volumeIn3).toBeCloseTo(signedVolume(r.mesh), 9);
    expect(r.bridgeIn).toBe(0);
    // labels from both parts: caramel (0) below the neck, cream (1) above; partId 0 = body, 1 = head
    const caramel = palette.indexOf('caramel_yarn');
    const cream = palette.indexOf('cream_yarn');
    let wrong = 0;
    const counts = [0, 0];
    for (let v = 0; v < r.mesh.labels.length; v++) {
      const y = r.mesh.positions[3 * v + 1];
      const pid = r.mesh.partId?.[v] ?? -1;
      counts[pid]++;
      if (y < 4.6 && (r.mesh.labels[v] !== caramel || pid !== 0)) wrong++;
      if (y > 6 && (r.mesh.labels[v] !== cream || pid !== 1)) wrong++;
    }
    expect(wrong).toBe(0);
    expect(counts[0]).toBeGreaterThan(1000);
    expect(counts[1]).toBeGreaterThan(1000);
    // the stored field meshes to the same solid
    expect(r.sdf.data.length).toBe(r.sdf.dims[0] * r.sdf.dims[1] * r.sdf.dims[2]);
    expect(Math.max(...r.sdf.dims)).toBe(96);
  });

  it('the unchanged teddy (both caramel) keeps one label and still reports both source parts', async () => {
    const r = await mergeParts([{ part: body }, { part: head }], { paletteIds: palette });
    expect(new Set(r.mesh.labels)).toEqual(new Set([palette.indexOf('caramel_yarn')]));
    expect(new Set(r.mesh.partId)).toEqual(new Set([0, 1]));
  });

  it('refuses parts with a gap > 0.1 in ("these parts do not touch")', async () => {
    // body top 5.2789, head bottom 5.1289 + dy: a gap of ≈ 0.15 in at dy = 0.3
    await expect(mergeParts([{ part: body }, { part: moved(head, 0.3) }])).rejects.toThrow('these parts do not touch');
    await expect(mergeParts([{ part: body }, { part: moved(head, 3) }])).rejects.toBeInstanceOf(MeshToolError);
  });

  it('merges parts that touch within 0.1 in without overlapping by bridging them', async () => {
    const r = await mergeParts([{ part: body }, { part: moved(head, 0.2) }], { paletteIds: palette }); // gap ≈ 0.05
    expect(r.links[0].gapIn).toBeGreaterThan(0.02);
    expect(r.links[0].gapIn).toBeLessThanOrEqual(MERGE_MAX_GAP_IN);
    expect(r.bridgeIn).toBeGreaterThan(0);
    expect(countComponents(r.mesh.indices)).toBe(1);
    expect(r.genus).toBe(0);
    expect(isWatertight(r.mesh.indices)).toBe(true);
    // the closing only adds the bridge and fills creases a little
    expect(r.volumeIn3 / r.unionVolumeIn3).toBeGreaterThan(0.99);
    expect(r.volumeIn3 / r.unionVolumeIn3).toBeLessThan(1.03);
  });

  it('needs at least two parts', async () => {
    await expect(mergeParts([{ part: body }])).rejects.toThrow('select at least two parts to merge');
    await expect(mergeParts([])).rejects.toBeInstanceOf(MeshToolError);
  });

  it('three parts in a chain (ear on head on body) merge; a floating part among them is refused', async () => {
    const ear = byId('ear_l');
    const r = await mergeParts([{ part: body }, { part: head }, { part: ear }], { paletteIds: palette });
    expect(countComponents(r.mesh.indices)).toBe(1);
    expect(new Set(r.mesh.partId)).toEqual(new Set([0, 1, 2]));
    const floating = { ...byId('tail'), position: [0, 20, 0] as [number, number, number] };
    await expect(mergeParts([{ part: body }, { part: head }, { part: floating }])).rejects.toThrow('these parts do not touch');
  });

  it('takes mesh parts by buffer (voxelized) and by stored volume, and gives the same solid', async () => {
    const conv = convertPrimitive(head, { paletteIds: palette });
    const centered = recenterMesh(conv.mesh);
    expect(Math.hypot(...centered.center)).toBeLessThan(0.05);
    const meshHead: Part = { id: 'head', label: 'Head', type: 'mesh', dims: { meshRef: 'm_head', bboxIn: centered.bboxIn }, position: head.position, rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    const byBuffer = await mergeParts([{ part: body }, { part: meshHead, mesh: conv.mesh }], { paletteIds: palette });
    const bySdf = await mergeParts([{ part: body }, { part: meshHead, sdf: volumeToSdf(conv.volume) }], { paletteIds: palette });
    const union = partVolume(body) + partVolume(head) - overlapVolume(body, head);
    // the converted head is the builder's tessellation (0.5% smaller than the analytic ellipsoid)
    for (const r of [byBuffer, bySdf]) {
      expect(countComponents(r.mesh.indices)).toBe(1);
      expect(r.genus).toBe(0);
      expect(Math.abs(r.volumeIn3 / union - 1)).toBeLessThan(0.02);
    }
    expect(Math.abs(byBuffer.volumeIn3 / bySdf.volumeIn3 - 1)).toBeLessThan(0.005);
    // without a buffer the stored-volume part still gets its partId; its labels are unknown (255)
    expect(new Set(bySdf.mesh.partId)).toEqual(new Set([0, 1]));
    for (let v = 0; v < bySdf.mesh.labels.length; v++) if (bySdf.mesh.partId?.[v] === 1) expect(bySdf.mesh.labels[v]).toBe(255);
    expect(new Set(byBuffer.mesh.labels)).toEqual(new Set([0]));
  });

  it('a mesh part needs a buffer or a stored volume', async () => {
    const meshPart: Part = { id: 'blob', type: 'mesh', dims: { meshRef: 'x', bboxIn: [1, 1, 1] }, position: [0, 3, 0], rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    await expect(mergeParts([{ part: body }, { part: meshPart }])).rejects.toThrow(/needs its mesh buffer/);
  });

  it('is deterministic and runs within the 1 s budget (§5.8)', { ...PERF, retry: 2 }, async () => {
    const a = await mergeParts([{ part: body }, { part: head }], { paletteIds: palette });
    const b = await mergeParts([{ part: body }, { part: head }], { paletteIds: palette });
    expect(Buffer.compare(Buffer.from(a.mesh.positions.buffer), Buffer.from(b.mesh.positions.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(a.mesh.labels.buffer), Buffer.from(b.mesh.labels.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(a.sdf.data.buffer), Buffer.from(b.sdf.data.buffer))).toBe(0);
    const best = await bestOfAsync(3, () => mergeParts([{ part: body }, { part: head }], { paletteIds: palette }));
    expect(best).toBeLessThan(budget(1000));
    expect(bestOf(1, () => decodeSdfVolume(a.sdf))).toBeLessThan(budget(1000));
  });

  it('bridges small parts with a sharp contact (cone tip 0.05–0.099 in above a sphere)', async () => {
    const base = { rotationDeg: [0, 0, 0] as [number, number, number], color: 'caramel_yarn' };
    for (const gap of [0.05, 0.099]) {
      const sphere: Part = { ...base, id: 'ball', type: 'sphere', dims: { r: 0.3 }, position: [0, 0, 0] };
      const cone: Part = { ...base, id: 'spike', type: 'cone', dims: { r: 0.15, h: 0.5 }, position: [0, 0.3 + gap + 0.25, 0], rotationDeg: [180, 0, 0] };
      const r = await mergeParts([{ part: sphere }, { part: cone }]);
      expect(r.links[0].gapIn).toBeCloseTo(gap, 3);
      expect(countComponents(r.mesh.indices)).toBe(1);
      expect(r.genus).toBe(0);
      expect(r.bridgeIn).toBeGreaterThan(0);
    }
  });

  it('refuses an open mesh part instead of merging a broken solid', async () => {
    const conv = convertPrimitive(head, { paletteIds: palette });
    const open = conv.mesh.indices.slice(0, conv.mesh.indices.length - 300);
    const meshHead: Part = { id: 'head', type: 'mesh', dims: { meshRef: 'm', bboxIn: conv.bboxIn }, position: head.position, rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    await expect(mergeParts([{ part: body }, { part: meshHead, mesh: { ...conv.mesh, indices: open } }])).rejects.toThrow(/not closed/);
  });
});
