// Toast: one short, passing message (bottom right). `ToastStack` lays out several. The data and timers live in
// appStore / app/toasts.ts; this is only the view. Keep the stack mounted while the app runs: it is the polite
// live region; errors are role="alert".
import type { ReactNode } from 'react';
import { Button, IconButton } from './Button';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

const TOAST_ICON: Record<ToastTone, IconName> = { info: 'info', success: 'success', warn: 'warning', error: 'error' };

export interface ToastViewProps {
  tone: ToastTone;
  message: ReactNode;
  action?: { label: string; run(): void };
  onDismiss(): void;
  /** Hover/focus pauses the timer (the caller runs it). */
  onPause?(paused: boolean): void;
}

export function ToastView({ tone, message, action, onDismiss, onPause }: ToastViewProps) {
  return (
    <div
      className={cx('ui-toast', `ui-toast--${tone}`)}
      // The stack is a polite live region (always mounted, so additions are announced); errors interrupt.
      role={tone === 'error' ? 'alert' : undefined}
      onMouseEnter={() => onPause?.(true)}
      onMouseLeave={() => onPause?.(false)}
      onFocus={() => onPause?.(true)}
      onBlur={() => onPause?.(false)}
    >
      <span className="ui-toast__icon">
        <Icon name={TOAST_ICON[tone]} size={18} />
      </span>
      <div className="ui-toast__message">{message}</div>
      {action ? (
        <Button
          size="sm"
          variant="ghost"
          className="ui-toast__action"
          onClick={() => {
            action.run();
            onDismiss();
          }}
        >
          {action.label}
        </Button>
      ) : null}
      <IconButton icon="x" label="Dismiss notification" size="sm" onClick={onDismiss} showTooltip={false} className="ui-toast__close" />
    </div>
  );
}

export function ToastStack({ children, label = 'Notifications' }: { children: ReactNode; label?: string }) {
  return (
    <section className="ui-toast-stack" aria-label={label} aria-live="polite" aria-relevant="additions">
      {children}
    </section>
  );
}
