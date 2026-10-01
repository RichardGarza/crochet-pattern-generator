// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { CrochetModelV1 } from './model';

/** The Q&A wizard's saved state (§3.2–§3.4). */
export interface QaState {
  answers: Record<string, unknown>;
  decided: Record<string, 'user' | 'auto'>;
  seed?: CrochetModelV1;
  seedSource: 'current-model' | 'template';
  promptVersion: 'prompt-v1';
  builderVersion: 'builder-v1';
  /** Where the wizard resumes (F4 step 1). */
  step: 'questions' | 'send' | 'import';
  /** Last Copy prompt / Save kit / fix-up copy. */
  generatedAt?: string;
  /** Drives the banner and the Import tab; cleared by an accepted import or Dismiss (§3.7.7). */
  awaiting?: { since: string; seedRev: number; via: 'copy' | 'compact' | 'kit' | 'fixup' };
  fixupVersion?: 'fixup-v1';
}
