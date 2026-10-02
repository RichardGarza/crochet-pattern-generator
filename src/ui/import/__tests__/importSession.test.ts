// Track T7.4a — the pending import per project (importSession.ts): files and text in, re-runs with the units answer
// and a version pick (older runs ignored), the original kept (several files as one zip), Accept as one undo step
// with "Carry anyway", the move to another project (§3.7.7), the expected height and the diff base.
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importInputs } from '../../../core/importer';
import { teddy, teddyProject } from '../../../state/slices/__tests__/teddyProject';
import { createProjectStore } from '../../../state/projectStore';
import { derivedStore } from '../../../state/derivedStore';
import type { ImportContext, ImportInput, ImportResult } from '../../../types/importer';
import type { ProjectDoc } from '../../../types/project';
import {
  acceptPending,
  clearImport,
  diffBaseFor,
  expectedHeightFor,
  importFiles,
  importText,
  keepUnits,
  MAX_INPUT_BYTES,
  moveImport,
  originalOf,
  pendingImport,
  rerunImport,
  resetImportSessions,
  setCarryAnyway,
  setImportRunner,
} from '../importSession';

const FIX = new URL('../../../../fixtures/claude-design/', import.meta.url);
const fixtureFile = (rel: string): File => new File([fs.readFileSync(new URL(rel, FIX))], rel.split('/').pop() ?? rel);

const calls: { inputs: ImportInput[]; ctx?: ImportContext }[] = [];

beforeEach(() => {
  calls.length = 0;
  setImportRunner(async (inputs, ctx) => {
    calls.push({ inputs, ctx });
    return importInputs(inputs, ctx);
  });
});

afterEach(() => {
  setImportRunner(null);
  resetImportSessions();
});

