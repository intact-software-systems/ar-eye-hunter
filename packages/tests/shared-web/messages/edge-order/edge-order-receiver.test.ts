import { describe, expect, it } from 'vitest';

import {
    EDGE_ORDER_RECEIVER_DEFAULT_LIMITS,
    type EdgeOrderReceiverLimits
} from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderReceiver } from '@shared-web/browser/messages/edge-order/edge-order-receiver.ts';
import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import {
    EDGE_ORDER_DEFAULT_STREAM_WAITS,
    type EdgeOrderStreamWaits
} from '@shared-web/browser/messages/edge-order/edge-order-stream-waits.ts';
import type { RallarMessageOrderGap } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { createManualTimers, type ManualTimers } from '../../../shared/resilience/manual-timers.ts';

const START_MS = 1_000;
/** A sender whose acknowledged sends are over at once: these tests are about the receiver. */
const NO_SETTLE_MS = 0;
/** The channel and sender of every arrival, unless a test names another sender. */
const ORIGIN = { topicId: 'room.moves', typeId: 'game.move', senderId: 'p' };
const FAR_DEADLINE_MS = 31_000;

interface ReceiverFixture {
    readonly timers: ManualTimers;
    readonly receiver: EdgeOrderReceiver<string>;
    /** The waits every arrival states for its channel, unless a test names others. */
    readonly waits: EdgeOrderStreamWaits;
    readonly handedOver: string[];
    readonly handedOverAtMs: number[];
    readonly gaps: RallarMessageOrderGap[];
    /** Run inside the hand-over port, so a test can act as an application that reacts in the same turn. */
    readonly handOverListeners: Array<(message: string) => void>;
    /** How far the receiver's clock runs ahead of its timers: a throttled tab fires a timer this late. */
    readonly timerLag: { ms: number; };
}

