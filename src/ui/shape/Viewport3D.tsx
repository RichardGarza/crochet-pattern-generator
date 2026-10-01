// Track T6 — the Shape tab's real viewport (DESIGN.md §4.1, §4.2): react-three-fiber over the shared builder at
// unitScale = 1 (inches), with a soft studio light, a contact shadow on the ground, matte "yarn" materials, a
// selection outline, the Move / Rotate / Scale gizmo and the Front / Left / Back / Top cameras.
//
// It renders `ViewportProps` (frozen, §5.2.1) and reads the editor's UI state (tool, hover, camera requests) from
// `editorStore`; every authored change goes through `state/slices/model3d.ts`. happy-dom has no WebGL, so the
// tab's tests pass a stub `Viewport` and this file is covered by the browser spec (e2e/tracks/t6-shape.spec.ts).
import { ContactShadows, Environment, Grid, Lightformer, OrbitControls, Outlines, TransformControls } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Euler, MathUtils, MeshPhysicalMaterial, NeutralToneMapping, Object3D, PCFShadowMap, PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { boundsCenter, boundsSize, modelBounds, worldBounds, type Bounds } from '../../core/model/transforms';
import {
  beginModelGesture,
  beginResizeGesture,
  pivotOf,
  scaleBlockedReason,
  scalePart,
  SNAP_MOVE_IN,
  SNAP_ROTATE_DEG,
  transformByPivot,
  type ModelGesture,
  type Pivot,
  type ResizeGesture,
} from '../../state/slices/model3d';
import { useProjectStore } from '../../state/projectStore';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import type { ViewportProps } from '../../types/ui';
import { editorStore, transformScope, useEditorStore, type CameraView } from './editorStore';
import { useModifierKeys, type ModifierKeys } from './modifiers';
import { PartGeometryCache, type PartGeometry } from './partGeometry';
import { completeSurfacePick } from './tools';
import { useCssColor } from './useCssColor';
import { disposeYarnMaterial, stitchRepeat, yarnMaterial } from './yarnLook';

/** Shared by the gizmo and the click handlers: a click that ends a gizmo drag must not change the selection. */
const gizmoState = { busy: false, lastDragEnd: 0 };

/** True while a gizmo drag runs or has just ended (its pointer-up also produces a click). */
function gizmoBusy(): boolean {
  return gizmoState.busy || performance.now() - gizmoState.lastDragEnd < 250;
}

const FOV = 30;

export function Viewport3D(props: ViewportProps) {
  const { onPick } = props;
  return (
    <div className="shape-viewport" data-testid="shape-viewport">
        <Canvas
          frameloop="demand"
          shadows={{ type: PCFShadowMap }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, toneMapping: NeutralToneMapping, toneMappingExposure: 1.05, preserveDrawingBuffer: false }}
          camera={{ fov: FOV, near: 0.05, far: 400, position: [9, 9, 22] }}
          onPointerMissed={(e) => {
            if (e.type !== 'click') return;
            if (gizmoBusy()) return;
            onPick?.(null);
          }}
          aria-label="3D view of the model"
          role="img"
        >
          <Scene {...props} />
        </Canvas>
    </div>
  );
}

function Scene({ model, meshes, selection, layers, onPick }: ViewportProps) {
  const bounds = useMemo(() => modelBounds(model, meshes), [model, meshes]);
  const size = boundsSize(bounds);
  const extent = Math.max(size[0], size[1], size[2], 1);
  const center = boundsCenter(bounds);
  return (
    <>
      <Lights bounds={bounds} extent={extent} />
      <Parts model={model} meshes={meshes} selection={selection} wireframe={!!layers.wireframe} onPick={onPick} />
      {/* Always mounted: drei's ContactShadows never frees its render targets, so it must not be re-created on
          edits (its size comes in powers of two) or toggled by unmounting (off = hidden and not rendered). */}
      <ContactShadows
        position={[center[0], bounds.min[1] - 0.002, center[2]]}
        scale={shadowScale(extent)}
        far={Math.max(size[1], 1) * 0.9}
        blur={2.2}
        opacity={0.55}
        resolution={512}
        color="#3a2416"
        frames={layers.shadow !== false ? Infinity : 0}
        visible={layers.shadow !== false}
      />
      {layers.grid ? (
        <Grid
          position={[0, bounds.min[1] - 0.004, 0]}
          args={[40, 40]}
          cellSize={0.5}
          sectionSize={2}
          cellThickness={0.6}
          sectionThickness={1}
          cellColor="#8a7a6a"
          sectionColor="#a94b25"
          fadeDistance={extent * 6}
          infiniteGrid
        />
      ) : null}
      <Gizmo model={model} meshes={meshes} selection={selection} />
      <CameraRig bounds={bounds} model={model} meshes={meshes} selection={selection} />
    </>
  );
}

