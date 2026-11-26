import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    readEdgeOrderDrops,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

interface SeenMove {
    readonly n: number;
    readonly stream: string | undefined;
    readonly position: number | undefined;
}

interface Receiver {
    readonly page: EdgeOrderPage;
    readonly seen: SeenMove[];
}

/** A page that listens on both carriers and records what its handlers were given, in order. */
function createReceiver(sessionId: string, handle: (move: EdgeOrderTestMove) => void | Promise<void> = () => {}): Receiver {
    const page = createEdgeOrderPage({ sessionId });
    const seen: SeenMove[] = [];
    const channel = page.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    const record = async (payload: EdgeOrderTestMove, message: { order?: { stream: string; position: number; }; }) => {
        seen.push({ n: payload.n, stream: message.order?.stream, position: message.order?.position });
        await handle(payload);
    };
    channel.onWs(record);
    channel.onRtc(record);
    return { page, seen };
}

/** Sends the moves over WS, one after another, and returns the messages that set out for them. */
async function sendMoves(page: EdgeOrderPage, moves: readonly number[]): Promise<readonly ALMessage[]> {
    const channel = page.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    const from = page.sent.ws.length;
    for (const n of moves) {
        await channel.sendWs({ n });
    }
    return page.sent.ws.slice(from);
}

function movesOf(receiver: Receiver): readonly number[] {
    return receiver.seen.map((move) => move.n);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('edge order: a sender reload', () => {
    it('starts the reloaded page\'s stream at once, while the old page\'s stream still waits', async () => {
        const bob = createReceiver('bob-session');
        const beforeReload = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [first, lost, third] = await sendMoves(beforeReload, [1, 2, 3]);
        await bob.page.deliver('ws', first);
        await bob.page.deliver('ws', third);
        expect(movesOf(bob)).toEqual([1]);

        // The reload keeps the session id and mints a new stream: its first message is position 1 again.
        const afterReload = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [fourth, fifth] = await sendMoves(afterReload, [4, 5]);
        await bob.page.deliver('ws', fourth);
        await bob.page.deliver('ws', fifth);

        expect(movesOf(bob)).toEqual([1, 4, 5]);
        expect(bob.seen.map((move) => move.position)).toEqual([1, 1, 2]);
        expect(bob.seen[1].stream).not.toBe(bob.seen[0].stream);
        expect(readEdgeOrderDrops(bob.page)).toEqual([]);

        // The old stream was not closed by the new one: its missing message still takes its place when it arrives.
        await bob.page.deliver('ws', lost);
        expect(movesOf(bob)).toEqual([1, 4, 5, 2, 3]);
        expect(readEdgeOrderDrops(bob.page)).toEqual([]);
    });

    it('gives up the old page\'s missing message when it can no longer arrive, without touching the new stream', async () => {
        const bob = createReceiver('bob-session');
        const beforeReload = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [first, , third] = await sendMoves(beforeReload, [1, 2, 3]);
        await bob.page.deliver('ws', first);
        await bob.page.deliver('ws', third);
        const afterReload = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [fourth] = await sendMoves(afterReload, [4]);
        await bob.page.deliver('ws', fourth);

        // Message 2 died with the old page. Message 3 is handed over just before its own deadline.
        await vi.advanceTimersByTimeAsync(30_000);
        const [fifth] = await sendMoves(afterReload, [5]);
        await bob.page.deliver('ws', fifth);

        expect(movesOf(bob)).toEqual([1, 4, 3, 5]);
        expect(readEdgeOrderDrops(bob.page)).toEqual([
            expect.objectContaining({ kind: 'edge-order-gap', stream: bob.seen[0].stream, fromPosition: 2, toPosition: 2 })
        ]);
    });
});

describe('edge order: two tabs of one login', () => {
    it('hands each tab\'s messages over in that tab\'s order, whatever order the two streams arrive in', async () => {
        const bob = createReceiver('bob-session');
        const tabA = createEdgeOrderPage({ sessionId: 'alice-session' });
        const tabB = createEdgeOrderPage({ sessionId: 'alice-session' });
        const fromA = await sendMoves(tabA, [11, 12, 13]);
        const fromB = await sendMoves(tabB, [21, 22, 23]);

        // The two tabs share a sender id. Each stream is swapped in transit, and the two are interleaved.
        for (const message of [fromA[0], fromB[1], fromA[2], fromB[0], fromB[2], fromA[1]]) {
            await bob.page.deliver('ws', message);
        }

        expect(movesOf(bob)).toEqual([11, 21, 22, 23, 12, 13]);
        expect(movesOf(bob).filter((n) => n < 20)).toEqual([11, 12, 13]);
        expect(movesOf(bob).filter((n) => n > 20)).toEqual([21, 22, 23]);
        expect(new Set(bob.seen.map((move) => move.stream)).size).toBe(2);
        expect(readEdgeOrderDrops(bob.page)).toEqual([]);
    });

    it('does not let one tab\'s missing message hold the other tab\'s stream', async () => {
        const bob = createReceiver('bob-session');
        const tabA = createEdgeOrderPage({ sessionId: 'alice-session' });
        const tabB = createEdgeOrderPage({ sessionId: 'alice-session' });
        const fromA = await sendMoves(tabA, [11, 12, 13]);
        const fromB = await sendMoves(tabB, [21, 22]);

        await bob.page.deliver('ws', fromA[0]);
        await bob.page.deliver('ws', fromA[2]);
        await bob.page.deliver('ws', fromB[0]);
        await bob.page.deliver('ws', fromB[1]);

        expect(movesOf(bob)).toEqual([11, 21, 22]);
    });
});

describe('edge order: a receiver that joins mid-stream', () => {
    it('starts at once at its first message when the sender says nothing earlier can still arrive', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const channel = alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        // The three moves before the join ended before the fourth was sent.
        for (const n of [1, 2, 3]) {
            (await channel.sendWs({ n })).cancel();
        }
        const afterJoin = await sendMoves(alice, [4, 5]);
        const joiner = createReceiver('joiner-session');

        await joiner.page.deliver('ws', afterJoin[0]);
        expect(movesOf(joiner)).toEqual([4]);
        await joiner.page.deliver('ws', afterJoin[1]);

        expect(joiner.seen.map((move) => [move.n, move.position])).toEqual([[4, 4], [5, 5]]);
        expect(readEdgeOrderDrops(joiner.page)).toEqual([]);
    });

    it('starts when its entry window ends, and loses nothing sent after it joined, in order', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        // Moves 1 to 3 went to the room before the joiner was in it, and are still open at the sender.
        await sendMoves(alice, [1, 2, 3]);
        const afterJoin = await sendMoves(alice, [4, 5, 6, 7]);
        const joiner = createReceiver('joiner-session');

        // The joiner's first two arrive swapped: an earlier message can still come, so it waits its window.
        await joiner.page.deliver('ws', afterJoin[1]);
        await joiner.page.deliver('ws', afterJoin[0]);
        await vi.advanceTimersByTimeAsync(499);
        expect(movesOf(joiner)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(movesOf(joiner)).toEqual([4, 5]);

        await joiner.page.deliver('ws', afterJoin[3]);
        await joiner.page.deliver('ws', afterJoin[2]);

        expect(movesOf(joiner)).toEqual([4, 5, 6, 7]);
        // It entered at the lowest message it held: what came before its entry is no gap.
        expect(readEdgeOrderDrops(joiner.page)).toEqual([]);
    });

    it('drops as late, and counts, a message from before its entry that reaches it afterwards', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [, , third, fourth] = await sendMoves(alice, [1, 2, 3, 4]);
        const joiner = createReceiver('joiner-session');
        await joiner.page.deliver('ws', fourth);
        await vi.advanceTimersByTimeAsync(500);

        await joiner.page.deliver('ws', third);

        expect(movesOf(joiner)).toEqual([4]);
        expect(readEdgeOrderDrops(joiner.page)).toEqual([
            expect.objectContaining({ kind: 'edge-order-arrival', outcome: 'late', position: 3 })
        ]);
        expect(joiner.page.messages.readUsage().edgeOrder.lateDrops).toBe(1);
    });
});

