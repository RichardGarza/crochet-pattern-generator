// Slider: a labelled native range input with its value shown next to the label. `onChange` fires while
// dragging; `onCommit` once when the user lets go (pointer up, key up, blur) — for work that should not run on
// every tick (DESIGN.md F2 step 6: preview while sliders move, full quality on release).
import type { CSSProperties, ReactNode } from 'react';
import { Field } from './Field';
import { describedBy, useFieldIds } from './fieldIds';
import { cx } from './cx';

export interface SliderProps {
  label: ReactNode;
  value: number;
  onChange(value: number): void;
  onCommit?(value: number): void;
  min: number;
  max: number;
  step?: number;
  /** How the value is shown (default: the number); also the screen reader's aria-valuetext. */
  format?(value: number): string;
  hint?: ReactNode;
  disabled?: boolean;
  labelHidden?: boolean;
  /** Labels under the two ends, e.g. ["Thin", "Round"]. */
  endLabels?: [string, string];
  id?: string;
  className?: string;
}

export function Slider({ label, value, onChange, onCommit, min, max, step = 1, format, hint, disabled, labelHidden, endLabels, id, className }: SliderProps) {
  const ids = useFieldIds(id);
  const shown = format ? format(value) : String(value);
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const commit = (e: { currentTarget: HTMLInputElement }) => onCommit?.(Number(e.currentTarget.value));
  return (
    <Field ids={ids} label={label} labelHidden={labelHidden} hint={hint} aside={<output htmlFor={ids.id}>{shown}</output>} className={cx('ui-slider-field', className)}>
      <input
        id={ids.id}
        type="range"
        className="ui-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={shown}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        {...describedBy(ids, hint)}
      />
      {endLabels ? (
        <div className="ui-slider__ends" aria-hidden="true">
          <span>{endLabels[0]}</span>
          <span>{endLabels[1]}</span>
        </div>
      ) : null}
    </Field>
  );
}
