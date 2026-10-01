// Track T6 — the inspector's size fields per part type (DESIGN.md §4.2 "Parameters": per-type numeric fields +
// sliders). The model stores radii (§3.5.1); a crocheter measures across a piece, so round sizes are shown as
// diameters ("Width", "Diameter") and written back as radii (`factor` 2).
import type { Part } from '../../types/model';

export interface DimSpec {
  /** The key in `part.dims`. */
  key: string;
  label: string;
  /** shown = stored × factor (2 for a radius shown as a diameter). */
  factor: number;
  kind: 'length' | 'angle';
  hint?: string;
}

const len = (key: string, label: string, factor = 1, hint?: string): DimSpec => ({ key, label, factor, kind: 'length', hint });

/** The numeric dims of a part type, in the order the inspector shows them. */
export function dimSpecs(type: Part['type']): DimSpec[] {
  switch (type) {
    case 'sphere':
      return [len('r', 'Diameter', 2)];
    case 'ellipsoid':
      return [len('rx', 'Width', 2, 'Side to side'), len('ry', 'Height', 2, 'Bottom to top'), len('rz', 'Depth', 2, 'Front to back')];
    case 'capsule':
      return [len('r', 'Diameter', 2), len('length', 'Length', 1, 'End to end, rounded ends included')];
    case 'cylinder':
      return [len('rTop', 'Top diameter', 2), len('rBottom', 'Bottom diameter', 2), len('h', 'Height')];
    case 'cone':
      return [len('r', 'Base diameter', 2), len('h', 'Height')];
    case 'torus':
      return [len('R', 'Ring diameter', 2, 'Across the ring, through the middle of the tube'), len('r', 'Tube thickness', 2), { key: 'arcDeg', label: 'Arc', factor: 1, kind: 'angle', hint: '360° is a closed ring' }];
    case 'box':
      return [len('w', 'Width'), len('h', 'Height'), len('d', 'Depth')];
    case 'flat':
      return [len('w', 'Width'), len('h', 'Height'), len('thickness', 'Thickness')];
    case 'lathe':
    case 'mesh':
      return [];
  }
}

/** Friendly names of the part types. */
export const TYPE_NAMES: Record<Part['type'], string> = {
  sphere: 'Ball',
  ellipsoid: 'Oval ball',
  capsule: 'Capsule',
  cylinder: 'Tube',
  cone: 'Cone',
  torus: 'Ring',
  lathe: 'Shaped round',
  flat: 'Flat piece',
  box: 'Block',
  mesh: 'Sculpted',
};

/** The value a dim field shows (display factor applied); arcDeg defaults to 360. */
export function dimValue(part: Part, spec: DimSpec): number | null {
  const v = (part.dims as unknown as Record<string, unknown>)[spec.key];
  if (spec.key === 'arcDeg' && v === undefined) return 360;
  return typeof v === 'number' && Number.isFinite(v) ? v * spec.factor : null;
}

/** "caramel_yarn" → "Caramel yarn". */
export function prettyName(s: string): string {
  const t = s.replace(/_/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}