function createReceiverFixture(
    limits: Partial<EdgeOrderReceiverLimits> = {},
    waits: Partial<EdgeOrderStreamWaits> = {}
): ReceiverFixture {
    const timers = createManualTimers(START_MS);
    const handedOver: string[] = [];
    const handedOverAtMs: number[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    const handOverListeners: Array<(message: string) => void> = [];
    const timerLag = { ms: 0 };
    const receiver = new EdgeOrderReceiver<string>({ ...EDGE_ORDER_RECEIVER_DEFAULT_LIMITS, ...limits }, {
        timers: { nowMs: () => timers.nowMs() + timerLag.ms, schedule: timers.schedule },
        handOver: (message) => {
            handedOver.push(message);
            handedOverAtMs.push(timers.nowMs());
            for (const listener of handOverListeners) {
                listener(message);
            }
        },
        reportGap: (gap) => {
            gaps.push(gap);
        }
    });
    return {
        timers,
        receiver,
        waits: { ...EDGE_ORDER_DEFAULT_STREAM_WAITS, ...waits },
        handedOver,
        handedOverAtMs,
        gaps,
        handOverListeners,
        timerLag
    };
}

/** A stamp of stream A whose sender has nothing earlier open, unless the test states what is. */
function stamp(position: number, statement: Partial<Omit<EdgeOrderStamp, 'position'>> = {}): EdgeOrderStamp {
    return {
        stream: 'A',
        position,
        lowestOpenPosition: position,
        earlierCanArriveUntilMs: undefined,
        holes: [],
        ...statement
    };
}

/** The stamp a sender page gives its next send, which stays open until `expiresAtMs`. */
function stampNextSend(sender: EdgeOrderSender, retried: boolean, expiresAtMs = FAR_DEADLINE_MS): EdgeOrderStamp {
    const position = sender.openSend(retried);
    const edgeOrderStamp = sender.stampSend(position, START_MS);
    sender.observeSend(position, { expiresAtMs, getEnd: () => 'open' });
    return edgeOrderStamp;
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
        origin: ORIGIN,
        stamp: edgeOrderStamp,
        waits: fixture.waits,
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

        accept(fixture, stamp(1), { message: 'p1' });
        accept(fixture, stamp(1), { origin: { ...ORIGIN, senderId: 'q' }, message: 'q1' });

        expect(fixture.handedOver).toEqual(['p1', 'q1']);
        expect(fixture.receiver.getCounts().streams).toBe(2);
    });

    it('treats a new stream from the same sender, as a reload makes one, as its own order beside the old one', () => {
        const fixture = createReceiverFixture();
        const beforeReload = new EdgeOrderSender('A', NO_SETTLE_MS);
        const afterReload = new EdgeOrderSender('B', NO_SETTLE_MS);

        accept(fixture, stampNextSend(beforeReload, true), { message: 'a1' });
        // Send 2 of the old stream is still on its way when the new page's first message arrives.
        const delayed = stampNextSend(beforeReload, true);
        accept(fixture, stampNextSend(beforeReload, true), { message: 'a3' });
        accept(fixture, stampNextSend(afterReload, true), { message: 'b1' });
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
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'cannot-arrive' }
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
            { ...ORIGIN, stream: 'A', fromPosition: 3, toPosition: 3, reason: 'cannot-arrive' }
        ]);
    });

    it('never waits for a send nothing retries: the newest is handed over and the late one is dropped', () => {
        const fixture = createReceiverFixture();
        const sender = new EdgeOrderSender('A', NO_SETTLE_MS);
        // Three sends in one turn: each later stamp says no receiver waits for the ones before it.
        const first = stampNextSend(sender, false, 3_000);
        const second = stampNextSend(sender, false, 3_000);
        const third = stampNextSend(sender, false, 3_000);

        accept(fixture, first);
        expect(accept(fixture, third)).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }
        ]);
        expect(fixture.timers.pendingCount()).toBe(0);
        expect(accept(fixture, second)).toBe('late');
    });

    it('releases a held message before its own deadline, however long the missing one could still arrive', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 90_000), { expiresAtMs: 4_000 });

        await fixture.timers.advanceTo(3_000);
        expect(fixture.handedOver).toEqual(['m1']);

        await fixture.timers.advanceTo(4_000);
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.handedOverAtMs[1]).toBeLessThan(4_000);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-deadline' }
        ]);
    });

    it('releases everything up to a held message whose deadline comes first, in order', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 90_000), { expiresAtMs: 60_000 });
        // Message 5 lives shorter than message 3 before it; it cannot be handed over ahead of 3.
        accept(fixture, stampBehind(5, 2, 90_000), { expiresAtMs: 4_000 });

        await fixture.timers.advanceTo(4_000);

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm5']);
        expect(fixture.handedOverAtMs[2]).toBeLessThan(4_000);
        expect(fixture.gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason])).toEqual([
            [2, 2, 'held-message-deadline'],
            [4, 4, 'held-message-deadline']
        ]);
    });

    it('holds no message longer than the cap its channel sets', async () => {
        const fixture = createReceiverFixture({}, { orderGapWaitMs: 300 });
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2));

        await fixture.timers.advanceTo(START_MS + 299);
        expect(fixture.handedOver).toEqual(['m1']);

        await fixture.timers.advanceTo(START_MS + 300);
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'channel-wait-cap' }
        ]);
    });

    it('lets each stream wait as its own channel says, and a stream follow the waits of its latest arrival', async () => {
        const fixture = createReceiverFixture();
        const capped = { ...fixture.waits, orderGapWaitMs: 300 };
        const otherChannel = { ...ORIGIN, typeId: 'game.chat' };
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2));
        accept(fixture, stamp(1), { origin: otherChannel, waits: capped, message: 'chat1' });
        accept(fixture, stampBehind(3, 2), { origin: otherChannel, waits: capped, message: 'chat3' });

        await fixture.timers.advanceTo(START_MS + 300);
        // Only the capped channel's stream gave its missing message up.
        expect(fixture.handedOver).toEqual(['m1', 'chat1', 'chat3']);

        // The uncapped stream's channel is declared again with a cap: its next arrival brings it.
        accept(fixture, stampBehind(4, 2), { waits: capped });
        expect(fixture.handedOver).toEqual(['m1', 'chat1', 'chat3', 'm3', 'm4']);
        expect(fixture.gaps.map((gap) => [gap.typeId, gap.fromPosition, gap.reason])).toEqual([
            ['game.chat', 2, 'channel-wait-cap'],
            ['game.move', 2, 'channel-wait-cap']
        ]);
    });

    it('closes a hole at once when a later message says the missing send has ended', () => {
        const fixture = createReceiverFixture();
        const sender = new EdgeOrderSender('A', NO_SETTLE_MS);
        let earlierSendsEnded = false;
        const stampOpenSend = (): EdgeOrderStamp => {
            const position = sender.openSend(true);
            const edgeOrderStamp = sender.stampSend(position, START_MS);
            sender.observeSend(position, {
                expiresAtMs: FAR_DEADLINE_MS,
                getEnd: () => earlierSendsEnded ? 'delivered' : 'open'
            });
            return edgeOrderStamp;
        };
        const first = stampOpenSend();
        stampOpenSend();
        const third = stampOpenSend();
        accept(fixture, first);
        expect(accept(fixture, third)).toBe('held');

        // Send 2 was cancelled; sends 1 and 3 were acknowledged. Send 4 is stamped with nothing earlier open.
        earlierSendsEnded = true;
        accept(fixture, stampOpenSend());

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }
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
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }
        ]);

        accept(fixture, stampBehind(3, 2));
        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4', 'm5']);
    });
});

