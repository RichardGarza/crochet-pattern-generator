// Tooltip: a short label shown on hover (after a short delay) and on keyboard focus (at once); Escape hides it.
// It is rendered in a portal with fixed positioning, so no overflow clips it, and it is linked to its anchor by
// aria-describedby while it shows. Tooltips repeat or explain; they never hold the only copy of information a
// task needs (touch screens have no hover).
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  content: ReactNode;
  /** A keyboard shortcut shown after the content, e.g. "⌘Z". */
  shortcut?: string;
  /** Preferred side; it flips when there is no room. Default 'bottom'. */
  placement?: 'top' | 'bottom';
  /** Hover delay in ms; default 350. */
  delay?: number;
  /** One focusable element (a Button, IconButton, link …). */
  children: ReactElement;
  disabled?: boolean;
}

const GAP = 8;
const MARGIN = 8;

export function Tooltip({ content, shortcut, placement = 'bottom', delay = 350, children, disabled }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = useCallback(
    (now: boolean) => {
      clear();
      if (disabled) return;
      if (now) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [delay, disabled],
  );
  const hide = useCallback(() => {
    clear();
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.firstElementChild ?? anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side = placement;
    if (side === 'bottom' && a.bottom + GAP + t.height > vh - MARGIN) side = 'top';
    else if (side === 'top' && a.top - GAP - t.height < MARGIN) side = 'bottom';
    const top = side === 'bottom' ? a.bottom + GAP : a.top - GAP - t.height;
    const left = Math.min(Math.max(MARGIN, a.left + a.width / 2 - t.width / 2), vw - MARGIN - t.width);
    setPos({ top, left, side });
  }, [open, placement, content]);

  if (!isValidElement(children)) return children;
  const child = children as ReactElement<{ 'aria-describedby'?: string }>;
  const describedBy = [child.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <span
      ref={anchorRef}
      className="ui-tooltip-anchor"
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocus={(e) => {
        // Keyboard focus shows at once; a mouse click that focuses does not re-open a tooltip.
        if ((e.target as HTMLElement).matches?.(':focus-visible')) show(true);
      }}
      onBlur={hide}
      onPointerDown={hide}
    >
      {cloneElement(child, { 'aria-describedby': describedBy })}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="ui-tooltip"
              data-side={pos?.side ?? placement}
              style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            >
              <span>{content}</span>
              {shortcut ? <kbd className="ui-tooltip__kbd">{shortcut}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
