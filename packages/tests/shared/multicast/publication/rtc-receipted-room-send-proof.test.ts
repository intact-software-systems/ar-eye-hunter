import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALRepairControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import { toALPublicationProofSigningInput } from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { toWsQueueBoxServerRecipientCopy } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-recipient-copy.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { createCountingSubtleCrypto, type CountingSubtleCrypto } from '../../signature/counting-subtle-crypto-fixtures.ts';
import type { AvailablePublicationCrypto } from '../../signature/publication-crypto-fixtures.ts';
import {
    createOriginReceiverMulticast,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    useFakeClock,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { signPublication } from '../rtc-publication-proof-fixtures.ts';
import {
    createChainHop,
    createRelayChain,
    deliverEach,
    toControlTuples,
    type RelayChain
} from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

/** The receipt window of an `at-least-once` send, after which its origin retries what is unconfirmed. */
const ACK_TIMEOUT_MS = 2_000;

const CHAT_TYPE_ID = 'chat.message.v1';

/**
 * D756: an ordinary RTC room multicast that asks a `receiver` or `leader` receipt is signed at its origin with the
 * session publication key and verified at every hop as a granted publication is; one that asks no logical receipt
 * stays unsigned.
 */
describe('the publisher proof of an ordinary receipted RTC room send (D756)', () => {
    useFakeClock();

    it('signs a receiver room multicast once in its first admission: the stored row and every copy carry one proof', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], {});
        const origin = createChainOrigin(chain, ['b', 'c']);

        const admitted = await enqueueAndDrain(origin.manager, createOriginReceiverMulticast('signed-once'));

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.proof).toEqual({ alg: 'ES256', keyId: chain.keys.a!.keyPair.keyId, signature: expect.any(String) });
        const copies = [...origin.channels.b!.sent, ...origin.channels.c!.sent];
        expect(copies).toHaveLength(2);
        for (const copy of copies) {
            expect(copy.proof).toEqual(admitted.message.proof);
            expect(toALPublicationProofSigningInput(copy)).toBe(toALPublicationProofSigningInput(admitted.message));
        }
    });

    it.each<[string, ALAckAlgo]>([
        ['no receipt', 'none'],
        ['a hop receipt', 'hop'],
        ['a subtree receipt', 'subtree']
    ])('leaves a room multicast that asks %s unsigned: no proof on the wire, no sign and no verify', async (_name, algo) => {
        const chain = await createRelayChain(['a', 'c'], {});
        const originCounting = createCountingSubtleCrypto();
        const origin = createChainOrigin(chain, ['c'], toCounted(chain, 'a', originCounting));
        const recipientCounting = createCountingSubtleCrypto();
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], publicationCrypto: toCounted(chain, 'c', recipientCounting) });
        const message = createOriginMulticast(`unsigned-${algo}`, algo);

        const admitted = await enqueueAndDrain(origin.manager, message);
        await c.receive(origin.channels.c!.sent[0]!, 'a');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect([admitted.message.proof, origin.channels.c!.sent[0]!.proof]).toEqual([undefined, undefined]);
        expect(c.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
        expect([originCounting.counts.sign, recipientCounting.counts.verify]).toEqual([0, 0]);
    });

    it.each(['receiver', 'leader'] as const)(
        'refuses an unsigned frame that asks a %s receipt at a relay: nothing delivered, forwarded or answered',
        async (mode) => {
            const chain = await createRelayChain(['a', 'r', 'c'], {});
            const snapshot = mode === 'leader' ? toOriginDirectedSnapshot(chain.snapshot, 'c', Date.now()) : chain.snapshot;
            const relay = createRtcRelayOverlayFixture({
                selfPeerId: 'r',
                snapshot,
                neighbourPeerIds: ['a', 'c'],
                publicationCrypto: chain.keys.r
            });

            await relay.receive(toUnsignedRelayedCopy(mode), 'a');

            expect([relay.delivered, await relay.readSent('c'), await relay.readSent('a')]).toEqual([[], [], []]);
            expect(readAdmissionReasons(relay)).toEqual(['unauthorized: missing-proof']);
        }
    );

    it('relays a signed receiver frame over two hops: the leaf verifies, delivers and confirms it as the origin signed it', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], {});
        const origin = createChainOrigin(chain, ['r']);
        // The relay cannot honour the origin's `expires-at`: a relay that re-stamped its expiry would break the proof.
        const r = createRtcRelayOverlayFixture({
            selfPeerId: 'r',
            snapshot: chain.snapshot,
            neighbourPeerIds: ['a', 'c'],
            publicationCrypto: chain.keys.r,
            qosProvider: { capabilitiesForMessage: () => ({ supportedExpiry: ['fresh-until'] }) }
        });
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'] });
        const message = { ...createOriginReceiverMulticast('relayed-signed'), targets: toOriginFrozenTargets(['r', 'c'], 3) };
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const signed = origin.channels.r!.sent[0]!;

        await r.receive(signed, 'a');
        const [forwarded] = await r.readSent('c');
        await c.receive(forwarded!, 'r');
        await deliverEach(await c.readSent('r'), r, 'c');
        await acceptEach(origin, await r.readSent('a'));

        expect(signed.proof).toBeDefined();
        expect([forwarded!.qos?.expiry, forwarded!.constraints?.expiresAtMs]).toEqual([signed.qos?.expiry, signed.constraints?.expiresAtMs]);
        expect(toALPublicationProofSigningInput(forwarded!)).toBe(toALPublicationProofSigningInput(signed));
        expect(c.delivered.map((delivered) => delivered.payload.resource)).toEqual([signed.payload.resource]);
        expect(readLastAcknowledgement(origin, message)).toMatchObject({ confirmedRecipientPeerIds: ['r', 'c'], complete: true });
    });

    it('holds a copy another member signed with its own key under the origin\'s id, never delivering or confirming it', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], {});
        const origin = createChainOrigin(chain, ['b', 'c']);
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a', 'b'] });
        const message = { ...createOriginReceiverMulticast('re-signed'), targets: toOriginFrozenTargets(['b', 'c'], 3) };
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const originCopy = origin.channels.c!.sent[0]!;
        const reSigned = await signPublication(chain.keys.b!, {
            ...originCopy,
            payload: { ...originCopy.payload, resource: JSON.stringify({ text: 'forged by b' }) },
            proof: undefined
        });

        await c.receive(reSigned, 'b');

        expect(c.delivered).toEqual([]);
        expect(readAdmissionReasons(c)).toEqual(['not-yet-in-sync: unknown-key']);
        expect(toControlTuples(await c.readSentControls('b'))).toEqual([['nack', 'c', 'not-yet-in-sync']]);
    });

    it('delivers once a replay of the origin\'s own signed copy that another member hands on before the origin\'s copy', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], {});
        const origin = createChainOrigin(chain, ['b', 'c']);
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a', 'b'] });
        const message = { ...createOriginReceiverMulticast('replayed'), targets: toOriginFrozenTargets(['b', 'c'], 3) };
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const originCopy = origin.channels.c!.sent[0]!;

        await c.receive(structuredClone(originCopy), 'b');
        await c.receive(originCopy, 'a');

        expect(originCopy.proof).toBeDefined();
        expect(c.delivered.map((delivered) => delivered.payload.resource)).toEqual([originCopy.payload.resource]);
        expect(readAdmissionReasons(c)[0]).toBe('admitted');
    });

    it('resends the stored signed frame at an ack-timeout retry, which the recipient verifies, delivers and confirms', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const origin = createChainOrigin(chain, ['c']);
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'] });
        const message = createOriginReceiverMulticast('retried');
        const admitted = await enqueueAndDrain(origin.manager, message);

        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);
        const [first, retried] = origin.channels.c!.sent;
        await c.receive(structuredClone(retried!), 'a');
        await acceptEach(origin, await c.readSent('a'));

        expect(admitted.message.proof).toBeDefined();
        expect(retried!.proof).toEqual(admitted.message.proof);
        expect(toALPublicationProofSigningInput(retried!)).toBe(toALPublicationProofSigningInput(first!));
        expect(c.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
        expect(readLastAcknowledgement(origin, message)).toMatchObject({ confirmedRecipientPeerIds: ['c'], complete: true });
    });

    it('answers a recipient\'s gap repair with the stored signed frame, which the recipient verifies and delivers', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const origin = createChainOrigin(chain, ['c']);
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'] });
        const message = createOriginReceiverMulticast('repaired');
        const admitted = await enqueueAndDrain(origin.manager, message);

        const repair = await origin.manager.acceptControlMessage(toRepairControl(admitted.message, 'c'));
        await vi.advanceTimersByTimeAsync(0);
        const repaired = origin.channels.c!.sent[1]!;
        await c.receive(structuredClone(repaired), 'a');

        expect(repair.kind).toBe('committed');
        expect(admitted.message.proof).toBeDefined();
        expect(repaired.proof).toEqual(admitted.message.proof);
        expect(toALPublicationProofSigningInput(repaired)).toBe(toALPublicationProofSigningInput(admitted.message));
        expect(c.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
    });

    it('hands WS a recipient copy of a signed receipted frame without its proof, which the WS client admits', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const origin = createChainOrigin(chain, ['c']);
        const admitted = await enqueueAndDrain(origin.manager, createOriginReceiverMulticast('ws-copy'));
        const copy = toWsQueueBoxServerRecipientCopy({ message: admitted.message, recipientPeerId: 'c', sentPositions: null }).right!;
        const ws = createWsClient('c');

        const accepted = await ws.client.acceptIncomingMessage(copy);
        await vi.advanceTimersByTimeAsync(0);

        expect(admitted.message.proof).toBeDefined();
        expect(copy.proof).toBeUndefined();
        expect(accepted.right?.kind).toBe('admitted');
        await vi.waitFor(() => expect(ws.delivered).toEqual([admitted.message.id.msgId]));
    });
});

