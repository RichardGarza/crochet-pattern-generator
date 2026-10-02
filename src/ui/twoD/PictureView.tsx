// Track T2.3 — the source picture as the chart sees it: turned and mirrored (CSS transforms on the <img>, which
// applies the EXIF orientation itself), showing a rectangle of the turned picture ("display space") at a scale.
// Used by the Source tab's stage (the whole picture) and the Chart tab's photo pane (the crop).
import type { ReactNode } from 'react';
import { displaySize, sourceLayerStyle, type Orientation, type Rect, type Size } from './cropGeometry';

export interface PictureViewProps {
  url: string | null;
  src: Size;
  orientation: Orientation;
  /** The rectangle of the turned picture to show (default: all of it). */
  view?: Rect;
  /** Shown pixels per display pixel. */
  scale: number;
  alt: string;
  /** Drawn over the picture, in the same box (CSS pixels of the view). */
  children?: ReactNode;
  className?: string;
}

export function PictureView({ url, src, orientation, view, scale, alt, children, className }: PictureViewProps) {
  const disp = displaySize(src, orientation.rotate);
  const v = view ?? { x: 0, y: 0, w: disp.w, h: disp.h };
  return (
    <div className={className ? `twod-picture ${className}` : 'twod-picture'} style={{ width: v.w * scale, height: v.h * scale }}>
      <div className="twod-picture__display" style={{ left: -v.x * scale, top: -v.y * scale, width: disp.w * scale, height: disp.h * scale }}>
        {url ? <img src={url} alt={alt} draggable={false} style={sourceLayerStyle(src, orientation, scale)} /> : <div className="twod-picture__placeholder" role="img" aria-label={alt} />}
      </div>
      {children}
    </div>
  );
}
