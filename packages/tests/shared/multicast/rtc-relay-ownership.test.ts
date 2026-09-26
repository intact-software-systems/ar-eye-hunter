import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

const ACK_TIMEOUT_MS = 2_000;

describe('the child hops an RTC relay owns', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('lets both recipients of a three-session star deliver and ACK, relaying nothing to each other', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'b'] });
        const message = createOriginReceiverMulticast('star');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');
        await c.receive(origin.channels.c!.sent[0]!, 'a');

        // In a star the origin already addresses both recipients, so neither owns the other as a child.
        expect(readCopies(await b.readSent('c'), message)).toBe(0);
        expect(readCopies(await c.readSent('b'), message)).toBe(0);
        const acks = [...await b.readSent('a'), ...await c.readSent('a')];
        expect(readAckTuples(acks)).toEqual([['b', 'delivered'], ['c', 'delivered']]);
        // A recipient that owns no child never asks the origin to retransmit (R-S2c-ii-9).
        expect(acks.map((control) => parseALControlMessage(control)?.type)).toEqual(['ack', 'ack']);
        for (const ack of acks) {
            await origin.manager.acceptControlMessage(ack);
        }
        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({ mode: 'receiver', complete: true, unconfirmedHopPeerIds: [] });

        await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);

        expect(origin.channels.b!.sent).toHaveLength(1);
        expect(origin.channels.c!.sent).toHaveLength(1);
    });

    it('never owns a sibling its sender addressed, even when the mesh also lists it as a neighbour', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c', 'd'] });
        const message = createOriginReceiverMulticast('mesh');
        await enqueueAndDrain(origin.manager, message);

        await b.receive(origin.channels.b!.sent[0]!, 'a');

        expect(readCopies(await b.readSent('c'), message)).toBe(0);
        expect(readCopies(await b.readSent('d'), message)).toBe(1);
    });

    it('sends an RTC unicast copy with no visited list, since unicast routing never reads it', async () => {
        const origin = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 4),
            nextHopPeerIds: ['b']
        });

        await enqueueAndDrain(
            origin.manager,
            newALUnicastMessage('a', { topicId: 'chat', resourceId: 'direct', contextId: 'room' }, 'b', 'chat.v1', {})
        );

        expect(origin.channels.b!.sent).toHaveLength(1);
        expect(origin.channels.b!.sent[0]!.diagnostics?.visitedPeerIds).toBeUndefined();
    });

    it('still completes the receipt when the visited list lost two mutually neighbouring siblings', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c', 'd'] });
        const peers = createStarPeers(snapshot, ['b', 'c', 'd']);
        const message = createOriginReceiverMulticast('past-cap');
        await enqueueAndDrain(origin.manager, message);

        // Past the cap the newest ids fall away: every recipient then owns the others and relays to them.
        for (const peerId of ['b', 'c', 'd']) {
            await peers.get(peerId)!.receive(toVisited(origin.channels[peerId]!.sent[0]!, ['a', 'b']), 'a');
        }
        await exchangeBetweenPeers(peers);
        for (const peerId of ['b', 'c', 'd']) {
            for (const control of await peers.get(peerId)!.readSent('a')) {
                await origin.manager.acceptControlMessage(control);
            }
        }

        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({
                mode: 'receiver',
                complete: true,
                confirmedRecipientPeerIds: expect.arrayContaining(['b', 'c', 'd']),
                unconfirmedRecipientPeerIds: []
            });
    });

    it('completes a peer that owns a sibling which is itself a relay, through that sibling answering it', async () => {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'e'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'b', 'e'] });
        const e = createRtcRelayOverlayFixture({ selfPeerId: 'e', snapshot, neighbourPeerIds: ['c'] });
        const message = createOriginReceiverMulticast('sibling-relay');
        await enqueueAndDrain(origin.manager, message);
        await c.receive(origin.channels.c!.sent[0]!, 'a');
        await e.receive((await c.readSent('e'))[0]!, 'c');
        await c.receive((await e.readSent('c'))[0]!, 'e');

        // `b` first hears of the message from a copy that names only its sender, so it owns its sibling `c`.
        await b.receive(toVisited(origin.channels.b!.sent[0]!, ['a', 'b']), 'a');
        expect(readCopies(await b.readSent('c'), message)).toBe(1);
        await c.receive((await b.readSent('c'))[0]!, 'b');
        for (const control of await c.readSent('b')) {
            await b.receive(control, 'c');
        }

        expect(readAckTuples(await c.readSent('b'))).toEqual([['c', 'subtree-complete']]);
        expect(readAckTuples(await b.readSent('a'))).toContainEqual(['b', 'subtree-complete']);
    });
});

