// Pure helpers of the shell: shortcuts, relative times, print availability, job names, theme cycling.
import { describe, expect, it } from 'vitest';
import type { PatternDoc } from '../../../types/pattern';
import { jobLabel } from '../jobs';
import { printBlockedReason } from '../print';
import { formatRelativeTime } from '../relativeTime';
import { shortcutFor } from '../shortcuts';
import { nextTheme } from '../theme';

const key = (k: string, o: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe('shortcutFor', () => {
  it('Mac: ⌘Z undo, ⇧⌘Z redo; Ctrl does nothing', () => {
    expect(shortcutFor(key('z', { metaKey: true }), true)).toBe('undo');
    expect(shortcutFor(key('Z', { metaKey: true, shiftKey: true }), true)).toBe('redo');
    expect(shortcutFor(key('z', { ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(key('y', { ctrlKey: true }), true)).toBeNull();
  });
  it('Windows / Linux: Ctrl+Z undo, Ctrl+Shift+Z and Ctrl+Y redo', () => {
    expect(shortcutFor(key('z', { ctrlKey: true }), false)).toBe('undo');
    expect(shortcutFor(key('z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo');
    expect(shortcutFor(key('y', { ctrlKey: true }), false)).toBe('redo');
    expect(shortcutFor(key('z', { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
  it('"?" is help; plain letters are nothing', () => {
    expect(shortcutFor(key('?', { shiftKey: true }), true)).toBe('help');
    expect(shortcutFor(key('z'), true)).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  it('reads naturally', () => {
    expect(formatRelativeTime('2026-10-01T11:59:30Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-01T11:59:00Z', now)).toBe('1 minute ago');
    expect(formatRelativeTime('2026-10-01T11:15:00Z', now)).toBe('45 minutes ago');
    expect(formatRelativeTime('2026-10-01T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-09-30T08:00:00Z', now)).toBe('yesterday');
    expect(formatRelativeTime('2026-09-27T12:00:00Z', now)).toBe('4 days ago');
    expect(formatRelativeTime('2026-08-01T12:00:00Z', now)).toMatch(/Aug|8/);
    expect(formatRelativeTime('garbage', now)).toBe('');
  });
});

describe('printBlockedReason (F8)', () => {
  const pattern = (severity?: 'error' | 'warn') => ({ issues: severity ? [{ code: severity === 'error' ? 'E_COUNT' : 'W_X', severity, message: '' }] : [] }) as unknown as PatternDoc;
  it('needs the PDF builder, a pattern, and no errors', () => {
    expect(printBlockedReason(false, pattern())).toMatch(/not available/);
    expect(printBlockedReason(true, undefined)).toMatch(/once the pattern is ready/);
    expect(printBlockedReason(true, pattern('error'))).toMatch(/errors/);
    expect(printBlockedReason(true, pattern('warn'))).toBeNull();
    expect(printBlockedReason(true, pattern())).toBeNull();
  });
});

describe('small names', () => {
  it('job labels', () => {
    expect(jobLabel('recon')).toBe('3D build');
    expect(jobLabel('somethingNew')).toBe('SomethingNew');
  });
  it('theme cycle', () => {
    expect([nextTheme('system'), nextTheme('light'), nextTheme('dark')]).toEqual(['light', 'dark', 'system']);
  });
});
