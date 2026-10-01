// core/persist pure parts: hashing and base64, reference collection, GC selection, snapshot policy,
// migrations (property tests), the local lock manager, and the lock handle.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mulberry32 as createPrng } from '../../kernel/prng';
import { isProjectId } from '../../../state/appStore';
import { createFakeLocks } from '../../../test/fakes';
import { ASSET_GC_MIN_AGE_MS, base64ToBytes, bytesToBase64, collectAssetKeys, isJsonAsset, refFor, selectUnreferenced, sha256Hex, shaOfKey } from '../assets';
import { isValidProjectId, projectFileName } from '../fileFormat';
import { createLocalLocks, holdLock } from '../locks';
import { CURRENT_DOC_VERSION, fieldPaths, migrateDoc, missingFields, MigrationError, type MigrationTable } from '../migrations';
import { KEEP_LAST, revsToKeep, snapshotDue } from '../snapshots';
import { copyName, importedName } from '../repo';
import { makeDoc } from './helpers';

const SHA = 'a'.repeat(64);

describe('hashing and base64', () => {
  it('sha256Hex matches node:crypto on blobs, buffers and views', async () => {
    const rnd = createPrng(7);
    for (const n of [0, 1, 55, 56, 64, 1000, 70_000]) {
      const bytes = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
      const want = createHash('sha256').update(bytes).digest('hex');
      expect(await sha256Hex(bytes)).toBe(want);
      expect(await sha256Hex(new Blob([bytes]))).toBe(want);
    }
  });

  it('base64 round trips any bytes, also large ones, and refuses junk', () => {
    const rnd = createPrng(3);
    for (const n of [0, 1, 2, 3, 4, 100_000]) {
      const bytes = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
    expect(() => base64ToBytes('abc')).toThrow();
    expect(() => base64ToBytes('ab$=')).toThrow();
  });
});

describe('asset references', () => {
  it('shaOfKey and refFor', () => {
    expect(shaOfKey(`p1/${SHA}`)).toBe(SHA);
    expect(shaOfKey(`p/1/${SHA}`)).toBeNull();
    expect(shaOfKey(`p1/${SHA.slice(1)}`)).toBeNull();
    expect(refFor(`p1/${SHA}`, new Blob([new Uint8Array(3)], { type: 'image/png' }))).toEqual({ key: `p1/${SHA}`, mime: 'image/png', bytes: 3, sha256: SHA });
    expect(() => refFor('x', new Blob())).toThrow();
  });

  it('collectAssetKeys finds refs, bare keys and keys in nested arrays, and nothing else', () => {
    const doc = {
      thumbnail: { key: `p1/${SHA}`, mime: 'image/png', bytes: 1, sha256: SHA },
      threeD: { views: [{ imageKey: `copy/${'b'.repeat(64)}` }], meshAssets: { m: { key: `p1/${'c'.repeat(64)}` } } },
      name: 'p1/not-a-hash',
      notes: `p1/${SHA} with text`,
    };
    expect([...collectAssetKeys(doc)].sort()).toEqual([`copy/${'b'.repeat(64)}`, `p1/${SHA}`, `p1/${'c'.repeat(64)}`]);
    const cyclic: Record<string, unknown> = { k: `p1/${SHA}` };
    cyclic.self = cyclic;
    expect([...collectAssetKeys(cyclic)]).toEqual([`p1/${SHA}`]);
  });

  it('isJsonAsset', () => {
    expect(isJsonAsset('application/json')).toBe(true);
    expect(isJsonAsset('application/ld+json')).toBe(true);
    expect(isJsonAsset('image/png')).toBe(false);
  });

  it('selectUnreferenced keeps referenced, young and undated assets', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const old = new Date(now.getTime() - ASSET_GC_MIN_AGE_MS).toISOString();
    const young = new Date(now.getTime() - ASSET_GC_MIN_AGE_MS + 1).toISOString();
    const stored: [string, { createdAt: string }][] = [
      ['a', { createdAt: old }],
      ['b', { createdAt: old }],
      ['c', { createdAt: young }],
      ['d', { createdAt: 'garbage' }],
    ];
    expect(selectUnreferenced(stored, new Set(['b']), now)).toEqual(['a']);
  });
});

