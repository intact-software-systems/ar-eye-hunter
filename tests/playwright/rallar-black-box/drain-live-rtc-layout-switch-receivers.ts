import { RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS } from '@shared-test/rallar-bb-test/rtc-stream.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    LAYOUT_SWITCH_RECEIVER_DRAIN_POLL_INTERVAL_MS,
    LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS
} from './live-rtc-layout-switch-test-timeouts.ts';

export namespace LiveRtcLayoutSwitchDrain {
    export interface Input {
        readonly readEvents: () => Promise<readonly LiveRtcControlClient.Event[]>;
        readonly countMissing: (events: readonly LiveRtcControlClient.Event[]) => number;
        readonly hold: (ms: number) => Promise<void>;
        readonly now: () => number;
    }

    /** What ended the drain: every frame arrived, the missing count stalled, or the drain's limit passed. */
    export type EndedBy = 'complete' | 'stall' | 'deadline';

    export interface Drained {
        readonly endedBy: EndedBy;
        readonly events: readonly LiveRtcControlClient.Event[];
    }
}

/**
 * Reads the run until every receiver holds every planned frame, or until the missing count has not changed for the
 * agent stream's own drain bound (`RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS`), so frames whose events
 * are still being published are waited for as long as they keep arriving, within the receivers' drain limit. No hold
 * passes the limit, so the drain ends at most one read after it.
 */
export async function drainLiveRtcLayoutSwitchReceivers(
    input: LiveRtcLayoutSwitchDrain.Input
): Promise<LiveRtcLayoutSwitchDrain.Drained> {
    const deadlineAtMs = input.now() + LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS;
    let lastMissing = Infinity;
    let lastChangedAtMs = input.now();
    for (;;) {
        const events = await input.readEvents();
        const missing = input.countMissing(events);
        if (missing !== lastMissing) {
            lastMissing = missing;
            lastChangedAtMs = input.now();
        }
        if (missing === 0) {
            return { endedBy: 'complete', events };
        }
        if (input.now() - lastChangedAtMs >= RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS) {
            return { endedBy: 'stall', events };
        }
        if (input.now() >= deadlineAtMs) {
            return { endedBy: 'deadline', events };
        }
        await input.hold(Math.min(LAYOUT_SWITCH_RECEIVER_DRAIN_POLL_INTERVAL_MS, deadlineAtMs - input.now()));
    }
}
