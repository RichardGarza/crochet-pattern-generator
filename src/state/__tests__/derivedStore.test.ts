import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../core/stub';
import type { ChartResult } from '../../types/chart';
import type { PatternDoc } from '../../types/pattern';
import type { ProjectDoc } from '../../types/project';
import { Superseded } from '../../workers/rpc';
import { createDerivedStore, DERIVED_KINDS, derivedStore, IDLE_JOB, isFresh, jobOf } from '../derivedStore';
import { projectStore } from '../projectStore';

// The store never looks inside a result; these stand in for the real ones.
const chart = (tag: string): ChartResult => ({ hash: tag }) as unknown as ChartResult;
const pattern = (tag: string): PatternDoc => ({ title: tag }) as unknown as PatternDoc;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('derivedStore', () => {
  it('starts empty, with every job idle', () => {
    const s = createDerivedStore().getState();
    for (const kind of DERIVED_KINDS) {
      expect(s[kind]).toBeNull();
      expect(jobOf(s, kind)).toBe(IDLE_JOB);
    }
    expect(DERIVED_KINDS).toEqual(['chart', 'pattern2d', 'recon', 'ami']);
    expect(jobOf(s, 'depth')).toEqual({ status: 'idle', inputHash: null, progress: null, error: null });
  });

  it('stores a result with the hash of its inputs', () => {
    const store = createDerivedStore();
    expect(store.getState().setResult('chart', 'h1', chart('one'))).toBe(true);
    const s = store.getState();
    expect(s.chart).toEqual({ inputHash: 'h1', value: chart('one') });
    expect(jobOf(s, 'chart')).toEqual({ status: 'done', inputHash: 'h1', progress: null, error: null });
    expect(isFresh(s, 'chart', 'h1')).toBe(true);
    expect(isFresh(s, 'chart', 'h2')).toBe(false); // the settings changed: what is shown is stale
    expect(isFresh(s, 'ami', 'h1')).toBe(false);
    expect(s.setResult('chart', 'h2', chart('two'))).toBe(true); // without a job, the newest write wins
    expect(store.getState().chart?.inputHash).toBe('h2');
  });

  it('tracks a job: running, progress, done', () => {
    const store = createDerivedStore();
    const s = store.getState();
    s.beginJob('recon', 'r1');
    expect(jobOf(store.getState(), 'recon')).toEqual({ status: 'running', inputHash: 'r1', progress: null, error: null });
    s.setJobProgress('recon', 'r1', 0.4);
    expect(jobOf(store.getState(), 'recon').progress).toBe(0.4);
    s.setJobProgress('recon', 'r1', 7);
    expect(jobOf(store.getState(), 'recon').progress).toBe(1);
    s.setJobProgress('recon', 'other', 0.1); // not the running job
    expect(jobOf(store.getState(), 'recon').progress).toBe(1);
    expect(s.finishJob('recon', 'other')).toBe(false);
    expect(s.finishJob('recon', 'r1')).toBe(true);
    expect(jobOf(store.getState(), 'recon')).toEqual({ status: 'done', inputHash: 'r1', progress: null, error: null });
    expect(store.getState().recon).toBeNull(); // finishJob stores no result
  });

  it('tracks jobs that have no result here, by any name', () => {
    const store = createDerivedStore();
    store.getState().beginJob('depth', 'photo-1');
    store.getState().setJobProgress('depth', 'photo-1', 0.5);
    expect(jobOf(store.getState(), 'depth')).toMatchObject({ status: 'running', progress: 0.5 });
    expect(store.getState().failJob('depth', 'photo-1', new Error('no WebGPU'))).toBe(true);
    expect(jobOf(store.getState(), 'depth')).toEqual({ status: 'error', inputHash: 'photo-1', progress: null, error: { name: 'Error', message: 'no WebGPU' } });
    store.getState().clear('depth');
    expect(jobOf(store.getState(), 'depth')).toBe(IDLE_JOB);
  });

  it('accepts only the result of the job that was started last', () => {
    const store = createDerivedStore();
    const s = store.getState();
    s.beginJob('chart', 'old');
    s.beginJob('chart', 'new');
    expect(s.setResult('chart', 'old', chart('old'))).toBe(false); // the slow, older job finishes late
    expect(store.getState().chart).toBeNull();
    expect(s.failJob('chart', 'old', new Error('late failure'))).toBe(false);
    expect(jobOf(store.getState(), 'chart').status).toBe('running');
    expect(s.setResult('chart', 'new', chart('new'))).toBe(true);
    expect(store.getState().chart?.value).toEqual(chart('new'));
  });

  it('does not treat Superseded as a failure, and keeps the last good result on a real failure', () => {
    const store = createDerivedStore();
    const s = store.getState();
    s.setResult('chart', 'h1', chart('good'));
    s.beginJob('chart', 'h2');
    expect(s.failJob('chart', 'h2', new Superseded(4))).toBe(false);
    expect(s.failJob('chart', 'h2', Object.assign(new Error('x'), { name: 'Superseded' }))).toBe(false); // from a worker
    expect(jobOf(store.getState(), 'chart').status).toBe('running');
    expect(s.failJob('chart', 'h2', new NotImplementedError('Chart2dApi.run'))).toBe(true);
    const after = store.getState();
    expect(jobOf(after, 'chart')).toEqual({
      status: 'error',
      inputHash: 'h2',
      progress: null,
      error: { name: 'NotImplementedError', message: 'Chart2dApi.run not implemented' },
    });
    expect(after.chart).toEqual({ inputHash: 'h1', value: chart('good') }); // stale, but still there to show
    expect(s.failJob('chart', 'h2', 'text')).toBe(false); // the job already ended
    s.beginJob('chart', 'h3');
    expect(s.failJob('chart', 'h3', 'just text')).toBe(true);
    expect(jobOf(store.getState(), 'chart').error).toEqual({ name: 'Error', message: 'just text' });
  });

  it('clear forgets one kind; reset forgets everything', () => {
    const store = createDerivedStore();
    const s = store.getState();
    s.setResult('chart', 'h', chart('c'));
    s.setResult('pattern2d', 'h', pattern('p'));
    s.beginJob('depth', 'd');
    s.clear('chart');
    expect(store.getState().chart).toBeNull();
    expect(jobOf(store.getState(), 'chart')).toBe(IDLE_JOB);
    expect(store.getState().pattern2d).not.toBeNull();
    s.reset();
    expect(store.getState().pattern2d).toBeNull();
    expect(store.getState().jobs).toEqual({});
  });
});

