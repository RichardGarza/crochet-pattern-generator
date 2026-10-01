// The workspace tab registry (DESIGN.md §5.3, §5.2.1). Final at Step 0: it lazy-imports each track's tab entry
// component from its track-owned path, so a track that implements its tab never edits this file.
//
//   2D: Source · Chart · Pattern · Materials · Export
//   3D: Photos (a photo project, or one that has photo views) · Import (from Claude Design or "Describe a toy",
//       waiting for a Claude Design result, or has imports) · Shape · Pattern (with the Yarn & size panel as its
//       settings slot) · Materials · Export
//
// The Q&A wizard is a project route (`#/p/<id>/qa`), not a tab; the start screen is the `#/` route. Both are
// lazy entries here too.
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { TabId } from '../state/appStore';
import type { ProjectDoc } from '../types/project';
import type { IconName } from '../ui/common/Icon';

export type TrackId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';

export interface TabDef {
  id: TabId;
  label: string;
  icon: IconName;
  /** The track that owns the entry component. */
  owner: TrackId;
  /** §5.3 visibility predicate (the project's mode is already checked by the registry it is in). */
  visible(doc: ProjectDoc): boolean;
  /** The entry component (lazy: its chunk loads when the tab is first shown). */
  Component: LazyExoticComponent<ComponentType>;
  /** Starts loading the chunk (on hover or focus of the tab), so opening the tab is instant. */
  preload(): Promise<unknown>;
}

/** A lazy component plus a preload function that shares its import. */
function entry<P extends object>(load: () => Promise<ComponentType<P>>): { Component: LazyExoticComponent<ComponentType<P>>; preload(): Promise<unknown> } {
  let pending: Promise<ComponentType<P>> | null = null;
  const once = () => (pending ??= load());
  return { Component: lazy(async () => ({ default: await once() })), preload: once };
}

const always = (): boolean => true;

/** A photo project ("from photos", "from one photo"), or any 3D project that has photo views (§5.3). */
export function hasPhotos(doc: ProjectDoc): boolean {
  const t = doc.threeD;
  return !!t && (t.origin === 'multiview' || t.origin === 'single' || t.views.length > 0);
}

/**
 * The project came from Claude Design or "Describe a toy", waits for a Claude Design result, or has imports —
 * so a photo project gets the Import tab as soon as a prompt is copied (§5.3).
 */
export function hasImport(doc: ProjectDoc): boolean {
  const origin = doc.threeD?.origin;
  return origin === 'claude-design' || origin === 'describe' || !!doc.qa?.awaiting || doc.imports.length > 0;
}

const source = entry(() => import('../ui/twoD/SourceTab').then((m) => m.SourceTab));
const chart = entry(() => import('../ui/twoD/ChartTab').then((m) => m.ChartTab));
const pattern2d = entry(() => import('../ui/pattern/PatternTab').then((m) => m.PatternTab));
const materials = entry(() => import('../ui/pattern/MaterialsTab').then((m) => m.MaterialsTab));
const exportTab = entry(() => import('../ui/export/ExportTab').then((m) => m.ExportTab));
const photos = entry(() => import('../ui/photos/PhotosTab').then((m) => m.PhotosTab));
const importTab = entry(() => import('../ui/import/ImportTab').then((m) => m.ImportTab));
const shape = entry(() => import('../ui/shape/ShapeTab').then((m) => m.ShapeTab as ComponentType));
// 3D: the Pattern tab carries the Yarn & size panel as its settings slot (§4.5, §5.2.1 PatternTabProps).
const pattern3d = entry(async () => {
  const [{ PatternTab }, { YarnSizePanel }] = await Promise.all([import('../ui/pattern/PatternTab'), import('../ui/shape/YarnSizePanel')]);
  const Pattern3D = () => createElement(PatternTab, { settingsSlot: createElement(YarnSizePanel, { context: 'pattern' }) });
  Pattern3D.displayName = 'PatternTab3D';
  return Pattern3D;
});

export const TABS_2D: readonly TabDef[] = [
  { id: 'source', label: 'Source', icon: 'image', owner: 'T2', visible: always, ...source },
  { id: 'chart', label: 'Chart', icon: 'chart', owner: 'T2', visible: always, ...chart },
  { id: 'pattern', label: 'Pattern', icon: 'list', owner: 'T2', visible: always, ...pattern2d },
  { id: 'materials', label: 'Materials', icon: 'yarn', owner: 'T2', visible: always, ...materials },
  { id: 'export', label: 'Export', icon: 'share', owner: 'T8', visible: always, ...exportTab },
];

export const TABS_3D: readonly TabDef[] = [
  { id: 'photos', label: 'Photos', icon: 'images', owner: 'T3', visible: hasPhotos, ...photos },
  { id: 'import', label: 'Import', icon: 'import', owner: 'T7', visible: hasImport, ...importTab },
  { id: 'shape', label: 'Shape', icon: 'cube', owner: 'T6', visible: always, ...shape },
  { id: 'pattern', label: 'Pattern', icon: 'list', owner: 'T2', visible: always, ...pattern3d },
  { id: 'materials', label: 'Materials', icon: 'yarn', owner: 'T2', visible: always, ...materials },
  { id: 'export', label: 'Export', icon: 'share', owner: 'T8', visible: always, ...exportTab },
];

/** The tabs this project shows, in order. */
export function visibleTabs(doc: ProjectDoc): TabDef[] {
  return (doc.mode === '2d' ? TABS_2D : TABS_3D).filter((t) => t.visible(doc));
}

/** The tab with this id if this project shows it. */
export function findTab(doc: ProjectDoc, id: string | undefined): TabDef | undefined {
  return id === undefined ? undefined : visibleTabs(doc).find((t) => t.id === id);
}

/**
 * Where `#/p/<id>` (no tab) goes: the Q&A wizard for a "Describe a toy" project that has neither a model nor a
 * prompt out (F4 starts there), else the first visible tab (2D: Source; photo projects: Photos; Claude Design
 * projects: Import).
 */
export function defaultRouteTab(doc: ProjectDoc): TabId | 'qa' {
  if (doc.mode === '3d' && doc.threeD?.origin === 'describe' && !doc.threeD.model && !doc.qa?.awaiting) return 'qa';
  return visibleTabs(doc)[0]?.id ?? 'export';
}

/** The Q&A wizard (T7) — the `#/p/<id>/qa` route. */
export const qaWizard = entry(() => import('../ui/qa/QaWizard').then((m) => m.QaWizard));

/** The start screen (T8 owns the entry; Step 0 delegates to the shell's layout) — the `#/` route. */
export const startScreen = entry(() => import('../ui/library/StartScreen').then((m) => m.StartScreen));
