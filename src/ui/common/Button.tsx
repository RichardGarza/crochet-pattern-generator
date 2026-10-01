// Button and IconButton. Variants: primary (one per view: the main action), secondary, ghost (toolbars),
// danger (destructive; confirm first). `disabledReason` keeps a button focusable and explains why it cannot be
// used (a native `disabled` button gets no hover or focus, so its reason would be invisible).
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Progress';
import { Tooltip } from './Tooltip';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the label. */
  icon?: IconName;
  /** Icon after the label (e.g. a chevron). */
  iconEnd?: IconName;
  /** Shows a spinner, sets aria-busy and ignores clicks. */
  loading?: boolean;
  /** Not available, and why: the button stays focusable (aria-disabled) and shows the reason as a tooltip. */
  disabledReason?: string;
  fullWidth?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 15, md: 17, lg: 19 };

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  disabledReason,
  fullWidth,
  className,
  children,
  type = 'button',
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const unavailable = !!disabledReason || loading;
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (unavailable) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  const button = (
    <button
      ref={ref}
      type={type}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, fullWidth && 'ui-btn--full', !children && 'ui-btn--icon-only', className)}
      aria-disabled={disabledReason ? true : undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      {children !== undefined && children !== null ? <span className="ui-btn__label">{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} size={ICON_SIZE[size]} /> : null}
    </button>
  );
  return disabledReason ? <Tooltip content={disabledReason}>{button}</Tooltip> : button;
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconEnd' | 'fullWidth'> {
  icon: IconName;
  /** The accessible name; also the tooltip. Required: an icon alone is not a label. */
  label: string;
  /** Shortcut shown in the tooltip, e.g. "⌘Z". */
  shortcut?: string;
  /** For toggles: sets aria-pressed. */
  pressed?: boolean;
  /** Default true. */
  showTooltip?: boolean;
  tooltipPlacement?: 'top' | 'bottom';
}

export function IconButton({
  icon,
  label,
  shortcut,
  pressed,
  showTooltip = true,
  tooltipPlacement,
  variant = 'ghost',
  size = 'md',
  disabledReason,
  className,
  ...rest
}: IconButtonProps) {
  const button = (
    <Button
      {...rest}
      variant={variant}
      size={size}
      icon={icon}
      aria-label={label}
      aria-pressed={pressed}
      className={cx('ui-icon-btn', className)}
      // The tooltip below shows the reason; the button keeps aria-disabled.
      aria-disabled={disabledReason ? true : rest['aria-disabled']}
      onClick={disabledReason ? (e) => e.preventDefault() : rest.onClick}
    />
  );
  if (!showTooltip && !disabledReason) return button;
  const tip = disabledReason ? `${label} — ${disabledReason}` : label;
  return (
    <Tooltip content={tip} shortcut={disabledReason ? undefined : shortcut} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  );
}