/** The ground shadow's side, inches: a power of two ≥ 2.6 × the model's extent (stable while editing). */
function shadowScale(extent: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(4, extent * 2.6)));
}

// ---- light

function Lights({ bounds, extent }: { bounds: Bounds; extent: number }) {
  const c = boundsCenter(bounds);
  const d = extent * 2.2;
  return (
    <>
      <hemisphereLight args={['#fff6ea', '#6b5544', 0.55]} />
      <directionalLight
        position={[c[0] + d * 0.55, c[1] + d * 1.1, c[2] + d * 0.9]}
        intensity={1.55}
        color="#fff3e2"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.025}
        shadow-radius={6}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={0.1}
        shadow-camera-far={d * 4}
      >
        <object3D attach="target" position={c} />
      </directionalLight>
      <directionalLight position={[c[0] - d, c[1] + d * 0.3, c[2] + d * 0.4]} intensity={0.35} color="#e8eefc" />
      <directionalLight position={[c[0] - d * 0.2, c[1] + d * 0.6, c[2] - d]} intensity={0.55} color="#ffe8d0" />
      <Environment resolution={128} frames={1} environmentIntensity={0.55}>
        <Lightformer form="rect" intensity={2.2} color="#fff4e6" position={[0, 6, 4]} scale={[10, 6, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.1} color="#ffffff" position={[-6, 2, 2]} scale={[4, 6, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.9} color="#ffe2c8" position={[5, 2, -5]} scale={[6, 4, 1]} target={[0, 0, 0]} />
        <Lightformer form="circle" intensity={0.6} color="#d9c7b5" position={[0, -6, 0]} scale={8} target={[0, 0, 0]} />
      </Environment>
    </>
  );
}

// ---- parts

function Parts({
  model,
  meshes,
  selection,
  wireframe,
  onPick,
}: {
  model: CrochetModelV1;
  meshes: Record<string, ColoredMesh>;
  selection: string[];
  wireframe: boolean;
  onPick?: (id: string | null) => void;
}) {
  const [cache] = useState(() => new PartGeometryCache());
  useEffect(() => () => cache.dispose(), [cache]);
  const geometries = useMemo(() => cache.sync(model, meshes), [cache, model, meshes]);
  const palette = useMemo(() => new Map(model.palette.map((c) => [c.id, c.hex])), [model.palette]);
  const hovered = useEditorStore((s) => s.hovered);
  const accent = useCssColor('--color-accent', '#a94b25');
  const selected = useMemo(() => new Set(selection), [selection]);
  const primary = selection[selection.length - 1];
  return (
    <group name="model">
      {model.parts.map((part) => {
        const g = geometries.get(part.id);
        if (!g) return null;
        return (
          <PartMesh
            key={part.id}
            part={part}
            geometry={g}
            hex={palette.get(part.color) ?? '#c8c0b8'}
            wireframe={wireframe}
            outline={selected.has(part.id) ? (part.id === primary ? 'primary' : 'selected') : hovered === part.id ? 'hover' : null}
            accent={accent}
            onPick={onPick}
          />
        );
      })}
    </group>
  );
}

function PartMesh({
  part,
  geometry,
  hex,
  wireframe,
  outline,
  accent,
  onPick,
}: {
  part: Part;
  geometry: PartGeometry;
  hex: string;
  wireframe: boolean;
  outline: 'primary' | 'selected' | 'hover' | null;
  accent: string;
  onPick?: (id: string | null) => void;
}) {
  const repeatKey = JSON.stringify(stitchRepeat(part));
  const material = useMemo<MeshPhysicalMaterial>(
    () => yarnMaterial({ hex, vertexColors: geometry.vertexColors, repeat: JSON.parse(repeatKey) as [number, number] | null, geometry: geometry.geometry, wireframe }),
    [hex, geometry, repeatKey, wireframe],
  );
  useEffect(() => () => disposeYarnMaterial(material), [material]);
  // A hovered part that goes away (undo, a new model) must not leave the pointer cursor behind.
  useEffect(
    () => () => {
      if (editorStore.getState().hovered === part.id) {
        editorStore.getState().setHovered(null);
        document.body.style.cursor = '';
      }
    },
    [part.id],
  );
  const rotation = useMemo(() => {
    const r = part.rotationDeg ?? [0, 0, 0];
    return new Euler(MathUtils.degToRad(r[0]), MathUtils.degToRad(r[1]), MathUtils.degToRad(r[2]), 'XYZ');
  }, [part.rotationDeg]);
  return (
    <mesh
      name={part.id}
      geometry={geometry.geometry}
      material={material}
      position={part.position}
      rotation={rotation}
      castShadow
      receiveShadow
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.delta > 4 || gizmoBusy()) return; // an orbit drag or the end of a gizmo drag, not a click
        if (editorStore.getState().surfacePick) {
          // Add part / a start point: the clicked surface point and its outward normal, in model space.
          const hit: Vec3 = [e.point.x, e.point.y, e.point.z];
          const n = e.face ? e.face.normal.clone().transformDirection(e.object.matrixWorld) : new Vector3(0, 1, 0);
          completeSurfacePick(part.id, hit, [n.x, n.y, n.z]);
          return;
        }
        onPick?.(part.id);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        editorStore.getState().setHovered(part.id);
        document.body.style.cursor = editorStore.getState().surfacePick ? 'crosshair' : 'pointer';
      }}
      onPointerOut={() => {
        if (editorStore.getState().hovered === part.id) editorStore.getState().setHovered(null);
        document.body.style.cursor = '';
      }}
    >
      {outline ? (
        <Outlines
          thickness={outline === 'primary' ? 4 : outline === 'selected' ? 3 : 2.5}
          color={accent}
          opacity={outline === 'hover' ? 0.55 : 1}
          transparent={outline === 'hover'}
          angle={0}
        />
      ) : null}
    </mesh>
  );
}

