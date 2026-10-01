// SegmentedControl: one choice out of 2–5 short options, all visible (US / UK terms, in / cm, Compact /
// Verbose). A radio group: one tab stop, ←/→ (and ↑/↓) move and select, Home/End jump.
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  /** Accessible name when `label` is not text (icon-only segments). */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group (visible label: use `label`). */
  ariaLabel?: string;
  /** A visible label above the control. */
  label?: ReactNode;
  value: T;
  onChange(value: T): void;
  options: readonly SegmentOption<T>[];
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({ ariaLabel, label, value, onChange, options, size = 'md', fullWidth, disabled, className }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number | undefined;
    const at = enabled.indexOf(index);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') target = enabled[0];
    else if (e.key === 'End') target = enabled[enabled.length - 1];
    if (target === undefined) return;
    e.preventDefault();
    refs.current[target]?.focus();
    onChange(options[target].value);
  };

  const labelId = useId();
  const group = (
    <div
      role="radiogroup"
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      aria-disabled={disabled || undefined}
      className={cx('ui-segmented', `ui-segmented--${size}`, fullWidth && 'ui-segmented--full', !label && className)}
    >
      {options.map((o, i) => {
        const selected = i === current;
        // The selected segment is the tab stop; with nothing selected, the first enabled one is.
        const tabStop = selected || (current < 0 && i === enabled[0]);
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            tabIndex={tabStop ? 0 : -1}
            disabled={o.disabled || disabled}
            className={cx('ui-segmented__option', selected && 'ui-segmented__option--selected')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
          >
            {o.icon ? <Icon name={o.icon} size={size === 'sm' ? 14 : 16} /> : null}
            {o.label !== undefined && o.label !== null && o.label !== '' ? <span>{o.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
  if (!label) return group;
  return (
    <div className={cx('ui-field', className)}>
      <div className="ui-field__label-row">
        <span className="ui-field__label" id={labelId}>
          {label}
        </span>
      </div>
      {group}
    </div>
  );
}
