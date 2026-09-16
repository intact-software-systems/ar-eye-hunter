import type { DistributedRunPerformanceAnalysis, DistributedRunSnapshots } from '../distributed-artifact-analysis.ts';
import { decodeElapsedMs } from '../distributed-artifact-analysis/decode-artifact-json-values.ts';
import {
    decodeDistributedRunEventEvidence,
    type DistributedRunEventEvidence
} from '../distributed-artifact-analysis/decode-distributed-run-event-evidence.ts';
import {
    decodeDistributedRunFleetReportEvidence,
    type DistributedRunFleetReportEvidence
} from '../distributed-artifact-analysis/decode-distributed-run-report-evidence.ts';
import {
    decodeDistributedRunResultEvidence,
    type DistributedRunResultEvidence
} from '../distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import { computeCommandTimingSamples, computeSlowestAgents } from './compute-command-timing.ts';
import { computeReceiverDelivery } from './compute-receiver-delivery.ts';
import { computeStreamTimingSamples } from './compute-stream-timing-samples.ts';
import { computeStreamTiming } from './compute-stream-timing.ts';
import { computeTimingSummary } from './compute-timing-summary.ts';

export interface DistributedRunPerformanceInput extends DistributedRunSnapshots {
    readonly fleetReport: DistributedRunFleetReportEvidence;
    /** The results.jsonl rows, which outrank control results describing the same stream. */
    readonly results: readonly DistributedRunResultEvidence[];
    readonly events: readonly DistributedRunEventEvidence[];
}

/** Performance from the snapshots alone: no fleet report, no results.jsonl rows, and the control run's events. */
export function computeDistributedRunSnapshotPerformance(
    snapshots: DistributedRunSnapshots
): DistributedRunPerformanceAnalysis {
    return computeDistributedRunPerformance({
        ...snapshots,
        fleetReport: decodeDistributedRunFleetReportEvidence({}),
        results: [],
        events: snapshots.controlRun.events.map(decodeDistributedRunEventEvidence)
    });
}

export function computeDistributedRunPerformance(
    input: DistributedRunPerformanceInput
): DistributedRunPerformanceAnalysis {
    const { distributedRun, controlRun, fleetReport, events } = input;
    const controlResults = controlRun.results.map(decodeDistributedRunResultEvidence);
    const commandTimingSamples = computeCommandTimingSamples({
        distributedRun,
        commands: controlRun.commands,
        controlResults
    });
    const streamSamples = computeStreamTimingSamples({ controlResults, jsonlResults: input.results, events }).samples;
    const { agents } = controlRun;
    return {
        runDurationMs: decodeElapsedMs(distributedRun.startedAtEpochMs, distributedRun.completedAtEpochMs) ??
            fleetReport.runP50Ms,
        agentCount: fleetReport.agents ?? agents.length,
        passRate: fleetReport.passRate ?? (distributedRun.rollup.ok ? 1 : 0),
        reconnectCount: agents.reduce((sum, agent) => sum + agent.reconnectCount, 0),
        diagnosticCount: countEventSeverity(events, 'warning') + countEventSeverity(events, 'error'),
        warningDiagnosticCount: countEventSeverity(events, 'warning'),
        errorDiagnosticCount: countEventSeverity(events, 'error'),
        exportedEventCount: events.length,
        agentReportedEventCount: agents.reduce((sum, agent) => sum + agent.receivedEventCount, 0),
        failedAgentCount: fleetReport.failedAgents ?? distributedRun.rollup.summary.failedParticipants,
        missingAgentCount: fleetReport.missingAgents ?? 0,
        staleAgentCount: fleetReport.staleAgents ?? 0,
        flakyAgentCount: fleetReport.flakyAgents ?? 0,
        commandTiming: computeTimingSummary(
            fleetReport.commandTiming,
            commandTimingSamples.map((sample) => sample.durationMs)
        ),
        streamTiming: computeStreamTiming(streamSamples),
        receiverDelivery: computeReceiverDelivery({ distributedRun, controlResults, jsonlResults: input.results }),
        slowestAgents: computeSlowestAgents(commandTimingSamples)
    };
}

function countEventSeverity(events: readonly DistributedRunEventEvidence[], severity: string): number {
    return events.filter((event) => event.severity === severity).length;
}