/** The two receipted room shapes the proof requirement does not sign: neither can be forged into a confirmed receipt. */
describe('the receipted RTC room sends that carry no publisher proof (D756)', () => {
    useFakeClock();

    it('refuses a receiver room broadcast naming only its exclusions as unsupported: its origin never freezes or signs it', async () => {
        const chain = await createRelayChain(['a', 'b', 'c', 'd'], {});
        const origin = createChainOrigin(chain, ['b', 'c']);
        const message = createExclusionsOnlyBroadcast('exclusions-only');

        const leg = await origin.manager.enqueueLegIfAbsent(message, 'hand-over');
        const carried = await enqueueAndDrain(origin.manager, { ...message, id: { ...message.id, msgId: `${message.id.msgId}-carried` } });

        for (const result of [leg, carried]) {
            expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
            expect(result.message.targets).toEqual(message.targets);
        }
        expect([...origin.channels.b!.sent, ...origin.channels.c!.sent]).toEqual([]);
    });

    it('refuses an unsigned receiver room broadcast naming only its exclusions at a recipient: nothing delivered or answered', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], {});
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a', 'b'] });
        const message = createExclusionsOnlyBroadcast('forged-exclusions-only');

        await c.receive({ ...message, forwarding: { ...message.forwarding, nextHopPeerIds: ['c'] } }, 'b');

        expect([c.delivered, await c.readSent('b')]).toEqual([[], []]);
        expect(readAdmissionReasons(c)).toEqual(['unauthorized: missing-proof']);
    });

    it('never relays a receiver room unicast: a hop that is not its addressee neither forwards nor delivers it', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], {});
        const r = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'] });
        const unicast = createReceiverUnicast('relayed-unicast');

        await r.receive({ ...unicast, forwarding: { ...unicast.forwarding, nextHopPeerIds: ['r'] } }, 'a');
        await r.forward(unicast, 'a');

        expect([r.delivered, await r.readSent('c'), await r.readSent('a')]).toEqual([[], [], []]);
    });
});

