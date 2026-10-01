// The toasts of appStore, bottom right (mounted once by App). Two always-mounted, visually hidden live regions
// announce them — errors assertively, the rest politely — so each is read exactly once.
import { useToastTimers } from '../../app/toasts';
import { appStore, useAppStore } from '../../state/appStore';
import { ToastStack, ToastView } from '../common/Toast';

export function ToastRegion() {
  const toasts = useAppStore((s) => s.toasts);
  const pause = useToastTimers(toasts);
  const lastError = [...toasts].reverse().find((t) => t.kind === 'error');
  const lastOther = [...toasts].reverse().find((t) => t.kind !== 'error');
  return (
    <>
      <div className="ui-visually-hidden" aria-live="polite" aria-atomic="true">
        {lastOther ? <span key={lastOther.id}>{lastOther.message}</span> : null}
      </div>
      <div className="ui-visually-hidden" aria-live="assertive" aria-atomic="true">
        {lastError ? <span key={lastError.id}>{lastError.message}</span> : null}
      </div>
      <ToastStack>
        {toasts.map((t) => (
          <ToastView key={t.id} tone={t.kind} message={t.message} action={t.action} onDismiss={() => appStore.getState().dismissToast(t.id)} onPause={(paused) => pause(t.id, paused)} />
        ))}
      </ToastStack>
    </>
  );
}
