// Dimensions the geometry kernels can trust (internal to core/model).
//
// A valid model (§3.5.2) has finite, positive dims, and for such a part `sanePart` returns the part itself. The
// kernels also run on models that have not been validated yet — an import being repaired, a field being typed
// in the editor — and must not throw, loop or hand NaN to three.js there. For those parts `sanePart` returns a
// copy whose dims are finite and whose lengths are not negative: a non-finite number becomes 0, a negative
// length its absolute value (what the builder would draw), a missing dims object a zero-size shape.
import type { Part, Vec3 } from '../../types/model';

const isLength = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isFinite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const length = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.abs(x) : 0);
const finite = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

const isPair = (p: unknown): p is [number, number] => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);

type Loose = Record<string, unknown>;

function isSane(part: Part): boolean {
  const d = part.dims as unknown;
  if (typeof d !== 'object' || d === null) return false;
  const v = d as Loose;
  switch (part.type) {
    case 'sphere':
      return isLength(v.r);
    case 'ellipsoid':
      return isLength(v.rx) && isLength(v.ry) && isLength(v.rz);
    case 'capsule':
      return isLength(v.r) && isLength(v.length);
    case 'cylinder':
      return isLength(v.rTop) && isLength(v.rBottom) && isLength(v.h);
    case 'cone':
      return isLength(v.r) && isLength(v.h);
    case 'torus':
      return isLength(v.R) && isLength(v.r) && (v.arcDeg === undefined || isFinite(v.arcDeg));
    case 'lathe':
      return Array.isArray(v.profile) && v.profile.every((p) => isPair(p) && p[0] >= 0);
    case 'flat':
      return isLength(v.w) && isLength(v.h) && isLength(v.thickness) && (v.points === undefined || (Array.isArray(v.points) && v.points.every(isPair)));
    case 'box':
      return isLength(v.w) && isLength(v.h) && isLength(v.d);
    case 'mesh':
      return Array.isArray(v.bboxIn) && v.bboxIn.length === 3 && v.bboxIn.every(isLength);
    default:
      return true; // an unknown type: each kernel has its own answer for it
  }
}

/** The part itself when its dims are finite and its lengths are not negative; else a copy with dims the kernels can use. */
export function sanePart<P extends Part>(part: P): P {
  if (isSane(part)) return part;
  const raw = part.dims as unknown;
  const v: Loose = typeof raw === 'object' && raw !== null ? (raw as Loose) : {};
  let dims: Part['dims'];
  switch (part.type) {
    case 'sphere':
      dims = { r: length(v.r) };
      break;
    case 'ellipsoid':
      dims = { rx: length(v.rx), ry: length(v.ry), rz: length(v.rz) };
      break;
    case 'capsule':
      dims = { r: length(v.r), length: length(v.length) };
      break;
    case 'cylinder':
      dims = { ...v, rTop: length(v.rTop), rBottom: length(v.rBottom), h: length(v.h) } as Part['dims'];
      break;
    case 'cone':
      dims = { r: length(v.r), h: length(v.h) };
      break;
    case 'torus':
      dims = isFinite(v.arcDeg) ? { R: length(v.R), r: length(v.r), arcDeg: v.arcDeg } : { R: length(v.R), r: length(v.r) };
      break;
    case 'lathe': {
      const profile = Array.isArray(v.profile) ? v.profile : [];
      dims = { profile: profile.filter((p): p is unknown[] => Array.isArray(p)).map((p): [number, number] => [length(p[0]), finite(p[1])]) };
      break;
    }
    case 'flat': {
      const points = Array.isArray(v.points) ? v.points.filter(isPair) : undefined;
      const shape = typeof v.shape === 'string' ? v.shape : 'rect';
      dims = { shape, w: length(v.w), h: length(v.h), thickness: length(v.thickness), ...(points ? { points } : {}) } as Part['dims'];
      break;
    }
    case 'box':
      dims = { w: length(v.w), h: length(v.h), d: length(v.d) };
      break;
    case 'mesh': {
      const b = Array.isArray(v.bboxIn) ? v.bboxIn : [];
      const bboxIn: Vec3 = [length(b[0]), length(b[1]), length(b[2])];
      dims = { meshRef: typeof v.meshRef === 'string' ? v.meshRef : '', bboxIn };
      break;
    }
    default:
      return part;
  }
  return { ...part, dims } as P;
}
