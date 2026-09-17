import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';

import type {
    RallarBlackBoxTestRtcStreamCommand,
    RallarBlackBoxTestRtcStreamFrameObservation,
    RallarBlackBoxTestRtcStreamResultValue,
    RallarBlackBoxTestRtcStreamThresholdFailure,
    RallarBlackBoxTestRtcStreamThresholds,
    RallarBlackBoxTestTransport
} from './rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxRtcStreamFramePlan {
    readonly index: number;
    readonly iteration: number;
    readonly scheduledElapsedMs: number;
}

export interface RallarBlackBoxRtcStreamPlan {
    readonly intervalMs: number;
    /** Absent when the command sets no rate and no positive interval. */
    readonly requestedRateHz?: number;
    readonly frames: readonly RallarBlackBoxRtcStreamFramePlan[];
}

export interface RallarBlackBoxRtcStreamPlaceholderContext {
    readonly commandId: string;
    readonly index: number;
    readonly iteration: number;
    readonly elapsedMs: number;
    readonly scheduledElapsedMs: number;
}

export interface RallarBlackBoxRtcStreamResultInput {
    readonly commandId: string;
    /** Absent when the stream command names no transport. */
    readonly transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly intervalMs: number;
    /** Absent when the plan carries no requested rate. */
    readonly requestedRateHz?: number;
    readonly plannedFrames: number;
    readonly observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
    /** Absent when the stream command configures no thresholds. */
    readonly thresholds?: RallarBlackBoxTestRtcStreamThresholds;
}

type RallarBlackBoxRtcStreamPlanSettings = Pick<
    RallarBlackBoxTestRtcStreamCommand,
    'count' | 'durationMs' | 'intervalMs' | 'rateHz'
>;

type StreamFrameCounts = Pick<
    RallarBlackBoxTestRtcStreamResultValue,
    'scheduledFrames' | 'attemptedFrames' | 'completedFrames' | 'failedFrames' | 'droppedFrames' | 'backpressureCount'
>;

type StreamPlaceholderName = keyof RallarBlackBoxRtcStreamPlaceholderContext;

interface StreamThresholdRule {
    readonly name: keyof RallarBlackBoxTestRtcStreamThresholds;
    readonly category: RallarBlackBoxTestRtcStreamThresholdFailure['category'];
    readonly label: string;
    readonly bound: 'minimum' | 'maximum';
    readonly toActual: (value: RallarBlackBoxTestRtcStreamResultValue) => number | undefined;
}

const STREAM_PLACEHOLDER_PATTERN = /\{stream\.(commandId|index|iteration|elapsedMs|scheduledElapsedMs)\}/g;
const STREAM_EXACT_PLACEHOLDER_PATTERN = /^\{stream\.(commandId|index|iteration|elapsedMs|scheduledElapsedMs)\}$/;
const STREAM_PLACEHOLDER_NAMES: readonly StreamPlaceholderName[] = [
    'commandId',
    'index',
    'iteration',
    'elapsedMs',
    'scheduledElapsedMs'
];

/** Failures are reported in this order. */
const STREAM_THRESHOLD_RULES: readonly StreamThresholdRule[] = [
    {
        name: 'maxDroppedFrames',
        category: 'delivery',
        label: 'Dropped frame count',
        bound: 'maximum',
        toActual: (value) => value.droppedFrames
    },
    {
        name: 'maxBackpressureCount',
        category: 'backpressure',
        label: 'Backpressure count',
        bound: 'maximum',
        toActual: (value) => value.backpressureCount
    },
    {
        name: 'minSendSuccessRatio',
        category: 'delivery',
        label: 'Stream send success ratio',
        bound: 'minimum',
        toActual: (value) =>
            value.attemptedFrames > 0 ? toRoundedMetric(value.completedFrames / value.attemptedFrames) : undefined
    },
    {
        name: 'maxP95SendDurationMs',
        category: 'delivery',
        label: 'P95 send duration',
        bound: 'maximum',
        toActual: (value) => value.duration.p95Ms
    },
    {
        name: 'maxP99SendDurationMs',
        category: 'delivery',
        label: 'P99 send duration',
        bound: 'maximum',
        toActual: (value) => value.duration.p99Ms
    },
    {
        name: 'maxAverageStartDriftMs',
        category: 'pacing',
        label: 'Average start drift',
        bound: 'maximum',
        toActual: (value) => value.pacing.averageStartDriftMs
    },
    {
        name: 'maxStartDriftMs',
        category: 'pacing',
        label: 'Maximum start drift',
        bound: 'maximum',
        toActual: (value) => value.pacing.maxStartDriftMs
    },
    {
        name: 'maxJitterMs',
        category: 'pacing',
        label: 'Maximum jitter',
        bound: 'maximum',
        toActual: (value) => value.pacing.maxJitterMs
    }
];

