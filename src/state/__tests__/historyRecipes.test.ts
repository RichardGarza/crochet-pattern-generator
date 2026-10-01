// History under hostile recipes. The recipe list comes from the independent review of Step 0b: it showed that
// immer 11.1's own patches are wrong for some of these (a draft modified and then replaced by its original(),
// and edits on a document that holds one object twice), so that REDO produced a document the user never had.
// history.ts therefore derives its patches from the two documents; these tests hold it to that:
//   - whatever a recipe does, `patches` turn the document before into the document after, `inverse` back;
//   - undo and redo are exact over long random walks with coalescing, also across the aliasing recipes;
//   - where plain JavaScript semantics are defined (no aliasing, no immer helpers), the document a recipe
//     produces is the one the same mutations give on a plain copy.
import { isDeepStrictEqual } from 'node:util';
import { current, original } from 'immer';
import { describe, expect, it } from 'vitest';
import { mulberry32, randomInt, type Rng } from '../../core/kernel/prng';
import { applyPatches, applyRecipe, emptyHistory, record, redo, seal, undo, type History } from '../history';

interface Item {
  id: number;
  tags: string[];
  pos?: [number, number, number];
  meta?: { a: number; deep?: { z: number } };
}
interface Doc {
  name: string;
  n: number;
  list: Item[];
  list2: Item[];
  map: Record<string, { v: number; deep: { w: number[] } }>;
  nested: { a: { b: { c: number } }; arr: number[] };
  opt?: string;
}

const initial = (): Doc => ({
  name: 'start',
  n: 0,
  list: [
    { id: 1, tags: ['a'], meta: { a: 1, deep: { z: 1 } } },
    { id: 2, tags: [], pos: [0, 0, 0] },
    { id: 3, tags: ['x', 'y'], meta: { a: 3 } },
    { id: 4, tags: [] },
  ],
  list2: [{ id: 10, tags: ['q'] }],
  map: { k0: { v: 0, deep: { w: [1, 2, 3] } }, k1: { v: 1, deep: { w: [] } } },
  nested: { a: { b: { c: 1 } }, arr: [1, 2, 3] },
});

interface Edit {
  name: string;
  /**
   * 'plain': the recipe uses nothing of immer and creates no aliasing, so it means the same on a plain object.
   * 'immer': it uses current() / original(). 'alias': it puts one object into the document twice.
   */
  kind: 'plain' | 'immer' | 'alias';
  run: (d: Doc, rng: Rng, fresh: () => number) => void;
}

const any = <T>(rng: Rng, items: readonly T[]): T => items[randomInt(rng, items.length)];

