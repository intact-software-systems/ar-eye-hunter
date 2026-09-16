import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import {
    createDistributedRunMonitorFailureIndex,
    createDistributedRunMonitorIndex,
    setDistributedRunMonitorDerivation,
    type DistributedRunMonitorIndex
} from './distributed-run-monitor-index.ts';
import { computeDistributedRunAgentProgress } from './distributed-run-observation/compute-distributed-run-agent-progress.ts';
import { computeDistributedRunReadiness } from './distributed-run-observation/compute-distributed-run-readiness.ts';
import { computeDistributedRunRecipeProgress } from './distributed-run-observation/compute-distributed-run-recipe-progress.ts';
import {
    computeDistributedRunCompositeCounts,
    toDistributedRunCompositeDrilldowns,
    toDistributedRunCompositeFailures
} from './distributed-run-observation/distributed-run-composite-drilldowns.ts';
import {
    toDistributedRunEventRows,
    toDistributedRunEventsByAgent
} from './distributed-run-observation/distributed-run-event-rows.ts';
import { toDistributedRunFailureRows } from './distributed-run-observation/distributed-run-failure-rows.ts';
import { computeDistributedRunLatencySummary } from './distributed-run-observation/distributed-run-latency-summary.ts';
import type {
    DistributedRunAgentProgressRow,
    DistributedRunArtifactValidation,
    DistributedRunCompositeCounts,
    DistributedRunCompositeDrilldown,
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunLatencySummary,
    DistributedRunReadinessRow,
    DistributedRunRecipeProgressRow,
    DistributedRunRuntimeDiagnosticCounts,
    DistributedRunRuntimeDiagnosticRow,
    DistributedRunTimelineItem
} from './distributed-run-observation/distributed-run-row-contracts.ts';
import {
    computeDistributedRunRuntimeDiagnosticCounts,
    toCorrelatedDistributedRunRuntimeDiagnostics,
    toDistributedRunRuntimeDiagnosticRows
} from './distributed-run-observation/distributed-run-runtime-diagnostic-rows.ts';
import { toDistributedRunTimeline } from './distributed-run-observation/to-distributed-run-timeline.ts';
import { validateDistributedRunArtifact } from './distributed-run-observation/validate-distributed-run-artifact.ts';

export type DistributedRunMonitor = Readonly<{
    distributedRunId: string;
    state: string;
    commandCounts: Readonly<{
        total: number;
        stage: number;
        barrier: number;
        start: number;
        cancel: number;
        completed: number;
        failed: number;
        pending: number;
    }>;
    resultCounts: Readonly<{
        total: number;
        ok: number;
        failed: number;
    }>;
    compositeCounts: DistributedRunCompositeCounts;
    diagnosticCounts: DistributedRunRuntimeDiagnosticCounts;
    latency: DistributedRunLatencySummary;
    artifact: DistributedRunArtifactValidation;
    timeline: readonly DistributedRunTimelineItem[];
    agentProgress: readonly DistributedRunAgentProgressRow[];
    recipeProgress: readonly DistributedRunRecipeProgressRow[];
    readiness: readonly DistributedRunReadinessRow[];
    failures: readonly DistributedRunFailureRow[];
    events: readonly DistributedRunEventRow[];
    runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    compositeDrilldowns: readonly DistributedRunCompositeDrilldown[];
}>;

export function deriveDistributedRunMonitor(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun?: ControlRunSnapshot;
        artifactBundle?: ControlDistributedRunArtifactBundle;
        artifactValidation?: DistributedRunArtifactValidation;
    }>
): DistributedRunMonitor {
    const index = createDistributedRunMonitorIndex(input);
    const linkedEvents = toDistributedRunEventRows(index.linkedControlEvents);
    const eventsByAgentId = toDistributedRunEventsByAgent(linkedEvents, index);
    const compositeDrilldowns = toDistributedRunCompositeDrilldowns(
        index.linkedResults,
        index.commandsById,
        index.linksByCommandId
    );
    const failures = toMonitorFailures(input.distributedRun, index, compositeDrilldowns);
    const runtimeDiagnostics = toCorrelatedDistributedRunRuntimeDiagnostics(
        toDistributedRunRuntimeDiagnosticRows(index.linkedControlEvents),
        createDistributedRunMonitorFailureIndex(failures, index)
    );
    const artifact = input.artifactValidation ??
        validateDistributedRunArtifact(input.artifactBundle);

    const monitor: DistributedRunMonitor = {
        distributedRunId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        commandCounts: index.commandCounts,
        resultCounts: index.resultCounts,
        compositeCounts: computeDistributedRunCompositeCounts(compositeDrilldowns),
        diagnosticCounts: computeDistributedRunRuntimeDiagnosticCounts(runtimeDiagnostics),
        latency: computeDistributedRunLatencySummary(index.latencies),
        artifact,
        timeline: toDistributedRunTimeline({
            distributedRun: input.distributedRun,
            index,
            commands: index.commandsById,
            results: index.linkedResults,
            events: linkedEvents,
            runtimeDiagnostics,
            failures
        }),
        agentProgress: computeDistributedRunAgentProgress({ index, eventsByAgentId }),
        recipeProgress: computeDistributedRunRecipeProgress({ index }),
        readiness: computeDistributedRunReadiness({ index }),
        failures,
        events: linkedEvents,
        runtimeDiagnostics,
        compositeDrilldowns
    };
    setDistributedRunMonitorDerivation(monitor, index, input.distributedRun);
    return monitor;
}

/** Recorded rollup failures and composite child failures share one newest-first order. */
function toMonitorFailures(
    distributedRun: ControlDistributedRunSnapshot,
    index: DistributedRunMonitorIndex,
    compositeDrilldowns: readonly DistributedRunCompositeDrilldown[]
): readonly DistributedRunFailureRow[] {
    return [
        ...toDistributedRunFailureRows(distributedRun, index.linkedResults, index.commandsById),
        ...toDistributedRunCompositeFailures(compositeDrilldowns)
    ].sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
}
