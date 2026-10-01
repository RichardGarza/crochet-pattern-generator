// Never lose user data: while projects live only in this tab (no saving yet), closing or reloading the tab
// with changes asks first (the browser's own "Leave site?" prompt).
import { useEffect } from 'react';
import { hasUnsavedWork } from './projectSession';

export function useUnloadGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      e.preventDefault();
      // Older browsers need returnValue set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
