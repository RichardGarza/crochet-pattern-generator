// Track T5 — the `MeshApi` implementation behind `mesh.worker` (DESIGN.md §2.9.8, §2.10.7, §5.4), kept in core so
// it runs and is tested in node; `workers/mesh.worker.ts` only exposes it.
//
// Two instances run at once — the editor's (it keeps sculpt sessions by `volumeId`) and the private one `ami.worker`
// spawns for Path B — so nothing here is global: each `MeshService` owns its sessions, its job gate and an instance
// tag that prefixes every id it hands out, so an id sent to the wrong instance is refused (`unknown-volume`) instead
// of touching another part's volume. Sessions are kept least-recently-used, at most MAX_SESSIONS per instance.
//
// Every mesh returned is a fresh copy (the kernels copy), so the worker may transfer its buffers without detaching
// any session state. `pathB` runs as a resumable computation and checks the job gate every few ms.
import type { ColoredMesh, SdfVolume } from '../../types/geometry';
import type { MeshApi } from '../../types/workers';
import { cutPart } from './cut';
import { fitMeshPart, meshFromPart } from './convert';
import { mergeParts } from './merge';
import { pathBAsync, type PathBOutcome } from './pathB';
import { SculptSession } from './sculpt';
import { MeshToolError, padVolume, volumeFromSdf } from './volume';
import { MAX_GRID_SIDE, voxelizeMesh } from './voxelize';

/** Sculpt sessions one instance keeps (least recently used are dropped beyond this). */
export const MAX_SESSIONS = 12;
/** Samples of room the sculpt volume keeps around the part (inflate needs space to grow), §2.9.8. */
export const SCULPT_MARGIN = 6;

type Gate = { check(jobId: number): Promise<void> };

/** `MeshApi` without `supersede` (the worker's `exposeApi` adds it on the shared gate). */
export type MeshMethods = Omit<MeshApi, 'supersede'> & { redoSculpt: NonNullable<MeshApi['redoSculpt']> };

function checkColoredMesh(mesh: ColoredMesh, what: string): void {
  if (!mesh || !(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array) || !(mesh.labels instanceof Uint8Array)) {
    throw new RangeError(`${what}: expected a ColoredMesh (Float32Array positions, Uint32Array indices, Uint8Array labels)`);
  }
  if (mesh.positions.length % 3 !== 0 || mesh.labels.length !== mesh.positions.length / 3) throw new RangeError(`${what}: one label per vertex expected`);
}

export class MeshService implements MeshMethods {
  private readonly gate: Gate | undefined;
  private readonly tag: string;
  private counter = 0;
  /** volumeId → session, in least-recently-used order (Map keeps insertion order; a use re-inserts). */
  private readonly sessions = new Map<string, SculptSession>();

