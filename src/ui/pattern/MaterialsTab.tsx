// Track T2 — the Materials tab of both modes: yarn per color, yardage and skeins, hook, gauge, size, notions
// (DESIGN.md F1 step 7, §2.8).
//
// Step 0 stub: a labelled placeholder. T2 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function MaterialsTab() {
  return (
    <TabPlaceholder
      stub="MaterialsTab"
      title="Materials"
      icon="yarn"
      track="T2"
      summary="Everything to have at hand before the first stitch."
      features={[
        'Each color matched to a real yarn, with how close the match is',
        'Yards, skeins and grams per color, rounded up so you do not run short',
        'Hook, gauge and finished size with its tolerance',
        'Notions: bobbins, safety eyes, stuffing',
      ]}
    />
  );
}
MaterialsTab.__stub = true as const;
