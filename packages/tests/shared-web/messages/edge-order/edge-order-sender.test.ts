import { describe, expect, it } from 'vitest';

import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';

const NOW_MS = 1_000;

interface ObservedSend {
    readonly position: number;
    /** Every recipient acknowledged the send. */
    end(): void;
    /** The send was refused or cancelled: no copy of it can still arrive. */
    refuse(): void;
}

/** Opens, stamps and observes one send as the wiring does: a position at the call, the rest once the send exists. */
function send(sender: EdgeOrderSender, expiresAtMs: number, retried = true): ObservedSend & {
    readonly stamp: ReturnType<EdgeOrderSender['stampSend']>;
} {
    const position = sender.openSend();
    const stamp = sender.stampSend(position, NOW_MS);
    let end: EdgeOrderSender.SendEnd = 'open';
    sender.observeSend(position, { expiresAtMs, retried, getEnd: () => end });
    return {
        position,
        stamp,
        end: () => {
            end = 'delivered';
        },
        refuse: () => {
            end = 'undelivered';
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
            earlierCanArriveUntilMs: undefined,
            holes: []
        });
        const second = send(sender, 12_000);
        expect(second.stamp).toEqual({
            stream: 'stream-a',
            position: 2,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 10_000,
            holes: []
        });
        // The latest, not the most recent: send 2 outlives send 3.
        const third = send(sender, 11_000);
        expect(third.stamp).toEqual({
            stream: 'stream-a',
            position: 3,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 12_000,
            holes: []
        });

        first.end();
        second.end();
        const fourth = send(sender, 13_000);
        expect(fourth.stamp).toEqual({
            stream: 'stream-a',
            position: 4,
            lowestOpenPosition: 3,
            earlierCanArriveUntilMs: 11_000,
            holes: []
        });

        third.end();
        fourth.end();
        expect(send(sender, 14_000).stamp).toEqual({
            stream: 'stream-a',
            position: 5,
            lowestOpenPosition: 5,
            earlierCanArriveUntilMs: undefined,
            holes: []
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
            earlierCanArriveUntilMs: 9_000,
            holes: []
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
            earlierCanArriveUntilMs: Number.MAX_SAFE_INTEGER,
            holes: []
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
            earlierCanArriveUntilMs: undefined,
            holes: []
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
            earlierCanArriveUntilMs: undefined,
            holes: []
        });
    });

    it('states a refused or cancelled send between open ones as a hole at once, and an acknowledged one never', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 10_000);
        const refused = send(sender, 10_000);
        const acknowledged = send(sender, 10_000);
        const cancelled = send(sender, 10_000);
        send(sender, 10_000);

        refused.refuse();
        acknowledged.end();
        cancelled.refuse();

        // Send 3 reached every recipient: one of them may hold it and not have sorted it yet, so it is no hole.
        expect(send(sender, 10_000).stamp).toEqual({
            stream: 'stream-a',
            position: 6,
            lowestOpenPosition: 1,
            earlierCanArriveUntilMs: 10_000,
            holes: [[2, 2], [4, 4]]
        });
    });

    it('states a send that never set out as a hole once a later send has taken the next position', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 10_000);
        const neverSetOut = sender.openSend();
        const next = sender.openSend();
        sender.endSend(neverSetOut);

        expect(sender.stampSend(next, NOW_MS)).toMatchObject({ position: 3, lowestOpenPosition: 1, holes: [[2, 2]] });
    });

    it('states neighbouring holes as one run, and only those below the stamped send', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 10_000);
        const refused = [send(sender, 10_000), send(sender, 10_000), send(sender, 10_000)];
        const builtLate = sender.openSend();
        const after = send(sender, 10_000);
        for (const each of refused) {
            each.refuse();
        }
        after.refuse();

        expect(sender.stampSend(builtLate, NOW_MS).holes).toEqual([[2, 4]]);
        expect(send(sender, 10_000).stamp.holes).toEqual([[2, 4], [6, 6]]);
    });

    it('keeps a failed send open until its deadline, and states it as a hole from then on', () => {
        const sender = new EdgeOrderSender('stream-a');
        send(sender, 20_000);
        // A failed send reads open: a copy that already set out can still arrive.
        send(sender, 5_000);
        const third = sender.openSend();
        const fourth = sender.openSend();

        expect(sender.stampSend(third, 4_999)).toMatchObject({ lowestOpenPosition: 1, holes: [] });
        expect(sender.stampSend(fourth, 5_000)).toMatchObject({ lowestOpenPosition: 1, holes: [[2, 2]] });
    });

    it('drops a hole from its stamps once every send below it has ended: the lowest open position says it', () => {
        const sender = new EdgeOrderSender('stream-a');
        const first = send(sender, 10_000);
        send(sender, 10_000).refuse();
        send(sender, 10_000);

        first.end();

        expect(send(sender, 10_000).stamp).toMatchObject({ position: 4, lowestOpenPosition: 3, holes: [] });
    });

    it('states at most 16 runs of holes, the lowest first, and the next ones once those are passed', () => {
        const sender = new EdgeOrderSender('stream-a');
        const first = send(sender, 10_000);
        // Positions 2 to 41: every even one refused, every odd one open, so each hole is a run of its own.
        const sends = Array.from({ length: 40 }, () => send(sender, 10_000));
        for (const each of sends.filter((_send, index) => index % 2 === 0)) {
            each.refuse();
        }

        const stated = send(sender, 10_000).stamp.holes;
        expect(stated).toHaveLength(16);
        expect(stated[0]).toEqual([2, 2]);
        expect(stated[15]).toEqual([32, 32]);

        first.end();
        for (const each of sends.slice(0, 31)) {
            each.end();
        }
        expect(send(sender, 10_000).stamp).toMatchObject({ lowestOpenPosition: 33, holes: [[34, 34], [36, 36], [38, 38], [40, 40]] });
    });

    it('counts the sends still open and the holes it still states, and nothing once they have ended', () => {
        const sender = new EdgeOrderSender('stream-a');
        const first = send(sender, 10_000);
        send(sender, 10_000).refuse();
        send(sender, 8_000);

        expect(sender.countOpenSends(NOW_MS)).toBe(3);
        first.end();
        expect(sender.countOpenSends(NOW_MS)).toBe(1);
        expect(sender.countOpenSends(8_000)).toBe(0);
    });
});