describe('EdgeOrderReceiver: holes a stamp states', () => {
    /** A stamp whose sender still has send 1 open and states the holes above it. */
    const stampWithHoles = (position: number, holes: EdgeOrderStamp['holes']): EdgeOrderStamp =>
        stamp(position, { lowestOpenPosition: 1, earlierCanArriveUntilMs: FAR_DEADLINE_MS, holes });

    it('closes a hole between open sends at once when a later message states it', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampWithHoles(1, []));

        // Send 1 is still open at the sender, so the lowest open position says nothing of send 2: the hole does.
        expect(accept(fixture, stampWithHoles(3, [[2, 2]]))).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([{ ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }]);
        expect(fixture.timers.pendingCount()).toBe(0);
    });

    it('goes on waiting for an open position between two holes', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampWithHoles(1, []));

        expect(accept(fixture, stampWithHoles(6, [[2, 2], [4, 5]]))).toBe('held');
        expect(fixture.handedOver).toEqual(['m1']);

        accept(fixture, stampWithHoles(3, [[2, 2]]));
        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm6']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' },
            { ...ORIGIN, stream: 'A', fromPosition: 4, toPosition: 5, reason: 'ended-at-sender' }
        ]);
    });

    it('closes a hole that the stamp of any message it holds states', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampWithHoles(1, []));
        // Message 4 was stamped while sends 2 and 3 were open; message 5 after both were refused.
        expect(accept(fixture, stampWithHoles(4, []))).toBe('held');

        expect(accept(fixture, stampWithHoles(5, [[2, 3]]))).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm4', 'm5']);
        expect(fixture.gaps).toEqual([{ ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 3, reason: 'ended-at-sender' }]);
    });

    it('hands over a message it holds although a later stamp calls its position a hole', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampWithHoles(1, []));
        expect(accept(fixture, stampWithHoles(3, []))).toBe('held');

        // Send 3 was cancelled after a copy of it had arrived here: the copy is not given up.
        accept(fixture, stampWithHoles(4, [[2, 3]]));

        expect(fixture.handedOver).toEqual(['m1', 'm3', 'm4']);
        expect(fixture.gaps).toEqual([{ ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }]);
    });

    it('drops the late copy of a position it passed as a hole', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stampWithHoles(1, []));
        accept(fixture, stampWithHoles(3, [[2, 2]]));

        expect(accept(fixture, stampWithHoles(2, []))).toBe('late');
        expect(fixture.handedOver).toEqual(['m1', 'm3']);
    });
});

describe('EdgeOrderReceiver: deadlines and dropped holds', () => {
    it('drops a held message its release timer reaches after its deadline, and reports its position', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 90_000), { expiresAtMs: 4_000 });
        accept(fixture, stampBehind(4, 2, 90_000), { expiresAtMs: 9_000 });

        // The timer set for just before message 3's deadline fires 50 ms late.
        fixture.timerLag.ms = 50;
        await fixture.timers.advanceTo(4_000);

        expect(fixture.handedOver).toEqual(['m1', 'm4']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-deadline' },
            { ...ORIGIN, stream: 'A', fromPosition: 3, toPosition: 3, reason: 'held-message-expired' }
        ]);
        expect(fixture.receiver.getCounts()).toMatchObject({ heldMessages: 0, expiredMessages: 1 });
    });

    it('drops an arrival that is already past its deadline and goes on with the next position', () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));

        expect(accept(fixture, stampBehind(2, 2), { expiresAtMs: START_MS })).toBe('expired');
        expect(accept(fixture, stampBehind(3, 3))).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm3']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-expired' }
        ]);
    });

    it('drops every held message on request, cancels their timers and keeps each stream where it stands', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1));
        accept(fixture, stampBehind(3, 2, 5_000));
        accept(fixture, stamp(2, { stream: 'B', lowestOpenPosition: 1, earlierCanArriveUntilMs: 5_000 }), {
            message: 'b2'
        });

        expect(fixture.receiver.dropHeldMessages()).toBe(2);

        expect(fixture.timers.pendingCount()).toBe(0);
        expect(fixture.receiver.getCounts()).toMatchObject({ streams: 2, heldMessages: 0, droppedMessages: 2 });
        await fixture.timers.advanceTo(6_000);
        expect(fixture.handedOver).toEqual(['m1']);
        // Stream A still stands at 2: a copy of 1 is late, and 2 is handed over when it comes.
        expect(accept(fixture, stamp(1))).toBe('late');
        expect(accept(fixture, stampBehind(2, 2))).toBe('handed-over');
        expect(fixture.gaps).toEqual([]);
    });
});

