import type {
    DistributedRunPerformanceAnalysis,
} from './distributed-artifact-analysis.ts';

export type DistributedRunTuningTimingMetric =
    | 'command-duration'
    | 'stream-send-duration'
    | 'stream-drift'
    | 'stream-cadence';

export type DistributedRunTuningNumericDelta = Readonly<{
    left?: number;
    right?: number;
    delta?: number;
}>;

export type DistributedRunTuningPerformanceComparison = Readonly<{
    timingMetric: DistributedRunTuningTimingMetric;
    availability: 'complete' | 'partial' | 'unavailable';
    selected: DistributedRunTuningNumericDelta & Readonly<{
        statistic: 'p95' | 'max' | 'achieved-completion';
        unit: 'ms' | 'hz';
    }>;
    rtc: Readonly<{
        plannedFrames: DistributedRunTuningNumericDelta;
        completedFrames: DistributedRunTuningNumericDelta;
        failedFrames: DistributedRunTuningNumericDelta;
        droppedFrames: DistributedRunTuningNumericDelta;
        inFlightLimitDropCount: DistributedRunTuningNumericDelta;
        backpressureCount: DistributedRunTuningNumericDelta;
        requestedRateHz: DistributedRunTuningNumericDelta;
        achievedCompletionHz: DistributedRunTuningNumericDelta;
        maxStartDriftMs: DistributedRunTuningNumericDelta;
        lateFrameCount: DistributedRunTuningNumericDelta;
    }>;
}>;

export function compareDistributedRunTuningPerformance(input: Readonly<{
    timingMetric: DistributedRunTuningTimingMetric;
    left?: DistributedRunPerformanceAnalysis;
    right?: DistributedRunPerformanceAnalysis;
}>): DistributedRunTuningPerformanceComparison {
    const definition = metricDefinition(input.timingMetric);
    const left = definition.value(input.left);
    const right = definition.value(input.right);
    const leftStream = input.left?.streamTiming;
    const rightStream = input.right?.streamTiming;
    return {
        timingMetric: input.timingMetric,
        availability: left !== undefined && right !== undefined
            ? 'complete' as const
            : left !== undefined || right !== undefined
            ? 'partial' as const
            : 'unavailable' as const,
        selected: {
            statistic: definition.statistic,
            unit: definition.unit,
            ...numericDelta(left, right),
        },
        rtc: {
            plannedFrames: numericDelta(leftStream?.plannedFrames, rightStream?.plannedFrames),
            completedFrames: numericDelta(leftStream?.completedFrames, rightStream?.completedFrames),
            failedFrames: numericDelta(leftStream?.failedFrames, rightStream?.failedFrames),
            droppedFrames: numericDelta(leftStream?.droppedFrames, rightStream?.droppedFrames),
            inFlightLimitDropCount: numericDelta(
                leftStream?.inFlightLimitDropCount,
                rightStream?.inFlightLimitDropCount,
            ),
            backpressureCount: numericDelta(leftStream?.backpressureCount, rightStream?.backpressureCount),
            requestedRateHz: numericDelta(leftStream?.requestedRateHz, rightStream?.requestedRateHz),
            achievedCompletionHz: numericDelta(
                leftStream?.achievedCompletionHz,
                rightStream?.achievedCompletionHz,
            ),
            maxStartDriftMs: numericDelta(leftStream?.maxStartDriftMs, rightStream?.maxStartDriftMs),
            lateFrameCount: numericDelta(leftStream?.lateFrameCount, rightStream?.lateFrameCount),
        },
    };
}

function metricDefinition(metric: DistributedRunTuningTimingMetric) {
    if (metric === 'command-duration') {
        return {
            statistic: 'p95' as const,
            unit: 'ms' as const,
            value: (value?: DistributedRunPerformanceAnalysis) =>
                value?.commandTiming.p95Ms,
        };
    }
    if (metric === 'stream-send-duration') {
        return {
            statistic: 'p95' as const,
            unit: 'ms' as const,
            value: (value?: DistributedRunPerformanceAnalysis) =>
                value?.streamTiming?.duration.p95Ms,
        };
    }
    if (metric === 'stream-drift') {
        return {
            statistic: 'max' as const,
            unit: 'ms' as const,
            value: (value?: DistributedRunPerformanceAnalysis) =>
                value?.streamTiming?.maxStartDriftMs,
        };
    }
    return {
        statistic: 'achieved-completion' as const,
        unit: 'hz' as const,
        value: (value?: DistributedRunPerformanceAnalysis) =>
            value?.streamTiming?.achievedCompletionHz,
    };
}

function numericDelta(
    left: number | undefined,
    right: number | undefined,
): DistributedRunTuningNumericDelta {
    return {
        left,
        right,
        delta: left !== undefined && right !== undefined
            ? round(right - left)
            : undefined,
    };
}

function round(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}
