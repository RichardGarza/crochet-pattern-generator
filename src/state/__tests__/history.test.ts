import { isDeepStrictEqual } from 'node:util';
import type { Patch } from 'immer';
import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../test/timing';
import { mulberry32, randomInt, type Rng } from '../../core/kernel/prng';
import {
  applyPatches,
  applyRecipe,
  canRedo,
  canUndo,
  diffDocuments,
  emptyHistory,
  HISTORY_LIMIT,
  record,
  redo,
  redoLabel,
  seal,
  undo,
  undoLabel,
  type History,
} from '../history';

interface Item {
  id: number;
  tags: string[];
  pos?: [number, number, number];
}
interface Doc {
  name: string;
  n: number;
  list: Item[];
  map: Record<string, { v: number; deep: { w: number[] } }>;
  nested: { a: { b: { c: number } }; arr: number[] };
  opt?: string;
}

const initial = (): Doc => ({
  name: 'start',
  n: 0,
  list: [
    { id: 1, tags: ['a'] },
    { id: 2, tags: [], pos: [0, 0, 0] },
  ],
  map: { k0: { v: 0, deep: { w: [1, 2, 3] } } },
  nested: { a: { b: { c: 1 } }, arr: [1, 2, 3] },
});

const clone = <T>(v: T): T => structuredClone(v);

/** A document with its history: the pair the store keeps. */
class Session {
  doc: Doc = initial();
  history: History = emptyHistory();
  limit = HISTORY_LIMIT;

  update(label: string, recipe: (d: Doc) => unknown, coalesceKey?: string): boolean {
    const change = applyRecipe(this.doc, recipe);
    this.doc = change.doc;
    const before = this.history;
    this.history = record(this.history, this.doc, { label, coalesceKey, patches: change.patches, inverse: change.inverse }, this.limit);
    return this.history !== before;
  }
  undo(): boolean {
    const step = undo(this.history, this.doc);
    if (!step) return false;
    this.doc = step.doc;
    this.history = step.history;
    return true;
  }
  redo(): boolean {
    const step = redo(this.history, this.doc);
    if (!step) return false;
    this.doc = step.doc;
    this.history = step.history;
    return true;
  }
  seal(): void {
    this.history = seal(this.history);
  }
  get labels(): string[] {
    return this.history.past.map((e) => e.label);
  }
}

describe('applyRecipe', () => {
  it('returns a new frozen document, leaves the old one alone and shares what did not change', () => {
    const doc = initial();
    const { doc: next, patches, inverse } = applyRecipe(doc, (d) => {
      d.nested.a.b.c = 5;
    });
    expect(next.nested.a.b.c).toBe(5);
    expect(doc.nested.a.b.c).toBe(1);
    expect(next.list).toBe(doc.list);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.nested.a.b)).toBe(true);
    expect(patches).toEqual([{ op: 'replace', path: ['nested', 'a', 'b', 'c'], value: 5 }]);
    expect(inverse).toEqual([{ op: 'replace', path: ['nested', 'a', 'b', 'c'], value: 1 }]);
  });

  it('ignores what the recipe returns, so one-line recipes work', () => {
    const doc = initial();
    expect(applyRecipe(doc, (d) => d.list.push({ id: 3, tags: [] })).doc.list).toHaveLength(3);
    expect(applyRecipe(doc, (d) => (d.name = 'renamed')).doc.name).toBe('renamed');
    expect(applyRecipe(doc, (d) => delete d.opt).doc).toEqual(doc);
  });

  it('gives no patches, and the same document, when nothing changed', () => {
    const doc = applyRecipe(initial(), () => {}).doc; // a frozen document
    const same = applyRecipe(doc, (d) => {
      d.n = 0; // the value it already has
      d.name = 'start';
    });
    expect(same.patches).toEqual([]);
    expect(same.doc).toBe(doc);
  });

  it('refuses an async recipe and changes nothing', async () => {
    const doc = initial();
    const recipe = async (d: Doc): Promise<void> => {
      d.n = 1;
      await Promise.resolve();
      d.n = 2;
    };
    expect(() => applyRecipe(doc, recipe)).toThrow(TypeError);
    expect(() => applyRecipe(doc, recipe)).toThrow('synchronous');
    expect(doc.n).toBe(0);
    await new Promise((r) => setTimeout(r, 5)); // the abandoned async bodies must not surface as unhandled rejections
  });

  it('changes nothing when the recipe throws', () => {
    const doc = initial();
    expect(() =>
      applyRecipe(doc, (d) => {
        d.n = 99;
        throw new Error('half way');
      }),
    ).toThrow('half way');
    expect(doc.n).toBe(0);
  });
});

