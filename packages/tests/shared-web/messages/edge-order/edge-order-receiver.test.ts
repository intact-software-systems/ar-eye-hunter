import { describe, expect, it } from 'vitest';

import type { EdgeOrderGap } from '@shared-web/browser/messages/edge-order/edge-order-gap.ts';
import {
    EDGE_ORDER_RECEIVER_DEFAULT_LIMITS,
    type EdgeOrderReceiverLimits
} from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderReceiver } from '@shared-web/browser/messages/edge-order/edge-order-receiver.ts';
import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import { createManualTimers, type ManualTimers } from '../../../shared/resilience/manual-timers.ts';

const START_MS = 1_000;
const FAR_DEADLINE_MS = 31_000;

interface ReceiverFixture {
    readonly timers: ManualTimers;
    readonly receiver: EdgeOrderReceiver<string>;
    readonly handedOver: string[];
    readonly handedOverAtMs: number[];
    readonly gaps: EdgeOrderGap[];
}

function createReceiverFixture(limits: Partial<EdgeOrderReceiverLimits> = {}): ReceiverFixture {
    const timers = createManualTimers(START_MS);
    const handedOver: string[] = [];
    const handedOverAtMs: number[] = [];
    const gaps: EdgeOrderGap[] = [];
    const receiver = new EdgeOrderReceiver<string>({ ...EDGE_ORDER_RECEIVER_DEFAULT_LIMITS, ...limits }, {
        timers,
        handOver: (message) => {
            handedOver.push(message);
            handedOverAtMs.push(timers.nowMs());
        },
        reportGap: (gap) => {
            gaps.push(gap);
        }
    });
    return { timers, receiver, handedOver, handedOverAtMs, gaps };
}

/** A stamp of stream A whose sender has nothing earlier open, unless the test states what is. */
function stamp(position: number, statement: Partial<Omit<EdgeOrderStamp, 'position'>> = {}): EdgeOrderStamp {
    return { streamId: 'A', position, lowestOpenPosition: position, earlierCanArriveUntilMs: undefined, ...statement };
}

/** A stamp whose sender still has the send at `lowestOpenPosition` open, retried until `untilMs`. */
function stampBehind(position: number, lowestOpenPosition: number, untilMs = FAR_DEADLINE_MS): EdgeOrderStamp {
    return stamp(position, { lowestOpenPosition, earlierCanArriveUntilMs: untilMs });
}

function accept(
    fixture: ReceiverFixture,
    edgeOrderStamp: EdgeOrderStamp,
    arrival: Partial<Omit<EdgeOrderReceiver.Arrival<string>, 'stamp'>> = {}
): EdgeOrderReceiver.Outcome {
    return fixture.receiver.accept({
        senderId: 'p',
        stamp: edgeOrderStamp,
        expiresAtMs: FAR_DEADLINE_MS,
        byteLength: 1,
        message: `m${edgeOrderStamp.position}`,
        ...arrival
    });
}

