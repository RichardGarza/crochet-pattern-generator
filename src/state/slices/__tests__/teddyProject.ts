// Test helpers of track T6: the canonical teddy (fixtures/models/teddy.canonical.json) as a model and as an
// open 3D project.
import teddyJson from '../../../../fixtures/models/teddy.canonical.json';
import { parseModel } from '../../../core/model/schema';
import type { CrochetModelV1 } from '../../../types/model';
import type { ProjectDoc } from '../../../types/project';
import { newProjectDoc } from '../../../ui/shell/newProject';
import type { ProjectStore } from '../../projectStore';

/** A fresh, validated copy of the canonical teddy. */
export function teddy(): CrochetModelV1 {
  return parseModel(structuredClone(teddyJson));
}

/** A 3D project ("from photos") holding `model` (the teddy by default). */
export function teddyProject(o: { id?: string; model?: CrochetModelV1 | null; units?: 'in' | 'cm' } = {}): ProjectDoc {
  const doc = newProjectDoc('photos', { id: o.id ?? 'p-teddy', now: new Date('2026-10-01T12:00:00Z'), prefs: { units: o.units ?? 'in', terms: 'us', hand: 'right', dialect: 'compact' } });
  const model = o.model === undefined ? teddy() : o.model;
  if (model && doc.threeD) doc.threeD.model = model;
  return doc;
}

/** Opens the teddy project in `store` (discarding whatever was open). */
export function openTeddy(store: ProjectStore, o: Parameters<typeof teddyProject>[0] = {}): void {
  store.getState().open(teddyProject(o), { discardUnsaved: true });
}

/** Freezes a value deeply (to prove a function does not mutate its input). */
export function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

export function byId(model: CrochetModelV1): Record<string, CrochetModelV1['parts'][number]> {
  return Object.fromEntries(model.parts.map((p) => [p.id, p]));
}