/** A count and a duration both bound the frames; with neither bound, or without a positive interval, nothing is planned. */
export function computeRallarBlackBoxRtcStreamPlan(
    settings: RallarBlackBoxRtcStreamPlanSettings
): RallarBlackBoxRtcStreamPlan {
    const intervalMs = settings.intervalMs ?? (
        settings.rateHz !== undefined && settings.rateHz > 0 ? toRoundedMetric(1000 / settings.rateHz) : 0
    );
    if (intervalMs <= 0) {
        return { intervalMs, requestedRateHz: settings.rateHz, frames: [] };
    }
    return {
        intervalMs,
        requestedRateHz: settings.rateHz ?? toRoundedMetric(1000 / intervalMs),
        frames: Array.from({ length: computeStreamFrameCount(settings, intervalMs) }, (_, index) => ({
            index,
            iteration: index + 1,
            scheduledElapsedMs: toRoundedMetric(index * intervalMs)
        }))
    };
}

/** A payload that is exactly one placeholder takes the placeholder value itself, which may be a number. */
export function toRallarBlackBoxRtcStreamFramePayload(
    payload: RallarMessagePayload,
    context: RallarBlackBoxRtcStreamPlaceholderContext
): RallarMessagePayload {
    if (typeof payload === 'string') {
        return toStreamPlaceholderText(payload, context);
    }
    if (Array.isArray(payload)) {
        return payload.map((item: RallarMessagePayload) => toRallarBlackBoxRtcStreamFramePayload(item, context));
    }
    if (payload === null || typeof payload !== 'object') {
        return payload;
    }
    return Object.fromEntries(
        Object.entries(payload).map((
            [key, item]: [string, RallarMessagePayload]
        ) => [key, toRallarBlackBoxRtcStreamFramePayload(item, context)])
    );
}

export function computeRallarBlackBoxRtcStreamResultValue(
    input: RallarBlackBoxRtcStreamResultInput
): RallarBlackBoxTestRtcStreamResultValue {
    const elapsedMs = Math.max(0, input.endedAtEpochMs - input.startedAtEpochMs);
    const observations = [...input.observations].sort((left, right) => left.index - right.index);
    const counts = computeStreamFrameCounts(observations);
    const value: RallarBlackBoxTestRtcStreamResultValue = {
        commandId: input.commandId,
        transport: input.transport,
        plannedFrames: input.plannedFrames,
        ...counts,
        startedAtEpochMs: input.startedAtEpochMs,
        endedAtEpochMs: input.endedAtEpochMs,
        elapsedMs,
        requestedRateHz: input.requestedRateHz,
        achievedScheduleHz: computeFrameRate(counts.scheduledFrames, elapsedMs),
        achievedCompletionHz: computeFrameRate(counts.completedFrames, elapsedMs),
        pacing: computeStreamPacing(observations, input.intervalMs),
        duration: computeStreamDuration(observations),
        thresholdFailures: [],
        observations
    };
    return {
        ...value,
        thresholdFailures: input.thresholds === undefined ? [] : computeStreamThresholdFailures(value, input.thresholds)
    };
}

