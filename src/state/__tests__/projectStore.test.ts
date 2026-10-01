// The store tests of DESIGN.md §6.2 item 7: update / undo / redo / coalesce, the asset cache,
// commitModelRevision and the hooks T8's autosave builds on.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { current, original } from 'immer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { mulberry32, randomInt, type Rng } from '../../core/kernel/prng';
import type { CommitModelRevisionFn } from '../../types/entryPoints';
import type { CrochetModelV1, Part } from '../../types/model';
import type { AssetRef, ProjectDoc } from '../../types/project';
import { HISTORY_LIMIT } from '../history';
import {
  AssetMissingError,
  commitModelRevision,
  createProjectStore,
  MODEL_REVISION_MIME,
  projectStore,
  ReadOnlyError,
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
  selectModel,
  selectRedoLabel,
  selectUndoLabel,
  sha256Hex,
  UnsavedChangesError,
  type CommitOptions,
  type ProjectStore,
} from '../projectStore';

// ---- fixtures

const T0 = '2026-10-01T10:00:00.000Z';
const CLOCK = '2026-10-01T12:34:56.000Z';

const AMI: NonNullable<ProjectDoc['threeD']>['ami'] = {
  style: 'classic',
  spiral: true,
  crispStripes: false,
  decMethod: 'invdec',
  dialect: 'compact',
  terms: 'us',
  hand: 'right',
  eyes: 'auto',
  defaultStuffing: 'medium',
  leanStPerRnd: 0.25,
};

const PALETTE = [
  { id: 'c1', hex: '#c8a27a' },
  { id: 'c2', hex: '#f4ebdd' },
  { id: 'c3', hex: '#222222' },
];

const base = { position: [0, 0, 0] as [number, number, number], color: 'c1' };
const sphere = (id: string, r = 1, more: Partial<Part> = {}): Part => ({ ...base, id, type: 'sphere', dims: { r }, ...more }) as Part;
const meshPart = (id: string, meshRef: string): Part => ({ ...base, id, type: 'mesh', dims: { meshRef, bboxIn: [1, 1, 1] } }) as Part;

function model(parts: Part[], more: Partial<CrochetModelV1> = {}): CrochetModelV1 {
  return {
    schema: 'crochet-model',
    version: '1.0',
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'toy',
    finishedSize: { height: 8 },
    palette: PALETTE,
    parts,
    ...more,
  };
}

function paint(index: number): NonNullable<Part['paint']> {
  return { kind: 'uv64', data: Buffer.from(new Uint8Array(64 * 64).fill(index)).toString('base64') };
}

function project(more: Partial<ProjectDoc> = {}): ProjectDoc {
  return {
    schema: 'crochet-project',
    version: 1,
    id: 'p1',
    name: 'Bunny',
    createdAt: T0,
    updatedAt: T0,
    rev: 3,
    mode: '3d',
    units: 'in',
    terms: 'us',
    hand: 'right',
    gauge: { cyc: 4, technique: 'amigurumi_sc' },
    sources: [],
    threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI },
    imports: [],
    ...more,
  };
}

function opened(doc: ProjectDoc = project(), o: { readOnly?: boolean } = {}): ProjectStore {
  const store = createProjectStore({ now: () => new Date(CLOCK) });
  store.getState().open(doc, o);
  return store;
}

const clone = <T>(v: T): T => structuredClone(v);
const docOf = (store: ProjectStore): ProjectDoc => {
  const { doc } = store.getState();
  if (!doc) throw new Error('no project is open');
  return doc;
};
const nodeSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const ref = (key: string): AssetRef => ({ key, mime: 'application/octet-stream', bytes: 1, sha256: key.split('/')[1] ?? key });

// ---- open / close

describe('open and close', () => {
  it('starts with no project', () => {
    const s = createProjectStore().getState();
    expect(s.doc).toBeNull();
    expect(s.saveStatus).toBe('saved');
    expect(s.session).toBe(0);
    expect(selectIsDirty(s)).toBe(false);
    expect(() => s.update('x', () => {})).toThrow('no project is open');
    expect(s.undo()).toBe(false);
    expect(s.beginSave()).toBeNull();
  });

  it('copies and freezes the document it is given', () => {
    const mine = project();
    const store = opened(mine);
    const doc = docOf(store);
    expect(doc).toEqual(mine);
    expect(doc).not.toBe(mine);
    mine.name = 'changed outside'; // the caller's object is not the store's
    expect(docOf(store).name).toBe('Bunny');
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.gauge)).toBe(true);
    expect(() => {
      (doc as { name: string }).name = 'mutated';
    }).toThrow(TypeError);
    const s = store.getState();
    expect([s.session, s.baseRev, s.changeId, s.readOnly, s.saveStatus]).toEqual([1, 3, 0, false, 'saved']);
  });

  it('refuses something that is not a project document, or has an unusable id', () => {
    const s = createProjectStore().getState();
    expect(() => s.open({ ...project(), schema: 'nope' } as unknown as ProjectDoc)).toThrow(TypeError);
    expect(() => s.open(null as unknown as ProjectDoc)).toThrow(TypeError);
    expect(() => s.open(project({ id: '' }))).toThrow('invalid project id');
    expect(() => s.open(project({ id: 'a/b' }))).toThrow('invalid project id'); // it is the first half of every asset key
    expect(s.doc).toBeNull();
  });

  it('will not drop unsaved changes unless told to', () => {
    const store = opened();
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    expect(() => store.getState().close()).toThrow(UnsavedChangesError);
    expect(() => store.getState().open(project({ id: 'p2' }))).toThrow(UnsavedChangesError);
    expect(docOf(store).name).toBe('Teddy');

    // saved changes are no obstacle
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    expect(() => store.getState().close()).toThrow(UnsavedChangesError); // the save has not finished
    store.getState().markSaved(ticket, { rev: 4 });
    store.getState().close();
    expect(store.getState().doc).toBeNull();
    expect(store.getState().session).toBe(2);

    // and the explicit way out
    store.getState().open(project());
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    store.getState().open(project({ id: 'p2', name: 'Other' }), { discardUnsaved: true });
    expect(docOf(store).id).toBe('p2');
    store.getState().update('Rename', (d) => (d.name = 'x'));
    store.getState().close({ discardUnsaved: true });
    expect(store.getState().history.past).toEqual([]);
    expect(store.getState().assets.size).toBe(0);
  });

  it('opens with a cache of assets that are already stored', async () => {
    const store = createProjectStore();
    const blob = new Blob(['x']);
    store.getState().open(project(), { assets: [['p1/abc', blob]] });
    expect(await store.getState().getAsset('p1/abc')).toBe(blob);
    expect(store.getState().unsavedAssetKeys.size).toBe(0);
  });
});

// ---- update

