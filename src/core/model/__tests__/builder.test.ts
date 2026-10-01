import { readFileSync } from 'node:fs';
import { type BufferGeometry, Color, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import {
  buildModel,
  BUILDER_VERSION,
  decodeUv64,
  encodeUv64,
  flatBevelSize,
  flatLayout,
  partGeometry,
  tessellatePart,
  UNIT_SCALE_INCHES,
  UNIT_SCALE_METERS,
  UV64_NONE,
  uv64Cell,
  vertexColorIds,
} from '../builder';
import { readEveryType, readEveryTypeMeshes } from './helpers/everyType';
import { meshVolume, modelOf, part, readSpecExample, samplePrimitives } from './helpers/geometry';
import { HEAVY } from './helpers/options';
import { CANONICAL_TEDDY_URL } from './helpers/teddy';

const example = readSpecExample();
const teddy = JSON.parse(readFileSync(CANONICAL_TEDDY_URL, 'utf8')) as CrochetModelV1;
const everyType = readEveryType();

const meshesOf = (group: Group): Mesh<BufferGeometry, MeshStandardMaterial>[] => group.children as Mesh<BufferGeometry, MeshStandardMaterial>[];

function expectFinite(g: BufferGeometry, label: string): void {
  const pos = g.attributes.position;
  expect(pos.count, `${label}: vertices`).toBeGreaterThan(3);
  for (let i = 0; i < pos.count * 3; i++) {
    if (!Number.isFinite(pos.array[i])) throw new Error(`${label}: position[${i}] is ${pos.array[i]}`);
  }
  const index = g.getIndex();
  const triangles = index ? index.count / 3 : pos.count / 3;
  expect(triangles, `${label}: triangles`).toBeGreaterThan(1);
  if (index) for (let i = 0; i < index.count; i++) expect(index.array[i]).toBeLessThan(pos.count);
  const color = g.attributes.color;
  if (color) for (let i = 0; i < color.count * 3; i++) expect(Number.isFinite(color.array[i])).toBe(true);
  g.computeBoundingBox();
  const box = g.boundingBox;
  expect(box && Number.isFinite(box.min.x + box.min.y + box.min.z + box.max.x + box.max.y + box.max.z), `${label}: bbox`).toBe(true);
}

describe('buildModel = builder-v1 (§3.4.1)', HEAVY, () => {
  it.each([
    ['the §3.6 example', example],
    ['teddy.canonical.json', teddy],
    ['every-type.json', everyType],
  ])('returns one named mesh per part with finite geometry (no NaN): %s', (_name, model) => {
    for (const scale of [UNIT_SCALE_INCHES, UNIT_SCALE_METERS]) {
      const group = buildModel(model, scale, readEveryTypeMeshes());
      expect(group.name).toBe(model.name);
      expect(group.userData.crochetModel).toBe(model);
      const meshes = meshesOf(group);
      expect(meshes.map((m) => m.name)).toEqual(model.parts.map((p) => p.id));
      meshes.forEach((mesh, i) => {
        const p = model.parts[i];
        expect(mesh.isMesh).toBe(true);
        expect(mesh.userData.crochet).toBe(p);
        expectFinite(mesh.geometry, `${p.id} (${p.type})`);
        expect(mesh.position.toArray()).toEqual(p.position.map((v) => v * scale));
        const r = p.rotationDeg ?? [0, 0, 0];
        expect(mesh.rotation.order).toBe('XYZ');
        expect(mesh.rotation.x).toBeCloseTo((r[0] * Math.PI) / 180, 12);
        expect(mesh.rotation.y).toBeCloseTo((r[1] * Math.PI) / 180, 12);
        expect(mesh.rotation.z).toBeCloseTo((r[2] * Math.PI) / 180, 12);
      });
    }
  });

  it('every lathe mesh spans exactly [y_min, y_max] of its profile: the origin is the profile y = 0 point, not the center (§0.1)', () => {
    const lathes: { model: CrochetModelV1; part: Extract<Part, { type: 'lathe' }> }[] = [];
    for (const model of [example, teddy, everyType]) {
      for (const p of model.parts) if (p.type === 'lathe') lathes.push({ model, part: p });
    }
    expect(lathes.length).toBeGreaterThanOrEqual(2);
    const offset = part('lathe', { profile: [[0, -0.75], [1, -0.5], [1.2, 0.5], [0, 2.25]] }, { id: 'offset', position: [3, 4, 5] });
    lathes.push({ model: modelOf([offset]), part: offset });
    for (const { model, part: p } of lathes) {
      const mesh = meshesOf(buildModel(model, 1)).find((m) => m.name === p.id) as Mesh<BufferGeometry>;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      const ys = p.dims.profile.map(([, y]) => y);
      const rMax = Math.max(...p.dims.profile.map(([r]) => r));
      // Float32 vertex buffers: exact to the last float digit
      expect(box?.min.y).toBe(Math.fround(Math.min(...ys)));
      expect(box?.max.y).toBe(Math.fround(Math.max(...ys)));
      expect(box?.max.x).toBeCloseTo(rMax, 6);
      expect(box?.min.z).toBeCloseTo(-rMax, 6);
      expect(mesh.position.toArray()).toEqual(p.position);
    }
  });

  it('unitScale scales positions and geometry alike; the default is the stage scale 0.0254 (meters)', () => {
    const inches = buildModel(example, 1);
    const meters = buildModel(example);
    const explicit = buildModel(example, 0.0254);
    meshesOf(inches).forEach((mesh, i) => {
      const other = meshesOf(meters)[i];
      const a = mesh.geometry.attributes.position;
      const b = other.geometry.attributes.position;
      expect(b.count).toBe(a.count);
      for (let k = 0; k < a.count * 3; k += 37) expect(b.array[k]).toBeCloseTo(a.array[k] * 0.0254, 6);
      expect(other.position.x).toBeCloseTo(mesh.position.x * 0.0254, 12);
      expect(meshesOf(explicit)[i].position.toArray()).toEqual(other.position.toArray());
    });
    expect(BUILDER_VERSION).toBe('builder-v1');
    expect(UNIT_SCALE_METERS).toBe(0.0254);
  });

  it('materials: one shared solid material per color id, named after it; painted parts get "<id>_painted" with vertex colors', () => {
    const meshes = meshesOf(buildModel(example, 1));
    const byName = Object.fromEntries(meshes.map((m) => [m.name, m]));
    expect(byName.head.material.name).toBe('c1');
    expect(byName.head.material).toBe(byName.arm_l.material);
    expect(byName.tail.material.name).toBe('c2');
    expect(byName.head.material.roughness).toBe(0.85);
    expect(byName.head.material.metalness).toBe(0);
    expect(`#${byName.head.material.color.getHexString()}`).toBe('#c8a27a');
    expect(byName.head.geometry.attributes.color).toBeUndefined();
    for (const id of ['body', 'ear_l', 'ear_r', 'foot_l', 'foot_r']) {
      expect(byName[id].material.name).toBe('c1_painted');
      expect(byName[id].material.vertexColors).toBe(true);
      expect(byName[id].geometry.attributes.color.count).toBe(byName[id].geometry.attributes.position.count);
    }
    // an unknown color id falls back to gray instead of throwing
    const gray = meshesOf(buildModel(modelOf([part('sphere', { r: 1 }, { color: 'nope' })]), 1))[0];
    expect(`#${gray.material.color.getHexString()}`).toBe('#cccccc');
    // a color id that is a property of Object.prototype is still just an unknown id
    const proto = meshesOf(buildModel(modelOf([part('sphere', { r: 1 }, { color: 'constructor' })]), 1))[0];
    expect(`#${proto.material.color.getHexString()}`).toBe('#cccccc');
    expect(buildModel(modelOf([part('sphere', { r: 1 })], { name: '' }), 1).name).toBe('model');
  });

  it('geometry per type follows §3.4.1 (segments, axes, sizes)', () => {
    const count = (p: Part): number => partGeometry(p).attributes.position.count;
    expect(count(part('sphere', { r: 1 }))).toBe(49 * 33);
    expect(count(part('ellipsoid', { rx: 1, ry: 2, rz: 3 }))).toBe(49 * 33);
    expect(count(part('capsule', { r: 0.5, length: 2 }))).toBe(33 * (12 * 2 + 1 + 1));
    expect(count(part('lathe', { profile: [[0, 0], [1, 0.5], [0, 1]] }))).toBe(49 * 3);
    expect(count(part('torus', { R: 1, r: 0.2 }))).toBe(25 * 65);
    const box = (p: Part): number[] => {
      const g = partGeometry(p);
      g.computeBoundingBox();
      return [...(g.boundingBox?.min.toArray() ?? []), ...(g.boundingBox?.max.toArray() ?? [])].map((v) => Math.round(v * 1e5) / 1e5);
    };
    expect(box(part('ellipsoid', { rx: 1, ry: 2, rz: 3 }))).toEqual([-1, -2, -3, 1, 2, 3]);
    expect(box(part('capsule', { r: 0.5, length: 3 }))).toEqual([-0.5, -1.5, -0.5, 0.5, 1.5, 0.5]); // TOTAL length 3
    expect(box(part('capsule', { r: 0.5, length: 0.2 }))).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]); // never shorter than a sphere
    expect(box(part('cylinder', { rTop: 0.5, rBottom: 1, h: 2 }))).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(box(part('box', { w: 1, h: 2, d: 3 }))).toEqual([-0.5, -1, -1.5, 0.5, 1, 1.5]);
    expect(box(part('torus', { R: 1, r: 0.25 }))).toEqual([-1.25, -1.25, -0.25, 1.25, 1.25, 0.25]); // ring in local XY
    // cone: apex +Y
    const cone = partGeometry(part('cone', { r: 1, h: 2 })).attributes.position;
    let apexRadius = Infinity;
    for (let i = 0; i < cone.count; i++) if (cone.getY(i) > 0.999) apexRadius = Math.min(apexRadius, Math.hypot(cone.getX(i), cone.getZ(i)));
    expect(apexRadius).toBeLessThan(1e-9);
    // flat: local XY facing +Z, total thickness = dims.thickness, centered
    const flat = box(part('flat', { shape: 'rect', w: 2, h: 1, thickness: 0.3 }));
    expect(flat[2]).toBe(-0.15);
    expect(flat[5]).toBe(0.15);
    expect(flat[3]).toBeCloseTo(-flat[0], 5);
    expect(flat[4]).toBeCloseTo(-flat[1], 5);
    // a cylinder is open only for open: 'both', as written in §3.4.1
    const closed = partGeometry(part('cylinder', { rTop: 1, rBottom: 1, h: 1 })).getIndex()?.count ?? 0;
    const top = partGeometry(part('cylinder', { rTop: 1, rBottom: 1, h: 1, open: 'top' })).getIndex()?.count ?? 0;
    const both = partGeometry(part('cylinder', { rTop: 1, rBottom: 1, h: 1, open: 'both' })).getIndex()?.count ?? 0;
    expect(top).toBe(closed);
    expect(both).toBeLessThan(closed);
    expect(() => partGeometry({ ...part('sphere', { r: 1 }), type: 'egg' } as unknown as Part)).toThrow('unknown part type egg');
  });

  it('every primitive mesh is closed and outward-facing: its volume is positive and matches its size', () => {
    for (const p of samplePrimitives()) expect(meshVolume(tessellatePart(p)), p.type).toBeGreaterThan(0);
    expect(meshVolume(tessellatePart(part('sphere', { r: 1 })))).toBeCloseTo((4 / 3) * Math.PI, 1);
    expect(meshVolume(tessellatePart(part('box', { w: 1, h: 2, d: 3 })))).toBeCloseTo(6, 6);
  });

  it('a mesh part is built from its buffers; without them it is the ellipsoid inscribed in bboxIn', () => {
    const blob = everyType.parts.find((p) => p.type === 'mesh') as Extract<Part, { type: 'mesh' }>;
    const meshes = readEveryTypeMeshes();
    const real = partGeometry(blob, 1, meshes);
    expect(real.attributes.position.count).toBe(meshes[blob.dims.meshRef].positions.length / 3);
    expect(real.getIndex()?.count).toBe(meshes[blob.dims.meshRef].indices.length);
    expect(real.attributes.normal.count).toBe(real.attributes.position.count);
    expect(real.attributes.position.array).not.toBe(meshes[blob.dims.meshRef].positions); // a copy
    const scaled = partGeometry(blob, 0.0254, meshes);
    expect(scaled.attributes.position.array[1]).toBeCloseTo(meshes[blob.dims.meshRef].positions[1] * 0.0254, 9);
    const placeholder = partGeometry(blob);
    placeholder.computeBoundingBox();
    expect(placeholder.boundingBox?.max.x).toBeCloseTo(blob.dims.bboxIn[0] / 2, 6);
    expect(placeholder.boundingBox?.max.y).toBeCloseTo(blob.dims.bboxIn[1] / 2, 6);
    expect(placeholder.boundingBox?.max.z).toBeCloseTo(blob.dims.bboxIn[2] / 2, 6);
    // vertex labels (palette indices) are painted: the lower half of the blob is palette[1]
    const group = buildModel(everyType, 1, meshes);
    const mesh = meshesOf(group).find((m) => m.name === blob.id) as Mesh<BufferGeometry, MeshStandardMaterial>;
    expect(mesh.material.name).toBe(`${blob.color}_painted`);
    const ids = vertexColorIds(mesh.geometry, blob, 1, { paletteIds: everyType.palette.map((c) => c.id), mesh: meshes[blob.dims.meshRef] });
    expect(ids?.[0]).toBe(blob.color);
    expect(ids?.[ids.length - 1]).toBe('c2');
  });

  it('a polygon without points does not throw (the schema rejects it; the builder draws a rectangle)', () => {
    const broken = part('flat', { shape: 'polygon', w: 1, h: 2, thickness: 0.2 });
    const g = partGeometry(broken);
    expectFinite(g, 'polygon without points');
  });

  it('never hands NaN to three.js: broken numbers in an unvalidated model are drawn as 0, negative lengths by their size', () => {
    const broken: Part[] = [
      part('sphere', { r: Number.NaN }, { id: 'a' }),
      part('ellipsoid', { rx: -1, ry: Number.POSITIVE_INFINITY, rz: 1 }, { id: 'b' }),
      part('capsule', { r: 1, length: Number.NaN }, { id: 'c' }),
      part('lathe', { profile: [[1, 0]] }, { id: 'd' }), // one point: LatheGeometry alone would throw
      part('lathe', { profile: [[Number.NaN, 0], [1, Number.NaN], [0, 2]] }, { id: 'e' }),
      part('flat', { shape: 'oval', w: Number.NaN, h: 1, thickness: 0.2 }, { id: 'f' }),
      part('flat', { shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0], [Number.NaN, 1], [1, 0], [1, 1]] }, { id: 'g' }),
      part('torus', { R: 1, r: 0.2, arcDeg: Number.NaN }, { id: 'h' }),
      part('box', { w: -1, h: 2, d: 3 }, { id: 'i', position: [Number.NaN, 1, 2], rotationDeg: [0, Number.POSITIVE_INFINITY, 0] }),
      { id: 'j', type: 'cone', position: [0, 0, 0], color: 'c1' } as unknown as Part, // no dims at all
    ];
    const group = buildModel(modelOf(broken), 1);
    expect(group.children).toHaveLength(broken.length);
    for (const mesh of meshesOf(group)) {
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite(pos.array[i]), mesh.name).toBe(true);
      expect(mesh.position.toArray().every(Number.isFinite), mesh.name).toBe(true);
      expect([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].every(Number.isFinite), mesh.name).toBe(true);
      expect(mesh.userData.crochet).toBe(broken.find((p) => p.id === mesh.name)); // the part itself is not rewritten
    }
    const b = partGeometry(broken[1]);
    b.computeBoundingBox();
    expect(b.boundingBox?.max.toArray()).toEqual([1, 0, 1]);
    expect(tessellatePart({ ...part('sphere', { r: 1 }), type: 'egg' } as unknown as Part).positions).toHaveLength(0);
  });
});

