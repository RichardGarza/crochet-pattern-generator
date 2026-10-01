// workers/client.ts in the node environment: there is no Worker here, so every worker is a fake that speaks
// real comlink over a MessageChannel (src/test/fakes.ts). The same calls against real module workers run in
// the Playwright smoke test (e2e/smoke.spec.ts, Step 0c).
import { wrap } from 'comlink';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isNotImplementedError, stub } from '../../core/stub';
import { createFakeWorker, type FakeWorker } from '../../test/fakes';
import type { AmiRequest, AmiResult } from '../../types/ami';
import type { ChartRequest, ChartResult } from '../../types/chart';
import type { ReconRequest, ReconResult } from '../../types/geometry';
import type { AmiApi, Chart2dApi, GeomApi, ImportApi, MeshApi, MlApi } from '../../types/workers';
import {
  createWorkerClient,
  isSuperseded,
  isWorkerTerminated,
  setWorkerSpawner,
  Superseded,
  transfer,
  WORKER_NAMES,
  workers,
  WorkerTerminated,
  type WorkerClient,
  type WorkerName,
} from '../client';
import { createJobGate, yieldMacrotask } from '../rpc';

/** Records what reached the worker. The arguments are what comlink delivered (structured clones). */
interface Call {
  method: string;
  args: unknown[];
}

function recorder() {
  const calls: Call[] = [];
  const record =
    <R>(method: string, result: (...args: never[]) => R) =>
    async (...args: unknown[]): Promise<R> => {
      calls.push({ method, args });
      return (result as (...a: unknown[]) => R)(...args);
    };
  return { calls, record };
}

/** One fake API per worker; every method records its call and answers something recognizable. */
function fakeApis() {
  const { calls, record } = recorder();
  const jobId = (r: { jobId: number }) => r.jobId;
  const chart2d = {
    supersede: record('chart2d.supersede', () => undefined),
    run: record('chart2d.run', (r: { jobId: number }) => ({ jobId: jobId(r) })),
    buildPattern: record('chart2d.buildPattern', (r: { title: string }) => ({ title: r.title })),
  } as unknown as Chart2dApi;
  const geom = {
    supersede: record('geom.supersede', () => undefined),
    mask: record('geom.mask', () => ({ mask: new Uint8Array([1, 0]), w: 2, h: 1 })),
    build: record('geom.build', (r: { jobId: number }) => ({ jobId: jobId(r) })),
    projectColors: record('geom.projectColors', (r: { jobId: number }) => ({ viewIoU: { job: jobId(r) } })),
  } as unknown as GeomApi;
  const ml = {
    supersede: record('ml.supersede', () => undefined),
    status: record('ml.status', () => ({ webgpu: false, depthCached: true, samCached: false })),
    depth: async (image: unknown, onProgress?: (p: number) => void) => {
      calls.push({ method: 'ml.depth', args: [image, typeof onProgress] });
      if (onProgress) {
        await onProgress(0.25);
        await onProgress(1);
      }
      return { data: new Float32Array([0.5]), w: 1, h: 1 };
    },
    samEncode: record('ml.samEncode', () => undefined),
    samMask: record('ml.samMask', () => ({ mask: new Uint8Array([1]), w: 1, h: 1 })),
  } as unknown as MlApi;
  const mesh = {
    supersede: record('mesh.supersede', () => undefined),
    pathB: record('mesh.pathB', (r: { jobId: number }) => ({ needsSplit: { level: jobId(r), loops: [] } })),
    merge: record('mesh.merge', () => ({ volumeIn3: 1 })),
    voxelize: record('mesh.voxelize', () => ({ volumeId: 'v1' })),
    sculpt: record('mesh.sculpt', () => ({ undoId: 'u1' })),
    undoSculpt: record('mesh.undoSculpt', () => ({ mesh: null })),
    cut: record('mesh.cut', () => [null, null]),
    fit: record('mesh.fit', () => ({ type: 'sphere', residual: 0 })),
    fromPart: record('mesh.fromPart', () => ({ labels: new Uint8Array(0) })),
  } as unknown as MeshApi;
  const ami = {
    supersede: record('ami.supersede', () => undefined),
    generate: record('ami.generate', (r: { jobId: number }) => ({ jobId: jobId(r) })),
  } as unknown as AmiApi;
  const importer = {
    supersede: record('import.supersede', () => undefined),
    importInputs: record('import.importInputs', () => ({ ok: true })),
  } as unknown as ImportApi;
  const apis: Record<WorkerName, object> = { chart2d, geom, ml, mesh, ami, import: importer };
  return { calls, apis };
}

