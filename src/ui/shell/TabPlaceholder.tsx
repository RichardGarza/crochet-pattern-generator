// The placeholder a Step 0 stub tab shows until its track builds the real one: what the tab will do, and
// which track brings it. Marked `data-stub` so tests can tell a stub from the real tab.
import type { ReactNode } from 'react';
import type { TrackId } from '../../app/tabs';
import { Badge } from '../common/Badge';
import { Icon, type IconName } from '../common/Icon';
import { TabLayout } from '../common/Layout';

export interface TabPlaceholderProps {
  /** The component name, for `data-stub` ("SourceTab"). */
  stub: string;
  title: string;
  icon: IconName;
  track: TrackId;
  summary: ReactNode;
  /** What the finished tab will offer, 3–5 short lines. */
  features: string[];
  /** Extra content under the list. */
  children?: ReactNode;
  /** A settings sidebar (e.g. the 3D Pattern tab's Yarn & size panel slot). */
  sidebar?: ReactNode;
}

export function TabPlaceholder({ stub, title, icon, track, summary, features, children, sidebar }: TabPlaceholderProps) {
  return (
    <TabLayout mainBackdrop="canvas" mainPadding="lg" mainLabel={title} sidebar={sidebar}>
      <div className="shell-placeholder" data-stub={stub} data-track={track}>
        <div className="shell-placeholder__card">
          <div className="shell-placeholder__head">
            <span className="shell-placeholder__tile">
              <Icon name={icon} size={26} />
            </span>
            <Badge tone="accent" icon="sparkles">
              Coming soon
            </Badge>
          </div>
          <h2 className="shell-placeholder__title">{title}</h2>
          <p className="shell-placeholder__summary">{summary}</p>
          <ul className="shell-placeholder__list" aria-label="What this tab will do">
            {features.map((f) => (
              <li key={f}>
                <Icon name="check" size={16} strokeWidth={2} />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          {children}
        </div>
      </div>
    </TabLayout>
  );
}
