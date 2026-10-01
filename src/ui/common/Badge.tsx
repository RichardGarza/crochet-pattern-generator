// Badge (a status label, not interactive) and Chip (a compact tag that can be clicked or removed).
// Color is never the only signal: a tone always comes with text, and status tones get an icon by default
// (DESIGN.md §5.7 accessibility).
import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

const TONE_ICON: Partial<Record<Tone, IconName>> = { success: 'success', warn: 'warning', danger: 'error', info: 'info' };

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** An icon; status tones default to their status icon. Pass `null` for none. */
  icon?: IconName | null;
  /** Solid uses the strong color; default soft. */
  variant?: 'soft' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  children: ReactNode;
}

export function Badge({ tone = 'neutral', icon, variant = 'soft', size = 'md', className, children, ...rest }: BadgeProps) {
  const name = icon === undefined ? TONE_ICON[tone] : icon;
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, `ui-badge--${variant}`, `ui-badge--${size}`, className)} {...rest}>
      {name ? <Icon name={name} size={size === 'sm' ? 12 : 14} strokeWidth={2} /> : null}
      <span>{children}</span>
    </span>
  );
}

export interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
  /** Makes the chip a button. */
  onClick?: () => void;
  /** Adds a remove button with this accessible label, e.g. "Remove Red". */
  onRemove?: () => void;
  removeLabel?: string;
  selected?: boolean;
  /** A color swatch shown before the text (always next to text, never alone). */
  swatch?: string;
  className?: string;
  title?: string;
}

export function Chip({ children, tone = 'neutral', icon, onClick, onRemove, removeLabel, selected, swatch, className, title }: ChipProps) {
  const inner = (
    <>
      {swatch ? <span className="ui-chip__swatch" style={{ background: swatch }} aria-hidden="true" /> : null}
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="ui-chip__text">{children}</span>
    </>
  );
  return (
    <span className={cx('ui-chip', `ui-chip--${tone}`, selected && 'ui-chip--selected', onClick && 'ui-chip--clickable', className)} title={title}>
      {onClick ? (
        <button type="button" className="ui-chip__main" onClick={onClick} aria-pressed={selected}>
          {inner}
        </button>
      ) : (
        <span className="ui-chip__main">{inner}</span>
      )}
      {onRemove ? (
        <button type="button" className="ui-chip__remove" onClick={onRemove} aria-label={removeLabel ?? 'Remove'}>
          <Icon name="x" size={12} strokeWidth={2.25} />
        </button>
      ) : null}
    </span>
  );
}