const EDITS: Edit[] = [
  { name: 'set-name', kind: 'plain', run: (d, _r, f) => void (d.name = `n${f()}`) },
  { name: 'push', kind: 'plain', run: (d, _r, f) => void d.list.push({ id: f(), tags: [`t${f()}`] }) },
  {
    name: 'move-unmodified-to-list2',
    kind: 'plain',
    run: (d) => {
      const it = d.list.shift();
      if (it) d.list2.push(it);
    },
  },
  {
    name: 'modify-then-move',
    kind: 'plain',
    run: (d, _r, f) => {
      if (d.list.length === 0) return;
      const it = d.list[0];
      it.tags.push(`m${f()}`);
      d.list.shift();
      d.list2.unshift(it);
    },
  },
  {
    name: 'move-then-modify',
    kind: 'plain',
    run: (d, _r, f) => {
      const it = d.list2.pop();
      if (!it) return;
      d.list.push(it);
      d.list[d.list.length - 1].id = f();
      it.tags.push('late');
    },
  },
  {
    name: 'swap',
    kind: 'plain',
    run: (d, rng) => {
      if (d.list.length < 2) return;
      const i = randomInt(rng, d.list.length);
      const j = randomInt(rng, d.list.length);
      [d.list[i], d.list[j]] = [d.list[j], d.list[i]];
    },
  },
  {
    name: 'swap-and-modify-one',
    kind: 'plain',
    run: (d, rng, f) => {
      if (d.list.length < 2) return;
      const i = randomInt(rng, d.list.length);
      const j = (i + 1) % d.list.length;
      const a = d.list[i];
      a.id = f();
      [d.list[i], d.list[j]] = [d.list[j], d.list[i]];
    },
  },
  { name: 'sort-desc', kind: 'plain', run: (d) => void d.list.sort((a, b) => b.id - a.id) },
  { name: 'sort-asc', kind: 'plain', run: (d) => void d.list.sort((a, b) => a.id - b.id) },
  { name: 'reverse', kind: 'plain', run: (d) => void d.list.reverse() },
  {
    name: 'alias-item-in-two-lists',
    kind: 'alias',
    run: (d) => {
      if (d.list.length > 0) d.list2.push(d.list[0]);
    },
  },
  {
    name: 'alias-then-modify-through-one',
    kind: 'alias',
    run: (d, _r, f) => {
      if (d.list.length === 0) return;
      d.list2.push(d.list[0]);
      d.list2[d.list2.length - 1].id = f();
    },
  },
  {
    name: 'duplicate-item-in-place',
    kind: 'alias',
    run: (d, rng) => {
      if (d.list.length === 0) return;
      const i = randomInt(rng, d.list.length);
      d.list.splice(i, 0, d.list[i]); // "duplicate point": the same object now sits at i and i + 1
    },
  },
  {
    name: 'edit-descendant-then-spread-ancestor',
    kind: 'plain',
    run: (d, _r, f) => {
      d.nested.a.b.c = f();
      d.nested = { ...d.nested, arr: [f()] };
    },
  },
  {
    name: 'spread-ancestor-then-edit-descendant-via-old-draft',
    kind: 'plain',
    run: (d, _r, f) => {
      const old = d.nested;
      d.nested = { ...old };
      old.a.b.c = f();
    },
  },
  {
    name: 'new-object-with-modified-draft-inside',
    kind: 'plain',
    run: (d, _r, f) => {
      d.nested.a.b.c = f();
      d.nested = { a: d.nested.a, arr: d.nested.arr };
    },
  },
  {
    name: 'delete-then-readd-same-draft',
    kind: 'plain',
    run: (d, rng) => {
      const keys = Object.keys(d.map);
      if (keys.length === 0) return;
      const k = any(rng, keys);
      const v = d.map[k];
      delete d.map[k];
      d.map[k] = v;
    },
  },
  {
    name: 'rename-key',
    kind: 'plain',
    run: (d, rng, f) => {
      const keys = Object.keys(d.map);
      if (keys.length === 0) return;
      const k = any(rng, keys);
      const v = d.map[k];
      delete d.map[k];
      d.map[`k${f()}`] = v;
    },
  },
  {
    name: 'rename-key-modified',
    kind: 'plain',
    run: (d, rng, f) => {
      const keys = Object.keys(d.map);
      if (keys.length === 0) return;
      const k = any(rng, keys);
      const v = d.map[k];
      v.deep.w.push(f());
      delete d.map[k];
      d.map[`k${f()}`] = v;
      v.v = f();
    },
  },
  { name: 'add-map', kind: 'plain', run: (d, _r, f) => void (d.map[`k${f()}`] = { v: f(), deep: { w: [f()] } }) },
  { name: 'opt-undefined', kind: 'plain', run: (d) => void (d.opt = undefined) },
  {
    name: 'opt-toggle',
    kind: 'plain',
    run: (d, _r, f) => {
      if ('opt' in d) delete d.opt;
      else d.opt = `o${f()}`;
    },
  },
  {
    name: 'assign-same-ref',
    kind: 'plain',
    run: (d) => {
      const { nested, list } = d;
      d.nested = nested;
      if (list.length > 0) list[0] = d.list[0];
    },
  },
  { name: 'object-assign', kind: 'plain', run: (d, _r, f) => void Object.assign(d.nested, { arr: [f(), f()] }) },
  { name: 'object-assign-root', kind: 'plain', run: (d, _r, f) => void Object.assign(d, { n: f(), name: `oa${f()}` }) },
  { name: 'truncate', kind: 'plain', run: (d) => void (d.list.length = Math.max(0, d.list.length - 2)) },
  { name: 'truncate-arr', kind: 'plain', run: (d) => void (d.nested.arr.length = 0) },
  {
    name: 'modify-late-then-splice-early',
    kind: 'plain',
    run: (d, _r, f) => {
      if (d.list.length < 3) return;
      d.list[2].tags.push(`s${f()}`);
      d.list.splice(0, 1);
    },
  },
  {
    name: 'modify-then-unshift',
    kind: 'plain',
    run: (d, _r, f) => {
      if (d.list.length === 0) return;
      d.list[0].id = f();
      d.list.unshift({ id: f(), tags: [] });
    },
  },
  {
    name: 'modify-then-sort',
    kind: 'plain',
    run: (d, rng, f) => {
      if (d.list.length === 0) return;
      any(rng, d.list).id = f() % 7;
      d.list.sort((a, b) => a.id - b.id);
    },
  },
  {
    name: 'filter-reassign',
    kind: 'plain',
    run: (d) => {
      d.list = d.list.filter((x) => x.id % 2 === 1);
    },
  },
  {
    name: 'modify-then-filter-reassign',
    kind: 'plain',
    run: (d, _r, f) => {
      for (const it of d.list) it.tags.push(`f${f()}`);
      d.list = d.list.filter((x) => x.id % 3 !== 0);
    },
  },
  {
    name: 'map-reassign-with-draft-children',
    kind: 'plain',
    run: (d) => {
      d.list = d.list.map((x) => ({ ...x, tags: x.tags }));
    },
  },
  {
    name: 'map-reassign-then-modify-old-child',
    kind: 'plain',
    run: (d, _r, f) => {
      const olds = [...d.list];
      d.list = d.list.map((x) => ({ ...x }));
      if (olds.length > 0) olds[0].tags.push(`late${f()}`);
    },
  },
  {
    name: 'new-object-two-refs-to-same-draft',
    kind: 'alias',
    run: (d, _r, f) => {
      const deep = d.map.k0?.deep;
      if (!deep) return;
      deep.w.push(f());
      d.map[`k${f()}`] = { v: 1, deep };
      d.map[`k${f()}`] = { v: 2, deep };
    },
  },
  {
    name: 'move-all',
    kind: 'plain',
    run: (d) => {
      d.list.push(...d.list2.splice(0));
    },
  },
  {
    name: 'clone-replace',
    kind: 'immer',
    run: (d) => {
      d.nested = structuredClone(current(d.nested));
    },
  },
  {
    name: 'modify-then-restore-original',
    kind: 'immer',
    run: (d, _r, f) => {
      if (d.list.length === 0) return;
      const it = d.list[0];
      it.id = f();
      d.list[0] = original(it) as Item;
    },
  },
  {
    name: 'modify-nested-then-restore-original-object-key',
    kind: 'immer',
    run: (d, _r, f) => {
      const a = d.nested.a;
      a.b.c = f();
      d.nested.a = original(a) as Doc['nested']['a'];
    },
  },
  {
    name: 'replace-branch-with-pure-fn-of-draft',
    kind: 'plain',
    run: (d, _r, f) => {
      // like `d.threeD.model = scaleModel(d.threeD.model, 2).model`
      const scale = (m: Doc['nested']): Doc['nested'] => ({ ...m, arr: m.arr.map((v) => v * 2), a: { ...m.a, b: { c: m.a.b.c + f() } } });
      d.nested = scale(d.nested);
    },
  },
  {
    name: 'nested-meta-edit-then-move-item-to-front',
    kind: 'plain',
    run: (d, _r, f) => {
      const i = d.list.findIndex((x) => x.meta);
      if (i < 0) return;
      const it = d.list[i];
      if (it.meta) {
        it.meta.a = f();
        if (it.meta.deep) it.meta.deep.z = f();
      }
      d.list.splice(i, 1);
      d.list.unshift(it);
    },
  },
  {
    name: 'move-item-then-edit-its-nested',
    kind: 'plain',
    run: (d, _r, f) => {
      const i = d.list.findIndex((x) => x.meta?.deep);
      if (i < 0) return;
      const it = d.list[i];
      d.list.splice(i, 1);
      d.list2.push(it);
      if (it.meta?.deep) it.meta.deep.z = f();
    },
  },
  {
    name: 'copy-subtree-current',
    kind: 'immer', // current() of an unmodified draft IS the base object: this one aliases as well
    run: (d) => {
      if (d.list.length > 0) d.list2.push(current(d.list[0]));
    },
  },
  {
    name: 'pop-push-same',
    kind: 'plain',
    run: (d) => {
      const it = d.list.pop();
      if (it) d.list.push(it);
    },
  },
  {
    name: 'splice-insert-middle',
    kind: 'plain',
    run: (d, rng, f) => {
      d.list.splice(randomInt(rng, d.list.length + 1), 0, { id: f(), tags: [], pos: [f(), 0, 0] });
    },
  },
  {
    name: 'splice-remove-middle',
    kind: 'plain',
    run: (d, rng) => {
      if (d.list.length > 0) d.list.splice(randomInt(rng, d.list.length), 1);
    },
  },
  {
    name: 'replace-list-item-by-spread',
    kind: 'plain',
    run: (d, rng, f) => {
      if (d.list.length === 0) return;
      const i = randomInt(rng, d.list.length);
      d.list[i] = { ...d.list[i], id: f() };
    },
  },
  {
    name: 'edit-child-then-replace-item-by-spread',
    kind: 'plain',
    run: (d, rng, f) => {
      if (d.list.length === 0) return;
      const i = randomInt(rng, d.list.length);
      d.list[i].tags.push(`e${f()}`);
      d.list[i] = { ...d.list[i], id: f() };
    },
  },
  {
    name: 'replace-item-by-spread-then-edit-old-child',
    kind: 'plain',
    run: (d, rng, f) => {
      if (d.list.length === 0) return;
      const i = randomInt(rng, d.list.length);
      const old = d.list[i];
      d.list[i] = { ...old, id: f() };
      old.tags.push(`late${f()}`);
    },
  },
];