describe('record, undo, redo', () => {
  it('records labelled steps and walks back and forth through them exactly', () => {
    const s = new Session();
    const states = [clone(s.doc)];
    s.update('Rename', (d) => (d.name = 'bunny'));
    states.push(clone(s.doc));
    s.update('Add item', (d) => d.list.push({ id: 3, tags: ['x', 'y'], pos: [1, 2, 3] }));
    states.push(clone(s.doc));
    s.update('Remove first item', (d) => d.list.splice(0, 1));
    states.push(clone(s.doc));
    s.update('Set optional', (d) => (d.opt = 'here'));
    states.push(clone(s.doc));
    s.update('Drop key', (d) => delete d.map.k0);
    states.push(clone(s.doc));

    expect(s.labels).toEqual(['Rename', 'Add item', 'Remove first item', 'Set optional', 'Drop key']);
    expect(s.history.past.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(undoLabel(s.history)).toBe('Drop key');
    expect(canRedo(s.history)).toBe(false);

    for (let i = states.length - 2; i >= 0; i--) {
      expect(s.undo()).toBe(true);
      expect(s.doc).toStrictEqual(states[i]);
    }
    expect(canUndo(s.history)).toBe(false);
    expect(s.undo()).toBe(false);
    expect(redoLabel(s.history)).toBe('Rename');
    for (let i = 1; i < states.length; i++) {
      expect(s.redo()).toBe(true);
      expect(s.doc).toStrictEqual(states[i]);
    }
    expect(s.redo()).toBe(false);
    expect(s.labels).toEqual(['Rename', 'Add item', 'Remove first item', 'Set optional', 'Drop key']);
    expect(s.history.past.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a new change clears the redo stack; a change that changes nothing does not', () => {
    const s = new Session();
    s.update('one', (d) => (d.n = 1));
    s.update('two', (d) => (d.n = 2));
    s.undo();
    expect(redoLabel(s.history)).toBe('two');
    expect(s.update('nothing', (d) => (d.n = 1))).toBe(false); // already 1
    expect(redoLabel(s.history)).toBe('two');
    expect(s.labels).toEqual(['one']);
    expect(s.update('three', (d) => (d.n = 3))).toBe(true);
    expect(canRedo(s.history)).toBe(false);
    expect(s.labels).toEqual(['one', 'three']);
    expect(s.history.past.map((e) => e.id)).toEqual([1, 3]); // ids are never reused
  });

  it('restores a key that was set to undefined, and one that was deleted, exactly', () => {
    const s = new Session();
    s.update('define', (d) => (d.opt = 'x'));
    const withOpt = clone(s.doc);
    s.update('to undefined', (d) => (d.opt = undefined));
    expect('opt' in s.doc).toBe(true);
    s.update('delete', (d) => delete d.opt);
    expect('opt' in s.doc).toBe(false);
    s.undo();
    expect('opt' in s.doc).toBe(true);
    expect(s.doc.opt).toBeUndefined();
    s.undo();
    expect(s.doc).toStrictEqual(withOpt);
    s.undo();
    expect('opt' in s.doc).toBe(false);
  });
});

describe('coalescing', () => {
  it('a drag with one coalesce key is ONE entry, however many updates it had', () => {
    const s = new Session();
    s.update('Select', (d) => (d.n = 1));
    const beforeDrag = clone(s.doc);
    for (let i = 1; i <= 500; i++) {
      s.update('Move item', (d) => (d.list[1].pos = [i, i * 2, i * 3]), 'drag:item-2');
    }
    expect(s.labels).toEqual(['Select', 'Move item']);
    const entry = s.history.past[1];
    expect(entry.coalesceKey).toBe('drag:item-2');
    // the entry is as small as a single move: from where the drag started to where it ended
    expect(entry.patches).toEqual([
      { op: 'replace', path: ['list', 1, 'pos', 0], value: 500 },
      { op: 'replace', path: ['list', 1, 'pos', 1], value: 1000 },
      { op: 'replace', path: ['list', 1, 'pos', 2], value: 1500 },
    ]);
    expect(entry.inverse).toEqual([
      { op: 'replace', path: ['list', 1, 'pos', 2], value: 0 },
      { op: 'replace', path: ['list', 1, 'pos', 1], value: 0 },
      { op: 'replace', path: ['list', 1, 'pos', 0], value: 0 },
    ]);
    const afterDrag = clone(s.doc);

    s.undo();
    expect(s.doc).toStrictEqual(beforeDrag); // one undo takes back the whole drag
    s.redo();
    expect(s.doc).toStrictEqual(afterDrag);
  });

  it('stays compact when the run touches several paths and grows arrays', () => {
    const s = new Session();
    const before = clone(s.doc);
    for (let i = 0; i < 100; i++) {
      s.update(
        'Paint',
        (d) => {
          d.nested.arr.push(100 + i);
          d.n = i;
          d.map.k0.deep.w[0] = i;
          if (i % 10 === 0) d.list.push({ id: 1000 + i, tags: [] });
        },
        'stroke',
      );
    }
    expect(s.history.past).toHaveLength(1);
    expect(s.history.past[0].patches.length).toBeLessThanOrEqual(100 + 10 + 2);
    expect(s.history.past[0].inverse.length).toBeLessThanOrEqual(100 + 10 + 2);
    const after = clone(s.doc);
    expect(after.nested.arr).toHaveLength(103);
    s.undo();
    expect(s.doc).toStrictEqual(before);
    s.redo();
    expect(s.doc).toStrictEqual(after);
  });

  it('starts a new entry for another key, for no key, after seal, and after undo or redo', () => {
    const s = new Session();
    s.update('a', (d) => (d.n = 1), 'k1');
    s.update('a', (d) => (d.n = 2), 'k1');
    s.update('b', (d) => (d.n = 3), 'k2'); // another key
    s.update('b', (d) => (d.n = 4), 'k2');
    s.update('c', (d) => (d.n = 5)); // no key
    s.update('c', (d) => (d.n = 6)); // no key never merges
    s.update('a', (d) => (d.n = 7), 'k1'); // k1 again, but the run was interrupted
    expect(s.labels).toEqual(['a', 'b', 'c', 'c', 'a']);

    s.seal(); // pointer-up
    s.update('a', (d) => (d.n = 8), 'k1'); // the next drag of the same thing
    expect(s.labels).toEqual(['a', 'b', 'c', 'c', 'a', 'a']);
    s.update('a', (d) => (d.n = 9), 'k1');
    expect(s.labels).toHaveLength(6);

    s.undo(); // n back to 7; the top entry is the fifth, also key k1
    expect(s.doc.n).toBe(7);
    s.update('a', (d) => (d.n = 10), 'k1'); // must not merge into the entry below
    expect(s.labels).toHaveLength(6);
    s.undo();
    expect(s.doc.n).toBe(7);
    s.redo();
    expect(s.doc.n).toBe(10);
    s.update('a', (d) => (d.n = 11), 'k1'); // a redone entry is closed too
    expect(s.labels).toHaveLength(7);
    s.undo();
    expect(s.doc.n).toBe(10);
  });

  it('undo in the middle of a drag takes back the drag so far; the drag then continues as a new step', () => {
    const s = new Session();
    const before = clone(s.doc);
    s.update('Move', (d) => (d.list[1].pos = [1, 0, 0]), 'drag');
    s.update('Move', (d) => (d.list[1].pos = [2, 0, 0]), 'drag');
    expect(s.undo()).toBe(true);
    expect(s.doc).toStrictEqual(before);
    expect(redoLabel(s.history)).toBe('Move');
    s.update('Move', (d) => (d.list[1].pos = [3, 0, 0]), 'drag'); // the pointer is still down
    s.update('Move', (d) => (d.list[1].pos = [4, 0, 0]), 'drag');
    expect(s.labels).toEqual(['Move']);
    expect(canRedo(s.history)).toBe(false);
    s.undo();
    expect(s.doc).toStrictEqual(before);
    s.redo();
    expect(s.doc.list[1].pos).toEqual([4, 0, 0]);
  });

  it('drops the entry of a run that ended where it started', () => {
    const s = new Session();
    s.update('before', (d) => (d.name = 'x'));
    s.update('Slide', (d) => (d.n = 5), 'slider');
    s.update('Slide', (d) => (d.n = 9), 'slider');
    s.update('Slide', (d) => (d.n = 0), 'slider'); // back at the start
    expect(s.labels).toEqual(['before']);
    expect(s.history.open).toBe(false);
    s.update('Slide', (d) => (d.n = 3), 'slider');
    expect(s.labels).toEqual(['before', 'Slide']);
    s.undo();
    expect(s.doc.n).toBe(0);
    // array growth that is taken back is a return to the start as well
    const t = new Session();
    t.update('Stroke', (d) => d.nested.arr.push(9), 'stroke');
    t.update('Stroke', (d) => d.nested.arr.pop(), 'stroke');
    expect(t.labels).toEqual([]);
    expect(t.doc).toStrictEqual(initial());
  });

  it('keeps the latest label of the run', () => {
    const s = new Session();
    s.update('Type name', (d) => (d.name = 'b'), 'name');
    s.update('Rename to "bu"', (d) => (d.name = 'bu'), 'name');
    expect(s.labels).toEqual(['Rename to "bu"']);
    expect(s.history.past[0].id).toBe(1);
  });
});

describe('cost', () => {
  it('a long coalesced stroke on a large array stays cheap per update', { ...PERF, retry: 2, timeout: 60_000 }, () => {
    // 2D hand edits: every pointer move appends to an array that already holds 20 000 overrides
    interface Chart {
      overrides: { cell: number; hex: string }[];
      locked: number[];
    }
    let doc: Chart = { overrides: Array.from({ length: 20_000 }, (_, i) => ({ cell: i, hex: '#aabbcc' })), locked: [] };
    let history: History = emptyHistory();
    const before = doc;
    const started = performance.now();
    const updates = 400;
    for (let i = 0; i < updates; i++) {
      const change = applyRecipe(doc, (d) => {
        d.overrides.push({ cell: 20_000 + i, hex: '#112233' });
      });
      doc = change.doc;
      history = record(history, doc, { label: 'Paint', coalesceKey: 'stroke', patches: change.patches, inverse: change.inverse });
    }
    const perUpdateMs = (performance.now() - started) / updates;
    expect(history.past).toHaveLength(1);
    expect(history.past[0].patches).toHaveLength(updates); // one `add` per painted cell, nothing about the 20 000
    expect(history.past[0].patches[0]).toEqual({ op: 'add', path: ['overrides', 20_000], value: { cell: 20_000, hex: '#112233' } });
    const undone = undo(history, doc);
    expect(undone?.doc.overrides).toHaveLength(20_000);
    expect(undone?.doc).toStrictEqual(before);
    // Measured 2.0 ms per update on the development machine, 1.1 ms of it immer's own produce on the
    // 20 000-element array (the diff 0.2 ms, re-deriving the entry 0.7 ms); 6.5 ms while other agents loaded
    // all 12 cores. The budget is one frame (16 ms): a drag must not stutter.
    expect(perUpdateMs).toBeLessThan(budget(16));
  });
});

describe('the cap', () => {
  it('keeps at most 200 entries and forgets the oldest', () => {
    expect(HISTORY_LIMIT).toBe(200);
    const s = new Session();
    for (let i = 1; i <= 250; i++) s.update(`step ${i}`, (d) => (d.n = i));
    expect(s.history.past).toHaveLength(200);
    expect(s.labels[0]).toBe('step 51');
    expect(s.labels[199]).toBe('step 250');
    let undone = 0;
    while (s.undo()) undone++;
    expect(undone).toBe(200);
    expect(s.doc.n).toBe(50); // steps 1..50 can no longer be undone
    expect(s.history.future).toHaveLength(200);
    let redone = 0;
    while (s.redo()) redone++;
    expect(redone).toBe(200);
    expect(s.doc.n).toBe(250);
    expect(s.history.past).toHaveLength(200);
  });

  it('counts a coalesced run as one entry', () => {
    const s = new Session();
    for (let i = 1; i <= 199; i++) s.update(`step ${i}`, (d) => (d.n = i));
    for (let i = 0; i < 300; i++) s.update('drag', (d) => (d.nested.a.b.c = 1000 + i), 'drag');
    expect(s.history.past).toHaveLength(200);
    expect(s.labels[0]).toBe('step 1');
    s.update('one more', (d) => (d.name = 'x'));
    expect(s.history.past).toHaveLength(200);
    expect(s.labels[0]).toBe('step 2');
  });

  it('honors a smaller limit', () => {
    const s = new Session();
    s.limit = 3;
    for (let i = 1; i <= 10; i++) s.update(`step ${i}`, (d) => (d.n = i));
    expect(s.labels).toEqual(['step 8', 'step 9', 'step 10']);
  });
});

// ---- a long random walk against a reference that keeps whole snapshots

/** A random edit that always changes the document. `fresh()` gives a number that was never used before. */
function randomEdit(rng: Rng, fresh: () => number): (d: Doc) => void {
  const pick = <T>(items: readonly T[]): T => items[randomInt(rng, items.length)];
  return (d) => {
    switch (randomInt(rng, 14)) {
      case 0:
        d.name = `name ${fresh()}`;
        return;
      case 1:
        d.n = fresh();
        return;
      case 2:
        d.list.push({ id: fresh(), tags: [`t${fresh()}`] });
        return;
      case 3:
        if (d.list.length > 0) d.list.splice(randomInt(rng, d.list.length), 1);
        else d.list.push({ id: fresh(), tags: [] });
        return;
      case 4:
        d.list.splice(randomInt(rng, d.list.length + 1), 0, { id: fresh(), tags: [], pos: [fresh(), 0, 0] });
        return;
      case 5: {
        if (d.list.length === 0) d.list.push({ id: fresh(), tags: [] });
        const item = pick(d.list);
        item.pos = [fresh(), fresh(), fresh()];
        return;
      }
      case 6: {
        if (d.list.length === 0) d.list.push({ id: fresh(), tags: [] });
        pick(d.list).tags.push(`t${fresh()}`);
        return;
      }
      case 7:
        d.map[`k${fresh()}`] = { v: fresh(), deep: { w: [fresh()] } };
        return;
      case 8: {
        const keys = Object.keys(d.map);
        if (keys.length > 0) delete d.map[pick(keys)];
        else d.map[`k${fresh()}`] = { v: fresh(), deep: { w: [] } };
        return;
      }
      case 9: {
        const keys = Object.keys(d.map);
        if (keys.length > 0) d.map[pick(keys)].deep.w.unshift(fresh());
        else d.n = fresh();
        return;
      }
      case 10:
        d.nested.a.b.c = fresh();
        return;
      case 11:
        d.nested = { a: { b: { c: fresh() } }, arr: [fresh(), fresh()] };
        return;
      case 12:
        if (d.opt === undefined) d.opt = `opt ${fresh()}`;
        else delete d.opt;
        return;
      default: {
        // move the last item to the front and reverse an array
        const last = d.list.pop();
        if (last) d.list.unshift(last);
        d.nested.arr.reverse();
        d.nested.arr.push(fresh());
        return;
      }
    }
  };
}

describe('undo and redo over long random sequences (seeded)', () => {
  it('always restores the document exactly, with coalescing, undo, redo and the cap mixed in', { timeout: 60_000 }, () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rng = mulberry32(seed * 104729);
      let counter = 1000;
      const fresh = (): number => ++counter;
      const s = new Session();
      s.limit = seed % 2 === 0 ? 25 : HISTORY_LIMIT;

      // The reference keeps whole documents: states[i] is the document after i steps.
      let states: Doc[] = [clone(s.doc)];
      let keys: (string | undefined)[] = []; // keys[i] = coalesce key of the step states[i] → states[i + 1]
      let cursor = 0;
      let open = false;
      let dropped = 0; // steps forgotten by the cap

      const steps = 1500;
      for (let step = 0; step < steps; step++) {
        const roll = rng();
        if (roll < 0.62) {
          const key = rng() < 0.5 ? `key${randomInt(rng, 2)}` : undefined;
          s.update(`edit ${step}`, randomEdit(rng, fresh), key);
          const now = clone(s.doc);
          if (open && key !== undefined && keys[cursor - 1] === key) {
            if (isDeepStrictEqual(now, states[cursor - 1])) {
              // the run came back to where it started: its step disappears
              states = states.slice(0, cursor);
              keys = keys.slice(0, cursor - 1);
              cursor--;
              open = false;
            } else {
              states = [...states.slice(0, cursor), now]; // the run continues: same step, new end state
              keys = keys.slice(0, cursor);
              open = true;
            }
          } else {
            states = [...states.slice(0, cursor + 1), now];
            keys = [...keys.slice(0, cursor), key];
            cursor++;
            if (cursor - dropped > s.limit) dropped = cursor - s.limit;
            open = key !== undefined;
          }
        } else if (roll < 0.8) {
          // an undo or redo that has nothing to do is a no-op: it does not even end a run
          const can = cursor > dropped;
          expect(s.undo(), `seed ${seed} step ${step}: undo`).toBe(can);
          if (can) {
            cursor--;
            open = false;
          }
        } else if (roll < 0.95) {
          const can = cursor < states.length - 1;
          expect(s.redo(), `seed ${seed} step ${step}: redo`).toBe(can);
          if (can) {
            cursor++;
            open = false;
          }
        } else {
          s.seal();
          open = false;
        }
        expect(s.doc, `seed ${seed} step ${step}`).toStrictEqual(states[cursor]);
        expect(s.history.past.length, `seed ${seed} step ${step}: past`).toBe(cursor - dropped);
        expect(s.history.future.length, `seed ${seed} step ${step}: future`).toBe(states.length - 1 - cursor);
        expect(s.history.past.length).toBeLessThanOrEqual(s.limit);
      }

      // all the way back, then all the way forward
      while (cursor > dropped) {
        expect(s.undo()).toBe(true);
        cursor--;
        expect(s.doc).toStrictEqual(states[cursor]);
      }
      expect(s.undo()).toBe(false);
      while (cursor < states.length - 1) {
        expect(s.redo()).toBe(true);
        cursor++;
        expect(s.doc).toStrictEqual(states[cursor]);
      }
      expect(s.redo()).toBe(false);
    }
  });
});

