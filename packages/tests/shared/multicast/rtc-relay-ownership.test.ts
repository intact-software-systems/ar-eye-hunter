import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
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
