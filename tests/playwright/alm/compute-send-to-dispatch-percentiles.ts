export interface SendToDispatchPercentiles {
    readonly p50Ms: number;
    readonly p95Ms: number;
}

export function computeSendToDispatchPercentiles(
    samplesMs: readonly number[]
): SendToDispatchPercentiles {
    return {
        p50Ms: computePercentile(samplesMs, 0.5, 10),
        p95Ms: computePercentile(samplesMs, 0.95, 10)
    };
}

/** Nearest rank, rounded to `1 / roundingScale` (10 gives 0.1). */
export function computePercentile(
    samples: readonly number[],
    fraction: number,
    roundingScale: number
): number {
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
    return Math.round((sorted[index] ?? Number.NaN) * roundingScale) / roundingScale;
}

export function computeMedian(values: readonly number[], roundingScale: number): number {
    return computePercentile(values, 0.5, roundingScale);
}
