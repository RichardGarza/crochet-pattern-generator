import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mulberry32, randomInt, type Rng } from '../../core/kernel/prng';
import {
  applyRecipe,
  canRedo,
  canUndo,
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
    // the entry is as small as a single move
    expect(entry.patches).toHaveLength(1);
    expect(entry.inverse).toHaveLength(1);
    expect(entry.patches[0]).toEqual({ op: 'replace', path: ['list', 1, 'pos'], value: [500, 1000, 1500] });
    expect(entry.inverse[0]).toEqual({ op: 'replace', path: ['list', 1, 'pos'], value: [0, 0, 0] });
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
  it('always restores the document exactly, with coalescing, undo, redo and the cap mixed in', () => {
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
