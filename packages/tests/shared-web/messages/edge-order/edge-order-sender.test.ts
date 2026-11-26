import { describe, expect, it } from 'vitest';

import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';

const NOW_MS = 1_000;

interface ObservedSend {
    readonly position: number;
    end(): void;
}

/** Opens, stamps and observes one send as the wiring does: a position at the call, the rest once the send exists. */
function send(sender: EdgeOrderSender, expiresAtMs: number, retried = true): ObservedSend & {
    readonly stamp: ReturnType<EdgeOrderSender['stampSend']>;
} {
    const position = sender.openSend();
    const stamp = sender.stampSend(position, NOW_MS);
    let ended = false;
    sender.observeSend(position, { expiresAtMs, retried, hasEnded: () => ended });
    return {
        position,
        stamp,
        end: () => {
            ended = true;
        }
    };
}

describe('EdgeOrderSender', () => {
    it('numbers the sends of its stream from 1, one position per call', () => {
        const sender = new EdgeOrderSender('stream-a');

        // Three calls in one turn, as an application that sends in a loop makes them: nothing is awaited between.
        const positions = [sender.openSend(), sender.openSend(), sender.openSend()];

        expect(positions).toEqual([1, 2, 3]);
        expect(positions.map((position) => sender.stampSend(position, NOW_MS).stream)).toEqual([
            'stream-a',
            'stream-a',
            'stream-a'
        ]);
    });

    it('states the latest deadline among earlier open sends, and none once they have ended', () => {
        const sender = new EdgeOrderSender('stream-a');

        const first = send(sender, 10_000);
        expect(first.stamp).toEqual({
            stream: 'stream-a',
            position: 1,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: undefined
        });
        const second = send(sender, 12_000);
        expect(second.stamp).toEqual({
            stream: 'stream-a',
            position: 2,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 10_000
        });
        // The latest, not the most recent: send 2 outlives send 3.
        const third = send(sender, 11_000);
        expect(third.stamp).toEqual({
            stream: 'stream-a',
            position: 3,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 12_000
        });

        first.end();
        second.end();
        const fourth = send(sender, 13_000);
        expect(fourth.stamp).toEqual({
            stream: 'stream-a',
            position: 4,
            lowestOpenPosition: 3,
            earlierCanArriveUntilMs: 11_000
        });

        third.end();
        fourth.end();
        expect(send(sender, 14_000).stamp).toEqual({
            stream: 'stream-a',
            position: 5,
            lowestOpenPosition: 5,
            earlierCanArriveUntilMs: undefined
        });
    });

    it('keeps the lowest open position at the oldest send that has not ended, whatever order they end in', () => {
        const sender = new EdgeOrderSender('stream-a');
        const first = send(sender, 10_000);
        const second = send(sender, 10_000);
        send(sender, 10_000);

        second.end();
        expect(send(sender, 10_000).stamp.lowestOpenPosition).toBe(1);

        first.end();
        expect(send(sender, 10_000).stamp.lowestOpenPosition).toBe(3);
    });

    it('states no deadline for a send nothing retries, and keeps it open until it ends', () => {
        const sender = new EdgeOrderSender('stream-a');
        const unretried = send(sender, 9_000, false);

        // Nothing brings send 1 back if it is lost, so no later message tells a receiver to wait for it.
        expect(send(sender, 20_000).stamp).toMatchObject({ lowestOpenPosition: 1, earlierCanArriveUntilMs: undefined });
        expect(send(sender, 20_000).stamp).toMatchObject({ lowestOpenPosition: 1, earlierCanArriveUntilMs: 20_000 });

        unretried.end();
        expect(send(sender, 20_000).stamp.lowestOpenPosition).toBe(2);
    });

    it('ends a send whose deadline has passed, whatever its lifecycle says', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 5_000);
        send(sender, 9_000);

        const position = sender.openSend();

        expect(sender.stampSend(position, 5_000)).toEqual({
            stream: 'stream-a',
            position: 3,
            lowestOpenPosition: 2,
            earlierCanArriveUntilMs: 9_000
        });
    });

    it('tells receivers to wait as long as they may for an earlier send that has no deadline yet', () => {
        const sender = new EdgeOrderSender('stream-a');
        // Send 1 took its position and is still connecting; send 2 is built first.
        sender.openSend();
        const second = sender.openSend();

        expect(sender.stampSend(second, NOW_MS)).toEqual({
            stream: 'stream-a',
            position: 2,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: Number.MAX_SAFE_INTEGER
        });
    });

    it('gives the position of a send that never set out to the next send, so it leaves no hole', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 10_000);
        const refused = sender.openSend();
        sender.endSend(refused);
        sender.endSend(refused);

        expect(sender.openSend()).toBe(2);
    });

    it('closes the position of a send that never set out once a later send has taken the next one', () => {
        const sender = new EdgeOrderSender('stream-a');
        // Two calls in one turn: the second has its position before the first is found refused.
        const refused = sender.openSend();
        const next = sender.openSend();
        sender.endSend(refused);

        expect(sender.stampSend(next, NOW_MS)).toEqual({
            stream: 'stream-a',
            position: 2,
            lowestOpenPosition: 2,
            earlierCanArriveUntilMs: undefined
        });
        expect(sender.openSend()).toBe(3);
    });

    it('does not count a later send that was built first among the earlier ones', () => {
        const sender = new EdgeOrderSender('stream-a');
        const first = sender.openSend();
        send(sender, 30_000);

        expect(sender.stampSend(first, NOW_MS)).toEqual({
            stream: 'stream-a',
            position: 1,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: undefined
        });
    });
});