interface WsRecipient {
    readonly client: ReturnType<typeof createDefaultWsQueueBoxClientService>;
    readonly delivered: string[];
}

/** The chain's origin `a`, signing with its own key, over `nextHopPeerIds`. */
function createChainOrigin(
    chain: RelayChain,
    nextHopPeerIds: readonly string[],
    publicationCrypto: AvailablePublicationCrypto = chain.keys.a!
): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds, publicationCrypto });
}

/** The session's own key over the counted WebCrypto. */
function toCounted(chain: RelayChain, sessionId: string, counting: CountingSubtleCrypto): AvailablePublicationCrypto {
    return { ...chain.keys[sessionId]!, subtle: counting.subtle };
}

/** A room multicast from `a` whose receipt is `algo`, asked through its quality of service. */
function createOriginMulticast(resourceId: string, algo: ALAckAlgo): ALMessage {
    return newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: { topicId: 'chat', resourceId, contextId: 'room' },
        groupRef: ORIGIN_ROOM,
        typeId: CHAT_TYPE_ID,
        resource: { text: resourceId },
        options: {
            ack: 'none',
            reliability: algo === 'none' ? 'best-effort' : 'at-least-once',
            ttlMs: 30_000,
            traceId: `trace-${resourceId}`,
            ...(algo === 'none' ? {} : { qos: { ack: { algo } } })
        }
    });
}

