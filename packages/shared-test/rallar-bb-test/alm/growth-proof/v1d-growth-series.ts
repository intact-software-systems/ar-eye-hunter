import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { V1dGrowthReader } from './v1d-growth-surface.ts';

/** One sample as its source file recorded it. */
export interface V1dGrowthSamplePoint {
    readonly atEpochMs: number;
    /** The agent a browser reading came from; null for a process or database reading. */
    readonly agentId: string | null;
    readonly value: ApiJsonValue;
}

/** One reading of one surface, measured from the start of the run's window. */
export interface V1dGrowthSeriesPoint {
    readonly elapsedMs: number;
    readonly value: number;
}

export interface V1dGrowthPlateau {
    readonly atElapsedMs: number;
    readonly value: number;
}

const HOUR_MS = 3_600_000;

/** Browser agents report on their own clocks, so their readings meet in buckets of the sampler's interval. */
const AGENT_BUCKET_MS = 30_000;

/** The first plateau is the median of this window, starting where the surface's warm-up ends. */
const PLATEAU_WINDOW_MS = 300_000;

export function toV1dGrowthSeries(
    points: readonly V1dGrowthSamplePoint[],
    reader: V1dGrowthReader,
    windowStartedAtEpochMs: number
): readonly V1dGrowthSeriesPoint[] {
    const readings = points
        .map((point) => ({
            elapsedMs: point.atEpochMs - windowStartedAtEpochMs,
            agentId: point.agentId,
            value: readV1dGrowthValue(point.value, reader)
        }))
        .filter((reading): reading is { elapsedMs: number; agentId: string | null; value: number; } =>
            reading.elapsedMs >= 0 && reading.value !== undefined
        );
    const byAgent = readings.some((reading) => reading.agentId !== null);
    return byAgent ? toAgentBucketMaxima(readings) : readings.map(({ elapsedMs, value }) => ({ elapsedMs, value }));
}

function readV1dGrowthValue(value: ApiJsonValue, reader: V1dGrowthReader): number | undefined {
    let current: ApiJsonValue = value;
    for (const step of reader.path) {
        const next = Array.isArray(current) && step === 'length'
            ? current.length
            : isApiJsonObject(current)
            ? current[step]
            : undefined;
        if (next === undefined) {
            return reader.absent === 'zero' && isApiJsonObject(current) ? 0 : undefined;
        }
        current = next;
    }
    return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

export function isApiJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toAgentBucketMaxima(readings: readonly V1dGrowthSeriesPoint[]): readonly V1dGrowthSeriesPoint[] {
    const maxima = new Map<number, number>();
    for (const reading of readings) {
        const bucket = Math.floor(reading.elapsedMs / AGENT_BUCKET_MS) * AGENT_BUCKET_MS;
        maxima.set(bucket, Math.max(maxima.get(bucket) ?? Number.NEGATIVE_INFINITY, reading.value));
    }
    return [...maxima.entries()]
        .sort(([left], [right]) => left - right)
        .map(([elapsedMs, value]) => ({ elapsedMs, value }));
}

/** The least-squares slope per hour of the points from `fromElapsedMs` on; null below two distinct instants. */
export function computeV1dGrowthSlopePerHour(
    series: readonly V1dGrowthSeriesPoint[],
    fromElapsedMs: number
): number | null {
    const window = series.filter((point) => point.elapsedMs >= fromElapsedMs);
    if (window.length < 2) {
        return null;
    }
    const meanTime = window.reduce((sum, point) => sum + point.elapsedMs, 0) / window.length;
    const meanValue = window.reduce((sum, point) => sum + point.value, 0) / window.length;
    const covariance = window.reduce((sum, point) => sum + (point.elapsedMs - meanTime) * (point.value - meanValue), 0);
    const variance = window.reduce((sum, point) => sum + (point.elapsedMs - meanTime) ** 2, 0);
    return variance === 0 ? null : (covariance / variance) * HOUR_MS;
}

export function computeV1dGrowthPlateau(
    series: readonly V1dGrowthSeriesPoint[],
    warmUpMs: number
): V1dGrowthPlateau | null {
    const window = series
        .filter((point) => point.elapsedMs >= warmUpMs && point.elapsedMs <= warmUpMs + PLATEAU_WINDOW_MS)
        .map((point) => point.value)
        .sort((left, right) => left - right);
    if (window.length === 0) {
        return null;
    }
    const middle = Math.floor(window.length / 2);
    const median = window.length % 2 === 1 ? window[middle]! : (window[middle - 1]! + window[middle]!) / 2;
    return { atElapsedMs: warmUpMs, value: median };
}

export function computeV1dGrowthMax(series: readonly V1dGrowthSeriesPoint[]): number | null {
    return series.length === 0 ? null : Math.max(...series.map((point) => point.value));
}
