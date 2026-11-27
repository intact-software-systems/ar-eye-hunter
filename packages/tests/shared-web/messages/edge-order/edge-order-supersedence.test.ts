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

interface SupersedencePages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    readonly send: RallarTypedMessageChannel<EdgeOrderTestMove>;
    readonly seen: number[];
    readonly gaps: RallarMessageOrderGap[];
}

/** A send that replaces the earlier sends of `key` that have not arrived yet. */
function latestWins(key: string): RallarTypedMessageSendOptions<EdgeOrderTestMove> {
    return { qos: { supersedence: { algo: 'latest-wins', opts: { supersedenceKey: key } } } };
}

function createSupersedencePages(): SupersedencePages {
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

describe('an edge-ordered room channel: supersedence', () => {
    it('passes a send its carrier settled superseded as a hole, as soon as a later message says so', async () => {
        const pages = createSupersedencePages();
        await pages.send.sendWs({ n: 1 });
        await pages.send.sendWs({ n: 2 }, latestWins('cursor'));
        const [first, superseded] = pages.alice.sent.ws;
        pages.alice.supersede('ws', superseded);
        await pages.send.sendWs({ n: 3 });
        const third = pages.alice.sent.ws[2];
        await pages.bob.deliver('ws', first);

        await pages.bob.deliver('ws', third);

        expect(pages.seen).toEqual([1, 3]);
        expect(toGapSummaries(pages.gaps)).toEqual([[2, 2, 'ended-at-sender']]);
    });

    it('never waits for a send that a later send of the same key replaces: the latest is handed over at once', async () => {
        const pages = createSupersedencePages();
        await pages.send.sendWs({ n: 1 }, latestWins('cursor'));
        await pages.send.sendWs({ n: 2 }, latestWins('cursor'));
        const [replaced, latest] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', latest);
        expect(pages.seen).toEqual([2]);

        await pages.bob.deliver('ws', replaced);
        expect(pages.seen).toEqual([2]);
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ lateDrops: 1, heldMessages: 0 });
    });

    it('hands a replaced send over in its place when it arrives before the one that replaces it', async () => {
        const pages = createSupersedencePages();
        await pages.send.sendWs({ n: 1 }, latestWins('cursor'));
        await pages.send.sendWs({ n: 2 }, latestWins('cursor'));

        for (const message of pages.alice.sent.ws) {
            await pages.bob.deliver('ws', message);
        }

        expect(pages.seen).toEqual([1, 2]);
        expect(pages.gaps).toEqual([]);
    });

    it.each<[string, RallarTypedMessageSendOptions<EdgeOrderTestMove>]>([
        ['another key', latestWins('selection')],
        ['no key', {}]
    ])('still waits for an earlier send of %s', async (_earlier, earlierOptions) => {
        const pages = createSupersedencePages();
        await pages.send.sendWs({ n: 1 });
        await pages.send.sendWs({ n: 2 }, earlierOptions);
        await pages.send.sendWs({ n: 3 }, latestWins('cursor'));
        const [first, second, third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);

        await pages.bob.deliver('ws', third);
        expect(pages.seen).toEqual([1]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen).toEqual([1, 2, 3]);
        expect(pages.gaps).toEqual([]);
    });

    it('keeps nothing of a replaced send once the sends of its stream have ended', async () => {
        const pages = createSupersedencePages();
        for (const n of [1, 2, 3]) {
            await pages.send.sendWs({ n }, latestWins('cursor'));
        }
        for (const message of pages.alice.sent.ws) {
            pages.alice.acknowledge('ws', message);
        }

        // The stream's last send is open for its settle time, counted from the read that first sees it acknowledged.
        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 1, openSends: 1 });
        await vi.advanceTimersByTimeAsync(500);

        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 1, openSends: 0 });
    });
});
