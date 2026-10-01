// Select: a labelled native <select> (keyboard, screen reader and touch behavior come from the platform),
// styled to match the other fields.
import type { ReactNode } from 'react';
import { Field } from './Field';
import { describedBy, useFieldIds } from './fieldIds';
import { Icon } from './Icon';
import { cx } from './cx';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  label: ReactNode;
  value: T;
  onChange(value: T): void;
  options: readonly SelectOption<T>[];
  /** Options in labelled groups (instead of `options`). */
  groups?: readonly { label: string; options: readonly SelectOption<T>[] }[];
  hint?: ReactNode;
  error?: ReactNode;
  labelHidden?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  className?: string;
}

export function Select<T extends string = string>({ label, value, onChange, options, groups, hint, error, labelHidden, disabled, size = 'md', id, className }: SelectProps<T>) {
  const ids = useFieldIds(id);
  const renderOption = (o: SelectOption<T>) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  );
  return (
    <Field ids={ids} label={label} labelHidden={labelHidden} hint={hint} error={error} className={className}>
      <span className={cx('ui-select', `ui-select--${size}`)}>
        <select id={ids.id} className={cx('ui-input', `ui-input--${size}`, 'ui-select__control')} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} {...describedBy(ids, hint, error)}>
          {groups
            ? groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map(renderOption)}
                </optgroup>
              ))
            : options.map(renderOption)}
        </select>
        <Icon name="chevron-down" size={16} className="ui-select__chevron" />
      </span>
    </Field>
  );
}
