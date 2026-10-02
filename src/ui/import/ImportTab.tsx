// Track T7.4 — the Import tab (DESIGN.md F4 steps 4–6, §3.7, §5.3, §5.7): a Claude Design result or a 3D model into
// this project — drop or paste, the import report, the changes, Accept, then the Yarn & size panel. Shown for
// projects from Claude Design or "Describe a toy", a project waiting for a Claude Design result, and any project
// with imports (`app/tabs.ts`).
import { TabLayout } from '../common';
import { ImportView } from './ImportView';

export function ImportTab() {
  return (
    <TabLayout mainLabel="Import" mainPadding="lg" mainBackdrop="canvas">
      <ImportView variant="tab" />
    </TabLayout>
  );
}
