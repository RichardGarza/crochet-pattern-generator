// The project session on the memory backend: create, leave without losing changes, reopen, library summaries.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../../../state/appStore';
import { projectStore } from '../../../state/projectStore';
import { createMemoryBackend, createProject, leaveProject, openProject, projectBackend, setProjectBackend, summaryOf } from '../projectSession';

describe('projectSession (memory backend)', () => {
  beforeEach(() => {
    setProjectBackend(createMemoryBackend());
    appStore.getState().setLibrary(null);
  });
  afterEach(() => {
    projectStore.getState().close({ discardUnsaved: true });
  });

  it('creates and opens a project and lists it in the library', async () => {
    const doc = await createProject('photos');
    expect(projectStore.getState().doc?.id).toBe(doc.id);
    expect(projectBackend().kind).toBe('memory');
    expect(appStore.getState().library?.map((s) => s.id)).toEqual([doc.id]);
    expect(appStore.getState().library?.[0]).toMatchObject({ name: 'Untitled toy', mode: '3d' });
  });

  it('keeps unsaved changes and assets when leaving, and gives them back on reopen', async () => {
    const doc = await createProject('picture');
    projectStore.getState().update('Rename project', (d) => {
      d.name = 'Sunflower';
    });
    const ref = await projectStore.getState().putAsset(new Blob(['pixels'], { type: 'image/png' }), 'image/png');
    await leaveProject();
    expect(projectStore.getState().doc).toBeNull();
    expect(appStore.getState().library?.find((s) => s.id === doc.id)?.name).toBe('Sunflower');
    expect(await openProject(doc.id)).toBe(true);
    expect(projectStore.getState().doc?.name).toBe('Sunflower');
    expect(await (await projectStore.getState().getAsset(ref)).text()).toBe('pixels');
  });

  it('switching projects keeps both', async () => {
    const a = await createProject('picture');
    projectStore.getState().update('Rename project', (d) => {
      d.name = 'A';
    });
    const b = await createProject('describe');
    expect(projectStore.getState().doc?.id).toBe(b.id);
    expect(await openProject(a.id)).toBe(true);
    expect(projectStore.getState().doc?.name).toBe('A');
    expect(await openProject(b.id)).toBe(true);
    expect(projectStore.getState().doc?.threeD?.origin).toBe('describe');
  });

  it('an unknown id opens nothing; two opens of one id at once open it once', async () => {
    expect(await openProject('nope')).toBe(false);
    const a = await createProject('picture');
    await createProject('photos');
    const session = projectStore.getState().session;
    const [x, y] = await Promise.all([openProject(a.id), openProject(a.id)]);
    expect([x, y]).toEqual([true, true]);
    // close (leave) + open = two session steps, not four.
    expect(projectStore.getState().session).toBe(session + 2);
  });

  it('the summary carries the Claude Design wait', async () => {
    const doc = await createProject('describe');
    expect(summaryOf(doc).awaitingClaudeDesign).toBeUndefined();
    projectStore.getState().update('Copy prompt', (d) => {
      d.qa = { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: '2026-10-01T12:00:00Z', seedRev: 0, via: 'copy' } };
    });
    expect(appStore.getState().library?.find((s) => s.id === doc.id)?.awaitingClaudeDesign).toBe(true);
  });
});