/** A client on fake workers, with a log of what was spawned. */
function fakeClient(apis: Record<WorkerName, object> = fakeApis().apis) {
  const spawned: { name: WorkerName; worker: FakeWorker }[] = [];
  const client = createWorkerClient({
    spawn: (name) => {
      const worker = createFakeWorker(apis[name]);
      spawned.push({ name, worker });
      return worker;
    },
  });
  return { client, spawned };
}

// Requests in these tests carry only what the fake reads; the client's types want the full request.
const req = <T>(fields: object = {}): T => fields as unknown as T;

/** A chart worker whose `run` takes `stages` gate checks. */
function slowChartApi() {
  const gate = createJobGate();
  const log = { started: [] as number[], finished: [] as number[], superseded: [] as number[] };
  const api = {
    supersede: async (jobId: number) => {
      log.superseded.push(jobId);
      gate.supersede(jobId);
    },
    run: async (r: { jobId: number; stages?: number }) => {
      log.started.push(r.jobId);
      for (let i = 0; i < (r.stages ?? 10); i++) await gate.check(r.jobId);
      log.finished.push(r.jobId);
      return { jobId: r.jobId };
    },
    buildPattern: async () => ({}),
  };
  return { api, log };
}

describe('workers/client in node', () => {
  it('imports without constructing a Worker (there is none here), and `workers` starts nothing', () => {
    expect(typeof Worker).toBe('undefined');
    for (const name of WORKER_NAMES) expect(workers.isRunning(name)).toBe(false);
    expect(Object.keys(workers).sort()).toEqual(['ami', 'chart2d', 'geom', 'importer', 'isRunning', 'mesh', 'ml', 'terminate']);
  });

  it('says how to inject fakes when a real worker is asked for without a Worker', async () => {
    setWorkerSpawner(null);
    const error: unknown = await workers.ml.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('no Worker in this environment');
    expect((error as Error).message).toContain('createFakeWorker');
    expect(workers.isRunning('ml')).toBe(false);
  });

  it('spawns each worker lazily, once, on its first call', async () => {
    const { client, spawned } = fakeClient();
    expect(spawned).toEqual([]);
    await client.ml.status();
    expect(spawned.map((s) => s.name)).toEqual(['ml']);
    expect(client.isRunning('ml')).toBe(true);
    expect(client.isRunning('geom')).toBe(false);
    await client.ml.status();
    await client.chart2d.buildPattern(req({ title: 't' }));
    await client.importer.importInputs([]);
    expect(spawned.map((s) => s.name)).toEqual(['ml', 'chart2d', 'import']);
    client.terminate();
  });
});

