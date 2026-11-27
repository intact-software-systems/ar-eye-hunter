import { describe, expect, it } from 'vitest';

import type { OrderedSendClock } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-clock.ts';
import { startOrderedSendLoopLagSampling } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/start-ordered-send-loop-lag-sampling.ts';

/** A clock whose one sleeper wakes when the test fires its timer, as late as the test says. */
interface ManualClock extends OrderedSendClock {
    readonly sleptMs: number[];
    /** Wakes the sleeper `overrunMs` after the delay it asked for ran out, and lets it run. */
    fire(overrunMs: number): Promise<void>;
}

function createManualClock(startMs: number): ManualClock {
    let nowMs = startMs;
    let wake: (() => void) | undefined;
    const sleptMs: number[] = [];
    return {
        sleptMs,
        nowMs: () => nowMs,
        nowEpochMs: () => 1_800_000_000_000 + nowMs,
        sleep: (delayMs) => {
            sleptMs.push(delayMs);
            return new Promise((resolve) => {
                wake = resolve;
            });
        },
        fire: async (overrunMs) => {
            nowMs += sleptMs[sleptMs.length - 1] + overrunMs;
            wake?.();
            await Promise.resolve();
            await Promise.resolve();
        }
    };
}

describe('startOrderedSendLoopLagSampling', () => {
    it('measures how late each tick of its timer fired, a tick armed as the one before it fired', async () => {
        const clock = createManualClock(2_000);
        const sampling = startOrderedSendLoopLagSampling(clock, 10);

        await clock.fire(0.25);
        await clock.fire(4);
        await clock.fire(0);
        const stopped = sampling.stop();
        await clock.fire(7);

        expect(await stopped).toEqual([0.25, 4, 0]);
        expect(clock.sleptMs).toEqual([10, 10, 10, 10]);
    });

    it('takes a tick that fired early for one that fired on time', async () => {
        const clock = createManualClock(0);
        const sampling = startOrderedSendLoopLagSampling(clock, 10);

        await clock.fire(-0.5);
        const stopped = sampling.stop();
        await clock.fire(0);

        expect(await stopped).toEqual([0]);
    });
});
