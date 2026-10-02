// Track T6 — the Shape tab's UI state (DESIGN.md §4.2 "Data written: UI state"): selection, the active tool,
// hover, view layers and camera requests. Never persisted and never part of the undo history; authored data
// changes only through `state/slices/model3d.ts` → `projectStore.update`.
import { createStore, useStore, type StoreApi } from 'zustand';
import type { AddableType } from '../../state/slices/model3d';
import type { Feature, Vec3 } from '../../types/model';
import type { LineRef } from '../../types/ui';

export type EditorTool = 'select' | 'move' | 'rotate' | 'scale' | 'paint';

/**
 * A click on a part's surface that the editor is waiting for (§4.2): where a new part goes (Add part), the start
 * point of a mesh part's first round (Start / axis), where a new face detail goes (Features), where a patch or a
 * spot sits (its center), or the points of an embroidered line (each click adds one; Enter finishes).
 */
export type SurfacePick =
  | { kind: 'add'; type: AddableType }
  | { kind: 'seed'; partId: string }
  | { kind: 'feature'; featureKind: Feature['kind']; partId: string | null }
  | { kind: 'region'; partId: string; index: number }
  | { kind: 'path'; featureKind: Feature['kind']; partId: string | null; points: Vec3[] };

/** The inspector's pages: the selected part, colors (palette, paint, stripes, details), proportions, yarn and size. */
export type InspectorPage = 'part' | 'colors' | 'proportions' | 'yarn';

/** Paint (P, §4.2): brush, eraser (back to the stripes and the base color), fill the part, or pick a color. */
export type PaintMode = 'brush' | 'erase' | 'fill' | 'pick';

export interface PaintSettings {
  mode: PaintMode;
  /** Palette id the brush and fill use; null = the first palette color. */
  color: string | null;
  /** Brush radius, inches (§4.2: 0.05–2 in, `[` / `]`). */
  radiusIn: number;
}

export const BRUSH_LIMITS_IN: readonly [number, number] = [0.05, 2];
export const DEFAULT_PAINT: Readonly<PaintSettings> = { mode: 'brush', color: null, radiusIn: 0.3 };

/** The region whose on-model guides and handles are shown (the one open in the Colors page). */
export interface ActiveRegion {
  partId: string;
  index: number;
}

/** §4.1: the camera buttons move the camera, never the model. 'home' = the three-quarter view; 'fit' frames the selection. */
export type CameraView = 'home' | 'front' | 'left' | 'back' | 'top' | 'fit';

export interface CameraRequest {
  view: CameraView;
  /** Increases on every request, so asking for the same view twice moves the camera twice. */
  nonce: number;
}

export interface EditorState {
  /** Selected part ids; the last one is the primary (the gizmo and the inspector follow it). */
  selection: string[];
  hovered: string | null;
  tool: EditorTool;
  /** Outliner rows whose children are hidden. */
  collapsed: ReadonlySet<string>;
  layers: Record<string, boolean>;
  camera: CameraRequest;
  /** True while a gizmo drag runs; `cancelDrag` undoes it (Escape). */
  dragging: boolean;
  cancelDrag: (() => void) | null;
  /** §4.2: Move and Rotate carry the attached parts along; ⌥ held inverts this for one drag. */
  followAttached: boolean;
  /** Waiting for a click on a part's surface (Add part, a mesh part's start point); Escape cancels. */
  surfacePick: SurfacePick | null;
  inspectorPage: InspectorPage;
  /** The open dialogs: Add part, Attach (for that part), Delete (those parts), Scale model to height. */
  addDialog: boolean;
  attachFor: string | null;
  deleteRequest: string[] | null;
  scaleDialog: boolean;
  paint: PaintSettings;
  /** The round line hovered on a ring or in a round list (§4.3: the ring ↔ line hover link). */
  lineRef: LineRef | null;
  activeRegion: ActiveRegion | null;
  /** The project this state belongs to (`bindProject`). */
  projectId: string | null;

