import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import { createDistributedRunMonitorIndex, type DistributedRunMonitorIndex } from './distributed-run-monitor-index.ts';
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
import {
    computeDistributedRunMonitorDerivationWork,
    recordDistributedRunMonitorDerivation,
    type DistributedRunMonitorDerivationWork
} from './distributed-run-observation/distributed-run-monitor-derivation-work.ts';
import { createDistributedRunMonitorFailureIndex } from './distributed-run-observation/distributed-run-monitor-failure-index.ts';
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

interface MonitorEvidence {
    readonly events: readonly DistributedRunEventRow[];
    readonly eventsByAgentId: ReadonlyMap<string, readonly DistributedRunEventRow[]>;
    readonly compositeDrilldowns: readonly DistributedRunCompositeDrilldown[];
    readonly failures: readonly DistributedRunFailureRow[];
    readonly runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    readonly timeline: readonly DistributedRunTimelineItem[];
    readonly work: readonly Partial<DistributedRunMonitorDerivationWork>[];
}

export function deriveDistributedRunMonitor(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun?: ControlRunSnapshot;
        artifactBundle?: ControlDistributedRunArtifactBundle;
        artifactValidation?: DistributedRunArtifactValidation;
    }>
): DistributedRunMonitor {
    const index = createDistributedRunMonitorIndex(input);
    const evidence = toMonitorEvidence(input.distributedRun, index);
    const agentProgress = computeDistributedRunAgentProgress({ index, eventsByAgentId: evidence.eventsByAgentId });
    const recipeProgress = computeDistributedRunRecipeProgress(index);
    const readiness = computeDistributedRunReadiness(index);

    const monitor: DistributedRunMonitor = {
        distributedRunId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        commandCounts: index.commandCounts,
        resultCounts: index.resultCounts,
        compositeCounts: computeDistributedRunCompositeCounts(evidence.compositeDrilldowns),
        diagnosticCounts: computeDistributedRunRuntimeDiagnosticCounts(evidence.runtimeDiagnostics),
        latency: computeDistributedRunLatencySummary(index.latencies),
        artifact: input.artifactValidation ?? validateDistributedRunArtifact(input.artifactBundle),
        timeline: evidence.timeline,
        agentProgress: agentProgress.rows,
        recipeProgress: recipeProgress.rows,
        readiness: readiness.rows,
        failures: evidence.failures,
        events: evidence.events,
        runtimeDiagnostics: evidence.runtimeDiagnostics,
        compositeDrilldowns: evidence.compositeDrilldowns
    };
    recordDistributedRunMonitorDerivation({
        monitor,
        distributedRun: input.distributedRun,
        firstCommandPhasesById: index.firstCommandPhasesById,
        work: computeDistributedRunMonitorDerivationWork([
            { monitorDerivationCount: 1 },
            index.work,
            ...evidence.work,
            agentProgress.work,
            recipeProgress.work,
            readiness.work
        ])
    });
    return monitor;
}

/** The linked events, failures, diagnostics and timeline the monitor shows, with the visits each projection made. */
function toMonitorEvidence(
    distributedRun: ControlDistributedRunSnapshot,
    index: DistributedRunMonitorIndex
): MonitorEvidence {
    const events = toDistributedRunEventRows(index.linkedControlEvents);
    const eventsByAgent = toDistributedRunEventsByAgent(events);
    const compositeDrilldowns = toDistributedRunCompositeDrilldowns(
        index.linkedResults,
        index.commandsById,
        index.linksByCommandId
    );
    const failures = toMonitorFailures(distributedRun, index, compositeDrilldowns);
    const failureIndex = createDistributedRunMonitorFailureIndex(failures);
    const diagnostics = toCorrelatedDistributedRunRuntimeDiagnostics(
        toDistributedRunRuntimeDiagnosticRows(index.linkedControlEvents),
        failureIndex
    );
    const timeline = toDistributedRunTimeline({
        distributedRun,
        commandLinks: index.commandLinks,
        commands: index.commandsById,
        results: index.linkedResults,
        events,
        runtimeDiagnostics: diagnostics.rows,
        failures
    });
    return {
        events,
        eventsByAgentId: eventsByAgent.eventsByAgentId,
        compositeDrilldowns,
        failures,
        runtimeDiagnostics: diagnostics.rows,
        timeline: timeline.items,
        work: [
            eventsByAgent.work,
            { failureIndexVisitCount: failureIndex.failureVisitCount },
            { diagnosticFailureCandidateVisitCount: diagnostics.failureCandidateVisitCount },
            timeline.work
        ]
    };
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
