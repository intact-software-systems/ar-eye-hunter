import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    RallarMessage,
    RallarMessageHandle,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import {
    createEdgeOrderPage,
    EDGE_ORDER_TEST_MOVES,
    EDGE_ORDER_TEST_ROOM,
    readEdgeOrderDrops,
    type EdgeOrderPage,
    type EdgeOrderTestMove
} from './edge-order-page-fixture.ts';

interface SeenMove {
    readonly n: number;
    readonly transport: string;
    readonly position: number | undefined;
}

const PLAIN_MOVES: RallarRoomMessageChannelDefinition = { ...EDGE_ORDER_TEST_MOVES, order: undefined };

interface TwoPages {
    readonly alice: EdgeOrderPage;
    readonly bob: EdgeOrderPage;
    readonly send: RallarTypedMessageChannel<EdgeOrderTestMove>;
    readonly seen: SeenMove[];
    readonly messages: RallarMessage<EdgeOrderTestMove>[];
}

/** Alice sends on the channel; Bob listens on both carriers and records what his handlers were given, in order. */
function createTwoPages(bobDefinition = EDGE_ORDER_TEST_MOVES): TwoPages {
    const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
    const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
    const seen: SeenMove[] = [];
    const messages: RallarMessage<EdgeOrderTestMove>[] = [];
    const receive = bob.messages.room<EdgeOrderTestMove>(bobDefinition);
    const record = (payload: EdgeOrderTestMove, message: RallarMessage<EdgeOrderTestMove>): void => {
        seen.push({ n: payload.n, transport: message.transport, position: message.order?.position });
        messages.push(message);
    };
    receive.onWs(record);
    receive.onRtc(record);
    return { alice, bob, send: alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES), seen, messages };
}

async function sendMoves(pages: TwoPages, carrier: 'ws' | 'rtc', count: number): Promise<readonly ALMessage[]> {
    for (let n = 1; n <= count; n += 1) {
        await (carrier === 'ws' ? pages.send.sendWs({ n }) : pages.send.sendRtc({ n }));
    }
    return pages.alice.sent[carrier];
}

