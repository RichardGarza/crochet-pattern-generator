// Track T6 — the Yarn & size panel shared by every 3D origin: target height, yarn weight, hook, yarn over /
// under, test ball, default stuffing (DESIGN.md §4.5). Shown before the build, after an import, on the Shape
// tab and as the 3D Pattern tab's settings slot.
//
// Step 0 stub: a labelled placeholder panel. T6 replaces this file with the real panel (same props) and drops
// `__stub`.
import type { YarnSizePanelProps } from '../../types/ui';
import { Badge } from '../common/Badge';
import { Panel } from '../common/Layout';

export type { YarnSizePanelProps } from '../../types/ui';

export function YarnSizePanel({ context }: YarnSizePanelProps) {
  return (
    <Panel title="Yarn & size" icon="ruler">
      <div className="shell-panel-placeholder" data-stub="YarnSizePanel" data-track="T6" data-context={context}>
        <p>Target height, yarn weight and hook, yarn over or under, a test ball, stuffing.</p>
        <Badge tone="accent" icon="sparkles" size="sm">
          Coming soon
        </Badge>
      </div>
    </Panel>
  );
}
YarnSizePanel.__stub = true as const;