describe('the client’s types', () => {
  it('job methods take their request without jobId; every other method is the API’s own', () => {
    type C = WorkerClient;
    expectTypeOf<C['chart2d']['run']>().toEqualTypeOf<(r: Omit<ChartRequest, 'jobId'>) => Promise<ChartResult>>();
    expectTypeOf<C['geom']['build']>().toEqualTypeOf<(r: Omit<ReconRequest, 'jobId'>) => Promise<ReconResult>>();
    expectTypeOf<C['ami']['generate']>().toEqualTypeOf<(r: Omit<AmiRequest, 'jobId'>) => Promise<AmiResult>>();
    expectTypeOf<Parameters<C['geom']['projectColors']>[0]>().toEqualTypeOf<Omit<Parameters<GeomApi['projectColors']>[0], 'jobId'>>();
    expectTypeOf<ReturnType<C['geom']['projectColors']>>().toEqualTypeOf<ReturnType<GeomApi['projectColors']>>();
    expectTypeOf<Parameters<C['mesh']['pathB']>[0]>().toEqualTypeOf<Omit<Parameters<MeshApi['pathB']>[0], 'jobId'>>();
    expectTypeOf<ReturnType<C['mesh']['pathB']>>().toEqualTypeOf<ReturnType<MeshApi['pathB']>>();

    expectTypeOf<C['chart2d']['buildPattern']>().toEqualTypeOf<Chart2dApi['buildPattern']>();
    expectTypeOf<C['geom']['mask']>().toEqualTypeOf<GeomApi['mask']>();
    expectTypeOf<C['ml']['status']>().toEqualTypeOf<MlApi['status']>();
    expectTypeOf<C['ml']['depth']>().toEqualTypeOf<MlApi['depth']>();
    expectTypeOf<C['ml']['samEncode']>().toEqualTypeOf<MlApi['samEncode']>();
    expectTypeOf<C['ml']['samMask']>().toEqualTypeOf<MlApi['samMask']>();
    expectTypeOf<C['ml']['cancel']>().toEqualTypeOf<() => void>();
    expectTypeOf<C['mesh']['merge']>().toEqualTypeOf<MeshApi['merge']>();
    expectTypeOf<C['mesh']['voxelize']>().toEqualTypeOf<MeshApi['voxelize']>();
    expectTypeOf<C['mesh']['sculpt']>().toEqualTypeOf<MeshApi['sculpt']>();
    expectTypeOf<C['mesh']['undoSculpt']>().toEqualTypeOf<MeshApi['undoSculpt']>();
    expectTypeOf<C['mesh']['cut']>().toEqualTypeOf<MeshApi['cut']>();
    expectTypeOf<C['mesh']['fit']>().toEqualTypeOf<MeshApi['fit']>();
    expectTypeOf<C['mesh']['fromPart']>().toEqualTypeOf<MeshApi['fromPart']>();
    expectTypeOf<C['importer']['importInputs']>().toEqualTypeOf<ImportApi['importInputs']>();

    // supersede is the channels' business, not the caller's
    expectTypeOf<keyof C['chart2d']>().toEqualTypeOf<'run' | 'buildPattern'>();
    expectTypeOf<keyof C['geom']>().toEqualTypeOf<'mask' | 'build' | 'projectColors'>();
    expectTypeOf<keyof C['ami']>().toEqualTypeOf<'generate'>();
    expectTypeOf<keyof C['importer']>().toEqualTypeOf<'importInputs'>();
    expectTypeOf<keyof C['ml']>().toEqualTypeOf<'status' | 'depth' | 'samEncode' | 'samMask' | 'cancel'>();
  });
});

describe('latest-wins job methods', () => {
  it('assign increasing job ids, so a request never carries one', async () => {
    const { calls, apis } = fakeApis();
    const { client } = fakeClient(apis);
    expect(await client.chart2d.run(req())).toEqual({ jobId: 1 });
    expect(await client.chart2d.run(req())).toEqual({ jobId: 2 });
    expect(await client.ami.generate(req())).toEqual({ jobId: 1 }); // each worker counts its own jobs
    expect(await client.ami.generate(req())).toEqual({ jobId: 2 });
    expect(await client.mesh.pathB(req())).toEqual({ needsSplit: { level: 1, loops: [] } });
    // geom's two job methods share one counter, because they share the worker's gate
    expect(await client.geom.build(req())).toEqual({ jobId: 1 });
    expect(await client.geom.projectColors(req())).toEqual({ viewIoU: { job: 2 } });
    expect(await client.geom.build(req())).toEqual({ jobId: 3 });
    expect(calls.filter((c) => c.method.endsWith('.supersede'))).toEqual([]);
    client.terminate();
  });

  it('five rapid chart requests run two jobs, resolve only the last and send supersede to the worker', async () => {
    const { api, log } = slowChartApi();
    const { client } = fakeClient({ ...fakeApis().apis, chart2d: api });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => client.chart2d.run(req({ stages: 20 }))));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'fulfilled']);
    for (const r of results.slice(0, 4)) {
      const reason: unknown = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(Superseded);
      expect(isSuperseded(reason)).toBe(true);
    }
    expect((results[4] as PromiseFulfilledResult<unknown>).value).toEqual({ jobId: 5 });
    expect(log.started).toEqual([1, 5]);
    expect(log.finished).toEqual([5]);
    expect(log.superseded).toEqual([2, 3, 4, 5]);
    client.terminate();
  });

  it('geom.projectColors waits for a build in flight instead of superseding it', async () => {
    const gate = createJobGate();
    const order: string[] = [];
    const superseded: number[] = [];
    const job = (name: string) => async (r: { jobId: number }) => {
      order.push(`${name} start`);
      for (let i = 0; i < 5; i++) await gate.check(r.jobId);
      order.push(`${name} end`);
      return { jobId: r.jobId };
    };
    const geom = {
      supersede: async (jobId: number) => {
        superseded.push(jobId);
        gate.supersede(jobId);
      },
      mask: async () => ({}),
      build: job('build'),
      projectColors: job('colors'),
    };
    const { client } = fakeClient({ ...fakeApis().apis, geom });
    const [build, colors] = await Promise.allSettled([client.geom.build(req()), client.geom.projectColors(req())]);
    expect(build.status).toBe('fulfilled');
    expect(colors.status).toBe('fulfilled');
    expect(superseded).toEqual([]);
    expect(order).toEqual(['build start', 'build end', 'colors start', 'colors end']);
    client.terminate();
  });
});

