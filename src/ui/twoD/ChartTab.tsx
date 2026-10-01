// Track T2 — the Chart tab: the chart editor next to the picture, with live workability metrics (DESIGN.md F1
// steps 4–5).
//
// Step 0 stub: a labelled placeholder. T2 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function ChartTab() {
  return (
    <TabPlaceholder
      stub="ChartTab"
      title="Chart"
      icon="chart"
      track="T2"
      summary="Your colorwork chart, stitch by stitch in true proportions, side by side with the picture."
      features={[
        'Paint, fill, replace and pick colors; lock cells against clean-up',
        'Merge colors and recolor to a real yarn',
        'Live metrics: color changes per row, confetti, bobbins, workability',
      ]}
    />
  );
}
ChartTab.__stub = true as const;
