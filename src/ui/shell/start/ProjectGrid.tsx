// The "Your projects" grid (§5.7): one card per ProjectSummary — thumbnail, name, mode, last change, a "waiting
// for Claude Design" badge — opened with one click. The library (T8) passes its card actions (duplicate,
// export, delete with confirm) through `renderActions` and a thumbnail URL through `thumbnailUrl`;
// `summaries === null` shows loading placeholders.
import type { ReactNode } from 'react';
import type { ProjectSummary } from '../../../types/project';
import { Badge } from '../../common/Badge';
import { EmptyState } from '../../common/EmptyState';
import { Icon } from '../../common/Icon';
import { formatRelativeTime } from '../relativeTime';
import { HeartChartArt, ToyArt } from './ChartArt';

export interface ProjectGridProps {
  /** null = still loading. */
  summaries: readonly ProjectSummary[] | null;
  onOpen(id: string): void;
  /** Buttons shown on a card (they must stop the click from opening the project). */
  renderActions?(summary: ProjectSummary): ReactNode;
  thumbnailUrl?(summary: ProjectSummary): string | undefined;
  /** What an empty library shows. */
  empty?: ReactNode;
  /** Newest first by default. */
  sort?: 'updated' | 'none';
}

function Thumb({ summary, url }: { summary: ProjectSummary; url?: string }) {
  if (url) return <img className="shell-project__img" src={url} alt="" loading="lazy" />;
  return <span className="shell-project__art">{summary.mode === '2d' ? <HeartChartArt cell={9} gap={1.5} /> : <ToyArt size={84} />}</span>;
}

export function ProjectGrid({ summaries, onOpen, renderActions, thumbnailUrl, empty, sort = 'updated' }: ProjectGridProps) {
  if (summaries === null) {
    return (
      <ul className="shell-projects" aria-busy="true" aria-label="Loading projects">
        {[0, 1, 2].map((i) => (
          <li key={i} className="shell-project shell-project--skeleton" aria-hidden="true">
            <span className="shell-project__thumb" />
            <span className="shell-skeleton shell-skeleton--title" />
            <span className="shell-skeleton shell-skeleton--line" />
          </li>
        ))}
      </ul>
    );
  }
  if (summaries.length === 0) {
    return (
      <>
        {empty ?? (
          <EmptyState icon="yarn" title="No projects yet" variant="panel">
            Start one above; it will appear here.
          </EmptyState>
        )}
      </>
    );
  }
  const list = sort === 'updated' ? [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : summaries;
  return (
    <ul className="shell-projects" aria-label="Your projects">
      {list.map((s) => (
        <li key={s.id} className="shell-project">
          <button type="button" className="shell-project__open" onClick={() => onOpen(s.id)} aria-label={`Open ${s.name}`} data-project-id={s.id}>
            <span className="shell-project__thumb">
              <Thumb summary={s} url={thumbnailUrl?.(s)} />
            </span>
            <span className="shell-project__info">
              <span className="shell-project__name">{s.name}</span>
              <span className="shell-project__meta">
                <Icon name={s.mode === '2d' ? 'chart' : 'cube'} size={13} />
                <span>{s.mode === '2d' ? '2D chart' : '3D toy'}</span>
                <span aria-hidden="true">·</span>
                <span>Edited {formatRelativeTime(s.updatedAt)}</span>
              </span>
            </span>
          </button>
          {s.awaitingClaudeDesign ? (
            <Badge tone="accent" icon="hourglass" size="sm" className="shell-project__badge">
              Waiting for Claude Design
            </Badge>
          ) : null}
          {renderActions ? <div className="shell-project__actions">{renderActions(s)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