describe('direct methods', () => {
  it('pass their arguments through and return the worker’s answer', async () => {
    const { calls, apis } = fakeApis();
    const { client } = fakeClient(apis);
    const image = { w: 1, h: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) };

    expect(await client.chart2d.buildPattern(req({ title: 'Bunny' }))).toEqual({ title: 'Bunny' });
    expect(await client.geom.mask(image, { keepHoles: true })).toEqual({ mask: new Uint8Array([1, 0]), w: 2, h: 1 });
    expect(await client.ml.status()).toEqual({ webgpu: false, depthCached: true, samCached: false });
    await client.ml.samEncode(image);
    expect(await client.ml.samMask([{ x: 1, y: 2, positive: true }])).toEqual({ mask: new Uint8Array([1]), w: 1, h: 1 });
    await client.mesh.merge([], { N: 64 });
    expect(await client.mesh.voxelize(req(), 96, {})).toEqual({ volumeId: 'v1' });
    await client.mesh.sculpt('v1', { tool: 'inflate', points: [[0, 0, 0]], radius: 1, strength: 0.5, mirrorX: false });
    await client.mesh.undoSculpt('u1');
    await client.mesh.cut('v1', { point: [0, 0, 0], normal: [0, 1, 0] });
    await client.mesh.fit(req());
    await client.mesh.fromPart(req({ id: 'body' }));
    expect(await client.importer.importInputs([{ kind: 'text', text: '{}' }], { expectedHeightIn: 8 })).toEqual({ ok: true });

    const byMethod = Object.fromEntries(calls.map((c) => [c.method, c.args]));
    expect(byMethod['geom.mask']).toEqual([image, { keepHoles: true }]);
    expect(byMethod['ml.samMask']).toEqual([[{ x: 1, y: 2, positive: true }]]);
    expect(byMethod['mesh.merge']).toEqual([[], { N: 64 }]);
    expect(byMethod['mesh.voxelize']).toEqual([{}, 96, {}]);
    expect(byMethod['mesh.sculpt']).toEqual(['v1', { tool: 'inflate', points: [[0, 0, 0]], radius: 1, strength: 0.5, mirrorX: false }]);
    expect(byMethod['mesh.undoSculpt']).toEqual(['u1']);
    expect(byMethod['mesh.cut']).toEqual(['v1', { point: [0, 0, 0], normal: [0, 1, 0] }]);
    expect(byMethod['mesh.fromPart']).toEqual([{ id: 'body' }]);
    expect(byMethod['import.importInputs']).toEqual([[{ kind: 'text', text: '{}' }], { expectedHeightIn: 8 }]);
    expect(calls.map((c) => c.method).sort()).toEqual(
      [
        'chart2d.buildPattern',
        'geom.mask',
        'import.importInputs',
        'mesh.cut',
        'mesh.fit',
        'mesh.fromPart',
        'mesh.merge',
        'mesh.sculpt',
        'mesh.undoSculpt',
        'mesh.voxelize',
        'ml.samEncode',
        'ml.samMask',
        'ml.status',
      ].sort(),
    );
    client.terminate();
  });

  it('pass a callback as a comlink proxy: ml.depth reports progress', async () => {
    const { calls, apis } = fakeApis();
    const { client } = fakeClient(apis);
    const image = { w: 1, h: 1, data: new Uint8ClampedArray(4) };
    const progress: number[] = [];
    const depth = await client.ml.depth(image, (p) => {
      progress.push(p);
    });
    expect(progress).toEqual([0.25, 1]);
    expect([...depth.data]).toEqual([0.5]);
    await client.ml.depth(image); // and no callback is no proxy
    expect(calls.filter((c) => c.method === 'ml.depth').map((c) => c.args[1])).toEqual(['function', 'undefined']);
    client.terminate();
  });

  it('clone buffers by default and move them when the caller marks them with transfer()', async () => {
    const { calls, apis } = fakeApis();
    const { client } = fakeClient(apis);
    const kept = { w: 1, h: 1, data: new Uint8ClampedArray([9, 9, 9, 9]) };
    await client.geom.mask(kept);
    expect(kept.data.byteLength).toBe(4); // a store may still hold this one

    const owned = { w: 1, h: 1, data: new Uint8ClampedArray([5, 6, 7, 8]) };
    await client.geom.mask(transfer(owned, [owned.data.buffer]));
    expect(owned.data.byteLength).toBe(0); // request-owned: moved, not copied
    const received = calls.filter((c) => c.method === 'geom.mask').map((c) => (c.args[0] as typeof owned).data);
    expect([...received[0]]).toEqual([9, 9, 9, 9]);
    expect([...received[1]]).toEqual([5, 6, 7, 8]);

    // the same through a latest-wins method, which rebuilds the request to add the job id
    const depth = new Float32Array([1, 2, 3]);
    await client.geom.build(transfer(req<Parameters<typeof client.geom.build>[0]>({ depth: { data: depth, w: 3, h: 1 } }), [depth.buffer]));
    expect(depth.byteLength).toBe(0);
    const build = calls.filter((c) => c.method === 'geom.build').map((c) => c.args[0] as { depth: { data: Float32Array } });
    expect(build).toHaveLength(1);
    expect([...build[0].depth.data]).toEqual([1, 2, 3]);
    client.terminate();
  });
});

