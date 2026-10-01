// TextField: a labelled single-line text input (or a textarea with `multiline`).
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { Field } from './Field';
import { describedBy, useFieldIds } from './fieldIds';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size' | 'prefix'> {
  label: ReactNode;
  value: string;
  onChange(value: string): void;
  hint?: ReactNode;
  error?: ReactNode;
  labelHidden?: boolean;
  /** An icon inside the field, before the text. */
  icon?: IconName;
  /** Text after the value inside the field, e.g. "mm". */
  suffix?: ReactNode;
  size?: 'sm' | 'md';
  multiline?: boolean;
  rows?: number;
  ref?: Ref<HTMLInputElement>;
  className?: string;
}

export function TextField({ label, value, onChange, hint, error, labelHidden, icon, suffix, size = 'md', multiline, rows = 3, id, ref, className, required, ...rest }: TextFieldProps) {
  const ids = useFieldIds(id);
  const aria = describedBy(ids, hint, error);
  return (
    <Field ids={ids} label={label} labelHidden={labelHidden} hint={hint} error={error} required={required} className={className}>
      {multiline ? (
        <textarea
          id={ids.id}
          className={cx('ui-input', 'ui-input--textarea', `ui-input--${size}`)}
          value={value}
          rows={rows}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
          {...(rest as Record<string, unknown>)}
        />
      ) : (
        <span className={cx('ui-input-wrap', `ui-input-wrap--${size}`, icon && 'ui-input-wrap--icon')}>
          {icon ? <Icon name={icon} size={16} className="ui-input-wrap__icon" /> : null}
          <input
            ref={ref}
            id={ids.id}
            className={cx('ui-input', `ui-input--${size}`)}
            value={value}
            required={required}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
            {...rest}
          />
          {suffix ? <span className="ui-input-wrap__suffix">{suffix}</span> : null}
        </span>
      )}
    </Field>
  );
}
