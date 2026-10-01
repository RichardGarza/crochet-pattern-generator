// Banner: a full-width message about the whole view (a project waiting for Claude Design, read-only, a save that
// failed). Icon + text, never color alone. Errors and warnings are announced (role="alert" / "status").
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export type BannerTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'accent';

const BANNER_ICON: Record<BannerTone, IconName> = { neutral: 'info', info: 'info', success: 'success', warn: 'warning', danger: 'error', accent: 'sparkles' };

export interface BannerProps {
  tone?: BannerTone;
  /** Overrides the tone's icon. */
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons (usually `Button size="sm"`). */
  actions?: ReactNode;
  /** Shows a close button. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
  /** Default: 'alert' for danger, 'status' otherwise. */
  role?: 'alert' | 'status' | 'region';
}

export function Banner({ tone = 'info', icon, title, children, actions, onDismiss, dismissLabel = 'Dismiss', className, role }: BannerProps) {
  return (
    <div className={cx('ui-banner', `ui-banner--${tone}`, className)} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      <span className="ui-banner__icon">
        <Icon name={icon ?? BANNER_ICON[tone]} size={18} />
      </span>
      <div className="ui-banner__text">
        {title ? <strong className="ui-banner__title">{title}</strong> : null}
        {children ? <span className="ui-banner__body">{children}</span> : null}
      </div>
      {actions ? <div className="ui-banner__actions">{actions}</div> : null}
      {onDismiss ? <IconButton icon="x" label={dismissLabel} size="sm" onClick={onDismiss} className="ui-banner__close" /> : null}
    </div>
  );
}
