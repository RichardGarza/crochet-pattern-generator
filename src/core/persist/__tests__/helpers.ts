// Test helpers for core/persist: fake "tabs" sharing one fake IndexedDB, one fake lock manager and one fake
// channel hub (src/test/fakes.ts), a manual clock for debounces and timeouts, and realistic documents.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { DEFAULT_PREFS } from '../../../state/appStore';
import { createFakeChannels, createFakeLocks, type FakeChannelHub, type FakeLockClient, type FakeLockManager } from '../../../test/fakes';
import type { ProjectDoc } from '../../../types/project';
import { newProjectDoc, type NewProjectKind } from '../../../ui/shell/newProject';
import { yieldMacrotask } from '../../../workers/rpc';
import { createPersistRepository, type PersistRepository, type RepositoryOptions, type Timers } from '../repo';

/** A clock whose timers run only when the test advances it. */
export interface ManualTimers extends Timers {
  /** Runs every timer due within `ms`, in order, letting async work settle after each. */
  advance(ms: number): Promise<void>;
  pending(): number;
  now(): number;
}

export function manualTimers(): ManualTimers {
  let t = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of queue) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        queue.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
    pending: () => queue.size,
    now: () => t,
  };
}

/** Lets fake IndexedDB, fake locks and fake channels deliver what is queued. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await yieldMacrotask();
}

/** Waits (in macrotasks) until `cond()` holds; fails after `rounds`. */
export async function waitFor(cond: () => boolean, rounds = 500): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await yieldMacrotask();
  }
  throw new Error('waitFor: condition never held');
}

export interface World {
  idb: IDBFactory;
  locks: FakeLockManager;
  hub: FakeChannelHub;
  timers: ManualTimers;
  clock: { now: Date };
  /** A new "tab": its own repository on the shared database, locks and channel. */
  tab(o?: Partial<RepositoryOptions> & { name?: string }): Tab;
}

export interface Tab {
  repo: PersistRepository;
  locks: FakeLockClient;
  name: string;
}

export function world(): World {
  const idb = new IDBFactory();
  const locks = createFakeLocks();
  const hub = createFakeChannels();
  const timers = manualTimers();
  const clock = { now: new Date('2026-10-01T12:00:00') };
  let n = 0;
  let ids = 0;
  return {
    idb,
    locks,
    hub,
    timers,
    clock,
    tab(o = {}) {
      const name = o.name ?? `tab-${++n}`;
      const client = locks.client(name);
      const repo = createPersistRepository({
        idb,
        locks: client,
        channel: hub.channel,
        now: () => new Date(clock.now),
        newId: () => `copy-${++ids}`,
        tabId: name,
        timers,
        storage: null,
        ...o,
      });
      return { repo, locks: client, name };
    },
  };
}

export function makeDoc(id = 'p1', kind: NewProjectKind = 'picture', name?: string): ProjectDoc {
  return newProjectDoc(kind, { id, now: new Date('2026-10-01T11:00:00Z'), prefs: DEFAULT_PREFS, ...(name ? { name } : {}) });
}

export const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values);

export async function blobOf(...values: number[]): Promise<Blob> {
  return new Blob([bytes(...values)], { type: 'image/png' });
}
