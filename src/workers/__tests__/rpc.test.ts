// The §5.4 RPC tests that need no Worker: the gate, the macrotask yield and the latest-wins channels, against
// fake workers that speak real comlink over a MessageChannel (src/test/fakes.ts).
import { wrap } from 'comlink';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mulberry32, randomInt } from '../../core/kernel/prng';
import { isNotImplementedError, stub } from '../../core/stub';
import { createFakeWorker } from '../../test/fakes';
import type { CreateJobGateFn, LatestWinsFn, YieldMacrotaskFn } from '../../types/entryPoints';
import type { Cancellable, Chart2dApi } from '../../types/workers';
import {
  collectTransferables,
  createJobGate,
  createLatestWinsGroup,
  exposeApi,
  isSuperseded,
  latestWins,
  Superseded,
  transfer,
  transferAll,
  yieldMacrotask,
  type JobGate,
} from '../rpc';

afterEach(() => {
  vi.useRealTimers();
});

/** A promise with its resolvers. */
function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Job {
  jobId: number;
  /** How many `gate.check` stages the job has; it "works" between them. */
  stages: number;
  tag?: string;
}

interface SlowApi extends Cancellable {
  run(r: Job): Promise<{ jobId: number; tag?: string }>;
}

/** A worker whose `run` takes `stages` macrotasks and checks the gate after each one. */
function slowWorker(log: { started: number[]; finished: number[]; superseded: number[]; stagesDone: Record<number, number> }) {
  const gate = createJobGate();
  const api: SlowApi = {
    supersede: async (jobId) => {
      log.superseded.push(jobId);
      gate.supersede(jobId);
    },
    run: async (r) => {
      log.started.push(r.jobId);
      log.stagesDone[r.jobId] = 0;
      for (let stage = 0; stage < r.stages; stage++) {
        await gate.check(r.jobId);
        log.stagesDone[r.jobId] = stage + 1;
      }
      log.finished.push(r.jobId);
      return { jobId: r.jobId, tag: r.tag };
    },
  };
  return api;
}

const newLog = () => ({ started: [] as number[], finished: [] as number[], superseded: [] as number[], stagesDone: {} as Record<number, number> });

describe('the frozen signatures of §5.2.1', () => {
  it('are exactly what rpc.ts exports', () => {
    expectTypeOf(yieldMacrotask).toEqualTypeOf<YieldMacrotaskFn>();
    expectTypeOf(createJobGate).toEqualTypeOf<CreateJobGateFn>();
    expectTypeOf(latestWins).toEqualTypeOf<LatestWinsFn>();
    expectTypeOf<ConstructorParameters<typeof Superseded>>().toEqualTypeOf<[jobId: number]>();
    expectTypeOf<Superseded['jobId']>().toEqualTypeOf<number>();
    expectTypeOf<JobGate>().toEqualTypeOf<{ supersede(jobId: number): void; check(jobId: number): Promise<void> }>();
  });
});

describe('Superseded', () => {
  it('carries the job id and is recognizable by name after comlink has rebuilt it', () => {
    const error = new Superseded(7);
    expect(error).toBeInstanceOf(Error);
    expect(error.jobId).toBe(7);
    expect(error.name).toBe('Superseded');
    expect(error.message).toContain('7');
    expect(isSuperseded(error)).toBe(true);
    // what arrives from a worker: a plain Error with only name, message and stack
    expect(isSuperseded(Object.assign(new Error(error.message), { name: 'Superseded' }))).toBe(true);
    expect(isSuperseded(new Error('boom'))).toBe(false);
    expect(isSuperseded(null)).toBe(false);
    expect(isSuperseded('Superseded')).toBe(false);
    expect(isSuperseded(undefined)).toBe(false);
  });
});

