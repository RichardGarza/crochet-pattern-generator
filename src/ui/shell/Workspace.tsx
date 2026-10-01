// The workspace of one project (DESIGN.md §5.7): top bar · project banners · tab bar · the open tab (or the Q&A
// wizard route) · status bar. Each tab renders inside its own error boundary and Suspense (its chunk loads on
// first use). A project route without a tab, or with a tab this project does not show, is redirected to the
// project's default tab.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { navigate } from '../../app/router';
import { TABS_2D, TABS_3D, defaultRouteTab, qaWizard, visibleTabs } from '../../app/tabs';
import { notify } from '../../app/toasts';
import type { ProjectRoute } from '../../state/appStore';
import { projectStore, useProjectStore } from '../../state/projectStore';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Icon } from '../common/Icon';
import { Spinner } from '../common/Progress';
import { TabPanel, Tabs } from '../common/Tabs';
import { ProjectBanners } from './ProjectBanners';
import { openProject } from './projectSession';
import { ShortcutsDialog } from './ShortcutsDialog';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useFocusOnArrival } from './focusOnArrival';
import { useWorkspaceShortcuts } from './shortcuts';

const ID_BASE = 'ws';

type LoadState = 'loading' | 'ready' | 'missing';

/** Opens the route's project (through projectSession) and reports where that stands. */
function useRouteProject(projectId: string): LoadState {
  const openId = useProjectStore((s) => s.doc?.id);
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (openId === projectId) return;
    let cancelled = false;
    void openProject(projectId).then(
      (found) => {
        if (!cancelled && !found) setMissing(projectId);
      },
      (error: unknown) => {
        if (cancelled) return;
        // Not a missing project: the current one could not be left (unsaved changes) or the backend failed.
        // Say why, and go back to the project that is still open, if any.
        notify.error(`Couldn’t open the project. ${error instanceof Error ? error.message : String(error)}`, { key: 'open-project' });
        const still = projectStore.getState().doc;
        if (still && still.id !== projectId) navigate({ screen: 'project', projectId: still.id }, { replace: true });
        else setMissing(projectId);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, openId]);
  if (openId === projectId) return 'ready';
  return missing === projectId ? 'missing' : 'loading';
}

function TabLoading() {
  return (
    <div className="shell-tab-loading" role="status">
      <Spinner size={22} />
      <span>Loading…</span>
    </div>
  );
}

function MissingProject() {
  return (
    <div className="shell-missing">
      <EmptyState
        icon="folder"
        title="This project isn't here"
        size="lg"
        level={1}
        actions={
          <Button variant="primary" icon="grid" onClick={() => navigate({ screen: 'start' })}>
            Back to your projects
          </Button>
        }
      >
        It may have been deleted, or it was only kept in a tab that has since closed.
      </EmptyState>
    </div>
  );
}

function OpenWorkspace({ route }: { route: ProjectRoute }) {
  // Primitive selections only: the frame re-renders when the name, the mode or the visible tabs change, not on
  // every edit of the document (a drag that updates the model 60 times a second).
  const id = useProjectStore((s) => s.doc?.id);
  const name = useProjectStore((s) => s.doc?.name);
  const mode = useProjectStore((s) => s.doc?.mode);
  const tabKey = useProjectStore((s) => (s.doc ? visibleTabs(s.doc).map((t) => t.id).join(',') : ''));
  const defaultTab = useProjectStore((s) => (s.doc ? defaultRouteTab(s.doc) : null));
  const [helpOpen, setHelpOpen] = useState(false);
  const onHelp = useCallback(() => setHelpOpen(true), []);
  useWorkspaceShortcuts({ onHelp });
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnArrival(mainRef);

  useEffect(() => {
    if (name) document.title = `${name} · Crochet Pattern Generator`;
    return () => {
      document.title = 'Crochet Pattern Generator';
    };
  }, [name]);

  const shown = tabKey.split(',');
  const tabs = (mode === '2d' ? TABS_2D : TABS_3D).filter((t) => shown.includes(t.id));
  const isQa = route.tab === 'qa';
  const tab = isQa ? undefined : tabs.find((t) => t.id === route.tab);
  const needsRedirect = !!id && !isQa && !tab;

  useEffect(() => {
    if (needsRedirect && id && defaultTab) navigate({ screen: 'project', projectId: id, tab: defaultTab }, { replace: true });
  }, [needsRedirect, id, defaultTab]);

  if (!id) return null;
  const Body = isQa ? qaWizard.Component : tab?.Component;
  const where = isQa ? 'the Q&A wizard' : tab ? `the ${tab.label} tab` : 'this view';

  return (
    <StatusBar>
      <TopBar projectId={id} onHelp={onHelp} />
      <ProjectBanners />
      <div className="shell-tabbar">
        {isQa ? (
          <span className="shell-tabbar__route" aria-current="page">
            <Icon name="message" size={17} />
            Describe your toy
          </span>
        ) : null}
        <Tabs
          idBase={ID_BASE}
          ariaLabel="Project views"
          items={tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
          value={tab?.id ?? null}
          onChange={(next) => navigate({ screen: 'project', projectId: id, tab: next })}
        />
      </div>
      <main className="shell-workspace__body" id="main" tabIndex={-1} ref={mainRef}>
        {/* The page's h1: the name in the top bar is an input, not a heading. */}
        <h1 className="ui-visually-hidden">{name}</h1>
        {Body ? (
          <ErrorBoundary where={where} resetKey={`${id}/${route.tab ?? ''}`}>
            <Suspense fallback={<TabLoading />}>
              {tab ? (
                <TabPanel idBase={ID_BASE} id={tab.id} className="shell-workspace__panel">
                  <Body />
                </TabPanel>
              ) : (
                <div className="shell-workspace__panel">
                  <Body />
                </div>
              )}
            </Suspense>
          </ErrorBoundary>
        ) : (
          <TabLoading />
        )}
      </main>
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </StatusBar>
  );
}

export function Workspace({ route }: { route: ProjectRoute }) {
  const state = useRouteProject(route.projectId);
  return (
    <div className="shell-workspace" data-testid="workspace">
      {state === 'ready' ? <OpenWorkspace route={route} /> : state === 'missing' ? <MissingProject /> : <TabLoading />}
    </div>
  );
}
