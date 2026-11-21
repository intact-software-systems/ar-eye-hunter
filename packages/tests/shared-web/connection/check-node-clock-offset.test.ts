import { expect, it } from 'vitest';

import { checkNodeClockOffset } from '../../../../examples/browser-startup-room/check-node-clock-offset.ts';

const calibration = { remoteEpochMs: 10_000, requestStartedAtMonotonicMs: 0, responseReceivedAtMonotonicMs: 0 };

it('projects staggered samples to one instant before comparing the two nodes', () => {
    const enforcement = { remoteEpochMs: 10_100, requestStartedAtMonotonicMs: 100, responseReceivedAtMonotonicMs: 100 };
    const result = checkNodeClockOffset({ calibration, enforcement }, 100, 20);
    expect(result.verdict).toBe('within');
    expect(result.minimumOffsetMs).toBeLessThanOrEqual(0);
    expect(result.maximumOffsetMs).toBeGreaterThanOrEqual(0);
});

it.each([-100, 100])('classifies a signed %i ms shift including both equality boundaries', (shift) => {
    const pair = { calibration, enforcement: { ...calibration, remoteEpochMs: calibration.remoteEpochMs + shift } };
    const result = checkNodeClockOffset(pair, 0, 0);
    expect(result.verdict).toBe('outside');
    expect(result.minimumOffsetMs).toBeLessThanOrEqual(shift);
    expect(result.maximumOffsetMs).toBeGreaterThanOrEqual(shift);
    const bounds = [Math.abs(result.minimumOffsetMs), Math.abs(result.maximumOffsetMs)];
    expect(checkNodeClockOffset(pair, 0, Math.min(...bounds)).verdict).toBe('inconclusive');
    expect(checkNodeClockOffset(pair, 0, Math.max(...bounds)).verdict).toBe('within');
});

it('rejects stale observations and invalid budgets', () => {
    const pair = { calibration, enforcement: calibration };
    expect(() => checkNodeClockOffset(pair, 3_000, 20)).toThrow(/expired/);
    expect(() => checkNodeClockOffset(pair, 0, -1)).toThrow(RangeError);
});