describe('yieldMacrotask', () => {
  it('resolves in a later macrotask: microtasks queued before it run first', async () => {
    const order: string[] = [];
    const yielded = yieldMacrotask().then(() => order.push('yield'));
    void Promise.resolve()
      .then(() => order.push('micro 1'))
      .then(() => order.push('micro 2'))
      .then(() => order.push('micro 3'));
    await yielded;
    expect(order).toEqual(['micro 1', 'micro 2', 'micro 3', 'yield']);
  });

  it('lets a message that is already queued on another port run first — whichever channel is older', async () => {
    await yieldMacrotask(); // the ping channel now exists and is OLDER than the channel below
    const younger = new MessageChannel();
    let delivered = 0;
    younger.port1.onmessage = () => {
      delivered++;
    };
    for (let i = 1; i <= 50; i++) {
      younger.port2.postMessage(i);
      await yieldMacrotask();
      expect(delivered).toBe(i);
    }
    younger.port1.close();
    younger.port2.close();
  });

  it('resolves concurrent yields in call order', async () => {
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => yieldMacrotask().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('is not held back by fake timers', async () => {
    vi.useFakeTimers();
    await yieldMacrotask();
    await createJobGate().check(1);
  });
});

describe('createJobGate', () => {
  it('lets a job run until a newer job id is known', async () => {
    const gate = createJobGate();
    await gate.check(1);
    await gate.check(0);
    gate.supersede(1);
    await gate.check(1); // the newest job itself is never stopped
    gate.supersede(2);
    await expect(gate.check(1)).rejects.toBeInstanceOf(Superseded);
    await expect(gate.check(1)).rejects.toMatchObject({ jobId: 1, name: 'Superseded' });
    await gate.check(2);
    await gate.check(3);
  });

  it('never goes back to an older id', async () => {
    const gate = createJobGate();
    gate.supersede(5);
    gate.supersede(3);
    await expect(gate.check(4)).rejects.toBeInstanceOf(Superseded);
    await gate.check(5);
  });

  it('always yields, also when it is going to throw', async () => {
    const gate = createJobGate();
    gate.supersede(9);
    let sync = true;
    const checked = gate.check(1).catch(() => {
      expect(sync).toBe(false);
    });
    sync = false;
    await checked;
  });

  it('a supersede sent during a long job stops it at its next check', async () => {
    const stagesRun: number[] = [];
    let remote!: SlowWorkRemote;
    interface SlowWork extends Cancellable {
      work(r: { jobId: number }): Promise<string>;
    }
    type SlowWorkRemote = { work(r: { jobId: number }): Promise<string>; supersede(jobId: number): Promise<void> };
    const worker = createFakeWorker(
      exposeLike<SlowWork>((gate) => ({
        work: async ({ jobId }) => {
          for (let stage = 1; stage <= 10; stage++) {
            stagesRun.push(stage); // a stage of synchronous work
            // The newer request arrives while stage 3 is running: its message waits in the queue.
            if (stage === 3) void remote.supersede(jobId + 1);
            await gate.check(jobId);
          }
          return 'finished';
        },
      })),
    );
    remote = wrap<SlowWork>(worker) as unknown as SlowWorkRemote;
    const error: unknown = await remote.work({ jobId: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isSuperseded(error)).toBe(true);
    expect((error as Error).message).toContain('job 1');
    expect(stagesRun).toEqual([1, 2, 3]); // stopped at the first check after the supersede was sent
    worker.terminate();
  });
});

/** The object `exposeApi` would expose, without exposing it (createFakeWorker does that). */
function exposeLike<T extends Cancellable>(methods: (gate: JobGate) => Omit<T, 'supersede'>): T {
  const gate = createJobGate();
  return { ...methods(gate), supersede: async (jobId: number) => gate.supersede(jobId) } as unknown as T;
}

describe('latestWins', () => {
  it('five rapid requests on a slow worker run at most two jobs and resolve only the last', async () => {
    const log = newLog();
    const worker = createFakeWorker(slowWorker(log));
    const remote = wrap<SlowApi>(worker);
    const run = latestWins<Job, { jobId: number; tag?: string }>(
      (q) => remote.run(q),
      (jobId) => remote.supersede(jobId),
    );
    const results = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((tag) => run({ stages: 20, tag })));

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'fulfilled']);
    for (const r of results.slice(0, 4)) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Superseded);
    }
    expect(results.slice(0, 4).map((r) => ((r as PromiseRejectedResult).reason as Superseded).jobId)).toEqual([1, 2, 3, 4]);
    expect((results[4] as PromiseFulfilledResult<{ jobId: number; tag?: string }>).value).toEqual({ jobId: 5, tag: 'e' });

    expect(log.started).toEqual([1, 5]); // two jobs: the one in flight and the last
    expect(log.finished).toEqual([5]);
    expect(log.superseded).toEqual([2, 3, 4, 5]); // every newer request told the worker at once
    expect(log.stagesDone[1]).toBeLessThan(20); // the job in flight was cut short
    worker.terminate();
  });

  it('rejects a replaced job in flight with Superseded even when the worker finished it', async () => {
    const calls: number[] = [];
    const gates: ReturnType<typeof deferred<string>>[] = [];
    const superseded: number[] = [];
    const run = latestWins<{ jobId: number; text: string }, string>(
      (q) => {
        calls.push(q.jobId);
        const d = deferred<string>();
        gates.push(d);
        return d.promise;
      },
      async (jobId) => {
        superseded.push(jobId);
      },
    );
    const first = run({ text: 'first' });
    const second = run({ text: 'second' });
    expect(calls).toEqual([1]);
    expect(superseded).toEqual([2]);
    gates[0].resolve('result of the first job'); // the worker ignored the supersede and finished
    await expect(first).rejects.toBeInstanceOf(Superseded);
    expect(calls).toEqual([1, 2]);
    gates[1].resolve('result of the second job');
    await expect(second).resolves.toBe('result of the second job');
  });

  it('assigns increasing job ids and sends no supersede when requests do not overlap', async () => {
    const seen: number[] = [];
    const superseded: number[] = [];
    const run = latestWins<{ jobId: number; n: number }, number>(
      async (q) => {
        seen.push(q.jobId);
        return q.n * 2;
      },
      async (jobId) => {
        superseded.push(jobId);
      },
    );
    expect(await run({ n: 1 })).toBe(2);
    expect(await run({ n: 2 })).toBe(4);
    expect(await run({ n: 3 })).toBe(6);
    expect(seen).toEqual([1, 2, 3]);
    expect(superseded).toEqual([]);
  });

  it('does not touch the caller’s request object', async () => {
    const request = Object.freeze({ n: 1 });
    const run = latestWins<{ jobId: number; n: number }, number>(
      async (q) => q.jobId,
      async () => {},
    );
    expect(await run(request)).toBe(1);
    expect(request).toEqual({ n: 1 });
  });

  it('passes errors through and keeps working after them', async () => {
    let fail = true;
    const run = latestWins<{ jobId: number }, string>(
      async () => {
        if (fail) throw new RangeError('bad input');
        return 'ok';
      },
      async () => {},
    );
    await expect(run({})).rejects.toBeInstanceOf(RangeError);
    fail = false;
    await expect(run({})).resolves.toBe('ok');
  });

  it('turns a synchronous throw of send into a rejection, and still runs the pending request', async () => {
    let n = 0;
    const run = latestWins<{ jobId: number }, string>(
      () => {
        if (++n === 1) throw new Error('send failed');
        return Promise.resolve('second');
      },
      async () => {},
    );
    const first = run({});
    const second = run({});
    await expect(first).rejects.toBeInstanceOf(Superseded); // it was replaced before it settled
    await expect(second).resolves.toBe('second');
  });

  it('rebuilds a Superseded that crossed the worker boundary, with its own job id', async () => {
    const run = latestWins<{ jobId: number }, string>(
      async () => {
        throw Object.assign(new Error('job 1 was superseded by a newer request'), { name: 'Superseded' });
      },
      async () => {},
    );
    const error: unknown = await run({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Superseded);
    expect((error as Superseded).jobId).toBe(1);
  });

  it('survives a supersede call that fails or throws', async () => {
    const gates: ReturnType<typeof deferred<number>>[] = [];
    let mode: 'reject' | 'throw' = 'reject';
    const run = latestWins<{ jobId: number }, number>(
      (q) => {
        const d = deferred<number>();
        gates.push(d);
        return d.promise.then(() => q.jobId);
      },
      (jobId) => {
        if (mode === 'throw') throw new Error(`cannot send supersede(${jobId})`);
        return Promise.reject(new Error(`the worker is gone, supersede(${jobId}) failed`));
      },
    );
    const a = run({});
    const b = run({});
    mode = 'throw';
    const c = run({});
    gates[0].resolve(0);
    await expect(a).rejects.toBeInstanceOf(Superseded);
    await expect(b).rejects.toBeInstanceOf(Superseded);
    await yieldMacrotask();
    gates[1].resolve(0);
    await expect(c).resolves.toBe(3);
  });

  it('never sends a pending request that was replaced, and keeps the transfer list of the one it sends', async () => {
    const log = newLog();
    const received: { jobId: number; bytes: number }[] = [];
    const gate = createJobGate();
    interface BufferJob {
      jobId: number;
      data: Uint8Array<ArrayBuffer>;
    }
    interface BufferApi extends Cancellable {
      run(r: BufferJob): Promise<number>;
    }
    const api: BufferApi = {
      supersede: async (jobId) => {
        log.superseded.push(jobId);
        gate.supersede(jobId);
      },
      run: async (r) => {
        received.push({ jobId: r.jobId, bytes: r.data.byteLength });
        for (let i = 0; i < 5; i++) await gate.check(r.jobId);
        return r.data[0];
      },
    };
    const worker = createFakeWorker(api);
    const remote = wrap<BufferApi>(worker);
    const run = latestWins<BufferJob, number>(
      (q) => remote.run(q),
      (jobId) => remote.supersede(jobId),
    );
    const buffers = [1, 2, 3].map((v) => new Uint8Array(16).fill(v));
    const [a, b, c] = buffers.map((data) => run(transfer({ data }, [data.buffer])));
    expect(buffers[0].byteLength).toBe(0); // sent at once: moved to the worker
    expect(buffers[1].byteLength).toBe(16); // pending, then replaced: never sent, never detached
    expect(buffers[2].byteLength).toBe(16); // pending
    const results = await Promise.allSettled([a, b, c]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect((results[2] as PromiseFulfilledResult<number>).value).toBe(3);
    expect(received).toEqual([
      { jobId: 1, bytes: 16 },
      { jobId: 3, bytes: 16 },
    ]);
    expect(buffers[1].byteLength).toBe(16);
    expect(buffers[2].byteLength).toBe(0); // transferred when it was finally sent
    worker.terminate();
  });
});