// ---- gizmo

function Gizmo({ model, selection }: { model: CrochetModelV1; meshes: Record<string, ColoredMesh>; selection: string[] }) {
  const tool = useEditorStore((s) => s.tool);
  const readOnly = useProjectStore((s) => s.readOnly);
  const primaryId = selection[selection.length - 1];
  const part = primaryId ? model.parts.find((p) => p.id === primaryId) : undefined;
  const mode = tool === 'move' ? 'translate' : tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : null;
  if (!part || !mode || readOnly || (mode === 'scale' && scaleBlockedReason(part))) return null;
  return <GizmoFor part={part} mode={mode} />;
}

type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * One gizmo drag, outside React: the pivot proxy the controls move, and the gesture that turns its motion into ONE
 * history step (§4.4) — a resize gesture re-anchors the children at most 10 times a second and on release (§4.2).
 */
class GizmoDrag {
  part: Part | null = null;
  mode: GizmoMode = 'translate';
  readonly proxy = new Object3D();
  private move: ModelGesture | null = null;
  private resize: ResizeGesture | null = null;
  private from: Pivot | null = null;
  private readonly keys: MutableRefObject<ModifierKeys>;
  private readonly invalidate: () => void;

  constructor(keys: MutableRefObject<ModifierKeys>, invalidate: () => void) {
    this.keys = keys;
    this.invalidate = invalidate;
  }

