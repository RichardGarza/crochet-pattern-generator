// The app root (DESIGN.md §5.3, §5.7): the theme, the capability probe, the route (start screen or a project's
// workspace) and the toasts. Rendered once by main.tsx.
import { Suspense, useEffect } from 'react';
import { ErrorBoundary } from './app/ErrorBoundary';
import { useRoute } from './app/router';
import { startScreen } from './app/tabs';
import { appStore, probeCapabilities } from './state/appStore';
import { Spinner } from './ui/common/Progress';
import { ToastRegion } from './ui/shell/ToastRegion';
import { Workspace } from './ui/shell/Workspace';
import { useApplyTheme } from './ui/shell/theme';
import { useUnloadGuard } from './ui/shell/unloadGuard';

let probed: Promise<void> | null = null;

/** Probes WebGPU, persistent storage and the folder mirror once per page (§5.5.4: HEAD /__projects → x-cpg-mirror). */
function useCapabilities(): void {
  useEffect(() => {
    probed ??= probeCapabilities().then((c) => appStore.getState().setCapabilities(c));
  }, []);
}

function SkipLink() {
  // A hash link would be read as a route, so the skip link moves focus itself.
  return (
    <a
      className="shell-skip"
      href="#main"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById('main')?.focus();
      }}
    >
      Skip to content
    </a>
  );
}

function Loading() {
  return (
    <div className="shell-boot" role="status">
      <Spinner size={22} label="Loading" />
    </div>
  );
}

export function App() {
  useApplyTheme();
  useCapabilities();
  useUnloadGuard();
  const route = useRoute();
  const StartScreen = startScreen.Component;
  return (
    <>
      <SkipLink />
      <ErrorBoundary where="the app" resetKey={route.screen === 'start' ? 'start' : route.projectId}>
        {route.screen === 'start' ? (
          <Suspense fallback={<Loading />}>
            <StartScreen />
          </Suspense>
        ) : (
          <Workspace route={route} />
        )}
      </ErrorBoundary>
      <ToastRegion />
    </>
  );
}
