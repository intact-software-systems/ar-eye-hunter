import {
    toBoolean,
    toFiniteNumber,
    toRecord,
    toText,
    toTransport
} from '../to-runtime-command-values.ts';
import {
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestLoopPacingIteration,
    type RallarBlackBoxTestLoopPacingSummary,
    type RallarBlackBoxTestLoopResultValue,
    type RallarBlackBoxTestLoopSendSummary,
    type RallarBlackBoxTestLoopThresholdFailure,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';
export interface LoopResultMetrics {
    readonly intervalMs: number;
    readonly count: number;
    readonly durationMs?: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly pacingIterations: readonly RallarBlackBoxTestLoopPacingIteration[];
    readonly thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
}
export function toLoopResultValue(
    { commandId, results, cancelled, metrics }: LoopResultInput
): RallarBlackBoxTestLoopResultValue {
    const iterations = new Set(
        results
            .map((result) => result.iteration)
            .filter((iteration): iteration is number => iteration !== undefined)
    ).size;
    const pacing = metrics
        ? toLoopPacingSummary(metrics)
        : undefined;
    const sends = toLoopSendSummary(results);
    return {
        commandId,
        iterations,
        childResultCount: results.length,
        passed: results.filter((result) => result.result.ok).length,
        failed: results.filter((result) => !result.result.ok).length,
        cancelled,
        pacing,
        sends,
        thresholdFailures: metrics?.thresholdFailures,
        results
    };
}
function toLoopPacingSummary(metrics: LoopResultMetrics): RallarBlackBoxTestLoopPacingSummary {
    const iterations = [...metrics.pacingIterations];
    const driftValues = iterations.map((iteration) => iteration.startDriftMs);
    const jitterValues = iterations
        .slice(1)
        .map((iteration, index) => Math.abs(iteration.startDriftMs - iterations[index].startDriftMs));
    const elapsedMs = Math.max(0, metrics.endedAtEpochMs - metrics.startedAtEpochMs);
    const completedIterations = iterations.length;
    const plannedIterations = metrics.durationMs === undefined
        ? metrics.count
        : completedIterations;
    const targetElapsedMs = Math.max(0, (completedIterations - 1) * metrics.intervalMs);
    const achievedRateHz = completedIterations > 1 && elapsedMs > 0
        ? toRoundedMetric(((completedIterations - 1) * 1000) / elapsedMs)
        : undefined;
    const requestedRateHz = metrics.intervalMs > 0
        ? toRoundedMetric(1000 / metrics.intervalMs)
        : undefined;
    const lateThresholdMs = Math.max(1, Math.round(Math.max(metrics.intervalMs, 1) * 0.5));

    return {
        requestedIntervalMs: metrics.intervalMs,
        requestedRateHz,
        plannedIterations,
        completedIterations,
        skippedIterations: Math.max(0, plannedIterations - completedIterations),
        cancelledIterations: iterations.filter((iteration) => iteration.cancelled).length,
        startedAtEpochMs: metrics.startedAtEpochMs,
        endedAtEpochMs: metrics.endedAtEpochMs,
        elapsedMs,
        targetElapsedMs,
        achievedRateHz,
        averageIterationDurationMs: computeAverage(iterations.map((iteration) => iteration.durationMs)),
        minStartDriftMs: driftValues.length > 0 ? Math.min(...driftValues) : undefined,
        maxStartDriftMs: driftValues.length > 0 ? Math.max(...driftValues) : undefined,
        averageStartDriftMs: computeAverage(driftValues),
        maxJitterMs: jitterValues.length > 0 ? Math.max(...jitterValues) : undefined,
        averageJitterMs: computeAverage(jitterValues),
        lateIterationCount: driftValues.filter((value) => value > lateThresholdMs).length,
        lateThresholdMs,
        iterations
    };
}
function toLoopSendSummary(
    results: readonly RallarBlackBoxTestCompositeChildResult[]
): RallarBlackBoxTestLoopSendSummary {
    const observations = results
        .map((result) => toSendObservation(result.result))
        .filter((observation): observation is RallarBlackBoxTestSendObservation => observation !== undefined);
    const durations = observations.map((observation) => observation.durationMs);
    const succeeded = observations.filter((observation) => observation.ok).length;
    const failed = observations.length - succeeded;
    const perTransportFailureCounts = observations.reduce<Record<string, number>>((counts, observation) => {
        if (observation.ok) {
            return counts;
        }
        const key = observation.transport ?? observation.kind;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
    }, {});

    return {
        sendCount: observations.length,
        succeeded,
        failed,
        successRatio: observations.length > 0
            ? toRoundedMetric(succeeded / observations.length)
            : undefined,
        duration: durations.length > 0
            ? {
                minMs: Math.min(...durations),
                maxMs: Math.max(...durations),
                averageMs: computeAverage(durations),
                totalMs: durations.reduce((sum, value) => sum + value, 0)
            }
            : undefined,
        queuedCount: observations.filter((observation) => observation.queued).length,
        enqueuedCount: observations.filter((observation) => observation.enqueued).length,
        backpressureCount: observations.filter((observation) => observation.backpressured).length,
        droppedPayloadCount: observations.reduce(
            (sum, observation) => sum + (observation.droppedPayloadCount ?? 0),
            0
        ),
        replacedPayloadCount: observations.reduce(
            (sum, observation) => sum + (observation.replacedPayloadCount ?? 0),
            0
        ),
        perTransportFailureCounts,
        observations
    };
}
function toSendObservation(
    result: RallarBlackBoxTestResult
): RallarBlackBoxTestSendObservation | undefined {
    if (result.kind !== 'rtc.send' && result.kind !== 'ws.send') {
        return undefined;
    }
    const value = toRecord(result.value);
    const observation = toRecord(value.sendObservation);
    return {
        commandId: result.commandId,
        kind: result.kind,
        transport: toTransport(observation.transport) ??
            (result.kind === 'ws.send' ? 'ws' : toTransport(value.transport)),
        durationMs: toFiniteNumber(observation.durationMs) ?? result.durationMs,
        ok: result.ok,
        status: toText(observation.status),
        queued: toBoolean(observation.queued) ?? false,
        enqueued: toBoolean(observation.enqueued) ?? false,
        backpressured: toBoolean(observation.backpressured) ?? false,
        droppedPayloadCount: toFiniteNumber(observation.droppedPayloadCount),
        replacedPayloadCount: toFiniteNumber(observation.replacedPayloadCount),
        errorCode: result.error?.code
    };
}

interface LoopResultInput {
    readonly commandId: string;
    readonly results: readonly RallarBlackBoxTestCompositeChildResult[];
    readonly cancelled: boolean;
    readonly metrics?: LoopResultMetrics;
}
function toRoundedMetric(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}
function computeAverage(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
