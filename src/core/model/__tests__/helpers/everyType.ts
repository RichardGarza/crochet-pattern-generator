// Test helper: the generator of `fixtures/models/every-type.json` and `fixtures/models/every-type.mesh.json`
// (fixtures.test.ts regenerates both and compares them byte for byte).
//
// The model holds one part of every type (two tori: a full ring and an arc; every flat shape), every region
// kind, every feature kind, every enum value of `attach.method`, `openEnd`, `stuffing` and the crochet hints,
// a paint field, and `x-*` keys on the model and on parts. It is a valid, grounded model with one attach tree:
// children are stacked on their parents with `placeChildOnSurface` (0.10 in overlap).
import { readFileSync } from 'node:fs';
import type { ColoredMesh } from '../../../../types/geometry';
import type { CrochetModelV1, Feature, Part, Vec3 } from '../../../../types/model';
import { encodeUv64, UV64_NONE, UV64_SIZE, uv64Cell } from '../../builder';
import { placeChildOnSurface } from '../../place';
import { boundsSize, groundModel, modelBounds, roundCoord, roundModel } from '../../transforms';
import { EVERY_TYPE_MESH_URL, EVERY_TYPE_URL } from './teddy';

export const EVERY_TYPE_MESH_REF = 'every-type-blob';

/** A mesh as the fixture file stores it: plain arrays. */
export interface MeshJson {
  positions: number[];
  indices: number[];
  labels: number[];
}

export function meshFromJson(json: MeshJson): ColoredMesh {
  return { positions: new Float32Array(json.positions), indices: new Uint32Array(json.indices), labels: new Uint8Array(json.labels) };
}

export function readEveryType(): CrochetModelV1 {
  return JSON.parse(readFileSync(EVERY_TYPE_URL, 'utf8')) as CrochetModelV1;
}

export function readEveryTypeMeshes(): Record<string, ColoredMesh> {
  const json = JSON.parse(readFileSync(EVERY_TYPE_MESH_URL, 'utf8')) as Record<string, MeshJson>;
  return Object.fromEntries(Object.entries(json).map(([key, mesh]) => [key, meshFromJson(mesh)]));
}

/**
 * A closed UV ellipsoid with `segments` meridians and `rings` parallels (both even), outward-facing triangles,
 * coordinates rounded to 1e-6. Its bounding box is exactly [2·rx, 2·ry, 2·rz], centered on the origin. The lower
 * half is labelled with palette index 1; the upper half has no label (255).
 */
export function uvEllipsoid(rx: number, ry: number, rz: number, segments = 8, rings = 6): MeshJson {
  const positions: number[] = [0, roundCoord(ry), 0];
  const labels: number[] = [UV64_NONE];
  for (let j = 1; j < rings; j++) {
    const theta = (Math.PI * j) / rings;
    for (let i = 0; i < segments; i++) {
      const phi = (2 * Math.PI * i) / segments;
      positions.push(roundCoord(rx * Math.sin(theta) * Math.cos(phi)), roundCoord(ry * Math.cos(theta)), roundCoord(rz * Math.sin(theta) * Math.sin(phi)));
      labels.push(j > rings / 2 ? 1 : UV64_NONE);
    }
  }
  positions.push(0, roundCoord(-ry), 0);
  labels.push(1);
  const ring = (j: number, i: number): number => 1 + (j - 1) * segments + (i % segments);
  const bottom = 1 + (rings - 1) * segments;
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    indices.push(0, ring(1, i + 1), ring(1, i));
    for (let j = 1; j < rings - 1; j++) {
      indices.push(ring(j, i), ring(j, i + 1), ring(j + 1, i));
      indices.push(ring(j, i + 1), ring(j + 1, i + 1), ring(j + 1, i));
    }
    indices.push(bottom, ring(rings - 1, i), ring(rings - 1, i + 1));
  }
  return { positions, indices, labels };
}

