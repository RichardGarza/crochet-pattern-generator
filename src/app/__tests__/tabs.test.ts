// The tab registry (DESIGN.md §5.3): ids, order and visibility predicates per project kind, default routes,
// and that every entry resolves to a component.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, TAB_IDS } from '../../state/appStore';
import type { ProjectDoc } from '../../types/project';
import { newProjectDoc, type NewProjectKind } from '../../ui/shell/newProject';
import { TABS_2D, TABS_3D, defaultRouteTab, findTab, hasImport, hasPhotos, qaWizard, startScreen, visibleTabs } from '../tabs';

const make = (kind: NewProjectKind): ProjectDoc => newProjectDoc(kind, { id: `p-${kind}`, now: new Date('2026-10-01T12:00:00Z'), prefs: DEFAULT_PREFS });
const ids = (doc: ProjectDoc) => visibleTabs(doc).map((t) => t.id);

describe('tab registry (§5.3)', () => {
  it('uses only the route tab ids of appStore, in the order of §5.3', () => {
    for (const t of [...TABS_2D, ...TABS_3D]) expect(TAB_IDS).toContain(t.id);
    expect(TABS_2D.map((t) => t.id)).toEqual(['source', 'chart', 'pattern', 'materials', 'export']);
    expect(TABS_3D.map((t) => t.id)).toEqual(['photos', 'import', 'shape', 'pattern', 'materials', 'export']);
  });

  it('shows each new project the tabs that apply', () => {
    expect(ids(make('picture'))).toEqual(['source', 'chart', 'pattern', 'materials', 'export']);
    expect(ids(make('photos'))).toEqual(['photos', 'shape', 'pattern', 'materials', 'export']);
    expect(ids(make('one-photo'))).toEqual(['photos', 'shape', 'pattern', 'materials', 'export']);
    expect(ids(make('describe'))).toEqual(['import', 'shape', 'pattern', 'materials', 'export']);
    expect(ids(make('claude-design'))).toEqual(['import', 'shape', 'pattern', 'materials', 'export']);
  });

  it('a photo project gets the Import tab as soon as it waits for Claude Design, or has imports', () => {
    const doc = make('photos');
    expect(hasImport(doc)).toBe(false);
    const waiting: ProjectDoc = { ...doc, qa: { answers: {}, decided: {}, seedSource: 'current-model', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: '2026-10-01T12:00:00Z', seedRev: 0, via: 'copy' } } };
    expect(ids(waiting)).toEqual(['photos', 'import', 'shape', 'pattern', 'materials', 'export']);
    const imported = { ...doc, imports: [{ id: 'i1' } as ProjectDoc['imports'][number]] };
    expect(hasImport(imported)).toBe(true);
  });

  it('a Claude Design project that has photo views shows Photos too', () => {
    const doc = make('claude-design');
    expect(hasPhotos(doc)).toBe(false);
    const withViews: ProjectDoc = { ...doc, threeD: { ...doc.threeD!, views: [{} as NonNullable<ProjectDoc['threeD']>['views'][number]] } };
    expect(ids(withViews)).toEqual(['photos', 'import', 'shape', 'pattern', 'materials', 'export']);
  });

  it('default routes: Source, Photos, Import — and the wizard for a fresh "Describe a toy"', () => {
    expect(defaultRouteTab(make('picture'))).toBe('source');
    expect(defaultRouteTab(make('photos'))).toBe('photos');
    expect(defaultRouteTab(make('claude-design'))).toBe('import');
    expect(defaultRouteTab(make('describe'))).toBe('qa');
    const doc = make('describe');
    const waiting: ProjectDoc = { ...doc, qa: { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: 'x', seedRev: 0, via: 'copy' } } };
    expect(defaultRouteTab(waiting)).toBe('import');
  });

  it('findTab finds only tabs the project shows', () => {
    expect(findTab(make('picture'), 'chart')?.label).toBe('Chart');
    expect(findTab(make('picture'), 'shape')).toBeUndefined();
    expect(findTab(make('photos'), 'import')).toBeUndefined();
    expect(findTab(make('photos'), undefined)).toBeUndefined();
  });

  it('every entry, the wizard and the start screen resolve to a component', async () => {
    for (const t of [...TABS_2D, ...TABS_3D, qaWizard, startScreen]) {
      const component = await t.preload();
      expect(typeof component).toBe('function');
    }
  });
});