describe('region painting (§3.4.1 paint, §3.5.2 semantics)', HEAVY, () => {
  const ids = (p: Part): { ids: string[]; g: BufferGeometry } => {
    const g = partGeometry(p);
    const out = vertexColorIds(g, p);
    if (!out) throw new Error('expected vertex colors');
    return { ids: out, g };
  };
  /** The color id at the vertex nearest to a local point. */
  const at = (p: Part, target: Vec3): string => {
    const { ids: all, g } = ids(p);
    const pos = g.attributes.position;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i) - target[0], pos.getY(i) - target[1], pos.getZ(i) - target[2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return all[best];
  };
  const ball = (regions: Part['regions']): Part => part('sphere', { r: 1 }, { regions });

  it('a solid part has no vertex colors', () => {
    expect(vertexColorIds(partGeometry(part('sphere', { r: 1 })), part('sphere', { r: 1 }))).toBeNull();
  });

  it('band: from/to are height fractions along local Y, 0 = bottom', () => {
    const p = ball([{ kind: 'band', from: 0, to: 0.25, color: 'c2' }]);
    expect(at(p, [0, -1, 0])).toBe('c2');
    expect(at(p, [0.8, -0.6, 0])).toBe('c2'); // t = 0.2
    expect(at(p, [1, 0, 0])).toBe('c1');
    expect(at(p, [0, 1, 0])).toBe('c1');
  });

  it('stripes: bands of widthIn along Y cycling through the colors', () => {
    const p = ball([{ kind: 'stripes', colors: ['c1', 'c2'], widthIn: 0.5 }]);
    expect(at(p, [0, -0.9, 0.435])).toBe('c1'); // 0.1 above the bottom
    expect(at(p, [0, -0.3, 0.954])).toBe('c2'); // 0.7
    expect(at(p, [0, 0.3, 0.954])).toBe('c1'); // 1.3
    expect(at(p, [0, 0.8, 0.6])).toBe('c2'); // 1.8
    const limited = ball([{ kind: 'stripes', from: 0.5, to: 1, colors: ['c2'], widthIn: 0.5 }]);
    expect(at(limited, [0, -0.5, 0.866])).toBe('c1');
    expect(at(limited, [0, 0.5, 0.866])).toBe('c2');
  });

  it('patch: azimuth 0° = +Z (front), +90° = +X (the toy’s left), limited to from/to', () => {
    const p = ball([{ kind: 'patch', azimuthDeg: 0, spanDeg: 90, from: 0.25, to: 0.75, color: 'c2' }]);
    expect(at(p, [0, 0, 1])).toBe('c2');
    expect(at(p, [0.6, 0, 0.8])).toBe('c2'); // azimuth 36.9°
    expect(at(p, [0.8, 0, 0.6])).toBe('c1'); // azimuth 53.1°
    expect(at(p, [0, 0, -1])).toBe('c1');
    expect(at(p, [0, 0.9, 0.436])).toBe('c1'); // above "to"
    const left = ball([{ kind: 'patch', azimuthDeg: 90, spanDeg: 60, from: 0, to: 1, color: 'c2' }]);
    expect(at(left, [1, 0, 0])).toBe('c2');
    expect(at(left, [-1, 0, 0])).toBe('c1');
    const back = ball([{ kind: 'patch', azimuthDeg: 180, spanDeg: 60, from: 0, to: 1, color: 'c2' }]);
    expect(at(back, [0, 0, -1])).toBe('c2'); // wraps across ±180°
    expect(at(back, [0.2, 0, -0.98])).toBe('c2');
    expect(at(back, [-0.2, 0, -0.98])).toBe('c2');
  });

  it('spot: a great-circle radius around (azimuth, elevation); elevation +90° = +Y', () => {
    const p = ball([{ kind: 'spot', azimuthDeg: 90, elevationDeg: 0, radiusIn: 0.3, color: 'c2' }]);
    expect(at(p, [1, 0, 0])).toBe('c2');
    expect(at(p, [0.97, 0.24, 0])).toBe('c2'); // 0.24 rad away
    expect(at(p, [0.9, 0.436, 0])).toBe('c1'); // 0.45 rad away
    expect(at(p, [-1, 0, 0])).toBe('c1');
    const top = ball([{ kind: 'spot', azimuthDeg: 0, elevationDeg: 90, radiusIn: 0.3, color: 'c2' }]);
    expect(at(top, [0, 1, 0])).toBe('c2');
    expect(at(top, [0, -1, 0])).toBe('c1');
  });

  it('later regions win; pattern regions are not painted by the builder', () => {
    const p = ball([
      { kind: 'band', from: 0, to: 1, color: 'c2' },
      { kind: 'spot', azimuthDeg: 0, elevationDeg: 0, radiusIn: 0.3, color: 'c1' },
      { kind: 'pattern', pattern: 'checker', colors: ['c1'] },
    ]);
    expect(at(p, [0, 0, 1])).toBe('c1');
    expect(at(p, [0, 0, -1])).toBe('c2');
  });

  it('vertex colors are the palette colors, converted from sRGB to linear', () => {
    const model = modelOf([ball([{ kind: 'band', from: 0, to: 0.5, color: 'c2' }])]);
    const mesh = meshesOf(buildModel(model, 1))[0];
    const color = mesh.geometry.attributes.color;
    const pos = mesh.geometry.attributes.position;
    const expectedBottom = new Color('#F4EBDD');
    const expectedTop = new Color('#C8A27A');
    let bottom = -1;
    let top = -1;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < -0.9) bottom = i;
      if (pos.getY(i) > 0.9) top = i;
    }
    expect(color.getX(bottom)).toBeCloseTo(expectedBottom.r, 6);
    expect(color.getY(bottom)).toBeCloseTo(expectedBottom.g, 6);
    expect(color.getZ(top)).toBeCloseTo(expectedTop.b, 6);
    expect(expectedTop.r).toBeLessThan(0xc8 / 255); // linear, not the sRGB byte
  });

  it('the paint field (uv64) wins over regions: u = az/360 + 0.5, v = height fraction (§2.11.1)', () => {
    const cells = new Uint8Array(4096).fill(UV64_NONE);
    for (let row = 36; row < 45; row++) for (let col = 0; col < 64; col++) cells[row * 64 + col] = 1; // t in [36/64, 45/64)
    cells[uv64Cell(90, 0.2)] = 1; // one cell on the left side
    const p = part('sphere', { r: 1 }, { regions: [{ kind: 'band', from: 0, to: 1, color: 'c1' }], paint: { kind: 'uv64', data: encodeUv64(cells) } });
    const g = partGeometry(p);
    const painted = vertexColorIds(g, p, 1, { paletteIds: ['c1', 'c2'] });
    const pos = g.attributes.position;
    let inRow = 0;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) + 1) / 2;
      const az = (Math.atan2(pos.getX(i), pos.getZ(i)) * 180) / Math.PI;
      const expected = cells[uv64Cell(az, t)] === 1 ? 'c2' : 'c1';
      expect(painted?.[i]).toBe(expected);
      if (expected === 'c2') inRow++;
    }
    expect(inRow).toBeGreaterThan(40);
    // without the palette the paint field cannot be read: only the regions are painted
    expect(vertexColorIds(g, p)?.every((id) => id === 'c1')).toBe(true);
    // the head of every-type.json carries a paint field and is rendered with vertex colors
    const head = meshesOf(buildModel(everyType, 1)).find((m) => m.name === 'head');
    expect(head?.material.name).toBe('c1_painted');
  });

  it('uv64 helpers: row-major cells, clamped; encode and decode are inverse', () => {
    expect(uv64Cell(-180, 0)).toBe(0);
    expect(uv64Cell(0, 0)).toBe(32);
    expect(uv64Cell(179.9, 0)).toBe(63);
    expect(uv64Cell(180, 0)).toBe(63);
    expect(uv64Cell(0, 1)).toBe(63 * 64 + 32);
    expect(uv64Cell(0, 0.5)).toBe(32 * 64 + 32);
    expect(uv64Cell(-999, -5)).toBe(0);
    const cells = new Uint8Array(4096);
    for (let i = 0; i < cells.length; i++) cells[i] = (i * 7) % 256;
    const data = encodeUv64(cells);
    expect(data).toHaveLength(5464);
    expect(decodeUv64(data)).toEqual(cells);
    expect(decodeUv64('AAAA')).toBeNull();
    expect(decodeUv64('not base64!')).toBeNull();
    expect(() => encodeUv64(new Uint8Array(10))).toThrow(RangeError);
  });
});