describe('EdgeOrderReceiver: order', () => {
    it('hands in-order arrivals over at once', () => {
        const fixture = createReceiverFixture();

        expect(accept(fixture, stamp(1))).toBe('handed-over');
        expect(accept(fixture, stampBehind(2, 1))).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm2']);
        expect(fixture.receiver.getCounts().heldMessages).toBe(0);
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('holds a message that is ahead and hands the pair over in send order when the earlier one arrives', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));

        expect(accept(fixture, stampBehind(3, 2))).toBe('held');
        expect(fixture.handedOver).toEqual(['m1']);
        expect(fixture.receiver.getCounts().heldMessages).toBe(1);

        expect(accept(fixture, stampBehind(2, 2))).toBe('handed-over');
        expect(fixture.handedOver).toEqual(['m1', 'm2', 'm3']);
        expect(fixture.gaps).toEqual([]);
        // The wake armed for the hole is cancelled with it.
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('keeps two senders that use the same stream id apart', () => {
        const fixture = createReceiverFixture();

        accept(fixture, stamp(1), { senderId: 'p', message: 'p1' });
        accept(fixture, stamp(1), { senderId: 'q', message: 'q1' });

        expect(fixture.handedOver).toEqual(['p1', 'q1']);
        expect(fixture.receiver.getCounts().streams).toBe(2);
    });

    it('treats a new stream from the same sender, as a reload makes one, as its own order beside the old one', () => {
        const fixture = createReceiverFixture();
        const beforeReload = new EdgeOrderSender('A');
        const afterReload = new EdgeOrderSender('B');
        const send = { expiresAtMs: FAR_DEADLINE_MS, retried: true };

        accept(fixture, beforeReload.stampSend(send), { message: 'a1' });
        // Send 2 of the old stream is still on its way when the new page's first message arrives.
        const delayed = beforeReload.stampSend(send);
        accept(fixture, beforeReload.stampSend(send), { message: 'a3' });
        accept(fixture, afterReload.stampSend(send), { message: 'b1' });
        accept(fixture, delayed, { message: 'a2' });

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'a2', 'a3']);
        expect(fixture.receiver.getCounts().streams).toBe(2);
        expect(fixture.gaps).toEqual([]);
    });
});

describe('EdgeOrderReceiver: the gap rule', () => {
    it('waits for a missing message until its sender says it can no longer arrive, then skips and reports', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        // Send 2 is lost for good. It was retried until 5 000, and message 3 says so.
        accept(fixture, stampBehind(3, 2, 5_000));

        await fixture.timers.advanceTo(4_999);
        expect(fixture.handedOver).toEqual(['m1']);

        await fixture.timers.advanceTo(5_000);
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'cannot-arrive' }
        ]);

        // A copy of 2 that arrives after all is dropped: handing it over now would break the order.
        expect(accept(fixture, stampBehind(2, 1, 4_000))).toBe('late');
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.receiver.getCounts().lateMessages).toBe(1);
    });

    it('hands over what arrives and goes on waiting for the rest of the hole', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(4, 2, 5_000));

        await fixture.timers.advanceTo(2_000);
        accept(fixture, stampBehind(2, 2));
        expect(fixture.handedOver).toEqual(['m1', 'm2']);

        await fixture.timers.advanceTo(5_000);
        expect(fixture.handedOver).toEqual(['m1', 'm2', 'm4']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 3, toPosition: 3, reason: 'cannot-arrive' }
        ]);
    });

    it('never waits for a send nothing retries: the newest is handed over and the late one is dropped', () => {
        const fixture = createReceiverFixture();
        const sender = new EdgeOrderSender('A');
        const unretried = { expiresAtMs: 3_000, retried: false };
        // Three sends in one turn: none has reached the carrier when the next is stamped.
        const first = sender.stampSend(unretried);
        const second = sender.stampSend(unretried);
        const third = sender.stampSend(unretried);

        accept(fixture, first);
        expect(accept(fixture, third)).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'cannot-arrive' }
        ]);
        expect(fixture.timers.pendingCount()).toBe(0);
        expect(accept(fixture, second)).toBe('late');
    });

    it('releases a held message before its own deadline, however long the missing one could still arrive', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 90_000), { expiresAtMs: 4_000 });

        await fixture.timers.advanceTo(3_998);
        expect(fixture.handedOver).toEqual(['m1']);

        await fixture.timers.advanceTo(3_999);
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.handedOverAtMs[1]).toBe(3_999);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-deadline' }
        ]);
    });

    it('releases everything up to a held message whose deadline comes first, in order', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 90_000), { expiresAtMs: 60_000 });
        // Message 5 lives shorter than message 3 before it; it cannot be handed over ahead of 3.
        accept(fixture, stampBehind(5, 2, 90_000), { expiresAtMs: 4_000 });

        await fixture.timers.advanceTo(3_999);

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm5']);
        expect(fixture.gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason])).toEqual([
            [2, 2, 'held-message-deadline'],
            [4, 4, 'held-message-deadline']
        ]);
    });

    it('holds no message longer than the cap its channel sets', async () => {
        const fixture = createReceiverFixture({ gapWaitCapMs: 300 });
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2));

        await fixture.timers.advanceTo(START_MS + 299);
        expect(fixture.handedOver).toEqual(['m1']);

        await fixture.timers.advanceTo(START_MS + 300);
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'channel-wait-cap' }
        ]);
    });

    it('closes a hole at once when a later message says the missing send has ended', () => {
        const fixture = createReceiverFixture();
        const sender = new EdgeOrderSender('A');
        const send = { expiresAtMs: FAR_DEADLINE_MS, retried: true };
        const first = sender.stampSend(send);
        sender.stampSend(send);
        const third = sender.stampSend(send);
        accept(fixture, first);
        expect(accept(fixture, third)).toBe('held');

        // Send 2 was cancelled; sends 1 and 3 were acknowledged. Send 4 is stamped with nothing earlier open.
        sender.endSend(1);
        sender.endSend(2);
        sender.endSend(3);
        accept(fixture, sender.stampSend(send));

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }
        ]);
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('closes only the part of a hole the sender says has ended and goes on waiting for the rest', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(4, 2));

        // Message 5 says send 2 has ended and send 3 is still open.
        expect(accept(fixture, stampBehind(5, 3))).toBe('held');
        expect(fixture.handedOver).toEqual(['m1']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }
        ]);

        accept(fixture, stampBehind(3, 2));
        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4', 'm5']);
    });
});

