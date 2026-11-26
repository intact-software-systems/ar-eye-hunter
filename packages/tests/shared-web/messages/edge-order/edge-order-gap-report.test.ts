import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    RallarMessageOrderGap,
    RallarRoomMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

interface GapPages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    /** What Bob's application saw, in the order it saw it: a move by its number, a gap by its positions. */
    readonly seen: string[];
    readonly gaps: RallarMessageOrderGap[];
}

/** Alice sends; Bob's channel records each move and each gap its `onOrderGap` is given. */
function createGapPages(onOrderGap?: (gap: RallarMessageOrderGap) => void | Promise<void>): GapPages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: string[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    bob.messages.room<EdgeOrderTestMove>({
        ...EDGE_ORDER_TEST_MOVES,
        onOrderGap: async (gap) => {
            seen.push(`gap ${gap.fromPosition}-${gap.toPosition}`);
            gaps.push(gap);
            await onOrderGap?.(gap);
        }
    }).onWs((payload) => {
        seen.push(`move ${payload.n}`);
    });
    return { alice, bob, seen, gaps };
}

/** Sends moves 1 to `count` over WS, of which the cancelled ones end at once, and returns what set out. */
async function sendMoves(page: EdgeOrderPage, count: number, cancelled: readonly number[] = []) {
    const channel = page.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    for (let n = 1; n <= count; n += 1) {
        const handle = await channel.sendWs({ n });
        if (cancelled.includes(n)) {
            handle.cancel();
        }
    }
    return page.sent.ws;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an edge-ordered room channel: the gap report', () => {
    it('gives each gap to onOrderGap once, with the sender, the stream, the positions and the reason', async () => {
        const pages = createGapPages();
        const sent = await sendMoves(pages.alice, 6, [2, 3, 5]);

        for (const message of [sent[0], sent[3], sent[5]]) {
            await pages.bob.deliver('ws', message);
        }

        const stream = JSON.parse(sent[0].payload.resource).edgeOrder.stream;
        expect(pages.gaps).toEqual([
            {
                topicId: 'room.moves',
                typeId: 'game.move',
                senderId: 'alice-session',
                stream,
                fromPosition: 2,
                toPosition: 3,
                reason: 'ended-at-sender'
            },
            {
                topicId: 'room.moves',
                typeId: 'game.move',
                senderId: 'alice-session',
                stream,
                fromPosition: 5,
                toPosition: 5,
                reason: 'ended-at-sender'
            }
        ]);
    });

    it('reports a gap in the stream\'s turn: after the message before it and before the message after it', async () => {
        const pages = createGapPages();
        const sent = await sendMoves(pages.alice, 4, [2]);

        for (const message of [sent[0], sent[2], sent[3]]) {
            await pages.bob.deliver('ws', message);
        }

        expect(pages.seen).toEqual(['move 1', 'gap 2-2', 'move 3', 'move 4']);
    });

    it('reports a message that could no longer arrive once its sender\'s time for it has passed', async () => {
        const pages = createGapPages();
        const channel = pages.alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        await channel.sendWs({ n: 1 }, { ttlMs: 3_000 });
        await channel.sendWs({ n: 2 }, { ttlMs: 4_000 });
        await channel.sendWs({ n: 3 });
        const [first, , third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        // Message 3 says how long the sends before it can still arrive: until the later of their two deadlines.
        await vi.advanceTimersByTimeAsync(4_000);

        expect(pages.gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason])).toEqual([[2, 2, 'cannot-arrive']]);
        expect(pages.seen).toEqual(['move 1', 'gap 2-2', 'move 3']);
    });

    it('reports what is given up when a message it holds can wait no longer', async () => {
        const pages = createGapPages();
        const channel = pages.alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        await channel.sendWs({ n: 1 });
        await channel.sendWs({ n: 2 });
        await channel.sendWs({ n: 3 }, { ttlMs: 2_000 });
        const [first, , third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        // Send 2 can still arrive for 30 s, but message 3 would pass its own deadline first: it is handed over.
        await vi.advanceTimersByTimeAsync(2_000);

        expect(pages.gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason])).toEqual([
            [2, 2, 'held-message-deadline']
        ]);
        expect(pages.seen).toEqual(['move 1', 'gap 2-2', 'move 3']);
    });

    it.each<[string, () => void | Promise<void>]>([
        ['throws', () => {
            throw new Error('The application\'s gap handler failed.');
        }],
        ['rejects', () => Promise.reject(new Error('The application\'s gap handler failed.'))]
    ])('goes on with the stream when onOrderGap %s', async (_failure, fail) => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pages = createGapPages(fail);
        const sent = await sendMoves(pages.alice, 5, [2, 4]);

        for (const message of [sent[0], sent[2], sent[4]]) {
            await pages.bob.deliver('ws', message);
        }

        expect(pages.seen).toEqual(['move 1', 'gap 2-2', 'move 3', 'gap 4-4', 'move 5']);
        expect(logged).toHaveBeenCalledTimes(2);
        logged.mockRestore();
    });

    it('gives a gap to the handler the latest declaration of the channel named, whichever room it is for', async () => {
        const pages = createGapPages();
        const later: number[] = [];
        pages.bob.messages.room<EdgeOrderTestMove>({
            ...EDGE_ORDER_TEST_MOVES,
            roomRef: { ...EDGE_ORDER_TEST_MOVES.roomRef!, groupId: 'other-room' },
            onOrderGap: (gap) => {
                later.push(gap.fromPosition);
            }
        });
        // A declaration that names no handler leaves the one before it standing.
        pages.bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        const sent = await sendMoves(pages.alice, 3, [2]);

        await pages.bob.deliver('ws', sent[0]);
        await pages.bob.deliver('ws', sent[2]);

        expect(later).toEqual([2]);
        expect(pages.gaps).toEqual([]);
    });

    it('refuses onOrderGap on a channel that is not edge-ordered, and one that is not a function', () => {
        const page = createEdgeOrderPage({ sessionId: 'alice-session' });
        const refused = (code: string) => expect.objectContaining({ issues: [expect.objectContaining({ path: '$.onOrderGap', code })] });

        expect(() => page.messages.room({ ...EDGE_ORDER_TEST_MOVES, order: undefined, onOrderGap: () => {} })).toThrow(
            refused('unsupported')
        );
        // A JavaScript caller's definition: nothing checked its fields before the page did.
        const unchecked: RallarRoomMessageChannelDefinition = JSON.parse(
            JSON.stringify({ ...EDGE_ORDER_TEST_MOVES, onOrderGap: 'log' })
        );
        expect(() => page.messages.room(unchecked)).toThrow(refused('invalid-order-gap-handler'));
    });
});

describe('an edge-ordered room channel: usage', () => {
    it('counts what the page holds now, and what it gave up since it loaded', async () => {
        const pages = createGapPages();
        const sent = await sendMoves(pages.alice, 6, [2]);
        // Five sends are open, and the cancelled one is a hole the stream still states.
        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 1, openSends: 6 });

        await pages.bob.deliver('ws', sent[0]);
        await pages.bob.deliver('ws', sent[2]);
        await pages.bob.deliver('ws', sent[4]);
        await pages.bob.deliver('ws', sent[5]);
        await pages.bob.deliver('ws', sent[0]);

        // Bob passed the cancelled send 2 and is holding 5 and 6 for send 4; the second copy of 1 was late.
        expect(pages.bob.messages.readUsage().edgeOrder).toEqual({
            streams: 1,
            heldMessages: 2,
            evictedStreams: 0,
            lateDrops: 1,
            gaps: 1,
            heldDropped: 0,
            sendStreams: 0,
            openSends: 0
        });

        pages.bob.detach();
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ heldMessages: 0, heldDropped: 2 });
    });
});
