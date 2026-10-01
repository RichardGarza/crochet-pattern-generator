// Track T6 — the viewport's per-part geometry, from the shared builder (`buildModel` at unitScale = 1, inches;
// DESIGN.md §3.4.1, §4.1). A part's geometry depends only on its shape and paint, not on where it sits, so it
// is cached by a key of those fields: a Move or Rotate drag rebuilds nothing, a Scale drag rebuilds one part.
import type { BufferGeometry } from 'three';
import { Mesh } from 'three';
import { buildModel, UNIT_SCALE_INCHES } from '../../core/model/builder';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Part } from '../../types/model';

let meshIds = new WeakMap<ColoredMesh, number>();
let nextMeshId = 1;

function meshKey(m: ColoredMesh | undefined): number {
  if (!m) return 0;
  let id = meshIds.get(m);
  if (id === undefined) meshIds.set(m, (id = nextMeshId++));
  return id;
}

/** Everything of a part (and its model) the builder's geometry and vertex colors depend on. */
export function geometryKey(model: Pick<CrochetModelV1, 'palette'>, part: Part, meshes?: Record<string, ColoredMesh>): string {
  const painted = !!(part.regions?.length || part.paint || part.type === 'mesh');
  return JSON.stringify([
    part.type,
    part.dims,
    painted ? part.color : null,
    part.regions ?? null,
    part.paint ?? null,
    painted ? model.palette.map((c) => [c.id, c.hex]) : null,
    part.type === 'mesh' ? meshKey(meshes?.[part.dims.meshRef]) : 0,
  ]);
}

export interface PartGeometry {
  geometry: BufferGeometry;
  /** The builder painted vertex colors (regions, paint, mesh labels). */
  vertexColors: boolean;
}

/** One part through the shared builder: its local-frame geometry and whether it carries vertex colors. */
export function buildPartGeometry(model: CrochetModelV1, part: Part, meshes?: Record<string, ColoredMesh>): PartGeometry {
  const group = buildModel({ ...model, parts: [part] }, UNIT_SCALE_INCHES, meshes);
  const mesh = group.children[0];
  if (!(mesh instanceof Mesh)) throw new Error(`the builder made no mesh for ${part.id}`);
  const material = mesh.material as { vertexColors?: boolean; dispose(): void };
  const vertexColors = !!material.vertexColors;
  material.dispose();
  const geometry = mesh.geometry as BufferGeometry;
  geometry.computeBoundingSphere();
  return { geometry, vertexColors };
}

/**
 * A small cache of part geometries by `geometryKey`: `sync(model)` returns the geometry of every part, builds
 * the missing ones and disposes the ones no part uses any more.
 */
export class PartGeometryCache {
  private entries = new Map<string, PartGeometry>();

  sync(model: CrochetModelV1, meshes?: Record<string, ColoredMesh>): Map<string, PartGeometry> {
    const used = new Map<string, PartGeometry>();
    const byPart = new Map<string, PartGeometry>();
    for (const part of model.parts) {
      const key = geometryKey(model, part, meshes);
      let entry = used.get(key) ?? this.entries.get(key);
      if (!entry) {
        try {
          entry = buildPartGeometry(model, part, meshes);
        } catch {
          continue; // an unknown part type: nothing to draw (the schema rejects it anyway)
        }
      }
      used.set(key, entry);
      byPart.set(part.id, entry);
    }
    for (const [key, entry] of this.entries) if (!used.has(key)) entry.geometry.dispose();
    this.entries = used;
    return byPart;
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.geometry.dispose();
    this.entries.clear();
  }
}

/** Test hook: forget the mesh-buffer ids. */
export function resetMeshKeys(): void {
  meshIds = new WeakMap();
  nextMeshId = 1;
}
