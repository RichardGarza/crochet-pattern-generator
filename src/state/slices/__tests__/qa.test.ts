// Track T7.2 — Accept an import (DESIGN.md §3.7.7; integration S1 task T7.5): one undo step commits the new model as
// an 'import' revision with `carry: 'none'` (the import carried itself), keeps the original file and the mesh
// buffers as assets, records the import and clears `qa.awaiting`.
import { describe, expect, it } from 'vitest';
import { importInputsSync } from '../../../core/importer';
import type { ColoredMesh } from '../../../types/geometry';
import type { ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Feature } from '../../../types/model';
import { MESH_ASSET_MIME, meshAssetCodec } from '../../../core/kernel/assetCodecs';
import { createProjectStore, type ProjectStore } from '../../projectStore';
import { acceptImport, type MeshCodec } from '../qa';
import { teddy, teddyProject } from './teddyProject';

const f = (id: string, on = 'head'): Feature => ({ id, kind: 'cheek', on, azimuthDeg: 30, elevationDeg: -10 });

function opened(o: { model?: CrochetModelV1; seed?: CrochetModelV1 } = {}): ProjectStore {
  const store = createProjectStore({ now: () => new Date('2026-10-01T12:00:00Z') });
  const doc = teddyProject({ model: o.model });
  doc.qa = {
    answers: {},
    decided: {},
    seedSource: 'current-model',
    promptVersion: 'prompt-v1',
    builderVersion: 'builder-v1',
    step: 'import',
    ...(o.seed ? { seed: o.seed } : {}),
    awaiting: { since: '2026-10-01T10:00:00Z', seedRev: 0, via: 'copy' },
  };
  store.getState().open(doc, { discardUnsaved: true });
  return store;
}

const result = (model: CrochetModelV1, more: Partial<ImportResult> = {}): ImportResult => ({
  ok: true,
  model,
  carrier: 'json',
  dialect: 'canonical-1',
  confidence: 'high',
  repairs: [{ code: 'units', message: 'kept' }],
  warnings: [],
  fingerprint: [],
  ...more,
});

const codec: MeshCodec = {
  mime: 'application/x-test-mesh',
  encode: (m) => new Blob([JSON.stringify({ p: [...m.positions], i: [...m.indices], l: [...m.labels] })]),
  decode: async (b) => {
    const o = JSON.parse(await b.text()) as { p: number[]; i: number[]; l: number[] };
    return { positions: Float32Array.from(o.p), indices: Uint32Array.from(o.i), labels: Uint8Array.from(o.l) };
  },
};

