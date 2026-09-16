import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunFailureAnalysis } from '../distributed-artifact-analysis.ts';
import {
    computeStreamInFlightLimitDropCount,
    hasStreamFailureEvidence,
    toEventStreamTimingSample,
    toResultStreamTimingSamples,
    type StreamTimingSample
} from '../distributed-run-performance/to-stream-timing-samples.ts';
import type { DistributedRunEventEvidence } from './decode-distributed-run-event-evidence.ts';
import type { DistributedRunResultEvidence } from './decode-distributed-run-result-evidence.ts';
import {
    isStreamFailureText,
    resolveMinimalFixArea,
    resolveVerificationCommand,
    TERMINAL_FAILURE_STATES,
    toAffectedAgents
} from './distributed-run-failure-vocabulary.ts';

interface StreamFailureCandidate {
    readonly sample: StreamTimingSample;
    /** Absent when neither the row nor the sample names the agent. */
    readonly agentId?: string;
    readonly evidenceFile: string;
}

const STREAM_PERFORMANCE_FIX_AREA = 'RTC stream pacing/performance';
const STREAM_FAILED_TOPIC = 'rallar.bb.rtc.stream_failed';

/** Absent when no result or stream event shows a stream that failed or crossed a threshold. */
export function computeStreamPerformanceFailure(
    results: readonly DistributedRunResultEvidence[],
    events: readonly DistributedRunEventEvidence[]
): DistributedRunFailureAnalysis | undefined {
    const candidate = [...toResultFailureCandidates(results), ...toEventFailureCandidates(events)]
        .find((entry) => hasStreamFailureEvidence(entry.sample));
    if (!candidate) {
        return undefined;
    }
    const { summary } = candidate.sample;
    const commandId = candidate.sample.commandId ?? summary.commandId;
    const frames = summary.plannedFrames !== undefined
        ? `${summary.completedFrames ?? 0}/${summary.plannedFrames} frames`
        : `${summary.completedFrames ?? 0} frames`;
    const details = [
        `completed ${frames}`,
        `dropped ${summary.droppedFrames ?? 0}`,
        `in-flight limit drops ${computeStreamInFlightLimitDropCount(candidate.sample)}`,
        summary.maxStartDriftMs !== undefined ? `max drift ${summary.maxStartDriftMs}ms` : undefined,
        summary.lateFrameCount !== undefined ? `late frames ${summary.lateFrameCount}` : undefined,
        summary.duration?.p99Ms !== undefined ? `p99 ${summary.duration.p99Ms}ms` : undefined
    ].filter((value): value is string => value !== undefined);
    return {
        category: 'rtc-stream-performance',
        title: 'RTC stream pacing/backlog threshold failed.',
        likelyCause: `RTC stream ${commandId ?? 'unknown-stream'} exceeded pacing/backlog thresholds: ${
            details.join(', ')
        }.`,
        nextAction:
            'Reduce green-suite stream rate/load or inspect stream progress, in-flight drops, send duration percentiles, and RTC diagnostics for affected agents.',
        minimalFixArea: STREAM_PERFORMANCE_FIX_AREA,
        verificationCommand: resolveVerificationCommand(STREAM_PERFORMANCE_FIX_AREA),
        affectedAgents: toAffectedAgents(candidate.agentId ?? candidate.sample.agentId),
        affectedRegions: [],
        commandId,
        evidenceFile: candidate.evidenceFile
    };
}

/** Absent unless a failed, timed-out or cancelled run ends while its last stream event is progress or start. */
export function computeStreamTimeoutFailure(
    distributedRun: ControlDistributedRunSnapshot,
    events: readonly DistributedRunEventEvidence[]
): DistributedRunFailureAnalysis | undefined {
    if (!TERMINAL_FAILURE_STATES.has(distributedRun.state)) {
        return undefined;
    }
    const streamEvent = [...events].reverse().find((event) =>
        event.topic === 'rallar.bb.rtc.stream_progress' || event.topic === 'rallar.bb.rtc.stream_started'
    );
    if (!streamEvent) {
        return undefined;
    }
    const summary = streamEvent.streamSummary;
    const commandId = streamEvent.commandId ?? summary?.commandId;
    const completedFrames = summary?.completedFrames ?? 0;
    const frameSummary = summary?.plannedFrames !== undefined
        ? `${completedFrames} of ${summary.plannedFrames} completed frames`
        : `${completedFrames} completed frames`;
    const likelyCause = `RTC stream ${commandId ?? 'unknown-stream'} reached ${frameSummary} before the run stopped.`;
    const minimalFix = resolveMinimalFixArea({
        category: 'rtc-stream',
        transport: streamEvent.transport,
        text: likelyCause
    });
    return {
        category: 'rtc-stream',
        title: 'RTC stream did not finish before the distributed run timed out.',
        likelyCause,
        nextAction:
            'Inspect stream progress, send duration percentiles, in-flight frames, and RTC diagnostics for the affected agent.',
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(streamEvent.agentId),
        affectedRegions: [],
        commandId,
        evidenceFile: 'events.jsonl'
    };
}

function toResultFailureCandidates(
    results: readonly DistributedRunResultEvidence[]
): readonly StreamFailureCandidate[] {
    return results.flatMap((result) =>
        toResultStreamTimingSamples(result)
            .filter(hasStreamFailureEvidence)
            .map((sample) => ({ sample, agentId: result.agentId ?? sample.agentId, evidenceFile: 'results.jsonl' }))
    );
}

function toEventFailureCandidates(events: readonly DistributedRunEventEvidence[]): readonly StreamFailureCandidate[] {
    return events.flatMap((event) => {
        const failureText = [event.topic, event.commandId, event.message, event.streamSummaryText ?? '{}']
            .filter(Boolean)
            .join(' ');
        const sample = event.topic === STREAM_FAILED_TOPIC || isStreamFailureText(failureText)
            ? toEventStreamTimingSample(event)
            : undefined;
        return sample === undefined ? [] : [{ sample, agentId: event.agentId, evidenceFile: 'events.jsonl' }];
    });
}
