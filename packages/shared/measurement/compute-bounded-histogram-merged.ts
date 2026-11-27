import { Either } from '../resilience/Either.ts';
import type { BoundedHistogram } from './bounded-histogram.ts';

/**
 * Two histograms as the one that recording every sample of both would give; its `sum` is exactly `left.sum + right.sum`,
 * so for samples that are not whole numbers it can differ from that histogram's in its last digits. Only histograms on
 * the same bounds have buckets that mean the same, so any other pair is refused as a value. Neither histogram is
 * validated again: each is one this package created, recorded into or decoded.
 */
export function computeBoundedHistogramMerged(
    left: BoundedHistogram,
    right: BoundedHistogram
): Either<string, BoundedHistogram> {
    const sameBounds = left.upperBounds.length === right.upperBounds.length &&
        left.upperBounds.every((bound, index) => bound === right.upperBounds[index]);
    if (!sameBounds) {
        return Either.ofLeft('A histogram merges only with a histogram on the same bounds');
    }
    return Either.ofRight({
        upperBounds: left.upperBounds,
        bucketCounts: left.bucketCounts.map((count, bucket) => count + right.bucketCounts[bucket]),
        count: left.count + right.count,
        sum: left.sum + right.sum,
        min: left.min === null || right.min === null ? left.min ?? right.min : Math.min(left.min, right.min),
        max: left.max === null || right.max === null ? left.max ?? right.max : Math.max(left.max, right.max)
    });
}
