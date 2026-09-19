import {
    computeStreamInFlightLimitDropCount,
    type StreamTimingSample
} from './to-stream-timing-samples.ts';

/** A stream timing sample with the priority of its source and its position among all candidates. */
export interface StreamTimingSampleCandidate {
    readonly sample: StreamTimingSample;
    readonly sourcePriority: number;
    readonly index: number;
}

/** A candidate with the keys the sample index groups it by. */
export interface PreparedStreamTimingSampleCandidate {
    readonly candidate: StreamTimingSampleCandidate;
    readonly baseKey: string;
    readonly fingerprint: string;
}

export function toPreparedStreamSampleCandidate(
    candidate: StreamTimingSampleCandidate
): PreparedStreamTimingSampleCandidate {
    return {
        candidate,
        baseKey: toStreamSampleBaseKey(candidate.sample),
        fingerprint: toStreamSampleFingerprint(candidate.sample)
    };
}

export function computeStreamSampleCandidateOrder(
    left: StreamTimingSampleCandidate,
    right: StreamTimingSampleCandidate
): number {
    const terminalPriority = Number(left.sample.completeness === 'terminal') -
        Number(right.sample.completeness === 'terminal');
    return terminalPriority ||
        toStreamSampleEvidenceScore(left.sample) - toStreamSampleEvidenceScore(right.sample) ||
        left.sourcePriority - right.sourcePriority ||
        left.index - right.index;
}

function toStreamSampleEvidenceScore(sample: StreamTimingSample): number {
    const { summary } = sample;
    return (summary.thresholdFailureCount > 0 ? 1_000_000 : 0) +
        (sample.failed ? 500_000 : 0) +
        (summary.completedFrames ?? 0) * 10_000 +
        (summary.scheduledFrames ?? 0) * 1_000 +
        (summary.plannedFrames ?? 0) * 100 +
        (summary.observations?.length ?? 0);
}

export function toStreamSampleKey(prepared: PreparedStreamTimingSampleCandidate): string {
    const { identityKey } = prepared.candidate.sample;
    return identityKey ? `${prepared.baseKey}:${identityKey}` : prepared.baseKey;
}

export function isSameStreamExecution(
    left: PreparedStreamTimingSampleCandidate,
    right: PreparedStreamTimingSampleCandidate,
    crossSource: boolean
): boolean {
    if (left.baseKey !== right.baseKey) {
        return false;
    }
    const leftSample = left.candidate.sample;
    const rightSample = right.candidate.sample;
    const sameFingerprint = left.fingerprint === right.fingerprint;
    if (!leftSample.identityKey || !rightSample.identityKey) {
        return (!leftSample.identityKey && !rightSample.identityKey) || sameFingerprint;
    }
    if (leftSample.identityKey === rightSample.identityKey) {
        return true;
    }
    if (leftSample.nested && rightSample.nested) {
        return false;
    }
    return !leftSample.nested && !rightSample.nested ? crossSource && sameFingerprint : sameFingerprint;
}

function toStreamSampleBaseKey(sample: StreamTimingSample): string {
    return `${sample.agentId ?? 'unknown-agent'}:${sample.commandId ?? sample.summary.commandId ?? 'unknown-stream'}`;
}

function toStreamSampleFingerprint(sample: StreamTimingSample): string {
    const { summary } = sample;
    return JSON.stringify({
        plannedFrames: summary.plannedFrames,
        scheduledFrames: summary.scheduledFrames,
        attemptedFrames: summary.attemptedFrames,
        completedFrames: summary.completedFrames,
        failedFrames: summary.failedFrames,
        droppedFrames: summary.droppedFrames,
        inFlightLimitDropCount: computeStreamInFlightLimitDropCount(sample),
        backpressureCount: summary.backpressureCount,
        requestedRateHz: summary.requestedRateHz,
        achievedScheduleHz: summary.achievedScheduleHz,
        achievedCompletionHz: summary.achievedCompletionHz,
        pacing: {
            maxStartDriftMs: summary.maxStartDriftMs,
            lateFrameCount: summary.lateFrameCount
        },
        duration: summary.fingerprintText.duration,
        thresholdFailures: summary.fingerprintText.thresholdFailures,
        observations: summary.fingerprintText.observations
    });
}
