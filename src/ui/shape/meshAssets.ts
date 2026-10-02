// Track T6.3 — mesh parts' buffers for the editor (DESIGN.md §5.5.6, integration-s2 task T6-6): `threeD.meshAssets`
// holds one `ColoredMesh` asset per mesh part (`<meshRef>`, plus `sdf:<meshRef>` volumes the editor does not read),
// stored and read ONLY through the shared codec (`meshAssetCodec`). Decoded meshes are cached by asset key, so the
// same bytes are decoded once and a changed asset (new labels after painting, a palette re-index) is a new object
// that the viewport's geometry cache rebuilds.
//
// Writing: a mesh is never edited in place. A new buffer is stored as a new content-addressed asset and the model's
// `meshAssets[meshRef]` is pointed at it in the same history step as the model change (copy-on-write, §4.4); undo
// points it back.
import { useEffect, useMemo, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { meshAssetCodec } from '../../core/kernel/assetCodecs';
import { projectStore, useProjectStore, type ProjectStore } from '../../state/projectStore';
import { currentModel, withRevision } from '../../state/slices/model3d';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1 } from '../../types/model';
import type { AssetRef, ProjectDoc } from '../../types/project';

const MAX_CACHED = 48;
const decoded = new Map<string, ColoredMesh>();
const pending = new Map<string, Promise<ColoredMesh | null>>();
/** Asset keys that failed to decode (each reported once). */
const failed = new Map<string, string>();

function remember(key: string, mesh: ColoredMesh): void {
  decoded.delete(key);
  decoded.set(key, mesh);
  while (decoded.size > MAX_CACHED) decoded.delete(decoded.keys().next().value as string);
}

/** Puts a mesh the editor just stored into the decode cache (no need to decode its own bytes back). */
export function rememberMesh(key: string, mesh: ColoredMesh): void {
  remember(key, mesh);
}

/** The decoded mesh of an asset, if it is cached. */
export function cachedMesh(ref: AssetRef | undefined): ColoredMesh | undefined {
  return ref ? decoded.get(ref.key) : undefined;
}

/** Why an asset could not be read, if it failed. */
export function meshLoadError(ref: AssetRef | undefined): string | undefined {
  return ref ? failed.get(ref.key) : undefined;
}

