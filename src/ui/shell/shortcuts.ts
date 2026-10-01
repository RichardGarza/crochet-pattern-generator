// Workspace keyboard shortcuts. ⌘Z / Ctrl+Z undo; ⇧⌘Z, ⇧Ctrl+Z and Ctrl+Y redo — on the project's history
// (projectStore). In a text field the browser's own text undo runs instead. "?" opens the shortcut list.
import { useEffect } from 'react';
import { projectStore } from '../../state/projectStore';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';
export const UNDO_SHORTCUT = `${MOD}Z`;
export const REDO_SHORTCUT = IS_MAC ? '⇧⌘Z' : 'Ctrl+Y';

/** True when a key press belongs to the focused control (typing, a native select, an editable region). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(target.type);
  }
  return false;
}

export type ShortcutAction = 'undo' | 'redo' | 'help' | null;

/** Which workspace action a key press asks for (pure; tested). */
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = IS_MAC): ShortcutAction {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (!mac && e.ctrlKey && !e.altKey && !e.shiftKey && key === 'y') return 'redo';
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?') return 'help';
  return null;
}

/** Installs the workspace shortcuts while mounted. */
export function useWorkspaceShortcuts(o: { onHelp(): void }): void {
  const { onHelp } = o;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      // A modal dialog owns the keyboard.
      if (document.querySelector('dialog[open]')) return;
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') projectStore.getState().undo();
      else if (action === 'redo') projectStore.getState().redo();
      else onHelp();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onHelp]);
}