/** The positions the page stated it held for their turn, in arrival order. */
function heldPositions(page: EdgeOrderPage): Array<number | null> {
    return page.diagnostics.flatMap((event) => event.kind === 'edge-order-arrival' && event.outcome === 'held' ? [event.position] : []);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an edge-ordered room channel: order', () => {
    it.each(['ws', 'rtc'] as const)('hands in-order arrivals over %s to the handler at once, each with its position', async (carrier) => {
        const pages = createTwoPages();
        const sent = await sendMoves(pages, carrier, 3);

        for (const message of sent) {
            await pages.bob.deliver(carrier, message);
        }

        expect(pages.seen).toEqual([
            { n: 1, transport: carrier, position: 1 },
            { n: 2, transport: carrier, position: 2 },
            { n: 3, transport: carrier, position: 3 }
        ]);
        expect(new Set(pages.messages.map((message) => message.order?.stream)).size).toBe(1);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([]);
    });

    it.each(['ws', 'rtc'] as const)('puts a pair swapped in transit over %s back in send order', async (carrier) => {
        const pages = createTwoPages();
        const [first, second, third] = await sendMoves(pages, carrier, 3);

        await pages.bob.deliver(carrier, first);
        await pages.bob.deliver(carrier, third);
        expect(pages.seen.map((move) => move.n)).toEqual([1]);

        await pages.bob.deliver(carrier, second);
        expect(pages.seen.map((move) => move.n)).toEqual([1, 2, 3]);
        expect(heldPositions(pages.bob)).toEqual([3]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([]);
    });

    it('sorts one stream that arrives over both carriers, and gives each message to its own carrier\'s handlers', async () => {
        const pages = createTwoPages();
        await pages.send.send({ n: 1 }, { strategy: 'rtc' });
        await pages.send.send({ n: 2 }, { strategy: 'ws' });
        await pages.send.send({ n: 3 }, { strategy: 'rtc' });
        const [first, third] = pages.alice.sent.rtc;
        const [second] = pages.alice.sent.ws;

        await pages.bob.deliver('rtc', first);
        await pages.bob.deliver('rtc', third);
        await pages.bob.deliver('ws', second);

        expect(pages.seen).toEqual([
            { n: 1, transport: 'rtc', position: 1 },
            { n: 2, transport: 'ws', position: 2 },
            { n: 3, transport: 'rtc', position: 3 }
        ]);
    });

    it('hands a message over once when its copy arrives over the other carrier too', async () => {
        const pages = createTwoPages();
        const [first, second] = await sendMoves(pages, 'rtc', 2);

        await pages.bob.deliver('rtc', first);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', second);
        await pages.bob.deliver('rtc', second);

        expect(pages.seen).toEqual([
            { n: 1, transport: 'rtc', position: 1 },
            { n: 2, transport: 'ws', position: 2 }
        ]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            expect.objectContaining({ kind: 'edge-order-arrival', outcome: 'late', carrier: 'ws', position: 1 }),
            expect.objectContaining({ kind: 'edge-order-arrival', outcome: 'late', carrier: 'rtc', position: 2 })
        ]);
    });

    it('sorts a stream through a carrier the application has no handler on', async () => {
        const alice = createEdgeOrderPage({ sessionId: 'alice-session' });
        const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
        const seen: number[] = [];
        bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).onWs((payload) => {
            seen.push(payload.n);
        });
        const send = alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES);
        await send.sendRtc({ n: 1 });
        await send.sendWs({ n: 2 });

        // Message 1 came over RTC, which this application does not handle: its position is still passed.
        await bob.deliver('rtc', alice.sent.rtc[0]);
        await bob.deliver('ws', alice.sent.ws[0]);

        expect(seen).toEqual([2]);
        expect(readEdgeOrderDrops(bob)).toEqual([]);
    });

    it('waits for an async handler to finish one message before it is given the next', async () => {
        const pages = createTwoPages();
        const steps: string[] = [];
        let finishFirst: () => void = () => {};
        pages.bob.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).onWs(async (payload) => {
            steps.push(`start ${payload.n}`);
            if (payload.n === 1) {
                await new Promise<void>((resolve) => {
                    finishFirst = resolve;
                });
            }
            steps.push(`end ${payload.n}`);
        });
        const [first, second] = await sendMoves(pages, 'ws', 2);

        const firstDelivered = pages.bob.deliver('ws', first);
        const secondDelivered = pages.bob.deliver('ws', second);
        await vi.advanceTimersByTimeAsync(0);
        expect(steps).toEqual(['start 1']);

        finishFirst();
        await Promise.all([firstDelivered, secondDelivered]);
        expect(steps).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    });
});