describe('project ids and names', () => {
  it('isValidProjectId agrees with appStore.isProjectId', () => {
    const rnd = createPrng(11);
    const alphabet = ['a', 'Z', '0', '-', '/', ' ', '\t', '\u0000', '\u007f', '\u0085', 'é', '\uD83D', '\uDE00', '😀', '%', '#'];
    const samples = ['', 'x'.repeat(200), 'x'.repeat(201), crypto.randomUUID()];
    for (let i = 0; i < 2000; i++) {
      let s = '';
      const n = Math.floor(rnd() * 6);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      samples.push(s);
    }
    for (const s of samples) expect(isValidProjectId(s), JSON.stringify(s)).toBe(isProjectId(s));
  });

  it('copy and import names', () => {
    expect(copyName('Bunny', new Date('2026-10-01T09:07:00'))).toBe('Bunny (copy, 09:07)');
    expect(importedName('Bunny', new Date('2026-01-05T23:59:00'))).toBe('Bunny (imported 2026-01-05)');
  });

  it('projectFileName makes any name safe', () => {
    expect(projectFileName('Heart blanket')).toBe('Heart blanket.crochet.json');
    expect(projectFileName('a/b:c*?"<>|')).toBe('a b c.crochet.json');
    expect(projectFileName('...')).toBe('Crochet project.crochet.json');
    expect(projectFileName('  ')).toBe('Crochet project.crochet.json');
  });
});

describe('snapshot policy', () => {
  const at = (iso: string) => new Date(iso);
  it('snapshotDue: none yet, 20 revs, 5 minutes', () => {
    const now = at('2026-10-01T12:00:00Z');
    expect(snapshotDue(undefined, 1, now)).toBe(true);
    expect(snapshotDue({ rev: 1, at: '2026-10-01T11:56:00Z' }, 20, now)).toBe(false);
    expect(snapshotDue({ rev: 1, at: '2026-10-01T11:56:00Z' }, 21, now)).toBe(true);
    expect(snapshotDue({ rev: 1, at: '2026-10-01T11:55:00Z' }, 2, now)).toBe(true);
    expect(snapshotDue({ rev: 1, at: 'garbage' }, 2, now)).toBe(true);
  });

  it('revsToKeep: the last 30 plus the newest of each day within 30 days; undated ones are kept', () => {
    const now = new Date('2026-10-31T18:00:00');
    const snaps = [];
    let rev = 0;
    for (let day = 0; day < 60; day++) {
      for (const hour of [9, 13, 17]) {
        const d = new Date(now);
        d.setDate(d.getDate() - 59 + day);
        d.setHours(hour, 0, 0, 0);
        snaps.push({ rev: ++rev, at: d.toISOString() });
      }
    }
    snaps.push({ rev: 0, at: 'garbage' });
    const keep = revsToKeep(snaps, now);
    for (let r = rev; r > rev - KEEP_LAST; r--) expect(keep.has(r)).toBe(true);
    expect(keep.has(0)).toBe(true);
    // Each of the last 30 days keeps its 17:00 snapshot; nothing older than 30 days survives.
    const kept = snaps.filter((s) => keep.has(s.rev) && s.rev > 0);
    for (const s of kept) expect(now.getTime() - Date.parse(s.at)).toBeLessThanOrEqual(30 * 24 * 3600_000);
    const daily = kept.filter((s) => s.rev <= rev - KEEP_LAST);
    for (const s of daily) expect(new Date(s.at).getHours()).toBe(17);
    expect(kept.length).toBe(KEEP_LAST + daily.length);
    expect(daily.length).toBe(20);
  });
});

/** A random JSON-like document with nested objects, arrays and odd keys. */
function randomValue(rnd: () => number, depth: number): unknown {
  const r = rnd();
  if (depth <= 0 || r < 0.35) {
    const leaves = [0, -1.5, 1e21, '', 'x', 'p1/' + SHA, true, false, null];
    return leaves[Math.floor(rnd() * leaves.length)];
  }
  if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(rnd, depth - 1));
  const o: Record<string, unknown> = {};
  const keys = ['a', 'b', 'c', 'constructor', 'toString', 'twoD', 'sources', '0', 'é'];
  for (let i = Math.floor(rnd() * 5); i > 0; i--) o[keys[Math.floor(rnd() * keys.length)]] = randomValue(rnd, depth - 1);
  return o;
}

function randomDoc(rnd: () => number): Record<string, unknown> {
  const base = makeDoc('p' + Math.floor(rnd() * 1000), rnd() < 0.5 ? 'picture' : 'photos') as unknown as Record<string, unknown>;
  const extra = randomValue(rnd, 5);
  return { ...base, extra, future: { nested: randomValue(rnd, 4) } };
}

