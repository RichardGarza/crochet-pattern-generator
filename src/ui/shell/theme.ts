// The color theme. `prefs.theme` (appStore) is the user's choice: 'system' follows `prefers-color-scheme`
// (tokens.css), 'light' / 'dark' are written to <html data-theme>. The choice is also mirrored to localStorage
// (`cpg.theme`) so index.html can set it before the first paint, and so it survives a reload before T8 persists
// the preferences (main.tsx reads it back at start; T8's `hydratePrefs` wins once it runs).
import { useEffect } from 'react';
import { appStore, useAppStore, type ThemePref } from '../../state/appStore';

export const THEME_STORAGE_KEY = 'cpg.theme';

export function readThemeHint(): ThemePref | null {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function writeThemeHint(theme: ThemePref): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be refused (private mode); the theme still applies for this session.
  }
}

/** Writes `data-theme` for the current preference (none for 'system'). */
export function applyTheme(theme: ThemePref, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Keeps <html data-theme> and the hint in step with `prefs.theme`. Mount once (App). */
export function useApplyTheme(): ThemePref {
  const theme = useAppStore((s) => s.prefs.theme);
  useEffect(() => {
    applyTheme(theme);
    writeThemeHint(theme);
  }, [theme]);
  return theme;
}

/** The theme actually shown: the preference, or the system's when it is 'system'. */
export function resolvedTheme(theme: ThemePref): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** System → Light → Dark → System. */
export function nextTheme(theme: ThemePref): ThemePref {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

export function setTheme(theme: ThemePref): void {
  appStore.getState().setPrefs({ theme });
}
