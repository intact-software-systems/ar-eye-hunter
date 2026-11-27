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

interface WaitPages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    /** The moves Bob's application saw, in the order it saw them. */
    readonly seen: number[];
    readonly gaps: RallarMessageOrderGap[];
}

type OrderWaits = Pick<RallarRoomMessageChannelDefinition, 'orderGapWaitMs' | 'orderEntryWindowMs'>;

/** Alice sends; Bob declares the channel with the waits a test names and records what he is handed. */
function createWaitPages(waits: OrderWaits): WaitPages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: number[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    bob.messages.room<EdgeOrderTestMove>({
        ...EDGE_ORDER_TEST_MOVES,
        ...waits,
        onOrderGap: (gap) => {
            gaps.push(gap);
        }
    }).onWs((payload) => {
        seen.push(payload.n);
    });
    return { alice, bob, seen, gaps };
}

/** Alice's moves 1 to `count`, each open for the default 30 s, as her WS carrier took them. */
async function sendMoves(page: EdgeOrderPage, count: number) {
    const channel = page.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    for (let n = 1; n <= count; n += 1) {
        await channel.sendWs({ n });
    }
    return page.sent.ws;
}

function toGapSummaries(gaps: readonly RallarMessageOrderGap[]) {
    return gaps.map((gap) => [gap.fromPosition, gap.toPosition, gap.reason]);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an edge-ordered room channel: orderGapWaitMs', () => {
    it('holds a message for a missing earlier one no longer than the channel says, then skips and reports', async () => {
        const pages = createWaitPages({ orderGapWaitMs: 300 });
        const [first, , third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        await vi.advanceTimersByTimeAsync(299);
        expect(pages.seen).toEqual([1]);

        await vi.advanceTimersByTimeAsync(1);
        expect(pages.seen).toEqual([1, 3]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'channel-wait-cap']]);
    });

    it('drops as late, and counts, the message that arrives after the channel\'s wait for it ended', async () => {
        const pages = createWaitPages({ orderGapWaitMs: 300 });
        const [first, second, third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);
        await vi.advanceTimersByTimeAsync(300);

        await pages.bob.deliver('ws', second);

        expect(pages.seen).toEqual([1, 3]);
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ lateDrops: 1, gaps: 1 });
    });

    it('waits as long as the sender says the missing message can arrive when the channel names no cap', async () => {
        const pages = createWaitPages({});
        const [first, second, third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        await vi.advanceTimersByTimeAsync(20_000);
        expect(pages.seen).toEqual([1]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen).toEqual([1, 2, 3]);
        expect(pages.gaps).toEqual([]);
    });

    it('never waits when the channel says 0', async () => {
        const pages = createWaitPages({ orderGapWaitMs: 0 });
        const [first, , third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', first);

        await pages.bob.deliver('ws', third);

        expect(pages.seen).toEqual([1, 3]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'channel-wait-cap']]);
    });
});

