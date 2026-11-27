import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarRoomMessageChannelDefinition } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

/** The test channel on a topic only granted principals publish on, and only an elected session receives. */
const GRANTED_MOVES: RallarRoomMessageChannelDefinition = { ...EDGE_ORDER_TEST_MOVES, access: 'granted' };

interface SeenMove {
    readonly n: number;
    readonly transport: string;
    readonly position: number | undefined;
}

interface GrantedPages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    /** What the handler of Bob's election was given, in the order it was given it. */
    readonly seen: SeenMove[];
}

/** Alice publishes on the granted channel; Bob elects to receive it, as `subscribe(handler)` does. */
function createGrantedPages(): GrantedPages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    return { alice, bob, seen: subscribe(bob) };
}

function subscribe(page: EdgeOrderPage): SeenMove[] {
    const seen: SeenMove[] = [];
    page.messages.room<EdgeOrderTestMove>(GRANTED_MOVES).subscribe((payload, message) => {
        seen.push({ n: payload.n, transport: message.transport, position: message.order?.position });
    });
    return seen;
}

/** Alice's moves 1 to `count` on the granted channel, as the carrier took them. */
async function publishMoves(page: EdgeOrderPage, carrier: ALDeliveryCarrier, count: number) {
    const channel = page.messages.room<EdgeOrderTestMove>(GRANTED_MOVES);
    for (let n = 1; n <= count; n += 1) {
        await (carrier === 'rtc' ? channel.sendRtc({ n }) : channel.sendWs({ n }));
    }
    return page.sent[carrier];
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an edge-ordered granted room channel', () => {
    it.each<[ALDeliveryCarrier]>([['rtc'], ['ws']])(
        'hands its subscriber a pair swapped in transit over %s in send order, with the application\'s payload',
        async (carrier) => {
            const pages = createGrantedPages();
            const [first, second, third] = await publishMoves(pages.alice, carrier, 3);

            await pages.bob.deliver(carrier, first);
            await pages.bob.deliver(carrier, third);
            expect(pages.seen.map((move) => move.n)).toEqual([1]);

            await pages.bob.deliver(carrier, second);
            expect(pages.seen).toEqual([
                { n: 1, transport: carrier, position: 1 },
                { n: 2, transport: carrier, position: 2 },
                { n: 3, transport: carrier, position: 3 }
            ]);
        }
    );

    it('wraps the payload before the message is created, so a publisher proof signs the stamp with it', async () => {
        const pages = createGrantedPages();

        const [published] = await publishMoves(pages.alice, 'rtc', 1);

        expect(JSON.parse(published.payload.resource)).toEqual({
            edgeOrder: expect.objectContaining({ position: 1, lowestOpenPosition: 1 }),
            payload: { n: 1 }
        });
    });

    it('lets a session that elects after the stream began enter it like any late joiner', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
        const [, , third] = await publishMoves(alice, 'rtc', 3);
        const seen = subscribe(bob);

        // Publications 1 and 2 were never meant for Bob, and are still open at Alice: he waits his entry window.
        await bob.deliver('rtc', third);
        expect(seen).toEqual([]);

        await vi.advanceTimersByTimeAsync(500);
        expect(seen.map((move) => move.n)).toEqual([3]);
        expect(bob.messages.readUsage().edgeOrder).toMatchObject({ gaps: 0 });
    });
});