  select(id: string | null, o?: { additive?: boolean }): void;
  setSelection(ids: string[]): void;
  setHovered(id: string | null): void;
  setTool(tool: EditorTool): void;
  toggleCollapsed(id: string, collapsed?: boolean): void;
  setLayer(name: string, on: boolean): void;
  requestCamera(view: CameraView): void;
  setDragging(dragging: boolean, cancel?: () => void): void;
  setFollowAttached(on: boolean): void;
  setSurfacePick(pick: SurfacePick | null): void;
  setInspectorPage(page: InspectorPage): void;
  setAddDialog(open: boolean): void;
  /** Opens the Attach dialog for a part (and selects it): the outliner, the inspector, an `attach-inferred` chip. */
  openAttach(partId: string): void;
  closeAttach(): void;
  requestDelete(ids: string[] | null): void;
  setScaleDialog(open: boolean): void;
  setPaint(patch: Partial<PaintSettings>): void;
  setLineRef(ref: LineRef | null): void;
  setActiveRegion(region: ActiveRegion | null): void;
  /** Adds a point to an embroidered line being drawn. */
  addPathPoint(partId: string, point: Vec3): void;
  /** The editor state belongs to `projectId`: everything is reset when it is another project (not on a remount). */
  bindProject(projectId: string | null): void;
  /** Drops ids that are no longer parts (after an undo, a new model). */
  prune(partIds: ReadonlySet<string>): void;
  reset(): void;
}

export type EditorStore = StoreApi<EditorState>;

export const DEFAULT_LAYERS: Readonly<Record<string, boolean>> = { shadow: true, grid: false, wireframe: false };

const initial = () => ({
  selection: [] as string[],
  hovered: null as string | null,
  tool: 'select' as EditorTool,
  collapsed: new Set<string>() as ReadonlySet<string>,
  layers: { ...DEFAULT_LAYERS },
  camera: { view: 'home' as CameraView, nonce: 0 },
  dragging: false,
  cancelDrag: null as (() => void) | null,
  followAttached: true,
  surfacePick: null as SurfacePick | null,
  inspectorPage: 'part' as InspectorPage,
  addDialog: false,
  attachFor: null as string | null,
  deleteRequest: null as string[] | null,
  projectId: null as string | null,
  scaleDialog: false,
  paint: { ...DEFAULT_PAINT } as PaintSettings,
  lineRef: null as LineRef | null,
  activeRegion: null as ActiveRegion | null,
});

