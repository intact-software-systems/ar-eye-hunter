import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { GrowthReader } from './growth-surface.ts';

/** One sample as its source file recorded it. */
export interface GrowthSamplePoint {
    readonly atEpochMs: number;
    /** The agent a browser reading came from; null for a process or database reading. */
    readonly agentId: string | null;
    /** The API process a heap reading came from, judged on its own; null for every other reading. */
    readonly serviceId: string | null;
    readonly value: ApiJsonValue;
}

/** One reading of one surface, measured from the start of the run's window. */
export interface GrowthSeriesPoint {
    readonly elapsedMs: number;
    readonly value: number;
}

/** One browser agent's own reading, before the agents' readings meet in one series. */
export interface GrowthAgentReading extends GrowthSeriesPoint {
    readonly agentId: string;
}

export interface GrowthPlateau {
    readonly atElapsedMs: number;
    readonly value: number;
}

/** One reading of a sample the reader found a number in, with the agent it came from, if any. */
interface GrowthReading extends GrowthSeriesPoint {
    readonly agentId: string | null;
}

const HOUR_MS = 3_600_000;

/** Browser agents report on their own clocks, so their readings meet in buckets of the sampler's interval. */
const AGENT_BUCKET_MS = 30_000;

/** The first plateau is the median of this window, starting where the surface's warm-up ends. */
const PLATEAU_WINDOW_MS = 300_000;

export function toGrowthSeries(
    points: readonly GrowthSamplePoint[],
    reader: GrowthReader,
    windowStartedAtEpochMs: number
): readonly GrowthSeriesPoint[] {
    const readings = toGrowthReadings(points, reader, windowStartedAtEpochMs);
    const byAgent = readings.some((reading) => reading.agentId !== null);
    return byAgent ? toAgentBucketMaxima(readings) : readings.map(({ elapsedMs, value }) => ({ elapsedMs, value }));
}

export function toGrowthAgentReadings(
    points: readonly GrowthSamplePoint[],
    reader: GrowthReader,
    windowStartedAtEpochMs: number
): readonly GrowthAgentReading[] {
    return toGrowthReadings(points, reader, windowStartedAtEpochMs).flatMap(({ elapsedMs, agentId, value }) =>
        agentId === null ? [] : [{ elapsedMs, agentId, value }]
    );
}

/** One agent's own series, kept apart from every other agent's. */
export interface GrowthAgentSeries {
    readonly agentId: string;
    readonly series: readonly GrowthSeriesPoint[];
}

/**
 * The median of each agent's readings from `fromElapsedMs` on in each bucket: one series per agent that reported
 * anything, one point per bucket, at its start, the agents in name order. An agent with no reading from
 * `fromElapsedMs` on has an empty series. Only complete buckets count: a bucket the agent's own last reading falls
 * inside is left out.
 */
export function computeGrowthAgentBucketMedians(
    readings: readonly GrowthAgentReading[],
    bucketMs: number,
    fromElapsedMs: number
): readonly GrowthAgentSeries[] {
    const byAgent = new Map<string, GrowthAgentReading[]>();
    for (const reading of readings) {
        byAgent.set(reading.agentId, [...(byAgent.get(reading.agentId) ?? []), reading]);
    }
    return [...byAgent.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([agentId, own]) => ({
            agentId,
            series: toCompleteBucketMedians(own.filter((reading) => reading.elapsedMs >= fromElapsedMs), bucketMs)
        }));
}

/** One agent's readings as bucket medians, leaving out the bucket its last reading falls inside. */
function toCompleteBucketMedians(
    readings: readonly GrowthAgentReading[],
    bucketMs: number
): readonly GrowthSeriesPoint[] {
    const lastElapsedMs = readings.reduce((last, reading) => Math.max(last, reading.elapsedMs), 0);
    const byBucket = new Map<number, number[]>();
    for (const reading of readings) {
        const bucket = Math.floor(reading.elapsedMs / bucketMs) * bucketMs;
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), reading.value]);
    }
    return [...byBucket.entries()]
        .filter(([bucket]) => bucket + bucketMs <= lastElapsedMs)
        .sort(([left], [right]) => left - right)
        .map(([bucket, values]) => ({ elapsedMs: bucket, value: computeGrowthMedian(values) }));
}

function toGrowthReadings(
    points: readonly GrowthSamplePoint[],
    reader: GrowthReader,
    windowStartedAtEpochMs: number
): readonly GrowthReading[] {
    return points.flatMap((point) => {
        const elapsedMs = point.atEpochMs - windowStartedAtEpochMs;
        const value = toGrowthValue(point.value, reader);
        return elapsedMs >= 0 && value !== undefined ? [{ elapsedMs, agentId: point.agentId, value }] : [];
    });
}

function toGrowthValue(value: ApiJsonValue, reader: GrowthReader): number | undefined {
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

function toAgentBucketMaxima(readings: readonly GrowthSeriesPoint[]): readonly GrowthSeriesPoint[] {
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
export function computeGrowthSlopePerHour(
    series: readonly GrowthSeriesPoint[],
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

export function computeGrowthPlateau(
    series: readonly GrowthSeriesPoint[],
    warmUpMs: number
): GrowthPlateau | null {
    const window = series
        .filter((point) => point.elapsedMs >= warmUpMs && point.elapsedMs <= warmUpMs + PLATEAU_WINDOW_MS)
        .map((point) => point.value);
    return window.length === 0 ? null : { atElapsedMs: warmUpMs, value: computeGrowthMedian(window) };
}

/** The median of a non-empty list. */
function computeGrowthMedian(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function computeGrowthMax(series: readonly GrowthSeriesPoint[]): number | null {
    return series.length === 0
        ? null
        : series.reduce((max, point) => Math.max(max, point.value), Number.NEGATIVE_INFINITY);
}

export function toGrowthLastElapsedMs(series: readonly GrowthSeriesPoint[]): number {
    return series.length === 0 ? 0 : series[series.length - 1]!.elapsedMs;
}

export function toGrowthMinutes(milliseconds: number): number {
    return Math.round((milliseconds / 60_000) * 10) / 10;
}

export function toGrowthRounded(value: number): number {
    return Math.round(value * 100) / 100;
}