describe('EdgeOrderReceiver: the entry rule', () => {
    it('starts at once at a first message whose sender says nothing earlier can still arrive', () => {
        const fixture = createReceiverFixture();

        expect(accept(fixture, stamp(57))).toBe('handed-over');
        // Earlier sends are open at the sender, but nothing retries them.
        expect(accept(fixture, stamp(40, { streamId: 'B', lowestOpenPosition: 38 }))).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m57', 'm40']);
        expect(fixture.gaps).toEqual([]);
    });

    it('waits the entry window for earlier messages and hands them over first when they arrive', () => {
        const fixture = createReceiverFixture();

        // The stream's second message overtook its first.
        expect(accept(fixture, stampBehind(2, 1))).toBe('held');
        accept(fixture, stamp(1));

        expect(fixture.handedOver).toEqual(['m1', 'm2']);
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('starts at the lowest message it holds when the entry window ends, with no gap report', async () => {
        const fixture = createReceiverFixture({ entryWaitMs: 500 });
        accept(fixture, stampBehind(58, 40));
        accept(fixture, stampBehind(57, 40));

        await fixture.timers.advanceTo(START_MS + 499);
        expect(fixture.handedOver).toEqual([]);

        await fixture.timers.advanceTo(START_MS + 500);
        expect(fixture.handedOver).toEqual(['m57', 'm58']);
        expect(fixture.gaps).toEqual([]);

        // A message the receiver entered past is late, like any other below the stream's position.
        expect(accept(fixture, stampBehind(56, 40))).toBe('late');
        expect(fixture.receiver.getCounts().lateMessages).toBe(1);
    });

    it('ends the entry window early when a later message says everything before the lowest held has ended', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampBehind(57, 40));

        accept(fixture, stampBehind(58, 57));

        expect(fixture.handedOver).toEqual(['m57', 'm58']);
        expect(fixture.gaps).toEqual([]);
    });
});

