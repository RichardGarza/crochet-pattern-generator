// In-memory fakes for unit tests (DESIGN.md §5.5.2 "Testability", §6.2 item 7, §6.3 T8). Step 0 owned.
//
//   createFakeLocks()     a `LockManagerLike` with the semantics of `navigator.locks` (exclusive locks, FIFO
//                         queue, `ifAvailable`, `steal`), shared by any number of fake "tabs";
//   createFakeChannels()  a `ChannelLike` factory with the semantics of `BroadcastChannel`;
//   createFakeWorker(api) a comlink worker without a thread, for workers/client.ts.
//
// happy-dom has no lock manager (`navigator.locks` is null; undefined in the node environment), and the real
// two-tab hand-over runs under Playwright (persist.spec, §6.4).
//
// Timing: like the real APIs, nothing here calls back synchronously. Lock callbacks and channel messages are
// delivered in a later MACROTASK (a MessageChannel ping — vitest's fake timers do not hold it back). A test
// waits for the promise it is interested in, or for `await hub.flush()` / `await locks.flush()`.
import { expose, type Endpoint } from 'comlink';
import type { ChannelLike, LockManagerLike } from '../types/entryPoints';
import { yieldMacrotask } from '../workers/rpc';

/** Runs `fn` in a later macrotask, in the order of the calls. */
function defer(fn: () => void): void {
  void yieldMacrotask().then(fn);
}