describe('an edge-ordered room channel: orderEntryWindowMs', () => {
    it('starts a stream first seen past its start when the channel\'s entry window ends', async () => {
        const pages = createWaitPages({ orderEntryWindowMs: 100 });
        const [, , third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', third);

        await vi.advanceTimersByTimeAsync(99);
        expect(pages.seen).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(pages.seen).toEqual([3]);
        expect(pages.gaps).toEqual([]);
    });

    it('waits the default 500 ms when the channel names no window', async () => {
        const pages = createWaitPages({});
        const [, , third] = await sendMoves(pages.alice, 3);
        await pages.bob.deliver('ws', third);

        await vi.advanceTimersByTimeAsync(499);
        expect(pages.seen).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(pages.seen).toEqual([3]);
    });

    it('starts at once when the channel says 0', async () => {
        const pages = createWaitPages({ orderEntryWindowMs: 0 });
        const [, , third] = await sendMoves(pages.alice, 3);

        await pages.bob.deliver('ws', third);

        expect(pages.seen).toEqual([3]);
        expect(pages.gaps).toEqual([]);
    });
});

describe('an edge-ordered room channel: which declaration\'s waits stand', () => {
    it('takes each wait from the latest declaration of the topic and type that names it, whichever room it is for', async () => {
        const pages = createWaitPages({ orderGapWaitMs: 5_000, orderEntryWindowMs: 100 });
        pages.bob.messages.room<EdgeOrderTestMove>({
            ...EDGE_ORDER_TEST_MOVES,
            roomRef: { ...EDGE_ORDER_TEST_MOVES.roomRef!, groupId: 'other-room' },
            orderGapWaitMs: 300
        });
        // A declaration that names neither wait leaves both standing.
        pages.bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        const [, second, , fourth] = await sendMoves(pages.alice, 4);

        // The entry window is the first declaration's: the later ones did not name one.
        await pages.bob.deliver('ws', second);
        await vi.advanceTimersByTimeAsync(100);
        expect(pages.seen).toEqual([2]);

        // The gap wait is the second declaration's.
        await pages.bob.deliver('ws', fourth);
        await vi.advanceTimersByTimeAsync(300);
        expect(pages.seen).toEqual([2, 4]);
        expect(toGapSummaries(pages.gaps)).toEqual([[3, 3, 'channel-wait-cap']]);
    });

    it('gives a stream the waits that stand when its next message arrives', async () => {
        const pages = createWaitPages({});
        const [first, , third, fourth] = await sendMoves(pages.alice, 4);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        pages.bob.messages.room<EdgeOrderTestMove>({ ...EDGE_ORDER_TEST_MOVES, orderGapWaitMs: 200 });
        // Message 3 is held under the waits that stood when it arrived.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pages.seen).toEqual([1]);

        // The stream's next arrival brings the new cap, which counts from when each message was first held.
        await pages.bob.deliver('ws', fourth);
        expect(pages.seen).toEqual([1, 3, 4]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'channel-wait-cap']]);
    });
});

describe('an edge-ordered room channel: refused waits', () => {
    const refused = (path: string, code: string) => expect.objectContaining({ issues: [expect.objectContaining({ path, code })] });

    it.each<[keyof OrderWaits]>([['orderGapWaitMs'], ['orderEntryWindowMs']])(
        'refuses %s on a channel that is not edge-ordered',
        (option) => {
            const page = createEdgeOrderPage({ sessionId: 'alice-session' });

            expect(() => page.messages.room({ ...EDGE_ORDER_TEST_MOVES, order: undefined, [option]: 100 })).toThrow(
                refused(`$.${option}`, 'unsupported')
            );
        }
    );

    it.each<[keyof OrderWaits, string, number | string | null]>([
        ['orderGapWaitMs', 'invalid-order-gap-wait', -1],
        ['orderGapWaitMs', 'invalid-order-gap-wait', 1.5],
        ['orderGapWaitMs', 'invalid-order-gap-wait', Number.POSITIVE_INFINITY],
        ['orderGapWaitMs', 'invalid-order-gap-wait', '300'],
        ['orderEntryWindowMs', 'invalid-order-entry-window', -1],
        ['orderEntryWindowMs', 'invalid-order-entry-window', 0.5],
        ['orderEntryWindowMs', 'invalid-order-entry-window', Number.NaN],
        ['orderEntryWindowMs', 'invalid-order-entry-window', null]
    ])('refuses %s as %s when it is %s', (option, code, value) => {
        const page = createEdgeOrderPage({ sessionId: 'alice-session' });
        // A JavaScript caller's definition: nothing checked its fields before the page did.
        const unchecked: RallarRoomMessageChannelDefinition = Object.assign({}, EDGE_ORDER_TEST_MOVES, {
            [option]: value
        });

        expect(() => page.messages.room(unchecked)).toThrow(refused(`$.${option}`, code));
    });

    it('states both waits it refuses, beside what else the definition gets wrong', () => {
        const page = createEdgeOrderPage({ sessionId: 'alice-session' });

        expect(() =>
            page.messages.room({
                ...EDGE_ORDER_TEST_MOVES,
                durability: 'local-outbox',
                orderGapWaitMs: -1,
                orderEntryWindowMs: -1
            })
        ).toThrow(
            expect.objectContaining({
                issues: [
                    expect.objectContaining({ path: '$.order', code: 'unsupported' }),
                    expect.objectContaining({ path: '$.orderGapWaitMs', code: 'invalid-order-gap-wait' }),
                    expect.objectContaining({ path: '$.orderEntryWindowMs', code: 'invalid-order-entry-window' })
                ]
            })
        );
    });
});
