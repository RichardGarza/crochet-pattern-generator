// The kernels against what Claude Design really exported (fixtures/claude-design/teddy-bear, research 08): the
// page's own GLB and OBJ downloads were produced by three.js r184 from the same spec, independently of this
// code. They are the reference for the dialect's nested transforms, for the analytic surfaces and for the
// bounding boxes. Also here: `buildModel` against the normative builder code of DESIGN.md §3.4.1, run as written.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'fflate';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part } from '../../../types/model';
import { buildModel } from '../builder';
import { partSdf } from '../sdf';
import { composeMat4, decomposeMat4, modelBounds, multiplyMat4, worldBounds } from '../transforms';
import { readEveryType } from './helpers/everyType';
import { readSpecExample } from './helpers/geometry';
import { buildCanonicalTeddy, CANONICAL_TEDDY_URL, FIXTURES_DIR } from './helpers/teddy';

const TEDDY_DIR = new URL('claude-design/teddy-bear/', FIXTURES_DIR);
/** The teddy after dialect normalization, before grounding: the coordinates Claude Design's page used. */
const normalized = buildCanonicalTeddy().normalized;

describe('the GLB export (three.js GLTFExporter r184)', () => {
  interface GltfNode {
    name?: string;
    matrix?: number[];
    children?: number[];
    extras?: { type?: string; dimensions?: Record<string, number> };
  }
  const bytes = readFileSync(new URL('amigurumi-teddy-bear.glb', TEDDY_DIR));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as { scene?: number; scenes: { nodes: number[] }[]; nodes: GltfNode[] };

  it('is the file research 08 describes: glTF 2, a JSON chunk, one node per part named by its id', () => {
    expect(view.getUint32(0, true)).toBe(0x46546c67); // "glTF"
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
    for (const p of normalized.parts) expect(gltf.nodes.some((n) => n.name === p.id), p.id).toBe(true);
  });

  it('§3.7.7: node matrices multiplied down the hierarchy decompose to the absolute transforms of the JSON dialect (±1e-4; here 1e-12)', () => {
    const identity = composeMat4([0, 0, 0]);
    const world = new Map<number, number[]>();
    const visit = (index: number, parent: number[]): void => {
      const node = gltf.nodes[index];
      const m = multiplyMat4(parent, node.matrix ?? identity);
      world.set(index, m);
      for (const child of node.children ?? []) visit(child, m);
    };
    for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, identity);
    let compared = 0;
    for (const p of normalized.parts) {
      const index = gltf.nodes.findIndex((n) => n.name === p.id);
      const { position, rotationDeg, scale } = decomposeMat4(world.get(index) as number[]);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(position[k] - p.position[k]), `${p.id} position[${k}]`).toBeLessThan(1e-12);
        expect(Math.abs(rotationDeg[k] - (p.rotationDeg ?? [0, 0, 0])[k]), `${p.id} rotation[${k}]`).toBeLessThan(1e-12);
        expect(scale[k]).toBeCloseTo(1, 12); // children are not scaled by their parents (§3.7.3)
      }
      compared++;
    }
    expect(compared).toBe(17);
    // nested three deep: head → muzzle → nose
    const nose = gltf.nodes.findIndex((n) => n.name === 'nose');
    const muzzle = gltf.nodes.findIndex((n) => n.name === 'muzzle');
    expect(gltf.nodes[muzzle].children).toContain(nose);
  });

  it('extras carry the dialect dims: a capsule length there is the straight section, ours the total', () => {
    const leg = gltf.nodes.find((n) => n.name === 'leg_l');
    expect(leg?.extras).toEqual({ name: 'Left Leg', type: 'capsule', dimensions: { radius: 0.75, length: 1.6 } });
    const ours = normalized.parts.find((p) => p.id === 'leg_l') as Extract<Part, { type: 'capsule' }>;
    expect(ours.dims).toEqual({ r: 0.75, length: 1.6 + 2 * 0.75 });
  });
});

