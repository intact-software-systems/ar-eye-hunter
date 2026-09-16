import type {
    DistributedRunFailedAnalysis,
    DistributedRunLowestReceiver,
    DistributedRunPerformanceAnalysis,
    DistributedRunReceiverDelivery,
    DistributedRunStreamTiming,
    DistributedRunTimingSummary
} from '../distributed-artifact-analysis.ts';
import { toRoundedMetric } from '../distributed-run-performance/compute-timing-summary.ts';
import type { DistributedRunAnalysisFacts } from './compute-distributed-run-artifact-pipeline-analysis.ts';

export function toDistributedRunSummaryMarkdown(analysis: DistributedRunAnalysisFacts): string {
    const { targetResolution } = analysis;
    return toMarkdown([
        `# Distributed Run Analysis: ${analysis.distributedRunId}`,
        '',
        `State: ${analysis.status}`,
        `Result: ${analysis.ok ? 'passed' : 'failed'}`,
        analysis.controlRunId ? `Control run: ${analysis.controlRunId}` : undefined,
        analysis.group?.groupId ? `Group: ${analysis.group.groupId}` : undefined,
        `Agents: ${analysis.summary.agents ?? 'unknown'}`,
        targetResolution
            ? `Targets: ${targetResolution.selected}/${
                targetResolution.expectedParticipantCount ?? 'unspecified'
            } resolved`
            : undefined,
        targetResolution ? `Target blockers: ${targetResolution.blockers}` : undefined,
        `Pass rate: ${toPercent(analysis.summary.passRate)}`,
        `Failure groups: ${analysis.summary.failureGroups}`,
        `Artifact warnings: ${analysis.parseWarnings.length}`,
        analysis.performance === undefined
            ? 'Performance: not analyzed, because it needs the control run snapshot that control-run.json records.'
            : undefined,
        analysis.spa === undefined
            ? 'SPA report and verdict: not analyzed, because they need the control run snapshot that control-run.json records.'
            : undefined,
        analysis.ok ? undefined : `First focus: ${analysis.failure.title}`,
        ''
    ]);
}

export function toDistributedRunFixProposalMarkdown(
    analysis: Omit<DistributedRunFailedAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'>
): string {
    const { failure } = analysis;
    return toMarkdown([
        `# Fix Proposal: ${analysis.distributedRunId}`,
        '',
        `Status: ${analysis.status}`,
        `Title: ${failure.title}`,
        `Category: ${failure.category}`,
        `Likely cause: ${failure.likelyCause}`,
        `Next action: ${failure.nextAction}`,
        `Minimal fix area: ${failure.minimalFixArea}`,
        failure.affectedAgents.length > 0 ? `Affected agents: ${failure.affectedAgents.join(', ')}` : undefined,
        failure.affectedRegions.length > 0 ? `Affected regions: ${failure.affectedRegions.join(', ')}` : undefined,
        failure.commandId ? `Command: ${failure.commandId}` : undefined,
        failure.recipeId ? `Recipe: ${failure.recipeId}` : undefined,
        `Evidence: ${failure.evidenceFile}`,
        '',
        'Suggested verification:',
        failure.verificationCommand,
        ''
    ]);
}

export function toDistributedRunPerformanceMarkdown(
    distributedRunId: string,
    performance: DistributedRunPerformanceAnalysis
): string {
    return toMarkdown([
        `# Performance: ${distributedRunId}`,
        '',
        `Pass rate: ${toPercent(performance.passRate)}`,
        performance.runDurationMs !== undefined ? `Run duration: ${performance.runDurationMs}ms` : undefined,
        `Agents: ${performance.agentCount}`,
        `Reconnects: ${performance.reconnectCount}`,
        `Diagnostics: ${performance.diagnosticCount}`,
        `Warning diagnostics: ${performance.warningDiagnosticCount}`,
        `Error diagnostics: ${performance.errorDiagnosticCount}`,
        `Exported events: ${performance.exportedEventCount}`,
        `Agent-reported events: ${performance.agentReportedEventCount}`,
        `Failed agents: ${performance.failedAgentCount}`,
        `Missing agents: ${performance.missingAgentCount ?? 'unknown'}`,
        `Stale agents: ${performance.staleAgentCount ?? 'unknown'}`,
        `Flaky agents: ${performance.flakyAgentCount ?? 'unknown'}`,
        toCommandTimingLine(performance.commandTiming),
        ...(performance.streamTiming ? toStreamTimingLines(performance.streamTiming) : []),
        performance.receiverDelivery ? toReceiverDeliveryLine(performance.receiverDelivery) : undefined,
        performance.slowestAgents.length > 0
            ? `Slowest agents: ${
                performance.slowestAgents.map((agent) =>
                    `${agent.agentId} max=${toMilliseconds(agent.maxMs)} avg=${toMilliseconds(agent.averageMs)}`
                ).join(', ')
            }`
            : undefined,
        ''
    ]);
}