describe('update', () => {
  it('applies a recipe, records a labelled history entry and marks the project unsaved', () => {
    const store = opened();
    const before = docOf(store);
    expect(store.getState().update('Rename project', (d) => (d.name = 'Teddy'))).toBe(true);
    const s = store.getState();
    expect(docOf(store).name).toBe('Teddy');
    expect(before.name).toBe('Bunny'); // the old document is untouched
    expect(docOf(store).gauge).toBe(before.gauge); // and shared where nothing changed
    expect(s.history.past.map((e) => e.label)).toEqual(['Rename project']);
    expect([s.changeId, s.savedChangeId, s.saveStatus]).toEqual([1, 0, 'unsaved']);
    expect(selectIsDirty(s)).toBe(true);
    expect(selectCanUndo(s)).toBe(true);
    expect(selectUndoLabel(s)).toBe('Rename project');
    expect(selectCanRedo(s)).toBe(false);
  });

  it('records nothing for a recipe that changes nothing', () => {
    const store = opened();
    expect(store.getState().update('Nothing', (d) => (d.name = 'Bunny'))).toBe(true);
    expect(store.getState().update('Nothing', () => {})).toBe(true);
    const s = store.getState();
    expect([s.history.past.length, s.changeId, s.saveStatus]).toEqual([0, 0, 'saved']);
  });

  it('changes nothing when a recipe throws or is async, and keeps working afterwards', () => {
    const store = opened();
    expect(() =>
      store.getState().update('Broken', (d) => {
        d.name = 'half';
        throw new Error('recipe failed');
      }),
    ).toThrow('recipe failed');
    expect(() =>
      store.getState().update('Async', async (d) => {
        d.name = 'async';
      }),
    ).toThrow('synchronous');
    expect(docOf(store).name).toBe('Bunny');
    expect(store.getState().history.past).toEqual([]);
    expect(store.getState().update('Fine', (d) => (d.name = 'ok'))).toBe(true);
    expect(docOf(store).name).toBe('ok');
  });

  it('refuses every action that writes the store from inside a recipe (found in review: markSaved and endCoalescing were overwritten)', async () => {
    const store = opened();
    store.getState().update('First', (d) => (d.name = 'first'), { coalesceKey: 'typing' });
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    const errors: string[] = [];
    let commit: Promise<unknown> | undefined;
    store.getState().update(
      'Outer',
      (d) => {
        d.name = 'outer';
        const s = store.getState();
        for (const call of [
          () => s.update('Inner', (x) => (x.name = 'inner')),
          () => s.undo(),
          () => s.redo(),
          () => s.open(project({ id: 'p9' }), { discardUnsaved: true }),
          () => s.close({ discardUnsaved: true }),
          () => s.setReadOnly(true),
          () => s.endCoalescing(),
          () => s.beginSave(),
          () => s.markSaved(ticket, { rev: 4 }),
          () => s.markSaveFailed(ticket, new Error('quota')),
          () => s.rebind(ticket, { id: 'p1-copy', rev: 1 }),
          () => s.cacheAsset('p1/cached', new Blob(['x'])),
          () => s.uncacheAssets(['p1/cached']),
        ]) {
          try {
            call();
            errors.push('no error');
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        commit = s.commitModelRevision(model([sphere('body')]), { source: 'edit', label: 'x', carry: 'none' });
      },
      { coalesceKey: 'typing' },
    );
    expect(errors).toHaveLength(13);
    for (const message of errors) expect(message).toContain('called from inside a recipe');
    await expect(commit).rejects.toThrow('called from inside a recipe');
    // the outer change went through, exactly once, and nothing else happened: the run is still open (no
    // endCoalescing), the save is still in flight (no markSaved), nothing was cached
    const s = store.getState();
    expect(docOf(store)).toMatchObject({ name: 'outer', id: 'p1', rev: 3 });
    expect(s.history.past.map((e) => e.label)).toEqual(['Outer']);
    expect(s.history.open).toBe(true);
    expect([s.savingTicket, s.baseRev, s.readOnly, s.assets.size]).toEqual([ticket.id, 3, false, 0]);
    // the ticket still ends normally afterwards, and the document and the base rev agree
    expect(s.markSaved(ticket, { rev: 4 })).toBe(true);
    expect([docOf(store).rev, store.getState().baseRev, store.getState().saveStatus]).toEqual([4, 4, 'unsaved']);
    // a commit's `also` is part of the recipe
    await expect(
      store.getState().commitModelRevisionWith(model([sphere('body')]), { source: 'edit', label: 'x', carry: 'none', also: () => store.getState().endCoalescing() }),
    ).rejects.toThrow('called from inside a recipe');
    expect(docOf(store).threeD?.model).toBeUndefined();
  });

  it('lets a subscriber make a follow-up update', () => {
    const store = opened();
    const unsubscribe = store.subscribe((state, prev) => {
      if (state.doc && prev.doc && state.doc.name !== prev.doc.name && state.doc.units === 'in') {
        store.getState().update('Follow-up', (d) => (d.units = 'cm'));
      }
    });
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    unsubscribe();
    expect(docOf(store)).toMatchObject({ name: 'Teddy', units: 'cm' });
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Rename', 'Follow-up']);
    expect(store.getState().changeId).toBe(2);
  });

  it('does not let a recipe touch what persistence owns, or the revision list', () => {
    const store = opened();
    const s = store.getState();
    const recipes: [string, (d: ProjectDoc) => unknown][] = [
      ['id', (d) => (d.id = 'other')],
      ['rev', (d) => (d.rev = 99)],
      ['updatedAt', (d) => (d.updatedAt = '2030-01-01T00:00:00.000Z')],
      ['createdAt', (d) => (d.createdAt = '2030-01-01T00:00:00.000Z')],
      ['schema', (d) => ((d as { schema: string }).schema = 'x')],
      ['version', (d) => ((d as { version: number }).version = 2)],
    ];
    for (const [field, recipe] of recipes) {
      expect(() => s.update(`touch ${field}`, recipe as never), field).toThrow(`must not change "${field}"`);
    }
    expect(() =>
      s.update('fake revision', (d) => {
        d.threeD?.revisions.push({ rev: 1, at: T0, source: 'edit', label: 'fake', asset: ref('p1/x') });
      }),
    ).toThrow('commitModelRevision only');
    expect(docOf(store)).toEqual(project());
    expect(store.getState().history.past).toEqual([]);
    expect(store.getState().changeId).toBe(0);
    // replacing a branch around the revisions without changing them is fine, also with an equal copy of the list
    expect(s.update('ami', (d) => void (d.threeD = { ...d.threeD!, ami: { ...AMI, spiral: false } }))).toBe(true);
    expect(docOf(store).threeD?.ami.spiral).toBe(false);
    expect(s.update('ami again', (d) => void (d.threeD = { ...structuredClone(current(d.threeD!)), ami: AMI }))).toBe(true);
    expect(docOf(store).threeD?.ami.spiral).toBe(true);
  });

  it('a recipe may give a project its threeD part, or remove one that holds no revision; not one that holds revisions', () => {
    const { threeD: _none, ...flat } = project({ mode: '2d' });
    const store = opened(flat);
    const s = store.getState();
    expect(
      s.update('Make it 3D', (d) => {
        d.mode = '3d';
        d.threeD = { origin: 'describe', meshAssets: {}, revisions: [], views: [], ami: AMI };
      }),
    ).toBe(true);
    expect(docOf(store).threeD?.revisions).toEqual([]);
    expect(s.undo()).toBe(true);
    expect(docOf(store)).toEqual(flat);
    expect(s.redo()).toBe(true);
    // creating it WITH a revision is writing a revision
    const { threeD: _again, ...flat2 } = project({ mode: '2d' });
    const other = opened(flat2);
    expect(() =>
      other.getState().update('3D with a fake revision', (d) => {
        d.threeD = { origin: 'describe', meshAssets: {}, revisions: [{ rev: 1, at: T0, source: 'edit', label: 'fake', asset: ref('p1/x') }], views: [], ami: AMI };
      }),
    ).toThrow('commitModelRevision only');
    // removing a threeD without revisions is an ordinary, undoable edit
    expect(s.update('drop 3D', (d) => void delete d.threeD)).toBe(true);
    expect(docOf(store).threeD).toBeUndefined();
    expect(s.undo()).toBe(true);
    expect(docOf(store).threeD?.origin).toBe('describe');
  });

  it('refuses a recipe that removes a threeD that holds model revisions, with a message that says so', async () => {
    const store = opened();
    await store.getState().commitModelRevision(model([sphere('body')]), { label: 'first', source: 'seed', carry: 'by-id' });
    expect(docOf(store).threeD?.revisions).toHaveLength(1);
    const before = clone(docOf(store));
    expect(() => store.getState().update('drop 3D', (d) => void delete d.threeD)).toThrow(/must not remove doc\.threeD while it holds model revisions/);
    expect(docOf(store)).toEqual(before);
  });

  it('a coalesced drag is ONE history entry and one undo', () => {
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI, model: model([sphere('body'), sphere('head')]) } }));
    const before = clone(docOf(store));
    for (let i = 1; i <= 120; i++) {
      store.getState().update(
        'Move head',
        (d) => {
          const head = d.threeD?.model?.parts[1];
          if (head) head.position = [i / 10, 2, 0];
        },
        { coalesceKey: 'drag:head' },
      );
    }
    const s = store.getState();
    expect(s.history.past.map((e) => e.label)).toEqual(['Move head']);
    expect(s.history.past[0].patches).toEqual([
      { op: 'replace', path: ['threeD', 'model', 'parts', 1, 'position', 0], value: 12 },
      { op: 'replace', path: ['threeD', 'model', 'parts', 1, 'position', 1], value: 2 },
    ]); // 120 ticks, as small as one move
    expect(s.changeId).toBe(120); // every tick is a change to save …
    expect(selectModel(s)?.parts[1].position).toEqual([12, 2, 0]);
    expect(s.undo()).toBe(true); // … and one step to undo
    expect(docOf(store)).toStrictEqual(before);
    expect(store.getState().redo()).toBe(true);
    expect(selectModel(store.getState())?.parts[1].position).toEqual([12, 2, 0]);

    // endCoalescing (pointer-up) separates two drags of the same part
    store.getState().update('Move head', (d) => void (d.threeD!.model!.parts[1].position = [1, 1, 1]), { coalesceKey: 'drag:head' });
    store.getState().endCoalescing();
    store.getState().update('Move head', (d) => void (d.threeD!.model!.parts[1].position = [2, 2, 2]), { coalesceKey: 'drag:head' });
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Move head', 'Move head', 'Move head']);
  });

  it('keeps at most 200 steps', () => {
    const store = opened();
    for (let i = 1; i <= 230; i++) store.getState().update(`Rename ${i}`, (d) => (d.name = `name ${i}`));
    expect(store.getState().history.past).toHaveLength(HISTORY_LIMIT);
    let undone = 0;
    while (store.getState().undo()) undone++;
    expect(undone).toBe(200);
    expect(docOf(store).name).toBe('name 30');
  });
});

