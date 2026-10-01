// The hash router (DESIGN.md §5.3): `#/` start · `#/p/<id>` a project at its default tab · `#/p/<id>/<tab>` ·
// `#/p/<id>/qa` the Q&A wizard. The route itself lives in appStore (`route`), parsed by appStore's pure
// `parseHash` / `formatHash`; this module connects them to the browser:
//
//   startRouter()        listens to `hashchange` and writes `setRoute(parseHash(location.hash))`; call once.
//   navigate(route)      writes `location.hash` (a history entry; the listener updates the store), or with
//                        { replace: true } replaces the entry and updates the store at once.
//   useRoute()           the current route, as a React hook.
//   hrefFor(route)       the `href` for a link.
import { appStore, formatHash, parseHash, sameRoute, useAppStore, type Route } from '../state/appStore';

let navigated = false;

/** True once the route changed after the page loaded (a navigation, Back / Forward, a typed hash). */
export const hasNavigated = (): boolean => navigated;

/** Starts following `location.hash`. Returns a function that stops it. */
export function startRouter(): () => void {
  const sync = () => appStore.getState().setRoute(parseHash(window.location.hash));
  const onHashChange = () => {
    navigated = true;
    sync();
  };
  sync();
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}

/**
 * Goes to `route`. A normal navigation adds a history entry (Back returns); `replace` rewrites the current
 * entry (redirects, e.g. a project route without a tab → its default tab).
 */
export function navigate(route: Route, o: { replace?: boolean } = {}): void {
  const hash = formatHash(route);
  navigated = true;
  if (o.replace) {
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
    appStore.getState().setRoute(parseHash(hash));
    return;
  }
  if (window.location.hash === hash) {
    appStore.getState().setRoute(parseHash(hash));
    return;
  }
  window.location.hash = hash;
}

/** The `href` of a route (for `<a>` elements). */
export const hrefFor = (route: Route): string => formatHash(route);

/** The current route. */
export function useRoute(): Route {
  return useAppStore((s) => s.route);
}

/** True when `route` is the current route. */
export function isCurrent(route: Route): boolean {
  return sameRoute(appStore.getState().route, route);
}
