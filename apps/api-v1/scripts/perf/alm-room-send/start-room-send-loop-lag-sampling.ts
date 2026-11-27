import type { RoomSendClock } from './room-send-clock.ts';

export interface RoomSendLoopLagSampling {
    /** Ends the sampling and returns the lag of every tick that fired before it, in milliseconds, in order. */
    stop(): Promise<readonly number[]>;
}

/**
 * Samples how late the event loop fires a timer: it sleeps `intervalMs` through the clock, reads how much longer
 * than that the sleep took, and sleeps again at once. A tick that fired early is taken for one on time. The tick in
 * flight when the sampling is stopped is not a sample: `stop` waits for it and leaves it out.
 */
export function startRoomSendLoopLagSampling(
    clock: RoomSendClock,
    intervalMs: number
): RoomSendLoopLagSampling {
    const loopLagsMs: number[] = [];
    let sampling = true;
    const sampled = (async () => {
        while (sampling) {
            const armedAtMs = clock.nowMs();
            await clock.sleep(intervalMs);
            if (sampling) {
                loopLagsMs.push(Math.max(0, clock.nowMs() - armedAtMs - intervalMs));
            }
        }
    })();
    return {
        stop: async () => {
            sampling = false;
            await sampled;
            return loopLagsMs;
        }
    };
}
