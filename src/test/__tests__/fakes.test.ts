// The fakes must behave like the real things, or tests built on them prove nothing: every expectation below
// is the documented behavior of navigator.locks / BroadcastChannel (and is repeated against the real APIs by
// the Playwright spec persist.spec, §6.4).
import { wrap } from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { yieldMacrotask } from '../../workers/rpc';
import { createFakeChannels, createFakeLocks, createFakeWorker, type FakeLock } from '../fakes';

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const outcome = (p: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('createFakeLocks', () => {
  it('grants a free lock, holds it while the callback runs and resolves with the callback’s value', async () => {
    const locks = createFakeLocks();
    const release = deferred<string>();
    let granted: unknown;
    let sync = true;
    const request = locks.request('project:a', {}, async (lock) => {
      expect(sync).toBe(false); // never called synchronously inside request()
      granted = lock;
      return release.promise;
    });
    sync = false;
    await locks.flush();
    expect(granted).toEqual({ name: 'project:a', mode: 'exclusive' } satisfies FakeLock);
    expect(locks.isHeld('project:a')).toBe(true);
    expect(locks.query()).toEqual({ held: [{ name: 'project:a', mode: 'exclusive', clientId: 'tab-0' }], pending: [] });
    release.resolve('done');
    expect(await request).toBe('done');
    await locks.flush();
    expect(locks.isHeld('project:a')).toBe(false);
  });

  it('makes a second request on a held lock wait, in order', async () => {
    const locks = createFakeLocks();
    const order: string[] = [];
    const first = deferred();
    const second = deferred();
    const a = locks.request('p', {}, async () => {
      order.push('a starts');
      await first.promise;
      order.push('a ends');
    });
    const b = locks.request('p', {}, async () => {
      order.push('b starts');
      await second.promise;
      order.push('b ends');
    });
    const c = locks.request('p', {}, async () => {
      order.push('c starts');
    });
    await locks.flush();
    expect(order).toEqual(['a starts']);
    expect(locks.query().pending).toHaveLength(2);
    first.resolve();
    await a;
    await locks.flush();
    expect(order).toEqual(['a starts', 'a ends', 'b starts']);
    second.resolve();
    await Promise.all([b, c]);
    expect(order).toEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts']);
  });

  it('keeps locks with different names apart', async () => {
    const locks = createFakeLocks();
    const hold = deferred();
    const a = locks.request('project:a', {}, () => hold.promise);
    let other = false;
    await locks.request('project:b', {}, async () => {
      other = true;
    });
    expect(other).toBe(true);
    hold.resolve();
    await a;
  });

  it('ifAvailable: the callback gets null when the lock is held, or when others are waiting for it', async () => {
    const locks = createFakeLocks();
    const hold = deferred();
    const holder = locks.request('p', {}, () => hold.promise);
    await locks.flush();

    const seen: unknown[] = [];
    const result = await locks.request('p', { ifAvailable: true }, async (lock) => {
      seen.push(lock);
      return lock === null ? 'read-only' : 'edit';
    });
    expect(seen).toEqual([null]);
    expect(result).toBe('read-only'); // request resolves with what the callback returned
    expect(locks.query().pending).toEqual([]); // it did not queue

    // free the lock while another request is queued: ifAvailable must still not jump the queue
    const waiterGate = deferred();
    const waiter = locks.request('p', {}, () => waiterGate.promise);
    const jump = locks.request('p', { ifAvailable: true }, async (lock) => lock);
    expect(await jump).toBeNull();
    hold.resolve();
    await holder;
    waiterGate.resolve();
    await waiter;
    await locks.flush();

    // and a free lock is granted
    const free = await locks.request('p', { ifAvailable: true }, async (lock) => lock);
    expect(free).toEqual({ name: 'p', mode: 'exclusive' });
  });

  it('ifAvailable holds the lock like any other request once it got it', async () => {
    const locks = createFakeLocks();
    const hold = deferred();
    const editor = locks.request('p', { ifAvailable: true }, (lock) => (lock ? hold.promise : Promise.resolve()));
    await locks.flush();
    expect(locks.isHeld('p')).toBe(true);
    expect(await locks.request('p', { ifAvailable: true }, async (lock) => lock)).toBeNull();
    hold.resolve();
    await editor;
  });

  it('steal takes a held lock: the old holder’s request rejects with AbortError while its callback keeps running', async () => {
    const locks = createFakeLocks();
    const tabA = locks.client('tab-a');
    const tabB = locks.client('tab-b');
    const aWork = deferred<string>();
    let aFinished = false;
    const a = outcome(
      tabA.request('project:x', {}, async () => {
        const value = await aWork.promise;
        aFinished = true;
        return value;
      }),
    );
    await locks.flush();
    expect(locks.query().held).toEqual([{ name: 'project:x', mode: 'exclusive', clientId: 'tab-a' }]);

    const bWork = deferred();
    let bLock: unknown = 'not called';
    const b = tabB.request('project:x', { steal: true }, async (lock) => {
      bLock = lock;
      await bWork.promise;
      return 'b done';
    });
    const stolen = await a; // settles at once, although A's callback has not returned
    expect(aFinished).toBe(false);
    expect(bLock).toBe('not called'); // as in Chromium: the old holder learns it first, then B's callback runs
    expect(stolen.ok).toBe(false);
    const error = (stolen as { ok: false; error: unknown }).error;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');

    await locks.flush();
    expect(bLock).toEqual({ name: 'project:x', mode: 'exclusive' });
    expect(locks.query().held).toEqual([{ name: 'project:x', mode: 'exclusive', clientId: 'tab-b' }]);

    // A's callback finishing later releases nothing: B still holds the lock
    aWork.resolve('a done');
    await locks.flush();
    expect(aFinished).toBe(true);
    expect(locks.isHeld('project:x')).toBe(true);
    expect(locks.query().held[0].clientId).toBe('tab-b');
    bWork.resolve();
    expect(await b).toBe('b done');
    await locks.flush();
    expect(locks.isHeld('project:x')).toBe(false);
  });

  it('steal goes ahead of everything that was waiting, which then waits for the stealer', async () => {
    const locks = createFakeLocks();
    const order: string[] = [];
    const hold = deferred();
    const holder = outcome(locks.request('p', {}, () => hold.promise));
    const waiting = locks.request('p', {}, async () => {
      order.push('waiter');
    });
    const stealGate = deferred();
    const stealer = locks.request('p', { steal: true }, async () => {
      order.push('stealer');
      await stealGate.promise;
    });
    expect((await holder).ok).toBe(false);
    await locks.flush();
    expect(order).toEqual(['stealer']);
    stealGate.resolve();
    await Promise.all([stealer, waiting]);
    expect(order).toEqual(['stealer', 'waiter']);
    hold.resolve();
  });

  it('steal on a free lock is simply granted', async () => {
    const locks = createFakeLocks();
    expect(await locks.request('p', { steal: true }, async (lock) => lock)).toEqual({ name: 'p', mode: 'exclusive' });
  });

  it('rejects when the callback throws or rejects, and releases the lock', async () => {
    const locks = createFakeLocks();
    await expect(
      locks.request('p', {}, () => {
        throw new Error('thrown');
      }),
    ).rejects.toThrow('thrown');
    await expect(locks.request('p', {}, async () => Promise.reject(new Error('rejected')))).rejects.toThrow('rejected');
    await locks.flush();
    expect(locks.isHeld('p')).toBe(false);
    expect(await locks.request('p', {}, async () => 'next')).toBe('next');
    // also for an unavailable lock's callback
    const hold = deferred();
    const holder = locks.request('q', {}, () => hold.promise);
    await expect(
      locks.request('q', { ifAvailable: true }, () => {
        throw new Error('from the null callback');
      }),
    ).rejects.toThrow('from the null callback');
    hold.resolve();
    await holder;
  });

  it('refuses steal with ifAvailable, and names that start with a hyphen', async () => {
    const locks = createFakeLocks();
    let called = false;
    const cb = async (): Promise<void> => {
      called = true;
    };
    const both = await outcome(locks.request('p', { steal: true, ifAvailable: true }, cb));
    const hyphen = await outcome(locks.request('-p', {}, cb));
    for (const result of [both, hyphen]) {
      expect(result.ok).toBe(false);
      expect(((result as { ok: false; error: unknown }).error as DOMException).name).toBe('NotSupportedError');
    }
    expect(called).toBe(false);
  });

  it('closing a tab releases its locks and drops its waiting requests', async () => {
    const locks = createFakeLocks();
    const tabA = locks.client();
    const tabB = locks.client();
    const tabC = locks.client();
    expect([tabA.clientId, tabB.clientId, tabC.clientId]).toEqual(['tab-1', 'tab-2', 'tab-3']);
    void tabA.request('p', {}, () => new Promise(() => {})); // a tab that never lets go
    let bGot = false;
    void tabB.request('p', {}, async () => {
      bGot = true;
      return new Promise(() => {});
    });
    let cGot = false;
    const c = tabC.request('p', {}, async () => {
      cGot = true;
    });
    await locks.flush();
    expect(locks.query().held[0].clientId).toBe('tab-1');
    tabB.close(); // B gives up waiting
    tabA.close(); // A's tab is closed
    await c;
    expect(bGot).toBe(false);
    expect(cGot).toBe(true);
    await expect(tabA.request('p', {}, async () => {})).rejects.toThrow('closed');
  });

  it('a tab closed after its lock was granted, before its callback ran: the callback never runs and the lock moves on', async () => {
    const locks = createFakeLocks();
    const tabA = locks.client('tab-a');
    let aRan = false;
    void tabA.request('p', {}, async () => {
      aRan = true;
    });
    await yieldMacrotask(); // the grant has happened; the callback's own task is still queued
    expect(locks.query().held).toEqual([{ name: 'p', mode: 'exclusive', clientId: 'tab-a' }]);
    expect(aRan).toBe(false);
    tabA.close();
    expect(await locks.request('p', {}, async (lock) => lock)).toEqual({ name: 'p', mode: 'exclusive' });
    expect(aRan).toBe(false);
  });

  it('works under fake timers', async () => {
    vi.useFakeTimers();
    const locks = createFakeLocks();
    expect(await locks.request('p', {}, async () => 'granted')).toBe('granted');
    await locks.flush();
  });
});

describe('createFakeChannels', () => {
  it('delivers to the other channels of the same name, not to the sender, and asynchronously', async () => {
    const hub = createFakeChannels();
    const a = hub.channel('cpg');
    const b = hub.channel('cpg');
    const c = hub.channel('cpg');
    const other = hub.channel('another-name');
    const got: Record<string, unknown[]> = { a: [], b: [], c: [], other: [] };
    a.onmessage = (e) => got.a.push(e.data);
    b.onmessage = (e) => got.b.push(e.data);
    c.onmessage = (e) => got.c.push(e.data);
    other.onmessage = (e) => got.other.push(e.data);

    a.postMessage({ type: 'release', project: 'p1' });
    expect(got.b).toEqual([]); // not synchronously
    await Promise.resolve();
    expect(got.b).toEqual([]); // and not in a microtask: a later task, like the real thing
    await hub.flush();
    expect(got).toEqual({ a: [], b: [{ type: 'release', project: 'p1' }], c: [{ type: 'release', project: 'p1' }], other: [] });
    expect(hub.openCount('cpg')).toBe(3);
    expect(hub.openCount()).toBe(4);
  });

  it('delivers in posting order and gives every receiver its own copy', async () => {
    const hub = createFakeChannels();
    const a = hub.channel('cpg');
    const b = hub.channel('cpg');
    const c = hub.channel('cpg');
    const atB: { n: number }[] = [];
    const atC: { n: number }[] = [];
    b.onmessage = (e) => atB.push(e.data as { n: number });
    c.onmessage = (e) => atC.push(e.data as { n: number });
    const message = { n: 1 };
    a.postMessage(message);
    message.n = 99; // changed after posting: the receivers still get what was posted
    a.postMessage({ n: 2 });
    b.postMessage({ n: 3 });
    await hub.flush();
    expect(atB.map((m) => m.n)).toEqual([1, 2]);
    expect(atC.map((m) => m.n)).toEqual([1, 2, 3]);
    expect(atB[0]).not.toBe(atC[0]);
    expect(atB[0]).not.toBe(message);
  });

  it('a closed channel receives nothing, also what was posted before it closed, and cannot post', async () => {
    const hub = createFakeChannels();
    const a = hub.channel('cpg');
    const b = hub.channel('cpg');
    const got: unknown[] = [];
    b.onmessage = (e) => got.push(e.data);
    a.postMessage('before close');
    b.close();
    await hub.flush();
    expect(got).toEqual([]);
    expect(hub.openCount('cpg')).toBe(1);
    expect(() => b.postMessage('x')).toThrow(DOMException);
    try {
      b.postMessage('x');
    } catch (e) {
      expect((e as DOMException).name).toBe('InvalidStateError');
    }
    b.close(); // closing twice is fine
  });

  it('a channel opened after a message was posted does not get it', async () => {
    const hub = createFakeChannels();
    const a = hub.channel('cpg');
    a.postMessage('early');
    const late = hub.channel('cpg');
    const got: unknown[] = [];
    late.onmessage = (e) => got.push(e.data);
    await hub.flush();
    expect(got).toEqual([]);
  });

  it('throws at once for a message that cannot be cloned', () => {
    const hub = createFakeChannels();
    const a = hub.channel('cpg');
    hub.channel('cpg');
    expect(() => a.postMessage({ fn: () => {} })).toThrow();
  });

  it('a reply from inside a handler is delivered too', async () => {
    const hub = createFakeChannels();
    const editor = hub.channel('cpg');
    const reader = hub.channel('cpg');
    const log: string[] = [];
    editor.onmessage = (e) => {
      log.push(`editor got ${String(e.data)}`);
      editor.postMessage('released');
    };
    reader.onmessage = (e) => log.push(`reader got ${String(e.data)}`);
    reader.postMessage('release');
    await hub.flush();
    expect(log).toEqual(['editor got release', 'reader got released']);
  });

  it('works under fake timers, and the factory can be passed around unbound', async () => {
    vi.useFakeTimers();
    const { channel, flush } = createFakeChannels();
    const a = channel('cpg');
    const b = channel('cpg');
    const got: unknown[] = [];
    b.onmessage = (e) => got.push(e.data);
    a.postMessage('ping');
    await flush();
    expect(got).toEqual(['ping']);
  });
});

describe('createFakeWorker', () => {
  it('answers comlink calls, clones arguments and rebuilds errors by name', async () => {
    const seen: unknown[] = [];
    const worker = createFakeWorker({
      echo: async (value: unknown) => {
        seen.push(value);
        return value;
      },
      fail: async () => {
        throw new RangeError('out of range');
      },
    });
    const remote = wrap<{ echo(v: unknown): Promise<unknown>; fail(): Promise<void> }>(worker);
    const sent = { a: [1, 2, 3] };
    const back = await remote.echo(sent);
    expect(back).toEqual(sent);
    expect(seen[0]).not.toBe(sent); // a structured clone crossed, not the object
    const error: unknown = await remote.fail().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('RangeError');
    expect(worker.terminated).toBe(false);
    worker.terminate();
    expect(worker.terminated).toBe(true);
  });

  it('drops messages after terminate, and reports a crash to its error listeners', async () => {
    let calls = 0;
    const worker = createFakeWorker({
      ping: async () => {
        calls++;
      },
    });
    const errors: string[] = [];
    const listener = (event: Event): void => {
      errors.push((event as ErrorEvent).message);
    };
    worker.addEventListener('error', listener);
    worker.crash('boom');
    worker.removeEventListener('error', listener);
    worker.crash('unheard');
    expect(errors).toEqual(['boom']);

    const remote = wrap<{ ping(): Promise<void> }>(worker);
    await remote.ping();
    worker.terminate();
    void remote.ping(); // never answered, like a call into a terminated Worker
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);
  });
});
