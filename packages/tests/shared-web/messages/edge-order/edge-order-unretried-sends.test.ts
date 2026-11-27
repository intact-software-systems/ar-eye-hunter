import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    RallarMessageOrderGap,
    RallarTypedMessageChannel,
    RallarTypedMessageSendOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

interface UnretriedPages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    readonly send: RallarTypedMessageChannel<EdgeOrderTestMove>;
    /** The moves Bob's application saw, in the order it saw them. */
    readonly seen: number[];
    readonly gaps: RallarMessageOrderGap[];
}

type SendOptions = RallarTypedMessageSendOptions<EdgeOrderTestMove>;

/** The ways an application asks for a send nothing retries. */
const UNRETRIED: ReadonlyArray<[string, SendOptions]> = [
    ['best-effort', { reliability: 'best-effort' }],
    ['at-least-once and asks no receipt', { ack: 'none' }],
    ['best-effort by its QoS request', { qos: { delivery: { algo: 'best-effort' } } }],
    ['unreceipted by its QoS request', { qos: { ack: { algo: 'none' } } }]
];

function createUnretriedPages(): UnretriedPages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: number[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    bob.messages.room<EdgeOrderTestMove>({
        ...EDGE_ORDER_TEST_MOVES,
        onOrderGap: (gap) => {
            gaps.push(gap);
        }
    }).onWs((payload) => {
        seen.push(payload.n);
    });
    return { alice, bob, send: alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES), seen, gaps };
}

/** Alice's moves `from` to `to` over WS, each sent with `options`. */
async function sendMoves(pages: UnretriedPages, from: number, to: number, options: SendOptions): Promise<void> {
    for (let n = from; n <= to; n += 1) {
        await pages.send.sendWs({ n }, options);
    }
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

describe('an edge-ordered room channel: sends nothing retries', () => {
    it.each(UNRETRIED)('hands a stream of sends that are %s over in send order when they arrive in order', async (_kind, options) => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 3, options);

        for (const message of pages.alice.sent.ws) {
            await pages.bob.deliver('ws', message);
        }

        expect(pages.seen).toEqual([1, 2, 3]);
        expect(pages.gaps).toEqual([]);
    });

    it.each(UNRETRIED)('never waits for a send that is %s: the newest is handed over, the late one dropped and counted', async (_kind, options) => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 3, options);
        const [first, second, third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);

        await pages.bob.deliver('ws', third);
        expect(pages.seen).toEqual([1, 3]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'ended-at-sender']]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen).toEqual([1, 3]);
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ lateDrops: 1, gaps: 1, heldMessages: 0 });
    });

    it('starts at once at the first message it gets, with no entry window', async () => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 3, { reliability: 'best-effort' });

        await pages.bob.deliver('ws', pages.alice.sent.ws[2]);

        expect(pages.seen).toEqual([3]);
        expect(pages.gaps).toEqual([]);
    });

    it('keeps nothing at the sender for a send nothing retries', async () => {
        const pages = createUnretriedPages();

        await sendMoves(pages, 1, 5, { reliability: 'best-effort' });

        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 1, openSends: 0 });
        expect(pages.alice.sent.ws.map((message) => JSON.parse(message.payload.resource).edgeOrder)).toEqual(
            [1, 2, 3, 4, 5].map((position) => expect.objectContaining({ position, lowestOpenPosition: position }))
        );
    });

    it('waits, in one stream, for the sends that are retried and never for those that are not', async () => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 1, {});
        await sendMoves(pages, 2, 2, { reliability: 'best-effort' });
        await sendMoves(pages, 3, 4, {});
        const [first, second, third, fourth] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);

        // Sends 2 and 3 are both missing. Nothing retries 2, so only 3 is waited for.
        await pages.bob.deliver('ws', fourth);
        expect(pages.seen).toEqual([1]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'ended-at-sender']]);

        await pages.bob.deliver('ws', third);
        expect(pages.seen).toEqual([1, 3, 4]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen).toEqual([1, 3, 4]);
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ lateDrops: 1, gaps: 1 });
    });

    it('holds a send nothing retries for an earlier retried one that is still missing, and hands it over in its place', async () => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 2, {});
        await sendMoves(pages, 3, 3, { reliability: 'best-effort' });
        const [first, second, third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);

        await pages.bob.deliver('ws', third);
        expect(pages.seen).toEqual([1]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen).toEqual([1, 2, 3]);
        expect(pages.gaps).toEqual([]);
    });

    it('states a send nothing retries that never set out as a position no receiver waits for', async () => {
        const pages = createUnretriedPages();
        await sendMoves(pages, 1, 1, { reliability: 'best-effort' });
        let failConnect = (_error: Error): void => {};
        pages.alice.heldConnects.push(
            new Promise((_resolve, reject) => {
                failConnect = reject;
            })
        );
        const failed = pages.send.sendWs({ n: 2 }, { reliability: 'best-effort' });
        const third = pages.send.sendWs({ n: 3 }, { reliability: 'best-effort' });
        failConnect(new Error('The connect failed.'));
        await expect(failed).rejects.toThrow('The connect failed.');
        await third;
        const [first, afterFailure] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', afterFailure);

        expect(pages.seen).toEqual([1, 3]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'ended-at-sender']]);
    });
});

describe('an edge-ordered room channel: receipts it still refuses', () => {
    it.each<[string, string, SendOptions]>([
        ['a receipt from the room\'s leader', '$.ack', { ack: 'group-leader' }],
        ['a receipt from the next hop', '$.qos.ack', { qos: { ack: { algo: 'hop' } } }],
        ['a best-effort send that asks the leader', '$.ack', { reliability: 'best-effort', ack: 'group-leader' }]
    ])('refuses %s as unsupported, and the refused send takes no position', async (_shape, path, options) => {
        const pages = createUnretriedPages();

        await expect(pages.send.sendWs({ n: 1 }, options)).rejects.toThrow(
            expect.objectContaining({ issues: [expect.objectContaining({ path, code: 'unsupported' })] })
        );

        await pages.send.sendWs({ n: 2 });
        expect(JSON.parse(pages.alice.sent.ws[0].payload.resource).edgeOrder.position).toBe(1);
    });
});