function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

/** The documents of a store are deeply frozen (projectStore.open freezes what it is given). */
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

/** What is wrong with the change a recipe made, or null. */
function problemOf(base: Doc, edit: (d: Doc) => void): { problem: string | null; doc: Doc } {
  const change = applyRecipe(base, edit);
  try {
    JSON.stringify(change.doc); // walks everything: a revoked draft left inside would throw
  } catch (e) {
    return { problem: `the result holds a revoked draft: ${(e as Error).message}`, doc: base };
  }
  if (!deeplyFrozen(change.doc)) return { problem: 'the result is not deeply frozen', doc: change.doc };
  if (change.patches.length === 0 && change.doc !== base) return { problem: 'no patches, but another document', doc: change.doc };
  if ((change.patches.length === 0) !== isDeepStrictEqual(change.doc, base)) return { problem: 'patches and document disagree on whether anything changed', doc: change.doc };
  let redone: Doc;
  let undone: Doc;
  try {
    redone = applyPatches(base, change.patches);
    undone = applyPatches(change.doc, change.inverse);
  } catch (e) {
    return { problem: `the patches do not apply: ${(e as Error).message}`, doc: change.doc };
  }
  if (!isDeepStrictEqual(redone, change.doc)) return { problem: 'applying the patches to the document before does NOT give the edited document', doc: change.doc };
  if (!isDeepStrictEqual(undone, base)) return { problem: 'applying the inverse does NOT restore the document before', doc: change.doc };
  if (!deeplyFrozen(redone) || !deeplyFrozen(undone)) return { problem: 'a patched document is not deeply frozen', doc: change.doc };
  return { problem: null, doc: change.doc };
}