// ---- the structural diff and the patch applier under the history

/** Deep freeze, as the documents of a store are. */
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

/** diff, then check both directions; returns the forward patches. */
function patchesBetween(base: unknown, next: unknown): { op: string; path: (string | number)[]; value?: unknown }[] {
  const a = frozen(structuredClone(base));
  const b = frozen(structuredClone(next));
  const { patches, inverse } = diffDocuments(a, b);
  expect(applyPatches(a, patches)).toStrictEqual(b);
  expect(applyPatches(b, inverse)).toStrictEqual(a);
  expect(patches.length).toBe(inverse.length);
  return patches;
}

describe('diffDocuments', () => {
  it('finds nothing between equal documents, whether they share objects or not', () => {
    const doc = frozen(initial());
    expect(diffDocuments(doc, doc)).toEqual({ patches: [], inverse: [] });
    expect(diffDocuments(doc, structuredClone(doc))).toEqual({ patches: [], inverse: [] });
    expect(diffDocuments([], [])).toEqual({ patches: [], inverse: [] });
    expect(diffDocuments(Number.NaN, Number.NaN).patches).toEqual([]);
  });

  it('patches object keys: replaced, added, removed, nested', () => {
    expect(patchesBetween({ a: 1, b: { c: 2, d: 3 }, e: 5 }, { a: 1, b: { c: 9, x: 1 }, f: 6 })).toEqual([
      { op: 'replace', path: ['b', 'c'], value: 9 },
      { op: 'remove', path: ['b', 'd'] },
      { op: 'add', path: ['b', 'x'], value: 1 },
      { op: 'remove', path: ['e'] },
      { op: 'add', path: ['f'], value: 6 },
    ]);
  });

  it('tells a key that holds undefined from a key that is not there', () => {
    expect(patchesBetween({ a: undefined }, {})).toEqual([{ op: 'remove', path: ['a'] }]);
    expect(patchesBetween({}, { a: undefined })).toEqual([{ op: 'add', path: ['a'], value: undefined }]);
    expect(patchesBetween({ a: undefined }, { a: null })).toEqual([{ op: 'replace', path: ['a'], value: null }]);
    expect(patchesBetween({ a: 0 }, { a: -0 })).toHaveLength(1); // exact, not "about equal"
  });

  it('replaces a value whose kind changed as a whole', () => {
    expect(patchesBetween({ a: [1, 2] }, { a: { 0: 1, 1: 2 } })).toEqual([{ op: 'replace', path: ['a'], value: { 0: 1, 1: 2 } }]);
    expect(patchesBetween({ a: { b: 1 } }, { a: 'text' })).toEqual([{ op: 'replace', path: ['a'], value: 'text' }]);
    expect(patchesBetween({ a: null }, { a: {} })).toEqual([{ op: 'replace', path: ['a'], value: {} }]);
    expect(patchesBetween(1, { a: 1 })).toEqual([{ op: 'replace', path: [], value: { a: 1 } }]); // even the root
    expect(patchesBetween([1], { a: 1 })).toEqual([{ op: 'replace', path: [], value: { a: 1 } }]);
  });

  it('patches arrays of one length index by index, into the elements', () => {
    expect(patchesBetween([{ id: 1, t: ['a'] }, { id: 2 }, 3], [{ id: 1, t: ['a', 'b'] }, { id: 2 }, 4])).toEqual([
      { op: 'add', path: [0, 't', 1], value: 'b' },
      { op: 'replace', path: [2], value: 4 },
    ]);
  });

  it('needs one patch per element for the usual array edits, however long the array is', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const base = frozen({ items });
    const edit = (change: (list: { id: number }[]) => void): unknown[] => {
      const list = [...items];
      change(list);
      const next = frozen({ items: list });
      const { patches, inverse } = diffDocuments(base, next);
      expect(applyPatches(base, patches)).toStrictEqual(next);
      expect(applyPatches(next, inverse)).toStrictEqual(base);
      return patches;
    };
    expect(edit((l) => l.push({ id: 1000 }))).toEqual([{ op: 'add', path: ['items', 1000], value: { id: 1000 } }]);
    expect(edit((l) => l.push({ id: 1000 }, { id: 1001 }))).toHaveLength(2);
    expect(edit((l) => l.pop())).toEqual([{ op: 'remove', path: ['items', 999] }]);
    expect(edit((l) => l.shift())).toEqual([{ op: 'remove', path: ['items', 0] }]);
    expect(edit((l) => l.unshift({ id: -1 }))).toEqual([{ op: 'add', path: ['items', 0], value: { id: -1 } }]);
    expect(edit((l) => l.splice(500, 1))).toEqual([{ op: 'remove', path: ['items', 500] }]);
    expect(edit((l) => l.splice(500, 3))).toEqual([
      { op: 'remove', path: ['items', 502] },
      { op: 'remove', path: ['items', 501] },
      { op: 'remove', path: ['items', 500] },
    ]);
    expect(edit((l) => l.splice(500, 0, { id: -5 }))).toEqual([{ op: 'add', path: ['items', 500], value: { id: -5 } }]);
    // a splice that also replaces: the element at the common index is patched in place, the rest removed
    expect(edit((l) => l.splice(10, 2, { id: -7 }))).toEqual([
      { op: 'replace', path: ['items', 10, 'id'], value: -7 },
      { op: 'remove', path: ['items', 11] },
    ]);
    expect(edit((l) => void (l.length = 0))).toHaveLength(1000);
  });

  it('handles reorders and unrelated arrays (correct, if not minimal)', () => {
    patchesBetween([1, 2, 3, 4], [4, 3, 2, 1]);
    patchesBetween([{ a: 1 }, { b: 2 }, { c: 3 }], [{ c: 3 }, { a: 1 }]);
    patchesBetween([1, 2, 3], []);
    patchesBetween([], [[1], [2, [3]]]);
    patchesBetween([[1, 2], [3]], [[3], [1, 2], [4]]);
    patchesBetween(['a', 'a', 'b', 'a'], ['a', 'b', 'a', 'a', 'a']);
  });

  it('treats a key named __proto__, constructor or toString as data', () => {
    const base = JSON.parse('{"__proto__": {"x": 1}, "constructor": 1, "plain": {"__proto__": 2}}') as Record<string, unknown>;
    const next = JSON.parse('{"__proto__": {"x": 2, "polluted": true}, "toString": "t", "plain": {}}') as Record<string, unknown>;
    expect(Object.keys(base)).toEqual(['__proto__', 'constructor', 'plain']);
    const patches = patchesBetween(base, next);
    expect(patches.map((p) => `${p.op} ${p.path.join('/')}`)).toEqual(['replace __proto__/x', 'add __proto__/polluted', 'remove constructor', 'remove plain/__proto__', 'add toString']);
    const applied = applyPatches(frozen(structuredClone(base)), diffDocuments(base, next).patches) as Record<string, unknown>;
    expect(Object.getPrototypeOf(applied)).toBe(Object.prototype); // an own key was written, not the prototype
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('does not look into branches that are the same object', () => {
    const shared = frozen({ big: Array.from({ length: 50 }, (_, i) => ({ i })) });
    const base = frozen({ a: shared, b: 1 });
    const next = frozen({ a: shared, b: 2 });
    const getters: string[] = [];
    const spy = new Proxy(base, {
      get(target, key, receiver) {
        getters.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(diffDocuments(spy, next).patches).toEqual([{ op: 'replace', path: ['b'], value: 2 }]);
    expect(getters.filter((k) => k === 'big')).toEqual([]);
  });

  it('holds for any two JSON values (seeded): the patches turn one into the other, and back', { timeout: 60_000 }, () => {
    const rng = mulberry32(31337);
    const randomJson = (depth: number): unknown => {
      const roll = rng();
      if (depth <= 0 || roll < 0.3) return [0, 1, -1, 2.5, 'a', 'b', '', true, false, null][randomInt(rng, 10)];
      if (roll < 0.65) return Array.from({ length: randomInt(rng, 5) }, () => randomJson(depth - 1));
      const obj: Record<string, unknown> = {};
      const n = randomInt(rng, 5);
      for (let i = 0; i < n; i++) obj[['a', 'b', 'c', 'd', 'e', 'f'][randomInt(rng, 6)]] = randomJson(depth - 1);
      return obj;
    };
    /** A value near `v`: the kind of difference an edit makes. */
    const mutate = (v: unknown, depth: number): unknown => {
      if (rng() < 0.15 || depth <= 0) return randomJson(2);
      if (Array.isArray(v)) {
        const copy = v.map((x) => (rng() < 0.2 ? mutate(x, depth - 1) : x));
        const roll = rng();
        if (roll < 0.25) copy.splice(randomInt(rng, copy.length + 1), 0, randomJson(2));
        else if (roll < 0.5 && copy.length > 0) copy.splice(randomInt(rng, copy.length), 1 + randomInt(rng, 2));
        else if (roll < 0.6) copy.reverse();
        return copy;
      }
      if (typeof v === 'object' && v !== null) {
        const copy: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
          if (rng() < 0.15) continue;
          copy[k] = rng() < 0.3 ? mutate(x, depth - 1) : x;
        }
        if (rng() < 0.3) copy[['a', 'x', 'y'][randomInt(rng, 3)]] = randomJson(2);
        return copy;
      }
      return randomJson(1);
    };
    for (let n = 0; n < 4000; n++) {
      const a = frozen(randomJson(4));
      const b = frozen(n % 2 === 0 ? mutate(a, 4) : randomJson(4));
      const { patches, inverse } = diffDocuments(a, b);
      expect(applyPatches(a, patches), `pair ${n}: forward`).toStrictEqual(b);
      expect(applyPatches(b, inverse), `pair ${n}: back`).toStrictEqual(a);
      expect(patches.length === 0, `pair ${n}: empty exactly when equal`).toBe(isDeepStrictEqual(a, b));
    }
  });

  it('keeps a null-prototype object one when it copies it, also through undo and redo (found in review)', () => {
    const dict = (entries: Record<string, unknown>): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, entries);
    const base = frozen({ table: dict({ a: 1, b: { c: 2 } }) });
    const next = frozen({ table: dict({ a: 1, b: { c: 3 }, d: 4 }) });
    const { patches, inverse } = diffDocuments(base, next);
    const forward = applyPatches(base, patches);
    const back = applyPatches(next, inverse);
    expect(Object.getPrototypeOf(forward.table)).toBeNull(); // `{ ...table }` would have given it Object.prototype
    expect(Object.getPrototypeOf(back.table)).toBeNull();
    expect(isDeepStrictEqual(forward, next)).toBe(true);
    expect(isDeepStrictEqual(back, base)).toBe(true);

    // immer keeps the prototype in a recipe, so undo and redo must too
    const change = applyRecipe(base, (d) => void (d.table.a = 2));
    expect(Object.getPrototypeOf(change.doc.table)).toBeNull();
    const history = record(emptyHistory(), change.doc, { label: 'Edit', patches: change.patches, inverse: change.inverse });
    const undone = undo(history, change.doc);
    if (!undone) throw new Error('expected an undo step');
    expect(Object.getPrototypeOf(undone.doc.table)).toBeNull();
    expect(isDeepStrictEqual(undone.doc, base)).toBe(true);
    const redone = redo(undone.history, undone.doc);
    if (!redone) throw new Error('expected a redo step');
    expect(Object.getPrototypeOf(redone.doc.table)).toBeNull();
    expect(isDeepStrictEqual(redone.doc, change.doc)).toBe(true);
  });

  it('is exact for everything a recipe can leave in a document: -0, NaN, Infinity, undefined, keys like __proto__ and length, null-prototype objects (seeded; found in review)', { timeout: 60_000 }, () => {
    const KEYS = ['a', 'b', '__proto__', 'constructor', 'length', '0', '1', '-1', '01', 'toString', 'hasOwnProperty', '', 'then', 'valueOf', '1e3', ' 2'];
    const rng = mulberry32(100_001);
    const define = (target: Record<string, unknown>, key: string, value: unknown): void => {
      Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    };
    const hostile = (depth: number): unknown => {
      switch (randomInt(rng, depth > 3 ? 6 : 10)) {
        case 0:
          return randomInt(rng, 5);
        case 1:
          return [0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null][randomInt(rng, 6)];
        case 2:
          return ['x', 'y', ''][randomInt(rng, 3)];
        case 3:
          return rng() < 0.5;
        case 4:
          return rng() < 0.5 ? undefined : null;
        case 5:
          return randomInt(rng, 3);
        case 6:
        case 7:
          return Array.from({ length: randomInt(rng, 5) }, () => hostile(depth + 1));
        default: {
          const obj = (rng() < 0.25 ? Object.create(null) : {}) as Record<string, unknown>;
          const n = randomInt(rng, 5);
          for (let i = 0; i < n; i++) define(obj, KEYS[randomInt(rng, KEYS.length)], hostile(depth + 1));
          return obj;
        }
      }
    };
    /** `v` with one nested value replaced or one key added: an edit, sharing everything else with `v`. */
    const nudge = (v: unknown, depth: number): unknown => {
      if (depth > 4 || typeof v !== 'object' || v === null || rng() < 0.2) return hostile(2);
      if (Array.isArray(v)) {
        const copy = [...(v as unknown[])];
        if (copy.length > 0 && rng() < 0.7) {
          const i = randomInt(rng, copy.length);
          copy[i] = nudge(copy[i], depth + 1);
        } else copy.splice(randomInt(rng, copy.length + 1), 0, hostile(3));
        return copy;
      }
      const source = v as Record<string, unknown>;
      const copy = Object.create(Object.getPrototypeOf(source) as object | null) as Record<string, unknown>;
      for (const key of Object.keys(source)) define(copy, key, source[key]);
      const keys = Object.keys(copy);
      if (keys.length > 0 && rng() < 0.7) {
        const key = keys[randomInt(rng, keys.length)];
        define(copy, key, nudge(copy[key], depth + 1));
      } else define(copy, KEYS[randomInt(rng, KEYS.length)], hostile(3));
      return copy;
    };
    const failures: string[] = [];
    for (let n = 0; n < 4000; n++) {
      const a = frozen(hostile(0));
      const b = frozen(n % 2 === 0 ? nudge(a, 0) : hostile(0));
      const { patches, inverse } = diffDocuments(a, b);
      // isDeepStrictEqual: Object.is on primitives, own keys, and prototypes
      if (!isDeepStrictEqual(applyPatches(a, patches), b)) failures.push(`pair ${n}: forward`);
      if (!isDeepStrictEqual(applyPatches(b, inverse), a)) failures.push(`pair ${n}: back`);
      if ((patches.length === 0) !== isDeepStrictEqual(a, b)) failures.push(`pair ${n}: patches ${patches.length}`);
    }
    expect(failures).toEqual([]);
    // an ordinary object that becomes a null-prototype one (or back) is replaced whole: the change is not lost
    expect(diffDocuments({ t: { a: 1 } }, { t: Object.assign(Object.create(null) as object, { a: 1 }) }).patches).toHaveLength(1);
  });
});

describe('applyPatches', () => {
  it('copies only the way to the patched place, shares the rest, and returns frozen objects', () => {
    const doc = frozen(initial());
    const next = applyPatches(doc, [{ op: 'replace', path: ['nested', 'a', 'b', 'c'], value: 7 }]);
    expect(next.nested.a.b.c).toBe(7);
    expect(doc.nested.a.b.c).toBe(1);
    expect(next.list).toBe(doc.list);
    expect(next.map).toBe(doc.map);
    expect(next.nested.arr).toBe(doc.nested.arr);
    expect(next.nested).not.toBe(doc.nested);
    for (const copy of [next, next.nested, next.nested.a, next.nested.a.b]) expect(Object.isFrozen(copy)).toBe(true);
    expect(applyPatches(doc, [])).toBe(doc);
  });

  it('puts back the very objects a step removed, and never touches the identity of the rest', () => {
    const s = new Session();
    s.doc = frozen({ ...initial(), list: [...initial().list, { id: 3, tags: ['c'] }] });
    const before = s.doc;
    s.update('Edit', (d) => {
      d.list.splice(1, 1); // remove an item
      delete d.map.k0; // remove a key
      d.nested.a.b.c = 2; // change a leaf
    });
    s.undo();
    expect(s.doc).toStrictEqual(before);
    expect(s.doc.list[1]).toBe(before.list[1]); // the removed item is the same object again
    expect(s.doc.map.k0).toBe(before.map.k0); // so is the value of the removed key
    expect(s.doc.list[0]).toBe(before.list[0]); // what was never touched never changed identity
    expect(s.doc.list[2]).toBe(before.list[2]);
    expect(s.doc.nested.arr).toBe(before.nested.arr);
    expect(s.doc.nested.a.b).toStrictEqual(before.nested.a.b); // rebuilt on the way to the leaf: equal, not identical
  });

  it('refuses a patch that does not fit the document, and applies nothing', () => {
    const doc = frozen(initial());
    const bad: Patch[] = [
      { op: 'replace', path: ['nope', 'x'], value: 1 }, // no such branch
      { op: 'replace', path: ['nope'], value: 1 }, // replace needs the key
      { op: 'remove', path: ['opt'] }, // remove needs the key
      { op: 'add', path: ['name'], value: 'x' }, // add needs the key to be free
      { op: 'replace', path: ['list', 4], value: {} }, // index out of range
      { op: 'remove', path: ['list', -1] },
      { op: 'add', path: ['list', 6], value: {} }, // beyond the end
      { op: 'add', path: ['list', 1.5], value: {} },
      { op: 'replace', path: ['name', 'length'], value: 3 }, // through a string
      { op: 'add', path: [], value: {} }, // the root can only be replaced
      { op: 'remove', path: [] },
    ];
    for (const patch of bad) {
      const good: Patch = { op: 'replace', path: ['n'], value: 5 };
      expect(() => applyPatches(doc, [good, patch]), JSON.stringify(patch)).toThrow('does not fit the document');
    }
    expect(doc).toStrictEqual(initial());
    expect(applyPatches(doc, [{ op: 'add', path: ['list', 2], value: { id: 5, tags: [] } }]).list).toHaveLength(3); // at the end is fine
    expect(applyPatches(doc, [{ op: 'replace', path: [], value: 'whole' }])).toBe('whole');
  });
});
