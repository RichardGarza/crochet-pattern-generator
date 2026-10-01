// Track T6.2 — the Yarn & size panel's model-dependent half (DESIGN.md §4.2 "Scale model to height", §4.5): the
// model's height and Scale model to height. Kept apart from `yarnSize.ts` and loaded on demand, because measuring a
// model needs the builder geometry (three.js), which the 3D Pattern tab's settings slot should not load up front.
import { MODEL_LIMITS } from '../../core/model/limits';
import { scaleModel } from '../../core/model/scale';
import { modelHeight } from '../../core/model/transforms';
import { currentModel, withRevision } from '../../state/slices/model3d';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import type { CrochetModelV1 } from '../../types/model';
import { HEIGHT_LIMITS_IN } from './yarnSize';

export { modelHeight };

/** Why the model cannot be scaled to `heightIn`, or null. */
export function scaleBlockedReason(model: CrochetModelV1, heightIn: number): string | null {
  if (model.parts.some((p) => p.type === 'mesh')) return 'Sculpted parts cannot be rescaled yet (they come with the sculpt tools)';
  if (!(heightIn >= HEIGHT_LIMITS_IN[0] && heightIn <= HEIGHT_LIMITS_IN[1])) return `Choose a height from ${HEIGHT_LIMITS_IN[0]} to ${HEIGHT_LIMITS_IN[1]} in`;
  const h = modelHeight(model);
  if (!(h > 0)) return 'The model has no height to scale';
  const k = heightIn / h;
  const tooBig = model.parts.some((p) => {
    const nums: number[] = [];
    const walk = (x: unknown, key?: string) => {
      if (typeof x === 'number' && key !== 'arcDeg') nums.push(Math.abs(x));
      else if (Array.isArray(x)) x.forEach((v) => walk(v));
      else if (x && typeof x === 'object') for (const [kk, v] of Object.entries(x)) walk(v, kk);
    };
    walk(p.dims);
    return nums.some((v) => v * k > MODEL_LIMITS.maxDimIn);
  });
  return tooBig ? `At ${heightIn} in a part would be larger than ${MODEL_LIMITS.maxDimIn} in` : null;
}

/**
 * Scale model to height (§4.2, §4.5): every part scaled uniformly about the ground center (`scaleModel`) so the
 * model is `heightIn` tall; one history step and a new model revision. Resolves false when blocked or unchanged.
 */
export async function scaleModelToHeight(heightIn: number, o: { store?: ProjectStore } = {}): Promise<boolean> {
  const store = o.store ?? projectStore;
  const model = currentModel(store);
  if (!model || store.getState().readOnly || scaleBlockedReason(model, heightIn)) return false;
  const h = modelHeight(model);
  const factor = heightIn / h;
  if (Math.abs(factor - 1) < 1e-6) return false;
  const next = withRevision(model, scaleModel(model, factor).model);
  await store.getState().commitModelRevision(next, { source: 'edit', label: `Scale to ${Number(heightIn.toFixed(2))} in tall`, carry: 'none' });
  return true;
}

