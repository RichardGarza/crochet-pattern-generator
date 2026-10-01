// EmptyState: what a view shows when it has nothing yet — an icon, a title, one or two sentences and the action
// that fills it.
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface EmptyStateProps {
  icon?: IconName;
  /** A custom illustration instead of the icon. */
  art?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons. */
  actions?: ReactNode;
  /** 'panel' draws a dashed frame; default 'plain'. */
  variant?: 'plain' | 'panel';
  size?: 'sm' | 'md' | 'lg';
  /** Heading level of the title; default 3. */
  level?: 1 | 2 | 3 | 4;
  className?: string;
}

export function EmptyState({ icon, art, title, children, actions, variant = 'plain', size = 'md', level = 3, className }: EmptyStateProps) {
  const H = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return (
    <div className={cx('ui-empty', `ui-empty--${variant}`, `ui-empty--${size}`, className)}>
      {art ?? (icon ? (
        <span className="ui-empty__icon">
          <Icon name={icon} size={size === 'lg' ? 30 : size === 'sm' ? 20 : 26} />
        </span>
      ) : null)}
      <H className="ui-empty__title">{title}</H>
      {children ? <div className="ui-empty__body">{children}</div> : null}
      {actions ? <div className="ui-empty__actions">{actions}</div> : null}
    </div>
  );
}
