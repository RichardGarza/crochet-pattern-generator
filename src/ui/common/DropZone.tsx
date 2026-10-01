// DropZone: drop files onto it, or click / press Enter or Space to choose them. Files that do not match
// `accept` are reported (onReject) instead of passed on. Also accepts a paste of files (⌘V) while focused.
//
// `accept` uses the <input accept> syntax: extensions (".png") and MIME types ("image/*", "model/gltf-binary").
import { useId, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';
import { fileMatchesAccept } from './files';

export interface DropZoneProps {
  /** Called with the accepted files (never empty). */
  onFiles(files: File[]): void;
  /** Called with the files that did not match `accept`. */
  onReject?(files: File[]): void;
  accept?: string;
  multiple?: boolean;
  /** Main line, e.g. "Drop a picture here". */
  title: ReactNode;
  /** Second line, e.g. "JPG, PNG, WebP or HEIC, up to 50 MB". */
  hint?: ReactNode;
  icon?: IconName;
  /** Text of the visible choose button; default "Choose file" / "Choose files". */
  buttonLabel?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Extra content under the hint (format chips, a paste box). */
  children?: ReactNode;
}

export function DropZone({ onFiles, onReject, accept, multiple = false, title, hint, icon = 'upload', buttonLabel, disabled, size = 'md', className, children }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hintId = useId();

  const take = (list: FileList | File[] | null) => {
    if (!list || disabled) return;
    const files = [...list];
    if (files.length === 0) return;
    const picked = multiple ? files : files.slice(0, 1);
    const ok = picked.filter((f) => fileMatchesAccept(f, accept));
    const bad = picked.filter((f) => !fileMatchesAccept(f, accept));
    if (ok.length) onFiles(ok);
    if (bad.length) onReject?.(bad);
  };

  const open = () => {
    if (!disabled) inputRef.current?.click();
  };

  const onDragEnter = (e: DragEvent) => {
    if (disabled || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDragOver = (e: DragEvent) => {
    if (disabled || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    take(e.dataTransfer.files);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      take(e.clipboardData.files);
    }
  };

  return (
    <div
      className={cx('ui-dropzone', `ui-dropzone--${size}`, over && 'ui-dropzone--over', disabled && 'ui-dropzone--disabled', className)}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPaste={onPaste}
      onClick={(e) => {
        // The visible button handles its own click; anywhere else in the zone opens the chooser too.
        if (!(e.target as HTMLElement).closest('button, a, input')) open();
      }}
    >
      <span className="ui-dropzone__icon">
        <Icon name={over ? 'download' : icon} size={size === 'sm' ? 20 : 26} />
      </span>
      <p className="ui-dropzone__title">{over ? 'Drop to add' : title}</p>
      {hint ? (
        <p className="ui-dropzone__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--md ui-dropzone__button" onClick={open} disabled={disabled} aria-describedby={hint ? hintId : undefined}>
        <Icon name="folder" size={17} />
        <span className="ui-btn__label">{buttonLabel ?? (multiple ? 'Choose files' : 'Choose file')}</span>
      </button>
      {children}
      <input
        ref={inputRef}
        type="file"
        className="ui-visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files);
          // Choosing the same file again must fire change again.
          e.target.value = '';
        }}
      />
    </div>
  );
}
