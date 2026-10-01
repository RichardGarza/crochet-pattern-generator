// Spinner (indeterminate, inline) and ProgressBar (determinate 0..1, or indeterminate when value is null).
import { cx } from './cx';

export interface SpinnerProps {
  /** Pixel size; default 18. */
  size?: number;
  /** Accessible text; without it the spinner is decorative (pair it with visible text). */
  label?: string;
  className?: string;
}

export function Spinner({ size = 18, label, className }: SpinnerProps) {
  return (
    <span className={cx('ui-spinner', className)} style={{ width: size, height: size }} {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface ProgressBarProps {
  /** 0..1, or null for "working, unknown how long". */
  value: number | null;
  /** Visible label above the bar (also its accessible name). */
  label?: string;
  /** Shows the percentage next to the label. Default true when value is a number. */
  showValue?: boolean;
  size?: 'sm' | 'md';
  tone?: 'accent' | 'success' | 'warn' | 'danger';
  className?: string;
}

export function ProgressBar({ value, label, showValue, size = 'md', tone = 'accent', className }: ProgressBarProps) {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  const withValue = showValue ?? pct !== null;
  return (
    <div className={cx('ui-progress', `ui-progress--${size}`, `ui-progress--${tone}`, className)}>
      {label || withValue ? (
        <div className="ui-progress__head">
          {label ? <span className="ui-progress__label">{label}</span> : <span />}
          {withValue && pct !== null ? <span className="ui-progress__value">{pct}%</span> : null}
        </div>
      ) : null}
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={label ?? 'Progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-busy={pct === null || undefined}
      >
        <div className={cx('ui-progress__fill', pct === null && 'ui-progress__fill--indeterminate')} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}
