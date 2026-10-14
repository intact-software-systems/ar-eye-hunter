import type { RateLimiter } from './Resilience.ts';

/** A nonspending forecast; the next admission must still pass the limiter's actual allow operation. */
export function computeRateLimiterRetryAfterMs(rateLimiter: RateLimiter, nowEpochMs: number): number | undefined {
    if (rateLimiter.isAllowedAt(nowEpochMs)) {
        return 0;
    }
    let earliestEligibleAtMs: number | undefined;
    for (const [bucket, status] of rateLimiter.slidingWindow.counterByBucket) {
        // Reads include the bucket's ending timestamp, so eligibility can change at the next integer millisecond.
        const candidateAtMs =
            Math.floor(status.createdTs + bucket.to - bucket.from + rateLimiter.slidingWindow.windowMs) + 1;
        if (
            Number.isSafeInteger(candidateAtMs) && candidateAtMs > nowEpochMs &&
            rateLimiter.isAllowedAt(candidateAtMs)
        ) {
            earliestEligibleAtMs = Math.min(earliestEligibleAtMs ?? candidateAtMs, candidateAtMs);
        }
    }
    return earliestEligibleAtMs === undefined ? undefined : earliestEligibleAtMs - nowEpochMs;
}