describe('the OBJ export (world-space vertices, one object per part)', () => {
  // 9.5 MB of text: one pass, keeping each object's box and every seventh vertex.
  const text = new TextDecoder().decode(gunzipSync(readFileSync(new URL('amigurumi-teddy-bear.obj.gz', TEDDY_DIR))));
  interface Shape {
    min: number[];
    max: number[];
    count: number;
    sample: number[];
  }
  const objects = new Map<string, Shape>();
  let current: Shape | undefined;
  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const a = text.charCodeAt(start);
    const b = text.charCodeAt(start + 1);
    if (a === 111 && b === 32) {
      current = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], count: 0, sample: [] };
      objects.set(text.slice(start + 2, end).trim(), current);
    } else if (a === 118 && b === 32 && current) {
      const v = text
        .slice(start + 2, end)
        .trim()
        .split(/\s+/)
        .map(Number);
      for (let k = 0; k < 3; k++) {
        current.min[k] = Math.min(current.min[k], v[k]);
        current.max[k] = Math.max(current.max[k], v[k]);
      }
      if (current.count % 7 === 0) current.sample.push(v[0], v[1], v[2]);
      current.count++;
    }
    start = end + 1;
  }

  it('has the 17 parts and 38 165 vertices of research 08', () => {
    expect([...objects.keys()].sort()).toEqual(normalized.parts.map((p) => p.id).sort());
    expect([...objects.values()].reduce((n, o) => n + o.count, 0)).toBe(38165);
  });

  it('every exported vertex lies on the analytic surface of its part (|sdf| < 1e-5 in)', () => {
    let checked = 0;
    for (const p of normalized.parts) {
      const f = partSdf(p);
      const o = objects.get(p.id) as Shape;
      for (let i = 0; i < o.sample.length; i += 3) {
        expect(Math.abs(f([o.sample[i], o.sample[i + 1], o.sample[i + 2]])), p.id).toBeLessThan(1e-5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('worldBounds contains every part’s exported vertices and is tight (within the tessellation, < 0.003 in)', () => {
    for (const p of normalized.parts) {
      const box = worldBounds(p);
      const o = objects.get(p.id) as Shape;
      for (let k = 0; k < 3; k++) {
        expect(o.min[k], `${p.id} min[${k}]`).toBeGreaterThanOrEqual(box.min[k] - 1e-6);
        expect(o.max[k], `${p.id} max[${k}]`).toBeLessThanOrEqual(box.max[k] + 1e-6);
        expect(o.min[k] - box.min[k], `${p.id} min[${k}] tight`).toBeLessThan(0.003);
        expect(box.max[k] - o.max[k], `${p.id} max[${k}] tight`).toBeLessThan(0.003);
      }
    }
  });

  it('the model box is the one research 08 measured on this file: x ±2.906, y −0.078 … 9.8, z −2.25 … 2.82', () => {
    const b = modelBounds(normalized);
    const all = [...objects.values()];
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(...all.map((o) => o.min[k]));
      const hi = Math.max(...all.map((o) => o.max[k]));
      expect(Math.abs(b.min[k] - lo)).toBeLessThan(0.001);
      expect(Math.abs(b.max[k] - hi)).toBeLessThan(0.001);
    }
    // The spec's grounding golden (+0.0789) is the exact capsule tip; the tessellated mesh stops at −0.0780.
    expect(b.min[1]).toBeCloseTo(-0.0789, 4);
    expect(Math.min(...all.map((o) => o.min[1]))).toBeCloseTo(-0.078, 3);
  });
});

describe('buildModel is the normative builder of §3.4.1', () => {
  // The code block of DESIGN.md, evaluated as written (its import and export removed).
  const spec = readFileSync(new URL('../../../../docs/DESIGN.md', import.meta.url), 'utf8');
  const heading = spec.indexOf('#### 3.4.1 Shared reference builder');
  const open = spec.indexOf('```js', heading);
  const code = spec
    .slice(open + 5, spec.indexOf('```', open + 5))
    .replace("import * as THREE from 'three';", '')
    .replace('export function buildModel', 'function buildModel');
  const normative = new Function('THREE', `${code}\nreturn buildModel;`)(THREE) as (spec: CrochetModelV1, unitScale?: number) => THREE.Group;

  const teddy = JSON.parse(readFileSync(CANONICAL_TEDDY_URL, 'utf8')) as CrochetModelV1;
  // The normative code has no mesh parts and no paint field: those are app-only additions.
  const everyType = readEveryType();
  const primitives: CrochetModelV1 = {
    ...everyType,
    parts: everyType.parts
      .filter((p) => p.type !== 'mesh')
      .map((p) => {
        const copy = { ...p };
        delete copy.paint;
        return copy;
      }),
  };

  it.each([
    ['the §3.6 example', readSpecExample()],
    ['teddy.canonical.json', teddy],
    ['every-type.json without its mesh part and paint field', primitives],
  ])('gives the same scene, number for number: %s', (_name, model) => {
    for (const unitScale of [undefined, 1]) {
      const expected = unitScale === undefined ? normative(model) : normative(model, unitScale);
      const actual = unitScale === undefined ? buildModel(model) : buildModel(model, unitScale);
      expect(actual.name).toBe(expected.name);
      expect(actual.userData.crochetModel).toBe(expected.userData.crochetModel);
      expect(actual.children).toHaveLength(expected.children.length);
      let numbers = 0;
      expected.children.forEach((child, i) => {
        const e = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        const a = actual.children[i] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        expect(a.name).toBe(e.name);
        expect(a.userData.crochet).toBe(e.userData.crochet);
        expect(a.position.toArray()).toEqual(e.position.toArray());
        expect([a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.order]).toEqual([e.rotation.x, e.rotation.y, e.rotation.z, e.rotation.order]);
        expect(a.material.name).toBe(e.material.name);
        expect(a.material.color.getHex()).toBe(e.material.color.getHex());
        expect(a.material.roughness).toBe(e.material.roughness);
        expect(a.material.metalness).toBe(e.material.metalness);
        expect(a.material.vertexColors).toBe(e.material.vertexColors);
        for (const attribute of ['position', 'color'] as const) {
          const ea = e.geometry.attributes[attribute];
          const aa = a.geometry.attributes[attribute];
          expect(aa === undefined, `${e.name} ${attribute}`).toBe(ea === undefined);
          if (!ea || !aa) continue;
          expect(aa.count).toBe(ea.count);
          let different = 0;
          for (let k = 0; k < ea.count * 3; k++) if (aa.array[k] !== ea.array[k]) different++;
          expect(different, `${e.name} ${attribute}`).toBe(0);
          numbers += ea.count * 3;
        }
        expect(a.geometry.getIndex()?.count).toBe(e.geometry.getIndex()?.count);
      });
      expect(numbers).toBeGreaterThan(40_000);
      // one shared solid material per color id, as in the normative code
      const solids = new Set(actual.children.map((c) => (c as THREE.Mesh).material).filter((m) => !(m as THREE.MeshStandardMaterial).vertexColors));
      const expectedSolids = new Set(expected.children.map((c) => (c as THREE.Mesh).material).filter((m) => !(m as THREE.MeshStandardMaterial).vertexColors));
      expect(solids.size).toBe(expectedSolids.size);
    }
  });
});