describe('createLatestWinsGroup: the job methods of one worker share its gate', () => {
  it('a request on another channel waits for the job in flight instead of cutting it short', async () => {
    const order: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred<void>>> = {};
    const superseded: number[] = [];
    const group = createLatestWinsGroup(async (jobId) => {
      superseded.push(jobId);
    });
    const send = (name: string) => (q: { jobId: number }) => {
      order.push(`${name}#${q.jobId}`);
      const d = deferred();
      gates[`${name}#${q.jobId}`] = d;
      return d.promise.then(() => `${name}#${q.jobId}`);
    };
    const build = group.channel<{ jobId: number }, string>(send('build'));
    const colors = group.channel<{ jobId: number }, string>(send('colors'));

    const b1 = build({});
    const c1 = colors({});
    expect(order).toEqual(['build#1']); // one job in flight per worker
    expect(superseded).toEqual([]); // and the build is not told to stop
    gates['build#1'].resolve();
    await expect(b1).resolves.toBe('build#1');
    expect(order).toEqual(['build#1', 'colors#2']);
    gates['colors#2'].resolve();
    await expect(c1).resolves.toBe('colors#2');
  });

  it('renumbers a waiting request when a supersede with a higher id went out, so the gate cannot stop it', async () => {
    const log = newLog();
    const gate = createJobGate();
    const sawJob: string[] = [];
    interface TwoApi extends Cancellable {
      build(r: { jobId: number }): Promise<string>;
      colors(r: { jobId: number }): Promise<string>;
    }
    const job = (name: string) => async (r: { jobId: number }) => {
      sawJob.push(`${name}#${r.jobId}`);
      for (let i = 0; i < 4; i++) await gate.check(r.jobId);
      return `${name}#${r.jobId}`;
    };
    const api: TwoApi = {
      supersede: async (jobId) => {
        log.superseded.push(jobId);
        gate.supersede(jobId);
      },
      build: job('build'),
      colors: job('colors'),
    };
    const worker = createFakeWorker(api);
    const remote = wrap<TwoApi>(worker);
    const group = createLatestWinsGroup((jobId) => remote.supersede(jobId));
    const build = group.channel<{ jobId: number }, string>((q) => remote.build(q));
    const colors = group.channel<{ jobId: number }, string>((q) => remote.colors(q));

    const c1 = colors({}); // id 1, in flight
    const b = build({}); // id 2, waits: another channel's job is running
    const c2 = colors({}); // id 3: replaces c1 → supersede(3)
    const results = await Promise.allSettled([c1, b, c2]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(Superseded);
    expect(log.superseded).toEqual([3]);
    // With its original id 2 the build would have been stopped by the gate (3 > 2) although nobody replaced
    // it. It ran as job 4; the worker saw ids in increasing order.
    expect(sawJob).toEqual(['colors#1', 'build#4', 'colors#5']);
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe('build#4');
    expect((results[2] as PromiseFulfilledResult<string>).value).toBe('colors#5');
    worker.terminate();
  });

  it('holds its invariants over random request sequences on three channels (seeded)', { timeout: 60_000 }, async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed * 7919);
      const gate = createJobGate();
      let running = 0;
      let maxRunning = 0;
      const jobIds: number[] = [];
      const supersedeIds: number[] = [];
      interface Req {
        jobId: number;
        channel: number;
        seq: number;
        stages: number;
      }
      const group = createLatestWinsGroup(async (jobId) => {
        supersedeIds.push(jobId);
        await yieldMacrotask(); // the message takes a macrotask to arrive
        gate.supersede(jobId);
      });
      const work = async (q: Req): Promise<number> => {
        jobIds.push(q.jobId);
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          for (let i = 0; i < q.stages; i++) await gate.check(q.jobId);
          return q.seq;
        } finally {
          running--;
        }
      };
      const channels = [0, 1, 2].map(() => group.channel<Req, number>(work));
      const requests: { channel: number; seq: number; madeAt: number; settledAt: number; outcome: 'ok' | 'superseded' | 'error' }[] = [];
      let clock = 0;
      const promises: Promise<void>[] = [];
      const total = 40;
      for (let n = 0; n < total; n++) {
        const channel = randomInt(rng, 3);
        const record = { channel, seq: n, madeAt: clock++, settledAt: -1, outcome: 'error' as 'ok' | 'superseded' | 'error' };
        requests.push(record);
        promises.push(
          channels[channel]({ channel, seq: n, stages: randomInt(rng, 4) }).then(
            (value) => {
              expect(value).toBe(n);
              record.outcome = 'ok';
              record.settledAt = clock++;
            },
            (error: unknown) => {
              record.outcome = error instanceof Superseded ? 'superseded' : 'error';
              record.settledAt = clock++;
            },
          ),
        );
        // sometimes several requests in one burst, sometimes with time for the worker to make progress
        const pause = randomInt(rng, 4);
        for (let i = 0; i < pause; i++) await yieldMacrotask();
      }
      await Promise.all(promises);

      expect(maxRunning, `seed ${seed}: one job in flight`).toBe(1);
      expect(requests.every((r) => r.outcome !== 'error')).toBe(true);
      for (let i = 1; i < jobIds.length; i++) expect(jobIds[i], `seed ${seed}: job ids grow`).toBeGreaterThan(jobIds[i - 1]);
      for (let c = 0; c < 3; c++) {
        const mine = requests.filter((r) => r.channel === c);
        if (mine.length === 0) continue;
        // the last request of every channel resolves
        expect(mine[mine.length - 1].outcome, `seed ${seed}, channel ${c}: last one resolves`).toBe('ok');
        // and nothing is rejected unless a newer request of ITS channel existed before it settled
        for (const [i, r] of mine.entries()) {
          if (r.outcome !== 'superseded') continue;
          const newer = mine[i + 1];
          expect(newer, `seed ${seed}: request ${r.seq} was superseded without a successor`).toBeDefined();
          expect(newer.madeAt).toBeLessThan(r.settledAt);
        }
      }
    }
  });
});

