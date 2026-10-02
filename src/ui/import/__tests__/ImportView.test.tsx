// @vitest-environment happy-dom
// Track T7.4a — the import screens (DESIGN.md F4 steps 4–6, §3.7.7): paste or drop → the report (carrier, dialect,
// confidence, a chip per fix) → Accept → Yarn & size; joins open the Attach tool (or the Shape tab while T6's entry
// point is a stub); the units question; the versions picker; a failure; read-only; the return path by `x-cpg`;
// the wizard's import step while waiting for Claude Design.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importInputs } from '../../../core/importer';
import { isImplemented } from '../../../core/stub';
import { appStore } from '../../../state/appStore';
import { projectStore } from '../../../state/projectStore';
import { teddy } from '../../../state/slices/__tests__/teddyProject';
import type { ProjectDoc } from '../../../types/project';
import { QaWizard } from '../../qa/QaWizard';
import { openAttachTool } from '../../shape/openAttachTool';
import { newProjectDoc } from '../../shell/newProject';
import { ImportTab } from '../ImportTab';
import { importFiles, pendingImport, resetImportSessions, setImportRunner } from '../importSession';

// happy-dom's import.meta.url is not a file URL: fixtures are found from the repository root (vitest's cwd)
const FIX = path.join(process.cwd(), 'fixtures', 'claude-design');
const fixtureFile = (rel: string): File => new File([fs.readFileSync(path.join(FIX, rel))], rel.split('/').pop() ?? rel);
const observedJson = (): string => fs.readFileSync(path.join(FIX, 'teddy-bear', 'teddy-bear.crochet-model.json'), 'utf8');

const PREFS = { units: 'in' as const, terms: 'us' as const, hand: 'right' as const, dialect: 'compact' as const };

function freshProject(id = 'fresh'): ProjectDoc {
  return newProjectDoc('claude-design', { id, now: new Date('2026-10-01T12:00:00Z'), prefs: PREFS });
}

function open(doc: ProjectDoc, readOnly = false): void {
  projectStore.getState().open(doc, { discardUnsaved: true, readOnly });
}

async function paste(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: /Or paste Claude’s reply/ }), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import pasted text' }));
  });
}

beforeEach(() => {
  setImportRunner((inputs, ctx) => importInputs(inputs, ctx));
  window.location.hash = '';
});

afterEach(() => {
  setImportRunner(null);
  resetImportSessions();
  projectStore.getState().close({ discardUnsaved: true });
  appStore.getState().setLibrary(null);
});