describe('acceptImport (§3.7.7)', () => {
  it('one undo step: a new revision, the original file, the import record, qa.awaiting cleared', async () => {
    const store = opened();
    const next = { ...teddy(), name: 'Claude bear', revision: 2 };
    const out = await acceptImport(
      { result: result(next), original: { name: 'bear.json', bytes: new TextEncoder().encode('{"x":1}'), mime: 'application/json' }, newId: () => 'imp-1', now: () => new Date('2026-10-01T13:00:00Z') },
      store,
    );
    const doc = store.getState().doc;
    expect(doc?.threeD?.model?.name).toBe('Claude bear');
    expect(doc?.qa?.awaiting).toBeUndefined();
    expect(doc?.imports).toEqual([out.record]);
    expect(out.record).toMatchObject({ id: 'imp-1', at: '2026-10-01T13:00:00.000Z', fileName: 'bear.json', carrier: 'json', dialect: 'canonical-1', confidence: 'high', revision: out.revision });
    expect(out.record.original.mime).toBe('application/json');
    expect(doc?.threeD?.revisions.at(-1)).toMatchObject({ rev: out.revision, source: 'import', label: 'Imported from Claude Design' });
    expect(await (await store.getState().getAsset(out.record.original)).text()).toBe('{"x":1}');
    // one undo takes all of it back
    expect(store.getState().undo()).toBe(true);
    const back = store.getState().doc;
    expect(back?.threeD?.model?.name).not.toBe('Claude bear');
    expect(back?.imports).toEqual([]);
    expect(back?.qa?.awaiting).toBeDefined();
  });

  it('carries editor features and crochet hints, but not the features Claude Design removed from the seed', async () => {
    const current: CrochetModelV1 = { ...teddy(), features: [f('blush_l'), f('freckle')], parts: teddy().parts.map((p) => (p.id === 'body' ? { ...p, crochet: { start: 'top' } } : p)) };
    const seed: CrochetModelV1 = { ...teddy(), features: [f('blush_l')] };
    const store = opened({ model: current, seed });
    const out = await acceptImport({ result: result(teddy()), original: { name: 'p.txt', bytes: new Uint8Array([1]) } }, store);
    const model = store.getState().doc?.threeD?.model as CrochetModelV1;
    expect(model.features?.map((x) => x.id)).toEqual(['freckle']);
    expect(model.parts.find((p) => p.id === 'body')?.crochet).toEqual({ start: 'top' });
    expect(out.droppedFeatures).toEqual(['blush_l']);
    expect(out.report.features).toEqual(['freckle']);
  });

  it('mesh parts are stored with the shared mesh codec by default (§5.5.6, integration-s2 task T7-2)', async () => {
    const obj = 'o blob\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n';
    const r = importInputsSync([{ kind: 'file', name: 'b.obj', bytes: new TextEncoder().encode(obj).buffer as ArrayBuffer }], { units: 'in' });
    expect(r.ok).toBe(true);
    const store = opened();
    await acceptImport({ result: r, original: { name: 'b.obj', bytes: new Uint8Array([1]) } }, store);
    const first = (r.model as CrochetModelV1).parts[0];
    const ref = first.type === 'mesh' ? first.dims.meshRef : '';
    const asset = store.getState().doc?.threeD?.meshAssets[ref];
    expect(asset?.mime).toBe(MESH_ASSET_MIME);
    const back = await meshAssetCodec.decode(await store.getState().getAsset(asset as NonNullable<typeof asset>));
    expect(back.positions).toEqual((r.meshes as Record<string, ColoredMesh>)[ref].positions);
    expect(back.labels).toEqual((r.meshes as Record<string, ColoredMesh>)[ref].labels);
  });

  it('a caller-supplied mesh codec is used instead (tests)', async () => {
    const obj = 'o blob\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n';
    const r = importInputsSync([{ kind: 'file', name: 'b.obj', bytes: new TextEncoder().encode(obj).buffer as ArrayBuffer }], { units: 'in' });
    const store = opened();
    await acceptImport({ result: r, original: { name: 'b.obj', bytes: new Uint8Array([1]) }, meshCodec: codec }, store);
    const doc = store.getState().doc;
    const first = (r.model as CrochetModelV1).parts[0];
    const ref = first.type === 'mesh' ? first.dims.meshRef : '';
    const asset = doc?.threeD?.meshAssets[ref];
    expect(asset?.mime).toBe('application/x-test-mesh');
    const back = await codec.decode(await store.getState().getAsset(asset as NonNullable<typeof asset>));
    expect(back.positions).toEqual((r.meshes as Record<string, ColoredMesh>)[ref].positions);
  });

  it('a failed result, no project, a read-only project: rejected, nothing changed', async () => {
    const store = opened();
    await expect(acceptImport({ result: { ...result(teddy()), ok: false, model: undefined }, original: { name: 'x', bytes: new Uint8Array() } }, store)).rejects.toThrow(/failed/);
    await expect(acceptImport({ result: result(teddy()), original: { name: 'x', bytes: new Uint8Array() } }, createProjectStore())).rejects.toThrow(/no project/);
    const ro = createProjectStore();
    ro.getState().open(teddyProject(), { readOnly: true });
    await expect(acceptImport({ result: result(teddy()), original: { name: 'x', bytes: new Uint8Array([1]) } }, ro)).rejects.toThrow();
    expect(ro.getState().doc?.imports).toEqual([]);
  });
});
