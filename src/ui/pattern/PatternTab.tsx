// Track T2 — the Pattern tab of both modes: the written pattern with its options and the validator badge
// (DESIGN.md F1 step 6, §4.3). In 3D the tab registry passes `<YarnSizePanel context="pattern" />` as
// `settingsSlot` (§4.5).
//
// Step 0 stub: a labelled placeholder. T2 replaces this file with the real tab (same props) and drops `__stub`.
import type { PatternTabProps } from '../../types/ui';
import { Sidebar } from '../common/Layout';
import { TabPlaceholder } from '../shell/TabPlaceholder';

export type { PatternTabProps } from '../../types/ui';

export function PatternTab({ settingsSlot }: PatternTabProps) {
  return (
    <TabPlaceholder
      stub="PatternTab"
      title="Written pattern"
      icon="list"
      track="T2"
      summary="Row-by-row instructions, checked stitch by stitch before you see them."
      features={[
        'Compact or verbose, US or UK terms, right- or left-handed',
        'Repeats written as repeats; colors named by yarn',
        'A checkbox per row to keep your place',
        'A stitch-count check on every line',
      ]}
      sidebar={settingsSlot ? <Sidebar>{settingsSlot}</Sidebar> : undefined}
    />
  );
}
PatternTab.__stub = true as const;