  /**
   * `gate` = the worker's job gate (pathB checks it); `tag` = this instance's id prefix (the worker passes a random
   * one; tests pass their own).
   */
  constructor(o: { gate?: Gate; tag?: string } = {}) {
    this.gate = o.gate;
    this.tag = o.tag ?? 'mesh';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(this.tag)) throw new RangeError('the instance tag must be 1–40 letters, digits, - or _');
  }

  /** Ids of the live sculpt sessions, least recently used first (diagnostics, tests). */
  get volumeIds(): string[] {
    return [...this.sessions.keys()];
  }

  private session(volumeId: string): SculptSession {
    const s = typeof volumeId === 'string' ? this.sessions.get(volumeId) : undefined;
    if (!s) throw new MeshToolError('unknown-volume', `no sculpt volume ${String(volumeId)} in this mesh worker (voxelize the part first)`);
    this.sessions.delete(volumeId);
    this.sessions.set(volumeId, s);
    return s;
  }

  /** The session an undo id belongs to (`<volumeId>:<n>`). */
  private sessionOfUndo(undoId: string): SculptSession {
    if (typeof undoId !== 'string' || undoId.lastIndexOf(':') <= 0) throw new MeshToolError('unknown-undo', `unknown undo id ${String(undoId)}`);
    const volumeId = undoId.slice(0, undoId.lastIndexOf(':'));
    if (!this.sessions.has(volumeId)) throw new MeshToolError('unknown-undo', `undo id ${undoId} belongs to no sculpt volume of this mesh worker`);
    return this.session(volumeId);
  }

  async pathB(r: Parameters<MeshApi['pathB']>[0]): Promise<PathBOutcome> {
    const gate = this.gate;
    const check = gate ? () => gate.check(r.jobId) : () => Promise.resolve();
    return pathBAsync(r, check);
  }

  async merge(parts: Parameters<MeshApi['merge']>[0], o?: Parameters<MeshApi['merge']>[1]): ReturnType<MeshApi['merge']> {
    if (!Array.isArray(parts)) throw new RangeError('merge: parts must be an array');
    for (const p of parts) if (p?.mesh) checkColoredMesh(p.mesh, 'merge');
    const res = await mergeParts(parts, { ...(o?.N !== undefined ? { N: o.N } : {}), ...(o?.paletteIds ? { paletteIds: o.paletteIds } : {}) });
    return res;
  }

  async voxelize(mesh: ColoredMesh, N: number, o?: { storedSdf?: SdfVolume }): Promise<{ volumeId: string }> {
    checkColoredMesh(mesh, 'voxelize');
    const minN = 2 * SCULPT_MARGIN + 3;
    if (!Number.isInteger(N) || N < minN || N > MAX_GRID_SIDE) throw new RangeError(`voxelize: N must be an integer in ${minN}…${MAX_GRID_SIDE}, got ${N}`);
    // A reconstructed part keeps its `sdf:<meshRef>` volume (§2.9.8 stored-SDF reuse): no re-voxelization.
    const volume = o?.storedSdf ? padVolume(volumeFromSdf(o.storedSdf), SCULPT_MARGIN) : voxelizeMesh(mesh, N, { margin: SCULPT_MARGIN });
    const volumeId = `${this.tag}-v${++this.counter}`;
    this.sessions.set(volumeId, new SculptSession(volumeId, volume, mesh));
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    return { volumeId };
  }

  async sculpt(volumeId: string, stroke: Parameters<MeshApi['sculpt']>[1]): Promise<{ mesh: ColoredMesh; undoId: string }> {
    const { mesh, undoId } = this.session(volumeId).stroke(stroke);
    return { mesh, undoId };
  }

  async undoSculpt(undoId: string): Promise<{ mesh: ColoredMesh }> {
    return { mesh: this.sessionOfUndo(undoId).undo(undoId) };
  }

  async redoSculpt(undoId: string): Promise<{ mesh: ColoredMesh }> {
    const r = this.sessionOfUndo(undoId).redo(undoId);
    if (!r) throw new MeshToolError('unknown-undo', `nothing to redo for ${undoId}`);
    return { mesh: r.mesh };
  }

  async cut(volumeId: string, plane: Parameters<MeshApi['cut']>[1]): Promise<[ColoredMesh, ColoredMesh]> {
    const s = this.session(volumeId);
    const [a, b] = cutPart(s.volume, plane, s.mesh);
    return [a.mesh, b.mesh];
  }

  async fit(mesh: ColoredMesh): ReturnType<MeshApi['fit']> {
    checkColoredMesh(mesh, 'fit');
    const f = fitMeshPart(mesh);
    return { type: f.type, dims: f.dims, position: f.position, rotationDeg: f.rotationDeg, residual: f.residual };
  }

  async fromPart(part: Parameters<MeshApi['fromPart']>[0], o?: Parameters<MeshApi['fromPart']>[1]): Promise<ColoredMesh> {
    return meshFromPart(part, { ...(o?.paletteIds ? { paletteIds: o.paletteIds } : {}), ...(o?.N !== undefined ? { N: o.N } : {}) });
  }
}