describe('ImportTab', () => {
  it('is the real tab (no stub) and starts with the drop zone and the paste box', () => {
    expect(isImplemented(ImportTab)).toBe(true);
    open(freshProject());
    render(<ImportTab />);
    expect(screen.getByRole('heading', { name: 'Bring in your Claude Design toy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import pasted text' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('paste Claude Design’s JSON → what was read and a chip per fix → Accept → Yarn & size; joins open the Attach tool', async () => {
    open(freshProject());
    render(<ImportTab />);
    await paste(observedJson());
    expect(await screen.findByRole('heading', { name: 'Your model is ready to import' })).toBeTruthy();
    expect(screen.getByTestId('import-carrier').textContent).toBe('Pasted text');
    expect(screen.getByTestId('import-dialect').textContent).toBe('Claude Design’s own way of writing models');
    expect(screen.getByTestId('import-confidence').textContent).toContain('Sure');
    expect(screen.getByTestId('import-summary').textContent).toBe('17 parts · 9.9 in tall · 4 colors');
    const fixes = screen.getByTestId('import-fixes');
    expect(fixes.textContent).toBe('We made 15 small fixes automatically');
    const joins = screen.getByRole('list', { name: 'Joined 6 parts to their neighbors' });
    expect(within(joins).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Left Leg → Body', 'Right Leg → Body', 'Left Arm → Body', 'Right Arm → Body', 'Tail → Body', 'Head → Body']);
    expect(screen.getByRole('list', { name: 'Matched 6 left/right pairs' }).children).toHaveLength(6);

    await act(async () => {
      fireEvent.click(screen.getByTestId('import-accept'));
    });
    expect(await screen.findByRole('heading', { name: '17 parts are in your project' })).toBeTruthy();
    const doc = projectStore.getState().doc;
    expect(doc?.threeD?.model?.parts).toHaveLength(17);
    expect(doc?.imports).toHaveLength(1);
    expect(projectStore.getState().history.past.at(-1)?.label).toBe('Imported from Claude Design');
    expect(screen.getByRole('heading', { name: 'Yarn & size' })).toBeTruthy();

    const join = within(screen.getByRole('list', { name: 'Joins to check' })).getByRole('button', { name: 'Head → Body' });
    fireEvent.click(join);
    if (!isImplemented(openAttachTool)) expect(window.location.hash).toBe('#/p/fresh/shape');

    // Done: the pending import is cleared and the Shape tab opens
    window.location.hash = '';
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(window.location.hash).toBe('#/p/fresh/shape');
    expect(pendingImport('fresh')).toBeUndefined();
  });

  it('a join chip before Accept asks first, then accepts and opens the Attach tool', async () => {
    open(freshProject());
    render(<ImportTab />);
    await paste(observedJson());
    await screen.findByRole('heading', { name: 'Your model is ready to import' });
    fireEvent.click(screen.getByRole('button', { name: 'Tail → Body' }));
    const ask = await screen.findByRole('dialog', { name: 'Accept the model first?' });
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: 'Accept and open Attach' }));
    });
    await waitFor(() => expect(projectStore.getState().doc?.imports).toHaveLength(1));
    if (!isImplemented(openAttachTool)) await waitFor(() => expect(window.location.hash).toBe('#/p/fresh/shape'));
  });

  it('a second import shows the changes against the current model, with "Carry anyway" for painted parts', async () => {
    const doc = freshProject();
    const current = teddy();
    const body = current.parts.find((p) => p.id === 'body');
    if (!body) throw new Error('body');
    body.paint = { kind: 'uv64', data: 'A'.repeat(5464) + '==' };
    if (doc.threeD) doc.threeD.model = current;
    open(doc);
    render(<ImportTab />);
    const next = teddy();
    const nb = next.parts.find((p) => p.id === 'body');
    if (nb?.type !== 'ellipsoid') throw new Error('body');
    nb.dims = { rx: nb.dims.rx * 1.3, ry: nb.dims.ry, rz: nb.dims.rz };
    await paste(JSON.stringify(next));
    expect(await screen.findByRole('heading', { name: 'Changes from your current model' })).toBeTruthy();
    expect(screen.getByTestId('import-diff-headline').textContent).toBe('1 changed · 16 the same');
    expect(screen.getByTestId('import-paint-not-carried').textContent).toContain('Not carried to Body');
    const carry = screen.getByRole('switch', { name: 'Carry anyway: Body' });
    fireEvent.click(carry);
    expect(pendingImport('fresh')?.carryAnyway).toEqual(['body']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('import-accept'));
    });
    await screen.findByRole('heading', { name: '17 parts are in your project' });
    expect(projectStore.getState().doc?.threeD?.model?.parts.find((p) => p.id === 'body')?.paint).toBeDefined();
    expect(screen.getByText(/keeping your painted colors on Body/)).toBeTruthy();
  });

  it('geometry in meters asks "0.25 in tall, or 9.9 in tall?"; the answer re-runs; Accept waits for it', async () => {
    open(freshProject());
    await importFiles('fresh', [fixtureFile('teddy-derived/teddy-builder-v1.obj.gz'), fixtureFile('teddy-derived/teddy-builder-v1.mtl')]);
    render(<ImportTab />);
    const dialog = await screen.findByRole('dialog', { name: 'How tall is this toy?' });
    expect(within(dialog).getByTestId('units-question').textContent).toBe('0.25 in tall, or 9.9 in tall?');
    expect(screen.getByTestId('import-accept').getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /0\.25 in tall/ }));
    });
    await waitFor(() => expect(screen.getByTestId('import-size').textContent).toBe('0.25 in tall'));
    expect(pendingImport('fresh')?.ctx.units).toBe('in');
    expect(screen.getByTestId('import-accept').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('closing the units question keeps our guess', async () => {
    open(freshProject());
    await importFiles('fresh', [fixtureFile('teddy-derived/teddy-builder-v1.obj.gz'), fixtureFile('teddy-derived/teddy-builder-v1.mtl')]);
    render(<ImportTab />);
    const dialog = await screen.findByRole('dialog', { name: 'How tall is this toy?' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
    await waitFor(() => expect(pendingImport('fresh')?.unitsAnswered).toBe(true));
    expect(screen.getByTestId('import-size').textContent).toBe('9.9 in tall');
  });

  it('two versions in an archive: the picker re-runs with the other one', async () => {
    open(freshProject());
    await importFiles('fresh', [fixtureFile('teddy-derived/teddy-stale-side-file.zip')]);
    render(<ImportTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose version…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Which version?' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Side file · revision 0/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Use this version' }));
    });
    await waitFor(() => expect(pendingImport('fresh')?.result?.model?.revision).toBe(0));
    expect(pendingImport('fresh')?.ctx.pickCandidate).toBe('crochet-model.json');
  });

  it('a failure explains itself; "Try again" goes back to the drop zone', async () => {
    open(freshProject());
    render(<ImportTab />);
    await paste('Here is your bear!');
    expect(await screen.findByRole('heading', { name: 'We couldn’t find a toy model in this text' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('heading', { name: 'Bring in your Claude Design toy' })).toBeTruthy();
  });

  it('read-only: nothing can be imported or accepted', async () => {
    open(freshProject(), true);
    render(<ImportTab />);
    expect(screen.getByText(/open read-only here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose files' }).hasAttribute('disabled')).toBe(true);
  });

  it('return path: a result tagged for another project offers it pre-selected and moves the import there', async () => {
    appStore.getState().setLibrary([
      { id: 'home', name: 'Bear for Mia', mode: '3d', updatedAt: '2026-09-30T10:00:00Z' },
      { id: 'flat', name: 'Blanket', mode: '2d', updatedAt: '2026-09-30T10:00:00Z' },
    ]);
    open(freshProject());
    render(<ImportTab />);
    await paste(JSON.stringify({ ...teddy(), 'x-cpg': { project: 'home', seedRev: 0 } }));
    expect(await screen.findByRole('heading', { name: 'Where should it go?' })).toBeTruthy();
    const into = screen.getByRole('radio', { name: /Import into “Bear for Mia”/ }) as HTMLInputElement;
    expect(into.checked).toBe(true);
    // the user may keep it here instead
    fireEvent.click(screen.getByRole('radio', { name: /A new project/ }));
    expect(screen.getByTestId('import-accept')).toBeTruthy();
    fireEvent.click(into);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue in “Bear for Mia”' }));
    });
    expect(window.location.hash).toBe('#/p/home/import');
    await waitFor(() => expect(pendingImport('home')?.phase).toBe('report'));
    expect(pendingImport('fresh')).toBeUndefined();
  });

  it('the only project waiting for Claude Design is offered, not pre-selected; a project with a model is never asked', async () => {
    appStore.getState().setLibrary([{ id: 'home', name: 'Bear for Mia', mode: '3d', updatedAt: '2026-09-30T10:00:00Z', awaitingClaudeDesign: true }]);
    open(freshProject());
    const view = render(<ImportTab />);
    await paste(observedJson());
    await screen.findByRole('heading', { name: 'Where should it go?' });
    expect((screen.getByRole('radio', { name: /A new project/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('It’s waiting for a Claude Design result')).toBeTruthy();
    view.unmount();
    resetImportSessions();
    const withModel = freshProject('p2');
    if (withModel.threeD) withModel.threeD.model = teddy();
    open(withModel);
    render(<ImportTab />);
    await paste(observedJson());
    await screen.findByRole('heading', { name: 'Your model is ready to import' });
    expect(screen.queryByRole('heading', { name: 'Where should it go?' })).toBeNull();
  });
});

describe('QaWizard', () => {
  it('while waiting for a Claude Design result it opens at the import step; otherwise it is still the placeholder', () => {
    const doc = newProjectDoc('describe', { id: 'd1', now: new Date('2026-10-01T12:00:00Z'), prefs: PREFS });
    open(doc);
    const first = render(<QaWizard />);
    expect(first.container.querySelector('[data-stub="QaWizard"]')).toBeTruthy();
    first.unmount();
    open({ ...doc, qa: { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: '2026-10-01T12:00:00Z', seedRev: 0, via: 'copy' } } });
    render(<QaWizard />);
    expect(screen.getByRole('heading', { name: 'Bring back your Claude Design result' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Copy prompt again/ })).toBeNull();
  });
});
