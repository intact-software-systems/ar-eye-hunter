/**
 * The nearest-rank percentile: the value at rank ceil(fraction * n) of the ascending values, where a fraction at or
 * below 0 reads the smallest and at or above 1 the largest. No values, or a fraction that is not finite, has no answer.
 */
export function computeNearestRank(values: readonly number[], fraction: number): number | undefined {
    const index = computeNearestRankIndex(values.length, fraction);
    return index === undefined ? undefined : [...values].sort((left, right) => left - right)[index];
}

/** The place of that rank among `count` ascending values, counted from 0, for a reader that holds no list of them. */
export function computeNearestRankIndex(count: number, fraction: number): number | undefined {
    if (count <= 0 || !Number.isFinite(fraction)) {
        return undefined;
    }
    return Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1));
}
