export interface SendToDispatchPercentiles {
    readonly p50Ms: number;
    readonly p95Ms: number;
}

/** Nearest-rank percentiles, rounded to 0.1 ms, of one run's measured sends. */
export function computeSendToDispatchPercentiles(
    samplesMs: readonly number[]
): SendToDispatchPercentiles {
    const sorted = [...samplesMs].sort((left, right) => left - right);
    return { p50Ms: computeNearestRank(sorted, 0.5), p95Ms: computeNearestRank(sorted, 0.95) };
}

/** The middle of the runs' values: the figure a configuration reports across its runs. */
export function computeMedian(values: readonly number[]): number {
    return computeNearestRank([...values].sort((left, right) => left - right), 0.5);
}

function computeNearestRank(sorted: readonly number[], fraction: number): number {
    const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
    return Math.round((sorted[index] ?? Number.NaN) * 10) / 10;
}
