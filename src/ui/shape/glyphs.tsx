// Track T6.2 — icons the Shape tab needs that the S0 icon set does not have yet (§6.1 rule 7: a track draws its
// own in the same style — 24 grid, 1.75 stroke, currentColor — and lists them under its requests): Mirror, Link,
// and one pictogram per primitive for Add part.
import type { ReactNode } from 'react';
import type { AddableType } from '../../state/slices/model3d';

function Svg({ size = 16, children, className }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg
      className={className ?? 'shape-glyph'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function MirrorGlyph({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3v3M12 10.5v3M12 18v3" />
      <path d="M9 7 3.5 17H9z" />
      <path d="m15 7 5.5 10H15z" />
    </Svg>
  );
}

export function LinkGlyph({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </Svg>
  );
}

const SHAPES: Record<AddableType, ReactNode> = {
  sphere: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12c2.5 2.2 13.5 2.2 16 0" />
    </>
  ),
  ellipsoid: (
    <>
      <ellipse cx="12" cy="12" rx="5.5" ry="8.5" />
      <path d="M6.5 12c2 1.6 9 1.6 11 0" />
    </>
  ),
  capsule: <rect x="8" y="3" width="8" height="18" rx="4" />,
  cylinder: (
    <>
      <ellipse cx="12" cy="6" rx="6" ry="2.5" />
      <path d="M6 6v12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6" />
    </>
  ),
  cone: (
    <>
      <path d="M12 3 5.5 18M12 3l6.5 15" />
      <ellipse cx="12" cy="18" rx="6.5" ry="2.5" />
    </>
  ),
  torus: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="5.5" />
      <ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" />
    </>
  ),
  box: (
    <>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  flat: (
    <>
      <path d="M12 3c4.5 3.5 6.5 8 4.5 13-1 2.5-3 4-4.5 5-1.5-1-3.5-2.5-4.5-5-2-5 0-9.5 4.5-13z" />
      <path d="M12 7v11" />
    </>
  ),
  lathe: (
    <>
      <path d="M5 19c0-8 3-14 7-14s7 6 7 14" />
      <ellipse cx="12" cy="19" rx="7" ry="2" />
    </>
  ),
};

export function ShapeGlyph({ type, size = 28 }: { type: AddableType; size?: number }) {
  return (
    <Svg size={size} className="shape-glyph shape-glyph--shape">
      {SHAPES[type]}
    </Svg>
  );
}
