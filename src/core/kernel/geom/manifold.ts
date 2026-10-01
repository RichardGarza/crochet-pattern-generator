// The manifold-3d loader (DESIGN.md §5.4). Step 0 kernel, shared by T3 (geom.worker) and T5 (mesh.worker).
//
// One initialization for node tests and for workers: in node, Emscripten finds manifold.wasm next to its own
// module; in a browser or worker the URL comes from Vite (`?url`). The Vite config keeps manifold-3d out of
// dependency pre-bundling, because its default `new URL('manifold.wasm', import.meta.url)` breaks there.
import Module, { type ErrorStatus, type Manifold, type ManifoldToplevel, type Mesh } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { GetManifoldFn } from '../../../types/entryPoints';
import type { MeshLike } from './meshMeasures';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

let ready: Promise<ManifoldToplevel> | undefined;

/**
 * The initialized manifold-3d module (`setup()` already called). Every call returns the same promise, so the
 * WASM module is instantiated once per thread. A failed initialization — the wasm did not load, or `setup()`
 * threw — is not kept: the call that failed rejects, the next call starts again.
 */
export const getManifold: GetManifoldFn = () => {
  if (ready === undefined) {
    const attempt = Module(isNode ? undefined : { locateFile: () => wasmUrl }).then((m) => {
      m.setup();
      return m;
    });
    attempt.catch(() => {
      if (ready === attempt) ready = undefined;
    });
    ready = attempt;
  }
  return ready;
};

/** `solid` is present exactly when the status is `'NoError'`; the caller must `delete()` it. */
export type ManifoldFromMesh = { status: 'NoError'; solid: Manifold } | { status: Exclude<ErrorStatus, 'NoError'>; solid?: undefined };

/** What manifold-3d says about a triangle mesh (§2.9.5 step 5). */
export interface ManifoldReport {
  /**
   * `'NoError'` when manifold-3d accepts the mesh as an oriented 2-manifold; otherwise its error status
   * (`'NotManifold'` for a hole, a T-junction or inconsistent winding, `'NonFiniteVertex'` for a NaN,
   * `'VertexOutOfBounds'` for a bad index, …).
   */
  status: ErrorStatus;
  /** Number of connected parts (`decompose().length`); 0 when the status is not `'NoError'` or the mesh is empty. */
  parts: number;
  /** Genus of the largest part by |volume| (0 = sphere-like, 1 = one handle); 0 when there is no part. */
  genus: number;
  /** Signed volume of the whole mesh as manifold-3d measures it: negative for an inside-out mesh. */
  volume: number;
}

type ManifoldConstructor = new (mesh: Mesh) => Manifold;

/**
 * The WASM constructor underneath `Manifold`. After `setup()`, `new Manifold(mesh)` is a JavaScript wrapper
 * that throws on a bad status WITHOUT freeing the object it has just built (manifold-3d 3.5.4: about half a
 * kilobyte of WASM heap lost per rejected mesh). The constructor it wraps returns the object whatever its
 * status, so the status can be read and the object freed. Undefined if a later version is laid out differently.
 */
function rawConstructor(wrapped: ManifoldConstructor): ManifoldConstructor | undefined {
  const parent = Object.getPrototypeOf(wrapped.prototype) as { constructor?: unknown } | null;
  const raw = parent?.constructor;
  return typeof raw === 'function' && raw !== wrapped && raw !== Object ? (raw as ManifoldConstructor) : undefined;
}

/**
 * Builds a manifold-3d solid from an indexed mesh (x, y, z per vertex; triangles counter-clockwise from
 * outside). The buffers are copied, never modified.
 *
 * Returns `{ status: 'NoError', solid }` — the caller owns `solid` and must `delete()` it — or the error
 * status of a mesh that manifold-3d rejects; a rejected mesh is not an exception and leaves nothing behind
 * in the WASM heap. An index that is not an integer in [0, 2³²) gives `'VertexOutOfBounds'`; a position
 * buffer whose length is not a multiple of 3 gives `'PropertiesWrongLength'` (manifold-3d itself would drop
 * the trailing values and accept the rest as a valid solid). Malformed buffers are statuses here, not the
 * `RangeError` of ./meshMeasures.ts, so that a caller validating a mesh (§2.9.5 step 5) has one check.
 *
 * manifold-3d accepts an inside-out mesh: check `solid.volume() > 0` too.
 */
export async function manifoldFromMesh(mesh: MeshLike): Promise<ManifoldFromMesh> {
  const toplevel = await getManifold();
  const { positions, indices } = mesh;
  if (positions.length % 3 !== 0) return { status: 'PropertiesWrongLength' };
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    // Uint32Array.from would turn 2.9 into 2 and NaN into 0, and validate a mesh that was not passed in.
    if (!(v >= 0 && v <= 0xffffffff) || !Number.isInteger(v)) return { status: 'VertexOutOfBounds' };
  }
  const input = new toplevel.Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: Uint32Array.from(indices) });
  const Wrapped = toplevel.Manifold;
  const Raw = rawConstructor(Wrapped);
  let solid: Manifold;
  try {
    solid = new (Raw ?? Wrapped)(input);
  } catch (error) {
    // The wrapper's ManifoldError carries the status in `code`.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code !== 'NoError') return { status: code as Exclude<ErrorStatus, 'NoError'> };
    throw error;
  }
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    return { status };
  }
  return { status, solid };
}

/**
 * Validates an indexed mesh with manifold-3d and frees every WASM object it creates: the status, the number
 * of parts, the genus of the largest part and the signed volume. See `manifoldFromMesh` for what is accepted.
 */
export async function manifoldReport(mesh: MeshLike): Promise<ManifoldReport> {
  const built = await manifoldFromMesh(mesh);
  if (built.status !== 'NoError') return { status: built.status, parts: 0, genus: 0, volume: 0 };
  const { solid } = built;
  try {
    const volume = solid.volume();
    const parts = solid.decompose();
    try {
      let genus = 0;
      let largest = -1;
      for (const part of parts) {
        const size = Math.abs(part.volume());
        if (size > largest) {
          largest = size;
          genus = part.genus();
        }
      }
      return { status: 'NoError', parts: parts.length, genus, volume };
    } finally {
      for (const part of parts) part.delete();
    }
  } finally {
    solid.delete();
  }
}
