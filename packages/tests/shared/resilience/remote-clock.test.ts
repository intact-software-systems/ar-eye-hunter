import { describe, expect, it } from 'vitest';

import { computeRemoteClockWindow } from '@shared/resilience/remote-clock.ts';

const observation = {
    remoteEpochMs: 1_800_000_000_000,
    requestStartedAtMonotonicMs: 100,
    responseReceivedAtMonotonicMs: 120
};
const policy = { maxRoundTripMs: 100, maxAgeMs: 30_000, maxRelativeDriftPpm: 100, maxMonotonicErrorMs: 0 };

describe('remote-clock uncertainty', () => {
    it('bounds asymmetric transit without using the local wall clock', () => {
        const result = computeRemoteClockWindow({ observation, policy, nowMonotonicMs: 120 });
        expect(result.right).toEqual({ earliestEpochMs: 1_799_999_999_999, latestEpochMs: 1_800_000_000_022 });
    });

    it('advances with monotonic elapsed time and expands the drift bound', () => {
        const result = computeRemoteClockWindow({ observation, policy, nowMonotonicMs: 10_120 });
        expect(result.right).toEqual({ earliestEpochMs: 1_800_000_009_998, latestEpochMs: 1_800_000_010_023 });
    });

    it('encloses both extremes of quantized monotonic readings', () => {
        const result = computeRemoteClockWindow({
            observation,
            policy: { ...policy, maxRelativeDriftPpm: 0, maxMonotonicErrorMs: 5 },
            nowMonotonicMs: 220
        });
        // Independent endpoint errors permit actual elapsed time from 90 ms to 130 ms.
        expect(result.right?.earliestEpochMs).toBeLessThanOrEqual(1_800_000_000_090);
        expect(result.right?.latestEpochMs).toBeGreaterThanOrEqual(1_800_000_000_130);
        expect(result.right!.latestEpochMs - result.right!.earliestEpochMs).toBeLessThanOrEqual(44);
    });

    it.each([
        { maxRoundTripMs: 29, maxAgeMs: 30_000, nowMonotonicMs: 120 },
        { maxRoundTripMs: 100, maxAgeMs: 109, nowMonotonicMs: 220 }
    ])('refuses a sample whose true duration could exceed policy: %j', ({ nowMonotonicMs, ...limits }) => {
        expect(
            computeRemoteClockWindow({
                observation,
                policy: { ...policy, ...limits, maxMonotonicErrorMs: 5 },
                nowMonotonicMs
            }).left
        ).toBeDefined();
    });

    it.each([
        ['stale sample', { nowMonotonicMs: 30_121 }],
        ['backward monotonic time', { nowMonotonicMs: 119 }],
        ['non-finite time', { nowMonotonicMs: NaN }],
        ['excessive transit', { observation: { ...observation, requestStartedAtMonotonicMs: 0 } }],
        ['reversed request interval', { observation: { ...observation, requestStartedAtMonotonicMs: 121 } }],
        ['invalid remote time', { observation: { ...observation, remoteEpochMs: -1 } }],
        ['overflow', { observation: { ...observation, remoteEpochMs: Number.MAX_SAFE_INTEGER } }],
        ['invalid policy', { policy: { ...policy, maxRelativeDriftPpm: -1 } }],
        ['invalid precision', { policy: { ...policy, maxMonotonicErrorMs: -1 } }]
    ])('refuses %s rather than claiming current time', (_name, changes) => {
        expect(computeRemoteClockWindow({ observation, policy, nowMonotonicMs: 120, ...changes }).left)
            .toBeDefined();
    });
});
