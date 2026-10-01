// The cross-track entry points of src/core (DESIGN.md §5.2.1, §6.1 rule 4). Step 0 owned.
//
// This test stays valid while the tracks build: an entry point is either still a Step 0 stub (marked `__stub`,
// throws NotImplementedError) or a real function. Either way it must exist under its frozen name at its frozen
// path, and its module must load in the node environment, because src/core runs in workers and never sees a DOM.
// The signatures themselves are guarded at compile time by src/types/__checks__/entryPoints.check.ts; the entry
// points under src/ui are covered there only (a UI module may need a DOM to load).
import { describe, expect, it } from 'vitest';
import { isImplemented, NotImplementedError } from '../../core/stub';

type Loader = () => Promise<Record<string, unknown>>;

const CORE_ENTRY_POINTS: [path: string, names: string[], load: Loader][] = [
  ['core/kernel/png', ['encodePng', 'decodePng'], () => import('../../core/kernel/png')],
  ['core/model/sdf', ['partSdf', 'overlapVolume', 'surfaceGap'], () => import('../../core/model/sdf')],
  ['core/model/attach', ['inferAttach', 'inferMirrorPairs'], () => import('../../core/model/attach')],
  ['core/model/revisions', ['carryOver'], () => import('../../core/model/revisions')],
  ['core/model/naming', ['nameParts'], () => import('../../core/model/naming')],
  ['core/model/place', ['placeChildOnSurface'], () => import('../../core/model/place')],
  ['core/model/proportions', ['readProportions', 'applyProportions'], () => import('../../core/model/proportions')],
  ['core/model/scale', ['scaleModel'], () => import('../../core/model/scale')],
  ['core/kernel/geom/manifold', ['getManifold'], () => import('../../core/kernel/geom/manifold')],
  ['core/image2d/run', ['runChart'], () => import('../../core/image2d/run')],
  ['core/yarn/match', ['nearestYarn'], () => import('../../core/yarn/match')],
  ['core/techniques/index', ['buildPattern2D'], () => import('../../core/techniques/index')],
  ['core/techniques/export', ['exportChart'], () => import('../../core/techniques/export')],
  ['core/pattern/render', ['renderLine', 'renderFoundation', 'renderLineExtras'], () => import('../../core/pattern/render')],
  ['core/pattern/text', ['renderPatternText'], () => import('../../core/pattern/text')],
  ['core/pattern/skill', ['computeSkill'], () => import('../../core/pattern/skill')],
  ['core/pattern/notes', ['notesFor'], () => import('../../core/pattern/notes')],
  ['core/pattern/terminology', ['abbreviationsFor', 'specialStitchesFor'], () => import('../../core/pattern/terminology')],
  ['core/recon/fit', ['fitPart'], () => import('../../core/recon/fit')],
  ['core/ami/generate', ['generateAmigurumi'], () => import('../../core/ami/generate')],
  ['core/importer/index', ['importInputs'], () => import('../../core/importer/index')],
  ['core/persist/repo', ['createProjectRepository'], () => import('../../core/persist/repo')],
  ['core/print/pdf', ['buildPdf'], () => import('../../core/print/pdf')],
];

describe('cross-track entry points of src/core', () => {
  for (const [path, names, load] of CORE_ENTRY_POINTS) {
    for (const name of names) {
      it(`${path} exports ${name}: a real function, or a Step 0 stub that throws NotImplementedError`, async () => {
        const mod = await load();
        const fn = mod[name];
        expect(typeof fn, `${path} must export a function named ${name}`).toBe('function');
        if (isImplemented(fn)) return;
        expect((fn as { __stub?: unknown }).__stub).toBe(true);
        try {
          (fn as () => unknown)();
          expect.unreachable(`the stub ${name} must throw`);
        } catch (e) {
          expect(e).toBeInstanceOf(NotImplementedError);
          expect((e as NotImplementedError).fn).toBe(name);
          expect((e as NotImplementedError).message).toBe(`${name} not implemented`);
        }
      });
    }
  }

  it('the Step 0 kernels are implemented, not stubs', async () => {
    const png = await import('../../core/kernel/png');
    expect(isImplemented(png.encodePng)).toBe(true);
    expect(isImplemented(png.decodePng)).toBe(true);
    for (const [path, names, load] of CORE_ENTRY_POINTS.filter(([p]) => p.startsWith('core/model/') || p.startsWith('core/kernel/'))) {
      const mod = await load();
      for (const name of names) expect(isImplemented(mod[name]), `${path} ${name}`).toBe(true);
    }
    const proportions = await import('../../core/model/proportions');
    expect(Object.keys(proportions.LIMB_TEMPLATE).sort()).toEqual(['biped', 'creature', 'quadruped', 'quadruped-standing']);
  });
});