describe('errors from a worker', () => {
  it('arrive as errors with their name and message; a Step 0 stub is recognizable', async () => {
    const chart2d = {
      supersede: async () => {},
      run: stub<Chart2dApi['run']>('Chart2dApi.run'),
      buildPattern: async () => {
        throw new RangeError('chart is empty');
      },
    };
    const { client } = fakeClient({ ...fakeApis().apis, chart2d });

    const fromStub: unknown = await client.chart2d.run(req()).catch((e: unknown) => e);
    expect(fromStub).toBeInstanceOf(Error);
    expect(isNotImplementedError(fromStub)).toBe(true);
    expect((fromStub as Error).message).toBe('Chart2dApi.run not implemented');
    expect(isSuperseded(fromStub)).toBe(false);

    const ordinary: unknown = await client.chart2d.buildPattern(req()).catch((e: unknown) => e);
    expect(ordinary).toBeInstanceOf(Error);
    expect((ordinary as Error).name).toBe('RangeError');
    expect((ordinary as Error).message).toBe('chart is empty');
    expect(isNotImplementedError(ordinary)).toBe(false);

    // the channel is free again after an error
    const again: unknown = await client.chart2d.run(req()).catch((e: unknown) => e);
    expect(isNotImplementedError(again)).toBe(true);
    client.terminate();
  });

  it('§5.4 item 3: a callback passed without the client is a DataCloneError; through the client it is proxied', async () => {
    // without the client: a plain function cannot cross the worker boundary
    const bare = createFakeWorker({ depth: async (_i: unknown, cb?: (p: number) => void) => cb?.(1) });
    const remote = wrap<{ depth(i: unknown, cb?: (p: number) => void): Promise<void> }>(bare);
    const error: unknown = await remote.depth({}, () => {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error | null)?.name).toBe('DataCloneError');
    bare.terminate();
    // through the client: the same kind of call works
    const { client } = fakeClient();
    await expect(client.ml.depth({ w: 1, h: 1, data: new Uint8ClampedArray(4) }, () => {})).resolves.toBeDefined();
    client.terminate();
  });
});

