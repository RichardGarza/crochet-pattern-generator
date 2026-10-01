// Switch: an on/off setting that applies at once (role="switch"). The label is clickable; the state is also
// shown as text for anyone who cannot rely on the knob's position or color.
import { useId, type ReactNode } from 'react';
import { cx } from './cx';

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  /** One line under the label. */
  description?: ReactNode;
  disabled?: boolean;
  /** Show "On" / "Off" next to the knob. Default false. */
  showState?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  id?: string;
}

export function Switch({ label, checked, onChange, description, disabled, showState, size = 'md', className, id }: SwitchProps) {
  const auto = useId();
  const base = id ?? auto;
  return (
    <div className={cx('ui-switch-row', disabled && 'ui-switch-row--disabled', className)}>
      <div className="ui-switch-row__text">
        <label className="ui-switch-row__label" htmlFor={base} id={`${base}-label`}>
          {label}
        </label>
        {description ? (
          <p className="ui-switch-row__description" id={`${base}-desc`}>
            {description}
          </p>
        ) : null}
      </div>
      <span className="ui-switch-row__control">
        {showState ? <span className="ui-switch-row__state">{checked ? 'On' : 'Off'}</span> : null}
        <button
          id={base}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-describedby={description ? `${base}-desc` : undefined}
          disabled={disabled}
          className={cx('ui-switch', `ui-switch--${size}`)}
          onClick={() => onChange(!checked)}
        >
          <span className="ui-switch__knob" />
        </button>
      </span>
    </div>
  );
}
