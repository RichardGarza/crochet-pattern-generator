// The workspace of one project (DESIGN.md §5.7): top bar · project banners · tab bar · the open tab (or the Q&A
// wizard route) · status bar. Each tab renders inside its own error boundary and Suspense (its chunk loads on
// first use). A project route without a tab, or with a tab this project does not show, is redirected to the
// project's default tab.
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { navigate } from '../../app/router';
import { defaultRouteTab, findTab, qaWizard, visibleTabs } from '../../app/tabs';
import type { ProjectRoute } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Progress';
import { TabPanel, Tabs } from '../common/Tabs';
import { ProjectBanners } from './ProjectBanners';
import { openProject } from './projectSession';
import { ShortcutsDialog } from './ShortcutsDialog';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
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
      () => {
        if (!cancelled) setMissing(projectId);
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
  const doc = useProjectStore((s) => s.doc);
  const [helpOpen, setHelpOpen] = useState(false);
  const onHelp = useCallback(() => setHelpOpen(true), []);
  useWorkspaceShortcuts({ onHelp });

  const name = doc?.name;
  useEffect(() => {
    if (name) document.title = `${name} · Crochet Pattern Generator`;
    return () => {
      document.title = 'Crochet Pattern Generator';
    };
  }, [name]);

  const tabs = doc ? visibleTabs(doc) : [];
  const isQa = route.tab === 'qa';
  const tab = doc && !isQa ? findTab(doc, route.tab) : undefined;
  const needsRedirect = !!doc && !isQa && !tab;

  useEffect(() => {
    if (needsRedirect && doc) navigate({ screen: 'project', projectId: doc.id, tab: defaultRouteTab(doc) }, { replace: true });
  }, [needsRedirect, doc]);

  if (!doc) return null;
  const Body = isQa ? qaWizard.Component : tab?.Component;
  const where = isQa ? 'the Q&A wizard' : tab ? `the ${tab.label} tab` : 'this view';

  return (
    <StatusBar>
      <TopBar projectId={doc.id} onHelp={onHelp} />
      <ProjectBanners />
      <nav className="shell-tabbar" aria-label="Project">
        <Tabs
          idBase={ID_BASE}
          ariaLabel="Project views"
          items={tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
          value={tab?.id ?? null}
          onChange={(id) => navigate({ screen: 'project', projectId: doc.id, tab: id })}
        />
        {isQa ? (
          <span className="shell-tabbar__route">
            <span className="shell-tabbar__route-dot" aria-hidden="true" />
            Describe your toy
          </span>
        ) : null}
      </nav>
      <main className="shell-workspace__body" id="main" tabIndex={-1}>
        {Body ? (
          <ErrorBoundary where={where} resetKey={`${doc.id}/${route.tab ?? ''}`}>
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
