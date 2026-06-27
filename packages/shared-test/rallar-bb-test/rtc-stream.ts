import type {
    RallarBlackBoxTestRtcStreamFrameObservation,
    RallarBlackBoxTestRtcStreamResultValue,
    RallarBlackBoxTestRtcStreamThresholdFailure,
    RallarBlackBoxTestRtcStreamThresholds,
    RallarBlackBoxTestTransport,
} from './types.ts';

const STREAM_PLACEHOLDER_PATTERN =
    /\{stream\.(commandId|index|iteration|elapsedMs|scheduledElapsedMs)\}/g;
const STREAM_EXACT_PLACEHOLDER_PATTERN =
    /^\{stream\.(commandId|index|iteration|elapsedMs|scheduledElapsedMs)\}$/;

export type RallarBlackBoxRtcStreamFramePlan = Readonly<{
    index: number;
    iteration: number;
    scheduledElapsedMs: number;
}>;

export type RallarBlackBoxRtcStreamPlan = Readonly<{
    intervalMs: number;
    requestedRateHz?: number;
    frames: readonly RallarBlackBoxRtcStreamFramePlan[];
}>;

export type RallarBlackBoxRtcStreamPlaceholderContext = Readonly<{
    commandId: string;
    index: number;
    iteration: number;
    elapsedMs: number;
    scheduledElapsedMs: number;
}>;

export function planRallarBlackBoxRtcStreamFrames(input: {
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    rateHz?: number;
}): RallarBlackBoxRtcStreamPlan {
    const intervalMs = input.intervalMs ?? (
        input.rateHz && input.rateHz > 0
            ? roundMetric(1000 / input.rateHz)
            : 0
    );
    if (intervalMs <= 0) {
        return {
            intervalMs,
            requestedRateHz: input.rateHz,
            frames: [],
        };
    }

    const countBound = positiveInteger(input.count);
    const durationBound = positiveInteger(input.durationMs) === undefined
        ? undefined
        : Math.ceil((input.durationMs as number) / intervalMs);
    const frameCount = countBound === undefined
        ? durationBound ?? 0
        : durationBound === undefined
            ? countBound
            : Math.min(countBound, durationBound);
    const frames: RallarBlackBoxRtcStreamFramePlan[] = [];
    for (let index = 0; index < frameCount; index++) {
        frames.push({
            index,
            iteration: index + 1,
            scheduledElapsedMs: roundMetric(index * intervalMs),
        });
    }

    return {
        intervalMs,
        requestedRateHz: input.rateHz ?? roundMetric(1000 / intervalMs),
        frames,
    };
}

export function replaceRallarBlackBoxRtcStreamPlaceholders<T>(
    value: T,
    context: RallarBlackBoxRtcStreamPlaceholderContext,
): T {
    if (typeof value === 'string') {
        const exact = STREAM_EXACT_PLACEHOLDER_PATTERN.exec(value);
        if (exact) {
            return streamPlaceholderValue(exact[1], context) as T;
        }

        return value.replace(
            STREAM_PLACEHOLDER_PATTERN,
            (_match, name: string) => String(streamPlaceholderValue(name, context)),
        ) as T;
    }

    if (Array.isArray(value)) {
        return value.map(entry => replaceRallarBlackBoxRtcStreamPlaceholders(entry, context)) as T;
    }

    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, entry]) => [key, replaceRallarBlackBoxRtcStreamPlaceholders(entry, context)]),
        ) as T;
    }

    return value;
}

export function summarizeRallarBlackBoxRtcStreamObservations(input: {
    commandId: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    intervalMs: number;
    requestedRateHz?: number;
    plannedFrames: number;
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
    thresholds?: RallarBlackBoxTestRtcStreamThresholds;
}): RallarBlackBoxTestRtcStreamResultValue {
    const elapsedMs = Math.max(0, input.endedAtEpochMs - input.startedAtEpochMs);
    const observations = [...input.observations].sort((left, right) => left.index - right.index);
    const durations = observations
        .filter(observation => !observation.dropped)
        .map(observation => observation.durationMs)
        .filter((value): value is number => value !== undefined);
    const startDrifts = observations
        .map(observation => observation.startDriftMs)
        .filter((value): value is number => value !== undefined);
    const jitters = startDrifts
        .slice(1)
        .map((drift, index) => Math.abs(drift - startDrifts[index]));
    const scheduledFrames = observations.length;
    const droppedFrames = observations.filter(observation => observation.dropped).length;
    const attemptedFrames = observations.filter(observation => !observation.dropped).length;
    const completedFrames = observations.filter(observation => observation.ok && !observation.dropped).length;
    const failedFrames = observations.filter(observation => !observation.ok).length;
    const backpressureCount = observations.filter(observation => observation.backpressured).length;
    const lateThresholdMs = Math.max(1, Math.round(Math.max(input.intervalMs, 1) * 0.5));
    const value: RallarBlackBoxTestRtcStreamResultValue = {
        commandId: input.commandId,
        transport: input.transport,
        plannedFrames: input.plannedFrames,
        scheduledFrames,
        attemptedFrames,
        completedFrames,
        failedFrames,
        droppedFrames,
        backpressureCount,
        startedAtEpochMs: input.startedAtEpochMs,
        endedAtEpochMs: input.endedAtEpochMs,
        elapsedMs,
        requestedRateHz: input.requestedRateHz,
        achievedScheduleHz: elapsedMs > 0
            ? roundMetric((scheduledFrames * 1000) / elapsedMs)
            : undefined,
        achievedCompletionHz: elapsedMs > 0
            ? roundMetric((completedFrames * 1000) / elapsedMs)
            : undefined,
        pacing: {
            intervalMs: input.intervalMs,
            maxStartDriftMs: startDrifts.length > 0 ? Math.max(...startDrifts) : undefined,
            averageStartDriftMs: average(startDrifts),
            maxJitterMs: jitters.length > 0 ? Math.max(...jitters) : undefined,
            lateFrameCount: startDrifts.filter(value => value > lateThresholdMs).length,
        },
        duration: {
            minMs: durations.length > 0 ? Math.min(...durations) : undefined,
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            p99Ms: percentile(durations, 0.99),
            maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
            averageMs: average(durations),
        },
        thresholdFailures: [],
        observations,
    };

    return {
        ...value,
        thresholdFailures: evaluateRallarBlackBoxRtcStreamThresholds(value, input.thresholds),
    };
}

