// Track T6 — which modifier keys are held (DESIGN.md §4.2: ⌥ transforms the part alone, ⇧ turns snapping off,
// ⇧-click adds to the selection). Read from keyboard AND pointer events, so a key pressed while the window was
// not focused is still seen on the next click or drag.
import { useEffect, useRef, type MutableRefObject } from 'react';

export interface ModifierKeys {
  alt: boolean;
  shift: boolean;
}

type WithModifiers = { altKey: boolean; shiftKey: boolean };

/** The modifier state carried by an event. */
export function modifiersOf(e: WithModifiers): ModifierKeys {
  return { alt: e.altKey, shift: e.shiftKey };
}

/** A ref that always holds the current modifier keys (no re-render on change). */
export function useModifierKeys(): MutableRefObject<ModifierKeys> {
  const keys = useRef<ModifierKeys>({ alt: false, shift: false });
  useEffect(() => {
    const update = (e: KeyboardEvent | PointerEvent) => {
      keys.current = modifiersOf(e);
    };
    const clear = () => {
      keys.current = { alt: false, shift: false };
    };
    window.addEventListener('keydown', update, true);
    window.addEventListener('keyup', update, true);
    window.addEventListener('pointerdown', update, true);
    window.addEventListener('pointermove', update, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', update, true);
      window.removeEventListener('keyup', update, true);
      window.removeEventListener('pointerdown', update, true);
      window.removeEventListener('pointermove', update, true);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return keys;
}
