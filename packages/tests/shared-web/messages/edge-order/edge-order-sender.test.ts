import { describe, expect, it } from 'vitest';

import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';

const RETRIED_UNTIL = (expiresAtMs: number): EdgeOrderSender.SendDto => ({ expiresAtMs, retried: true });
const NEVER_RETRIED: EdgeOrderSender.SendDto = { expiresAtMs: 9_000, retried: false };

describe('EdgeOrderSender', () => {
    it('numbers the sends of its stream from 1, one position per call', () => {
        const sender = new EdgeOrderSender('stream-a');

        // Three calls in one turn, as an application that sends in a loop makes them: nothing is awaited between.
        const stamps = [10_000, 10_000, 10_000].map((expiresAtMs) => sender.stampSend(RETRIED_UNTIL(expiresAtMs)));

        expect(stamps.map((stamp) => stamp.position)).toEqual([1, 2, 3]);
        expect(stamps.map((stamp) => stamp.streamId)).toEqual(['stream-a', 'stream-a', 'stream-a']);
    });

    it('states the latest deadline among earlier open sends, and none once they have ended', () => {
        const sender = new EdgeOrderSender('stream-a');

        expect(sender.stampSend(RETRIED_UNTIL(10_000))).toEqual({
            streamId: 'stream-a',
            position: 1,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: undefined
        });
        expect(sender.stampSend(RETRIED_UNTIL(12_000))).toEqual({
            streamId: 'stream-a',
            position: 2,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 10_000
        });
        // The latest, not the most recent: send 2 outlives send 3.
        expect(sender.stampSend(RETRIED_UNTIL(11_000))).toEqual({
            streamId: 'stream-a',
            position: 3,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 12_000
        });

        sender.endSend(1);
        sender.endSend(2);
        expect(sender.stampSend(RETRIED_UNTIL(13_000))).toEqual({
            streamId: 'stream-a',
            position: 4,
            lowestOpenPosition: 3,
            earlierCanArriveUntilMs: 11_000
        });

        sender.endSend(3);
        sender.endSend(4);
        expect(sender.stampSend(RETRIED_UNTIL(14_000))).toEqual({
            streamId: 'stream-a',
            position: 5,
            lowestOpenPosition: 5,
            earlierCanArriveUntilMs: undefined
        });
    });

    it('keeps the lowest open position at the oldest send that has not ended, whatever order they end in', () => {
        const sender = new EdgeOrderSender('stream-a');
        sender.stampSend(RETRIED_UNTIL(10_000));
        sender.stampSend(RETRIED_UNTIL(10_000));
        sender.stampSend(RETRIED_UNTIL(10_000));

        sender.endSend(2);
        expect(sender.stampSend(RETRIED_UNTIL(10_000)).lowestOpenPosition).toBe(1);

        sender.endSend(1);
        expect(sender.stampSend(RETRIED_UNTIL(10_000)).lowestOpenPosition).toBe(3);
    });

    it('states no deadline for a send nothing retries, and keeps it open until it is handed to the carrier', () => {
        const sender = new EdgeOrderSender('stream-a');
        sender.stampSend(NEVER_RETRIED);

        // Nothing brings send 1 back if it is lost, so no later message tells a receiver to wait for it.
        expect(sender.stampSend(RETRIED_UNTIL(20_000))).toMatchObject({
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: undefined
        });
        expect(sender.stampSend(RETRIED_UNTIL(20_000))).toMatchObject({
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 20_000
        });

        // The carrier took send 1: for a send that asks no receipt that is its end.
        sender.endSend(1);
        expect(sender.stampSend(RETRIED_UNTIL(20_000)).lowestOpenPosition).toBe(2);
    });

    it('ignores the end of a send that has already ended', () => {
        const sender = new EdgeOrderSender('stream-a');
        sender.stampSend(RETRIED_UNTIL(10_000));
        sender.stampSend(RETRIED_UNTIL(10_000));

        sender.endSend(1);
        sender.endSend(1);

        expect(sender.stampSend(RETRIED_UNTIL(10_000))).toMatchObject({
            position: 3,
            lowestOpenPosition: 2,
            earlierCanArriveUntilMs: 10_000
        });
    });
});