export function createEditorStore(): EditorStore {
  return createStore<EditorState>()((set, get) => ({
    ...initial(),
    select(id, o) {
      const { selection } = get();
      // Picking a part shows it (the Colors page stays: it is about the selected part too).
      if (id !== null && get().inspectorPage !== 'part' && get().inspectorPage !== 'colors') set({ inspectorPage: 'part' });
      if (id === null) {
        if (!o?.additive && selection.length > 0) set({ selection: [] });
        return;
      }
      if (o?.additive) {
        // Shift-click toggles a part in or out; a part added becomes the primary.
        set({ selection: selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id] });
        return;
      }
      if (selection.length === 1 && selection[0] === id) return;
      set({ selection: [id] });
    },
    setSelection(ids) {
      set({ selection: [...new Set(ids)] });
    },
    setHovered(id) {
      if (get().hovered !== id) set({ hovered: id });
    },
    setTool(tool) {
      if (get().tool === tool) return;
      // Paint (P) shows its settings; leaving it goes back to the part.
      if (tool === 'paint') set({ tool, inspectorPage: 'colors' });
      else if (get().tool === 'paint' && get().inspectorPage === 'colors') set({ tool, inspectorPage: 'part' });
      else set({ tool });
    },
    toggleCollapsed(id, collapsed) {
      const next = new Set(get().collapsed);
      const want = collapsed ?? !next.has(id);
      if (want === next.has(id)) return;
      if (want) next.add(id);
      else next.delete(id);
      set({ collapsed: next });
    },
    setLayer(name, on) {
      if (get().layers[name] === on) return;
      set({ layers: { ...get().layers, [name]: on } });
    },
    requestCamera(view) {
      set({ camera: { view, nonce: get().camera.nonce + 1 } });
    },
    setDragging(dragging, cancel) {
      set({ dragging, cancelDrag: dragging ? (cancel ?? null) : null });
    },
    setFollowAttached(on) {
      if (get().followAttached !== on) set({ followAttached: on });
    },
    setSurfacePick(pick) {
      set({ surfacePick: pick });
    },
    setInspectorPage(page) {
      if (get().inspectorPage !== page) set({ inspectorPage: page });
    },
    setAddDialog(open) {
      if (get().addDialog !== open) set({ addDialog: open });
    },
    openAttach(partId) {
      set({ selection: [partId], inspectorPage: 'part', attachFor: partId });
    },
    closeAttach() {
      if (get().attachFor !== null) set({ attachFor: null });
    },
    requestDelete(ids) {
      set({ deleteRequest: ids && ids.length > 0 ? [...ids] : null });
    },
    setScaleDialog(open) {
      if (get().scaleDialog !== open) set({ scaleDialog: open });
    },
    setPaint(patch) {
      const next = { ...get().paint, ...patch };
      next.radiusIn = Math.min(BRUSH_LIMITS_IN[1], Math.max(BRUSH_LIMITS_IN[0], Number.isFinite(next.radiusIn) ? next.radiusIn : DEFAULT_PAINT.radiusIn));
      set({ paint: next });
    },
    setLineRef(ref) {
      const cur = get().lineRef;
      if (cur === ref || (cur && ref && cur.piece === ref.piece && cur.line === ref.line)) return;
      set({ lineRef: ref });
    },
    setActiveRegion(region) {
      const cur = get().activeRegion;
      if (cur === region || (cur && region && cur.partId === region.partId && cur.index === region.index)) return;
      set({ activeRegion: region });
    },
    addPathPoint(partId, point) {
      const pick = get().surfacePick;
      if (pick?.kind !== 'path') return;
      if (pick.partId && pick.partId !== partId) return;
      set({ surfacePick: { ...pick, partId, points: [...pick.points, point] } });
    },
    bindProject(projectId) {
      if (get().projectId === projectId) return;
      set({ ...initial(), projectId });
    },
    prune(partIds) {
      const { selection, hovered } = get();
      const kept = selection.filter((id) => partIds.has(id));
      const patch: Partial<EditorState> = {};
      if (kept.length !== selection.length) patch.selection = kept;
      if (hovered && !partIds.has(hovered)) patch.hovered = null;
      const { attachFor, deleteRequest, surfacePick } = get();
      if (attachFor && !partIds.has(attachFor)) patch.attachFor = null;
      if (deleteRequest && deleteRequest.some((id) => !partIds.has(id))) {
        const left = deleteRequest.filter((id) => partIds.has(id));
        patch.deleteRequest = left.length > 0 ? left : null;
      }
      if ((surfacePick?.kind === 'seed' || surfacePick?.kind === 'region') && !partIds.has(surfacePick.partId)) patch.surfacePick = null;
      if ((surfacePick?.kind === 'feature' || surfacePick?.kind === 'path') && surfacePick.partId && !partIds.has(surfacePick.partId)) patch.surfacePick = null;
      const { activeRegion } = get();
      if (activeRegion && !partIds.has(activeRegion.partId)) patch.activeRegion = null;
      if (Object.keys(patch).length > 0) set(patch);
    },
    reset() {
      set({ ...initial(), projectId: get().projectId });
    },
  }));
}

/** The Shape tab's store (one per app; the tab resets it when another project opens). */
export const editorStore = createEditorStore();

export function useEditorStore<T>(selector: (s: EditorState) => T): T {
  return useStore(editorStore, selector);
}

/** The primary selected part (the last selected), or null. */
export const selectPrimary = (s: EditorState): string | null => s.selection[s.selection.length - 1] ?? null;

/** The scope of a Move / Rotate: the toggle, inverted while ⌥ is held (§4.2). */
export function transformScope(followAttached: boolean, altHeld: boolean): 'subtree' | 'alone' {
  return followAttached !== altHeld ? 'subtree' : 'alone';
}
