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
import {
    decodeBoolean,
    decodeFiniteNumber,
    decodeRecord,
    decodeText,
    decodeTransport
} from '../runtime/decode-runtime-result-values.ts';

export interface LoopResultMetrics {
    readonly intervalMs: number;
    readonly count: number;
    /** Absent for a count-bounded loop. */
    readonly durationMs?: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly pacingIterations: readonly RallarBlackBoxTestLoopPacingIteration[];
    /** Absent until the loop's thresholds have been evaluated and at least one failed. */
    readonly thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
}

export interface LoopResultInput {
    readonly commandId: string;
    readonly results: readonly RallarBlackBoxTestCompositeChildResult[];
    readonly cancelled: boolean;
    /** Absent before the loop starts, when no pacing has been measured. */
    readonly metrics?: LoopResultMetrics;
}

type LoopPacingDrift = Pick<
    RallarBlackBoxTestLoopPacingSummary,
    'minStartDriftMs' | 'maxStartDriftMs' | 'averageStartDriftMs' | 'maxJitterMs' | 'averageJitterMs'
>;

export function toLoopResultValue(input: LoopResultInput): RallarBlackBoxTestLoopResultValue {
    const { commandId, results, cancelled, metrics } = input;
    const iterations = new Set(
        results
            .map((result) => result.iteration)
            .filter((iteration): iteration is number => iteration !== undefined)
    ).size;
    return {
        commandId,
        iterations,
        childResultCount: results.length,
        passed: results.filter((result) => result.result.ok).length,
        failed: results.filter((result) => !result.result.ok).length,
        cancelled,
        pacing: metrics ? toLoopPacingSummary(metrics) : undefined,
        sends: toLoopSendSummary(results),
        thresholdFailures: metrics?.thresholdFailures,
        results
    };
}

function toLoopPacingSummary(metrics: LoopResultMetrics): RallarBlackBoxTestLoopPacingSummary {
    const iterations = [...metrics.pacingIterations];
    const elapsedMs = Math.max(0, metrics.endedAtEpochMs - metrics.startedAtEpochMs);
    const completedIterations = iterations.length;
    const plannedIterations = metrics.durationMs === undefined ? metrics.count : completedIterations;
    const drift = toLoopPacingDrift(iterations);
    const lateThresholdMs = Math.max(1, Math.round(Math.max(metrics.intervalMs, 1) * 0.5));

    return {
        requestedIntervalMs: metrics.intervalMs,
        requestedRateHz: metrics.intervalMs > 0 ? toRoundedMetric(1000 / metrics.intervalMs) : undefined,
        plannedIterations,
        completedIterations,
        skippedIterations: Math.max(0, plannedIterations - completedIterations),
        cancelledIterations: iterations.filter((iteration) => iteration.cancelled).length,
        startedAtEpochMs: metrics.startedAtEpochMs,
        endedAtEpochMs: metrics.endedAtEpochMs,
        elapsedMs,
        targetElapsedMs: Math.max(0, (completedIterations - 1) * metrics.intervalMs),
        achievedRateHz: completedIterations > 1 && elapsedMs > 0
            ? toRoundedMetric(((completedIterations - 1) * 1000) / elapsedMs)
            : undefined,
        averageIterationDurationMs: computeAverage(iterations.map((iteration) => iteration.durationMs)),
        ...drift,
        lateIterationCount: iterations.filter((iteration) => iteration.startDriftMs > lateThresholdMs).length,
        lateThresholdMs,
        iterations
    };
}

function toLoopPacingDrift(iterations: readonly RallarBlackBoxTestLoopPacingIteration[]): LoopPacingDrift {
    const driftValues = iterations.map((iteration) => iteration.startDriftMs);
    const jitterValues = iterations
        .slice(1)
        .map((iteration, index) => Math.abs(iteration.startDriftMs - iterations[index].startDriftMs));
    return {
        minStartDriftMs: driftValues.length > 0 ? Math.min(...driftValues) : undefined,
        maxStartDriftMs: driftValues.length > 0 ? Math.max(...driftValues) : undefined,
        averageStartDriftMs: computeAverage(driftValues),
        maxJitterMs: jitterValues.length > 0 ? Math.max(...jitterValues) : undefined,
        averageJitterMs: computeAverage(jitterValues)
    };
}

function toLoopSendSummary(
    results: readonly RallarBlackBoxTestCompositeChildResult[]
): RallarBlackBoxTestLoopSendSummary {
    const observations = results
        .map((result) => toSendObservation(result.result))
        .filter((observation): observation is RallarBlackBoxTestSendObservation => observation !== undefined);
    const succeeded = observations.filter((observation) => observation.ok).length;

    return {
        sendCount: observations.length,
        succeeded,
        failed: observations.length - succeeded,
        successRatio: observations.length > 0 ? toRoundedMetric(succeeded / observations.length) : undefined,
        duration: toSendDurationSummary(observations.map((observation) => observation.durationMs)),
        queuedCount: observations.filter((observation) => observation.queued).length,
        droppedPayloadCount: observations.reduce((sum, observation) => sum + (observation.droppedPayloadCount ?? 0), 0),
        replacedPayloadCount: observations.reduce(
            (sum, observation) => sum + (observation.replacedPayloadCount ?? 0),
            0
        ),
        perTransportFailureCounts: toPerTransportFailureCounts(observations),
        observations
    };
}

function toSendDurationSummary(durations: readonly number[]): RallarBlackBoxTestLoopSendSummary['duration'] {
    return durations.length > 0
        ? {
            minMs: Math.min(...durations),
            maxMs: Math.max(...durations),
            averageMs: computeAverage(durations),
            totalMs: durations.reduce((sum, value) => sum + value, 0)
        }
        : undefined;
}

function toPerTransportFailureCounts(
    observations: readonly RallarBlackBoxTestSendObservation[]
): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const observation of observations.filter((candidate) => !candidate.ok)) {
        const key = observation.transport ?? observation.kind;
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

function toSendObservation(result: RallarBlackBoxTestResult): RallarBlackBoxTestSendObservation | undefined {
    if (result.kind !== 'rtc.send' && result.kind !== 'ws.send') {
        return undefined;
    }
    const value = decodeRecord(result.value);
    const observation = decodeRecord(value.sendObservation);
    return {
        commandId: result.commandId,
        kind: result.kind,
        transport: decodeTransport(observation.transport) ??
            (result.kind === 'ws.send' ? 'ws' : decodeTransport(value.transport)),
        durationMs: decodeFiniteNumber(observation.durationMs) ?? result.durationMs,
        ok: result.ok,
        status: decodeText(observation.status),
        queued: decodeBoolean(observation.queued) ?? false,
        droppedPayloadCount: decodeFiniteNumber(observation.droppedPayloadCount),
        replacedPayloadCount: decodeFiniteNumber(observation.replacedPayloadCount),
        errorCode: result.error?.code
    };
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