describe('an RTC relay whose recorded parent left (R-S2c-ii-12)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('re-parents to the origin whose retry reaches it, so the leaf behind it is retried and confirmed', async () => {
        const message = createOriginReceiverMulticast('parent-left');
        const chain = await createChainAfterParentLeft(message);

        await chain.c.receive(chain.origin.channels.c!.sent[0]!, 'a');

        expect(readAckTuples(await chain.c.readSent('a'))).toEqual([]);
        const toLeaf = await chain.c.readSent('d');
        expect(readCopies(toLeaf, message)).toBe(2);
        await chain.d.receive(toLeaf.at(-1)!, 'c');
        for (const control of await chain.d.readSent('c')) {
            await chain.c.receive(control, 'd');
        }
        const answer = await chain.c.readSent('a');
        expect(readAckTuples(answer).toSorted()).toEqual([['c', 'subtree-complete'], ['d', 'forwarded']]);
        for (const ack of answer) {
            await chain.origin.manager.acceptControlMessage(ack);
        }
        const settled = readLastAcknowledgement(chain.origin);
        expect(settled).toMatchObject({ mode: 'receiver', complete: false, unconfirmedRecipientPeerIds: ['r'] });
        expect(settled?.kind === 'acknowledgement' && settled.confirmedRecipientPeerIds.toSorted()).toEqual(['c', 'd']);
    });

    it('never lets a subtree receipt read complete while the leaf behind the re-parented relay is silent, nor for the departed hop', async () => {
        const message = createOriginSubtreeMulticast('parent-left-subtree');
        const chain = await createChainAfterParentLeft(message);

        await chain.c.receive(chain.origin.channels.c!.sent[0]!, 'a');
        for (const control of await chain.c.readSent('a')) {
            await chain.origin.manager.acceptControlMessage(control);
        }

        expect(readLastAcknowledgement(chain.origin)?.complete ?? false).toBe(false);
        expect(await chain.origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeDefined();
        const toLeaf = await chain.c.readSent('d');
        await chain.d.receive(toLeaf.at(-1)!, 'c');
        for (const control of await chain.d.readSent('c')) {
            await chain.c.receive(control, 'd');
        }
        for (const control of await chain.c.readSent('a')) {
            await chain.origin.manager.acceptControlMessage(control);
        }
        // `c` now completes its own hop, but the retry keeps the departed `r` expected: its subtree was never
        // confirmed by the hop that owned it, so the receipt times out as on main (R-S2c-ii-14).
        expect(readLastAcknowledgement(chain.origin)).toMatchObject({
            mode: 'subtree',
            complete: false,
            confirmedHopPeerIds: ['c'],
            unconfirmedHopPeerIds: ['r']
        });
    });

    it('answers a sibling at once while the recorded parent stays, and re-parents to it once the parent left', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 's', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r'] });
        // `r` addresses both `c` and `s`, so `s` is a sibling of `c` until `r` leaves and `s` leads to it.
        const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c', 's'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['r', 's', 'd'] });
        const d = createRtcRelayOverlayFixture({ selfPeerId: 'd', snapshot, neighbourPeerIds: ['c'] });
        const message = createOriginReceiverMulticast('sibling-then-parent');
        await enqueueAndDrain(origin.manager, message);
        await r.receive(origin.channels.r!.sent[0]!, 'a');
        const copy = (await r.readSent('c'))[0]!;
        await c.receive(copy, 'r');

        await c.receive(copy, 's');
        expect(readAckTuples(await c.readSent('s'))).toEqual([['c', 'subtree-complete']]);
        expect(readCopies(await c.readSent('d'), message)).toBe(1);

        c.acceptSnapshot(createOriginSnapshot(['a', 's', 'c', 'd'], 5));
        await vi.advanceTimersByTimeAsync(1);
        await c.receive(copy, 's');
        expect(readAckTuples(await c.readSent('s'))).toEqual([['c', 'subtree-complete']]);
        const toLeaf = await c.readSent('d');
        expect(readCopies(toLeaf, message)).toBe(2);
        await d.receive(toLeaf.at(-1)!, 'c');
        for (const control of await d.readSent('c')) {
            await c.receive(control, 'd');
        }
        expect(readAckTuples((await c.readSent('s')).slice(1)).toSorted())
            .toEqual([['c', 'subtree-complete'], ['d', 'forwarded']]);
        expect(readAckTuples(await c.readSent('r'))).toEqual([]);
    });
});

