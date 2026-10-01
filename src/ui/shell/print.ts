// Print / PDF from the top bar (F8): available when T8's buildPdf exists and the project has a pattern without
// errors ("exports are blocked while any E_* validation error exists").
import { notify } from '../../app/toasts';
import { buildPdf } from '../../core/print/pdf';
import { useDerivedStore } from '../../state/derivedStore';
import { useProjectStore } from '../../state/projectStore';
import type { PatternDoc } from '../../types/pattern';

/** The open project's pattern, when one has been generated (2D: pattern2d; 3D: the amigurumi result). */
export function usePatternDoc(): PatternDoc | undefined {
  const mode = useProjectStore((s) => s.doc?.mode);
  return useDerivedStore((s) => (mode === '2d' ? s.pattern2d?.value : mode === '3d' ? s.ami?.value.pattern : undefined));
}

/** Why Print / PDF cannot run now, or null when it can. */
export function printBlockedReason(pdfReady: boolean, pattern: PatternDoc | undefined): string | null {
  if (!pdfReady) return 'Printing and PDF are not available yet';
  if (!pattern) return 'Available once the pattern is ready';
  if (pattern.issues.some((i) => i.severity === 'error')) return 'Fix the errors in the pattern first';
  return null;
}

/** Builds the PDF and opens it in a new tab (where the system print dialog is one click away). */
export async function printPattern(pattern: PatternDoc): Promise<void> {
  // Open the tab now, inside the click, so no popup blocker stops it; fill it when the PDF is ready.
  const tab = window.open('', '_blank');
  try {
    const blob = await buildPdf(pattern, { paper: navigator.language === 'en-US' ? 'letter' : 'a4' });
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    notify.error(`Could not make the PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}