describe('patches of a recipe', () => {
  it('turn the document before into the document after, and back — every hostile recipe alone', () => {
    const problems: string[] = [];
    for (const edit of EDITS) {
      for (let seed = 1; seed <= 5; seed++) {
        const rng = mulberry32(seed);
        let counter = 1000;
        const { problem } = problemOf(frozen(initial()), (d) => edit.run(d, rng, () => ++counter));
        if (problem) {
          problems.push(`${edit.name}: ${problem}`);
          break;
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('… and in random sequences, where earlier recipes leave shared objects behind (seeded)', () => {
    const problems = new Map<string, string>();
    let steps = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed * 7919);
      let counter = 1000;
      const fresh = (): number => ++counter;
      let doc = frozen(initial());
      for (let step = 0; step < 80; step++) {
        const edit = any(rng, EDITS);
        steps++;
        const { problem, doc: next } = problemOf(doc, (d) => edit.run(d, rng, fresh));
        if (problem && !problems.has(edit.name)) problems.set(edit.name, `${edit.name}: ${problem} (seed ${seed} step ${step})`);
        doc = next;
      }
    }
    expect([...problems.values()]).toEqual([]);
    expect(steps).toBe(32_000);
  });

  it('record nothing for a recipe that ends where it started', () => {
    const base = frozen(initial());
    const restore = applyRecipe(base, (d) => {
      const it = d.list[0];
      it.id = 99;
      d.list[0] = original(it) as Item;
    });
    expect(restore.patches).toEqual([]);
    expect(restore.doc).toBe(base);
    const equalCopy = applyRecipe(base, (d) => {
      d.nested = structuredClone(current(d.nested));
      d.list = d.list.map((x) => ({ ...x }));
    });
    expect(equalCopy.patches).toEqual([]);
    expect(equalCopy.doc).toBe(base); // an equal copy is no change: the document keeps its identity
  });
});

/** True when some object is reachable twice in the document. */
function holdsAnObjectTwice(doc: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return Object.values(value).some(visit);
  };
  return visit(doc);
}

describe('the document a recipe produces', () => {
  it('is the one plain JavaScript gives on a copy without shared objects — also when the document holds one object twice (seeded)', () => {
    // A document that holds one object in two places behaves as if it held two equal objects: an edit through
    // one place leaves the other alone. (Saving and loading separates them anyway.)
    const edits = EDITS.filter((e) => e.kind !== 'immer');
    expect(edits.filter((e) => e.kind === 'alias').length).toBeGreaterThanOrEqual(4);
    const problems = new Map<string, string>();
    let stepsOnSharedObjects = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed * 104729);
      let counter = 1000;
      const fresh = (): number => ++counter;
      let doc = frozen(initial());
      for (let step = 0; step < 60; step++) {
        const edit = any(rng, edits);
        if (holdsAnObjectTwice(doc)) stepsOnSharedObjects++;
        // the same recipe, with the same random choices, on a plain mutable copy that shares nothing
        const plain = JSON.parse(JSON.stringify(doc)) as Doc;
        if ('opt' in doc && doc.opt === undefined) plain.opt = undefined; // JSON drops a key that holds undefined
        const choices = Math.floor(rng() * 2 ** 31);
        const counterBefore = counter;
        edit.run(plain, mulberry32(choices), fresh);
        counter = counterBefore;
        const { doc: next } = applyRecipe(doc, (d) => edit.run(d, mulberry32(choices), fresh));
        if (!isDeepStrictEqual(next, plain) && !problems.has(edit.name)) {
          problems.set(edit.name, `${edit.name}: the document differs from the plain one (seed ${seed} step ${step})\n  immer=${JSON.stringify(next)}\n  plain=${JSON.stringify(plain)}`);
        }
        doc = next;
      }
    }
    expect([...problems.values()]).toEqual([]);
    expect(stepsOnSharedObjects).toBeGreaterThan(1000);
  });
});