/** The transport copy an origin that did not sign would send its relay `r`, frozen to `c` and asking `mode`. */
function toUnsignedRelayedCopy(mode: 'receiver' | 'leader'): ALMessage {
    const message = newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: { topicId: 'chat', resourceId: `unsigned-${mode}`, contextId: 'room' },
        groupRef: ORIGIN_ROOM,
        typeId: CHAT_TYPE_ID,
        resource: { text: 'unsigned' },
        options: {
            ack: mode === 'leader' ? 'group-leader' : 'receiver',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            traceId: `trace-unsigned-${mode}`
        }
    });
    return {
        ...message,
        targets: toOriginFrozenTargets(['c'], 3),
        forwarding: { ...message.forwarding, nextHopPeerIds: ['r'] },
        constraints: { ...message.constraints, expiresAtMs: message.id.ts + 30_000 }
    };
}

function toRepairControl(message: ALMessage, fromPeerId: string): ALMessage {
    return newALRepairControlMessage(
        { v: 4, msgId: `repair-${fromPeerId}`, senderId: fromPeerId, ts: Date.now(), traceId: `trace-repair-${fromPeerId}` },
        { msgId: message.id.msgId, fromPeerId, toPeerId: 'a', reason: 'retransmit', observedAtEpochMs: Date.now() }
    );
}

function createWsClient(sessionId: string): WsRecipient {
    const creationNow = () => Temporal.Instant.fromEpochMilliseconds(Date.now());
    const client = createDefaultWsQueueBoxClientService({
        nowEpochMs: () => Date.now(),
        creationNow,
        outbox: new InMemoryQueueBox(undefined, creationNow),
        socket: new JsonWebSocketClient('ws://receipted-room-send', createPassThroughTransportFaultPort()),
        sessionId,
        serverPeerId: 'server',
        qosProvider: {}
    });
    onTestFinished(() => client.close());
    const delivered: string[] = [];
    client.onAllInboxMessagesDo({
        onMessage: async (message) => {
            delivered.push(message.id.msgId);
        }
    });
    return { client, delivered };
}

async function acceptEach(origin: RtcOriginOverlayFixture, messages: readonly ALMessage[]): Promise<void> {
    for (const message of messages) {
        await origin.manager.acceptControlMessage(message);
    }
}

function readLastAcknowledgement(origin: RtcOriginOverlayFixture, message: ALMessage) {
    return origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement' && settlement.msgId === message.id.msgId)
        .at(-1);
}

function readAdmissionReasons(fixture: RtcRelayOverlayFixture): readonly string[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.typeId === CHAT_TYPE_ID ? [event.reason] : []);
}

/** A receiver room broadcast from `a` that names only its exclusions, which its origin never freezes. */
function createExclusionsOnlyBroadcast(resourceId: string): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: { topicId: 'chat', resourceId, contextId: 'room' },
        scope: 'room',
        typeId: CHAT_TYPE_ID,
        resource: { text: resourceId },
        options: { ack: 'receiver', reliability: 'at-least-once', ttlMs: 30_000, groupRef: ORIGIN_ROOM, exceptPeerIds: ['d'] }
    });
}

/** A receiver room unicast from `a` to `c`. */
function createReceiverUnicast(resourceId: string): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: { topicId: 'chat', resourceId, contextId: 'room' },
        toPeerId: 'c',
        typeId: CHAT_TYPE_ID,
        resource: { text: resourceId },
        options: { groupRef: ORIGIN_ROOM, ack: 'receiver', reliability: 'at-least-once', ttlMs: 30_000 }
    });
}
