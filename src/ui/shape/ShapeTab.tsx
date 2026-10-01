// Track T6 — the Shape tab: the 3D adjustment editor (DESIGN.md F5, §4.1–§4.4). Parts outliner (the attach
// tree) on the left, the viewport in the middle with the tool bar above it and the camera buttons on it, the
// inspector on the right, validation in the status bar.
//
// The viewport is injectable (`ShapeTabProps.Viewport`, §5.2.1): the app uses the react-three-fiber viewport
// (`Viewport3D`, loaded on demand), tests pass a stub (happy-dom has no WebGL context).
import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react';
import { navigate } from '../../app/router';
import { notify } from '../../app/toasts';
import { gapIssues, scaleBlockedReason } from '../../state/slices/model3d';
import { projectStore, useProjectStore } from '../../state/projectStore';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1 } from '../../types/model';
import type { ShapeTabProps, ViewportProps } from '../../types/ui';
import { Badge, Button, EmptyState, IconButton, SegmentedControl, Spinner, Switch, TabLayout, Toolbar, ToolbarDivider, Tooltip } from '../common';
import { StatusItems, useShortcutGroup, type ShortcutGroup } from '../shell';
import { isEditableTarget, IS_MAC } from '../shell/shortcuts';
import { TYPE_NAMES } from './dimSpecs';
import { editorStore, useEditorStore, type CameraView, type EditorTool } from './editorStore';
import { ShapeInspector } from './Inspector';
import { ShapeDialogs } from './ShapeDialogs';
import { duplicateSelection, mirrorSelection, requestDeleteSelection } from './tools';
import { useModifierKeys } from './modifiers';
import { Outliner } from './Outliner';
import './shape.css';

export type { ShapeTabProps, ViewportProps } from '../../types/ui';

const Viewport3D = lazy(() => import('./Viewport3D').then((m) => ({ default: m.Viewport3D })));

function DefaultViewport(props: ViewportProps) {
  return (
    <Suspense
      fallback={
        <div className="shape-viewport shape-viewport--loading">
          <Spinner size={22} label="Loading the 3D view…" />
        </div>
      }
    >
      <Viewport3D {...props} />
    </Suspense>
  );
}

/** Mesh-part buffers by `meshRef`. Decoding `threeD.meshAssets` arrives with the mesh tools (T6.4); until then a
 * mesh part is drawn as the ellipsoid of its bounding box (the builder's fallback). */
const NO_MESHES: Record<string, ColoredMesh> = Object.freeze({}) as Record<string, ColoredMesh>;

const TOOLS: { value: EditorTool; label: string; key: string; tooltip: string }[] = [
  { value: 'select', label: 'Select', key: 'Q', tooltip: 'Select parts (Q) · ⇧-click adds' },
  { value: 'move', label: 'Move', key: 'W', tooltip: 'Move (W) · hold ⌥ to move a part alone · ⇧ turns snapping off' },
  { value: 'rotate', label: 'Rotate', key: 'E', tooltip: 'Rotate (E) · turns about the part’s center' },
  { value: 'scale', label: 'Resize', key: 'R', tooltip: 'Resize (R) · attached parts stay on the surface' },
];

const TOOL_KEYS: Record<string, EditorTool> = { q: 'select', w: 'move', e: 'rotate', r: 'scale' };

const VIEWS: { view: CameraView; label: string; tip: string }[] = [
  { view: 'front', label: 'Front', tip: 'Look at the front' },
  { view: 'left', label: 'Left', tip: 'Look at the toy’s own left side' },
  { view: 'back', label: 'Back', tip: 'Look at the back' },
  { view: 'top', label: 'Top', tip: 'Look down from above' },
];