describe('migrations (§5.5.3): pure, and every field is kept', () => {
  it('the current version passes through unchanged (same object, not migrated)', () => {
    const doc = makeDoc('p1');
    const r = migrateDoc(doc);
    expect(r).toEqual({ doc, from: CURRENT_DOC_VERSION, migrated: false });
    expect(r.doc).toBe(doc);
  });

  it('refuses what it cannot migrate', () => {
    expect(() => migrateDoc(null)).toThrow(MigrationError);
    expect(() => migrateDoc({ schema: 'other', version: 1 })).toThrow(/not a Crochet/);
    expect(() => migrateDoc({ ...makeDoc('p1'), version: 0 })).toThrow(/invalid version/);
    expect(() => migrateDoc({ ...makeDoc('p1'), version: 1.5 })).toThrow(/invalid version/);
    expect(() => migrateDoc({ ...makeDoc('p1'), version: CURRENT_DOC_VERSION + 1 })).toThrow(expect.objectContaining({ code: 'newer-version' }));
    expect(() => migrateDoc({ ...makeDoc('p1'), version: 1 }, { target: 3, table: { 1: { up: (d) => ({ ...d, version: 2 }) } } })).toThrow(/No migration from version 2/);
  });

  // A hypothetical future chain: v1 → v2 adds a field, v2 → v3 renames one (declared) and restructures another.
  const chain: MigrationTable = {
    1: { up: (d) => ({ ...d, version: 2, tags: [] }) },
    2: {
      up: (d) => {
        const { hand, ...rest } = d;
        return { ...rest, version: 3, handedness: hand, gauge: { ...(d.gauge as object), schemaNote: 'v3' } };
      },
      drops: ['hand'],
    },
  };

  it('property: a chain of migrations keeps every leaf field of 500 random documents (renames declared)', () => {
    const rnd = createPrng(2026);
    for (let i = 0; i < 500; i++) {
      const doc = randomDoc(rnd);
      const before = structuredClone(doc);
      const r = migrateDoc(doc, { table: chain, target: 3 });
      expect(doc).toEqual(before); // pure: the input is untouched
      expect(r.migrated).toBe(true);
      expect(r.from).toBe(1);
      const out = r.doc as unknown as Record<string, unknown>;
      expect(out.version).toBe(3);
      expect(missingFields(before, out, ['hand'])).toEqual([]);
      expect(out.handedness).toBe(before.hand);
      // Unknown fields come through deeply equal.
      expect(out.extra).toEqual(before.extra);
      expect(out.future).toEqual(before.future);
      // Deterministic.
      expect(migrateDoc(before, { table: chain, target: 3 }).doc).toEqual(out);
    }
  }, 60_000);

  it('the runner refuses a step that silently loses a field', () => {
    const lossy: MigrationTable = {
      1: {
        up: (d) => {
          const { sources: _dropped, ...rest } = d;
          return { ...rest, version: 2 };
        },
      },
    };
    expect(() => migrateDoc(makeDoc('p1'), { table: lossy, target: 2 })).toThrow(expect.objectContaining({ code: 'lost-fields' }));
    const deep: MigrationTable = { 1: { up: (d) => ({ ...d, version: 2, gauge: {} }) } };
    expect(() => migrateDoc(makeDoc('p1'), { table: deep, target: 2 })).toThrow(/lost gauge\./);
  });

  it('fieldPaths and missingFields', () => {
    expect(fieldPaths({ a: { b: [1, { c: 2 }] }, d: {}, e: [] })).toEqual(['a.b.0', 'a.b.1.c', 'd', 'e']);
    expect(missingFields({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toEqual(['a.c']);
    expect(missingFields({ a: [{ x: 1 }, { x: 2 }] }, { a: [{}, {}] }, ['a.*.x'])).toEqual([]);
  });
});

describe('locks', () => {
  it('holdLock: granted, released, reports a steal', async () => {
    const locks = createFakeLocks();
    const a = await holdLock(locks.client('a'), 'project:x');
    expect(a?.held()).toBe(true);
    expect(await holdLock(locks.client('b'), 'project:x', { ifAvailable: true })).toBeNull();
    const b = await holdLock(locks.client('b'), 'project:x', { steal: true });
    expect(await a?.ended).toBe('stolen');
    expect(a?.held()).toBe(false);
    b?.release();
    expect(await b?.ended).toBe('released');
    await locks.flush();
    expect(locks.isHeld('project:x')).toBe(false);
  });

  it('holdLock: a request the manager refuses rejects', async () => {
    await expect(holdLock(createFakeLocks(), '-bad')).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('createLocalLocks: exclusive, FIFO, ifAvailable and steal within one tab', async () => {
    const locks = createLocalLocks();
    const order: string[] = [];
    const first = await holdLock(locks, 'n');
    expect(await holdLock(locks, 'n', { ifAvailable: true })).toBeNull();
    const second = holdLock(locks, 'n').then((l) => (order.push('second'), l));
    const third = holdLock(locks, 'n').then((l) => (order.push('third'), l));
    first?.release();
    const s = await second;
    s?.release();
    const t = await third;
    expect(order).toEqual(['second', 'third']);
    const thief = await holdLock(locks, 'n', { steal: true });
    expect(await t?.ended).toBe('stolen');
    thief?.release();
    expect(await thief?.ended).toBe('released');
    expect(await holdLock(locks, 'n', { ifAvailable: true })).not.toBeNull();
  });
});