describe('derivedStore.run', () => {
  it('computes, stores and returns the value; the same inputs are not computed twice', async () => {
    const store = createDerivedStore();
    let computed = 0;
    const compute = async (): Promise<ChartResult> => {
      computed++;
      return chart('c');
    };
    expect(await store.getState().run('chart', 'h1', compute)).toEqual(chart('c'));
    expect(await store.getState().run('chart', 'h1', compute)).toEqual(chart('c'));
    expect(computed).toBe(1);
    expect(jobOf(store.getState(), 'chart').status).toBe('done');
    expect(await store.getState().run('chart', 'h2', compute)).toEqual(chart('c'));
    expect(computed).toBe(2);
    expect(store.getState().chart?.inputHash).toBe('h2');
  });

  it('joins the job that is already running for the same inputs', async () => {
    const store = createDerivedStore();
    const gate = deferred<ChartResult>();
    let computed = 0;
    const compute = (): Promise<ChartResult> => {
      computed++;
      return gate.promise;
    };
    const first = store.getState().run('chart', 'h1', compute);
    const second = store.getState().run('chart', 'h1', compute);
    expect(second).toBe(first);
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'running', inputHash: 'h1' });
    gate.resolve(chart('once'));
    expect(await first).toEqual(chart('once'));
    expect(computed).toBe(1);
  });

  it('drops the result of a job that a newer run overtook, whatever order they finish in', async () => {
    const store = createDerivedStore();
    const slow = deferred<ChartResult>();
    const fast = deferred<ChartResult>();
    const older = store.getState().run('chart', 'old', () => slow.promise);
    const newer = store.getState().run('chart', 'new', () => fast.promise);
    fast.resolve(chart('new'));
    expect(await newer).toEqual(chart('new'));
    slow.resolve(chart('old')); // arrives last
    expect(await older).toBeUndefined();
    expect(store.getState().chart).toEqual({ inputHash: 'new', value: chart('new') });
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'done', inputHash: 'new' });
  });

  it('going back to inputs whose result is stored makes a job that is still running stale', async () => {
    const store = createDerivedStore();
    await store.getState().run('chart', 'a', async () => chart('a'));
    const slow = deferred<ChartResult>();
    const running = store.getState().run('chart', 'b', () => slow.promise);
    // the user undoes: the inputs are 'a' again, and that result is still here
    expect(await store.getState().run('chart', 'a', async () => chart('never computed'))).toEqual(chart('a'));
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'done', inputHash: 'a' });
    slow.resolve(chart('b'));
    expect(await running).toBeUndefined();
    expect(store.getState().chart).toEqual({ inputHash: 'a', value: chart('a') });
    // the same when the stale job fails instead
    const failing = deferred<ChartResult>();
    const second = store.getState().run('chart', 'c', () => failing.promise);
    await store.getState().run('chart', 'a', async () => chart('never computed'));
    failing.reject(new Error('late'));
    expect(await second).toBeUndefined();
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'done', inputHash: 'a', error: null });
  });

  it('A → B → A while the first A still runs: the newest run resolves with the value stored for A', async () => {
    const store = createDerivedStore();
    const firstA = deferred<ChartResult>();
    const b = deferred<ChartResult>();
    const againA = deferred<ChartResult>();
    const first = store.getState().run('chart', 'A', () => firstA.promise);
    const middle = store.getState().run('chart', 'B', () => b.promise);
    const latest = store.getState().run('chart', 'A', () => againA.promise); // the user went back to A
    firstA.resolve(chart('A'));
    expect(await first).toEqual(chart('A')); // it is the latest job for A, so it is stored
    againA.resolve(chart('A again'));
    b.resolve(chart('B'));
    expect(await latest).toEqual(chart('A')); // not undefined: nothing newer was asked for
    expect(await middle).toBeUndefined();
    expect(store.getState().chart).toEqual({ inputHash: 'A', value: chart('A') });
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'done', inputHash: 'A' });

    // the same when the newest A fails after the older A stored its value
    const store2 = createDerivedStore();
    const a1 = deferred<ChartResult>();
    const a2 = deferred<ChartResult>();
    const older = store2.getState().run('chart', 'A', () => a1.promise);
    void store2.getState().run('chart', 'B', () => new Promise<ChartResult>(() => {}));
    const newest = store2.getState().run('chart', 'A', () => a2.promise);
    a1.resolve(chart('A'));
    expect(await older).toEqual(chart('A'));
    a2.reject(new Error('late'));
    expect(await newest).toEqual(chart('A'));
    expect(jobOf(store2.getState(), 'chart')).toMatchObject({ status: 'done', inputHash: 'A', error: null });
  });

  it('never rejects: a failure is recorded in the job, and Superseded is not a failure', async () => {
    const store = createDerivedStore();
    await store.getState().run('chart', 'ok', async () => chart('good'));
    expect(
      await store.getState().run('chart', 'bad', async () => {
        throw new RangeError('chart is empty');
      }),
    ).toBeUndefined();
    expect(jobOf(store.getState(), 'chart')).toEqual({ status: 'error', inputHash: 'bad', progress: null, error: { name: 'RangeError', message: 'chart is empty' } });
    expect(store.getState().chart?.inputHash).toBe('ok');

    // a compute that throws before it returns a promise
    expect(
      await store.getState().run('chart', 'sync', () => {
        throw new Error('thrown synchronously');
      }),
    ).toBeUndefined();
    expect(jobOf(store.getState(), 'chart').error?.message).toBe('thrown synchronously');

    // a retry with the same inputs runs again after an error
    expect(await store.getState().run('chart', 'bad', async () => chart('now fine'))).toEqual(chart('now fine'));

    // superseded by a request that did not come through run: neither result nor failure
    expect(
      await store.getState().run('chart', 'sup', async () => {
        throw new Superseded(3);
      }),
    ).toBeUndefined();
    expect(jobOf(store.getState(), 'chart')).toEqual(IDLE_JOB);
    expect(store.getState().chart?.inputHash).toBe('bad');
  });

  it('a reset while a job runs discards its result', async () => {
    const store = createDerivedStore();
    const gate = deferred<ChartResult>();
    const running = store.getState().run('chart', 'h', () => gate.promise);
    store.getState().reset();
    gate.resolve(chart('of the project that was closed'));
    expect(await running).toBeUndefined();
    expect(store.getState().chart).toBeNull();
    expect(store.getState().jobs).toEqual({});
    // and the same inputs can be computed again afterwards
    expect(await store.getState().run('chart', 'h', async () => chart('fresh'))).toEqual(chart('fresh'));
  });

  it('a job from before a reset stores nothing even while a new job for the same inputs runs (found by a mutation check)', async () => {
    const store = createDerivedStore();
    const before = deferred<ChartResult>();
    const after = deferred<ChartResult>();
    const old = store.getState().run('chart', 'h', () => before.promise);
    store.getState().reset(); // another project was opened
    const fresh = store.getState().run('chart', 'h', () => after.promise); // same input hash, new project
    before.resolve(chart('of the project that was closed'));
    expect(await old).toBeUndefined();
    expect(store.getState().chart).toBeNull(); // the old project's result never lands …
    expect(jobOf(store.getState(), 'chart')).toMatchObject({ status: 'running', inputHash: 'h' }); // … nor ends the new job
    after.resolve(chart('of the open project'));
    expect(await fresh).toEqual(chart('of the open project'));
    expect(store.getState().chart).toEqual({ inputHash: 'h', value: chart('of the open project') });
  });

  it('keeps the kinds apart', async () => {
    const store = createDerivedStore();
    const [c, p] = await Promise.all([store.getState().run('chart', 'h', async () => chart('c')), store.getState().run('pattern2d', 'h', async () => pattern('p'))]);
    expect(c).toEqual(chart('c'));
    expect(p).toEqual(pattern('p'));
    expect(store.getState().chart?.value).toEqual(chart('c'));
    expect(store.getState().pattern2d?.value).toEqual(pattern('p'));
  });
});

