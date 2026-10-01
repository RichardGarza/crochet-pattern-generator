// Test helpers for the T3.2 build: ReconRequests made of rendered orthographic silhouettes (helpers/views.ts).
import type { ResolvedGauge } from '../../../../types/gauge';
import type { PhotoView, ReconRequest, ReconSettings, ViewLabel } from '../../../../types/geometry';
import { renderSilhouette, type Camera, type Ellipsoid } from './views';

/** A worsted amigurumi-like gauge (only `cell` matters to the geometry build). */
export const GAUGE: ResolvedGauge = { cell: { w: 0.22, h: 0.2 }, wSc: 0.22, hSc: 0.2, lscIn: 1, hookMm: 3.5, stretch: 1, tol: 0.1, source: 'default' };

export const SETTINGS: ReconSettings = {
  N: 128,
  kappa: 0.9,
  photoView: 'front',
  backShape: 'mirror',
  backColors: 'part',
  oneSidedDetail: true,
  useDepth: false,
  keepHoles: false,
  mergeTouching: false,
  splitNeck: true,
  openingFrac: 0.12,
  fitTolerance: 0.12,
  targetHeightIn: 8,
};

/** 512² views at 380 px per world unit (the solids of helpers/views.ts are about one unit tall). */
export const CAM: Camera = { w: 512, h: 512, pxPerUnit: 380 };

export interface ViewSpec {
  label: ViewLabel;
  id?: string;
  cam?: Partial<Camera>;
  align?: Partial<PhotoView['align']>;
  mask?: Uint8Array<ArrayBuffer>;
}

/** A request whose views are the silhouettes of `solids` (or the given masks). */
export function request(solids: readonly Ellipsoid[], views: readonly (ViewLabel | ViewSpec)[], settings: Partial<ReconSettings> = {}, jobId = 1): ReconRequest {
  return {
    jobId,
    settings: { ...SETTINGS, ...settings },
    gauge: GAUGE,
    views: views.map((v) => {
      const spec: ViewSpec = typeof v === 'string' ? { label: v } : v;
      const cam = { ...CAM, ...spec.cam };
      return {
        view: { id: spec.id ?? spec.label, imageKey: `img:${spec.id ?? spec.label}`, label: spec.label, align: { scale: 1, dx: 0, dy: 0, rot90: 0, mirror: false, ...spec.align } },
        image: { w: 1, h: 1, data: new Uint8ClampedArray(4) },
        mask: spec.mask ?? renderSilhouette(solids, spec.label, cam),
        maskW: cam.w,
        maskH: cam.h,
      };
    }),
  };
}
