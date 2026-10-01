// Dialog: a modal on the native <dialog> element (showModal makes the rest of the page inert and gives Escape
// for free). On top of that: Tab / Shift+Tab wrap inside the dialog (a focus trap that also holds in browsers
// whose inert handling lets focus reach the page), the first field or `initialFocus` gets focus on open, focus
// returns to the element that opened it on close, and a click on the backdrop closes unless `dismissible` is
// false. `ConfirmDialog` is the standard "Delete / Cancel" question.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Button, IconButton } from './Button';
import { cx } from './cx';
import { focusableIn } from './focus';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons at the bottom right; put the primary action last. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Escape and a backdrop click close it. Default true. */
  dismissible?: boolean;
  /** The element to focus on open (default: the first field, else the first button). */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, initialFocus, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const returnTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      const target = initialFocus?.current ?? focusableIn(dialog).find((el) => el.matches('input, select, textarea')) ?? focusableIn(dialog).find((el) => !el.classList.contains('ui-dialog__close')) ?? dialog;
      target.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      returnTo.current?.focus();
      returnTo.current = null;
    }
  }, [open, initialFocus]);

  // Unmounting while open: give focus back too.
  useEffect(
    () => () => {
      returnTo.current?.focus();
    },
    [],
  );

  const pressOnBackdrop = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      // A control that used Escape itself (a field restoring its value) prevented it.
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (dismissible) onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = focusableIn(ref.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={ref}
      className={cx('ui-dialog', `ui-dialog--${size}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        // The native Escape path: keep the dialog under React's control.
        e.preventDefault();
        if (dismissible) onCloseRef.current();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop lands on the <dialog> element itself, outside its content box.
        pressOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        // Close on the click (not the press), so the focus we give back is not taken by the press.
        if (dismissible && pressOnBackdrop.current && e.target === ref.current) onCloseRef.current();
        pressOnBackdrop.current = false;
      }}
    >
      {open ? (
        <div className="ui-dialog__panel">
          <header className="ui-dialog__header">
            <div className="ui-dialog__heading">
              <h2 id={titleId} className="ui-dialog__title">
                {title}
              </h2>
              {description ? (
                <p id={descId} className="ui-dialog__description">
                  {description}
                </p>
              ) : null}
            </div>
            {dismissible ? <IconButton icon="x" label="Close" size="sm" onClick={onClose} className="ui-dialog__close" showTooltip={false} /> : null}
          </header>
          {children ? <div className="ui-dialog__body">{children}</div> : null}
          {footer ? <footer className="ui-dialog__footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Default 'danger' (a confirm dialog usually guards something destructive). */
  tone?: 'danger' | 'primary';
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', tone = 'danger', onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      // A destructive confirm starts on Cancel, so a quick Enter does no harm.
      initialFocus={tone === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
