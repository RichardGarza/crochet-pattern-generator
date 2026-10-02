// Track T2.3 — the chart of the open 2D project, for the Source and Chart tabs (DESIGN.md F1 step 4, §5.4): every
// settings change recomputes it in the chart2d worker, debounced 250 ms, latest-wins; the tabs show the last result
// (dimmed while a newer one is computed) and the job's state.
import { useEffect } from 'react';
import { useProjectStore, projectStore } from '../../state/projectStore';
import { jobOf, useDerivedStore, type JobState } from '../../state/derivedStore';
import { chartInputHash, runChartJob, twoDOf, useTwoDUi } from '../../state/slices/twoD';
import type { ChartResult } from '../../types';

export const CHART_DEBOUNCE_MS = 250;

/** Starts the chart job for the current inputs (call once per mounted tab; jobs for equal inputs are joined). */
export function useChartJob(): void {
  const hash = useProjectStore((s) => (s.doc ? chartInputHash(s.doc) : null));
  useEffect(() => {
    if (!hash) return undefined;
    const t = setTimeout(() => {
      const doc = projectStore.getState().doc;
      if (doc && chartInputHash(doc) === hash) void runChartJob(doc);
    }, CHART_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [hash]);
}

export interface ChartView {
  /** The last chart computed for this project (maybe for older inputs). */
  result: ChartResult | null;
  /** The result belongs to the current inputs. */
  fresh: boolean;
  job: JobState;
  engine: 'unknown' | 'ready' | 'unavailable';
  /** The project has a picture and chart settings. */
  ready: boolean;
}

export function useChartView(): ChartView {
  const hash = useProjectStore((s) => (s.doc ? chartInputHash(s.doc) : null));
  const ready = useProjectStore((s) => !!twoDOf(s.doc));
  const entry = useDerivedStore((s) => s.chart);
  const job = useDerivedStore((s) => jobOf(s, 'chart'));
  const engine = useTwoDUi((s) => s.engine);
  return { result: entry?.value ?? null, fresh: !!entry && entry.inputHash === hash, job, engine, ready };
}
