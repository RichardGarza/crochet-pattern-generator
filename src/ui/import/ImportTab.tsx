// Track T7 — the Import tab: a Claude Design result or a 3D model into this project, the import report, the
// diff and accept (DESIGN.md F4 steps 4–5, §3.7).
//
// Step 0 stub: a labelled placeholder. T7 replaces this file with the real tab (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function ImportTab() {
  return (
    <TabPlaceholder
      stub="ImportTab"
      title="Import"
      icon="import"
      track="T7"
      summary="Bring a Claude Design result or a 3D model into this project."
      features={[
        'Drop a .zip, .html, .glb, .gltf, .obj with .mtl, .ply, .stl or .json — or paste text',
        'See what was read, and every automatic repair',
        'Compare with the current model, then accept it as a new version',
        'No model data in the result? Copy a short fix-up message for Claude Design',
      ]}
    />
  );
}
ImportTab.__stub = true as const;