describe('an edge-ordered room channel: the wrapper', () => {
    it('gives the handler the application payload, never the wrapper, and leaves the envelope as it travelled', async () => {
        const pages = createTwoPages();
        const laneSeen: object[] = [];
        pages.bob.messages.ws.onMessage<EdgeOrderTestMove>({ topicId: 'room.moves' }, (message) => {
            laneSeen.push(message.payload);
        });
        const [first] = await sendMoves(pages, 'ws', 1);

        await pages.bob.deliver('ws', first);

        expect(pages.messages[0].payload).toEqual({ n: 1 });
        expect(laneSeen).toEqual([{ n: 1 }]);
        expect(pages.messages[0].raw).toBe(first);
        expect(JSON.parse(first.payload.resource)).toEqual({
            edgeOrder: { stream: pages.messages[0].order?.stream, position: 1, lowestOpenPosition: 1 },
            payload: { n: 1 }
        });
    });

    it('counts the wrapper against the payload limit, and a send refused for it leaves no hole', async () => {
        const text = 'x'.repeat(200);
        const alice = createEdgeOrderPage({ sessionId: 'alice-session', maxPayloadBytes: JSON.stringify({ text }).length });
        const pages = createTwoPages();
        const edge = alice.messages.room<{ text: string; }>(EDGE_ORDER_TEST_MOVES);
        const plain = alice.messages.room<{ text: string; }>({ ...PLAIN_MOVES, topicId: 'room.notes' });

        const fits = await plain.sendWs({ text });
        await edge.sendWs({ text: 'a' });
        const refused = await edge.sendWs({ text });
        await edge.sendWs({ text: 'c' });

        expect(fits.lifecycle().state).toBe('queued');
        expect(refused.lifecycle()).toMatchObject({ state: 'rejected' });
        const [, first, next] = alice.sent.ws;
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', next);
        // Nothing of the refused send set out, so the next send took its position.
        expect(pages.messages.map((message) => message.order?.position)).toEqual([1, 2]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([]);
    });
});

describe('an edge-ordered room channel: the send side', () => {
    it('takes the position when the application calls send, whichever send is built first', async () => {
        const pages = createTwoPages();
        let connectFirst: () => void = () => {};
        pages.alice.heldConnects.push(
            new Promise<void>((resolve) => {
                connectFirst = resolve;
            })
        );

        const first = pages.send.sendWs({ n: 1 });
        const second = pages.send.sendWs({ n: 2 });
        await second;
        connectFirst();
        await first;

        const [builtFirst, builtSecond] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', builtFirst);
        expect(pages.seen).toEqual([]);
        await pages.bob.deliver('ws', builtSecond);
        expect(pages.seen.map((move) => move.n)).toEqual([1, 2]);
    });

    it('mints the stream in memory: per page, per room, and never from the session id', async () => {
        const pages = createTwoPages();
        const otherTab = createEdgeOrderPage({ sessionId: 'alice-session' });
        const otherRoom = { ...EDGE_ORDER_TEST_ROOM, groupId: 'other-room' };
        await pages.send.sendWs({ n: 1 });
        await pages.alice.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).sendWs({ n: 2 });
        await pages.alice.messages.room<EdgeOrderTestMove>({ ...EDGE_ORDER_TEST_MOVES, roomRef: otherRoom }).sendWs({ n: 3 });
        await otherTab.messages.room<EdgeOrderTestMove>(EDGE_ORDER_TEST_MOVES).sendWs({ n: 4 });

        const stamps = [...pages.alice.sent.ws, ...otherTab.sent.ws].map((message) => JSON.parse(message.payload.resource).edgeOrder);

        // The same channel and room share one stream, whichever channel object sent.
        expect(stamps.map((stamp) => stamp.position)).toEqual([1, 2, 1, 1]);
        expect(stamps[1].stream).toBe(stamps[0].stream);
        expect(new Set(stamps.map((stamp) => stamp.stream)).size).toBe(3);
        expect(stamps.map((stamp) => stamp.stream)).not.toContain('alice-session');
    });

    it('gives the position of a send that failed before it had a handle to the next send', async () => {
        const pages = createTwoPages();
        await pages.send.sendWs({ n: 1 });
        pages.alice.heldConnects.push(Promise.reject(new Error('The connect failed.')));
        await expect(pages.send.sendWs({ n: 2 })).rejects.toThrow('The connect failed.');
        await pages.send.sendWs({ n: 3 });
        const [first, next] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', next);

        expect(pages.seen.map((move) => [move.n, move.position])).toEqual([[1, 1], [3, 2]]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([]);
    });

    it('closes a refused send\'s position in a burst at once, while the sends before it are still open', async () => {
        const text = 'x'.repeat(200);
        const alice = createEdgeOrderPage({ sessionId: 'alice-session', maxPayloadBytes: JSON.stringify({ text }).length });
        const pages = createTwoPages();
        const channel = alice.messages.room<{ text: string; }>(EDGE_ORDER_TEST_MOVES);

        // One turn: each send has its position before the one before it is found refused.
        const burst = [channel.sendWs({ text: 'a' }), channel.sendWs({ text }), channel.sendWs({ text: 'c' })];
        const [, refused] = await Promise.all(burst);
        expect(refused.lifecycle().state).toBe('rejected');
        const [one, three] = alice.sent.ws;
        await pages.bob.deliver('ws', one);
        await pages.bob.deliver('ws', three);

        // Send 1 is still open, so message 3 cannot say that everything below it has ended: it names the hole.
        expect(JSON.parse(three.payload.resource).edgeOrder).toMatchObject({ lowestOpenPosition: 1, holes: [[2, 2]] });
        expect(pages.messages.map((message) => message.order?.position)).toEqual([1, 3]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            expect.objectContaining({ kind: 'edge-order-gap', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' })
        ]);
    });

    it.each<[string, (handle: RallarMessageHandle, pages: TwoPages) => Promise<void>]>([
        ['cancelled', async (handle) => {
            handle.cancel();
            await Promise.resolve();
        }],
        ['expired', async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        }]
    ])('closes the position of a %s send at once on the next message', async (_end, endSecond) => {
        const pages = createTwoPages();
        await pages.send.sendWs({ n: 1 });
        const second = await pages.send.sendWs({ n: 2 }, { ttlMs: 2_000 });
        await endSecond(second, pages);
        await pages.send.sendWs({ n: 3 });
        const [first, , third] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        expect(pages.seen.map((move) => move.n)).toEqual([1, 3]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            expect.objectContaining({ kind: 'edge-order-gap', fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' })
        ]);
    });

    it('tells receivers a send has ended once its lifecycle is over, and how long an open one can still arrive', async () => {
        const pages = createTwoPages();
        const first = await pages.send.sendWs({ n: 1 });
        await pages.send.sendWs({ n: 2 }, { ttlMs: 5_000 });
        first.cancel();
        await pages.send.sendWs({ n: 3 });

        const stamps = pages.alice.sent.ws.map((message) => JSON.parse(message.payload.resource).edgeOrder);

        expect(stamps).toEqual([
            expect.objectContaining({ position: 1, lowestOpenPosition: 1 }),
            expect.objectContaining({ position: 2, lowestOpenPosition: 1, earlierCanArriveUntilMs: 1_030_000 }),
            expect.objectContaining({ position: 3, lowestOpenPosition: 2, earlierCanArriveUntilMs: 1_005_000 })
        ]);
    });
});

describe('an edge-ordered room channel: gaps and drops', () => {
    it('skips a message that can no longer arrive, states the gap, and drops its late copy', async () => {
        const pages = createTwoPages();
        await pages.send.sendWs({ n: 1 }, { ttlMs: 4_000 });
        await pages.send.sendWs({ n: 2 }, { ttlMs: 5_000 });
        await pages.send.sendWs({ n: 3 });
        const [first, second, third] = pages.alice.sent.ws;
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(pages.seen.map((move) => move.n)).toEqual([1]);
        await vi.advanceTimersByTimeAsync(1);
        expect(pages.seen.map((move) => move.n)).toEqual([1, 3]);

        await pages.bob.deliver('ws', second);
        expect(pages.seen.map((move) => move.n)).toEqual([1, 3]);
        const stream = pages.messages[0].order?.stream;
        expect(readEdgeOrderDrops(pages.bob)).toEqual([
            {
                kind: 'edge-order-gap',
                topicId: 'room.moves',
                typeId: 'game.move',
                senderId: 'alice-session',
                stream,
                fromPosition: 2,
                toPosition: 2,
                reason: 'cannot-arrive'
            },
            {
                kind: 'edge-order-arrival',
                outcome: 'late',
                msgId: second.id.msgId,
                typeId: 'game.move',
                senderId: 'alice-session',
                carrier: 'ws',
                stream,
                position: 2,
                traceId: second.id.traceId,
                corrId: second.id.msgId
            }
        ]);
    });

    it('drops what it holds when the connect goes away, and keeps the stream where it stands', async () => {
        const pages = createTwoPages();
        const [first, second, third, fourth] = await sendMoves(pages, 'ws', 4);
        await pages.bob.deliver('ws', first);
        await pages.bob.deliver('ws', third);
        await pages.bob.deliver('ws', fourth);

        pages.bob.detach();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pages.seen.map((move) => move.n)).toEqual([1]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([{ kind: 'edge-order-held-dropped', count: 2 }]);

        // A copy of 1 is still late, and 2 is still next.
        await pages.bob.deliver('ws', first);
        vi.setSystemTime(1_000_000);
        await pages.bob.deliver('ws', second);
        expect(pages.seen.map((move) => move.n)).toEqual([1, 2]);
    });
});

describe('an edge-ordered room channel: declared on one end only', () => {
    it('does not hand over a message that carries no stamp, and states it', async () => {
        const pages = createTwoPages();
        await pages.alice.messages.room<EdgeOrderTestMove>(PLAIN_MOVES).sendWs({ n: 1 });
        const [plain] = pages.alice.sent.ws;

        await pages.bob.deliver('ws', plain);

        expect(pages.seen).toEqual([]);
        expect(readEdgeOrderDrops(pages.bob)).toEqual([{
            kind: 'edge-order-arrival',
            outcome: 'unwrapped',
            msgId: plain.id.msgId,
            typeId: 'game.move',
            senderId: 'alice-session',
            carrier: 'ws',
            stream: null,
            position: null,
            traceId: plain.id.traceId,
            corrId: plain.id.msgId
        }]);
    });

    it('gives a receiver that did not declare it the wrapped payload, in arrival order', async () => {
        const pages = createTwoPages(PLAIN_MOVES);
        const [first, second] = await sendMoves(pages, 'ws', 2);

        await pages.bob.deliver('ws', second);
        await pages.bob.deliver('ws', first);

        expect(pages.messages.map((message) => message.payload)).toEqual([
            { edgeOrder: expect.objectContaining({ position: 2 }), payload: { n: 2 } },
            { edgeOrder: expect.objectContaining({ position: 1 }), payload: { n: 1 } }
        ]);
        expect(pages.messages.map((message) => message.order)).toEqual([undefined, undefined]);
    });
});

describe('an edge-ordered room channel: refused shapes', () => {
    const unsupported = (path: string) => expect.objectContaining({ issues: [expect.objectContaining({ path, code: 'unsupported' })] });

    it('refuses a channel that stores its sends', () => {
        const page = createEdgeOrderPage({ sessionId: 'alice-session' });

        expect(() => page.messages.room<EdgeOrderTestMove>({ ...EDGE_ORDER_TEST_MOVES, durability: 'local-outbox' })).toThrow(
            unsupported('$.order')
        );
    });

    it('refuses a channel that names no room, and an order it does not know', () => {
        const page = createEdgeOrderPage({ sessionId: 'alice-session' });
        const { roomRef: _roomRef, ...roomless } = EDGE_ORDER_TEST_MOVES;

        expect(() => page.messages.channel<EdgeOrderTestMove>(roomless)).toThrow(unsupported('$.order'));
        expect(() => page.messages.room<EdgeOrderTestMove>({ ...EDGE_ORDER_TEST_MOVES, order: 'hop' as 'edge' })).toThrow(
            expect.objectContaining({ issues: [expect.objectContaining({ path: '$.order', code: 'invalid-order' })] })
        );
    });

    it.each<[string, string, (channel: RallarTypedMessageChannel<EdgeOrderTestMove>) => Promise<object>]>([
        ['a send to the room\'s leader', '$.ack', (channel) => channel.send({ n: 1 }, { ack: 'group-leader' })],
        ['a send to the server', '$.peerId', (channel) => channel.sendWs({ n: 1 }, { peerId: 'server' })],
        ['a world send', '$.scope', (channel) => channel.sendWs({ n: 1 }, { scope: 'world' })],
        ['a send with an ordering key', '$.orderingKey', (channel) => channel.send({ n: 1 }, { orderingKey: 'moves' })],
        ['a send with a sequence', '$.seq', (channel) => channel.sendRtc({ n: 1 }, { seq: 1 })],
        [
            'a superseding send',
            '$.qos.supersedence',
            (channel) => channel.send({ n: 1 }, { qos: { supersedence: { algo: 'latest-wins', opts: { supersedenceKey: 'k' } } } })
        ],
        ['a stored send', '$.qos.durability', (channel) => channel.send({ n: 1 }, { qos: { durability: { algo: 'local-outbox' } } })],
        ['the ws-then-rtc strategy', '$.strategy', (channel) => channel.send({ n: 1 }, { strategy: 'ws-then-rtc' })]
    ])('refuses %s as unsupported, and the refused send takes no position', async (_shape, path, sendRefused) => {
        const pages = createTwoPages();

        await expect(sendRefused(pages.send)).rejects.toThrow(
            expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ path, code: 'unsupported' })]) })
        );

        await pages.send.sendWs({ n: 2 });
        expect(JSON.parse(pages.alice.sent.ws[0].payload.resource).edgeOrder.position).toBe(1);
    });
});
