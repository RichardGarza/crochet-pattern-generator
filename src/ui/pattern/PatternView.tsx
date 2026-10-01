// Track T2 — the generic pattern view used by both modes: pieces, lines, checkboxes and the ring ↔ line hover
// link (DESIGN.md §4.3; props frozen in §5.2.1, src/types/ui.ts).
//
// Step 0 stub: a labelled placeholder. T2 replaces it with the real component and keeps the props.
import type { PatternViewProps } from '../../types/ui';

export type { LineRef, PatternViewProps } from '../../types/ui';

export function PatternView(props: PatternViewProps) {
  return (
    <div data-stub="PatternView" role="note">
      Pattern view for “{props.doc.title}” — not implemented yet (track T2)
    </div>
  );
}
PatternView.__stub = true as const;