  get active(): boolean {
    return this.move !== null || this.resize !== null;
  }

  /** The part and the mode the gizmo works on now. */
  target(part: Part, mode: GizmoMode): void {
    this.part = part;
    this.mode = mode;
    this.follow();
  }

  /** Puts the proxy on the part's pivot (not during a drag: the drag owns the proxy). */
  follow(): void {
    if (this.active || !this.part) return;
    const pivot = pivotOf(this.part);
    this.proxy.position.set(...pivot.center);
    this.proxy.rotation.set(MathUtils.degToRad(pivot.rotationDeg[0]), MathUtils.degToRad(pivot.rotationDeg[1]), MathUtils.degToRad(pivot.rotationDeg[2]), 'XYZ');
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.invalidate();
  }

  begin(): void {
    const part = this.part;
    if (!part || this.active) return;
    const name = part.label ?? part.id;
    if (this.mode === 'scale') this.resize = beginResizeGesture(`Resize ${name}`);
    else this.move = beginModelGesture(this.mode === 'translate' ? `Move ${name}` : `Rotate ${name}`);
    if (!this.active) return;
    this.from = pivotOf(part);
    gizmoState.busy = true;
    editorStore.getState().setDragging(true, () => this.cancel());
  }

  change(): void {
    const part = this.part;
    if (!part || !this.from) return;
    const proxy = this.proxy;
    if (this.resize) {
      // The handles can be dragged through the center (a negative scale): never below 1%.
      const factors: Vec3 = [Math.max(0.01, proxy.scale.x), Math.max(0.01, proxy.scale.y), Math.max(0.01, proxy.scale.z)];
      const snap = !this.keys.current.shift;
      this.resize.update(part.id, (m, o) => scalePart(m, part.id, factors, { snap, reanchor: o.reanchor }));
      return;
    }
    if (!this.move) return;
    const from = this.from;
    const to: Pivot = {
      center: [proxy.position.x, proxy.position.y, proxy.position.z],
      rotationDeg: [MathUtils.radToDeg(proxy.rotation.x), MathUtils.radToDeg(proxy.rotation.y), MathUtils.radToDeg(proxy.rotation.z)],
    };
    const scope = transformScope(editorStore.getState().followAttached, this.keys.current.alt);
    this.move.update((m) => transformByPivot(m, part.id, from, to, scope));
  }

  end(): void {
    if (!this.active) {
      this.follow(); // after a cancel, the proxy goes back to the part when the pointer is released
      return;
    }
    this.change();
    this.move?.end();
    this.resize?.end();
    this.move = null;
    this.resize = null;
    this.from = null;
    gizmoState.busy = false;
    gizmoState.lastDragEnd = performance.now();
    editorStore.getState().setDragging(false);
    this.follow();
  }

  /** Escape: the drag leaves no history step and the part goes back to where it was. */
  cancel(): void {
    if (!this.active) return;
    this.move?.cancel();
    this.resize?.cancel();
    this.move = null;
    this.resize = null;
    this.from = null;
    gizmoState.busy = false;
    gizmoState.lastDragEnd = performance.now();
    editorStore.getState().setDragging(false);
    this.follow();
  }

  dispose(): void {
    this.end();
  }
}

function GizmoFor({ part, mode }: { part: Part; mode: GizmoMode }) {
  const invalidate = useThree((s) => s.invalidate);
  const keys = useModifierKeys();
  const [drag] = useState(() => new GizmoDrag(keys, invalidate));
  const [snap, setSnap] = useState(true);

  useLayoutEffect(() => {
    drag.target(part, mode);
  }, [drag, part, mode]);
  useEffect(() => () => drag.dispose(), [drag]);

  // ⇧ held = no snapping (§4.2); ⌥ / ⇧ pressed or released mid-drag recomputes from the start.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      setSnap(!e.shiftKey);
      if (drag.active && (e.key === 'Alt' || e.key === 'Shift')) drag.change();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [drag]);

  return (
    <>
      {/* The controls need their object in the scene graph; the proxy draws nothing. */}
      <primitive object={drag.proxy} />
      <TransformControls
      object={drag.proxy}
      mode={mode}
      space={mode === 'scale' ? 'local' : 'world'}
      size={1.15}
      translationSnap={snap ? SNAP_MOVE_IN : null}
      rotationSnap={snap ? MathUtils.degToRad(SNAP_ROTATE_DEG) : null}
      onMouseDown={() => drag.begin()}
      onObjectChange={() => drag.change()}
      onMouseUp={() => drag.end()}
      />
    </>
  );
}

