// Track T8 — the Export tab: PDF (Letter / A4) and print, chart files, pattern text, the project file
// (DESIGN.md F1 step 8, F7, F8).
//
// Step 0 stub: a labelled placeholder. T8 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function ExportTab() {
  return (
    <TabPlaceholder
      stub="ExportTab"
      title="Export"
      icon="share"
      track="T8"
      summary="Take your pattern with you, on paper or as files."
      features={[
        'A print-ready PDF (Letter or A4): cover, materials, tiled chart with a page map, every row',
        'The chart as a PNG (one pixel per stitch), CSV or JSON',
        'The pattern as plain text or Markdown',
        'The whole project as one .crochet.json file, for backup or sharing',
      ]}
    />
  );
}
ExportTab.__stub = true as const;
