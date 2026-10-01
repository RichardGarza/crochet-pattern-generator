// Track T7 — GLB (DESIGN.md §3.7.5). T7.1 reads the 12-byte header and the JSON chunk and implements ladder step 1
// only (a spec stored as `nodes[].extras.crochetModel`), which is also how an archive's GLB becomes a spec
// candidate (§3.7.2). Steps 2–4 (per-node extras, the observed extras with matrices, geometry fit) are T7.2.
import { isPlainObject } from './common';
import { isSpecLike, parseJsonSafe } from './text';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

export type GlbJson = { ok: true; json: Record<string, unknown> } | { ok: false; error: string; forbidden?: string };

/** The glTF JSON of a binary glTF 2.0 file (header, then the first chunk, which must be JSON). */
export function readGlbJson(bytes: Uint8Array): GlbJson {
  if (bytes.length < 20) return { ok: false, error: 'the GLB file is too short' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return { ok: false, error: 'not a GLB file' };
  const version = view.getUint32(4, true);
  if (version !== 2) return { ok: false, error: `GLB version ${version} (this app reads version 2)` };
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + length > bytes.length) return { ok: false, error: 'the GLB has no readable JSON chunk' };
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, forbidden: parsed.forbidden };
  if (!isPlainObject(parsed.value)) return { ok: false, error: 'the GLB JSON is not an object' };
  return { ok: true, json: parsed.value };
}

/** Ladder step 1: the first node whose `extras.crochetModel` is a spec. */
export function specFromGltfJson(json: Record<string, unknown>): Record<string, unknown> | null {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || !isPlainObject(node.extras)) continue;
    const spec = node.extras.crochetModel;
    if (isSpecLike(spec)) return spec as Record<string, unknown>;
  }
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  for (const scene of scenes) if (isPlainObject(scene) && isPlainObject(scene.extras) && isSpecLike(scene.extras.crochetModel)) return scene.extras.crochetModel as Record<string, unknown>;
  return null;
}