function domException(message: string, name: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---- locks

/** What a lock callback receives when the lock is granted (the real one is a `Lock`). */
export interface FakeLock {
  readonly name: string;
  readonly mode: 'exclusive';
}

export interface FakeLockInfo {
  name: string;
  mode: 'exclusive';
  /** The fake tab that holds or requested the lock. */
  clientId: string;
}

/** One fake tab's view of the lock manager. */
export interface FakeLockClient extends LockManagerLike {
  readonly clientId: string;
  /**
   * What closing the tab does: its held locks are released and its queued requests dropped (their `request`
   * promises never settle, as in a tab that is gone). Later requests from this client reject.
   */
  close(): void;
}

export interface FakeLockManager extends LockManagerLike {
  /** A lock manager view for one fake tab; all clients of one manager share the locks. */
  client(clientId?: string): FakeLockClient;
  /** Like `navigator.locks.query()`, but synchronous. */
  query(): { held: FakeLockInfo[]; pending: FakeLockInfo[] };
  /** True when `name` is held by anyone. */
  isHeld(name: string): boolean;
  /** Resolves once every callback that could start by now has been started. */
  flush(): Promise<void>;
}

interface LockRequest {
  name: string;
  clientId: string;
  callback: (lock: unknown | null) => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface HeldLock {
  request: LockRequest;
}

/**
 * An in-memory lock manager with the semantics of `navigator.locks` for exclusive locks:
 *
 *   - `request(name, {}, cb)` waits its turn (FIFO per name), calls `cb(lock)`, holds the lock until the
 *     promise `cb` returned settles, then resolves (or rejects) with `cb`'s outcome;
 *   - `{ ifAvailable: true }`: when the lock is held, or others are queued for it, `cb(null)` is called
 *     instead of waiting, and `request` resolves with what `cb(null)` returns;
 *   - `{ steal: true }`: the current holder loses the lock at once — ITS `request` promise rejects with an
 *     `AbortError` DOMException, while its callback keeps running — and the stealing request is granted ahead
 *     of everything queued;
 *   - `steal` together with `ifAvailable`, and a name starting with `-`, reject with `NotSupportedError`;
 *   - a callback is never called synchronously inside `request`.
 *
 * `createFakeLocks()` itself is the lock manager of a default tab (`clientId` 'tab-0'); `client()` makes more
 * tabs that share the same locks.
 */
export function createFakeLocks(): FakeLockManager {
  const held = new Map<string, HeldLock>();
  const queues = new Map<string, LockRequest[]>();
  const closed = new Set<string>();
  let nextClient = 1;
  let scheduled = 0;

  const queueOf = (name: string): LockRequest[] => {
    let q = queues.get(name);
    if (!q) {
      q = [];
      queues.set(name, q);
    }
    return q;
  };

  const later = (fn: () => void): void => {
    scheduled++;
    defer(() => {
      scheduled--;
      fn();
    });
  };

  /** Calls the callback and settles the request with its outcome; `lock` is null for an unavailable lock. */
  const run = (request: LockRequest, lock: FakeLock | null, done: () => void): void => {
    let outcome: Promise<unknown>;
    try {
      outcome = Promise.resolve(request.callback(lock));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (value) => {
        done();
        request.resolve(value);
      },
      (error: unknown) => {
        done();
        request.reject(error);
      },
    );
  };

  const grant = (request: LockRequest): void => {
    const lock: HeldLock = { request };
    held.set(request.name, lock);
    run(request, { name: request.name, mode: 'exclusive' }, () => {
      // A stolen lock is no longer in the table; its callback finishing releases nothing.
      if (held.get(request.name) === lock) {
        held.delete(request.name);
        later(() => process(request.name));
      }
    });
  };

  const process = (name: string): void => {
    if (held.has(name)) return;
    const q = queueOf(name);
    const next = q.shift();
    if (next) grant(next);
  };

  const requestAs = (
    clientId: string,
    name: string,
    o: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown> => {
    if (closed.has(clientId)) return Promise.reject(domException('The tab that made this lock request is closed.', 'InvalidStateError'));
    if (name.startsWith('-')) return Promise.reject(domException("Lock names must not start with '-'.", 'NotSupportedError'));
    if (o.steal && o.ifAvailable) {
      return Promise.reject(domException("The 'steal' and 'ifAvailable' options cannot be used together.", 'NotSupportedError'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const request: LockRequest = { name, clientId, callback, resolve, reject };
      // Like the real manager, a request takes effect asynchronously, and requests take effect in call order.
      later(() => {
        if (closed.has(clientId)) return;
        if (o.steal) {
          const victim = held.get(name);
          if (victim) {
            held.delete(name);
            victim.request.reject(domException("Lock broken by another request with the 'steal' option.", 'AbortError'));
          }
          queueOf(name).unshift(request);
        } else if (o.ifAvailable && (held.has(name) || queueOf(name).length > 0)) {
          run(request, null, () => {});
          return;
        } else {
          queueOf(name).push(request);
        }
        process(name);
      });
    });
  };

  const makeClient = (clientId: string): FakeLockClient => ({
    clientId,
    request: (name, o, callback) => requestAs(clientId, name, o, callback),
    close(): void {
      closed.add(clientId);
      for (const [name, q] of queues) {
        queues.set(
          name,
          q.filter((r) => r.clientId !== clientId),
        );
      }
      for (const [name, lock] of [...held]) {
        if (lock.request.clientId !== clientId) continue;
        held.delete(name);
        later(() => process(name));
      }
    },
  });

  const defaultClient = makeClient('tab-0');

  return {
    request: defaultClient.request,
    client(clientId?: string): FakeLockClient {
      return makeClient(clientId ?? `tab-${nextClient++}`);
    },
    query() {
      const info = (r: LockRequest): FakeLockInfo => ({ name: r.name, mode: 'exclusive', clientId: r.clientId });
      return {
        held: [...held.values()].map((l) => info(l.request)),
        pending: [...queues.values()].flatMap((q) => q.map(info)),
      };
    },
    isHeld: (name) => held.has(name),
    async flush(): Promise<void> {
      do {
        await yieldMacrotask();
      } while (scheduled > 0);
    },
  };
}

// ---- channels

export interface FakeChannelHub {
  /**
   * The factory to pass as `createProjectRepository({ channel })`: a new channel object every call, as
   * `new BroadcastChannel(name)` would give. Safe to pass around unbound.
   */
  channel(name: string): ChannelLike;
  /** Resolves once every message posted so far has been delivered. */
  flush(): Promise<void>;
  /** How many channels are open, for one name or in total. */
  openCount(name?: string): number;
}

interface FakeChannel extends ChannelLike {
  closed: boolean;
}

/**
 * An in-memory bus with the semantics of `BroadcastChannel`: a message goes to every OTHER open channel object
 * with the same name — also to a second channel of the same fake tab, never to the sender — as a
 * structured clone, in a later macrotask, in posting order. The receivers are fixed when the message is
 * posted; one that is closed before delivery does not get it. `postMessage` on a closed channel throws
 * `InvalidStateError`, and a value that cannot be cloned throws `DataCloneError`, both synchronously.
 */
export function createFakeChannels(): FakeChannelHub {
  const open = new Map<string, Set<FakeChannel>>();
  let undelivered = 0;

  const channel = (name: string): ChannelLike => {
    let peers = open.get(name);
    if (!peers) {
      peers = new Set();
      open.set(name, peers);
    }
    const group = peers;
    const self: FakeChannel = {
      closed: false,
      onmessage: null,
      postMessage(message: unknown): void {
        if (self.closed) throw domException('The channel is closed.', 'InvalidStateError');
        const deliveries = [...group].filter((peer) => peer !== self).map((peer) => ({ peer, data: structuredClone(message) }));
        undelivered++;
        defer(() => {
          undelivered--;
          for (const { peer, data } of deliveries) {
            if (!peer.closed) peer.onmessage?.({ data });
          }
        });
      },
      close(): void {
        self.closed = true;
        group.delete(self);
      },
    };
    group.add(self);
    return self;
  };

  return {
    channel,
    async flush(): Promise<void> {
      do {
        await yieldMacrotask();
      } while (undelivered > 0);
    },
    openCount(name?: string): number {
      if (name !== undefined) return open.get(name)?.size ?? 0;
      let n = 0;
      for (const peers of open.values()) n += peers.size;
      return n;
    },
  };
}

// ---- workers

/** The object `createFakeWorker` returns: what workers/client.ts calls a `WorkerLike`, plus test controls. */
export interface FakeWorker extends Endpoint {
  terminate(): void;
  readonly terminated: boolean;
  /** Fires an `error` event on the worker object, as an uncaught error inside a real worker would. */
  crash(message?: string): void;
}

type Listener = EventListenerOrEventListenerObject;

/**
 * A worker without a thread: `api` is exposed with comlink on one end of a MessageChannel and the returned
 * object is the other end. Calls go through real comlink messages (structured clone, transfer lists,
 * `Comlink.proxy` callbacks, errors rebuilt by name), so client code is exercised as with a real worker —
 * except that `api` runs on the calling thread, so a method that never awaits blocks its caller.
 *
 *   const client = createWorkerClient({ spawn: (name) => createFakeWorker(apis[name]) });
 */
export function createFakeWorker(api: object): FakeWorker {
  const { port1, port2 } = new MessageChannel();
  // Node only: a forgotten fake worker must not keep the test process alive.
  (port1 as { unref?: () => void }).unref?.();
  (port2 as { unref?: () => void }).unref?.();
  expose(api, port1);
  const errorListeners = new Set<Listener>();
  let terminated = false;
  return {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) return; // like a terminated Worker: the message is dropped
      port2.postMessage(message, transfer ?? []);
    },
    addEventListener(type: string, listener: Listener, options?: object): void {
      if (type === 'error' || type === 'messageerror') errorListeners.add(listener);
      else port2.addEventListener(type, listener, options);
    },
    removeEventListener(type: string, listener: Listener, options?: object): void {
      if (type === 'error' || type === 'messageerror') errorListeners.delete(listener);
      else port2.removeEventListener(type, listener, options);
    },
    start(): void {
      port2.start();
    },
    terminate(): void {
      terminated = true;
      port1.close();
      port2.close();
    },
    get terminated(): boolean {
      return terminated;
    },
    crash(message = 'fake worker crashed'): void {
      const event = { type: 'error', message } as unknown as Event;
      for (const listener of [...errorListeners]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}