/** Loads and decodes one mesh asset (null when it is missing or invalid: the part is then drawn as its box's ellipsoid). */
export function loadMesh(ref: AssetRef, store: ProjectStore = projectStore): Promise<ColoredMesh | null> {
  const hit = decoded.get(ref.key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(ref.key);
  if (running) return running;
  const job = (async () => {
    try {
      const blob = await store.getState().getAsset(ref);
      const mesh = await meshAssetCodec.decode(blob);
      remember(ref.key, mesh);
      failed.delete(ref.key);
      return mesh;
    } catch (e) {
      failed.set(ref.key, e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      pending.delete(ref.key);
    }
  })();
  pending.set(ref.key, job);
  return job;
}

/** The mesh parts' asset refs of a document, by meshRef. */
export function meshRefsOf(doc: Pick<ProjectDoc, 'threeD'> | null | undefined): Record<string, AssetRef> {
  const out: Record<string, AssetRef> = {};
  const threeD = doc?.threeD;
  if (!threeD?.model) return out;
  for (const p of threeD.model.parts) {
    if (p.type !== 'mesh') continue;
    const ref = Object.hasOwn(threeD.meshAssets, p.dims.meshRef) ? threeD.meshAssets[p.dims.meshRef] : undefined;
    if (ref) out[p.dims.meshRef] = ref;
  }
  return out;
}

/** Every mesh part's buffer of the open model (missing or invalid assets are left out). */
export async function loadModelMeshes(store: ProjectStore = projectStore): Promise<Record<string, ColoredMesh>> {
  const refs = meshRefsOf(store.getState().doc);
  const out: Record<string, ColoredMesh> = {};
  await Promise.all(
    Object.entries(refs).map(async ([meshRef, ref]) => {
      const mesh = await loadMesh(ref, store);
      if (mesh) out[meshRef] = mesh;
    }),
  );
  return out;
}

// ---- previews (a paint stroke on a mesh part shows before its asset is stored)

interface PreviewState {
  meshes: Readonly<Record<string, ColoredMesh>>;
}
export const meshPreview = createStore<PreviewState>()(() => ({ meshes: {} }));

export function setMeshPreview(meshRef: string, mesh: ColoredMesh | null): void {
  const cur = meshPreview.getState().meshes;
  if (mesh === null) {
    if (!Object.hasOwn(cur, meshRef)) return;
    const next = { ...cur };
    delete next[meshRef];
    meshPreview.setState({ meshes: next });
  } else meshPreview.setState({ meshes: { ...cur, [meshRef]: mesh } });
}

/**
 * The open model's mesh buffers by meshRef, for the viewport and the paint tools: decoded on demand, stable while
 * nothing changes, with stroke previews on top.
 */
export function useModelMeshes(): Record<string, ColoredMesh> {
  const model = useProjectStore((s) => s.doc?.threeD?.model);
  const assets = useProjectStore((s) => s.doc?.threeD?.meshAssets);
  const previews = useStore(meshPreview, (s) => s.meshes);
  const [loaded, setLoaded] = useState(0);
  const refs = useMemo(() => meshRefsOf(model && assets ? { threeD: { model, meshAssets: assets } as ProjectDoc['threeD'] } : null), [model, assets]);
  const key = Object.entries(refs)
    .map(([m, r]) => `${m}=${r.key}`)
    .join('|');
  useEffect(() => {
    let alive = true;
    const missing = Object.values(refs).filter((r) => !decoded.has(r.key) && !failed.has(r.key));
    if (missing.length === 0) return;
    void Promise.all(missing.map((r) => loadMesh(r))).then(() => {
      if (alive) setLoaded((n) => n + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const out: Record<string, ColoredMesh> = {};
    for (const [meshRef, ref] of Object.entries(refs)) {
      const mesh = decoded.get(ref.key);
      if (mesh) out[meshRef] = mesh;
    }
    for (const [meshRef, mesh] of Object.entries(previews)) if (Object.hasOwn(refs, meshRef)) out[meshRef] = mesh;
    return Object.freeze(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded, previews]);
}

// ---- writing

/** Stores mesh buffers as assets (one content-addressed asset each). */
export async function storeMeshes(meshes: Readonly<Record<string, ColoredMesh>>, store: ProjectStore = projectStore): Promise<Record<string, AssetRef>> {
  const out: Record<string, AssetRef> = {};
  for (const [meshRef, mesh] of Object.entries(meshes)) {
    const ref = await store.getState().putAsset(meshAssetCodec.encode(mesh), meshAssetCodec.mime);
    remember(ref.key, mesh);
    out[meshRef] = ref;
  }
  return out;
}

/** What a mesh-aware edit returns: the new model and the mesh buffers it changed (by meshRef). */
export interface MeshEditResult {
  model: CrochetModelV1;
  meshes?: Readonly<Record<string, ColoredMesh>>;
}

/**
 * Runs an edit that may change mesh buffers as ONE history step: the changed buffers are stored first (new assets),
 * then the model (revision + 1) and its `meshAssets` entries change together. Resolves false when nothing changed,
 * the project is read-only, or the project changed while the assets were stored.
 */
export async function editModelWithMeshes(
  label: string,
  edit: (model: CrochetModelV1, meshes: Readonly<Record<string, ColoredMesh>>) => MeshEditResult,
  o: { store?: ProjectStore } = {},
): Promise<boolean> {
  const store = o.store ?? projectStore;
  const model = currentModel(store);
  if (!model || store.getState().readOnly) return false;
  const session = store.getState().session;
  const meshes = await loadModelMeshes(store);
  const base = currentModel(store);
  if (base !== model || store.getState().session !== session) return false;
  const r = edit(model, meshes);
  const changed: Record<string, ColoredMesh> = {};
  for (const [meshRef, mesh] of Object.entries(r.meshes ?? {})) if (mesh !== meshes[meshRef]) changed[meshRef] = mesh;
  if (r.model === model && Object.keys(changed).length === 0) return false;
  const refs = Object.keys(changed).length > 0 ? await storeMeshes(changed, store) : {};
  if (currentModel(store) !== model || store.getState().session !== session) return false;
  return store.getState().update(label, (draft) => {
    const threeD = draft.threeD;
    if (!threeD?.model) return;
    if (r.model !== model) threeD.model = withRevision(model, r.model) as typeof threeD.model;
    else if (Object.keys(refs).length > 0) threeD.model.revision = model.revision + 1;
    for (const [meshRef, ref] of Object.entries(refs)) threeD.meshAssets[meshRef] = ref;
  });
}

/** Test hook: forget every decoded mesh. */
export function resetMeshCache(): void {
  decoded.clear();
  pending.clear();
  failed.clear();
  meshPreview.setState({ meshes: {} });
}
