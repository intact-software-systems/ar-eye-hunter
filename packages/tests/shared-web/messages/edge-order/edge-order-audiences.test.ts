import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type {
    RallarTypedMessageChannel,
    RallarTypedMessageSendOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

type SendOptions = RallarTypedMessageSendOptions<EdgeOrderTestMove>;

interface AudiencePages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    readonly send: RallarTypedMessageChannel<EdgeOrderTestMove>;
    /** The moves Bob's application saw, in the order it saw them, whichever carrier each came over. */
    readonly seen: number[];
}

/** A narrowed audience as a send names it, and the carrier the fixture's page hands that send to. */
const NARROWED: ReadonlyArray<[string, SendOptions, 'ws' | 'rtc']> = [
    ['a fixed list', { strategy: 'ws', recipientPeerIds: ['bob-session'] }, 'ws'],
    ['one principal', { strategy: 'ws', scope: 'principal', principalId: 'bob' }, 'ws'],
    ['everyone but one session', { strategy: 'ws', exceptPeerIds: ['carol-session'] }, 'ws'],
    ['one peer over WS', { strategy: 'ws', peerId: 'bob-session' }, 'ws'],
    ['one peer over RTC', { strategy: 'rtc', peerId: 'bob-session' }, 'rtc']
];

function createAudiencePages(): AudiencePages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: number[] = [];
    const receive = bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
    receive.onWs((payload) => {
        seen.push(payload.n);
    });
    receive.onRtc((payload) => {
        seen.push(payload.n);
    });
    return { alice, bob, send: alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES), seen };
}

function readStamp(message: ALMessage): EdgeOrderStamp {
    return JSON.parse(message.payload.resource).edgeOrder;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an edge-ordered room channel: narrowed audiences', () => {
    it.each(NARROWED)('gives a send to %s a stream of its own, so the room\'s stream has no hole for it', async (_audience, options, carrier) => {
        const pages = createAudiencePages();
        await pages.send.send({ n: 1 }, { strategy: 'ws' });
        await pages.send.send({ n: 10 }, options);
        await pages.send.send({ n: 2 }, { strategy: 'ws' });
        const narrowed = pages.alice.sent[carrier].find((message) => JSON.parse(message.payload.resource).payload.n === 10)!;
        const room = pages.alice.sent.ws.filter((message) => message !== narrowed);

        expect(room.map((message) => readStamp(message).position)).toEqual([1, 2]);
        expect(readStamp(room[1]).holes).toBeUndefined();
        expect(readStamp(narrowed)).toMatchObject({ position: 1, lowestOpenPosition: 1 });
        expect(readStamp(narrowed).stream).not.toBe(readStamp(room[0]).stream);
        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ sendStreams: 2 });
    });

    it.each(NARROWED)('sorts a stream sent to %s at its receiver like any other', async (_audience, options, carrier) => {
        const pages = createAudiencePages();
        for (const n of [1, 2, 3]) {
            await pages.send.send({ n }, options);
        }
        const [first, second, third] = pages.alice.sent[carrier];

        await pages.bob.deliver(carrier, first);
        await pages.bob.deliver(carrier, third);
        expect(pages.seen).toEqual([1]);

        await pages.bob.deliver(carrier, second);
        expect(pages.seen).toEqual([1, 2, 3]);
    });

    it('keeps one stream for one audience, in whatever order a send lists its sessions', async () => {
        const pages = createAudiencePages();

        await pages.send.sendWs({ n: 1 }, { recipientPeerIds: ['bob-session', 'carol-session'] });
        await pages.send.sendWs({ n: 2 }, { recipientPeerIds: ['carol-session', 'bob-session'] });
        await pages.send.sendWs({ n: 3 }, { recipientPeerIds: ['bob-session'] });

        const stamps = pages.alice.sent.ws.map(readStamp);
        expect(stamps.map((stamp) => stamp.position)).toEqual([1, 2, 1]);
        expect(stamps[1].stream).toBe(stamps[0].stream);
        expect(stamps[2].stream).not.toBe(stamps[0].stream);
    });

    it('does not let a session left out of a listed send wait for it', async () => {
        const pages = createAudiencePages();
        await pages.send.sendWs({ n: 1 });
        await pages.send.sendWs({ n: 10 }, { recipientPeerIds: ['carol-session'] });
        await pages.send.sendWs({ n: 2 });
        const [first, , second] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', second);

        expect(pages.seen).toEqual([1, 2]);
        expect(pages.bob.messages.readUsage().edgeOrder).toMatchObject({ gaps: 0, heldMessages: 0 });
    });
});

describe('an edge-ordered room channel: audiences it still refuses', () => {
    it('refuses a send addressed to the server once the connect names it, and keeps no open send for it', async () => {
        const pages = createAudiencePages();

        await expect(pages.send.sendWs({ n: 1 }, { peerId: 'server' })).rejects.toThrow(
            expect.objectContaining({ issues: [expect.objectContaining({ path: '$.peerId', code: 'unsupported' })] })
        );

        expect(pages.alice.sent.ws).toEqual([]);
        expect(pages.alice.messages.readUsage().edgeOrder).toMatchObject({ openSends: 0 });
    });

    it('refuses a world send, which names no room', async () => {
        const pages = createAudiencePages();

        await expect(pages.send.sendWs({ n: 1 }, { scope: 'world' })).rejects.toThrow(
            expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ path: '$.scope', code: 'unsupported' })]) })
        );
    });
});
