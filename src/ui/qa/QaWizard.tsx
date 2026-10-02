// Track T7 — the Q&A wizard (the `#/p/<id>/qa` route): questions, the seed blockout, Copy prompt / Save kit and the
// import step (DESIGN.md F4, §3.2–3.4). It resumes at `QaState.step`.
//
// T7.4a (design v1.5: the questions, the prompt and the send step wait for the postponed Claude Design send-side
// trial): while the project waits for a Claude Design result (`qa.awaiting`), the wizard opens at its import step
// (F4 step 1) — the same import screen as the Import tab. "Copy prompt again" is offered only when the stored
// prompt text exists, which needs prompt-v1 (T7.3), so it is not shown yet. Otherwise the wizard is still the
// Step 0 placeholder, so it keeps `__stub` until T7.3.
import { TabLayout } from '../common';
import { ImportView } from '../import/ImportView';
import { TabPlaceholder } from '../shell/TabPlaceholder';
import { useProjectStore } from '../../state/projectStore';

export function QaWizard() {
  const awaiting = useProjectStore((s) => !!s.doc?.qa?.awaiting);
  if (awaiting) {
    return (
      <TabLayout mainLabel="Bring back your Claude Design result" mainPadding="lg" mainBackdrop="canvas">
        <ImportView variant="wizard" />
      </TabLayout>
    );
  }
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
