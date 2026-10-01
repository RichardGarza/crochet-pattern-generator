// The toasts of appStore, bottom right (mounted once by App; the stack is a live region, so it always renders).
import { useToastTimers } from '../../app/toasts';
import { appStore, useAppStore } from '../../state/appStore';
import { ToastStack, ToastView } from '../common/Toast';

export function ToastRegion() {
  const toasts = useAppStore((s) => s.toasts);
  const pause = useToastTimers(toasts);
  return (
    <ToastStack>
      {toasts.map((t) => (
        <ToastView key={t.id} tone={t.kind} message={t.message} action={t.action} onDismiss={() => appStore.getState().dismissToast(t.id)} onPause={(paused) => pause(t.id, paused)} />
      ))}
    </ToastStack>
  );
}
