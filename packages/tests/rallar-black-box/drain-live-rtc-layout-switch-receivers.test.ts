import { describe, expect, it } from 'vitest';

import { RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS } from '@shared-test/rallar-bb-test/rtc-stream.ts';

import { drainLiveRtcLayoutSwitchReceivers } from '../../../tests/playwright/rallar-black-box/drain-live-rtc-layout-switch-receivers.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/live-rtc-layout-switch-test-timeouts.ts';

/** How long each fake run read takes, unlike any interval, so an overrun past the deadline shows. */
const READ_MS = 400;

interface DrainClock {
    readonly now: () => number;
    /** When each hold ended, on the drain's clock. */
    readonly heldUntil: number[];
}

/** A drain whose run reads each take `READ_MS` and report the next of `missingCounts`, the last repeating. */
async function drainWith(missingCounts: readonly number[]) {
    let nowMs = 0;
    let reads = 0;
    const clock: DrainClock = { now: () => nowMs, heldUntil: [] };
    const drained = await drainLiveRtcLayoutSwitchReceivers({
        readEvents: async () => {
            nowMs += READ_MS;
            reads += 1;
            return [{ kind: `read-${reads}` }] satisfies LiveRtcControlClient.Event[];
        },
        countMissing: () => missingCounts[Math.min(reads, missingCounts.length) - 1],
        hold: async (ms) => {
            nowMs += ms;
            clock.heldUntil.push(nowMs);
        },
        now: clock.now
    });
    return { drained, clock, reads };
}

describe('the layout-switch receivers\' drain', () => {
    it('ends once every receiver holds every frame, with the last read\'s events', async () => {
        const { drained, reads } = await drainWith([3, 1, 0]);

        expect(drained).toEqual({ endedBy: 'complete', events: [{ kind: 'read-3' }] });
        expect(reads).toBe(3);
    });

    it('ends once the missing count stalls for the stream\'s own drain bound', async () => {
        const { drained, clock } = await drainWith([5, 2]);

        expect(drained.endedBy).toBe('stall');
        expect(clock.now()).toBeGreaterThanOrEqual(READ_MS + RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS);
        expect(clock.now()).toBeLessThan(LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS);
    });

    // The drain checked its deadline and then held a whole interval, so a steady trickle ran up to an interval past the
    // 65 s its test counts, and ended without saying the deadline ended it.
    it('holds no further than its deadline and says the deadline ended it, at most one read past its limit', async () => {
        const trickle = Array.from({ length: 1_000 }, (_value, index) => 1_000 - index);
        const { drained, clock } = await drainWith(trickle);

        expect(drained.endedBy).toBe('deadline');
        expect(clock.now()).toBeLessThanOrEqual(LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS + READ_MS);
        expect(Math.max(...clock.heldUntil)).toBeLessThanOrEqual(LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS);
    });
});