function toCommandTimingLine(timing: DistributedRunTimingSummary): string {
    return `Command timing: count=${timing.count ?? 'unknown'}, min=${toMilliseconds(timing.minMs)}, p50=${
        toMilliseconds(timing.p50Ms)
    }, p95=${toMilliseconds(timing.p95Ms)}, p99=${toMilliseconds(timing.p99Ms)}, max=${
        toMilliseconds(timing.maxMs)
    }, avg=${toMilliseconds(timing.averageMs)}, outliers=${timing.outlierCount ?? 'unknown'}`;
}

function toStreamTimingLines(timing: DistributedRunStreamTiming): readonly string[] {
    const frames = `streams=${timing.streamCount}, frames=${timing.completedFrames}/${timing.plannedFrames}, ` +
        `attempted=${timing.attemptedFrames}, failed=${timing.failedFrames}, dropped=${timing.droppedFrames}, ` +
        `in-flight drops=${timing.inFlightLimitDropCount}, backpressure=${timing.backpressureCount}`;
    const pacing = `max drift=${toMilliseconds(timing.maxStartDriftMs)}, late frames=${timing.lateFrameCount}, ` +
        `p50=${toMilliseconds(timing.duration.p50Ms)}, p95=${toMilliseconds(timing.duration.p95Ms)}, ` +
        `p99=${toMilliseconds(timing.duration.p99Ms)}, max=${toMilliseconds(timing.duration.maxMs)}, ` +
        `achieved=${toRate(timing.achievedCompletionHz)}`;
    const disposition = `streams=${timing.streamCount}, planned=${timing.plannedFrames}, ` +
        `completed=${timing.completedFrames}, failed=${timing.failedFrames}, dropped=${timing.droppedFrames}, ` +
        `in-flight drops=${timing.inFlightLimitDropCount}`;
    return [
        `Stream timing: ${frames}, ${pacing}`,
        `Frame disposition: ${disposition}`,
        ...(timing.slowestAgents.length > 0
            ? [
                `Slowest stream agents: ${
                    timing.slowestAgents.map((agent) =>
                        `${agent.agentId} max=${toMilliseconds(agent.maxMs)} p99=${toMilliseconds(agent.p99Ms)}`
                    ).join(', ')
                }`
            ]
            : [])
    ];
}

function toReceiverDeliveryLine(delivery: DistributedRunReceiverDelivery): string {
    return `Receiver delivery: receivers=${delivery.sampleCount}, expected=${
        delivery.expectedInboundMessages ?? 'unknown'
    }, min required=${delivery.minExpectedInboundMessages ?? 'unknown'}, min=${
        delivery.minReceivedMessages ?? 'unknown'
    }, median=${delivery.medianReceivedMessages ?? 'unknown'}, p95=${
        delivery.p95ReceivedMessages ?? 'unknown'
    }, lowest=${toLowestReceiverText(delivery.lowestAgents[0])}`;
}

function toLowestReceiverText(agent: DistributedRunLowestReceiver | undefined): string {
    if (!agent) {
        return 'none';
    }
    const expected = agent.expectedInboundMessages ?? 'unknown';
    const ratio = agent.deliveryRatio === undefined ? 'unknown' : toPercent(agent.deliveryRatio);
    return `${agent.agentId} ${agent.receivedMessages}/${expected} (${ratio})`;
}

function toMarkdown(lines: readonly (string | undefined)[]): string {
    return lines.filter((line): line is string => line !== undefined).join('\n');
}

function toPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function toMilliseconds(value: number | undefined): string {
    return value === undefined ? '-' : `${Math.round(value)}ms`;
}

function toRate(value: number | undefined): string {
    return value === undefined ? '-' : `${toRoundedMetric(value)}Hz`;
}
