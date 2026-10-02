// Test fixture of track T6.3: an `AmiResult` shaped like T4's (rings, stitch labels, ghosts, a 3D PatternDoc with
// one piece per part, issues) computed from a model with plain geometry, so the rings / ghost / badges / ring ↔ line
// UI can be tested before T4's `generateAmigurumi` exists. The layout follows the reading in `ui/shape/amiView.ts`.
// Also loaded by the e2e spec through the dev server (no test-only imports here).
import { localSdf } from '../../../core/model/sdf';
import { localBounds, localToWorld, partAxis } from '../../../core/model/transforms';
import type { AmiResult, MakeAs, PieceFrame, RingGeom, RoundsResult } from '../../../types/ami';
import type { Issue } from '../../../types/issues';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import type { Line, PatternDoc, Piece } from '../../../types/pattern';
import { GHOST_STRIDE } from '../amiView';

/** The radius of a part at local height y (bisection on its SDF along +X, in the part's local XZ plane). */
function radiusAt(part: Part, y: number, R: number): number {
  const f = localSdf(part);
  if (f(0, y, 0) < 0) return 0;
  let lo = 0;
  let hi = R;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid, y, 0) >= 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface FixtureOptions {
  /** Ghost radius / ring radius (1 = the ghost matches the model). */
  ghostScale?: number;
  jobId?: number;
  /** Rounds per inch of height. */
  roundsPerIn?: number;
}

/** An `AmiResult` for `model`: every part a piece except the eyes (safety eyes), with rings along each part's local Y. */
export function amiFixture(model: CrochetModelV1, o: FixtureOptions = {}): AmiResult {
  const ghostScale = o.ghostScale ?? 0.97;
  const perIn = o.roundsPerIn ?? 4;
  const plan: Record<string, MakeAs> = {};
  const frames: Record<string, PieceFrame> = {};
  const rounds: Record<string, RoundsResult> = {};
  const ghosts: Record<string, Float32Array<ArrayBuffer>> = {};
  const pieces: Piece[] = [];
  const issues: Issue[] = [];
  model.parts.forEach((part) => {
    const isEye = part.id.startsWith('eye');
    plan[part.id] = isEye ? 'safety_eye' : 'piece';
    if (isEye) return;
    const b = localBounds(part);
    const h = b.max[1] - b.min[1];
    const R = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    const axis = partAxis(part, 1);
    const n = Math.max(3, Math.min(40, Math.round(h * perIn)));
    const rings: RingGeom[] = [];
    const counts: number[] = [];
    const labels: Uint8Array<ArrayBuffer>[] = [];
    const ghost = new Float32Array(n * GHOST_STRIDE);
    const base = Math.max(0, model.palette.findIndex((c) => c.id === part.color));
    const accent = (base + 1) % model.palette.length;
    for (let k = 0; k < n; k++) {
      const y = b.min[1] + ((k + 0.5) / n) * h;
      const r = radiusAt(part, y, R);
      const center = localToWorld(part, [0, y, 0]) as Vec3;
      rings.push({ center, normal: axis, radius: r });
      const sts = Math.max(6, Math.round((2 * Math.PI * r) / 0.2));
      counts.push(sts);
      const lab = new Uint8Array(sts).fill(base);
      // A stripe two rounds wide in the middle; one stitch at the seam in the accent color.
      if (k === Math.floor(n / 2) || k === Math.floor(n / 2) + 1) lab.fill(accent);
      lab[0] = accent;
      labels.push(lab);
      ghost.set([center[0], center[1], center[2], axis[0], axis[1], axis[2], r * ghostScale], k * GHOST_STRIDE);
    }
    frames[part.id] = { axis, startPole: 'bottom', seamDir: [0, 0, -1] };
    rounds[part.id] = {
      partId: part.id,
      path: part.type === 'mesh' ? 'B' : 'A',
      counts,
      loops: counts.map(() => 'both'),
      hEff: h / n,
      closedEnd: true,
      start: { k: 'mr', n: counts[0] },
      finish: 'gather',
      rings,
      stitchLabels: labels,
    };
    ghosts[part.id] = ghost;
    const lines: Line[] = counts.map((c, k) => ({ kind: 'rnd', n: k + 1, ops: [{ k: 'st', st: 'sc' }], prevCount: k === 0 ? null : counts[k - 1], stated: c }));
    pieces.push({ id: `piece_${part.id}`, title: part.label ?? part.id, makeCount: 1, partIds: [part.id], intro: [], lines, finish: { kind: 'gather', tailIn: 8, text: 'Fasten off.' } });
  });
  if (model.parts.some((p) => p.id === 'head')) issues.push({ code: 'W_SIZE', severity: 'warn', message: 'Head: the pattern comes out 6% shorter than the model.', where: { part: 'head' } });
  if (model.parts.some((p) => p.id === 'tail')) issues.push({ code: 'E_OPEN_EDGE', severity: 'error', message: 'Tail: the open edge has nowhere to be sewn.', where: { piece: 'piece_tail', line: 0 } });
  const pattern = {
    kind: '3d',
    title: model.name,
    terms: 'us',
    hand: 'right',
    dialect: 'compact',
    skill: { level: 2, name: 'Easy', reasons: [] },
    finishedSize: { wIn: 6, hIn: 9.5, tolPct: 8 },
    gaugeText: '',
    hook: { mm: 3.5 },
    materials: [],
    notions: [],
    notes: [],
    abbreviations: [],
    specialStitches: [],
    pieces,
    assembly: [],
    finishing: [],
    issues,
    hash: 'fixture',
  } satisfies PatternDoc;
  return { jobId: o.jobId ?? 1, plan, frames, rounds, ghosts, pattern, issues, hash: 'fixture' };
}
