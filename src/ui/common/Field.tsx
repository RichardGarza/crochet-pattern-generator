// Field: the label / hint / error frame every form control uses, with the ids wired for assistive technology
// (label → control, aria-describedby → hint and error, aria-invalid on error).
import type { ReactNode } from 'react';
import type { FieldIds } from './fieldIds';
import { Icon } from './Icon';
import { cx } from './cx';

export type { FieldIds } from './fieldIds';

export interface FieldProps {
  ids: FieldIds;
  label: ReactNode;
  /** Keeps the label for screen readers only (a toolbar field with an obvious meaning). */
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** Something at the right end of the label row (a value readout, a help link). */
  aside?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ ids, label, labelHidden, hint, error, aside, required, className, children }: FieldProps) {
  return (
    <div className={cx('ui-field', error ? 'ui-field--error' : null, className)}>
      <div className={cx('ui-field__label-row', labelHidden && 'ui-visually-hidden')}>
        <label className="ui-field__label" htmlFor={ids.id}>
          {label}
          {required ? (
            <span className="ui-field__required" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </label>
        {aside ? <span className="ui-field__aside">{aside}</span> : null}
      </div>
      {children}
      {error ? (
        <p className="ui-field__error" id={ids.errorId}>
          <Icon name="error" size={14} strokeWidth={2} />
          <span>{error}</span>
        </p>
      ) : null}
      {hint ? (
        <p className="ui-field__hint" id={ids.hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
