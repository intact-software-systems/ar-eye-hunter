/**
 * The nearest-rank percentile: the value at rank ceil(fraction * n) of the ascending values, where a fraction at or
 * below 0 reads the smallest and at or above 1 the largest. No values, or a fraction that is not finite, has no answer.
 */
export function computeNearestRank(values: readonly number[], fraction: number): number | undefined {
    if (values.length === 0 || !Number.isFinite(fraction)) {
        return undefined;
    }
    const ascending = [...values].sort((left, right) => left - right);
    const index = Math.min(ascending.length - 1, Math.max(0, Math.ceil(fraction * ascending.length) - 1));
    return ascending[index];
}
