import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    readEdgeOrderDrops,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

interface SettlePages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    /** The moves Bob's handlers were given, in order. */
    readonly seen: number[];
}

function createSettlePages(): SettlePages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: number[] = [];
    const channel = bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    channel.onWs((payload) => {
        seen.push(payload.n);
    });
    channel.onRtc((payload) => {
        seen.push(payload.n);
    });
    return { alice, bob, seen };
}

/** Alice sends one move over the carrier, and every recipient's receipt for it has reached her before she goes on. */
async function sendAcknowledged(alice: EdgeOrderPage, carrier: 'ws' | 'rtc', n: number) {
    const channel = alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    const handle = await (carrier === 'ws' ? channel.sendWs({ n }) : channel.sendRtc({ n }));
    const message = alice.sent[carrier].at(-1)!;
    alice.acknowledge(carrier, message);
    expect(handle.lifecycle().state).toBe('acknowledged');
    return message;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('edge order: a message its recipient has acknowledged and not yet sorted', () => {
    it('is waited for, and handed over first, when a later message overtakes it over the other carrier', async () => {
        const pages = createSettlePages();
        await pages.bob.deliver('ws', await sendAcknowledged(pages.alice, 'ws', 4));
        // Bob admitted message 5 over WS and acknowledged it; it still waits in his WS lane behind a slow handler.
        const fifth = await sendAcknowledged(pages.alice, 'ws', 5);
        await vi.advanceTimersByTimeAsync(100);
        const sixth = await sendAcknowledged(pages.alice, 'rtc', 6);

        await pages.bob.deliver('rtc', sixth);
        expect(pages.seen).toEqual([4]);

        await vi.advanceTimersByTimeAsync(300);
        await pages.bob.deliver('ws', fifth);

        expect(pages.seen).toEqual([4, 5, 6]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([]);
    });

    it('is waited for no longer than the settle time by a receiver that never gets it', async () => {
        const pages = createSettlePages();
        await pages.bob.deliver('ws', await sendAcknowledged(pages.alice, 'ws', 1));
        // Message 2 went to an audience Bob was not in: everyone it was sent to acknowledged it.
        await sendAcknowledged(pages.alice, 'ws', 2);
        const third = await sendAcknowledged(pages.alice, 'ws', 3);

        await pages.bob.deliver('ws', third);
        await vi.advanceTimersByTimeAsync(499);
        expect(pages.seen).toEqual([1]);
        await vi.advanceTimersByTimeAsync(1);

        expect(pages.seen).toEqual([1, 3]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            expect.objectContaining({ kind: 'edge-order-gap', fromPosition: 2, toPosition: 2, reason: 'cannot-arrive' })
        ]);
    });

    it('is passed at once, as before, on a message stamped after its settle time', async () => {
        const pages = createSettlePages();
        await pages.bob.deliver('ws', await sendAcknowledged(pages.alice, 'ws', 1));
        await sendAcknowledged(pages.alice, 'ws', 2);
        // Message 3 is the stamp that first reads the acknowledgement of 2; it is still on its way to Bob.
        const third = await sendAcknowledged(pages.alice, 'ws', 3);
        await vi.advanceTimersByTimeAsync(500);
        const fourth = await sendAcknowledged(pages.alice, 'ws', 4);

        await pages.bob.deliver('ws', fourth);

        // Send 2 is over at the sender, so Bob gives it up without waiting; message 3 is still open and waited for.
        expect(JSON.parse(fourth.payload.resource).edgeOrder.lowestOpenPosition).toBe(3);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            expect.objectContaining({ kind: 'edge-order-gap', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' })
        ]);
        expect(pages.seen).toEqual([1]);
        await pages.bob.deliver('ws', third);
        expect(pages.seen).toEqual([1, 3, 4]);
    });

    it('still leaves the sender\'s open-send table: counted for its settle time, and not after', async () => {
        const pages = createSettlePages();
        await sendAcknowledged(pages.alice, 'ws', 1);
        await sendAcknowledged(pages.alice, 'rtc', 2);

        // Both acknowledgements are first read at this instant: by the second send's stamp, and by this read.
        expect(pages.alice.messages.readUsage().edgeOrder.openSends).toBe(2);
        await vi.advanceTimersByTimeAsync(499);
        expect(pages.alice.messages.readUsage().edgeOrder.openSends).toBe(2);
        await vi.advanceTimersByTimeAsync(1);

        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 1, openSends: 0 });
    });
});