describe('the RTC subtree retry keeps every unfinished hop expected (R-S2c-ii-14)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('never completes through a new hop that relays to a subtree it does not own (P4)', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r'] });
        const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c', 'b'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['r', 'b', 'd'] });
        const message = createOriginSubtreeMulticast('new-hop-relays');
        await enqueueAndDrain(origin.manager, message);
        await r.receive(origin.channels.r!.sent[0]!, 'a');
        // The copies r -> b and c -> d are lost, and the overlay of the origin gains b before its timeout.
        await c.receive((await r.readSent('c'))[0]!, 'r');
        await retryThroughNewHop(origin, 'b');

        await b.receive(origin.channels.b!.sent.at(-1)!, 'a');
        await c.receive((await b.readSent('c')).at(-1)!, 'b');
        for (const control of await c.readSent('b')) {
            await b.receive(control, 'c');
        }
        await acceptAtOrigin(origin, await b.readSent('a'));

        await expectSubtreeIncompleteUntilExhausted(origin, message);
    });

    it('never completes through a new hop that answers the retried copy for itself alone (P5)', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r'] });
        const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c', 'b'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c', 'r'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['r', 'b', 'd'] });
        const message = createOriginSubtreeMulticast('new-hop-leaf');
        await enqueueAndDrain(origin.manager, message);
        await r.receive(origin.channels.r!.sent[0]!, 'a');
        // Only c -> d is lost: b is a leaf that already delivered the copy r sent it.
        await c.receive((await r.readSent('c'))[0]!, 'r');
        await b.receive((await r.readSent('b'))[0]!, 'r');
        await retryThroughNewHop(origin, 'b');

        await b.receive(origin.channels.b!.sent.at(-1)!, 'a');
        expect(readAckTuples(await b.readSent('a'))).toEqual([['b', 'delivered']]);
        await acceptAtOrigin(origin, await b.readSent('a'));

        await expectSubtreeIncompleteUntilExhausted(origin, message);
    });

    it('keeps the receipt row of a mesh whose unfinished hop the retry routes around (P3)', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r', 'b'] });
        const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c'] });
        const b = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['r', 'b', 'd'] });
        const message = createOriginSubtreeMulticast('mesh-routed-around');
        await enqueueAndDrain(origin.manager, message);
        await r.receive(origin.channels.r!.sent[0]!, 'a');
        await b.receive(origin.channels.b!.sent[0]!, 'a');
        // Both relays own c; c records r as its parent and its copy to d is lost, so only b completes.
        await c.receive((await r.readSent('c'))[0]!, 'r');
        await c.receive((await b.readSent('c'))[0]!, 'b');
        for (const control of await c.readSent('b')) {
            await b.receive(control, 'c');
        }
        await acceptAtOrigin(origin, await b.readSent('a'));

        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);

        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'subtree', expectedPeerIds: ['r', 'b'], ackedPeerIds: ['b'] });
        await expectSubtreeIncompleteUntilExhausted(origin, message);
    });
});

describe('the RTC subtree targeted repair keeps every unfinished hop expected (R-S2c-ii-14)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('adds the requester to the hops a subtree receipt expects, never replacing the others with it', async () => {
        const origin = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b', 'c'], 4), nextHopPeerIds: ['b', 'c'] });
        const message = { ...createOriginSubtreeMulticast('targeted-repair'), qos: { repair: { algo: 'retransmit' } } } as const;
        await enqueueAndDrain(origin.manager, message);

        await origin.manager.acceptControlMessage(newALNackControlMessage(
            { v: 2, msgId: 'nack-from-b', senderId: 'b', ts: Date.now() },
            { msgId: message.id.msgId, fromPeerId: 'b', toPeerId: 'a', reason: 'gap', observedAtEpochMs: Date.now() }
        ));
        await vi.advanceTimersByTimeAsync(100);

        expect(origin.channels.b!.sent).toHaveLength(2);
        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'subtree', expectedPeerIds: ['b', 'c'] });
    });
});

describe('a relay re-parented away from a live parent (R-S2c-ii-14)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('lets the former parent, no longer a hop of the origin, still confirm itself under receiver', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r'] });
        const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c'] });
        const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'r', 'd'] });
        const d = createRtcRelayOverlayFixture({ selfPeerId: 'd', snapshot, neighbourPeerIds: ['c'] });
        const message = createOriginReceiverMulticast('live-parent');
        await enqueueAndDrain(origin.manager, message);
        await r.receive(origin.channels.r!.sent[0]!, 'a');
        // The copy c -> d is lost; r stays in the room but the origin's tree now reaches c directly.
        await c.receive((await r.readSent('c'))[0]!, 'r');
        origin.overlays.accept('room', createOriginOverlay(['c']));
        origin.ready.peerIds = ['c'];
        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);

        await c.receive(origin.channels.c!.sent.at(-1)!, 'a');
        await d.receive((await c.readSent('d')).at(-1)!, 'c');
        for (const control of await d.readSent('c')) {
            await c.receive(control, 'd');
        }
        for (const control of await c.readSent('r')) {
            await r.receive(control, 'c');
        }
        await acceptAtOrigin(origin, [...await c.readSent('a'), ...await r.readSent('a')]);

        const settled = readLastAcknowledgement(origin);
        expect(settled).toMatchObject({ mode: 'receiver', complete: true, unconfirmedRecipientPeerIds: [] });
        expect(settled?.kind === 'acknowledgement' && settled.confirmedRecipientPeerIds.toSorted()).toEqual(['c', 'd', 'r']);
    });
});

