// Track T2 — the generic materials view used by both modes: yarn per color, yardage band, skeins, notions
// (DESIGN.md §2.8; props frozen in §5.2.1, src/types/ui.ts).
//
// Step 0 stub: a labelled placeholder. T2 replaces it with the real component and keeps the props.
import type { MaterialsViewProps } from '../../types/ui';

export type { MaterialsViewProps } from '../../types/ui';

export function MaterialsView(props: MaterialsViewProps) {
  return (
    <div data-stub="MaterialsView" role="note">
      Materials for “{props.doc.title}” ({props.units}) — not implemented yet (track T2)
    </div>
  );
}
MaterialsView.__stub = true as const;