// ---- read-only

describe('a read-only project', () => {
  it('rejects update, undo, redo, putAsset and a model commit, and counts the attempts for the banner', async () => {
    const store = opened(project(), { readOnly: true });
    const s = store.getState();
    expect(s.saveStatus).toBe('read-only');
    expect(s.update('Rename', (d) => (d.name = 'Teddy'))).toBe(false);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
    await expect(s.putAsset(new Uint8Array([1]), 'application/octet-stream')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(s.commitModelRevision(model([sphere('body')]), { source: 'import', label: 'Import', carry: 'by-id' })).rejects.toBeInstanceOf(ReadOnlyError);
    const after = store.getState();
    expect(after.doc).toEqual(project());
    expect(after.rejectedEdits).toBe(5);
    expect([after.changeId, after.history.past.length, after.assets.size]).toEqual([0, 0, 0]);
    expect(selectCanUndo(after)).toBe(false);
    expect(after.beginSave()).toBeNull();
  });

  it('keeps the unsaved changes of a tab that lost its lock, so they can still be saved (§5.5.2)', () => {
    const store = opened();
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    store.getState().setReadOnly(true); // the lock was stolen
    expect(store.getState().saveStatus).toBe('unsaved');
    expect(store.getState().update('More', (d) => (d.name = 'x'))).toBe(false);
    expect(selectCanUndo(store.getState())).toBe(false);
    const ticket = store.getState().beginSave();
    expect(ticket?.doc.name).toBe('Teddy');
    if (ticket) store.getState().markSaved(ticket, { rev: 4 });
    expect(store.getState().saveStatus).toBe('read-only');
    store.getState().setReadOnly(false);
    expect(store.getState().saveStatus).toBe('saved');
    expect(store.getState().update('Again', (d) => (d.name = 'y'))).toBe(true);
  });
});

// ---- undo / redo: a long random walk through the store

function randomProjectEdit(rng: Rng, fresh: () => number): (d: ProjectDoc) => void {
  const pick = <T>(items: readonly T[]): T => items[randomInt(rng, items.length)];
  return (d) => {
    const parts = d.threeD?.model?.parts ?? [];
    switch (randomInt(rng, 13)) {
      case 0:
        d.name = `name ${fresh()}`;
        return;
      case 1:
        d.gauge.hookMm = fresh() / 100;
        return;
      case 2:
        if (d.gauge.swatch) delete d.gauge.swatch;
        else d.gauge.swatch = { sts: fresh(), rows: 20, spanIn: 4 };
        return;
      case 3:
        d.sources.push({ id: `s${fresh()}`, asset: ref(`p1/${fresh()}`), name: 'photo.jpg', w: 10, h: 10, addedAt: T0 });
        return;
      case 4:
        if (d.sources.length > 0) d.sources.splice(randomInt(rng, d.sources.length), 1);
        else d.units = d.units === 'in' ? 'cm' : 'in';
        return;
      case 5:
        if (parts.length > 0) pick(parts).position = [fresh(), fresh(), fresh()];
        else d.hand = d.hand === 'right' ? 'left' : 'right';
        return;
      case 6: {
        if (parts.length === 0) {
          d.terms = d.terms === 'us' ? 'uk' : 'us';
          return;
        }
        const part = pick(parts);
        if (part.crochet) delete part.crochet;
        else part.crochet = { make: 'piece', seamAzimuthDeg: fresh() };
        return;
      }
      case 7:
        if (d.threeD?.model) d.threeD.model.parts.push(sphere(`part_${fresh()}`, 1 + (fresh() % 7)) as never);
        else d.name = `no model ${fresh()}`;
        return;
      case 8:
        if (parts.length > 1) parts.splice(randomInt(rng, parts.length), 1);
        else d.name = `few parts ${fresh()}`;
        return;
      case 9:
        if (d.threeD) d.threeD.ami.leanStPerRnd = fresh() / 1000;
        return;
      case 10:
        if (d.qa) delete d.qa;
        else d.qa = { answers: { q: fresh() }, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'questions' };
        return;
      case 11:
        if (d.threeD) d.threeD.meshAssets[`mesh_${fresh()}`] = ref(`p1/${fresh()}`);
        return;
      default:
        if (parts.length > 0) pick(parts).paint = paint(fresh() % 3);
        else d.name = `unpainted ${fresh()}`;
    }
  };
}

describe('undo and redo through the store', () => {
  it('restore the document exactly over a long random sequence of edits, drags and model commits (seeded)', { timeout: 60_000 }, async () => {
    for (const seed of [11, 12, 13]) {
      const rng = mulberry32(seed);
      let counter = 100;
      const fresh = (): number => ++counter;
      const store = opened();
      // The reference keeps whole documents: states[i] is the document after i steps.
      let states: ProjectDoc[] = [clone(docOf(store))];
      let cursor = 0;
      let dropped = 0; // steps the cap of 200 has forgotten
      let runKey: string | undefined; // key of the open coalesced run, if any
      const pushed = (): void => {
        cursor++;
        if (cursor - dropped > HISTORY_LIMIT) dropped = cursor - HISTORY_LIMIT;
      };

      for (let step = 0; step < 700; step++) {
        const roll = rng();
        if (roll < 0.55) {
          const key = rng() < 0.4 ? `key${randomInt(rng, 2)}` : undefined;
          const idBefore = store.getState().changeId;
          store.getState().update(`edit ${step}`, randomProjectEdit(rng, fresh) as never, { coalesceKey: key });
          if (store.getState().changeId === idBefore) continue; // the edit changed nothing
          const now = clone(docOf(store));
          if (key !== undefined && runKey === key) {
            if (isDeepStrictEqual(now, states[cursor - 1])) {
              // the run came back to where it started: its step disappears
              states = states.slice(0, cursor);
              cursor--;
              runKey = undefined;
            } else {
              states = [...states.slice(0, cursor), now];
            }
          } else {
            states = [...states.slice(0, cursor + 1), now];
            pushed();
            runKey = key;
          }
        } else if (roll < 0.62) {
          const next = model([sphere('body', 1 + (fresh() % 5), { color: 'c2' }), sphere(`limb_${fresh()}`)]);
          await store.getState().commitModelRevision(next, { source: rng() < 0.5 ? 'import' : 'recon', label: `commit ${step}`, carry: rng() < 0.5 ? 'by-id' : 'none' });
          states = [...states.slice(0, cursor + 1), clone(docOf(store))];
          pushed();
          runKey = undefined;
        } else if (roll < 0.8) {
          const can = cursor > dropped;
          expect(store.getState().undo(), `seed ${seed} step ${step}`).toBe(can);
          if (can) {
            cursor--;
            runKey = undefined;
          }
        } else if (roll < 0.95) {
          const can = cursor < states.length - 1;
          expect(store.getState().redo(), `seed ${seed} step ${step}`).toBe(can);
          if (can) {
            cursor++;
            runKey = undefined;
          }
        } else {
          store.getState().endCoalescing();
          runKey = undefined;
        }
        expect(docOf(store), `seed ${seed} step ${step}`).toStrictEqual(states[cursor]);
        expect(store.getState().history.past.length, `seed ${seed} step ${step}`).toBe(cursor - dropped);
      }
      expect(dropped, 'the walk is long enough to reach the cap').toBeGreaterThan(0);

      while (cursor > dropped) {
        expect(store.getState().undo()).toBe(true);
        cursor--;
        expect(docOf(store)).toStrictEqual(states[cursor]);
      }
      expect(store.getState().undo()).toBe(false);
      while (cursor < states.length - 1) {
        expect(store.getState().redo()).toBe(true);
        cursor++;
        expect(docOf(store)).toStrictEqual(states[cursor]);
      }
      expect(selectRedoLabel(store.getState())).toBeUndefined();
    }
  });

  it('redo is exact on a document that holds one object twice (found in review: a duplicated lathe point)', () => {
    const profile: [number, number][] = [
      [0, 0],
      [1, 0.5],
      [1, 1],
      [0, 1.5],
    ];
    const body = { ...base, id: 'body', type: 'lathe', dims: { profile } } as Part;
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI, model: model([body]) } }));
    const profileOf = (): [number, number][] => (selectModel(store.getState())!.parts[0].dims as { profile: [number, number][] }).profile;
    const s = store.getState();
    // "Duplicate point": the recipe inserts the point it read from the draft, so the document holds it twice
    s.update('Duplicate point', (d) => {
      const points = (d.threeD!.model!.parts[0].dims as { profile: [number, number][] }).profile;
      points.splice(2, 0, points[1]);
    });
    expect(profileOf()[1]).toBe(profileOf()[2]);
    // "Drag point": set y, keep the profile sorted by y
    s.update('Drag point', (d) => {
      const points = (d.threeD!.model!.parts[0].dims as { profile: [number, number][] }).profile;
      points[1][1] = 0.7;
      points.sort((a, b) => a[1] - b[1]);
    });
    const dragged = [
      [0, 0],
      [1, 0.5],
      [1, 0.7],
      [1, 1],
      [0, 1.5],
    ];
    expect(profileOf()).toEqual(dragged); // one of the two moved, the other stayed
    const edited = clone(docOf(store));
    expect(store.getState().undo()).toBe(true);
    expect(profileOf()).toEqual([
      [0, 0],
      [1, 0.5],
      [1, 0.5],
      [1, 1],
      [0, 1.5],
    ]);
    expect(store.getState().redo()).toBe(true);
    expect(profileOf()).toEqual(dragged); // immer's own patches gave [1, 0.7] twice here
    expect(docOf(store)).toStrictEqual(edited);
    store.getState().undo();
    store.getState().undo();
    expect(profileOf()).toEqual(profile);
  });

  it('records nothing for a recipe that ends where it started (found in review: a draft replaced by its original)', () => {
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI, model: model([sphere('body', 2), sphere('head', 1)]) } }));
    const before = store.getState();
    expect(
      store.getState().update('Try a color, then reset the part', (d) => {
        const part = d.threeD!.model!.parts[0];
        part.color = 'c2';
        d.threeD!.model!.parts[0] = original(part) as never;
      }),
    ).toBe(true);
    // immer's own patches recorded "color = c2" for this, and a redo then produced a document the user never had
    const after = store.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.history.past).toEqual([]);
    expect([after.changeId, after.saveStatus]).toEqual([0, 'saved']);
    // the same for a branch replaced by an equal copy
    store.getState().update('Equal copy', (d) => void (d.threeD!.model = structuredClone(current(d.threeD!.model!)) as never));
    expect(store.getState().doc).toBe(before.doc);
    expect(store.getState().history.past).toEqual([]);
  });

  it('never moves rev, updatedAt or id, which persistence owns', () => {
    const store = opened();
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    store.getState().markSaved(ticket, { rev: 4 });
    expect(docOf(store)).toMatchObject({ rev: 4, updatedAt: CLOCK, name: 'Teddy' });
    expect(store.getState().undo()).toBe(true);
    expect(docOf(store)).toMatchObject({ rev: 4, updatedAt: CLOCK, name: 'Bunny', id: 'p1' });
    expect(store.getState().saveStatus).toBe('unsaved'); // the undo is a change to save
    expect(store.getState().redo()).toBe(true);
    expect(docOf(store)).toMatchObject({ rev: 4, updatedAt: CLOCK, name: 'Teddy' });
  });
});

