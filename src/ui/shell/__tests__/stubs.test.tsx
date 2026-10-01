// @vitest-environment happy-dom
// The Step 0 stub entry components: each renders a labelled placeholder (data-stub, its track) and carries
// `__stub`. A track that implements its component replaces the stub; these tests then skip themselves.
import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { isImplemented } from '../../../core/stub';
import { ExportTab } from '../../export/ExportTab';
import { ImportTab } from '../../import/ImportTab';
import { MaterialsTab } from '../../pattern/MaterialsTab';
import { PatternTab } from '../../pattern/PatternTab';
import { PhotosTab } from '../../photos/PhotosTab';
import { QaWizard } from '../../qa/QaWizard';
import { ShapeTab } from '../../shape/ShapeTab';
import { YarnSizePanel } from '../../shape/YarnSizePanel';
import { ChartTab } from '../../twoD/ChartTab';
import { SourceTab } from '../../twoD/SourceTab';

const STUBS: [name: string, Component: ComponentType, track: string][] = [
  ['SourceTab', SourceTab, 'T2'],
  ['ChartTab', ChartTab, 'T2'],
  ['PatternTab', PatternTab as ComponentType, 'T2'],
  ['MaterialsTab', MaterialsTab, 'T2'],
  ['ExportTab', ExportTab, 'T8'],
  ['PhotosTab', PhotosTab, 'T3'],
  ['ImportTab', ImportTab, 'T7'],
  ['QaWizard', QaWizard, 'T7'],
  ['ShapeTab', ShapeTab as ComponentType, 'T6'],
];

describe('Step 0 stub tabs', () => {
  for (const [name, Component, track] of STUBS) {
    it.runIf(!isImplemented(Component))(`${name} renders a labelled placeholder for track ${track}`, () => {
      const { container } = render(<Component />);
      const el = container.querySelector(`[data-stub="${name}"]`);
      expect(el?.getAttribute('data-track')).toBe(track);
      expect(el?.textContent).toContain('Coming soon');
      expect(el?.querySelector('h2')?.textContent).toBeTruthy();
    });
  }

  it.runIf(!isImplemented(PatternTab) && !isImplemented(YarnSizePanel))('PatternTab shows its settingsSlot in a sidebar (the 3D Yarn & size panel)', () => {
    const { container, getByRole } = render(<PatternTab settingsSlot={<YarnSizePanel context="pattern" />} />);
    expect(getByRole('complementary', { name: 'Settings' })).toBeTruthy();
    expect(container.querySelector('[data-stub="YarnSizePanel"]')?.getAttribute('data-context')).toBe('pattern');
  });
});