export function evaluateRallarBlackBoxRtcStreamThresholds(
    value: RallarBlackBoxTestRtcStreamResultValue,
    thresholds: RallarBlackBoxTestRtcStreamThresholds | undefined,
): readonly RallarBlackBoxTestRtcStreamThresholdFailure[] {
    if (!thresholds) {
        return [];
    }

    const failures: RallarBlackBoxTestRtcStreamThresholdFailure[] = [];
    const successRatio = value.attemptedFrames > 0
        ? roundMetric(value.completedFrames / value.attemptedFrames)
        : undefined;
    pushNumericFailure(
        failures,
        thresholds.maxDroppedFrames,
        value.droppedFrames,
        'maxDroppedFrames',
        'delivery',
        'Dropped frame count',
        'above',
    );
    pushNumericFailure(
        failures,
        thresholds.maxBackpressureCount,
        value.backpressureCount,
        'maxBackpressureCount',
        'backpressure',
        'Backpressure count',
        'above',
    );
    if (
        thresholds.minSendSuccessRatio !== undefined &&
        successRatio !== undefined &&
        successRatio < thresholds.minSendSuccessRatio
    ) {
        failures.push({
            name: 'minSendSuccessRatio',
            category: 'delivery',
            threshold: thresholds.minSendSuccessRatio,
            actual: successRatio,
            message: `Stream send success ratio was ${successRatio}, below the configured ${thresholds.minSendSuccessRatio} minimum.`,
        });
    }
    pushNumericFailure(
        failures,
        thresholds.maxP95SendDurationMs,
        value.duration.p95Ms,
        'maxP95SendDurationMs',
        'delivery',
        'P95 send duration',
        'above',
    );
    pushNumericFailure(
        failures,
        thresholds.maxP99SendDurationMs,
        value.duration.p99Ms,
        'maxP99SendDurationMs',
        'delivery',
        'P99 send duration',
        'above',
    );
    pushNumericFailure(
        failures,
        thresholds.maxAverageStartDriftMs,
        value.pacing.averageStartDriftMs,
        'maxAverageStartDriftMs',
        'pacing',
        'Average start drift',
        'above',
    );
    pushNumericFailure(
        failures,
        thresholds.maxStartDriftMs,
        value.pacing.maxStartDriftMs,
        'maxStartDriftMs',
        'pacing',
        'Maximum start drift',
        'above',
    );
    pushNumericFailure(
        failures,
        thresholds.maxJitterMs,
        value.pacing.maxJitterMs,
        'maxJitterMs',
        'pacing',
        'Maximum jitter',
        'above',
    );

    return failures;
}

export function sampleRallarBlackBoxRtcStreamObservations(
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[],
    sampleEvery: number,
): readonly RallarBlackBoxTestRtcStreamFrameObservation[] {
    if (!Number.isInteger(sampleEvery) || sampleEvery <= 1 || observations.length <= 2) {
        return observations;
    }

    const lastIndex = observations.length - 1;
    return observations.filter((observation, index) =>
        index === 0 ||
        index === lastIndex ||
        observation.iteration % sampleEvery === 0 ||
        !observation.ok ||
        observation.dropped === true ||
        observation.backpressured === true
    );
}

function streamPlaceholderValue(
    name: string,
    context: RallarBlackBoxRtcStreamPlaceholderContext,
): string | number {
    switch (name) {
        case 'commandId':
            return context.commandId;
        case 'index':
            return context.index;
        case 'iteration':
            return context.iteration;
        case 'elapsedMs':
            return context.elapsedMs;
        case 'scheduledElapsedMs':
            return context.scheduledElapsedMs;
        default:
            return '';
    }
}

function pushNumericFailure(
    failures: RallarBlackBoxTestRtcStreamThresholdFailure[],
    threshold: number | undefined,
    actual: number | undefined,
    name: keyof RallarBlackBoxTestRtcStreamThresholds,
    category: RallarBlackBoxTestRtcStreamThresholdFailure['category'],
    label: string,
    direction: 'above',
): void {
    if (threshold === undefined || actual === undefined || actual <= threshold) {
        return;
    }

    failures.push({
        name,
        category,
        threshold,
        actual,
        message: `${label} was ${actual} ms, ${direction} the configured ${threshold} ms maximum.`,
    });
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
    return sorted[index];
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundMetric(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function positiveInteger(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
