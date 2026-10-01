// Track T6 — the Shape tab's UI state (DESIGN.md §4.2 "Data written: UI state"): selection, the active tool,
// hover, view layers and camera requests. Never persisted and never part of the undo history; authored data
// changes only through `state/slices/model3d.ts` → `projectStore.update`.
import { createStore, useStore, type StoreApi } from 'zustand';
import type { AddableType } from '../../state/slices/model3d';

export type EditorTool = 'select' | 'move' | 'rotate' | 'scale';

/**
 * A click on a part's surface that the editor is waiting for (§4.2): where a new part goes (Add part), or the
 * start point of a mesh part's first round (Start / axis).
 */
export type SurfacePick = { kind: 'add'; type: AddableType } | { kind: 'seed'; partId: string };

/** The inspector's two pages: the selected part, or the project's yarn and size (§4.5). */
export type InspectorPage = 'part' | 'yarn';

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
  /** The open dialogs: Add part, Attach (for that part), Delete (those parts). */
  addDialog: boolean;
  attachFor: string | null;
  deleteRequest: string[] | null;

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
});

export function createEditorStore(): EditorStore {
  return createStore<EditorState>()((set, get) => ({
    ...initial(),
    select(id, o) {
      const { selection } = get();
      // Picking a part shows it.
      if (id !== null && get().inspectorPage !== 'part') set({ inspectorPage: 'part' });
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
      if (get().tool !== tool) set({ tool });
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
      if (surfacePick?.kind === 'seed' && !partIds.has(surfacePick.partId)) patch.surfacePick = null;
      if (Object.keys(patch).length > 0) set(patch);
    },
    reset() {
      set(initial());
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
