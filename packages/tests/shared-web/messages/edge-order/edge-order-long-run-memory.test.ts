import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    EDGE_ORDER_TEST_ROOM,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

/** More streams than a page follows at once, so every round also pushes streams out and keeps records of them. */
const STREAMS_PER_ROUND = 300;
const ROUNDS = 6;
/** Longer than the 30 s a move lives: by then nothing of a round can still arrive. */
const IDLE_MS = 31_000;

/**
 * One round of traffic: Alice sends three moves in each of the round's rooms, which is one stream per room. Bob gets
 * move 1 and move 3 of every stream, and move 2 of every second stream only, so half of them end the round holding
 * a message for a move that never comes.
 */
async function runRound(alice: EdgeOrderPage, bob: EdgeOrderPage): Promise<void> {
    for (let room = 0; room < STREAMS_PER_ROUND; room += 1) {
        const channel = alice.messages.room<EdgeOrderTestMove>({
            ...EDGE_ORDER_TEST_MOVES,
            roomRef: { ...EDGE_ORDER_TEST_ROOM, groupId: `room-${room}` }
        });
        const from = alice.sent.ws.length;
        for (const n of [1, 2, 3]) {
            await channel.sendWs({ n });
        }
        const [first, second, third] = alice.sent.ws.slice(from);
        await bob.deliver('ws', first);
        await bob.deliver('ws', third);
        if (room % 2 === 0) {
            await bob.deliver('ws', second);
        }
    }
    // What the fixture records of a round is the test's memory, not the page's.
    alice.sent.ws.length = 0;
    bob.diagnostics.length = 0;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('edge order: memory over a long run', () => {
    it('keeps what it holds within its caps under traffic, and nothing once its streams have gone idle', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
        let handedOver = 0;
        bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).onWs(() => {
            handedOver += 1;
        });

        for (let round = 1; round <= ROUNDS; round += 1) {
            await runRound(alice, bob);

            const busy = bob.messages.readUsage().edgeOrder;
            expect(busy.streams).toBe(256);
            expect(busy.evictedStreams).toBe(STREAMS_PER_ROUND - 256);
            expect(busy.heldMessages).toBeGreaterThan(0);
            expect(busy.heldMessages).toBeLessThanOrEqual(STREAMS_PER_ROUND / 2);
            // A page keeps at most 256 send streams; each of them still has its three sends open.
            expect(alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 256, openSends: 3 * 256 });

            await vi.advanceTimersByTimeAsync(IDLE_MS);

            expect(bob.messages.readUsage().edgeOrder).toMatchObject({ streams: 0, heldMessages: 0, evictedStreams: 0 });
            expect(alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 256, openSends: 0 });
        }

        // The run did the work it was meant to: every stream handed over what it got, and stated what it did not.
        expect(handedOver).toBe(ROUNDS * (STREAMS_PER_ROUND * 2 + STREAMS_PER_ROUND / 2));
        expect(bob.messages.readUsage().edgeOrder).toMatchObject({ gaps: ROUNDS * (STREAMS_PER_ROUND / 2), lateDrops: 0 });
    });
});
