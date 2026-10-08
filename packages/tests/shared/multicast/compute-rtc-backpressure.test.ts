import { describe, expect, it } from 'vitest';

import { computeRtcBackpressure } from '@shared/multicast/compute-rtc-backpressure.ts';

const FLOW_CONTROL = {
    highWatermarkBytes: 64 * 1024,
    lowWatermarkBytes: 16 * 1024,
    overflow: 'drop-new',
    maxQueueItems: 32
} as const;

function toChannel(bufferedAmount: number) {
    return { bufferedAmount, flowControl: FLOW_CONTROL };
}

describe('the backpressure of a message\'s ready next hops (D184)', () => {
    it('is backpressured when every ready next hop holds at or above its high watermark', () => {
        expect(computeRtcBackpressure([toChannel(64 * 1024), toChannel(80 * 1024)])).toBe(true);
    });

    it('is not backpressured while one ready next hop can still take the message', () => {
        expect(computeRtcBackpressure([toChannel(64 * 1024), toChannel(64 * 1024 - 1)])).toBe(false);
    });

    it('is not backpressured below every high watermark', () => {
        expect(computeRtcBackpressure([toChannel(0), toChannel(16 * 1024)])).toBe(false);
    });

    it('is not backpressured without a ready next hop, which leaves the message to its route', () => {
        expect(computeRtcBackpressure([])).toBe(false);
    });
});