describe('EdgeOrderReceiver: duplicates and bounds', () => {
    it('drops a duplicate of a held message, and treats a copy of one already handed over as late', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2));

        expect(accept(fixture, stampBehind(3, 2), { message: 'm3-again' })).toBe('duplicate');
        expect(accept(fixture, stamp(1), { message: 'm1-again' })).toBe('late');

        expect(fixture.receiver.getCounts()).toEqual({
            streams: 1,
            heldMessages: 1,
            lateMessages: 1,
            duplicateMessages: 1
        });
        accept(fixture, stampBehind(2, 2));
        expect(fixture.handedOver).toEqual(['m1', 'm2', 'm3']);
    });

    it('skips forward with a report when a stream holds more messages than its cap', () => {
        const fixture = createReceiverFixture({ maxHeldMessagesPerStream: 4 });
        accept(fixture, stamp(1));
        for (const position of [3, 4, 5, 6]) {
            expect(accept(fixture, stampBehind(position, 2))).toBe('held');
        }

        // The fifth held message passes the cap.
        accept(fixture, stampBehind(7, 2));

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4', 'm5', 'm6', 'm7']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-cap' }
        ]);
        expect(fixture.receiver.getCounts().heldMessages).toBe(0);
    });

    it('skips forward only as far as the cap needs', () => {
        const fixture = createReceiverFixture({ maxHeldMessagesPerStream: 2 });
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2));
        accept(fixture, stampBehind(5, 2));

        accept(fixture, stampBehind(7, 2));

        // Message 3 leaves and the stream is back at its cap; the hole at 4 is still waited for.
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.receiver.getCounts().heldMessages).toBe(2);
    });

    it('skips forward with a report when a stream holds more bytes than its cap', () => {
        const fixture = createReceiverFixture({ maxHeldBytesPerStream: 100 });
        accept(fixture, stamp(1), { byteLength: 60 });
        expect(accept(fixture, stampBehind(3, 2), { byteLength: 60 })).toBe('held');

        accept(fixture, stampBehind(4, 2), { byteLength: 60 });

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'held-byte-cap' }
        ]);
    });

    it('forgets the stream it has heard from least recently when a new one passes the stream cap', async () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { streamId: 'A' }), { message: 'a1' });
        await fixture.timers.advanceTo(2_000);
        accept(fixture, stamp(1, { streamId: 'B' }), { message: 'b1' });
        await fixture.timers.advanceTo(3_000);
        accept(fixture, stampBehind(2, 2), { message: 'a2' });

        accept(fixture, stamp(1, { streamId: 'C' }), { message: 'c1' });

        expect(fixture.receiver.getCounts().streams).toBe(2);
        // Stream A is still known, so a copy of its first message is late.
        expect(accept(fixture, stamp(1, { streamId: 'A' }), { message: 'a1-again' })).toBe('late');
        // Stream B was forgotten: the price of the bound is that a copy from it enters as a new stream.
        expect(accept(fixture, stamp(1, { streamId: 'B' }), { message: 'b1-again' })).toBe('handed-over');
    });

    it('hands over, in order and with a report, what a stream holds before it is forgotten', () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { streamId: 'A' }), { message: 'a1' });
        accept(fixture, stampBehind(3, 2), { message: 'a3' });
        accept(fixture, stamp(1, { streamId: 'B' }), { message: 'b1' });

        accept(fixture, stamp(1, { streamId: 'C' }), { message: 'c1' });

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'a3', 'c1']);
        expect(fixture.gaps).toEqual([
            { senderId: 'p', streamId: 'A', fromPosition: 2, toPosition: 2, reason: 'stream-cap' }
        ]);
        expect(fixture.receiver.getCounts()).toMatchObject({ streams: 2, heldMessages: 0 });
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('defaults to the figures hop order already uses, and a 500 ms entry window', () => {
        expect(EDGE_ORDER_RECEIVER_DEFAULT_LIMITS).toEqual({
            maxHeldMessagesPerStream: 256,
            maxHeldBytesPerStream: 1024 * 1024,
            maxStreams: 256,
            entryWaitMs: 500,
            gapWaitCapMs: undefined
        });
    });
});