// ---- assets

describe('sha256Hex', () => {
  it('matches the published vectors and node:crypto on many lengths', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    const rng = mulberry32(5);
    for (const n of [...Array.from({ length: 140 }, (_, i) => i), 255, 256, 257, 1000, 4096, 65_537, 300_000, 1 << 20, (1 << 20) + 55]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = Math.floor(rng() * 256);
      expect(sha256Hex(bytes), `length ${n}`).toBe(nodeSha256(bytes));
    }
    // a view into a larger buffer hashes its own bytes only
    const big = new Uint8Array(1000).map((_, i) => (i * 131 + 7) & 255);
    const view = big.subarray(13, 13 + 119);
    expect(sha256Hex(view)).toBe(nodeSha256(view));
  });
});

describe('putAsset and the asset cache', () => {
  it('returns the content-addressed ref <projectId>/<sha256> and caches the bytes', async () => {
    const store = opened();
    const bytes = new TextEncoder().encode('a photo, really');
    const asset = await store.getState().putAsset(bytes, 'image/jpeg');
    const sha = nodeSha256(bytes);
    expect(asset).toEqual({ key: `p1/${sha}`, mime: 'image/jpeg', bytes: bytes.length, sha256: sha });
    const s = store.getState();
    expect([...s.assets.keys()]).toEqual([asset.key]);
    expect([...s.unsavedAssetKeys]).toEqual([asset.key]);
    const blob = await s.getAsset(asset);
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(await s.getAsset(asset.key)).toBe(blob);
    expect(s.saveStatus).toBe('saved'); // an asset alone is not a change of the document
  });

  it('dedupes identical bytes: one key, one stored blob', async () => {
    const store = opened();
    const put = store.getState().putAsset;
    const a = await put(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
    const first = store.getState().assets.get(a.key);
    const b = await put(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
    const c = await put(new Uint8Array([1, 2, 3, 4]).buffer, 'application/octet-stream'); // an ArrayBuffer
    const d = await put(new Blob([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), 'application/octet-stream'); // a Blob
    const e = await put(new Uint8Array([1, 2, 3, 4]), 'image/png'); // the key is the content, not the type
    const other = await put(new Uint8Array([1, 2, 3, 5]), 'application/octet-stream');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
    expect(e.key).toBe(a.key);
    // the ref describes the blob stored under the key (the first one), not this call's label
    expect(e.mime).toBe('application/octet-stream');
    expect((await store.getState().getAsset(e)).type).toBe(e.mime);
    expect(other.key).not.toBe(a.key);
    expect(store.getState().assets.size).toBe(2);
    expect(store.getState().assets.get(a.key)).toBe(first);
    // concurrent puts of the same bytes
    const many = await Promise.all(Array.from({ length: 8 }, () => put(new Uint8Array([9, 9, 9]), 'application/octet-stream')));
    expect(new Set(many.map((m) => m.key)).size).toBe(1);
    expect(store.getState().assets.size).toBe(3);
  });

  it('normalizes the mime as Blob does, and the ref of a dedupe hit names the stored blob’s type', async () => {
    const store = opened();
    const png = await store.getState().putAsset(new Uint8Array([1, 2, 3]), 'Image/PNG');
    expect(png.mime).toBe('image/png');
    const again = await store.getState().putAsset(new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect(again).toEqual(png);
    expect((await store.getState().getAsset(again)).type).toBe('image/png');
  });

  it('stores a snapshot: changing the caller’s array afterwards does not change the asset', async () => {
    const store = opened();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = store.getState().putAsset(bytes, 'application/octet-stream');
    bytes.fill(7); // before the hash was even computed
    const asset = await pending;
    expect(asset.sha256).toBe(nodeSha256(new Uint8Array([1, 2, 3])));
    expect(new Uint8Array(await (await store.getState().getAsset(asset)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('keeps a Blob of the right type as it is', async () => {
    const store = opened();
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const asset = await store.getState().putAsset(blob, 'text/plain');
    expect(store.getState().assets.get(asset.key)).toBe(blob);
    expect(asset.bytes).toBe(5);
  });

  it('rejects without a project, and when the project is closed while hashing', async () => {
    const store = createProjectStore();
    await expect(store.getState().putAsset(new Uint8Array(1), 'x/y')).rejects.toThrow('no project is open');
    store.getState().open(project());
    const pending = store.getState().putAsset(new Uint8Array(1), 'x/y');
    store.getState().open(project({ id: 'p2' })); // another project took its place
    await expect(pending).rejects.toThrow('closed while the asset was being stored');
    expect(store.getState().assets.size).toBe(0);
  });

  it('loads what is not cached through the loader T8 registers, once', async () => {
    const store = opened();
    const s = store.getState();
    await expect(s.getAsset('p1/missing')).rejects.toBeInstanceOf(AssetMissingError);
    const calls: [string, AssetRef | undefined][] = [];
    const stored = new Blob(['stored']);
    s.setAssetLoader(async (key, r) => {
      calls.push([key, r]);
      await Promise.resolve();
      return key === 'p1/stored' ? stored : undefined;
    });
    const wanted = ref('p1/stored');
    const [a, b] = await Promise.all([s.getAsset(wanted), s.getAsset('p1/stored')]);
    expect(a).toBe(stored);
    expect(b).toBe(stored);
    expect(calls).toEqual([['p1/stored', wanted]]);
    expect(await s.getAsset('p1/stored')).toBe(stored); // now from the cache
    expect(calls).toHaveLength(1);
    expect(store.getState().unsavedAssetKeys.size).toBe(0); // a loaded asset is already stored
    const missing: unknown = await s.getAsset('p1/unknown').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(AssetMissingError);
    expect((missing as AssetMissingError).key).toBe('p1/unknown');
    s.cacheAsset('p1/direct', stored);
    expect(await s.getAsset('p1/direct')).toBe(stored);
  });
});

describe('uncacheAssets', () => {
  it('frees saved assets, which then load again through the loader, and never drops an unsaved one', async () => {
    const store = opened();
    const s = store.getState();
    const saved = await s.putAsset(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    s.update('Use it', (d) => d.sources.push({ id: 's1', asset: saved, name: 'a.png', w: 1, h: 1, addedAt: T0 }));
    const unreferenced = await s.putAsset(new Uint8Array([4, 5, 6]), 'application/octet-stream'); // saved with the ticket too
    const repository = new Map(store.getState().assets); // what a repository would hold after the save
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    const later = await s.putAsset(new Uint8Array([7, 8, 9]), 'application/octet-stream'); // added during the save
    store.getState().markSaved(ticket, { rev: 4 });

    s.uncacheAssets([saved.key, unreferenced.key, later.key, 'p1/unknown']);
    const after = store.getState();
    expect([...after.assets.keys()]).toEqual([later.key]); // the one that is not saved yet stays
    expect([...after.unsavedAssetKeys]).toEqual([later.key]);

    let loads = 0;
    s.setAssetLoader(async (key) => {
      loads++;
      return repository.get(key);
    });
    expect(new Uint8Array(await (await s.getAsset(saved)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(loads).toBe(1);
    expect(store.getState().assets.has(saved.key)).toBe(true); // cached again
    s.uncacheAssets([]); // nothing to do: no new Map
    expect(store.getState().assets).toBe(store.getState().assets);
  });
});

// ---- commitModelRevision

async function readRevision(store: ProjectStore, rev: number) {
  return store.getState().readModelRevision(rev);
}

describe('commitModelRevision', () => {
  it('sets the first model of a project (there is none to carry from) and appends revision 1', async () => {
    const store = opened();
    const first = model([sphere('body', 2), sphere('head', 1)]);
    const report = await store.getState().commitModelRevision(first, { source: 'recon', label: 'Built from photos', carry: 'by-id' });
    expect(report).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });

    const doc = docOf(store);
    expect(doc.threeD?.model).toEqual(first);
    expect(doc.threeD?.revisions).toHaveLength(1);
    const revision = doc.threeD!.revisions[0];
    expect(revision).toMatchObject({ rev: 1, at: CLOCK, source: 'recon', label: 'Built from photos' });
    expect(revision.asset.key).toBe(`p1/${revision.asset.sha256}`);
    expect(revision.asset.mime).toBe(MODEL_REVISION_MIME);

    // the asset holds the model of this revision
    const blob = await store.getState().getAsset(revision.asset);
    expect(blob.size).toBe(revision.asset.bytes);
    expect(nodeSha256(new Uint8Array(await blob.arrayBuffer()))).toBe(revision.asset.sha256);
    expect(JSON.parse(await blob.text())).toEqual({ format: 'crochet-model-revision', version: 1, model: first, meshAssets: {} });
    expect((await readRevision(store, 1)).model).toEqual(first);

    // one history step
    const s = store.getState();
    expect(s.history.past.map((e) => e.label)).toEqual(['Built from photos']);
    expect([s.changeId, s.saveStatus]).toEqual([1, 'unsaved']);
    expect([...s.unsavedAssetKeys]).toEqual([revision.asset.key]);
    expect(s.undo()).toBe(true);
    expect(docOf(store)).toStrictEqual(project());
    expect(store.getState().redo()).toBe(true);
    expect(docOf(store)).toStrictEqual(doc);
  });

  it('replaces the model with a new revision and keeps the previous one', async () => {
    const store = opened();
    const s = store.getState();
    const first = model([sphere('body', 2)]);
    const second = model([sphere('body', 2.5), sphere('head', 1)], { name: 'refined' });
    await s.commitModelRevision(first, { source: 'recon', label: 'Built from photos', carry: 'by-id' });
    await s.commitModelRevision(second, { source: 'import', label: 'Imported from Claude Design', carry: 'by-id' });
    const revisions = docOf(store).threeD!.revisions;
    // the first model was not edited in between, so its revision already holds it: no extra entry
    expect(revisions.map((r) => [r.rev, r.source, r.label])).toEqual([
      [1, 'recon', 'Built from photos'],
      [2, 'import', 'Imported from Claude Design'],
    ]);
    expect(selectModel(store.getState())).toEqual(second);
    expect((await readRevision(store, 1)).model).toEqual(first);
    expect((await readRevision(store, 2)).model).toEqual(second);
    expect(store.getState().history.past).toHaveLength(2);
  });

  it('snapshots the model the user edited before replacing it, so nothing edited is lost', async () => {
    const store = opened();
    const s = store.getState();
    await s.commitModelRevision(model([sphere('body', 2), sphere('head', 1)]), { source: 'recon', label: 'Built from photos', carry: 'by-id' });
    // the user works on the model in place
    s.update('Paint body', (d) => void (d.threeD!.model!.parts[0].paint = paint(1) as never));
    s.update('Body as appliqué', (d) => void (d.threeD!.model!.parts[0].crochet = { make: 'applique' }));
    s.update('Move head', (d) => void (d.threeD!.model!.parts[1].position = [0, 3, 0]));
    const edited = clone(selectModel(store.getState()));

    // the import comes back with a much bigger body: its paint cannot be carried
    const imported = model([sphere('body', 4), sphere('head', 1)]);
    const report = await s.commitModelRevision(imported, { source: 'import', label: 'Imported from Claude Design', carry: 'by-id' });
    expect(report).toEqual({ crochet: ['body'], paint: [], paintDropped: ['body'], features: [] });

    const doc = docOf(store);
    expect(doc.threeD!.revisions.map((r) => [r.rev, r.source, r.label])).toEqual([
      [1, 'recon', 'Built from photos'],
      [2, 'edit', 'Before: Imported from Claude Design'],
      [3, 'import', 'Imported from Claude Design'],
    ]);
    // the new model: hints carried, paint not
    expect(doc.threeD!.model!.parts[0]).toMatchObject({ dims: { r: 4 }, crochet: { make: 'applique' } });
    expect(doc.threeD!.model!.parts[0].paint).toBeUndefined();
    expect(doc.threeD!.model!.parts[1].position).toEqual([0, 0, 0]); // geometry is the new model's
    // "it stays in the previous revision" (§3.7.7): the edited model, paint included
    const previous = await readRevision(store, 2);
    expect(previous.model).toEqual(edited);
    expect(previous.model.parts[0].paint).toEqual(paint(1));
    expect((await readRevision(store, 3)).model).toEqual(doc.threeD!.model);

    // still ONE undo step, which also takes both revision entries back
    expect(store.getState().history.past.map((e) => e.label).slice(-1)).toEqual(['Imported from Claude Design']);
    expect(store.getState().undo()).toBe(true);
    expect(selectModel(store.getState())).toEqual(edited);
    expect(docOf(store).threeD!.revisions.map((r) => r.rev)).toEqual([1]);
    // the revision assets stay in the store either way, and go out with the next save
    const ticket = store.getState().beginSave();
    expect(ticket?.newAssets.size).toBe(3);
    expect(store.getState().redo()).toBe(true);
    expect(docOf(store)).toStrictEqual(doc);
  });

  it('carries by id per the rules, honors carryPaintAnyway, and carries nothing with carry: none', async () => {
    const seed = model([
      sphere('body', 2, { crochet: { make: 'piece', start: 'top' }, paint: paint(1) }),
      sphere('head', 1, { paint: paint(2) }),
      sphere('tail', 0.5, { paint: paint(0), crochet: { make: 'skip' } }),
    ]);
    const next = model([sphere('body', 2.1), sphere('head', 1.5), sphere('tail', 0.5), sphere('nose', 0.2)]);
    const start = project({ threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI, model: seed } });

    const byId = opened(start);
    const report = await byId.getState().commitModelRevision(next, { source: 'import', label: 'Import', carry: 'by-id' });
    expect(report).toEqual({ crochet: ['body', 'tail'], paint: ['body', 'tail'], paintDropped: ['head'], features: [] });
    const parts = selectModel(byId.getState())!.parts;
    expect(parts[0]).toMatchObject({ dims: { r: 2.1 }, crochet: { make: 'piece', start: 'top' }, paint: paint(1) });
    expect(parts[1].paint).toBeUndefined();
    expect(parts[2]).toMatchObject({ crochet: { make: 'skip' }, paint: paint(0) });
    expect(parts[3]).toEqual(sphere('nose', 0.2));

    const anyway = opened(start);
    const forced = await anyway.getState().commitModelRevision(next, { source: 'import', label: 'Import', carry: 'by-id', carryPaintAnyway: ['head'] });
    expect(forced).toEqual({ crochet: ['body', 'tail'], paint: ['body', 'head', 'tail'], paintDropped: [], features: [] });
    expect(selectModel(anyway.getState())!.parts[1].paint).toEqual(paint(2));

    const none = opened(start);
    const nothing = await none.getState().commitModelRevision(next, { source: 'edit', label: 'Replace', carry: 'none', carryPaintAnyway: ['head'] });
    expect(nothing).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });
    expect(selectModel(none.getState())).toEqual(next);

    // a project opened with a model but no revision yet: the outgoing model becomes revision 1
    expect(docOf(byId).threeD!.revisions.map((r) => [r.rev, r.source])).toEqual([
      [1, 'edit'],
      [2, 'import'],
    ]);
    expect((await readRevision(byId, 1)).model).toEqual(seed);
  });

  it('does not change, keep or freeze the model it is given', async () => {
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets: {}, revisions: [], views: [], ami: AMI, model: model([sphere('body', 2, { crochet: { make: 'piece' } })]) } }));
    const next = model([sphere('body', 2), sphere('head', 1)]);
    const before = clone(next);
    await store.getState().commitModelRevision(next, { source: 'import', label: 'Import', carry: 'by-id' });
    expect(next).toEqual(before);
    expect(selectModel(store.getState())!.parts[0].crochet).toEqual({ make: 'piece' });
    // the caller may go on using its object; the document has its own copy
    expect(Object.isFrozen(next)).toBe(false);
    expect(Object.isFrozen(next.parts[1])).toBe(false);
    next.parts[1].position = [9, 9, 9];
    next.name = 'changed by the caller afterwards';
    expect(selectModel(store.getState())).toMatchObject({ name: 'toy', parts: [{ id: 'body' }, { id: 'head', position: [0, 0, 0] }] });
    expect(Object.isFrozen(selectModel(store.getState())!.parts[1])).toBe(true);

    // the same without carry-over, where the model goes in as it is
    const plainNext = model([sphere('tail', 1)]);
    await store.getState().commitModelRevision(plainNext, { source: 'edit', label: 'Replace', carry: 'none' });
    expect(Object.isFrozen(plainNext)).toBe(false);
    expect(selectModel(store.getState())).not.toBe(plainNext);
    expect(selectModel(store.getState())).toEqual(plainNext);
  });

  it('does nothing when the model would not change', async () => {
    const store = opened();
    const s = store.getState();
    const m = model([sphere('body', 2)]);
    await s.commitModelRevision(m, { source: 'recon', label: 'Built', carry: 'none' });
    const before = store.getState();
    const report = await s.commitModelRevision(clone(m), { source: 'edit', label: 'Scale to the same height', carry: 'none' });
    expect(report).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });
    const after = store.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.history).toBe(before.history);
    expect(after.changeId).toBe(before.changeId);
  });

  it('continues the numbering after the highest revision, and stamps the injected time', async () => {
    const existing = { rev: 7, at: T0, source: 'seed' as const, label: 'Seed', asset: ref('p1/seedsha') };
    const store = opened(project({ threeD: { origin: 'describe', meshAssets: {}, revisions: [existing], views: [], ami: AMI } }));
    await store.getState().commitModelRevision(model([sphere('body')]), { source: 'import', label: 'Import', carry: 'by-id' });
    expect(docOf(store).threeD!.revisions.map((r) => [r.rev, r.at])).toEqual([
      [7, T0],
      [8, CLOCK],
    ]);
    // a stored list with malformed entries (an old or damaged file): only integer revs count (found in review:
    // NaN gave NaN, 1.5 gave 2.5)
    const cases: [number[], number][] = [
      [[Number.NaN], 1],
      [[1.5], 1],
      [[1.5, 2], 3],
      [[-5], 1],
      [[1, 1], 2],
      [[3, 1], 4],
    ];
    for (const [revs, expected] of cases) {
      const revisions = revs.map((rev, i) => ({ rev, at: T0, source: 'seed' as const, label: 'Seed', asset: ref(`p1/seed${i}`) }));
      const odd = opened(project({ threeD: { origin: 'describe', meshAssets: {}, revisions, views: [], ami: AMI } }));
      await odd.getState().commitModelRevision(model([sphere('body')]), { source: 'import', label: 'Import', carry: 'by-id' });
      expect(docOf(odd).threeD!.revisions.at(-1)?.rev, String(revs)).toBe(expected);
    }
  });

  it('records the mesh assets of the model’s mesh parts in the revision', async () => {
    const meshAssets = { m1: ref('p1/m1sha'), 'sdf:m1': ref('p1/m1sdf'), m2: ref('p1/m2sha'), unrelated: ref('p1/zzz') };
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets, revisions: [], views: [], ami: AMI } }));
    await store.getState().commitModelRevision(model([meshPart('body', 'm1'), sphere('head')]), { source: 'recon', label: 'Built', carry: 'none' });
    expect((await readRevision(store, 1)).meshAssets).toEqual({ m1: meshAssets.m1, 'sdf:m1': meshAssets['sdf:m1'] });
  });

  it('commitModelRevisionWith changes more of the document in the same undo step', async () => {
    const store = opened(
      project({
        qa: { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: T0, seedRev: 3, via: 'copy' } },
      }),
    );
    const before = clone(docOf(store));
    const original = ref('p1/originalfile');
    let seenRev = 0;
    const report = await store.getState().commitModelRevisionWith(model([meshPart('body', 'm9')]), {
      source: 'import',
      label: 'Imported from Claude Design',
      carry: 'by-id',
      also: (d, info) => {
        seenRev = info.rev;
        expect(info.report).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });
        d.imports.push({ id: 'i1', at: T0, fileName: 'toy.zip', carrier: 'zip', dialect: 'canonical-1', confidence: 'high', repairs: [], original, revision: info.rev });
        if (d.qa) delete d.qa.awaiting;
        if (d.threeD) d.threeD.meshAssets.m9 = ref('p1/m9sha');
      },
    });
    expect(report.crochet).toEqual([]);
    expect(seenRev).toBe(1);
    const doc = docOf(store);
    expect(doc.imports).toHaveLength(1);
    expect(doc.imports[0].revision).toBe(doc.threeD!.revisions[0].rev);
    expect(doc.qa?.awaiting).toBeUndefined();
    // the snapshot was taken after `also`: it knows the mesh asset written there
    expect((await readRevision(store, 1)).meshAssets).toEqual({ m9: ref('p1/m9sha') });
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().undo();
    expect(docOf(store)).toStrictEqual(before);
  });

  it('lets `also` replace threeD as a whole, but not drop the model or change the revision list (found in review)', async () => {
    const store = opened();
    const s = store.getState();
    await s.commitModelRevision(model([sphere('body', 2)]), { source: 'recon', label: 'A', carry: 'none' });
    s.update('Edit', (d) => void (d.threeD!.model!.parts[0].position = [9, 9, 9]));
    const before = store.getState();
    const attempts: [string, NonNullable<CommitOptions['also']>, RegExp][] = [
      ['wipe the list', (d) => void (d.threeD!.revisions.length = 0), /must not change threeD.revisions/],
      ['relabel a revision', (d) => void (d.threeD!.revisions[0].label = 'renamed'), /must not change threeD.revisions/],
      ['add a revision', (d) => void d.threeD!.revisions.push({ rev: 50, at: T0, source: 'edit', label: 'fake', asset: ref('p1/fake') }), /must not change threeD.revisions/],
      ['drop threeD', (d) => void delete d.threeD, /removed doc.threeD/],
      ['drop the model', (d) => void delete d.threeD!.model, /removed the model/],
    ];
    for (const [name, also, message] of attempts) {
      await expect(s.commitModelRevisionWith(model([sphere('body', 3)]), { source: 'import', label: name, carry: 'none', also }), name).rejects.toThrow(message);
      const after = store.getState();
      expect([after.doc, after.history, after.assets, after.changeId], name).toEqual([before.doc, before.history, before.assets, before.changeId]);
      expect(after.doc, name).toBe(before.doc);
    }
    // replacing the whole branch is fine: the new revisions go into the branch `also` left
    await s.commitModelRevisionWith(model([sphere('body', 3)]), {
      source: 'import',
      label: 'B',
      carry: 'none',
      also: (d) => void (d.threeD = { ...d.threeD!, ami: { ...AMI, spiral: false } }),
    });
    const doc = docOf(store);
    expect(doc.threeD!.ami.spiral).toBe(false);
    expect(doc.threeD!.model).toEqual(model([sphere('body', 3)]));
    expect(doc.threeD!.revisions.map((r) => [r.rev, r.source, r.label])).toEqual([
      [1, 'recon', 'A'],
      [2, 'edit', 'Before: B'],
      [3, 'import', 'B'],
    ]);
    expect((await readRevision(store, 2)).model.parts[0].position).toEqual([9, 9, 9]);
    expect((await readRevision(store, 3)).model).toEqual(model([sphere('body', 3)]));
    // also when the new branch shares nothing with the draft (before the fix the entry went into the detached draft)
    await s.commitModelRevisionWith(model([sphere('body', 4)]), {
      source: 'import',
      label: 'C',
      carry: 'none',
      also: (d) => void (d.threeD = { ...structuredClone(current(d.threeD!)), ami: AMI }),
    });
    expect(docOf(store).threeD!.revisions.map((r) => [r.rev, r.label])).toEqual([
      [1, 'A'],
      [2, 'Before: B'],
      [3, 'B'],
      [4, 'C'],
    ]);
    expect((await readRevision(store, 4)).model).toEqual(model([sphere('body', 4)]));
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['A', 'Edit', 'B', 'C']);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().undo()).toBe(true);
    expect(docOf(store)).toStrictEqual(before.doc);
  });

  it('with `also`, appends a revision even for an unchanged model, so a record that names `info.rev` finds it', async () => {
    const store = opened();
    const s = store.getState();
    const m = model([sphere('body', 2)]);
    await s.commitModelRevision(m, { source: 'recon', label: 'Built', carry: 'none' });
    const assets = store.getState().assets;
    let named = 0;
    await s.commitModelRevisionWith(clone(m), {
      source: 'import',
      label: 'Imported the same model',
      carry: 'by-id',
      also: (d, info) => {
        named = info.rev;
        d.imports.push({ id: 'i1', at: T0, fileName: 'toy.json', carrier: 'json', dialect: 'canonical-1', confidence: 'high', repairs: [], original: ref('p1/file'), revision: info.rev });
      },
    });
    const revisions = docOf(store).threeD!.revisions;
    expect(revisions.map((r) => [r.rev, r.label])).toEqual([
      [1, 'Built'],
      [2, 'Imported the same model'],
    ]);
    expect(named).toBe(2);
    expect(docOf(store).imports[0].revision).toBe(2);
    expect(revisions[1].asset).toEqual(revisions[0].asset); // the same content: one asset
    expect(store.getState().assets).toBe(assets); // nothing new to store
  });

  it('rejects, and changes nothing, without a project, without a 3D part, or with something that is not a model', async () => {
    const options = { source: 'import', label: 'Import', carry: 'by-id' } as const;
    await expect(createProjectStore().getState().commitModelRevision(model([sphere('body')]), options)).rejects.toThrow('no project is open');
    const twoD = opened(project({ mode: '2d', threeD: undefined }));
    await expect(twoD.getState().commitModelRevision(model([sphere('body')]), options)).rejects.toThrow('no 3D part');
    const store = opened();
    await expect(store.getState().commitModelRevision({ schema: 'nope' } as unknown as CrochetModelV1, options)).rejects.toThrow('not a crochet-model');
    await expect(store.getState().commitModelRevisionWith(model([sphere('body')]), { ...options, also: () => { throw new Error('also failed'); } })).rejects.toThrow('also failed');
    expect(docOf(store)).toEqual(project());
    expect(store.getState().assets.size).toBe(0);
    expect(store.getState().history.past).toEqual([]);
  });

  it('reverts to a stored revision as a new revision, with the mesh assets it had', async () => {
    const store = opened(project({ threeD: { origin: 'multiview', meshAssets: { m1: ref('p1/m1-v1') }, revisions: [], views: [], ami: AMI } }));
    const s = store.getState();
    const first = model([meshPart('body', 'm1')]);
    await s.commitModelRevision(first, { source: 'recon', label: 'Built from photos', carry: 'none' });
    // sculpting writes a new mesh under the same meshRef (copy-on-write asset keys, §4.4)
    s.update('Sculpt body', (d) => void (d.threeD!.meshAssets.m1 = ref('p1/m1-v2')));
    await s.commitModelRevision(model([sphere('body', 2)]), { source: 'import', label: 'Import', carry: 'none' });
    expect(docOf(store).threeD!.revisions.map((r) => r.rev)).toEqual([1, 2, 3]);

    await s.revertToModelRevision(1);
    const doc = docOf(store);
    expect(doc.threeD!.model).toEqual(first);
    expect(doc.threeD!.meshAssets.m1).toEqual(ref('p1/m1-v1')); // the mesh of that revision, not the sculpted one
    expect(doc.threeD!.revisions.map((r) => [r.rev, r.source, r.label])).toEqual([
      [1, 'recon', 'Built from photos'],
      [2, 'edit', 'Before: Import'],
      [3, 'import', 'Import'],
      [4, 'edit', 'Revert to revision 1: Built from photos'],
    ]);
    expect(doc.threeD!.revisions[3].asset).toEqual(doc.threeD!.revisions[0].asset); // same content, stored once
    await s.revertToModelRevision(1); // already current: nothing happens
    expect(docOf(store)).toBe(doc);
    store.getState().undo();
    expect(selectModel(store.getState())).toEqual(model([sphere('body', 2)]));
    await expect(s.revertToModelRevision(99)).rejects.toThrow('no model revision 99');
  });

  it('has the frozen signature of §5.2.1, as a function and as a store action', () => {
    expectTypeOf(commitModelRevision).toEqualTypeOf<CommitModelRevisionFn>();
    expectTypeOf(projectStore.getState().commitModelRevision).toEqualTypeOf<CommitModelRevisionFn>();
  });

  it('the module-level commitModelRevision acts on the app store', async () => {
    projectStore.getState().open(project({ id: 'app' }), { discardUnsaved: true });
    const report = await commitModelRevision(model([sphere('body')]), { source: 'seed', label: 'Seed', carry: 'by-id' });
    expect(report).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });
    expect(projectStore.getState().doc?.threeD?.revisions.map((r) => r.source)).toEqual(['seed']);
    projectStore.getState().close({ discardUnsaved: true });
  });
});