describe('flatLayout: what the other kernels know about a flat part', () => {
  it('gives the outline as the builder centers it, the half extents with the bevel, and the unique vertices', () => {
    const dims = { shape: 'teardrop' as const, w: 0.9, h: 2.2, thickness: 0.3 };
    const layout = flatLayout(dims);
    const g = partGeometry(part('flat', dims));
    g.computeBoundingBox();
    expect(layout.half[0]).toBeCloseTo(g.boundingBox?.max.x ?? 0, 6);
    expect(layout.half[1]).toBeCloseTo(g.boundingBox?.max.y ?? 0, 6);
    expect(layout.half[2]).toBeCloseTo(0.15, 6);
    // the outline is the front-face contour: every outline point is a vertex of the mesh at z = ±thickness/2
    const front = new Set<string>();
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) - 0.15) < 1e-6) front.add(`${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)}`);
    for (let i = 0; i < layout.outline.length; i += 2) {
      expect(front.has(`${layout.outline[i].toFixed(4)},${layout.outline[i + 1].toFixed(4)}`)).toBe(true);
    }
    expect(layout.outline.length / 2).toBe(front.size);
    expect(layout.vertices.length % 3).toBe(0);
    expect(layout.vertices.length / 3).toBeLessThan(pos.count);
    expect(flatBevelSize(dims)).toBeCloseTo(0.09, 12); // min(0.3·t, 0.1·min(w, h))
    expect(flatBevelSize({ shape: 'rect', w: 0.2, h: 1, thickness: 0.3 })).toBeCloseTo(0.02, 12);
    expect(flatLayout(dims)).toBe(layout); // cached by dims
  });

  it('a polygon is centered on its bounding box, like the builder geometry', () => {
    const dims = { shape: 'polygon' as const, w: 2, h: 1, thickness: 0.2, points: [[10, 10], [12, 10], [12, 11], [10, 11]] as [number, number][] };
    const layout = flatLayout(dims);
    const xs = Array.from(layout.outline).filter((_, i) => i % 2 === 0);
    const ys = Array.from(layout.outline).filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(-1, 5);
    expect(Math.max(...xs)).toBeCloseTo(1, 5);
    expect(Math.min(...ys)).toBeCloseTo(-0.5, 5);
    expect(Math.max(...ys)).toBeCloseTo(0.5, 5);
  });

  it('tessellatePart returns ArrayBuffer-backed copies with a triangle index', () => {
    for (const p of samplePrimitives()) {
      const t = tessellatePart(p);
      expect(t.positions).toBeInstanceOf(Float32Array);
      expect(t.indices).toBeInstanceOf(Uint32Array);
      expect(t.positions.buffer).toBeInstanceOf(ArrayBuffer);
      expect(t.indices.length % 3).toBe(0);
      expect(Math.max(...t.indices)).toBeLessThan(t.positions.length / 3);
    }
  });
});