export function buildEveryTypeMeshes(): Record<string, MeshJson> {
  return { [EVERY_TYPE_MESH_REF]: uvEllipsoid(0.4, 0.3, 0.35) };
}

/** The canonical text of the mesh fixture: one array per line. */
export function stringifyMeshes(meshes: Record<string, MeshJson>): string {
  const body = Object.entries(meshes)
    .map(
      ([key, mesh]) =>
        `  ${JSON.stringify(key)}: {\n    "positions": [${mesh.positions.join(', ')}],\n    "indices": [${mesh.indices.join(', ')}],\n    "labels": [${mesh.labels.join(', ')}]\n  }`,
    )
    .join(',\n');
  return `{\n${body}\n}\n`;
}

/** A paint field: one painted band (palette index 2) around the middle, a painted spot (index 3) on the front. */
function examplePaint(): string {
  const cells = new Uint8Array(UV64_SIZE * UV64_SIZE).fill(UV64_NONE);
  for (let row = 28; row < 36; row++) for (let col = 0; col < UV64_SIZE; col++) cells[row * UV64_SIZE + col] = 2;
  for (const az of [-6, 0, 6]) for (const t of [0.72, 0.78]) cells[uv64Cell(az, t)] = 3;
  return encodeUv64(cells);
}

export function buildEveryType(): CrochetModelV1 {
  const sewn = (to: string): Part['attach'] => ({ to, method: 'sewn' });
  // Positions of children are placeholders until they are stacked below.
  const at: Vec3 = [0, 0, 0];
  const body: Part = {
    id: 'body',
    label: 'Body',
    type: 'lathe',
    dims: {
      profile: [
        [0, 0],
        [1, 0],
        [1.45, 0.66],
        [1.5, 1.26],
        [1.23, 2.1],
        [0.82, 2.76],
        [0, 3],
      ],
      sharp: [1],
    },
    position: [0, 0, 0],
    color: 'c1',
    stuffing: 'firm',
    notes: 'The root. Its position is the axis point at profile y = 0.',
    regions: [
      { kind: 'band', from: 0, to: 0.15, color: 'c2' },
      { kind: 'stripes', from: 0.2, to: 0.5, colors: ['c2', 'c3'], widthIn: 0.25 },
      { kind: 'patch', azimuthDeg: 0, spanDeg: 90, from: 0.5, to: 0.8, color: 'c4' },
      { kind: 'spot', azimuthDeg: 120, elevationDeg: 10, radiusIn: 0.3, color: 'c5' },
      { kind: 'pattern', pattern: 'spots', colors: ['c3'], scaleIn: 0.4, coverage: 0.3, from: 0.8, to: 1 },
    ],
    'x-note': 'extension keys on parts are kept',
  };
  const parts: { part: Part; dir: Vec3 }[] = [
    {
      dir: [0, 1, 0],
      part: {
        id: 'head',
        label: 'Head',
        type: 'sphere',
        dims: { r: 1 },
        position: at,
        color: 'c1',
        stuffing: 'firm',
        attach: { to: 'body', method: 'sewn', openEnd: 'none' },
        paint: { kind: 'uv64', data: examplePaint() },
      },
    },
    {
      dir: [0, -0.2, 1],
      part: {
        id: 'snout',
        label: 'Snout',
        type: 'cone',
        dims: { r: 0.35, h: 0.6 },
        position: at,
        rotationDeg: [90, 0, 0],
        color: 'c2',
        stuffing: 'light',
        attach: { to: 'head', method: 'sewn', openEnd: 'bottom' },
        crochet: { make: 'piece', start: 'top', axis: 'y', style: 'exact', seamAzimuthDeg: 180 },
      },
    },
    {
      dir: [1, 0.35, 0],
      part: {
        id: 'arm_l',
        label: 'Left arm',
        type: 'capsule',
        dims: { r: 0.3, length: 1.6 },
        position: at,
        rotationDeg: [0, 0, -70],
        color: 'c1',
        stuffing: 'light',
        attach: { to: 'body', method: 'sewn', openEnd: 'top' },
      },
    },
    {
      dir: [-1, 0.35, 0],
      part: {
        id: 'arm_r',
        label: 'Right arm',
        type: 'capsule',
        dims: { r: 0.3, length: 1.6 },
        position: at,
        rotationDeg: [0, 0, 70],
        color: 'c1',
        stuffing: 'light',
        attach: { to: 'body', method: 'sewn', openEnd: 'top' },
        mirrorOf: 'arm_l',
      },
    },
    {
      dir: [0.5, -1, 0.15],
      part: {
        id: 'leg_l',
        label: 'Left leg',
        type: 'cylinder',
        dims: { rTop: 0.4, rBottom: 0.5, h: 1.2, open: 'top' },
        position: at,
        color: 'c3',
        stuffing: 'medium',
        attach: { to: 'body', method: 'crochet-in-place', openEnd: 'top' },
        'x-tag': { order: 1, labels: ['left'] },
      },
    },
    {
      dir: [-0.5, -1, 0.15],
      part: {
        id: 'leg_r',
        label: 'Right leg',
        type: 'cylinder',
        dims: { rTop: 0.4, rBottom: 0.5, h: 1.2, open: 'top' },
        position: at,
        color: 'c3',
        stuffing: 'medium',
        attach: { to: 'body', method: 'crochet-in-place', openEnd: 'top' },
        mirrorOf: 'leg_l',
      },
    },
    {
      dir: [0, -0.1, 1],
      part: {
        id: 'belly',
        label: 'Belly',
        type: 'ellipsoid',
        dims: { rx: 0.7, ry: 0.8, rz: 0.3 },
        position: at,
        color: 'c2',
        stuffing: 'none',
        flatten: 0.5,
        attach: { to: 'body', method: 'worked-from' },
        crochet: { make: 'applique', start: 'auto', axis: 'z', style: 'classic' },
      },
    },
    {
      dir: [0, 1, 0],
      part: {
        id: 'halo',
        label: 'Halo',
        type: 'torus',
        dims: { R: 0.8, r: 0.12 },
        position: at,
        rotationDeg: [90, 0, 0],
        color: 'c5',
        stuffing: 'none',
        attach: { to: 'head', method: 'glued' },
        crochet: { make: 'skip' },
      },
    },
    {
      dir: [0, -0.3, -1],
      part: {
        id: 'tail',
        label: 'Tail',
        type: 'torus',
        dims: { R: 0.5, r: 0.15, arcDeg: 200 },
        position: at,
        rotationDeg: [0, 90, 0],
        color: 'c3',
        stuffing: 'light',
        attach: { to: 'body', method: 'sewn' },
        crochet: { make: 'auto', start: 'bottom', axis: 'auto' },
      },
    },
    {
      dir: [0, 0.3, -1],
      part: {
        id: 'pack',
        label: 'Backpack',
        type: 'box',
        dims: { w: 1.2, h: 1, d: 0.5 },
        position: at,
        color: 'c4',
        stuffing: 'medium',
        attach: sewn('body'),
      },
    },
    {
      dir: [0.55, 1, 0],
      part: {
        id: 'ear_l',
        label: 'Left ear',
        type: 'flat',
        dims: { shape: 'teardrop', w: 0.6, h: 0.9, thickness: 0.2 },
        position: at,
        rotationDeg: [0, 0, -25],
        color: 'c1',
        stuffing: 'none',
        flatten: 1,
        regions: [{ kind: 'band', from: 0.2, to: 0.8, color: 'c4' }],
        attach: { to: 'head', method: 'sewn', openEnd: 'bottom' },
      },
    },
    {
      dir: [-0.55, 1, 0],
      part: {
        id: 'ear_r',
        label: 'Right ear',
        type: 'flat',
        dims: { shape: 'teardrop', w: 0.6, h: 0.9, thickness: 0.2 },
        position: at,
        rotationDeg: [0, 0, 25],
        color: 'c1',
        stuffing: 'none',
        flatten: 1,
        regions: [{ kind: 'band', from: 0.2, to: 0.8, color: 'c4' }],
        attach: { to: 'head', method: 'sewn', openEnd: 'bottom' },
        mirrorOf: 'ear_l',
      },
    },
    {
      dir: [0, 1, -0.6],
      part: {
        id: 'crest',
        label: 'Crest',
        type: 'flat',
        dims: { shape: 'triangle', w: 0.5, h: 0.6, thickness: 0.15 },
        position: at,
        rotationDeg: [0, 90, 0],
        color: 'c5',
        attach: sewn('head'),
      },
    },
    {
      dir: [0, 0, -1],
      part: {
        id: 'tag',
        label: 'Tag',
        type: 'flat',
        dims: { shape: 'rect', w: 0.5, h: 0.3, thickness: 0.06 },
        position: at,
        color: 'c2',
        attach: { to: 'pack', method: 'none' },
        crochet: { make: 'embroidery' },
      },
    },
    {
      dir: [0, 0, 1],
      part: {
        id: 'star',
        label: 'Star',
        type: 'flat',
        dims: {
          shape: 'polygon',
          w: 0.5,
          h: 0.48,
          thickness: 0.08,
          points: [
            [0, 0.25],
            [0.07, 0.08],
            [0.25, 0.08],
            [0.11, -0.04],
            [0.16, -0.23],
            [0, -0.12],
            [-0.16, -0.23],
            [-0.11, -0.04],
            [-0.25, 0.08],
            [-0.07, 0.08],
          ],
        },
        position: at,
        color: 'c5',
        attach: sewn('belly'),
        crochet: { make: 'region' },
      },
    },
    {
      dir: [0.75, 0.2, 0.65],
      part: {
        id: 'button',
        label: 'Button',
        type: 'flat',
        dims: { shape: 'circle', w: 0.3, h: 0.3, thickness: 0.08 },
        position: at,
        rotationDeg: [0, 49, 0],
        color: 'c4',
        attach: sewn('body'),
      },
    },
    {
      dir: [-0.75, 0.2, 0.65],
      part: {
        id: 'badge',
        label: 'Badge',
        type: 'flat',
        dims: { shape: 'oval', w: 0.4, h: 0.25, thickness: 0.08 },
        position: at,
        rotationDeg: [0, -49, 0],
        color: 'c3',
        attach: sewn('body'),
      },
    },
    {
      dir: [-1, -0.45, 0],
      part: {
        id: 'blob',
        label: 'Blob',
        type: 'mesh',
        dims: { meshRef: EVERY_TYPE_MESH_REF, bboxIn: [0.8, 0.6, 0.7] },
        position: at,
        color: 'c4',
        stuffing: 'medium',
        attach: sewn('body'),
        crochet: { make: 'piece', seed: [0, 0.3, 0] },
      },
    },
  ];

  // Stack: parents before children, each child on the ray from its parent's center, 0.10 in into its surface.
  const placed = new Map<string, Part>([[body.id, body]]);
  for (const { part, dir } of parts) {
    const parent = placed.get(part.attach?.to ?? '');
    if (!parent) throw new Error(`every-type helper: ${part.id} is listed before its parent`);
    placed.set(part.id, placeChildOnSurface(parent, part, { dir }));
  }

  const features: Feature[] = [
    { id: 'eye_l', kind: 'safety_eye', on: 'head', azimuthDeg: 30, elevationDeg: 10, sizeMm: 9, color: 'c4', mirror: true },
    { id: 'eye_shine', kind: 'embroidered_eye', on: 'head', azimuthDeg: 28, elevationDeg: 14, sizeIn: 0.08, color: 'c2', mirror: true },
    { id: 'eye_patch', kind: 'felt', on: 'head', azimuthDeg: -30, elevationDeg: 10, sizeIn: 0.5, color: 'c2' },
    { id: 'nose', kind: 'nose', on: 'snout', azimuthDeg: 0, elevationDeg: 90, sizeIn: 0.15, color: 'c4' },
    {
      id: 'mouth',
      kind: 'mouth',
      on: 'head',
      azimuthDeg: 0,
      elevationDeg: -35,
      color: 'c4',
      path: [
        [-10, -32],
        [0, -38],
        [10, -32],
      ],
    },
    { id: 'cheek_l', kind: 'cheek', on: 'head', azimuthDeg: 50, elevationDeg: -15, sizeIn: 0.3, color: 'c3', mirror: true },
    {
      id: 'brow_l',
      kind: 'brow',
      on: 'head',
      azimuthDeg: 30,
      elevationDeg: 25,
      color: 'c4',
      mirror: true,
      path: [
        [22, 24],
        [38, 27],
      ],
    },
    {
      id: 'whiskers_l',
      kind: 'whiskers',
      on: 'head',
      azimuthDeg: 40,
      elevationDeg: -20,
      color: 'c2',
      mirror: true,
      path: [
        [35, -20],
        [60, -15],
      ],
    },
    {
      id: 'seam',
      kind: 'line',
      on: 'body',
      azimuthDeg: 180,
      elevationDeg: 0,
      color: 'c4',
      path: [
        [180, -40],
        [180, 40],
      ],
    },
    { id: 'heart', kind: 'applique', on: 'body', azimuthDeg: -25, elevationDeg: 20, sizeIn: 0.4, color: 'c3', mirror: false },
  ];

  const model: CrochetModelV1 = {
    schema: 'crochet-model',
    version: '1.0',
    revision: 1,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'Every part type',
    description: 'A fixture: one part of every type, every region kind and every feature kind.',
    category: 'creature',
    style: 'minimal',
    audience: 'adult',
    finishedSize: { height: 1 },
    pose: 'standing',
    flatBase: true,
    yarn: { weightCYC: 4, hookMm: 3.5, stsPerIn: 5.1, fiber: 'acrylic' },
    palette: [
      { id: 'c1', hex: '#C8A27A', name: 'tan', role: 'main' },
      { id: 'c2', hex: '#F4EBDD', name: 'cream', role: 'accent' },
      { id: 'c3', hex: '#F2A7B5', name: 'pink', role: 'accent' },
      { id: 'c4', hex: '#222222', name: 'black', role: 'detail' },
      { id: 'c5', hex: '#E0B13C', name: 'gold' },
    ],
    parts: [body, ...parts.map(({ part }) => placed.get(part.id) as Part)],
    features,
    assembly: [
      { order: 1, part: 'head', to: 'body', text: 'Sew the head to the top of the body, centered.' },
      { order: 2, part: 'ear_l', to: 'head', text: 'Sew the ears to the top of the head.' },
      { order: 3, part: 'halo', text: 'Glue the halo above the head.' },
    ],
    assumptions: ['This model exists to exercise code paths; it is not a toy anyone should make.'],
    source: {
      tool: 'crochet-pattern-generator',
      stage: 'seed',
      views: ['front', 'left'],
      createdAt: '2026-10-01T00:00:00Z',
      promptVersion: 'prompt-v1',
      builderVersion: 'builder-v1',
    },
    'x-cpg': { project: 'every-type', seedRev: 0 },
    'x-note': 'extension keys on the model are kept',
  };

  // Ground it, and record the measured bounding box as the finished size.
  const meshes = Object.fromEntries(Object.entries(buildEveryTypeMeshes()).map(([key, mesh]) => [key, meshFromJson(mesh)]));
  const grounded = groundModel(model, meshes).model;
  const size = boundsSize(modelBounds(grounded, meshes));
  return roundModel({ ...grounded, finishedSize: { height: size[1], width: size[0], depth: size[2] } });
}
