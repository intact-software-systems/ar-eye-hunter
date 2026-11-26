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
 * One round of traffic: Alice sends three moves in each of the round's rooms. She keeps 256 send streams and a round
 * has more rooms than that, so every room's stream is a new one each round. Bob gets
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
    it('holds nothing once its streams go idle, and what it keeps of them stays within its caps round after round', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
        let handedOver = 0;
        bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).onWs(() => {
            handedOver += 1;
        });
        const idle: Array<ReturnType<EdgeOrderPage['messages']['readUsage']>['edgeOrder']> = [];

        for (let round = 1; round <= ROUNDS; round += 1) {
            await runRound(alice, bob);

            const busy = bob.messages.readUsage().edgeOrder;
            expect(busy.heldMessages).toBeGreaterThan(0);
            expect(busy.heldMessages).toBeLessThanOrEqual(STREAMS_PER_ROUND / 2);
            // A page keeps at most 256 send streams; each of them still has its three sends open.
            expect(alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 256, openSends: 3 * 256 });

            await vi.advanceTimersByTimeAsync(IDLE_MS);

            idle.push(bob.messages.readUsage().edgeOrder);
            expect(alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 256, openSends: 0 });
        }

        // Every idle reading holds no message. A page follows 256 streams and keeps the position of 256 more it
        // pushed out; with 300 new streams a round both are full from the second round on, and stay there.
        expect(idle.map((usage) => usage.heldMessages)).toEqual(Array.from({ length: ROUNDS }, () => 0));
        expect(idle.map((usage) => usage.streams)).toEqual(Array.from({ length: ROUNDS }, () => 256));
        expect(idle.map((usage) => usage.evictedStreams)).toEqual([
            STREAMS_PER_ROUND - 256,
            ...Array.from({ length: ROUNDS - 1 }, () => 256)
        ]);
        // The run did the work it was meant to: every stream handed over what it got, and stated what it did not.
        expect(handedOver).toBe(ROUNDS * (STREAMS_PER_ROUND * 2 + STREAMS_PER_ROUND / 2));
        expect(idle.at(-1)).toMatchObject({ gaps: ROUNDS * (STREAMS_PER_ROUND / 2), lateDrops: 0 });
    });
});
