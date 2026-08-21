import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { describe, expect, it } from 'vitest';

describe('ResourceInboxRetryPolicy', () => {
    it('schedules failures after attempts one through nineteen exactly', () => {
        const expected = [
            1,
            2,
            4,
            8,
            16,
            1_000,
            2_000,
            4_000,
            8_000,
            16_000,
            30_000,
            30_000,
            30_000,
            30_000,
            30_000,
            30_000,
            30_000,
            30_000,
            30_000
        ];

        expect(expected.map((_, index) => retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, index + 1, 0.5))).toEqual(
            expected.map((delayMs) => ({ status: 'retry', delayMs }))
        );
    });

    it('fails retryable work after the twentieth processing attempt', () => {
        expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 20, 0.5))
            .toEqual({ status: 'failed', delayMs: null });
    });

    it('applies symmetric twenty-percent jitter with integer rounding', () => {
        expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 7, 0))
            .toEqual({ status: 'retry', delayMs: 1_600 });
        expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 7, 1))
            .toEqual({ status: 'retry', delayMs: 2_400 });
    });

    it('never jitters a nonzero delay below one millisecond', () => {
        expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 1, 0))
            .toEqual({ status: 'retry', delayMs: 1 });
    });

    it('publishes the mandatory retry and fairness defaults', () => {
        expect(DEFAULT_RESOURCE_INBOX_RETRY_POLICY).toMatchObject({
            maxAttempts: 20,
            maxDelayMs: 30_000,
            jitterRatio: 0.2,
            staleDueThresholdMs: 30_000
        });
    });
});
