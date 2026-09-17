import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunFailureAnalysis } from '../distributed-artifact-analysis.ts';
import {
    computeStreamInFlightLimitDropCount,
    hasStreamFailureEvidence,
    isStreamFailureText,
    STREAM_FAILED_TOPIC,
    STREAM_PROGRESS_TOPIC,
    STREAM_STARTED_TOPIC,
    toEventStreamTimingSample,
    toResultStreamTimingSamples,
    type StreamTimingSample
} from '../distributed-run-performance/to-stream-timing-samples.ts';
import type { DistributedRunEventEvidence } from './decode-distributed-run-event-evidence.ts';
import type { DistributedRunResultEvidence } from './decode-distributed-run-result-evidence.ts';
import type { DistributedRunStreamSummary } from './decode-distributed-run-stream-summary.ts';
import {
    resolveMinimalFixArea,
    resolveVerificationCommand,
    STREAM_FIX_AREA,
    TERMINAL_FAILURE_STATES,
    toAffectedAgents
} from './distributed-run-failure-vocabulary.ts';

interface StreamFailureCandidate {
    readonly sample: StreamTimingSample;
    /** Absent when neither the row nor the sample names the agent. */
    readonly agentId?: string;
    readonly evidenceFile: string;
}

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
    const inFlightLimitDropCount = computeStreamInFlightLimitDropCount(candidate.sample);
    const details = [
        toCompletedFramesDetail(summary),
        summary.droppedFrames !== undefined ? `dropped ${summary.droppedFrames}` : undefined,
        inFlightLimitDropCount !== undefined ? `in-flight limit drops ${inFlightLimitDropCount}` : undefined,
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
        minimalFixArea: STREAM_FIX_AREA,
        verificationCommand: resolveVerificationCommand(STREAM_FIX_AREA),
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
        event.topic === STREAM_PROGRESS_TOPIC || event.topic === STREAM_STARTED_TOPIC
    );
    if (!streamEvent) {
        return undefined;
    }
    const summary = streamEvent.streamSummary;
    const commandId = streamEvent.commandId ?? summary?.commandId;
    const likelyCause = `RTC stream ${commandId ?? 'unknown-stream'} ${
        toStoppedStreamProgress(summary)
    } before the run stopped.`;
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

/** Absent when the summary records no completed frame count. */
function toCompletedFramesDetail(summary: DistributedRunStreamSummary): string | undefined {
    if (summary.completedFrames === undefined) {
        return undefined;
    }
    return summary.plannedFrames === undefined
        ? `completed ${summary.completedFrames} frames`
        : `completed ${summary.completedFrames}/${summary.plannedFrames} frames`;
}

function toStoppedStreamProgress(summary: DistributedRunStreamSummary | undefined): string {
    if (summary?.completedFrames === undefined) {
        return 'reported no completed frame count';
    }
    return summary.plannedFrames === undefined
        ? `reached ${summary.completedFrames} completed frames`
        : `reached ${summary.completedFrames} of ${summary.plannedFrames} completed frames`;
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
