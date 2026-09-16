import type { DistributedRunLatencySummary } from './distributed-run-row-contracts.ts';

export function summarizeDistributedRunLatencies(values: readonly number[]): DistributedRunLatencySummary {
    if (values.length === 0) {
        return { count: 0 };
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
        averageMs: average(sorted)
    };
}

export function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: readonly number[], quantile: number): number | undefined {
    if (sortedValues.length === 0) {
        return undefined;
    }
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * quantile) - 1)
    );
    return sortedValues[index];
}

export function maxFiniteNumber(values: readonly (number | undefined)[]): number | undefined {
    let max: number | undefined;
    for (const value of values) {
        if (isFiniteDurationMs(value) && (max === undefined || value > max)) {
            max = value;
        }
    }
    return max;
}

export function durationBetween(start: number | undefined, end: number | undefined): number | undefined {
    return start !== undefined && end !== undefined && end >= start
        ? end - start
        : undefined;
}

export function isFiniteDurationMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
