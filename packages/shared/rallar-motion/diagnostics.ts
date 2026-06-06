import type {
    RallarMotionDiagnosticsSummary,
    RallarMotionDiagnosticsTracker,
    RallarMotionDiagnosticsTrackerOptions,
    RallarMotionPushResult,
    RallarMotionSample,
} from './types.ts';

type DiagnosticsState = {
    acceptedCount: number;
    duplicateSeqCount: number;
    staleSeqCount: number;
    droppedOldSampleCount: number;
    sequenceGapCount: number;
    droppedSequenceCount: number;
    intervalCount: number;
    totalIntervalMs: number;
    totalJitterMs: number;
    maxIntervalMs?: number;
    lastObservedAtByEntity: Map<string, number>;
    lastIntervalByEntity: Map<string, number>;
};

export function createRallarMotionDiagnosticsTracker(
    _options: RallarMotionDiagnosticsTrackerOptions = {},
): RallarMotionDiagnosticsTracker {
    const state = createState();

    return {
        recordPush(
            result: RallarMotionPushResult,
            sample?: Pick<RallarMotionSample, 'entityId' | 'observedAtEpochMs'>,
        ): RallarMotionDiagnosticsSummary {
            if (result.status === 'accepted') {
                state.acceptedCount += 1;
                if (sample) {
                    recordInterval(state, sample);
                }
            } else if (result.status === 'duplicate-seq') {
                state.duplicateSeqCount += 1;
            } else if (result.status === 'stale-seq') {
                state.staleSeqCount += 1;
            } else if (result.status === 'dropped-old-sample') {
                state.droppedOldSampleCount += 1;
            }

            if (result.sequenceGap) {
                state.sequenceGapCount += 1;
                state.droppedSequenceCount +=
                    result.sequenceGap.droppedSeqCount;
            }

            return toSummary(state);
        },
        recordSample(sample): RallarMotionDiagnosticsSummary {
            recordInterval(state, sample);
            return toSummary(state);
        },
        summary(): RallarMotionDiagnosticsSummary {
            return toSummary(state);
        },
        reset(): void {
            const next = createState();
            state.acceptedCount = next.acceptedCount;
            state.duplicateSeqCount = next.duplicateSeqCount;
            state.staleSeqCount = next.staleSeqCount;
            state.droppedOldSampleCount = next.droppedOldSampleCount;
            state.sequenceGapCount = next.sequenceGapCount;
            state.droppedSequenceCount = next.droppedSequenceCount;
            state.intervalCount = next.intervalCount;
            state.totalIntervalMs = next.totalIntervalMs;
            state.totalJitterMs = next.totalJitterMs;
            state.maxIntervalMs = next.maxIntervalMs;
            state.lastObservedAtByEntity.clear();
            state.lastIntervalByEntity.clear();
        },
    };
}

function createState(): DiagnosticsState {
    return {
        acceptedCount: 0,
        duplicateSeqCount: 0,
        staleSeqCount: 0,
        droppedOldSampleCount: 0,
        sequenceGapCount: 0,
        droppedSequenceCount: 0,
        intervalCount: 0,
        totalIntervalMs: 0,
        totalJitterMs: 0,
        lastObservedAtByEntity: new Map<string, number>(),
        lastIntervalByEntity: new Map<string, number>(),
    };
}

function recordInterval(
    state: DiagnosticsState,
    sample: Pick<RallarMotionSample, 'entityId' | 'observedAtEpochMs'>,
): void {
    const previousObservedAt = state.lastObservedAtByEntity.get(sample.entityId);
    state.lastObservedAtByEntity.set(sample.entityId, sample.observedAtEpochMs);
    if (previousObservedAt === undefined) {
        return;
    }

    const intervalMs = sample.observedAtEpochMs - previousObservedAt;
    if (intervalMs <= 0) {
        return;
    }

    const previousInterval = state.lastIntervalByEntity.get(sample.entityId);
    state.lastIntervalByEntity.set(sample.entityId, intervalMs);
    state.intervalCount += 1;
    state.totalIntervalMs += intervalMs;
    state.maxIntervalMs = Math.max(state.maxIntervalMs ?? 0, intervalMs);
    if (previousInterval !== undefined) {
        state.totalJitterMs += Math.abs(intervalMs - previousInterval);
    }
}

function toSummary(state: DiagnosticsState): RallarMotionDiagnosticsSummary {
    return {
        acceptedCount: state.acceptedCount,
        duplicateSeqCount: state.duplicateSeqCount,
        staleSeqCount: state.staleSeqCount,
        droppedOldSampleCount: state.droppedOldSampleCount,
        sequenceGapCount: state.sequenceGapCount,
        droppedSequenceCount: state.droppedSequenceCount,
        intervalCount: state.intervalCount,
        averageIntervalMs: state.intervalCount > 0
            ? state.totalIntervalMs / state.intervalCount
            : undefined,
        averageJitterMs: state.intervalCount > 1
            ? state.totalJitterMs / (state.intervalCount - 1)
            : undefined,
        maxIntervalMs: state.maxIntervalMs,
    };
}