// ---- undo / redo walks

interface Failure {
  kind: 'undo' | 'redo' | 'collapse' | 'bookkeeping' | 'throw';
  text: string;
}

function walk(seed: number, edits: readonly Edit[], steps: number, limit: number): Failure | null {
  const rng: Rng = mulberry32(seed * 2654435761);
  let counter = 1000;
  const fresh = (): number => ++counter;
  let doc = frozen(initial());
  let history: History = emptyHistory();
  // before[i] = the document before past[i]; after[i] = the document after future[i] is redone
  let before: Doc[] = [];
  let after: Doc[] = [];
  const log: string[] = [];
  const lastId = (): number | undefined => history.past[history.past.length - 1]?.id;

  for (let step = 0; step < steps; step++) {
    const roll = rng();
    try {
      if (roll < 0.66) {
        const edit = edits[randomInt(rng, edits.length)];
        const key = rng() < 0.6 ? `key${randomInt(rng, 2)}` : undefined;
        log.push(`${edit.name}${key ? `@${key}` : ''}`);
        const docBefore = doc;
        const change = applyRecipe(doc, (d) => edit.run(d, rng, fresh));
        if (change.patches.length === 0) continue;
        const idBefore = lastId();
        const lengthBefore = history.past.length;
        const wasOpen = history.open;
        doc = change.doc;
        history = record(history, doc, { label: edit.name, coalesceKey: key, patches: change.patches, inverse: change.inverse }, limit);
        after = [];
        if (history.past.length === lengthBefore - 1) {
          // the run collapsed: it must be back where it started
          const start = before.pop() as Doc;
          if (!isDeepStrictEqual(doc, start)) return { kind: 'collapse', text: `seed ${seed} step ${step}: a run's entry was dropped although the document is not where the run started; ${log.slice(-6).join(' | ')}` };
        } else if (lastId() === idBefore && wasOpen && history.past.length === lengthBefore) {
          // merged into the open entry: its "before" stays
        } else {
          before.push(docBefore);
          if (before.length > limit) before = before.slice(before.length - limit);
        }
      } else if (roll < 0.83) {
        log.push('undo');
        const undone = undo(history, doc);
        if (!undone) {
          if (before.length !== 0) return { kind: 'undo', text: `seed ${seed} step ${step}: undo refused with ${before.length} steps` };
          continue;
        }
        const expected = before.pop() as Doc;
        after.push(doc);
        doc = undone.doc;
        history = undone.history;
        if (!isDeepStrictEqual(doc, expected)) return { kind: 'undo', text: `seed ${seed} step ${step}: undo did not restore the document before the step; ${log.slice(-8).join(' | ')}` };
      } else if (roll < 0.95) {
        log.push('redo');
        const redone = redo(history, doc);
        if (!redone) {
          if (after.length !== 0) return { kind: 'redo', text: `seed ${seed} step ${step}: redo refused with ${after.length} steps` };
          continue;
        }
        const expected = after.pop() as Doc;
        before.push(doc);
        doc = redone.doc;
        history = redone.history;
        if (!isDeepStrictEqual(doc, expected)) return { kind: 'redo', text: `seed ${seed} step ${step}: redo did not restore the edited document; ${log.slice(-8).join(' | ')}` };
      } else {
        log.push('seal');
        history = seal(history);
      }
    } catch (e) {
      return { kind: 'throw', text: `seed ${seed} step ${step}: threw ${(e as Error).message}; ${log.slice(-8).join(' | ')}` };
    }
    if (history.past.length !== before.length) return { kind: 'bookkeeping', text: `seed ${seed} step ${step}: ${history.past.length} entries, ${before.length} expected; ${log.slice(-6).join(' | ')}` };
    if (history.past.length > limit) return { kind: 'bookkeeping', text: `seed ${seed} step ${step}: more than ${limit} entries` };
  }
  for (;;) {
    const undone = undo(history, doc);
    if (!undone) break;
    const expected = before.pop() as Doc;
    doc = undone.doc;
    history = undone.history;
    if (!isDeepStrictEqual(doc, expected)) return { kind: 'undo', text: `seed ${seed}, unwinding at the end: undo did not restore the document` };
  }
  return before.length === 0 ? null : { kind: 'bookkeeping', text: `seed ${seed}: ${before.length} steps left after unwinding` };
}

describe('undo and redo under hostile recipes (seeded walks with coalescing, sealing and the cap)', () => {
  it('are exact for the recipes that create no shared objects', () => {
    const edits = EDITS.filter((e) => e.kind === 'plain');
    const failures: string[] = [];
    for (let seed = 1; seed <= 300 && failures.length < 3; seed++) {
      const failure = walk(seed, edits, 150, seed % 3 === 0 ? 12 : 200);
      if (failure) failures.push(`[${failure.kind}] ${failure.text}`);
    }
    expect(failures).toEqual([]);
  });

  it('are exact for all of them: aliasing, original(), current()', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 400 && failures.length < 3; seed++) {
      const failure = walk(seed, EDITS, 150, seed % 4 === 0 ? 12 : 200);
      if (failure) failures.push(`[${failure.kind}] ${failure.text}`);
    }
    expect(failures).toEqual([]);
  });
});
