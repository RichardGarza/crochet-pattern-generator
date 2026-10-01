// Layout primitives. A workspace tab renders one `TabLayout`: settings sidebar (left) · main view · inspector
// (right), each region scrolling on its own (DESIGN.md §5.7). Inside the side regions, `Panel`s group settings.
// `Stack` and `Toolbar` arrange controls. The shell's top bar, banners, tab bar and status bar are outside the
// tab; a tab adds items to the status bar with `<StatusItems>` from ui/shell.
import { useId, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface TabLayoutProps {
  /** Settings sidebar (left), usually a few Panels. */
  sidebar?: ReactNode;
  sidebarLabel?: string;
  /** Inspector (right): details of the selection. */
  inspector?: ReactNode;
  inspectorLabel?: string;
  /** A toolbar pinned above the main view. */
  toolbar?: ReactNode;
  /** The main view. */
  children: ReactNode;
  mainLabel?: string;
  /** 'none' for canvases and 3D views that fill the region; default 'md'. */
  mainPadding?: 'none' | 'md' | 'lg';
  /** A sunken, dotted "graph paper" backdrop for canvases. */
  mainBackdrop?: 'plain' | 'canvas';
  className?: string;
}

export function TabLayout({ sidebar, sidebarLabel = 'Settings', inspector, inspectorLabel = 'Inspector', toolbar, children, mainLabel, mainPadding = 'md', mainBackdrop = 'plain', className }: TabLayoutProps) {
  return (
    <div className={cx('ui-tablayout', sidebar ? 'ui-tablayout--sidebar' : null, inspector ? 'ui-tablayout--inspector' : null, className)}>
      {sidebar ? (
        <aside className="ui-tablayout__side ui-tablayout__sidebar" aria-label={sidebarLabel}>
          {sidebar}
        </aside>
      ) : null}
      <section className={cx('ui-tablayout__main', `ui-tablayout__main--${mainBackdrop}`)} aria-label={mainLabel}>
        {toolbar ? <div className="ui-tablayout__toolbar">{toolbar}</div> : null}
        <div className={cx('ui-tablayout__content', `ui-tablayout__content--pad-${mainPadding}`)}>{children}</div>
      </section>
      {inspector ? (
        <aside className="ui-tablayout__side ui-tablayout__inspector" aria-label={inspectorLabel}>
          {inspector}
        </aside>
      ) : null}
    </div>
  );
}

export interface PanelProps {
  title: ReactNode;
  icon?: IconName;
  /** Small buttons at the right of the header. */
  actions?: ReactNode;
  /** The header toggles the body (aria-expanded). */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, icon, actions, collapsible, defaultOpen = true, children, className }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const heading = (
    <>
      {icon ? <Icon name={icon} size={16} className="ui-panel__icon" /> : null}
      <span className="ui-panel__title-text">{title}</span>
    </>
  );
  return (
    <section className={cx('ui-panel', className)}>
      <header className="ui-panel__header">
        <h3 className="ui-panel__title">
          {collapsible ? (
            <button type="button" className="ui-panel__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
              {heading}
              <Icon name="chevron-down" size={16} className={cx('ui-panel__chevron', !open && 'ui-panel__chevron--closed')} />
            </button>
          ) : (
            heading
          )}
        </h3>
        {actions ? <div className="ui-panel__actions">{actions}</div> : null}
      </header>
      <div id={bodyId} className="ui-panel__body" hidden={collapsible && !open}>
        {children}
      </div>
    </section>
  );
}

/** A side region's content: Panels separated by hairlines. */
export function Sidebar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('ui-sidebar', className)}>{children}</div>;
}

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  direction?: 'row' | 'column';
  /** Gap in token steps: 1 = 4 px … 8 = 40 px. Default 3 (12 px). */
  gap?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  wrap?: boolean;
}

export function Stack({ direction = 'column', gap = 3, align, justify, wrap, className, style, ...rest }: StackProps) {
  return (
    <div
      className={cx('ui-stack', className)}
      style={{ flexDirection: direction, gap: `var(--space-${gap})`, alignItems: align, justifyContent: justify, flexWrap: wrap ? 'wrap' : undefined, ...style }}
      {...rest}
    />
  );
}

export interface ToolbarProps {
  /** Accessible name, e.g. "Chart tools". */
  label: string;
  children: ReactNode;
  className?: string;
}

/** A row of tool buttons (role="toolbar"). Separate groups with `<ToolbarDivider />`. */
export function Toolbar({ label, children, className }: ToolbarProps) {
  return (
    <div role="toolbar" aria-label={label} className={cx('ui-toolbar', className)}>
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return <span className="ui-toolbar__divider" role="separator" aria-orientation="vertical" />;
}

/** A thin rule between groups. */
export function Divider({ vertical }: { vertical?: boolean }) {
  return <hr className={cx('ui-divider', vertical && 'ui-divider--vertical')} />;
}

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="ui-visually-hidden">{children}</span>;
}

/** A keyboard key: <Kbd>⌘</Kbd><Kbd>Z</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