describe('edge order: hand-over, one stream at a time', () => {
    it('goes on handing over another sender\'s stream while one stream\'s handler never settles', async () => {
        const bob = createReceiver('bob-session', (move) => move.n === 1 ? new Promise<void>(() => {}) : undefined);
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const carol = createEdgeOrderPage({ sessionId: 'carol-session' });
        const fromAlice = await sendMoves(alice, [1, 2]);
        const fromCarol = await sendMoves(carol, [31, 32]);

        // Alice's stream arrives over WS and its first handler hangs: that arrival's hand-over never settles.
        void bob.page.deliver('ws', fromAlice[0]);
        void bob.page.deliver('ws', fromAlice[1]);
        await bob.page.deliver('rtc', fromCarol[0]);
        await bob.page.deliver('rtc', fromCarol[1]);

        // Alice's second message waits behind her first; Carol's two are handed over, in her order.
        expect([...movesOf(bob)].sort((left, right) => left - right)).toEqual([1, 31, 32]);
        expect(movesOf(bob).filter((n) => n > 30)).toEqual([31, 32]);
    });

    it('keeps one stream\'s messages one at a time, each handler finished before the next starts', async () => {
        const steps: string[] = [];
        const release = Promise.withResolvers<void>();
        const bob = createReceiver('bob-session', async (move) => {
            steps.push(`start ${move.n}`);
            if (move.n === 1) {
                await release.promise;
            }
            steps.push(`end ${move.n}`);
        });
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const [first, second] = await sendMoves(alice, [1, 2]);

        const delivered = [bob.page.deliver('ws', first), bob.page.deliver('rtc', second)];
        await vi.advanceTimersByTimeAsync(0);
        expect(steps).toEqual(['start 1']);

        release.resolve();
        await Promise.all(delivered);
        expect(steps).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    });
});
