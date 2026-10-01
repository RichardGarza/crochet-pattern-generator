// Tabs: a WAI-ARIA tab list. One tab stop (the selected tab); ←/→ move, Home/End jump. Activation is automatic
// (moving selects) unless `activation="manual"` (moving only focuses; Enter/Space select) — use manual when a tab
// is expensive to open. Pair each tab with its panel through `tabIds(idBase, id)` / `<TabPanel>`.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';
import { tabIds } from './tabIds';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: IconName;
  /** Something after the label: a count, a status Badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  /** Accessible name of the tab list, e.g. "Project views". */
  ariaLabel: string;
  items: readonly TabItem<T>[];
  /** The selected tab; null = none (e.g. a route that is not a tab). */
  value: T | null;
  onChange(id: T): void;
  /** Prefix of the tab / panel ids. */
  idBase: string;
  activation?: 'auto' | 'manual';
  /** 'line' (underline, for page-level tabs) or 'pill' (contained, inside panels). Default 'line'. */
  variant?: 'line' | 'pill';
  size?: 'sm' | 'md';
  className?: string;
}

export function Tabs<T extends string = string>({ ariaLabel, items, value, onChange, idBase, activation = 'auto', variant = 'line', size = 'md', className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
  const selected = items.findIndex((t) => t.id === value);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const at = enabled.indexOf(index);
    let target: number | undefined;
    if (e.key === 'ArrowRight') target = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') target = enabled[0];
    else if (e.key === 'End') target = enabled[enabled.length - 1];
    if (target === undefined) return;
    e.preventDefault();
    refs.current[target]?.focus();
    if (activation === 'auto') onChange(items[target].id);
  };

  return (
    <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" className={cx('ui-tabs', `ui-tabs--${variant}`, `ui-tabs--${size}`, className)}>
      {items.map((t, i) => {
        const isSelected = i === selected;
        const ids = tabIds(idBase, t.id);
        const tabStop = isSelected || (selected < 0 && i === enabled[0]);
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={isSelected ? ids.panel : undefined}
            tabIndex={tabStop ? 0 : -1}
            disabled={t.disabled}
            className={cx('ui-tab', isSelected && 'ui-tab--selected')}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            data-tab={t.id}
          >
            {t.icon ? <Icon name={t.icon} size={size === 'sm' ? 15 : 17} /> : null}
            <span className="ui-tab__label">{t.label}</span>
            {t.badge ? <span className="ui-tab__badge">{t.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idBase: string;
  id: string;
  children: ReactNode;
  className?: string;
}

/** The panel of the selected tab (render only the selected one). */
export function TabPanel({ idBase, id, children, className }: TabPanelProps) {
  const ids = tabIds(idBase, id);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className={className} tabIndex={-1}>
      {children}
    </div>
  );
}
