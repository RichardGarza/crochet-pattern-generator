// The workspace status bar (DESIGN.md §5.7): validation badges and metrics on the left — the open tab puts
// them there with `<StatusItems>` — and worker progress on the right, read from derivedStore's jobs.
//
//   <StatusItems><Badge tone="success">Stitch counts OK</Badge><span>Workability 82</span></StatusItems>
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDerivedStore, type JobState } from '../../state/derivedStore';
import { Badge } from '../common/Badge';
import { Icon } from '../common/Icon';
import { Spinner } from '../common/Progress';
import { jobLabel } from './jobs';

const StatusSlotContext = createContext<HTMLElement | null>(null);

/** Renders its children into the status bar's left side while mounted (inside a workspace tab). */
export function StatusItems({ children }: { children: ReactNode }) {
  const slot = useContext(StatusSlotContext);
  return slot ? createPortal(children, slot) : null;
}

function JobStatus({ name, job }: { name: string; job: JobState }) {
  if (job.status === 'running') {
    const pct = job.progress === null ? null : Math.round(job.progress * 100);
    return (
      <span className="shell-status__job" data-job={name}>
        <Spinner size={13} />
        <span>
          {jobLabel(name)}
          {/* Percentages are shown, not announced: the live region reports only start, end and failure. */}
          <span aria-hidden="true">{pct === null ? '…' : ` ${pct}%`}</span>
        </span>
        {pct === null ? null : (
          <span className="shell-status__meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
    );
  }
  if (job.status === 'error') {
    return (
      <Badge tone="danger" size="sm" title={job.error?.message}>
        {jobLabel(name)} failed
      </Badge>
    );
  }
  return null;
}

/** The status bar; `children` is the provider for the tab's `<StatusItems>`. */
export function StatusBar({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const allJobs = useDerivedStore((s) => s.jobs);
  const jobs = Object.entries(allJobs).filter(([, j]) => j.status === 'running' || j.status === 'error');
  return (
    <StatusSlotContext.Provider value={slot}>
      {children}
      <footer className="shell-status" aria-label="Status">
        <div className="shell-status__left" ref={setSlot} />
        <div className="shell-status__right" role="status" aria-live="polite">
          {jobs.length > 0 ? (
            jobs.map(([name, job]) => <JobStatus key={name} name={name} job={job} />)
          ) : (
            <span className="shell-status__idle">
              <Icon name="check" size={13} strokeWidth={2} />
              Ready
            </span>
          )}
          {extra}
        </div>
      </footer>
    </StatusSlotContext.Provider>
  );
}