// ---- camera

const VIEW_DIRECTIONS: Record<Exclude<CameraView, 'fit'>, Vec3> = {
  home: [0.62, 0.42, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [1, 0, 0], // the object's own left is +X (§0.1, §2.9.2)
  top: [0, 1, 1e-4], // the object's front at the bottom of the screen
};

function fitDistance(radius: number, camera: PerspectiveCamera): number {
  const vFov = MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fov = Math.min(vFov, hFov);
  return (radius / Math.sin(fov / 2)) * 1.12;
}

function CameraRig({ bounds, model, meshes, selection }: { bounds: Bounds; model: CrochetModelV1; meshes: Record<string, ColoredMesh>; selection: string[] }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const request = useEditorStore((s) => s.camera);
  const anim = useRef<{ fromPos: Vector3; toPos: Vector3; fromTarget: Vector3; toTarget: Vector3; t0: number; ms: number } | null>(null);
  const framedModel = useRef<string | null>(null);

  const goTo = (view: CameraView, animate: boolean) => {
    const ctl = controls.current;
    if (!ctl) return;
    let box = bounds;
    if (view === 'fit' && selection.length > 0) {
      const parts = model.parts.filter((p) => selection.includes(p.id));
      if (parts.length > 0) {
        box = parts.map((p) => worldBounds(p, p.type === 'mesh' ? meshes[p.dims.meshRef] : undefined)).reduce((a, b) => ({ min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] }));
      }
    }
    const size = boundsSize(box);
    const radius = Math.max(0.25, Math.hypot(size[0], size[1], size[2]) / 2);
    // A little higher than the box center, so the camera pill at the top of the view does not cover the model.
    const target = new Vector3(...boundsCenter(box)).add(new Vector3(0, view === 'top' ? 0 : radius * 0.06, 0));
    const dir = view === 'fit' ? camera.position.clone().sub(ctl.target).normalize() : new Vector3(...VIEW_DIRECTIONS[view]).normalize();
    const pos = target.clone().addScaledVector(dir, fitDistance(radius, camera));
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      camera.position.copy(pos);
      ctl.target.copy(target);
      ctl.update();
      anim.current = null;
    } else {
      anim.current = { fromPos: camera.position.clone(), toPos: pos, fromTarget: ctl.target.clone(), toTarget: target, t0: performance.now(), ms: 420 };
    }
    camera.near = Math.max(0.01, radius / 200);
    camera.far = Math.max(100, radius * 60);
    camera.updateProjectionMatrix();
    invalidate();
  };

  // Frame the model when it first appears (a new model, not every edit).
  const modelKey = `${model.name}:${model.parts.length > 0 ? model.parts[0].id : ''}`;
  useEffect(() => {
    if (framedModel.current === modelKey) return;
    framedModel.current = modelKey;
    goTo('home', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const lastNonce = useRef(request.nonce);
  useEffect(() => {
    if (request.nonce === lastNonce.current) return;
    lastNonce.current = request.nonce;
    goTo(request.view, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useFrame(() => {
    const a = anim.current;
    const ctl = controls.current;
    if (!a || !ctl) return;
    const t = Math.min(1, (performance.now() - a.t0) / a.ms);
    const k = 1 - (1 - t) ** 3;
    camera.position.lerpVectors(a.fromPos, a.toPos, k);
    ctl.target.lerpVectors(a.fromTarget, a.toTarget, k);
    ctl.update();
    if (t >= 1) anim.current = null;
    invalidate();
  });

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} minDistance={0.5} maxDistance={200} />;
}