// ---- what T8's autosave builds on

describe('save hooks', () => {
  it('beginSave hands out a snapshot with the unsaved assets; markSaved writes rev and updatedAt', async () => {
    const store = opened();
    const s = store.getState();
    expect(s.beginSave()).toBeNull(); // nothing to save
    const asset = await s.putAsset(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(s.beginSave()).toBeNull(); // an asset nobody references yet is not a change
    s.update('Add source', (d) => d.sources.push({ id: 's1', asset, name: 'a.png', w: 1, h: 1, addedAt: T0 }));

    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    expect(ticket.baseRev).toBe(3);
    expect(ticket.changeId).toBe(1);
    expect(ticket.doc).toEqual({ ...docOf(store), updatedAt: CLOCK });
    expect(Object.isFrozen(ticket.doc)).toBe(true);
    expect([...ticket.newAssets.keys()]).toEqual([asset.key]);
    expect(ticket.newAssets.get(asset.key)).toBe(store.getState().assets.get(asset.key));
    expect(store.getState().saveStatus).toBe('saving');
    expect(store.getState().beginSave()).toBeNull(); // one save at a time
    expect(docOf(store).updatedAt).toBe(T0); // not before the save succeeded

    expect(store.getState().markSaved(ticket, { rev: 4 })).toBe(true);
    const after = store.getState();
    expect(after.doc).toMatchObject({ rev: 4, updatedAt: CLOCK });
    expect([after.baseRev, after.savedChangeId, after.saveStatus, after.saveError]).toEqual([4, 1, 'saved', null]);
    expect(after.unsavedAssetKeys.size).toBe(0);
    expect(after.assets.has(asset.key)).toBe(true); // still cached
    expect(after.history.past).toHaveLength(1); // saving does not touch the history
    expect(after.markSaved(ticket, { rev: 5 })).toBe(false); // a ticket ends once
    expect(store.getState().baseRev).toBe(4);
  });

  it('stays unsaved when the user kept working during the save', async () => {
    const store = opened();
    store.getState().update('One', (d) => (d.name = 'one'));
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    store.getState().update('Two', (d) => (d.name = 'two'));
    const late = await store.getState().putAsset(new Uint8Array([5]), 'application/octet-stream');
    store.getState().markSaved(ticket, { rev: 4 });
    const s = store.getState();
    expect(ticket.doc.name).toBe('one');
    expect(s.doc).toMatchObject({ name: 'two', rev: 4 });
    expect([s.saveStatus, s.savedChangeId, s.changeId]).toEqual(['unsaved', 1, 2]);
    expect([...s.unsavedAssetKeys]).toEqual([late.key]);
    const next = s.beginSave();
    expect(next?.baseRev).toBe(4);
    expect(next?.doc.name).toBe('two');
    expect([...(next?.newAssets.keys() ?? [])]).toEqual([late.key]);
  });

  it('a failed save leaves everything to be saved again', async () => {
    const store = opened();
    const asset = await store.getState().putAsset(new Uint8Array([1]), 'application/octet-stream');
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    expect(store.getState().markSaveFailed(ticket, new Error('QuotaExceededError'))).toBe(true);
    const s = store.getState();
    expect([s.saveStatus, s.saveError, s.savedChangeId]).toEqual(['error', 'QuotaExceededError', 0]);
    expect(s.doc?.rev).toBe(3);
    expect(s.markSaveFailed(ticket, 'again')).toBe(false);
    expect(s.markSaved(ticket, { rev: 5 })).toBe(false); // a failed ticket cannot succeed later
    expect([store.getState().doc?.rev, store.getState().baseRev]).toEqual([3, 3]);
    const retry = s.beginSave();
    expect(retry?.id).not.toBe(ticket.id);
    expect([...(retry?.newAssets.keys() ?? [])]).toEqual([asset.key]);
    expect(store.getState().saveStatus).toBe('saving');
    if (retry) store.getState().markSaved(retry, { rev: 4 });
    expect([store.getState().saveStatus, store.getState().saveError]).toEqual(['saved', null]);
  });

  it('ignores a ticket of a project that is no longer open', () => {
    const store = opened();
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    store.getState().open(project({ id: 'p2', rev: 10 }), { discardUnsaved: true });
    expect(store.getState().markSaved(ticket, { rev: 4 })).toBe(false);
    expect(store.getState().markSaveFailed(ticket, 'x')).toBe(false);
    expect(store.getState().rebind(ticket, { id: 'copy', rev: 1 })).toBe(false);
    expect(store.getState().doc).toMatchObject({ id: 'p2', rev: 10 });
    expect(store.getState().baseRev).toBe(10);
  });

  it('rebind continues in the conflict copy: new id, rev and name, same history (§5.5.2)', async () => {
    const store = opened();
    store.getState().update('Rename', (d) => (d.name = 'Teddy'));
    const old = await store.getState().putAsset(new Uint8Array([1]), 'application/octet-stream');
    const ticket = store.getState().beginSave();
    if (!ticket) throw new Error('expected a ticket');
    const hashing = store.getState().putAsset(new Uint8Array([3]), 'application/octet-stream'); // still hashing during the rebind
    // repo.save answered { ok: false, conflict }; repo.saveAsCopy stored the ticket's document as a new project
    expect(store.getState().rebind(ticket, { id: 'p1-copy', rev: 1, name: 'Teddy (copy, 12:34)' })).toBe(true);
    const s = store.getState();
    expect(s.doc).toMatchObject({ id: 'p1-copy', rev: 1, name: 'Teddy (copy, 12:34)', updatedAt: CLOCK });
    expect([s.baseRev, s.saveStatus, s.unsavedAssetKeys.size]).toEqual([1, 'saved', 0]);
    // an asset that was still being hashed is keyed by the project it will be saved with
    const late = await hashing;
    expect(late.key.startsWith('p1-copy/')).toBe(true);
    expect(store.getState().unsavedAssetKeys.has(late.key)).toBe(true);
    // later saves go to the copy: exactly one copy per conflict
    s.update('More', (d) => (d.units = 'cm'));
    expect(store.getState().beginSave()).toMatchObject({ baseRev: 1, doc: { id: 'p1-copy' } });
    // new assets are keyed by the copy's id; old refs keep their keys
    const fresh = await store.getState().putAsset(new Uint8Array([2]), 'application/octet-stream');
    expect(fresh.key.startsWith('p1-copy/')).toBe(true);
    expect(old.key.startsWith('p1/')).toBe(true);
    expect(store.getState().assets.has(old.key)).toBe(true);
    // the history survived
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Rename', 'More']);
    expect(() => store.getState().rebind(ticket, { id: 'a/b', rev: 1 })).toThrow('invalid project id');
  });

  it('exposes every change to a subscriber together with the previous state', async () => {
    const store = opened();
    const seen: [number, number, string][] = [];
    store.subscribe((state, prev) => {
      if (state.changeId !== prev.changeId) seen.push([prev.changeId, state.changeId, state.doc?.name ?? '']);
    });
    store.getState().update('a', (d) => (d.name = 'a'));
    store.getState().update('b', (d) => (d.name = 'b'));
    store.getState().undo();
    store.getState().redo();
    await store.getState().commitModelRevision(model([sphere('body')]), { source: 'seed', label: 'Seed', carry: 'none' });
    expect(seen).toEqual([
      [0, 1, 'a'],
      [1, 2, 'b'],
      [2, 3, 'a'],
      [3, 4, 'b'],
      [4, 5, 'b'],
    ]);
  });
});