/** The overlay of the origin gains `peerId` as a next hop, and the ack timeout retries through it. */
async function retryThroughNewHop(origin: RtcOriginOverlayFixture, peerId: string): Promise<void> {
    origin.overlays.accept('room', createOriginOverlay(['r', peerId]));
    origin.ready.peerIds = ['r', peerId];
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);
    expect(origin.channels[peerId]!.sent).toHaveLength(1);
}

async function acceptAtOrigin(origin: RtcOriginOverlayFixture, controls: readonly ALMessage[]): Promise<void> {
    for (const control of controls) {
        await origin.manager.acceptControlMessage(control);
    }
}

/** `d` never received the message, so no settlement may read the subtree complete, up to the last retry. */
async function expectSubtreeIncompleteUntilExhausted(origin: RtcOriginOverlayFixture, message: ALMessage): Promise<void> {
    expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
        .toMatchObject({ mode: 'subtree', expectedPeerIds: expect.arrayContaining(['r']) });
    await vi.advanceTimersByTimeAsync(20 * ACK_TIMEOUT_MS);
    const acknowledgements = origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
    expect(acknowledgements.some((settlement) => settlement.complete)).toBe(false);
}

interface RelayChain {
    readonly origin: RtcOriginOverlayFixture;
    readonly c: RtcRelayOverlayFixture;
    readonly d: RtcRelayOverlayFixture;
}

/**
 * The tree `a -> r -> c -> d`: `c` forwarded to `d` and that copy was lost, then `r` left before relaying
 * anything upward, and the origin retried through its new next hop `c`.
 */
async function createChainAfterParentLeft(message: ALMessage): Promise<RelayChain> {
    const snapshot = createOriginSnapshot(['a', 'r', 'c', 'd'], 4);
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r'] });
    const r = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'c'] });
    const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'r', 'd'] });
    const d = createRtcRelayOverlayFixture({ selfPeerId: 'd', snapshot, neighbourPeerIds: ['c'] });
    await enqueueAndDrain(origin.manager, message);
    await r.receive(origin.channels.r!.sent[0]!, 'a');
    await c.receive((await r.readSent('c'))[0]!, 'r');
    expect(readCopies(await c.readSent('d'), message)).toBe(1);
    origin.groups.accept('room', createOriginSnapshot(['a', 'c', 'd'], 5));
    origin.overlays.accept('room', createOriginOverlay(['c']));
    origin.ready.peerIds = ['c'];
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);
    expect(origin.channels.c!.sent).toHaveLength(1);
    return { origin, c, d };
}

function createOriginSubtreeMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000 }
    );
}

function readLastAcknowledgement(origin: RtcOriginOverlayFixture) {
    return origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1);
}

function createStarPeers(
    snapshot: ReturnType<typeof createOriginSnapshot>,
    peerIds: readonly string[]
): ReadonlyMap<string, RtcRelayOverlayFixture> {
    return new Map(peerIds.map((peerId) => [
        peerId,
        createRtcRelayOverlayFixture({
            selfPeerId: peerId,
            snapshot,
            neighbourPeerIds: ['a', ...peerIds.filter((other) => other !== peerId)]
        })
    ]));
}

/** Delivers every copy and control the peers send each other until none is new. */
async function exchangeBetweenPeers(peers: ReadonlyMap<string, RtcRelayOverlayFixture>): Promise<void> {
    const delivered = new Map<string, number>();
    for (let round = 0; round < 6; round += 1) {
        for (const [fromPeerId, from] of peers) {
            for (const [toPeerId, to] of peers) {
                if (fromPeerId === toPeerId) {
                    continue;
                }
                const sent = await from.readSent(toPeerId);
                for (const message of sent.slice(delivered.get(`${fromPeerId}>${toPeerId}`) ?? 0)) {
                    await to.receive(message, fromPeerId);
                }
                delivered.set(`${fromPeerId}>${toPeerId}`, sent.length);
            }
        }
    }
}

function toVisited(message: ALMessage, visitedPeerIds: readonly string[]): ALMessage {
    return { ...message, diagnostics: { ...message.diagnostics, visitedPeerIds } };
}

function readCopies(messages: readonly ALMessage[], message: ALMessage): number {
    return messages.filter((sent) => sent.id.msgId === message.id.msgId).length;
}

function readAckTuples(messages: readonly ALMessage[]): readonly (readonly [string, string])[] {
    return messages.flatMap((message) => {
        const control = parseALControlMessage(message);
        return control?.type === 'ack' ? [[control.payload.logicalRecipientPeerId, control.payload.status] as const] : [];
    });
}
