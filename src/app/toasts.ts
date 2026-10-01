// Toasts: the data lives in appStore (`toasts`, `toast()`, `dismissToast()`); this module runs their timers
// and offers short helpers. The view is ui/shell/ToastRegion.tsx (mounted once by App).
//
//   notify.success('Copied')                         4 s
//   notify.error('Could not read that file', { action: { label: 'Details', run } })   stays until dismissed
//   notify.info('…', { key: 'save' })                a toast with the same key replaces the one showing
//
// A toast's timer pauses while the pointer or focus is on it, and resumes with the time it had left.
import { useEffect, useRef } from 'react';
import { appStore, type Toast, type ToastInput, type ToastKind } from '../state/appStore';

type Options = Omit<ToastInput, 'message' | 'kind'>;

const show = (kind: ToastKind) => (message: string, o: Options = {}): number => appStore.getState().toast({ ...o, message, kind });

export const notify = {
  info: show('info'),
  success: show('success'),
  warn: show('warn'),
  error: show('error'),
  dismiss: (id: number): void => appStore.getState().dismissToast(id),
};

interface Timer {
  handle: ReturnType<typeof setTimeout> | null;
  /** When it started counting, and how long it had left then. */
  startedAt: number;
  remaining: number;
}

/**
 * Runs the timers of the toasts shown: each disappears `timeoutMs` after it appeared (0 = never), not counting
 * time paused. Returns `pause(id, paused)` for the view.
 */
export function useToastTimers(toasts: readonly Toast[]): (id: number, paused: boolean) => void {
  const timers = useRef(new Map<number, Timer>());

  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        if (timer.handle) clearTimeout(timer.handle);
        timers.current.delete(id);
      }
    }
    for (const t of toasts) {
      if (t.timeoutMs <= 0 || timers.current.has(t.id)) continue;
      timers.current.set(t.id, {
        handle: setTimeout(() => appStore.getState().dismissToast(t.id), t.timeoutMs),
        startedAt: Date.now(),
        remaining: t.timeoutMs,
      });
    }
  }, [toasts]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) if (timer.handle) clearTimeout(timer.handle);
      map.clear();
    };
  }, []);

  return (id, paused) => {
    const timer = timers.current.get(id);
    if (!timer) return;
    if (paused && timer.handle) {
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
    } else if (!paused && !timer.handle) {
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => appStore.getState().dismissToast(id), Math.max(1000, timer.remaining));
    }
  };
}
