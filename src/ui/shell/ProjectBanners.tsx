// The banner slot above the tab bar (§5.3, §5.7): banners posted by persistence (banners.ts), the shell's own
// read-only notice, and "Waiting for your Claude Design result" (F4 step 3) while doc.qa.awaiting is set.
import { navigate } from '../../app/router';
import { notify } from '../../app/toasts';
import { projectStore, useProjectStore } from '../../state/projectStore';
import { Banner } from '../common/Banner';
import { Button } from '../common/Button';
import { dismissProjectBanner, useProjectBanners, type ProjectBanner } from './banners';
import { formatRelativeTime } from './relativeTime';

function PostedBanner({ banner }: { banner: ProjectBanner }) {
  return (
    <Banner
      tone={banner.tone}
      title={banner.title}
      onDismiss={banner.dismissible ? () => dismissProjectBanner(banner.id) : undefined}
      actions={
        banner.actions?.length ? (
          <>
            {banner.actions.map((a, i) => (
              <Button key={a.label} size="sm" variant={a.variant ?? (i === 0 ? 'secondary' : 'ghost')} onClick={a.run}>
                {a.label}
              </Button>
            ))}
          </>
        ) : undefined
      }
    >
      {banner.message}
    </Banner>
  );
}

function AwaitingBanner({ projectId, since }: { projectId: string; since: string }) {
  const dismiss = () => {
    const changed = projectStore.getState().update('Stop waiting for Claude Design', (d) => {
      if (d.qa) delete d.qa.awaiting;
    });
    if (changed) notify.info('No longer waiting for a Claude Design result. You can still import one from the Import tab.');
  };
  return (
    <Banner
      tone="accent"
      icon="hourglass"
      title="Waiting for your Claude Design result"
      actions={
        <>
          <Button size="sm" variant="primary" icon="import" onClick={() => navigate({ screen: 'project', projectId, tab: 'import' })}>
            Import Claude Design result
          </Button>
          <Button size="sm" variant="ghost" icon="copy" onClick={() => navigate({ screen: 'project', projectId, tab: 'qa' })}>
            Copy prompt again
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        </>
      }
    >
      Prompt copied {formatRelativeTime(since)}. You can close the app meanwhile — nothing is lost.
    </Banner>
  );
}

export function ProjectBanners() {
  const posted = useProjectBanners();
  const readOnly = useProjectStore((s) => s.readOnly);
  const projectId = useProjectStore((s) => s.doc?.id);
  const awaitingSince = useProjectStore((s) => s.doc?.qa?.awaiting?.since);
  const hasReadOnlyBanner = posted.some((b) => b.kind === 'read-only');
  if (!projectId) return null;
  const items = [
    ...posted.map((b) => <PostedBanner key={`posted-${b.id}`} banner={b} />),
    readOnly && !hasReadOnlyBanner ? (
      <Banner key="read-only" tone="warn" icon="lock" title="Read-only">
        This project is open in another tab. You can look around here, but changes are off.
      </Banner>
    ) : null,
    awaitingSince ? <AwaitingBanner key="awaiting" projectId={projectId} since={awaitingSince} /> : null,
  ].filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className="shell-banners" aria-label="Project messages" role="region">
      {items}
    </div>
  );
}
