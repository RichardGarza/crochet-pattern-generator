// The workspace top bar (DESIGN.md §5.7): library, editable name, save chip, undo / redo, Print / PDF, Export.
import { navigate } from '../../app/router';
import { projectStore, selectCanRedo, selectCanUndo, selectRedoLabel, selectUndoLabel, useProjectStore } from '../../state/projectStore';
import { Badge } from '../common/Badge';
import { Button, IconButton } from '../common/Button';
import { ProjectName } from './ProjectName';
import { printBlockedReason, printPattern, usePatternDoc } from './print';
import { buildPdf } from '../../core/print/pdf';
import { isImplemented } from '../../core/stub';
import { ProjectSaveChip } from './SaveChip';
import { ThemeToggle } from './ThemeToggle';
import { REDO_SHORTCUT, UNDO_SHORTCUT } from './shortcuts';

export function TopBar({ projectId, onHelp }: { projectId: string; onHelp(): void }) {
  const mode = useProjectStore((s) => s.doc?.mode);
  const canUndo = useProjectStore(selectCanUndo);
  const canRedo = useProjectStore(selectCanRedo);
  const undoLabel = useProjectStore(selectUndoLabel);
  const redoLabel = useProjectStore(selectRedoLabel);
  const pattern = usePatternDoc();
  const printReason = printBlockedReason(isImplemented(buildPdf), pattern);

  return (
    <header className="shell-topbar">
      <div className="shell-topbar__start">
        <Button variant="ghost" icon="grid" onClick={() => navigate({ screen: 'start' })} className="shell-topbar__library">
          Projects
        </Button>
        <span className="shell-topbar__sep" aria-hidden="true" />
        <ProjectName />
        {mode ? (
          <Badge tone="neutral" icon={mode === '2d' ? 'chart' : 'cube'} size="sm" className="shell-topbar__mode">
            {mode === '2d' ? '2D chart' : '3D toy'}
          </Badge>
        ) : null}
        <ProjectSaveChip />
      </div>
      <div className="shell-topbar__end">
        <div className="shell-topbar__group" role="group" aria-label="History">
          <IconButton
            icon="undo"
            label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
            shortcut={UNDO_SHORTCUT}
            disabledReason={canUndo ? undefined : 'Nothing to undo'}
            onClick={() => projectStore.getState().undo()}
            data-testid="undo"
          />
          <IconButton
            icon="redo"
            label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
            shortcut={REDO_SHORTCUT}
            disabledReason={canRedo ? undefined : 'Nothing to redo'}
            onClick={() => projectStore.getState().redo()}
            data-testid="redo"
          />
        </div>
        <span className="shell-topbar__sep" aria-hidden="true" />
        <IconButton icon="keyboard" label="Keyboard shortcuts" shortcut="?" onClick={onHelp} />
        <ThemeToggle />
        <Button variant="secondary" icon="printer" disabledReason={printReason ?? undefined} onClick={() => pattern && void printPattern(pattern)}>
          Print / PDF
        </Button>
        <Button variant="primary" icon="share" onClick={() => navigate({ screen: 'project', projectId, tab: 'export' })}>
          Export
        </Button>
      </div>
    </header>
  );
}
