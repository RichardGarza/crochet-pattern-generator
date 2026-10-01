// Worker RPC (DESIGN.md §5.4, D22). Step 0 owned.
//
// This half has no DOM and no Worker in it, so it runs inside workers, on the main thread and in the vitest
// node environment. workers/client.ts (main thread) builds the typed worker proxies on top of it.
//
// There is no SharedArrayBuffer (D20) and a comlink message is a macrotask, so a running job sees a newer
// request only when it yields. Hence:
//   - the CLIENT side keeps at most one request in flight and one pending per channel (`latestWins`), rejects
//     what a newer request replaced with `Superseded`, and tells the worker with `supersede(newJobId)`;
//   - the WORKER side keeps the newest job id in a gate (`createJobGate`) and calls `await gate.check(jobId)`
//     between stages: a macrotask yield that lets the queued `supersede` message run, then a throw when the
//     job is no longer the newest.
import { expose, transfer as comlinkTransfer, type Endpoint } from 'comlink';
import type { CreateJobGateFn, LatestWinsFn, YieldMacrotaskFn } from '../types/entryPoints';
import type { Cancellable } from '../types/workers';

// ---- Superseded

/**
 * Thrown by `gate.check` inside a worker when a newer job has arrived, and used by `latestWins` to reject the
 * requests a newer one replaced. Callers ignore it: a newer request of theirs is on its way.
 *
 * comlink rebuilds a thrown error as a plain `Error` that keeps only `name`, `message` and `stack`, so after a
 * worker boundary `instanceof Superseded` is false: use `isSuperseded(e)`. (`latestWins` rebuilds real
 * instances, so what its callers catch does pass `instanceof`.)
 */
export class Superseded extends Error {
  readonly jobId: number;

  constructor(jobId: number) {
    super(`job ${jobId} was superseded by a newer request`);
    this.name = 'Superseded';
    this.jobId = jobId;
  }
}

/** True for a `Superseded`, also after it has crossed a worker boundary (recognized by name). */
export function isSuperseded(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'Superseded';
}

// ---- yieldMacrotask

// Captured at module load, so a test that installs fake timers later does not freeze every gate.
const realSetImmediate: ((fn: () => void) => unknown) | undefined = typeof setImmediate === 'function' ? setImmediate : undefined;
const realSetTimeout = setTimeout;

type RefPort = MessagePort & { ref?: () => void; unref?: () => void };
let ping: { receive: RefPort; send: MessagePort } | undefined;
const waiting: (() => void)[] = [];

function pingChannel(): { receive: RefPort; send: MessagePort } {
  if (ping) return ping;
  const { port1, port2 } = new MessageChannel();
  const receive = port1 as RefPort;
  receive.onmessage = () => {
    const resolve = waiting.shift();
    // Node only: an idle port must not keep the process alive.
    if (waiting.length === 0) receive.unref?.();
    if (!resolve) return;
    // Node polls message ports in handle order, not in posting order, so one ping does not guarantee that a
    // message queued earlier on ANOTHER port has been delivered (measured: 0 of 200 when the ping channel is
    // the older one). setImmediate runs after the current poll phase, which has then drained every port.
    // Browsers have no setImmediate and deliver posted messages in posting order.
    if (realSetImmediate) realSetImmediate(resolve);
    else resolve();
  };
  receive.unref?.();
  ping = { receive, send: port2 };
  return ping;
}

/**
 * Resolves in a later macrotask: a MessageChannel ping. Messages that were already queued for this thread —
 * a worker's `supersede` call in particular — run before the promise resolves. `setTimeout(0)` would do the
 * same but is clamped to 4 ms once nested.
 */
export const yieldMacrotask: YieldMacrotaskFn = () =>
  new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      realSetTimeout(resolve, 0);
      return;
    }
    const channel = pingChannel();
    waiting.push(resolve);
    channel.receive.ref?.();
    channel.send.postMessage(0);
  });

// ---- the worker's job gate

export type JobGate = ReturnType<CreateJobGateFn>;

/**
 * Cooperative cancellation inside a worker (§5.4 item 2). The worker's `supersede(jobId)` method calls
 * `gate.supersede(jobId)`; a job calls `await gate.check(itsJobId)` between stages and at least every ~50 ms
 * inside long loops. `check` always yields one macrotask first, so a `supersede` message that is waiting in
 * the queue is seen by the very next check; then it throws `Superseded` when a newer job id is known.
 *
 * `supersede` only ever raises the newest id, so messages that arrive out of order cannot revive an old job.
 */
