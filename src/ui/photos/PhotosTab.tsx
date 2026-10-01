// Track T3 — the Photos tab of a 3D photo project: add and label views, masks, alignment, the build (DESIGN.md
// F2 steps 1–6, F3).
//
// Step 0 stub: a labelled placeholder. T3 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function PhotosTab() {
  return (
    <TabPlaceholder
      stub="PhotosTab"
      title="Photos"
      icon="images"
      track="T3"
      summary="Add photos of your toy, say which side each one shows, and the app lifts the toy off the background."
      features={[
        'Two to six photos (front and one side at least), or one photo with the 3D-ifier',
        'Label each view: front, back, left, right, top or bottom',
        'Automatic cut-outs with a touch-up brush; optional click-to-select',
        'Yarn & size, then Build: a parts model to adjust on the Shape tab',
      ]}
    />
  );
}
PhotosTab.__stub = true as const;
