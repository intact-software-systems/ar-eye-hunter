import type { DistributedRunPerformanceAnalysis, DistributedRunSnapshots } from '../distributed-artifact-analysis.ts';
import { toControlEventEvidence } from '../distributed-artifact-analysis/decode-distributed-run-event-evidence.ts';
import { computeDistributedRunPerformance } from './compute-distributed-run-performance.ts';

/** Performance from the snapshots alone: no fleet report, no results.jsonl rows, and the control run's events. */
export function computeDistributedRunSnapshotPerformance(
    snapshots: DistributedRunSnapshots
): DistributedRunPerformanceAnalysis {
    return computeDistributedRunPerformance({
        ...snapshots,
        results: [],
        events: snapshots.controlRun.events.map(toControlEventEvidence)
    });
}