export const createJobGate: CreateJobGateFn = () => {
  let latestJobId = Number.NEGATIVE_INFINITY;
  return {
    supersede(jobId: number): void {
      if (jobId > latestJobId) latestJobId = jobId;
    },
    async check(jobId: number): Promise<void> {
      await yieldMacrotask();
      if (latestJobId > jobId) throw new Superseded(jobId);
    },
  };
};

// ---- transferables

const transferLists = new WeakMap<object, Transferable[]>();

/**
 * Marks `value` so that the listed buffers are TRANSFERRED (moved, not copied) when `value` is sent as a call
 * argument or returned from an exposed method — comlink's `transfer`, plus a record that lets `latestWins`
 * keep the list when it adds the job id to a request. Transfer only what the sender no longer needs: the
 * buffers are detached on this side. Buffers a store still holds are cloned instead (send them unmarked).
 */
export function transfer<T extends object>(value: T, transferables: Transferable[]): T {
  transferLists.set(value, transferables);
  return comlinkTransfer(value, transferables);
}

/** An ArrayBuffer, also one from another realm (`instanceof` would miss it); never a SharedArrayBuffer. */
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]';

/**
 * Every ArrayBuffer reachable from `value` through plain objects, arrays, Maps and Sets (typed arrays and
 * DataViews contribute their underlying buffer), each listed once. SharedArrayBuffers are skipped.
 */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (v: unknown): void => {
    if (typeof v !== 'object' || v === null) return;
    if (seen.has(v)) return;
    seen.add(v);
    if (isArrayBuffer(v)) {
      found.add(v);
      return;
    }
    if (ArrayBuffer.isView(v)) {
      if (isArrayBuffer(v.buffer)) found.add(v.buffer);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v instanceof Map) {
      for (const [k, item] of v) {
        visit(k);
        visit(item);
      }
      return;
    }
    if (v instanceof Set) {
      for (const item of v) visit(item);
      return;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return; // Blob, Date, class instances: not walked
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(value);
  return [...found];
}

/**
 * `transfer(value, collectTransferables(value))`: for a worker result (or a request) whose buffers the sender
 * will not touch again, e.g. `return transferAll(result)` at the end of an exposed method (§5.4 item 3).
 */
export function transferAll<T extends object>(value: T): T {
  return transfer(value, collectTransferables(value));
}

// ---- latest-wins channels (client side)

interface Slot {
  /** Which channel of the group the request belongs to. */
  readonly channel: symbol;
  jobId: number;
  /** Set when a newer request of the same channel arrived while this one was in flight. */
  superseded: boolean;
  send(jobId: number): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** The latest-wins channels of ONE worker: see `createLatestWinsGroup`. */
export interface LatestWinsGroup {
  /**
   * A latest-wins wrapper for one job method of the worker. `send` receives the request with its `jobId`
   * filled in (and the transfer list of `transfer(request, …)` carried over).
   */
  channel<Q extends { jobId: number }, R>(send: (q: Q) => Promise<R>): (q: Omit<Q, 'jobId'>) => Promise<R>;
}

/**
 * Latest-wins channels for the job methods of one worker (§5.4 item 1). A worker has ONE gate, and
 * `supersede(n)` stops every job whose id is below n, whichever method started it. So the channels of a
 * worker share a job-id counter and one in-flight slot:
 *
 *   - at most one job of the worker is in flight, and each channel keeps at most one pending request;
 *   - a newer request on a channel rejects that channel's pending one with `Superseded`, and — when the job
 *     in flight belongs to the same channel — marks it stale and immediately sends `supersede(newJobId)`;
 *     a job of ANOTHER channel is never cut short: the request waits its turn;
 *   - a stale job rejects with `Superseded` when it settles, even if the worker finished it;
 *   - job ids only grow in the order the worker sees them (a waiting request is renumbered if a `supersede`
 *     with a higher id went out meanwhile), so the gate never stops a job that nobody replaced.
 *
 * The promise of `send` must settle (workers/client.ts rejects it when a worker is terminated or crashes);
 * a `send` that never settles blocks the group.
 */
export function createLatestWinsGroup(supersede: (jobId: number) => Promise<void>): LatestWinsGroup {
  let lastJobId = 0;
  /** The highest id the worker has seen, in a job or in a `supersede` message. */
  let highWater = 0;
  let inFlight: Slot | null = null;
  /** At most one per channel, in request order. */
  const pending: Slot[] = [];

  const start = (slot: Slot): void => {
    if (slot.jobId < highWater) slot.jobId = ++lastJobId;
    highWater = slot.jobId;
    inFlight = slot;
    let sent: Promise<unknown>;
    try {
      sent = Promise.resolve(slot.send(slot.jobId));
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      (value) => settle(slot, true, value),
      (error: unknown) => settle(slot, false, error),
    );
  };

  const settle = (slot: Slot, ok: boolean, value: unknown): void => {
    if (inFlight === slot) inFlight = null;
    if (slot.superseded) slot.reject(new Superseded(slot.jobId));
    else if (ok) slot.resolve(value);
    else slot.reject(isSuperseded(value) && !(value instanceof Superseded) ? new Superseded(slot.jobId) : value);
    if (inFlight === null) {
      const next = pending.shift();
      if (next) start(next);
    }
  };

  const notifyWorker = (jobId: number): void => {
    if (jobId > highWater) highWater = jobId;
    try {
      // A failed supersede message is not the caller's problem: the job in flight then simply runs to its end.
      Promise.resolve(supersede(jobId)).catch(() => {});
    } catch {
      // as above
    }
  };

  return {
    channel<Q extends { jobId: number }, R>(send: (q: Q) => Promise<R>): (q: Omit<Q, 'jobId'>) => Promise<R> {
      const channel = Symbol('latest-wins channel');
      return (request) =>
        new Promise<R>((resolve, reject) => {
          const slot: Slot = {
            channel,
            jobId: ++lastJobId,
            superseded: false,
            send: (jobId) => {
              const full = { ...request, jobId } as unknown as Q;
              const list = transferLists.get(request);
              return send(list ? transfer(full, list) : full);
            },
            resolve: resolve as (value: unknown) => void,
            reject,
          };
          if (inFlight === null) {
            start(slot);
            return;
          }
          const replaced = pending.findIndex((p) => p.channel === channel);
          if (replaced >= 0) {
            const [old] = pending.splice(replaced, 1);
            old.reject(new Superseded(old.jobId));
          }
          pending.push(slot);
          if (inFlight.channel === channel) {
            inFlight.superseded = true;
            notifyWorker(slot.jobId);
          }
        });
    },
  };
}

/**
 * One latest-wins channel (§5.4 item 1, §5.2.1): at most one request in flight and one pending; a newer
 * request rejects the pending one with `Superseded` and immediately sends `supersede(newJobId)`, so five rapid
 * requests run at most two jobs and only the last one resolves. The wrapper assigns the job ids (1, 2, 3, …).
 *
 * For a worker with several job methods, use ONE `createLatestWinsGroup` for all of them (as client.ts does).
 */
export const latestWins: LatestWinsFn = (send, supersede) => createLatestWinsGroup(supersede).channel(send);

// ---- exposing a worker API

/**
 * Exposes a worker's API with comlink and wires its `supersede` method to a fresh job gate:
 *
 *   exposeApi<Chart2dApi>((gate) => ({
 *     run: async (r) => transferAll(await runChart({ ...r, image: await decodeImage(r.image) }, gate)),
 *     buildPattern: async (r) => buildPattern2D(r),
 *   }));
 *
 * The exposed `supersede(jobId)` raises the gate. A worker that owns a nested worker (ami.worker → its private
 * mesh.worker) also returns its own `supersede` from the factory; it runs after the gate was raised and
 * forwards the id. `endpoint` defaults to the worker's global scope; tests pass a MessagePort.
 */
export function exposeApi<T extends Cancellable>(
  methods: (gate: JobGate) => Omit<T, 'supersede'> & { supersede?: Cancellable['supersede'] },
  endpoint?: Endpoint,
): { api: T; gate: JobGate } {
  const gate = createJobGate();
  const { supersede: forward, ...rest } = methods(gate);
  const api = {
    ...rest,
    supersede: async (jobId: number): Promise<void> => {
      gate.supersede(jobId);
      if (forward) await forward(jobId);
    },
  } as unknown as T;
  if (endpoint) expose(api, endpoint);
  else expose(api);
  return { api, gate };
}
