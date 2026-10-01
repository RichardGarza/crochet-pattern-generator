// Ids and aria wiring for form controls inside a Field.
import { useId, type ReactNode } from 'react';

export interface FieldIds {
  /** The control's id. */
  id: string;
  hintId: string;
  errorId: string;
}

/** Stable ids for a control and its hint and error (pass `id` to choose the control's id). */
export function useFieldIds(id?: string): FieldIds {
  const auto = useId();
  const base = id ?? auto;
  return { id: base, hintId: `${base}-hint`, errorId: `${base}-error` };
}

/** The aria attributes of a control inside a Field. */
export function describedBy(ids: FieldIds, hint?: ReactNode, error?: ReactNode): { 'aria-describedby'?: string; 'aria-invalid'?: true } {
  const list = [error ? ids.errorId : null, hint ? ids.hintId : null].filter(Boolean).join(' ');
  return { ...(list ? { 'aria-describedby': list } : {}), ...(error ? { 'aria-invalid': true as const } : {}) };
}