describe('transferables', () => {
  it('collects each buffer once, through plain objects, arrays, Maps and Sets', () => {
    const shared = new ArrayBuffer(32);
    const mesh = {
      positions: new Float32Array(shared, 0, 4),
      indices: new Uint32Array(shared, 16, 4),
      labels: new Uint8Array(3),
      nested: { list: [new Int16Array(2), { deep: new DataView(new ArrayBuffer(4)) }], raw: new ArrayBuffer(8) },
      map: new Map<string, Uint8Array>([['a', new Uint8Array(1)]]),
      set: new Set([new Uint8Array(1)]),
      text: 'not a buffer',
      n: 5,
      nothing: null,
    };
    const buffers = collectTransferables(mesh);
    expect(buffers).toHaveLength(7);
    expect(new Set(buffers).size).toBe(7);
    expect(buffers).toContain(shared);
    expect(buffers).toContain(mesh.labels.buffer);
    expect(buffers).toContain(mesh.nested.raw);
  });

  it('does not walk into Blobs or class instances, and survives cycles', () => {
    class Holder {
      data = new Uint8Array(4);
    }
    const cyclic: Record<string, unknown> = { blob: new Blob(['x']), holder: new Holder(), date: new Date(0) };
    cyclic.self = cyclic;
    cyclic.list = [cyclic];
    expect(collectTransferables(cyclic)).toEqual([]);
    expect(collectTransferables(null)).toEqual([]);
    expect(collectTransferables(42)).toEqual([]);
    expect(collectTransferables(new Uint8Array(2))).toHaveLength(1);
  });

  it('transferAll moves a result out of the worker: the sender’s arrays are detached, the receiver’s are intact', async () => {
    interface MeshApi extends Cancellable {
      make(): Promise<{ positions: Float32Array<ArrayBuffer>; labels: Uint8Array<ArrayBuffer> }>;
    }
    let kept: { positions: Float32Array<ArrayBuffer>; labels: Uint8Array<ArrayBuffer> } | undefined;
    const worker = createFakeWorker(
      exposeLike<MeshApi>(() => ({
        make: async () => {
          kept = { positions: new Float32Array([1, 2, 3]), labels: new Uint8Array([7, 8]) };
          return transferAll(kept);
        },
      })),
    );
    const remote = wrap<MeshApi>(worker);
    const result = await remote.make();
    expect([...result.positions]).toEqual([1, 2, 3]);
    expect([...result.labels]).toEqual([7, 8]);
    expect(kept?.positions.byteLength).toBe(0);
    expect(kept?.labels.byteLength).toBe(0);
    worker.terminate();
  });
});

