// Focus after a route change: a click on a start card or on "Projects" unmounts the focused element, which
// leaves focus on <body> (keyboard users start over at the top, screen readers announce nothing). The new
// screen's <main> takes focus instead — but not on the first page load, where the skip link stays the first stop.
import { useEffect, type RefObject } from 'react';
import { hasNavigated } from '../../app/router';

export function useFocusOnArrival(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!hasNavigated()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) ref.current?.focus({ preventScroll: true });
  }, [ref]);
}