describe('importFiles / importText', () => {
  it('a dropped archive: reading, then the report; the original is the file itself; the job shows in the status bar', async () => {
    const running = importFiles('p1', [fixtureFile('teddy-bear/teddy-bear.project-archive.zip')], { expectedHeightIn: 10 });
    expect(pendingImport('p1')?.phase).toBe('reading');
    await running;
    const p = pendingImport('p1');
    expect(p?.phase).toBe('report');
    expect(p?.result?.ok).toBe(true);
    expect(p?.result?.model?.parts).toHaveLength(17);
    expect(p?.original).toMatchObject({ name: 'teddy-bear.project-archive.zip', mime: 'application/zip' });
    expect(p?.original.bytes.size).toBe(fs.statSync(new URL('teddy-bear/teddy-bear.project-archive.zip', FIX)).size);
    expect(calls[0].ctx).toEqual({ expectedHeightIn: 10 });
    expect(p?.unitsAnswered).toBe(true); // nothing to ask for a spec carrier
    expect(derivedStore.getState().jobs.import?.status).not.toBe('running');
  });

  it('OBJ + MTL: one zip of both as the original; the units question is open', async () => {
    await importFiles('p1', [fixtureFile('teddy-derived/teddy-builder-v1.obj.gz'), fixtureFile('teddy-derived/teddy-builder-v1.mtl')]);
    const p = pendingImport('p1');
    expect(p?.result?.units?.confirm).toBe(true);
    expect(p?.unitsAnswered).toBe(false);
    expect(p?.original.name).toBe('teddy-builder-v1.obj.gz + teddy-builder-v1.mtl');
    const blob = p?.original.bytes;
    if (!blob) throw new Error('no original');
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(['teddy-builder-v1.mtl', 'teddy-builder-v1.obj.gz']);
    keepUnits('p1');
    expect(pendingImport('p1')?.unitsAnswered).toBe(true);
  });

  it('the units answer re-runs the import with ctx.units; a version pick with ctx.pickCandidate', async () => {
    await importFiles('p1', [fixtureFile('teddy-derived/teddy-builder-v1.obj.gz'), fixtureFile('teddy-derived/teddy-builder-v1.mtl')]);
    await rerunImport('p1', { units: 'in' });
    expect(calls.at(-1)?.ctx).toEqual({ units: 'in' });
    expect(pendingImport('p1')?.result?.units).toMatchObject({ chosen: 'in', reason: 'user', confirm: false });
    expect(pendingImport('p1')?.unitsAnswered).toBe(true);
    await rerunImport('p1', { units: undefined });
    expect(calls.at(-1)?.ctx).toEqual({});

    await importFiles('p2', [fixtureFile('teddy-derived/teddy-stale-side-file.zip')]);
    expect(pendingImport('p2')?.result?.model?.revision).toBe(1);
    await rerunImport('p2', { pickCandidate: 'crochet-model.json' });
    expect(pendingImport('p2')?.result?.model?.revision).toBe(0);
  });

  it('an older run that answers late is ignored', async () => {
    let release: (r: ImportResult) => void = () => {};
    setImportRunner((inputs, ctx) => {
      calls.push({ inputs, ctx });
      if (calls.length === 1) return new Promise((res) => (release = res));
      return importInputs(inputs, ctx);
    });
    const slow = importText('p1', 'first');
    await importText('p1', JSON.stringify(teddy()));
    expect(pendingImport('p1')?.phase).toBe('report');
    release({ ok: false, carrier: 'text', dialect: 'none', confidence: 'low', repairs: [], warnings: [], fingerprint: [] });
    await slow;
    expect(pendingImport('p1')?.phase).toBe('report');
    expect(pendingImport('p1')?.result?.ok).toBe(true);
  });

  it('pasted text without a model fails; a worker that throws fails with its message; nothing is stored', async () => {
    await importText('p1', 'hello');
    expect(pendingImport('p1')).toMatchObject({ phase: 'failed', original: { name: 'Pasted text', mime: 'text/plain' } });
    setImportRunner(async () => {
      throw new Error('worker died');
    });
    await importText('p1', 'x');
    expect(pendingImport('p1')).toMatchObject({ phase: 'failed', error: 'worker died' });
    clearImport('p1');
    expect(pendingImport('p1')).toBeUndefined();
  });

  it('a file over 100 MB is refused before it is read', async () => {
    const big = new File([new Uint8Array(8)], 'huge.zip');
    Object.defineProperty(big, 'size', { value: MAX_INPUT_BYTES + 1 });
    await importFiles('p1', [big]);
    expect(pendingImport('p1')).toMatchObject({ phase: 'failed', error: 'too-large:huge.zip' });
    expect(calls).toHaveLength(0);
  });

  it('originalOf: duplicate names in a drop are kept apart', () => {
    const o = originalOf([
      { name: 'a.obj', bytes: new Uint8Array([1]), type: '' },
      { name: 'a.obj', bytes: new Uint8Array([2]), type: '' },
    ]);
    expect(o.mime).toBe('application/zip');
    expect(originalOf([{ name: 'x.glb', bytes: new Uint8Array([1]), type: '' }]).mime).toBe('model/gltf-binary');
    expect(originalOf([{ name: 'x.weird', bytes: new Uint8Array([1]), type: '' }]).mime).toBe('application/octet-stream');
  });
});