/** The first and last frames and every failed, dropped or backpressured frame are always kept. */
export function toRallarBlackBoxRtcStreamObservationSample(
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[],
    sampleEvery: number
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

function computeStreamFrameCount(settings: RallarBlackBoxRtcStreamPlanSettings, intervalMs: number): number {
    const countBound = resolvePositiveInteger(settings.count);
    const durationMs = resolvePositiveInteger(settings.durationMs);
    const durationBound = durationMs === undefined ? undefined : Math.ceil(durationMs / intervalMs);
    if (countBound === undefined) {
        return durationBound ?? 0;
    }
    return durationBound === undefined ? countBound : Math.min(countBound, durationBound);
}

function toStreamPlaceholderText(
    text: string,
    context: RallarBlackBoxRtcStreamPlaceholderContext
): string | number {
    const exact = STREAM_EXACT_PLACEHOLDER_PATTERN.exec(text);
    if (exact) {
        return resolveStreamPlaceholderValue(exact[1], context);
    }
    return text.replace(
        STREAM_PLACEHOLDER_PATTERN,
        (_match, name: string) => String(resolveStreamPlaceholderValue(name, context))
    );
}

function resolveStreamPlaceholderValue(
    name: string,
    context: RallarBlackBoxRtcStreamPlaceholderContext
): string | number {
    return isStreamPlaceholderName(name) ? context[name] : '';
}

function isStreamPlaceholderName(name: string): name is StreamPlaceholderName {
    return STREAM_PLACEHOLDER_NAMES.some((candidate) => candidate === name);
}

function computeStreamFrameCounts(
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[]
): StreamFrameCounts {
    return {
        scheduledFrames: observations.length,
        attemptedFrames: observations.filter((observation) => !observation.dropped).length,
        completedFrames: observations.filter((observation) => observation.ok && !observation.dropped).length,
        failedFrames: observations.filter((observation) => !observation.ok).length,
        droppedFrames: observations.filter((observation) => observation.dropped).length,
        backpressureCount: observations.filter((observation) => observation.backpressured).length
    };
}

function computeStreamPacing(
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[],
    intervalMs: number
): RallarBlackBoxTestRtcStreamResultValue['pacing'] {
    const startDrifts = observations.map((observation) => observation.startDriftMs);
    const jitters = startDrifts.slice(1).map((drift, index) => Math.abs(drift - startDrifts[index]));
    const lateThresholdMs = Math.max(1, Math.round(Math.max(intervalMs, 1) * 0.5));
    return {
        intervalMs,
        maxStartDriftMs: computeMaximum(startDrifts),
        averageStartDriftMs: computeAverage(startDrifts),
        maxJitterMs: computeMaximum(jitters),
        lateFrameCount: startDrifts.filter((drift) => drift > lateThresholdMs).length
    };
}

function computeStreamDuration(
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[]
): RallarBlackBoxTestRtcStreamResultValue['duration'] {
    const durations = observations
        .filter((observation) => !observation.dropped)
        .map((observation) => observation.durationMs);
    return {
        minMs: durations.length > 0 ? Math.min(...durations) : undefined,
        p50Ms: computePercentile(durations, 0.5),
        p95Ms: computePercentile(durations, 0.95),
        p99Ms: computePercentile(durations, 0.99),
        maxMs: computeMaximum(durations),
        averageMs: computeAverage(durations)
    };
}

function computeStreamThresholdFailures(
    value: RallarBlackBoxTestRtcStreamResultValue,
    thresholds: RallarBlackBoxTestRtcStreamThresholds
): readonly RallarBlackBoxTestRtcStreamThresholdFailure[] {
    return STREAM_THRESHOLD_RULES.flatMap((rule) => {
        const threshold = thresholds[rule.name];
        const actual = rule.toActual(value);
        if (threshold === undefined || actual === undefined) {
            return [];
        }
        if (rule.bound === 'maximum') {
            return actual > threshold
                ? [{
                    name: rule.name,
                    category: rule.category,
                    threshold,
                    actual,
                    message: `${rule.label} was ${actual} ms, above the configured ${threshold} ms maximum.`
                }]
                : [];
        }
        return actual < threshold
            ? [{
                name: rule.name,
                category: rule.category,
                threshold,
                actual,
                message: `${rule.label} was ${actual}, below the configured ${threshold} minimum.`
            }]
            : [];
    });
}

function computeFrameRate(frames: number, elapsedMs: number): number | undefined {
    return elapsedMs > 0 ? toRoundedMetric((frames * 1000) / elapsedMs) : undefined;
}

function computePercentile(values: readonly number[], percentileValue: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
    return sorted[index];
}

function computeAverage(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return toRoundedMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function computeMaximum(values: readonly number[]): number | undefined {
    return values.length > 0 ? Math.max(...values) : undefined;
}

function toRoundedMetric(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}
