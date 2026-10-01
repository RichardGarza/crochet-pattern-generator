// @vitest-environment happy-dom
// Step 0 stub tests. T2 owns this folder: replace this file with real tests when the views are implemented.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isImplemented } from '../../../core/stub';
import type { PatternDoc } from '../../../types/pattern';
import { MaterialsView } from '../MaterialsView';
import { PatternView } from '../PatternView';

const doc: PatternDoc = {
  kind: '2d',
  title: 'Test pattern',
  terms: 'us',
  hand: 'right',
  dialect: 'compact',
  skill: { level: 1, name: 'Basic', reasons: [] },
  finishedSize: { wIn: 10, hIn: 12, tolPct: 12 },
  gaugeText: '',
  hook: { mm: 5 },
  materials: [],
  notions: [],
  notes: [],
  abbreviations: [],
  specialStitches: [],
  pieces: [],
  assembly: [],
  finishing: [],
  issues: [],
  hash: '',
};

describe('ui/pattern Step 0 stubs', () => {
  it.runIf(!isImplemented(PatternView))('PatternView renders a labelled placeholder', () => {
    const { container } = render(<PatternView doc={doc} dialect="compact" terms="us" hand="right" />);
    const el = container.querySelector('[data-stub="PatternView"]');
    expect(el?.textContent).toContain('Test pattern');
    expect(el?.textContent).toContain('not implemented yet (track T2)');
  });

  it.runIf(!isImplemented(MaterialsView))('MaterialsView renders a labelled placeholder', () => {
    const { container } = render(<MaterialsView doc={doc} units="in" />);
    const el = container.querySelector('[data-stub="MaterialsView"]');
    expect(el?.textContent).toContain('Test pattern');
    expect(el?.textContent).toContain('not implemented yet (track T2)');
  });
});