describe('terminate and respawn', () => {
  /** An ml worker whose depth() never answers. */
  function hangingMl() {
    const started: number[] = [];
    let n = 0;
    const ml = {
      supersede: async () => {},
      status: async () => ({ webgpu: false, depthCached: false, samCached: false, instance: n }),
      depth: () => {
        started.push(++n);
        return new Promise(() => {});
      },
      samEncode: async () => {},
      samMask: async () => ({}),
    };
    return { ml, started };
  }

  it('ml.cancel() terminates the worker: the call in flight rejects and the next call gets a fresh worker', async () => {
    const { ml, started } = hangingMl();
    const { client, spawned } = fakeClient({ ...fakeApis().apis, ml });
    const depth = client.ml.depth({ w: 1, h: 1, data: new Uint8ClampedArray(4) });
    await yieldMacrotask();
    expect(started).toEqual([1]);
    expect(client.isRunning('ml')).toBe(true);

    client.ml.cancel();
    const error: unknown = await depth.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerTerminated);
    expect(isWorkerTerminated(error)).toBe(true);
    expect((error as WorkerTerminated).worker).toBe('ml');
    expect((error as WorkerTerminated).crashed).toBe(false);
    expect(spawned[0].worker.terminated).toBe(true);
    expect(client.isRunning('ml')).toBe(false);

    await client.ml.status();
    expect(spawned.map((s) => s.name)).toEqual(['ml', 'ml']);
    expect(spawned[1].worker.terminated).toBe(false);
    client.terminate();
    expect(spawned[1].worker.terminated).toBe(true);
  });

  it('cancel with nothing running spawns nothing', () => {
    const { client, spawned } = fakeClient();
    client.ml.cancel();
    client.terminate('geom');
    client.terminate();
    expect(spawned).toEqual([]);
  });

  it('a crashed worker rejects its calls in flight and is replaced on the next call', async () => {
    const { ml } = hangingMl();
    const { client, spawned } = fakeClient({ ...fakeApis().apis, ml });
    const depth = client.ml.depth({ w: 1, h: 1, data: new Uint8ClampedArray(4) });
    const status = client.ml.status();
    await status;
    spawned[0].worker.crash('out of memory');
    const error: unknown = await depth.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerTerminated);
    expect((error as WorkerTerminated).crashed).toBe(true);
    expect((error as WorkerTerminated).message).toContain('out of memory');
    expect(spawned[0].worker.terminated).toBe(true);
    await client.ml.status();
    expect(spawned).toHaveLength(2);
    // an error event of the old instance no longer touches the new one
    spawned[0].worker.crash('late');
    expect(client.isRunning('ml')).toBe(true);
    client.terminate();
  });

  it('terminating under a latest-wins channel: the replaced job is Superseded, the newest runs on the fresh worker', async () => {
    let instance = 0;
    const started: string[] = [];
    const makeChart = () => {
      const id = ++instance;
      return {
        supersede: async () => {},
        run: (r: { jobId: number }) => {
          started.push(`worker ${id} job ${r.jobId}`);
          return id === 1 ? new Promise(() => {}) : Promise.resolve({ jobId: r.jobId });
        },
        buildPattern: async () => ({}),
      };
    };
    const spawned: FakeWorker[] = [];
    const client = createWorkerClient({
      spawn: () => {
        const worker = createFakeWorker(makeChart());
        spawned.push(worker);
        return worker;
      },
    });
    const first = client.chart2d.run(req());
    const second = client.chart2d.run(req());
    await yieldMacrotask();
    client.terminate('chart2d');
    await expect(first).rejects.toBeInstanceOf(Superseded);
    await expect(second).resolves.toEqual({ jobId: 2 });
    expect(started).toEqual(['worker 1 job 1', 'worker 2 job 2']);

    // with nothing pending, the caller sees the termination itself
    const third = client.chart2d.run(req()); // worker 2 answers at once
    await expect(third).resolves.toEqual({ jobId: 3 });
    client.terminate();
  });

  it('a lone job in flight rejects with WorkerTerminated when its worker is terminated', async () => {
    const chart2d = { supersede: async () => {}, run: () => new Promise(() => {}), buildPattern: async () => ({}) };
    const { client } = fakeClient({ ...fakeApis().apis, chart2d });
    const run = client.chart2d.run(req());
    await yieldMacrotask();
    client.terminate('chart2d');
    await expect(run).rejects.toBeInstanceOf(WorkerTerminated);
  });
});

describe('the `workers` singleton', () => {
  it('uses the spawner set by setWorkerSpawner, and goes back to real workers with null', async () => {
    const { apis } = fakeApis();
    const spawned: WorkerName[] = [];
    setWorkerSpawner((name) => {
      spawned.push(name);
      return createFakeWorker(apis[name]);
    });
    expect(await workers.ml.status()).toEqual({ webgpu: false, depthCached: true, samCached: false });
    expect(await workers.ami.generate(req())).toEqual({ jobId: 1 });
    expect(spawned).toEqual(['ml', 'ami']);
    expect(workers.isRunning('ml')).toBe(true);

    setWorkerSpawner(null); // terminates the fakes
    expect(workers.isRunning('ml')).toBe(false);
    expect(workers.isRunning('ami')).toBe(false);
    await expect(workers.ml.status()).rejects.toThrow('no Worker in this environment');
  });
});
