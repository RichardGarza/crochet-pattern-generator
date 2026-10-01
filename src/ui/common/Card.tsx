// Card: a soft surface that groups content. `CardButton` is a whole card that acts as one button (the start
// screen's "new project" cards): one tab stop, Enter/Space activate, the title is its accessible name.
import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Inner spacing; default 'md' (20 px). */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Raised cards cast a shadow; flat ones only have a border. Default 'flat'. */
  elevation?: 'flat' | 'raised';
  as?: 'div' | 'section' | 'article' | 'li';
  ref?: Ref<HTMLElement>;
}

export function Card({ padding = 'md', elevation = 'flat', as = 'div', className, ref, ...rest }: CardProps) {
  // One element type for the checker: the props are the common HTMLElement ones.
  const Tag = as as 'div';
  return <Tag ref={ref as Ref<HTMLDivElement>} className={cx('ui-card', `ui-card--pad-${padding}`, `ui-card--${elevation}`, className)} {...rest} />;
}

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  /** Buttons at the right end of the header. */
  actions?: ReactNode;
  /** Heading level of the title; default 3. */
  level?: 2 | 3 | 4;
}

export function CardHeader({ title, subtitle, icon, actions, level = 3 }: CardHeaderProps) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <div className="ui-card__header">
      {icon ? (
        <span className="ui-card__header-icon">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <div className="ui-card__header-text">
        <H className="ui-card__title">{title}</H>
        {subtitle ? <p className="ui-card__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ui-card__actions">{actions}</div> : null}
    </div>
  );
}

export interface CardButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title: string;
  description?: ReactNode;
  icon?: IconName;
  /** Extra content under the description (chips, an illustration). */
  footer?: ReactNode;
  /** Visual tone of the icon tile; default 'accent'. */
  tone?: 'accent' | 'neutral' | 'info' | 'success';
  ref?: Ref<HTMLButtonElement>;
}

export function CardButton({ title, description, icon, footer, tone = 'accent', className, children, type = 'button', ref, ...rest }: CardButtonProps) {
  // The title names the button and the description describes it (not every text inside, e.g. footer chips).
  const id = useId();
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-card', 'ui-card--interactive', className)}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      {...rest}
    >
      {icon ? (
        <span className={cx('ui-card__tile', `ui-card__tile--${tone}`)}>
          <Icon name={icon} size={22} />
        </span>
      ) : null}
      <span className="ui-card__body">
        <span className="ui-card__title ui-card__title--button" id={`${id}-title`}>
          {title}
        </span>
        {description ? (
          <span className="ui-card__description" id={`${id}-desc`}>
            {description}
          </span>
        ) : null}
      </span>
      {children}
      {footer ? <span className="ui-card__footer">{footer}</span> : null}
      <Icon name="arrow-right" size={18} className="ui-card__arrow" />
    </button>
  );
}
