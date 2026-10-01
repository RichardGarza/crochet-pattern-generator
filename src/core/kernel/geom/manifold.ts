// The manifold-3d loader (DESIGN.md §5.4). Step 0 kernel, shared by T3 (geom.worker) and T5 (mesh.worker).
//
// One initialization for node tests and for workers: in node, Emscripten finds manifold.wasm next to its own
// module; in a browser or worker the URL comes from Vite (`?url`). The Vite config keeps manifold-3d out of
// dependency pre-bundling, because its default `new URL('manifold.wasm', import.meta.url)` breaks there.
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { GetManifoldFn } from '../../../types/entryPoints';
import type { MeshLike } from './meshMeasures';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

let ready: Promise<ManifoldToplevel> | undefined;

/**
 * The initialized manifold-3d module (`setup()` already called). Every call returns the same promise, so the
 * WASM module is instantiated once per thread. If the initialization fails, the next call tries again.
 */
export const getManifold: GetManifoldFn = () =>
  (ready ??= Module(isNode ? undefined : { locateFile: () => wasmUrl }).then(
    (m) => {
      m.setup();
      return m;
    },
    (error: unknown) => {
      ready = undefined;
      throw error;
    },
  ));

/** What manifold-3d says about a triangle mesh (§2.9.5 step 5). */
export interface ManifoldReport {
  /**
   * `'NoError'` when manifold-3d accepts the mesh as an oriented 2-manifold; otherwise its error status
   * (`'NotManifold'` for a hole, a T-junction or inconsistent winding, `'NonFiniteVertex'` for a NaN, …).
   */
  status: string;
  /** Number of connected parts (`decompose().length`); 0 when the status is not `'NoError'` or the mesh is empty. */
  parts: number;
  /** Genus of the largest part by |volume| (0 = sphere-like, 1 = one handle); 0 when there is no part. */
  genus: number;
  /** Signed volume of the whole mesh as manifold-3d measures it: negative for an inside-out mesh. */
  volume: number;
}

/**
 * Validates an indexed mesh with manifold-3d and frees every WASM object it creates. The buffers are copied,
 * never modified. A mesh that manifold-3d rejects gives its error status, not an exception.
 *
 * manifold-3d accepts an inside-out mesh with status `'NoError'`: check `volume > 0` too.
 */
export async function manifoldReport(mesh: MeshLike): Promise<ManifoldReport> {
  const { Manifold, Mesh } = await getManifold();
  const input = new Mesh({ numProp: 3, vertProperties: Float32Array.from(mesh.positions), triVerts: Uint32Array.from(mesh.indices) });
  let solid: InstanceType<typeof Manifold>;
  try {
    solid = new Manifold(input);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return { status: code, parts: 0, genus: 0, volume: 0 };
    throw error;
  }
  try {
    const status = solid.status();
    if (status !== 'NoError') return { status, parts: 0, genus: 0, volume: 0 };
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
      return { status, parts: parts.length, genus, volume };
    } finally {
      for (const part of parts) part.delete();
    }
  } finally {
    solid.delete();
  }
}