describe('Accept', () => {
  it('one undo step in the open project, with "Carry anyway"; then the pending import says accepted', async () => {
    const store = createProjectStore();
    const current = teddy();
    const body = current.parts.find((p) => p.id === 'body');
    if (!body) throw new Error('body');
    body.paint = { kind: 'uv64', data: 'A'.repeat(5464) + '==' };
    store.getState().open(teddyProject({ id: 'p1', model: current }), { discardUnsaved: true });
    const next = teddy();
    const nb = next.parts.find((p) => p.id === 'body');
    if (nb?.type !== 'ellipsoid') throw new Error('body');
    nb.dims = { rx: nb.dims.rx * 1.3, ry: nb.dims.ry, rz: nb.dims.rz };
    await importText('p1', JSON.stringify(next));
    setCarryAnyway('p1', ['body', 'body']);
    expect(pendingImport('p1')?.carryAnyway).toEqual(['body']);
    const outcome = await acceptPending('p1', store);
    expect(outcome.report.paint).toEqual(['body']);
    expect(store.getState().doc?.threeD?.model?.parts.find((p) => p.id === 'body')?.paint).toBeDefined();
    expect(store.getState().doc?.imports).toHaveLength(1);
    expect(store.getState().doc?.imports[0].fileName).toBe('Pasted text');
    expect(pendingImport('p1')?.phase).toBe('accepted');
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().doc?.imports).toHaveLength(0);
  });

  it('refuses another project, a failed import, a read-only project (the report stays)', async () => {
    const store = createProjectStore();
    store.getState().open(teddyProject({ id: 'p1' }), { discardUnsaved: true });
    await importText('p2', JSON.stringify(teddy()));
    await expect(acceptPending('p2', store)).rejects.toThrow(/Open the project/);
    await importText('p1', 'nothing');
    await expect(acceptPending('p1', store)).rejects.toThrow(/nothing to accept/);
    store.getState().setReadOnly(true);
    await importText('p1', JSON.stringify(teddy()));
    await expect(acceptPending('p1', store)).rejects.toThrow();
    expect(pendingImport('p1')?.phase).toBe('report');
  });
});

describe('moveImport (§3.7.7)', () => {
  it('the import moves to the project and runs again with its expected height', async () => {
    await importFiles('fresh', [fixtureFile('teddy-derived/teddy-builder-v1.obj.gz'), fixtureFile('teddy-derived/teddy-builder-v1.mtl')]);
    await moveImport('fresh', 'home', { expectedHeightIn: 10 });
    expect(pendingImport('fresh')).toBeUndefined();
    const p = pendingImport('home');
    expect(p?.phase).toBe('report');
    expect(calls.at(-1)?.ctx).toEqual({ expectedHeightIn: 10 });
    // with the project's height the meters reading needs no question
    expect(p?.result?.units).toMatchObject({ chosen: 'm', reason: 'expected-height', confirm: false });
    await moveImport('nothing-here', 'home');
    expect(pendingImport('home')?.run).toBe(p?.run);
  });
});

describe('expected height and the diff base', () => {
  const base = (): ProjectDoc => teddyProject({ id: 'p1', model: null });
  it('seed height, else the model height, else the target height, else none', () => {
    const d = base();
    expect(expectedHeightFor(d)).toBeUndefined();
    expect(expectedHeightFor(null)).toBeUndefined();
    if (d.threeD) d.threeD.recon = { targetHeightIn: 8 } as NonNullable<NonNullable<ProjectDoc['threeD']>['recon']>;
    expect(expectedHeightFor(d)).toBe(8);
    if (d.threeD) d.threeD.model = teddy();
    expect(expectedHeightFor(d)).toBe(teddy().finishedSize.height);
    d.qa = { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', seed: { ...teddy(), finishedSize: { height: 6 } } };
    expect(expectedHeightFor(d)).toBe(6);
  });

  it('the seed when the result carries this project\'s tag for that seed, else the current model', () => {
    const d = teddyProject({ id: 'p1' });
    expect(diffBaseFor(d, {})?.what).toBe('current');
    d.qa = { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', seed: teddy(), awaiting: { since: '2026-10-01T00:00:00Z', seedRev: 4, via: 'copy' } };
    expect(diffBaseFor(d, { cpgTag: { project: 'p1', seedRev: 4 } })?.what).toBe('seed');
    expect(diffBaseFor(d, { cpgTag: { project: 'p1', seedRev: 3 } })?.what).toBe('current');
    expect(diffBaseFor(d, { cpgTag: { project: 'other', seedRev: 4 } })?.what).toBe('current');
    expect(diffBaseFor(teddyProject({ model: null }), {})).toBeUndefined();
  });
});
