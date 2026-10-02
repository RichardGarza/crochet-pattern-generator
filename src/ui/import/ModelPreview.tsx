// Track T7.4 — the imported model seen from the front (an SVG of each part's outline in its yarn color, `preview.ts`),
// so the user sees what came back before accepting it. Parts named in `highlight` get an accent outline (new or
// changed parts in the diff).
import { useEffect, useState } from 'react';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1 } from '../../types/model';
import { Spinner } from '../common';
import type { FrontView } from './preview';
import { partDisplayName } from './present';

type PreviewModule = typeof import('./preview');
let loading: Promise<PreviewModule> | null = null;

export interface ModelPreviewProps {
  model: CrochetModelV1;
  meshes?: Record<string, ColoredMesh>;
  /** Accessible description ("Front view of the imported model"). */
  label: string;
  highlight?: ReadonlySet<string>;
  size?: 'md' | 'sm';
}

export function ModelPreview({ model, meshes, label, highlight, size = 'md' }: ModelPreviewProps) {
  const [view, setView] = useState<{ model: CrochetModelV1; view: FrontView } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loading ??= import('./preview');
    loading
      .then((m) => {
        if (live) setView({ model, view: m.frontView(model, meshes) });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [model, meshes]);

  const current = view && view.model === model ? view.view : null;
  if (failed) return <div className={`imp-preview imp-preview--${size} imp-preview--empty`}>No preview</div>;
  if (!current) {
    return (
      <div className={`imp-preview imp-preview--${size} imp-preview--empty`}>
        <Spinner label="Drawing the preview" />
      </div>
    );
  }
  const [x0, y0, x1, y1] = current.box;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  const w = x1 - x0 + 2 * pad;
  const h = y1 - y0 + 2 * pad;
  return (
    <div className={`imp-preview imp-preview--${size}`}>
      <svg role="img" aria-label={label} viewBox={`${x0 - pad} ${-(y1 + pad)} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" data-testid="import-preview" data-parts={current.shapes.length}>
        <line className="imp-preview__ground" x1={x0 - pad} x2={x1 + pad} y1={-y0} y2={-y0} />
        <g transform="scale(1,-1)">
          {current.shapes.map((s) => (
            <path key={s.part} d={s.d} fill={s.fill} className={highlight?.has(s.part) ? 'imp-preview__part imp-preview__part--hl' : 'imp-preview__part'}>
              <title>{partDisplayName(s.part, model)}</title>
            </path>
          ))}
        </g>
      </svg>
    </div>
  );
}
