import type {
    RallarBlackBoxTestCompositeChildResult,
    RallarBlackBoxTestLoopThresholds,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxTestLoopChildResult extends RallarBlackBoxTestCompositeChildResult {
    readonly iteration: number;
}

export interface RallarBlackBoxTestLoopPacingIteration {
    readonly iteration: number;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    readonly startDriftMs: number;
    readonly commandCount: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
}

export interface RallarBlackBoxTestLoopPacingSummary {
    readonly requestedIntervalMs: number;
    readonly requestedRateHz?: number;
    readonly plannedIterations: number;
    readonly completedIterations: number;
    readonly skippedIterations: number;
    readonly cancelledIterations: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly elapsedMs: number;
    readonly targetElapsedMs: number;
    readonly achievedRateHz?: number;
    readonly averageIterationDurationMs?: number;
    readonly minStartDriftMs?: number;
    readonly maxStartDriftMs?: number;
    readonly averageStartDriftMs?: number;
    readonly maxJitterMs?: number;
    readonly averageJitterMs?: number;
    readonly lateIterationCount: number;
    readonly lateThresholdMs: number;
    readonly iterations: readonly RallarBlackBoxTestLoopPacingIteration[];
}

export interface RallarBlackBoxTestLoopSendSummary {
    readonly sendCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly successRatio?: number;
    readonly duration?: Readonly<{
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        totalMs: number;
    }>;
    readonly queuedCount: number;
    readonly enqueuedCount: number;
    readonly backpressureCount: number;
    readonly droppedPayloadCount: number;
    readonly replacedPayloadCount: number;
    readonly perTransportFailureCounts: Readonly<Record<string, number>>;
    readonly observations: readonly RallarBlackBoxTestSendObservation[];
}

export interface RallarBlackBoxTestLoopThresholdFailure {
    readonly name: keyof RallarBlackBoxTestLoopThresholds;
    readonly category: 'pacing' | 'delivery' | 'backpressure';
    readonly threshold: number | boolean;
    readonly actual?: number | boolean;
    readonly message: string;
}

export interface RallarBlackBoxTestLoopResultValue {
    readonly commandId: string;
    readonly iterations: number;
    readonly childResultCount: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
    readonly pacing?: RallarBlackBoxTestLoopPacingSummary;
    readonly sends?: RallarBlackBoxTestLoopSendSummary;
    readonly thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
    readonly results: readonly RallarBlackBoxTestLoopChildResult[];
}