export function ShapeTab({ Viewport = DefaultViewport }: ShapeTabProps) {
  const projectId = useProjectStore((s) => s.doc?.id ?? null);
  const hasThreeD = useProjectStore((s) => !!s.doc?.threeD);
  const model = useProjectStore((s) => s.doc?.threeD?.model);
  const origin = useProjectStore((s) => s.doc?.threeD?.origin);
  const units = useProjectStore((s) => s.doc?.units ?? 'in');
  const readOnly = useProjectStore((s) => s.readOnly);

  // A new project starts with a clean editor.
  useEffect(() => {
    editorStore.getState().reset();
  }, [projectId]);

  // Parts that no longer exist (an undo, a new model) leave the selection.
  useEffect(() => {
    if (model) editorStore.getState().prune(new Set(model.parts.map((p) => p.id)));
  }, [model]);

  if (!hasThreeD) {
    return (
      <div className="shape-empty">
        <EmptyState icon="cube" title="The Shape tab is for 3D projects" level={2} variant="panel" />
      </div>
    );
  }
  if (!model) return <NoModel projectId={projectId} origin={origin} readOnly={readOnly} />;
  return <Editor Viewport={Viewport} units={units} readOnly={readOnly} />;
}

function NoModel({ projectId, origin, readOnly }: { projectId: string | null; origin?: string; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const fromPhotos = origin === 'multiview' || origin === 'single';
  const open = async () => {
    setBusy(true);
    try {
      // Loaded on demand: the sample and the schema it is checked with are not needed to edit a model.
      await (await import('./sampleModel')).openSampleTeddy();
    } catch (e) {
      notify.error(`The sample teddy could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const goTo = fromPhotos ? 'photos' : 'import';
  return (
    <div className="shape-empty">
      <EmptyState
        icon="cube"
        title="No 3D model yet"
        level={2}
        size="lg"
        variant="panel"
        actions={
          <>
            {projectId ? (
              <Button icon={fromPhotos ? 'camera' : 'import'} onClick={() => navigate({ screen: 'project', projectId, tab: goTo })}>
                {fromPhotos ? 'Go to Photos' : 'Go to Import'}
              </Button>
            ) : null}
            <Button variant="primary" icon="sparkles" loading={busy} disabledReason={readOnly ? 'This project is read-only' : undefined} onClick={() => void open()}>
              Try the sample teddy
            </Button>
          </>
        }
      >
        <p>
          {fromPhotos
            ? 'Build the model from your photos first; it opens here to adjust.'
            : 'Import your Claude Design result first; it opens here to adjust.'}{' '}
          Or try the editor now with a sample teddy bear (you can undo it).
        </p>
      </EmptyState>
    </div>
  );
}

function Editor({ Viewport, units, readOnly }: { Viewport: ComponentType<ViewportProps>; units: 'in' | 'cm'; readOnly: boolean }) {
  const model = useProjectStore((s) => s.doc?.threeD?.model);
  const selection = useEditorStore((s) => s.selection);
  const layers = useEditorStore((s) => s.layers);
  const tool = useEditorStore((s) => s.tool);
  const keys = useModifierKeys();
  const issues = useMemo(() => (model ? gapIssues(model) : []), [model]);

  const onPick = (id: string | null) => editorStore.getState().select(id, { additive: keys.current.shift });

  useEditorShortcuts();
  useShortcutGroup(SHAPE_SHORTCUTS);

  if (!model) return null;
  const primary = selection[selection.length - 1];
  const primaryPart = primary ? model.parts.find((p) => p.id === primary) : undefined;
  return (
    <TabLayout
      className="shape-layout"
      sidebar={<Outliner model={model} issues={issues} />}
      sidebarLabel="Parts"
      inspector={<ShapeInspector model={model} units={units} issues={issues} readOnly={readOnly} />}
      inspectorLabel="Inspector"
      mainLabel="3D view"
      mainPadding="none"
      toolbar={<ShapeToolbar tool={tool} readOnly={readOnly} />}
    >
      <div className="shape-stage">
        <Viewport model={model} meshes={NO_MESHES} selection={selection} layers={layers} onPick={onPick} />
        <CameraButtons />
        <StageHint model={model} selection={selection} tool={tool} readOnly={readOnly} />
        <PickHint model={model} />
        <p className="shape-stage__help" aria-hidden="true">
          Drag to turn · scroll to zoom · right-drag to pan
        </p>
      </div>
      <StatusItems>
        <span>
          {model.parts.length} {model.parts.length === 1 ? 'part' : 'parts'}
        </span>
        {issues.length === 0 ? (
          <Badge tone="success" size="sm">
            Every part touches its parent
          </Badge>
        ) : (
          <Tooltip content={issues.map((i) => i.message).join(' · ')}>
            <span tabIndex={0} className="shape-status-focus">
              <Badge tone="warn" size="sm">
                {issues.length === 1 ? '1 part has a gap' : `${issues.length} parts have gaps`}
              </Badge>
            </span>
          </Tooltip>
        )}
        {primaryPart ? <span className="shape-muted">Selected: {primaryPart.label ?? primaryPart.id}</span> : null}
      </StatusItems>
      <ShapeDialogs model={model} />
    </TabLayout>
  );
}

/** A line on the view when the active tool cannot act: nothing selected, or a part it cannot resize. */
/** While the editor waits for a click on a part's surface (Add part, a sculpted part's start point). */
function PickHint({ model }: { model: CrochetModelV1 }) {
  const pick = useEditorStore((s) => s.surfacePick);
  if (!pick) return null;
  const part = pick.kind === 'seed' ? model.parts.find((p) => p.id === pick.partId) : undefined;
  const text =
    pick.kind === 'add'
      ? `Click on the model where the new ${TYPE_NAMES[pick.type].toLowerCase()} goes. It hangs from the part you click.`
      : `Click on ${part ? (part.label ?? part.id) : 'the part'} where round 1 should start.`;
  return (
    <div className="shape-stage__pick" role="status">
      <span>{text}</span>
      <Button size="sm" variant="secondary" onClick={() => editorStore.getState().setSurfacePick(null)}>
        Cancel (Esc)
      </Button>
    </div>
  );
}

function StageHint({ model, selection, tool, readOnly }: { model: CrochetModelV1; selection: string[]; tool: EditorTool; readOnly: boolean }) {
  if (readOnly || tool === 'select') return null;
  const verb = tool === 'move' ? 'move' : tool === 'rotate' ? 'turn' : 'resize';
  const primary = selection[selection.length - 1];
  const part = primary ? model.parts.find((p) => p.id === primary) : undefined;
  const blocked = part && tool === 'scale' ? scaleBlockedReason(part) : null;
  const text = !part ? `Select a part to ${verb} it` : blocked;
  if (!text) return null;
  return (
    <p className="shape-stage__hint" role="status">
      {text}
    </p>
  );
}

function ShapeToolbar({ tool, readOnly }: { tool: EditorTool; readOnly: boolean }) {
  const follow = useEditorStore((s) => s.followAttached);
  const layers = useEditorStore((s) => s.layers);
  return (
    <Toolbar label="Shape tools">
      <SegmentedControl<EditorTool>
        ariaLabel="Tool"
        size="sm"
        value={readOnly ? 'select' : tool}
        onChange={(t) => editorStore.getState().setTool(t)}
        disabled={readOnly}
        options={TOOLS.map((t) => ({ value: t.value, label: t.label, tooltip: t.tooltip }))}
      />
      <ToolbarDivider />
      <Switch className="shape-follow" label="Attached parts follow" size="sm" checked={follow} onChange={(on) => editorStore.getState().setFollowAttached(on)} />
      <ToolbarDivider />
      <Button size="sm" icon="plus" disabledReason={readOnly ? 'This project is read-only' : undefined} onClick={() => editorStore.getState().setAddDialog(true)}>
        Add part
      </Button>
      <span className="shape-toolbar__spacer" />
      <IconButton icon="grid" label="Ground grid" pressed={!!layers.grid} size="sm" onClick={() => editorStore.getState().setLayer('grid', !layers.grid)} />
      <IconButton icon="sun" label="Ground shadow" pressed={layers.shadow !== false} size="sm" onClick={() => editorStore.getState().setLayer('shadow', layers.shadow === false)} />
      <IconButton icon="layers" label="Wireframe" pressed={!!layers.wireframe} size="sm" onClick={() => editorStore.getState().setLayer('wireframe', !layers.wireframe)} />
    </Toolbar>
  );
}

function CameraButtons() {
  const request = (view: CameraView) => editorStore.getState().requestCamera(view);
  return (
    <div className="shape-cameras" role="group" aria-label="Camera">
      {VIEWS.map((v) => (
        <Tooltip key={v.view} content={v.tip}>
          <button type="button" className="shape-cameras__btn" onClick={() => request(v.view)}>
            {v.label}
          </button>
        </Tooltip>
      ))}
      <span className="shape-cameras__sep" aria-hidden="true" />
      <Tooltip content="Three-quarter view of the whole toy">
        <button type="button" className="shape-cameras__btn" onClick={() => request('home')}>
          Reset
        </button>
      </Tooltip>
      <Tooltip content="Zoom to the selected parts" shortcut="F">
        <button type="button" className="shape-cameras__btn" onClick={() => request('fit')}>
          Frame
        </button>
      </Tooltip>
    </div>
  );
}

/** The Shape tab's rows of the "?" shortcut list (integration task T6.1). */
const SHAPE_SHORTCUTS: ShortcutGroup = {
  id: 'shape',
  title: 'Shape tab',
  rows: [
    { keys: [['Q']], what: 'Select' },
    { keys: [['W']], what: 'Move' },
    { keys: [['E']], what: 'Rotate' },
    { keys: [['R']], what: 'Resize' },
    { keys: [['F']], what: 'Frame the selection' },
    { keys: [[IS_MAC ? '⌘' : 'Ctrl', 'D']], what: 'Duplicate the selected parts' },
    { keys: [['M']], what: 'Mirror to the other side (or update the mirrored twin)' },
    { keys: [['⌫'], ['Delete']], what: 'Delete the selected parts (asks first)' },
    { keys: [['Esc']], what: 'Cancel a drag or placing; clear the selection' },
    { keys: [['⌥']], what: 'Hold while dragging: move a part without the parts attached to it' },
    { keys: [['⇧']], what: 'Hold while dragging: no snapping · ⇧-click adds to the selection' },
  ],
};

/**
 * Q / W / E / R pick the tool, F frames the selection, ⌘D duplicates, M mirrors, ⌫ asks to delete, Escape cancels a
 * drag or a surface pick, then clears the selection (outside text fields and dialogs).
 */
function useEditorShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const editor = editorStore.getState();
      const readOnly = projectStore.getState().readOnly;
      const key = e.key.toLowerCase();
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && key === 'd') {
        // Before the browser's bookmark shortcut.
        e.preventDefault();
        if (!readOnly && editor.selection.length > 0) duplicateSelection();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && editor.dragging) {
        // Escape during a gizmo drag cancels it (no history step); the selection stays.
        e.preventDefault();
        editor.cancelDrag?.();
        return;
      }
      if (e.key === 'Escape' && editor.surfacePick) {
        e.preventDefault();
        editor.setSurfacePick(null);
        return;
      }
      const tool = TOOL_KEYS[key];
      if (tool) {
        if (readOnly) return;
        e.preventDefault();
        editor.setTool(tool);
      } else if (key === 'f') {
        e.preventDefault();
        editor.requestCamera('fit');
      } else if (key === 'm' && !e.shiftKey) {
        if (readOnly || editor.selection.length === 0) return;
        e.preventDefault();
        mirrorSelection();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (readOnly || editor.selection.length === 0) return;
        e.preventDefault();
        requestDeleteSelection();
      } else if (e.key === 'Escape' && editor.selection.length > 0) {
        e.preventDefault();
        editor.select(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
