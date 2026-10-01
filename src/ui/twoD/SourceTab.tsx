// Track T2 — the Source tab of a 2D project: picture intake (drop / choose, HEIC via the server), crop, rotate,
// flip, background handling, and the chart settings panel (DESIGN.md F1 steps 1–3).
//
// Step 0 stub: a labelled placeholder. T2 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function SourceTab() {
  return (
    <TabPlaceholder
      stub="SourceTab"
      title="Source picture"
      icon="image"
      track="T2"
      summary="Add the picture to chart, then frame it and choose how its background is worked."
      features={[
        'Drop or choose a JPG, PNG, WebP, GIF or iPhone HEIC picture',
        'Crop freely or to the finished shape; rotate and flip',
        'Keep the background, or work it in one plain yarn',
        'Settings: technique, yarn and hook, finished size, colors, level of detail',
      ]}
    />
  );
}
SourceTab.__stub = true as const;