describe('the app’s derivedStore', () => {
  const project = (id: string): ProjectDoc => ({
    schema: 'crochet-project',
    version: 1,
    id,
    name: id,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    rev: 1,
    mode: '2d',
    units: 'in',
    terms: 'us',
    hand: 'right',
    gauge: { cyc: 4, technique: 'sc_graphgan' },
    sources: [],
    imports: [],
  });

  it('is emptied when a project is opened or closed, and kept through edits and a conflict copy', () => {
    projectStore.getState().open(project('a'), { discardUnsaved: true });
    derivedStore.getState().setResult('chart', 'h', chart('of project a'));
    projectStore.getState().update('Rename', (d) => (d.name = 'renamed'));
    expect(derivedStore.getState().chart).not.toBeNull(); // an edit does not empty it (its hash goes stale instead)

    const ticket = projectStore.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    projectStore.getState().rebind(ticket, { id: 'a-copy', rev: 1 });
    expect(derivedStore.getState().chart).not.toBeNull(); // still the same work, under a new id

    projectStore.getState().open(project('b'));
    expect(derivedStore.getState().chart).toBeNull();
    derivedStore.getState().setResult('chart', 'h', chart('of project b'));
    projectStore.getState().close();
    expect(derivedStore.getState().chart).toBeNull();
    expect(derivedStore.getState().jobs).toEqual({});
  });
});
