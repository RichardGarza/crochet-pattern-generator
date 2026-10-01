// Track T6 — the Shape tab: the 3D adjustment editor with live rounds (DESIGN.md F5, §4).
//
// Step 0 stub: a labelled placeholder. T6 replaces this file with the real tab (same props) and drops `__stub`.
import type { ShapeTabProps } from '../../types/ui';
import { TabPlaceholder } from '../shell/TabPlaceholder';

export type { ShapeTabProps, ViewportProps } from '../../types/ui';

export function ShapeTab(_props: ShapeTabProps) {
  return (
    <TabPlaceholder
      stub="ShapeTab"
      title="Shape"
      icon="cube"
      track="T6"
      summary="Adjust the 3D model and watch the rounds update as you go."
      features={[
        'Move, rotate and scale parts; attached parts follow',
        'Add, mirror, cut, merge and sculpt parts',
        'Paint colors, stripes and spots',
        'Rounds drawn as rings on the model, linked to the pattern lines',
      ]}
    />
  );
}
ShapeTab.__stub = true as const;
