// Track T2.3 — icons the 2D tabs need that the S0 set lacks (§6.1 rule 7: a track draws its own in the same style —
// 24 grid, 1.75 stroke, currentColor — and lists them under its requests), and the toolbar button that shows them.
import type { ReactNode } from 'react';
import { Tooltip, cx } from '../common';

const ICONS = {
  brush: (
    <>
      <path d="M18.4 3.6a2 2 0 0 1 2.8 2.8l-8.6 8.6-2.8-2.8z" />
      <path d="M9.8 12.2c-2 0-3.3 1.3-3.3 3.3 0 1.4-.8 2.6-2.5 3.3 1.3 1 2.8 1.5 4.3 1.5 2.9 0 4.6-2 4.3-5.3" />
    </>
  ),
  bucket: (
    <>
      <path d="m4.5 11.5 7-7 8 8-6.5 6.5a2 2 0 0 1-2.8 0l-5.7-5.7a1.3 1.3 0 0 1 0-1.8z" />
      <path d="M4.5 12.5h15" />
      <path d="M8.5 7.5 6 5" />
      <path d="M20.5 16.5s1.5 1.8 1.5 2.8a1.5 1.5 0 0 1-3 0c0-1 1.5-2.8 1.5-2.8z" />
    </>
  ),
  swap: (
    <>
      <circle cx="7" cy="7" r="3.5" />
      <circle cx="17" cy="17" r="3.5" />
      <path d="M13 5.5h3.5a2 2 0 0 1 2 2V11" />
      <path d="m16.5 9 2 2 2-2" />
      <path d="M11 18.5H7.5a2 2 0 0 1-2-2V13" />
      <path d="m7.5 15-2-2-2 2" />
    </>
  ),
  eyedropper: (
    <>
      <path d="m14.5 6.5 3 3" />
      <path d="M16.2 3.8a2.3 2.3 0 0 1 3.3 0l.7.7a2.3 2.3 0 0 1 0 3.3l-2.4 2.4-4-4z" />
      <path d="m13.5 7.5-8.2 8.2a2 2 0 0 0-.6 1.4V19.3H7a2 2 0 0 0 1.4-.6l8.1-8.2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <path d="M12 14.5v2" />
    </>
  ),
  eraser: (
    <>
      <path d="M8.5 20.5H20" />
      <path d="m4.6 13.9 9.3-9.3a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8l-8.2 8.2a4 4 0 0 1-2.8 1.2H8.6L4.6 16.7a2 2 0 0 1 0-2.8z" />
      <path d="m9.5 9 6.5 6.5" />
    </>
  ),
  'rotate-left': (
    <>
      <path d="M4 5v5h5" />
      <path d="M4.6 14.5A8 8 0 1 0 6.3 6.3L4 9" />
    </>
  ),
  'rotate-right': (
    <>
      <path d="M20 5v5h-5" />
      <path d="M19.4 14.5A8 8 0 1 1 17.7 6.3L20 9" />
    </>
  ),
  flip: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2.5" />
      <path d="M9 6.5 3.5 17.5H9z" />
      <path d="M15 6.5l5.5 11H15z" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2.5V16a2 2 0 0 0 2 2h13.5" />
      <path d="M2.5 6H16a2 2 0 0 1 2 2v13.5" />
    </>
  ),
  'zoom-in': (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20.5 20.5-5.3-5.3" />
      <path d="M10.5 7.5v6M7.5 10.5h6" />
    </>
  ),
  'zoom-out': (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20.5 20.5-5.3-5.3" />
      <path d="M7.5 10.5h6" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
      <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
    </>
  ),
  'grid-lines': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" />
    </>
  ),
  'split-view': (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M12 4.5v15" />
      <path d="m5.5 15.5 2.5-3 2 2" />
      <path d="M15 9h3M15 12h3M15 15h3" />
    </>
  ),
  'subject-brush': (
    <>
      <circle cx="12" cy="9" r="4" />
      <path d="M5 20.5c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  'background-brush': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="m3.5 15 5-5 4.5 4.5 3-3 4.5 4.5" />
      <circle cx="15.5" cy="8" r="1.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type TwoDIconName = keyof typeof ICONS;

export function TwoDIcon({ name, size = 18, className }: { name: TwoDIconName; size?: number; className?: string }) {
  return (
    <svg
      className={cx('ui-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden
      data-icon={name}
    >
      {ICONS[name]}
    </svg>
  );
}

export interface ToolButtonProps {
  icon: TwoDIconName;
  /** Accessible name and tooltip. */
  label: string;
  shortcut?: string;
  /** Toggle / radio state (aria-pressed). */
  pressed?: boolean;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  /** Shown next to the icon (a toolbar text button). */
  text?: ReactNode;
}

/** A toolbar button with one of the icons above (the S0 IconButton takes only S0 icon names). */
export function ToolButton({ icon, label, shortcut, pressed, onClick, disabled, className, text }: ToolButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} describe={false}>
      <button
        type="button"
        className={cx('ui-btn', 'ui-btn--ghost', 'ui-btn--md', !text && 'ui-btn--icon-only', !text && 'ui-icon-btn', 'twod-toolbtn', pressed && 'twod-toolbtn--on', className)}
        aria-label={text ? undefined : label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut ? shortcut.replace('⇧', 'Shift+') : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <TwoDIcon name={icon} />
        {text ? <span className="ui-btn__label">{text}</span> : null}
      </button>
    </Tooltip>
  );
}
