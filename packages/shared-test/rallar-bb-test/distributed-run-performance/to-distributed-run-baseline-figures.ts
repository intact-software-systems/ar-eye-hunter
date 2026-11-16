import type { SameRegimeComparison } from '../../../shared/measurement/compute-same-regime-comparison.ts';
import type { DistributedRunPerformanceAnalysis } from '../distributed-artifact-analysis.ts';

/** Declared before any baseline run; a run that falls outside it is investigated, never answered by widening it. */
export const DISTRIBUTED_RUN_LOCAL_BASELINE_BAND: SameRegimeComparison.Band = { relative: 0.1, absolute: 5 };

export function toDistributedRunBaselineFigures(
    analysis: DistributedRunPerformanceAnalysis
): Readonly<Record<string, number>> {
    const { commandTiming, runDurationMs } = analysis;
    const figures: Readonly<Record<string, number | undefined>> = {
        'commandTiming.p50Ms': commandTiming.p50Ms,
        'commandTiming.p95Ms': commandTiming.p95Ms,
        'commandTiming.p99Ms': commandTiming.p99Ms,
        runDurationMs
    };
    return Object.fromEntries(
        Object.entries(figures).filter((entry): entry is [string, number] => entry[1] !== undefined)
    );
}
