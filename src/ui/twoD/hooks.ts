// Track T2.3 — small hooks of the 2D tabs.
import { useEffect, useState } from 'react';
import { projectStore } from '../../state/projectStore';
import type { AssetRef } from '../../types';
import type { Size } from './cropGeometry';

/** An object URL for an asset of the open project (revoked when it changes or unmounts). */
export function useAssetUrl(ref: AssetRef | undefined): string | null {
  const [state, setState] = useState<{ key: string; url: string } | null>(null);
  const key = ref?.key;
  useEffect(() => {
    if (!key || typeof URL.createObjectURL !== 'function') return undefined;
    let live = true;
    let made: string | null = null;
    projectStore
      .getState()
      .getAsset(key)
      .then((blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setState({ key, url: made });
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [key]);
  return key && state?.key === key ? state.url : null;
}

/** The content size of an element (0 × 0 without ResizeObserver, as in happy-dom). */
export function useElementSize(el: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return undefined;
    const read = () => setSize((old) => (old.w === el.clientWidth && old.h === el.clientHeight ? old : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}
