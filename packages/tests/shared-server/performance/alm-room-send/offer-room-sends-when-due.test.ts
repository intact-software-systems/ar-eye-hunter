import { describe, expect, it } from 'vitest';

import { offerRoomSendsWhenDue } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/offer-room-sends-when-due.ts';

interface DueSend {
    readonly msgId: string;
    readonly dueAtMs: number;
}

/** A clock a sleep moves: each sleep adds what `advanceMs` answers for the delay it was asked. */
interface SteppedClock {
    nowMs: number;
    readonly log: string[];
    readonly sleep: (delayMs: number) => Promise<void>;
}

function createSteppedClock(startMs: number, advanceMs: (delayMs: number) => number): SteppedClock {
    const clock: SteppedClock = {
        nowMs: startMs,
        log: [],
        sleep: async (delayMs) => {
            clock.log.push(`sleep ${delayMs}`);
            clock.nowMs += advanceMs(delayMs);
        }
    };
    return clock;
}

describe('offerRoomSendsWhenDue', () => {
    it('waits out a timer that fired early, and offers a send only once its due instant is reached', async () => {
        // Every sleep returns a quarter of a millisecond before the delay it was asked ran out.
        const clock = createSteppedClock(1_000, (delayMs) => Math.max(delayMs - 0.25, 0.125));
        const sends: readonly DueSend[] = [{ msgId: 'send-1', dueAtMs: 1_010 }];

        await offerRoomSendsWhenDue({
            sends,
            nowMs: () => clock.nowMs,
            sleep: clock.sleep,
            offer: (send) => clock.log.push(`offer ${send.msgId} at ${clock.nowMs}`)
        });

        expect(clock.log).toEqual(['sleep 10', 'sleep 0.25', 'sleep 0.125', 'offer send-1 at 1010']);
    });

    it('arms each wait against the send\'s own due instant, so a late offer does not push the next one back', async () => {
        // Every sleep overruns by 30 ms: the first offer is 30 ms late, and the second is still due at its own instant.
        const clock = createSteppedClock(2_000, (delayMs) => delayMs + 30);
        const sends: readonly DueSend[] = [
            { msgId: 'send-1', dueAtMs: 2_100 },
            { msgId: 'send-2', dueAtMs: 2_200 },
            { msgId: 'send-3', dueAtMs: 2_210 }
        ];

        await offerRoomSendsWhenDue({
            sends,
            nowMs: () => clock.nowMs,
            sleep: clock.sleep,
            offer: (send) => clock.log.push(`offer ${send.msgId} at ${clock.nowMs}`)
        });

        expect(clock.log).toEqual([
            'sleep 100',
            'offer send-1 at 2130',
            'sleep 70',
            'offer send-2 at 2230',
            'offer send-3 at 2230'
        ]);
    });

    it('offers nothing and waits for nothing when there is no send', async () => {
        const clock = createSteppedClock(0, (delayMs) => delayMs);

        await offerRoomSendsWhenDue({
            sends: [],
            nowMs: () => clock.nowMs,
            sleep: clock.sleep,
            offer: () => clock.log.push('offer')
        });

        expect(clock.log).toEqual([]);
    });
});
