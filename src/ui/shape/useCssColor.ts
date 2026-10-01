// Track T6 — reads a design token (a CSS custom property holding a color) and follows theme changes, so the
// WebGL viewport (selection outline) uses the same accent as the rest of the app in light and dark.
import { useEffect, useState } from 'react';

function read(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function useCssColor(name: string, fallback: string): string {
  const [value, setValue] = useState(() => read(name, fallback));
  useEffect(() => {
    const sync = () => setValue(read(name, fallback));
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener('change', sync);
    sync();
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', sync);
    };
  }, [name, fallback]);
  return value;
}
