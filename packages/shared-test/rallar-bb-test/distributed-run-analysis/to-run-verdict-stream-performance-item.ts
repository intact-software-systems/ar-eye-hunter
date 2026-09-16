import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';
import { compactStrings } from './compact-strings.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis-report.ts';
import type { RunCausalTrailItem } from './run-verdict-causal-trail.ts';
import { isRtcStreamPerformanceFailureText } from './to-distributed-failure-explanation.ts';

export function toRunVerdictStreamPerformanceItem(
    input: Readonly<{
        report: DistributedRunAnalysisReport;
        monitor: DistributedRunMonitor;
        firstFailure: NonNullable<DistributedRunAnalysisReport['firstFailure']>;
        firstActionCategory?: DistributedRunAnalysisReport['nextActions'][number]['category'];
        eventEvidence: readonly string[];
    }>
): RunCausalTrailItem | undefined {
    const streamPerformanceEvent = input.monitor.events.find((event) =>
        isRtcStreamPerformanceFailureText(`${event.topic ?? ''} ${event.summary} ${event.payloadSummary}`)
    );
    const isStreamPerformanceFailure = input.firstActionCategory === 'rtc-stream-performance' ||
        isRtcStreamPerformanceFailureText(`${input.firstFailure.code ?? ''} ${input.firstFailure.message}`);
    if (!isStreamPerformanceFailure) {
        return undefined;
    }

    const streamAgentId = input.firstFailure.agentId ?? streamPerformanceEvent?.agentId;
    const streamCommandId = input.firstFailure.commandId ?? streamPerformanceEvent?.commandId;
    const streamEventEvidence = input.eventEvidence.length > 0
        ? input.eventEvidence
        : streamPerformanceEvent
        ? [streamPerformanceEvent.eventId]
        : [];
    return {
        kind: 'stream-performance',
        label: 'Stream pacing evidence',
        detail:
            'Check frame disposition, in-flight drops, max start drift, late frames, and stream P95/P99 before changing RTC routing or recipe thresholds.',
        tone: 'bad',
        targetKind: streamCommandId ? 'command' : 'agent',
        targetId: streamCommandId ?? streamAgentId,
        actionLabel: 'Inspect stream pacing',
        agentId: streamAgentId,
        recipeId: input.firstFailure.recipeId,
        commandId: streamCommandId,
        atEpochMs: input.firstFailure.atEpochMs,
        evidence: compactStrings([
            streamCommandId,
            streamAgentId,
            input.firstFailure.code,
            ...streamEventEvidence.slice(0, 3)
        ])
    };
}
