// Track T6 — the sample teddy (`fixtures/models/teddy.canonical.json`, the normalized Claude Design teddy of
// Step 0b): what the Shape tab offers a 3D project that has no model yet, so the editor can be tried at once.
// It enters the project like any other model: as a new model revision (§3.7.7, §5.2.1), one undo step.
import { parseModel } from '../../core/model/schema';
import { commitModelRevision } from '../../state/projectStore';
import type { CrochetModelV1 } from '../../types/model';

export const SAMPLE_LABEL = 'Open the sample teddy';

/** The sample model, validated (loaded on demand: it is not part of the app's first chunk). */
export async function loadSampleTeddy(): Promise<CrochetModelV1> {
  const json = (await import('../../../fixtures/models/teddy.canonical.json')).default as unknown;
  return parseModel(structuredClone(json));
}

/** Puts the sample teddy into the open 3D project as a new model revision. */
export async function openSampleTeddy(): Promise<void> {
  const model = await loadSampleTeddy();
  await commitModelRevision({ ...model, name: 'Sample teddy' }, { source: 'import', label: SAMPLE_LABEL, carry: 'none' });
}
