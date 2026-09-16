import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import {
    createDistributedRunMonitorFailureIndex,
    createDistributedRunMonitorIndex,
    recordDistributedRunMonitorDerivation
} from './distributed-run-monitor-index.ts';
import { distributedRunAgentProgress } from './distributed-run-observation/distributed-run-agent-progress.ts';
import {
    distributedRunCompositeCounts,
    distributedRunCompositeDrilldowns,
    distributedRunCompositeFailures
} from './distributed-run-observation/distributed-run-composite-drilldowns.ts';
import {
    distributedRunEvents,
    distributedRunEventsByAgent
} from './distributed-run-observation/distributed-run-event-rows.ts';
import { distributedRunFailures } from './distributed-run-observation/distributed-run-failure-rows.ts';
import { summarizeDistributedRunLatencies } from './distributed-run-observation/distributed-run-latency-summary.ts';
import { distributedRunReadiness } from './distributed-run-observation/distributed-run-readiness.ts';
import { distributedRunRecipeProgress } from './distributed-run-observation/distributed-run-recipe-progress.ts';
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
    correlateDistributedRunRuntimeDiagnostics,
    distributedRunRuntimeDiagnosticCounts,
    distributedRunRuntimeDiagnostics
} from './distributed-run-observation/distributed-run-runtime-diagnostic-rows.ts';
import { distributedRunTimeline } from './distributed-run-observation/distributed-run-timeline.ts';
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
    const linkedEvents = distributedRunEvents(index.linkedControlEvents);
    const eventsByAgentId = distributedRunEventsByAgent(linkedEvents, index);
    const compositeDrilldowns = distributedRunCompositeDrilldowns(
        index.linkedResults,
        index.commandsById,
        index.linksByCommandId
    );
    const failures = toMonitorFailures(input.distributedRun, index, compositeDrilldowns);
    const runtimeDiagnostics = correlateDistributedRunRuntimeDiagnostics(
        distributedRunRuntimeDiagnostics(index.linkedControlEvents),
        createDistributedRunMonitorFailureIndex(failures, index)
    );
    const artifact = input.artifactValidation ??
        validateDistributedRunArtifact(input.artifactBundle);

    const monitor: DistributedRunMonitor = {
        distributedRunId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        commandCounts: index.commandCounts,
        resultCounts: index.resultCounts,
        compositeCounts: distributedRunCompositeCounts(compositeDrilldowns),
        diagnosticCounts: distributedRunRuntimeDiagnosticCounts(runtimeDiagnostics),
        latency: summarizeDistributedRunLatencies(index.latencies),
        artifact,
        timeline: distributedRunTimeline({
            distributedRun: input.distributedRun,
            index,
            commands: index.commandsById,
            results: index.linkedResults,
            events: linkedEvents,
            runtimeDiagnostics,
            failures,
            artifact
        }),
        agentProgress: distributedRunAgentProgress({ index, eventsByAgentId }),
        recipeProgress: distributedRunRecipeProgress({ index }),
        readiness: distributedRunReadiness({ index }),
        failures,
        events: linkedEvents,
        runtimeDiagnostics,
        compositeDrilldowns
    };
    recordDistributedRunMonitorDerivation(monitor, index, input.distributedRun);
    return monitor;
}

/** Recorded rollup failures and composite child failures share one newest-first order. */
function toMonitorFailures(
    distributedRun: ControlDistributedRunSnapshot,
    index: ReturnType<typeof createDistributedRunMonitorIndex>,
    compositeDrilldowns: readonly DistributedRunCompositeDrilldown[]
): readonly DistributedRunFailureRow[] {
    return [
        ...distributedRunFailures(distributedRun, index.linkedResults, index.commandsById),
        ...distributedRunCompositeFailures(compositeDrilldowns)
    ].sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
}
