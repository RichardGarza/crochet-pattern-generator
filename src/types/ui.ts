// DESIGN.md §5.2.1 — props of the components one track renders from another track's folder. Frozen at Step 0;
// change only through the S0 amendment lane (§6.1 rule 7). The function entry points are in ./entryPoints.ts.
//
// The components live at track-owned paths and re-export their props type from here:
//   ui/shape/YarnSizePanel.tsx, ShapeTab.tsx (T6) · ui/pattern/PatternView.tsx, MaterialsView.tsx, PatternTab.tsx (T2)
// The other tab entry components take no props: ui/library/StartScreen (T8) · ui/twoD/SourceTab, ChartTab (T2) ·
// ui/pattern/MaterialsTab (T2) · ui/photos/PhotosTab (T3) · ui/import/ImportTab (T7) · ui/qa/QaWizard (T7) ·
// ui/export/ExportTab (T8).
import type { ComponentType, ReactNode } from 'react';
import type { ColoredMesh } from './geometry';
import type { CrochetModelV1 } from './model';
import type { PatternDoc } from './pattern';
import type { Hand, Terms, UnitPref } from './units';

// ---- T6 — ui/shape/YarnSizePanel.tsx, ShapeTab.tsx

/** §4.5: where the Yarn & size panel is shown. */
export interface YarnSizePanelProps {
  context: 'pre-model' | 'post-import' | 'shape' | 'pattern';
  onDone?(): void;
}

export interface ViewportProps {
  model: CrochetModelV1;
  meshes: Record<string, ColoredMesh>;
  selection: string[];
  layers: Record<string, boolean>;
  onPick?(partId: string | null): void;
}

/** `Viewport` defaults to the R3F viewport; tests pass a stub (happy-dom has no WebGL context). */
export interface ShapeTabProps {
  Viewport?: ComponentType<ViewportProps>;
}

// ---- T2 — ui/pattern/PatternView.tsx, MaterialsView.tsx, PatternTab.tsx (used by both modes)

/** `piece` = Piece.id (3D); undefined in 2D. */
export type LineRef = { piece?: string; line: number };

/** The ring ↔ line hover link of §4.3 goes through `highlight` / `onHoverLine`. */
export interface PatternViewProps {
  doc: PatternDoc;
  dialect: 'compact' | 'verbose';
  terms: Terms;
  hand: Hand;
  highlight?: LineRef | null;
  onHoverLine?(ref: LineRef | null): void;
  onSelectLine?(ref: LineRef): void;
  checked?: ReadonlySet<string>;
  onToggleChecked?(key: string): void;
}

export interface MaterialsViewProps {
  doc: PatternDoc;
  units: UnitPref;
}

/** 3D: the tab registry passes `<YarnSizePanel context="pattern" />` (§4.5). */
export interface PatternTabProps {
  settingsSlot?: ReactNode;
}
