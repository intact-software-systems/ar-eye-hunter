import type { DistributedRunTimingSummary } from '../distributed-artifact-analysis.ts';
import type { DistributedRunTimingRecord } from '../distributed-artifact-analysis/decode-distributed-run-stream-summary.ts';

export interface NumberExtrema {
    readonly min: number;
    readonly max: number;
}

/** Sampled durations win; without samples the summary repeats the recorded timing. */
export function computeTimingSummary(
    recorded: DistributedRunTimingRecord,
    values: readonly number[]
): DistributedRunTimingSummary {
    if (values.length > 0) {
        const p50Ms = computePercentile(values, 0.5);
        const p95Ms = computePercentile(values, 0.95);
        const p99Ms = computePercentile(values, 0.99);
        const extrema = computeNumberExtrema(values);
        return {
            count: values.length,
            minMs: extrema?.min,
            p50Ms,
            p95Ms,
            p99Ms,
            maxMs: extrema?.max,
            averageMs: computeAverage(values),
            spreadRatio: computeSpreadRatio(p50Ms, p95Ms),
            outlierCount: computeOutlierCount(values, p50Ms, p95Ms)
        };
    }
    return {
        count: recorded.count ?? 0,
        minMs: recorded.minMs,
        p50Ms: recorded.p50Ms,
        p95Ms: recorded.p95Ms,
        p99Ms: recorded.p99Ms,
        maxMs: recorded.maxMs,
        averageMs: recorded.averageMs,
        spreadRatio: computeSpreadRatio(recorded.p50Ms, recorded.p95Ms),
        outlierCount: recorded.outlierCount ?? 0
    };
}

/** The nearest-rank percentile; absent for no values. */
export function computePercentile(values: readonly number[], percentileValue: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
    return sorted[index];
}

/** Absent for no values. */
export function computeAverage(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return toRoundedMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Absent for no values. */
export function computeNumberExtrema(values: readonly number[]): NumberExtrema | undefined {
    if (values.length === 0) {
        return undefined;
    }
    let min = values[0];
    let max = values[0];
    for (let index = 1; index < values.length; index += 1) {
        const value = values[index];
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
    }
    return { min, max };
}

/** Absent when no value is defined. */
export function computeMaxNumber(values: readonly (number | undefined)[]): number | undefined {
    let max: number | undefined;
    for (const value of values) {
        if (value !== undefined && (max === undefined || value > max)) {
            max = value;
        }
    }
    return max;
}

export function toRoundedMetric(value: number): number {
    return Math.round(value * 100) / 100;
}

function computeSpreadRatio(p50Ms: number | undefined, p95Ms: number | undefined): number | undefined {
    return p50Ms !== undefined && p95Ms !== undefined
        ? toRoundedMetric(p95Ms / Math.max(1, p50Ms))
        : undefined;
}

function computeOutlierCount(
    values: readonly number[],
    p50Ms: number | undefined,
    p95Ms: number | undefined
): number {
    if (values.length < 2 || p50Ms === undefined || p95Ms === undefined || p95Ms <= p50Ms) {
        return 0;
    }
    return values.filter((value) => value >= p95Ms && value > p50Ms).length;
}
