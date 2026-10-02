// Track T6.3 — the live loop's state for the UI (status strip, Rounds panel): not ready / working / up to date /
// failed, compared with the hash of the document as it is now (DESIGN.md §4.3).
import { useMemo } from 'react';
import { derivedStore, useDerivedStore } from '../../state/derivedStore';
import { useProjectStore } from '../../state/projectStore';
import { amiInputs, loopStatus } from './liveLoop';

/** The loop's state as the UI words it (status strip, rounds panel). */
export function useLoopStatus() {
  const doc = useProjectStore((s) => s.doc);
  const hash = useMemo(() => amiInputs(doc)?.hash ?? null, [doc]);
  const job = useDerivedStore((s) => s.jobs.ami);
  const entry = useDerivedStore((s) => s.ami);
  return useMemo(() => loopStatus(derivedStore.getState(), hash), [job, entry, hash]); // eslint-disable-line react-hooks/exhaustive-deps
}
