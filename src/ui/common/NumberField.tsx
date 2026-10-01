// NumberField: a labelled number input with a unit suffix and optional − / + steppers.
//
// `kind="length"`: `value`, `min` and `max` are INCHES (the app's internal unit, DESIGN.md §0.1); the field shows
// and accepts them in `units` (in or cm) and calls `onChange` with inches. Plain numbers use `suffix` ("%",
// "sts", "mm"). The text is committed on Enter and on blur (not on every keystroke, so a half-typed "1." is never
// a value); ↑/↓ step by `step` (Shift: ×10) in display units; the value is clamped to [min, max]. Text that is
// not a number shows an error and leaves the value unchanged.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { UnitPref } from '../../types/units';
import { Field } from './Field';
import { describedBy, useFieldIds } from './fieldIds';
import { Icon } from './Icon';
import { cx } from './cx';
import { formatNumber, fromDisplayLength, parseNumber, toDisplayLength } from './units';

export interface NumberFieldProps {
  label: ReactNode;
  /** The value (inches when kind="length"); null = empty. */
  value: number | null;
  onChange(value: number | null): void;
  kind?: 'number' | 'length';
  /** Display unit of a length (the user's preference). Default 'in'. */
  units?: UnitPref;
  /** Unit text of a plain number. */
  suffix?: string;
  /** In the value's unit (inches for lengths). */
  min?: number;
  max?: number;
  /** Step in display units. Default 1 (0.25 in / 0.5 cm for lengths). */
  step?: number;
  /** Decimals shown. Default 2 (lengths: 2 in, 1 cm). */
  precision?: number;
  /** Allow clearing the field (onChange(null)). Default false: an empty field restores the value. */
  allowEmpty?: boolean;
  /** Show − / + buttons. */
  stepper?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  labelHidden?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  className?: string;
  placeholder?: string;
}

export function NumberField({
  label,
  value,
  onChange,
  kind = 'number',
  units = 'in',
  suffix,
  min,
  max,
  step,
  precision,
  allowEmpty = false,
  stepper = false,
  hint,
  error,
  labelHidden,
  disabled,
  size = 'md',
  id,
  className,
  placeholder,
}: NumberFieldProps) {
  const ids = useFieldIds(id);
  const isLength = kind === 'length';
  const digits = precision ?? (isLength && units === 'cm' ? 1 : 2);
  const stepBy = step ?? (isLength ? (units === 'cm' ? 0.5 : 0.25) : 1);
  const unitText = isLength ? units : suffix;

  const toShown = (v: number | null): string => (v === null ? '' : formatNumber(isLength ? toDisplayLength(v, units) : v, digits));
  const [text, setText] = useState(() => toShown(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);

  // Follow outside changes (undo, another control, a unit switch) unless the user is typing.
  useEffect(() => {
    if (!focused.current) {
      setText(toShown(value));
      setInvalid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units, digits, isLength]);

  const clamp = (v: number): number => {
    let out = v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
  };

  const commitValue = (next: number | null) => {
    setInvalid(false);
    setText(toShown(next));
    if (next !== value) onChange(next);
  };

  const commit = () => {
    const shown = parseNumber(text);
    if (text.trim() === '') {
      if (allowEmpty) commitValue(null);
      else setText(toShown(value));
      setInvalid(false);
      return;
    }
    if (shown === null) {
      setInvalid(true);
      return;
    }
    commitValue(clamp(isLength ? fromDisplayLength(shown, units) : shown));
  };

  const stepValue = (direction: 1 | -1, factor = 1) => {
    const current = parseNumber(text) ?? (value === null ? 0 : isLength ? toDisplayLength(value, units) : value);
    // Round to the step grid so repeated steps do not accumulate float noise.
    const nextShown = Math.round((current + direction * stepBy * factor) / stepBy) * stepBy;
    commitValue(clamp(isLength ? fromDisplayLength(nextShown, units) : nextShown));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      setText(toShown(value));
      setInvalid(false);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepValue(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : 1);
    }
  };

  // The unit is part of the accessible name ("Width (inches)"); the visible suffix is decorative.
  const unitName = unitText === 'in' ? 'inches' : unitText === 'cm' ? 'centimeters' : unitText;
  const labelNode = unitText ? (
    <>
      {label}
      <span className="ui-visually-hidden">{` (${unitName})`}</span>
    </>
  ) : (
    label
  );
  const shownError = error ?? (invalid ? 'Enter a number' : undefined);
  const atMin = value !== null && min !== undefined && value <= min;
  const atMax = value !== null && max !== undefined && value >= max;

  return (
    <Field ids={ids} label={labelNode} labelHidden={labelHidden} hint={hint} error={shownError} className={className}>
      <span className={cx('ui-input-wrap', `ui-input-wrap--${size}`, stepper && 'ui-input-wrap--stepper', disabled && 'ui-input-wrap--disabled')}>
        {stepper ? (
          <button type="button" className="ui-input-wrap__step" tabIndex={-1} aria-label="Decrease" disabled={disabled || atMin} onClick={() => stepValue(-1)}>
            <Icon name="minus" size={14} strokeWidth={2} />
          </button>
        ) : null}
        <input
          id={ids.id}
          className={cx('ui-input', `ui-input--${size}`, 'ui-input--number')}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (invalid) setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          {...describedBy(ids, hint, shownError)}
        />
        {unitText ? (
          <span className="ui-input-wrap__suffix" aria-hidden="true">
            {unitText}
          </span>
        ) : null}
        {stepper ? (
          <button type="button" className="ui-input-wrap__step" tabIndex={-1} aria-label="Increase" disabled={disabled || atMax} onClick={() => stepValue(1)}>
            <Icon name="plus" size={14} strokeWidth={2} />
          </button>
        ) : null}
      </span>
    </Field>
  );
}
