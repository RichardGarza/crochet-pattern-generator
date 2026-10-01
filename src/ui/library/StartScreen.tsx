// Track T8 — the start screen's library: the project grid with thumbnails, duplicate, export, delete with
// confirm, and "Restore from folder or backup" (DESIGN.md §5.7, F7). The `#/` route entry (app/tabs.ts).
//
// Step 0 stub. It delegates to the shell's StartLayout (header, the five new-project cards — creation is the
// shell's) and shows the projects of this tab through the shell's ProjectGrid. T8 replaces this file: keep
// `StartLayout` and pass the real grid (`renderActions`, `thumbnailUrl`, `summaries` from the repository) and
// the restore button; drop `__stub`.
import { navigate } from '../../app/router';
import { useAppStore } from '../../state/appStore';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { ProjectGrid } from '../shell/start/ProjectGrid';
import { StartLayout } from '../shell/start/StartLayout';

export function StartScreen() {
  const library = useAppStore((s) => s.library);
  return (
    <StartLayout
      libraryActions={
        <Button variant="ghost" icon="refresh" size="sm" disabledReason="Coming soon: restore a project from the projects folder or a backup">
          Restore from folder or backup
        </Button>
      }
      library={
        <ProjectGrid
          summaries={library ?? []}
          onOpen={(id) => navigate({ screen: 'project', projectId: id })}
          empty={
            <EmptyState icon="yarn" title="No projects yet" variant="panel">
              Pick one of the cards above to start. Your projects are saved in this browser as you work.
            </EmptyState>
          }
        />
      }
    />
  );
}
StartScreen.__stub = true as const;
