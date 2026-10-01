// New projects from the start cards: valid documents with the right mode, origin and defaults.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../../../state/appStore';
import { createProjectStore } from '../../../state/projectStore';
import { NEW_PROJECT_OPTIONS, newProjectDoc } from '../newProject';

const now = new Date('2026-10-01T12:00:00.000Z');

describe('newProjectDoc', () => {
  it('has the five start cards of §5.7, in order', () => {
    expect(NEW_PROJECT_OPTIONS.map((o) => o.title)).toEqual([
      'New pattern from a picture',
      'New 3D toy from photos',
      'New 3D toy from one photo',
      'Describe a toy for Claude Design',
      'Import from Claude Design',
    ]);
  });

  it('makes a 2D project with the Table A defaults and no sources', () => {
    const doc = newProjectDoc('picture', { id: 'a', now, prefs: { ...DEFAULT_PREFS, units: 'cm', terms: 'uk' } });
    expect(doc).toMatchObject({ schema: 'crochet-project', version: 1, id: 'a', mode: '2d', units: 'cm', terms: 'uk', hand: 'right', rev: 0, sources: [], imports: [] });
    expect(doc.gauge).toEqual({ cyc: 4, technique: 'sc_graphgan' });
    expect(doc.createdAt).toBe('2026-10-01T12:00:00.000Z');
    expect(doc.threeD).toBeUndefined();
    expect(doc.twoD).toBeUndefined();
  });

  it('makes 3D projects with their origin, amigurumi gauge and settings, and no model', () => {
    const origins = { photos: 'multiview', 'one-photo': 'single', describe: 'describe', 'claude-design': 'claude-design' } as const;
    for (const [kind, origin] of Object.entries(origins) as [keyof typeof origins, string][]) {
      const doc = newProjectDoc(kind, { id: kind, now, prefs: { ...DEFAULT_PREFS, hand: 'left', dialect: 'verbose' } });
      expect(doc.mode).toBe('3d');
      expect(doc.gauge).toEqual({ cyc: 4, technique: 'amigurumi_sc' });
      expect(doc.threeD).toMatchObject({ origin, meshAssets: {}, revisions: [], views: [] });
      expect(doc.threeD?.model).toBeUndefined();
      expect(doc.threeD?.ami).toMatchObject({ style: 'classic', spiral: true, decMethod: 'invdec', hand: 'left', dialect: 'verbose', defaultStuffing: 'firm', leanStPerRnd: 0.25 });
    }
  });

  it('is accepted by projectStore.open and is not dirty', () => {
    for (const o of NEW_PROJECT_OPTIONS) {
      const store = createProjectStore();
      store.getState().open(newProjectDoc(o.kind, { id: `id-${o.kind}`, now, prefs: DEFAULT_PREFS }));
      expect(store.getState().doc?.name).toBe(o.defaultName);
      expect(store.getState().saveStatus).toBe('saved');
    }
  });
});