describe('EdgeOrderReceiver: the entry rule', () => {
    it('starts at once at a first message whose sender says nothing earlier can still arrive', () => {
        const fixture = createReceiverFixture();

        expect(accept(fixture, stamp(57))).toBe('handed-over');
        // Earlier sends are open at the sender, but nothing retries them.
        expect(accept(fixture, stamp(40, { stream: 'B', lowestOpenPosition: 38 }))).toBe('handed-over');
        // Earlier sends were retried, but only until a moment that has passed.
        const expired = stamp(9, { stream: 'C', lowestOpenPosition: 4, earlierCanArriveUntilMs: START_MS });
        expect(accept(fixture, expired)).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m57', 'm40', 'm9']);
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
        const fixture = createReceiverFixture({}, { orderEntryWindowMs: 500 });
        accept(fixture, stampBehind(58, 40));
        accept(fixture, stampBehind(57, 40));
        expect(accept(fixture, stampBehind(57, 40), { message: 'm57-again' })).toBe('duplicate');

        await fixture.timers.advanceTo(START_MS + 499);
        expect(fixture.handedOver).toEqual([]);

        await fixture.timers.advanceTo(START_MS + 500);
        expect(fixture.handedOver).toEqual(['m57', 'm58']);
        expect(fixture.gaps).toEqual([]);

        // A message the receiver entered past is late, like any other below the stream's position.
        expect(accept(fixture, stampBehind(56, 40))).toBe('late');
        expect(fixture.receiver.getCounts().lateMessages).toBe(1);
    });

    it('starts before the entry window ends when a message it holds would pass its own deadline', async () => {
        const fixture = createReceiverFixture({}, { orderEntryWindowMs: 500 });
        accept(fixture, stampBehind(57, 40), { expiresAtMs: START_MS + 200 });

        await fixture.timers.advanceTo(START_MS + 200);

        expect(fixture.handedOver).toEqual(['m57']);
        expect(fixture.handedOverAtMs[0]).toBeLessThan(START_MS + 200);
        expect(fixture.gaps).toEqual([]);
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
            duplicateMessages: 1,
            expiredMessages: 0,
            droppedMessages: 0,
            evictedStreams: 0
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
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'held-message-cap' }
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
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'held-byte-cap' }
        ]);
    });

    it('forgets the idle stream it has heard from least recently when a new one passes the stream cap', async () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        await fixture.timers.advanceTo(2_000);
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });
        await fixture.timers.advanceTo(3_000);
        accept(fixture, stampBehind(2, 2), { message: 'a2' });

        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });

        // Streams A and C are the two that are known: a copy of a message either handed over is late. So B went.
        expect(fixture.receiver.getCounts().streams).toBe(2);
        expect(accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1-again' })).toBe('late');
        expect(accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1-again' })).toBe('late');
        expect(fixture.receiver.getCounts().streams).toBe(2);
    });

    it('keeps a stream that holds messages while a stream that holds nothing can be forgotten', () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        // Stream A was heard from first, but it is waiting for its message 2.
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stampBehind(3, 2), { message: 'a3' });
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });

        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });
        accept(fixture, stampBehind(2, 2), { message: 'a2' });

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
        expect(fixture.gaps).toEqual([]);
    });

    it('hands over, in order and with a report, what a stream holds when it must be forgotten', () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stampBehind(3, 2), { message: 'a3' });
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });
        accept(fixture, stamp(3, { stream: 'B', lowestOpenPosition: 2, earlierCanArriveUntilMs: 5_000 }), {
            message: 'b3'
        });

        // Every stream holds something, so the one heard from least recently goes.
        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'a3', 'c1']);
        expect(fixture.gaps).toEqual([
            { ...ORIGIN, stream: 'A', fromPosition: 2, toPosition: 2, reason: 'stream-cap' }
        ]);
        expect(fixture.receiver.getCounts()).toMatchObject({ streams: 2, heldMessages: 1 });
        // Only stream B's wake is left.
        expect(fixture.timers.pendingCount()).toBe(1);
    });

    it('keeps a new stream whole when the hand-over that makes room for it brings its next message', () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stampBehind(3, 2), { message: 'a3' });
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });
        accept(fixture, stamp(3, { stream: 'B', lowestOpenPosition: 2, earlierCanArriveUntilMs: 5_000 }), {
            message: 'b3'
        });
        // An application that, handed a3, causes stream C's second message to be accepted in the same turn:
        // before the call that carries C's first message has finished.
        fixture.handOverListeners.push((message) => {
            if (message === 'a3') {
                accept(fixture, stamp(2, { stream: 'C', lowestOpenPosition: 1, earlierCanArriveUntilMs: 5_000 }), {
                    message: 'c2'
                });
            }
        });

        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'a3', 'c1', 'c2']);
        expect(fixture.receiver.getCounts()).toMatchObject({ streams: 2, heldMessages: 1 });
    });

    it('defaults to the figures hop order already uses, and a 500 ms entry window', () => {
        expect(EDGE_ORDER_RECEIVER_DEFAULT_LIMITS).toEqual({
            maxHeldMessagesPerStream: 256,
            maxHeldBytesPerStream: 1024 * 1024,
            maxStreams: 256,
            maxEvictedStreams: 256
        });
        expect(EDGE_ORDER_DEFAULT_STREAM_WAITS).toEqual({ orderEntryWindowMs: 500, orderGapWaitMs: undefined });
    });
});

