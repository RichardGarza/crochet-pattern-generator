// Track T7 — the Q&A wizard (the `#/p/<id>/qa` route): questions, the seed blockout, Copy prompt / Save kit and
// the import step (DESIGN.md F4, §3.2–3.4). It resumes at `QaState.step`.
//
// Step 0 stub: a labelled placeholder. T7 replaces this file with the real wizard (no props) and drops `__stub`.
import { TabPlaceholder } from '../shell/TabPlaceholder';

export function QaWizard() {
  return (
    <TabPlaceholder
      stub="QaWizard"
      title="Describe your toy"
      icon="message"
      track="T7"
      summary="A short Q&A turns your answers into a ready prompt for Claude Design."
      features={[
        'What it is, its size, yarn and parts — each question with “Decide for me”',
        'A live blockout of the parts as you answer',
        'Copy the prompt, or save a kit with your photos',
        'Then bring the result back on the Import tab',
      ]}
    />
  );
}
QaWizard.__stub = true as const;