describe('exposeApi', () => {
  it('exposes the methods, wires supersede to the gate and forwards it to a nested worker', async () => {
    const { port1, port2 } = new MessageChannel();
    const forwarded: number[] = [];
    interface Api extends Cancellable {
      slow(r: { jobId: number }): Promise<string>;
      add(a: number, b: number): Promise<number>;
    }
    const { gate, api } = exposeApi<Api>(
      (g) => ({
        slow: async ({ jobId }) => {
          for (let i = 0; i < 50; i++) await g.check(jobId);
          return 'finished';
        },
        add: async (a, b) => a + b,
        supersede: async (jobId) => {
          forwarded.push(jobId);
        },
      }),
      port1,
    );
    const remote = wrap<Api>(port2);
    expect(await remote.add(2, 3)).toBe(5);
    const slow = remote.slow({ jobId: 1 }).catch((e: unknown) => e);
    await remote.supersede(2);
    expect(isSuperseded(await slow)).toBe(true);
    expect(forwarded).toEqual([2]);
    await expect(gate.check(1)).rejects.toBeInstanceOf(Superseded);
    expect(typeof api.supersede).toBe('function');
    port1.close();
    port2.close();
  });

  it('a Step 0 worker stub is recognizable on the client, and so is an ordinary error', async () => {
    const { port1, port2 } = new MessageChannel();
    exposeApi<Chart2dApi>(
      () => ({
        run: stub<Chart2dApi['run']>('Chart2dApi.run'),
        buildPattern: async () => {
          throw new TypeError('no chart');
        },
      }),
      port1,
    );
    const remote = wrap<Chart2dApi>(port2);
    await expect(remote.supersede(1)).resolves.toBeUndefined();

    const notImplemented: unknown = await (remote.run as unknown as (r: unknown) => Promise<unknown>)({ jobId: 1 }).catch((e: unknown) => e);
    expect(notImplemented).toBeInstanceOf(Error);
    expect(isNotImplementedError(notImplemented)).toBe(true);
    expect((notImplemented as Error).message).toBe('Chart2dApi.run not implemented');
    expect(isSuperseded(notImplemented)).toBe(false);

    const ordinary: unknown = await (remote.buildPattern as unknown as (r: unknown) => Promise<unknown>)({}).catch((e: unknown) => e);
    expect(ordinary).toBeInstanceOf(Error);
    expect((ordinary as Error).name).toBe('TypeError');
    expect((ordinary as Error).message).toBe('no chart');
    expect(isNotImplementedError(ordinary)).toBe(false);
    port1.close();
    port2.close();
  });
});