describe('EdgeOrderReceiver: a stream it has not heard from for long', () => {
    it('is still followed: a missing message is waited for, and a late copy stays late', async () => {
        const fixture = createReceiverFixture();
        accept(fixture, stamp(1), { expiresAtMs: 5_000 });
        await fixture.timers.advanceTo(3_600_000);

        // The sender goes on after an hour. Its third message arrives first: this is a gap, not an entry.
        expect(accept(fixture, stampBehind(3, 2, 3_630_000), { expiresAtMs: 3_630_000 })).toBe('held');
        await fixture.timers.advanceTo(3_602_000);
        expect(accept(fixture, stampBehind(2, 2, 3_630_000), { expiresAtMs: 3_630_000 })).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['m1', 'm2', 'm3']);
        expect(accept(fixture, stamp(1), { expiresAtMs: 3_630_000 })).toBe('late');
        expect(fixture.gaps).toEqual([]);
    });
});

describe('EdgeOrderReceiver: a stream the stream cap pushed out', () => {
    it('keeps its position, so a late copy stays late and its next message is handed over at once', () => {
        const fixture = createReceiverFixture({ maxStreams: 2 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });
        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });
        expect(fixture.receiver.getCounts()).toMatchObject({ streams: 2, evictedStreams: 1 });

        expect(accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1-again' })).toBe('late');
        // Send 1 is still open at the sender: a stream entering here would wait its entry window for it.
        expect(accept(fixture, stamp(2, { stream: 'A', lowestOpenPosition: 1, earlierCanArriveUntilMs: FAR_DEADLINE_MS }), {
            message: 'a2'
        })).toBe('handed-over');

        expect(fixture.handedOver).toEqual(['a1', 'b1', 'c1', 'a2']);
    });

    it('keeps the position a stream reached when what it held was handed over to make room', () => {
        const fixture = createReceiverFixture({ maxStreams: 1 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stampBehind(3, 2), { message: 'a3' });

        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });

        expect(fixture.handedOver).toEqual(['a1', 'a3', 'b1']);
        expect(accept(fixture, stampBehind(2, 2), { message: 'a2' })).toBe('late');
    });

    it('keeps at most as many records as its limit, the newest: an older stream enters as new when heard again', () => {
        const fixture = createReceiverFixture({ maxStreams: 1, maxEvictedStreams: 1 });
        accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1' });
        accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1' });
        accept(fixture, stamp(1, { stream: 'C' }), { message: 'c1' });

        expect(fixture.receiver.getCounts().evictedStreams).toBe(1);
        expect(accept(fixture, stamp(1, { stream: 'B' }), { message: 'b1-again' })).toBe('late');
        // The stated limit: stream A's record was pushed out, so its late copy is handed over again.
        expect(accept(fixture, stamp(1, { stream: 'A' }), { message: 'a1-again' })).toBe('handed-over');
    });
});
