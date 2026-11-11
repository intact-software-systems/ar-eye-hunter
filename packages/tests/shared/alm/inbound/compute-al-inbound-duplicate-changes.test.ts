import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    decodeALControlMessage,
    type ALAckPayload,
    type ALAckStatus,
    type ALNackPayload,
    type ALParsedControlMessage
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { isALRelayedNackReason, type ALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';
import {
    computeALInboundAdmission,
    computeALInboundBufferedRelease
} from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import { validateALInboundCommitBundle } from '@shared/alm/inbound/admission/validate-al-inbound-commit-bundle.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundPlanner
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundPlanningObservations
} from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import {
    computeALInboundControlAdmission,
    toALInboundControlCommitBundle
} from '@shared/alm/inbound/control/compute-al-inbound-control-admission.ts';
import {
    computeALInboundNackAdmission,
    toALInboundNackCommitBundle
} from '@shared/alm/inbound/control/compute-al-inbound-nack-admission.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { toRtcPublicationHandlingPlan } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    signTestALReceiptControl,
    toTestALAckPayload,
    toTestALNackPayload,
    toTestSignatureProof
} from '../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../signature/publication-crypto-fixtures.ts';
import {
    createInboundTestMessage,
    INBOUND_TEST_EFFECT_PREPARATION,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    planInboundTestMessage
} from '../inbound-runtime-test-fixture.ts';

const SOURCES: Readonly<Record<ALDeliveryCarrier, ALInboundMessageRuntime.Source>> = {
    rtc: { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID },
    ws: { kind: 'ws-client', peerId: INBOUND_TEST_SENDER_PEER_ID, authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } }
};
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
/** Two downstream peers, so the relay's first admission forwards and keeps a relay row. */
const DOWNSTREAM_PEER_IDS = ['downstream-1', 'downstream-2'];

/** How the receiving peer plans a copy: a leaf of the fixture's two peers, or a relay over the RTC tree. */
interface ReceivingPeer {
    readonly planner: ALInboundPlanner;
    readonly canForward: boolean;
}

const LEAF_PEER: ReceivingPeer = { planner: planInboundTestMessage, canForward: false };
const RELAY_PEER: ReceivingPeer = {
    planner: (msg, _source, observations) =>
        planALMessageHandling(msg, {
            ...observations,
            selfPeerId: INBOUND_TEST_SELF_PEER_ID,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            connectedPeerIds: [INBOUND_TEST_SENDER_PEER_ID, ...DOWNSTREAM_PEER_IDS],
            groupMemberPeerIds: [INBOUND_TEST_SELF_PEER_ID, INBOUND_TEST_SENDER_PEER_ID, ...DOWNSTREAM_PEER_IDS],
            overlayNeighborPeerIds: DOWNSTREAM_PEER_IDS
        }),
    canForward: true
};

/** A frozen leaf of the sender's room, planning every copy as the room authorizes it. */
const FROZEN_LEAF_PEER: ReceivingPeer = {
    planner: (msg, _source, observations) =>
        planALMessageHandling(msg, {
            ...observations,
            selfPeerId: INBOUND_TEST_SELF_PEER_ID,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            connectedPeerIds: [INBOUND_TEST_SENDER_PEER_ID],
            groupMemberPeerIds: [INBOUND_TEST_SELF_PEER_ID, INBOUND_TEST_SENDER_PEER_ID]
        }),
    canForward: false
};

/** The same leaf holding no active token: its RTC carrier plans a granted copy forward-not-subscribed. */
const NOT_SUBSCRIBED_OVER_RTC_PEER: ReceivingPeer = {
    planner: (msg, source, observations) => {
        const plan = FROZEN_LEAF_PEER.planner(msg, source, observations);
        return source.kind === 'rtc-peer'
            ? toRtcPublicationHandlingPlan(plan, Either.ofRight({ delivery: 'forward-not-subscribed' }), INBOUND_TEST_SENDER_PEER_ID)
            : plan;
    },
    canForward: false
};

interface RepeatedAck {
    /** The runtime that claims the `send-control` row. */
    readonly rowCarrier: ALDeliveryCarrier;
    /** The carrier the ACK names for itself. */
    readonly carrier: ALDeliveryCarrier;
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
}

/** A `receiver` room multicast its origin froze to this peer alone; a `seq` orders it on the sender's feed track. */
function createFrozenReceiverMessage(msgId: string, seq?: number): ALMessage {
    const message = newALMulticastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'room.feed', resourceId: msgId, contextId: 'room' },
        ROOM,
        'room.feed.v1',
        { text: msgId },
        { reliability: 'at-least-once', ack: 'receiver', ttlMs: 60_000, ...(seq === undefined ? {} : { seq }) }
    );
    return {
        ...message,
        id: { ...message.id, msgId },
        targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID], snapshotVersion: 1 }
    };
}

/** A room message acknowledged by every logical recipient, the shape a relay forwards down the RTC tree. */
function createRelayedMessage(msgId: string): ALMessage {
    const message = newALMulticastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        'chat.message.v1',
        { text: msgId },
        { reliability: 'at-least-once', ack: 'all-logical-recipients', ttlMs: 60_000 }
    );
    return { ...message, id: { ...message.id, msgId } };
}

/** The bundle one arrival computes over the store's current rows, read as the real admission reads it. */
async function computeArrival(
    store: ALInboundAdmissionStore,
    msg: ALMessage,
    arrival: Readonly<{ peer: ReceivingPeer; carrier: ALDeliveryCarrier; }>
): Promise<ALInboundCommitBundle> {
    const { peer } = arrival;
    const source = SOURCES[arrival.carrier];
    const nowMs = Date.now();
    const read = await store.readIncomingMessage({
        selfPeerId: INBOUND_TEST_SELF_PEER_ID,
        orderingObserver: 'addressed',
        msg,
        source,
        nowMs,
        prePlan: peer.planner(msg, source, { nowMs })
    });
    const plan = peer.planner(msg, source, computeALInboundPlanningObservations(read));
    const facts = readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION);
    return computeALInboundAdmission({
        read,
        plan,
        facts,
        canForward: peer.canForward,
        recordedParentPresent: true
    });
}

/** Commits the first copy's admission, then computes what the second copy's would commit. */
async function computeSecondArrival(
    msg: ALMessage,
    peer: ReceivingPeer,
    carriers: readonly [first: ALDeliveryCarrier, second: ALDeliveryCarrier]
): Promise<ALInboundCommitBundle> {
    return await computeRetriedArrival(msg, msg, { peer, carriers });
}

/** Commits the first copy's admission, then computes what a later copy of the same message would commit. */
async function computeRetriedArrival(
    first: ALMessage,
    retried: ALMessage,
    arrival: Readonly<{ peer: ReceivingPeer; carriers: readonly [first: ALDeliveryCarrier, second: ALDeliveryCarrier]; }>
): Promise<ALInboundCommitBundle> {
    const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
    const { peer, carriers } = arrival;
    const firstBundle = await computeArrival(admissionStore, first, { peer, carrier: carriers[0] });
    expect(await admissionStore.commitBundle(firstBundle)).toBe('committed');
    return await computeArrival(admissionStore, retried, { peer, carrier: carriers[1] });
}

/** The release of the buffered copy of `msg`, computed as the ordered delivery does once its predecessor was admitted. */
async function computeBufferedRelease(
    store: ALInboundAdmissionStore,
    msg: ALMessage,
    peer: ReceivingPeer
): Promise<ALInboundCommitBundle> {
    const nowMs = Date.now();
    const trackKey = toALOrderingTrackKey(msg);
    const seq = msg.ordering?.seq;
    if (trackKey === undefined || seq === undefined) {
        throw new Error('A buffered release needs an ordered message');
    }
    const read = await store.readBufferedRelease({ trackKey, seq, nowMs });
    if (read === undefined) {
        throw new Error('The buffered copy must still be retained for its release');
    }
    const plan = peer.planner(read.snapshot.msg, read.source, computeALInboundBufferedReleasePlanningObservations(read));
    const facts = readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION);
    return computeALInboundBufferedRelease({ read, plan, facts });
}

/** The retried hop copy a relay's parent resends to it alone (D25). */
function toRetriedHopCopy(msg: ALMessage): ALMessage {
    return { ...msg, forwarding: { nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] } };
}

/** A room unicast acknowledged by its addressee, relayed by this peer toward it. */
function createRelayedUnicast(msgId: string, toPeerId: string): ALMessage {
    const message = newALUnicastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        toPeerId,
        'chat.message.v1',
        { text: msgId },
        {
            reliability: 'at-least-once',
            ack: 'all-logical-recipients',
            ttlMs: 60_000,
            groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' }
        }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function toRepeatedAcks(bundle: ALInboundCommitBundle): readonly RepeatedAck[] {
    return bundle.durableEffects.flatMap((effect): RepeatedAck[] => {
        if (effect.payload.kind !== 'send-control') {
            return [];
        }
        const control = decodeALControlMessage(effect.payload.msg).right;
        return control?.type === 'ack'
            ? [{
                rowCarrier: effect.carrier,
                carrier: control.payload.carrier,
                toPeerId: control.payload.toPeerId,
                ackedMsgId: control.payload.ackedMsgId,
                status: control.payload.status
            }]
            : [];
    });
}

describe('a duplicate on the other carrier than its first admission (D56, R-S3b-1)', () => {
    it.each([['rtc', 'ws'], ['ws', 'rtc']] as const)(
        'first admitted over %s, a copy over %s sends the own ACK again on the arrival carrier',
        async (first, second) => {
            const msg = createInboundTestMessage({ msgId: 'handed-over', acknowledged: true });

            expect(toRepeatedAcks(await computeSecondArrival(msg, LEAF_PEER, [first, second]))).toEqual([{
                rowCarrier: second,
                carrier: second,
                toPeerId: INBOUND_TEST_SENDER_PEER_ID,
                ackedMsgId: 'handed-over',
                status: 'delivered'
            }]);
        }
    );

    it('keeps a copy on the first carrier that names no next hop unanswered, as before', async () => {
        const msg = createInboundTestMessage({ msgId: 'same-carrier', acknowledged: true });

        expect(toRepeatedAcks(await computeSecondArrival(msg, LEAF_PEER, ['rtc', 'rtc']))).toEqual([]);
    });

    // R-S3b-21: the WS receiver receipt counts every frozen member's own ACK, relays included; the relay's
    // forwarded ACKs stay on the first carrier, so the copy answers only for this peer.
    it.each<{ second: ALDeliveryCarrier; named: string; expected: readonly RepeatedAck[]; }>([
        {
            second: 'ws',
            named: 'its own ACK on ws and no forwarded ACK',
            expected: [{
                rowCarrier: 'ws',
                carrier: 'ws',
                toPeerId: INBOUND_TEST_SENDER_PEER_ID,
                ackedMsgId: 'relayed',
                status: 'delivered'
            }]
        },
        { second: 'rtc', named: 'nothing, as before', expected: [] }
    ])('a relay first admitted over rtc answers a copy over $second with $named', async ({ second, expected }) => {
        const bundle = await computeSecondArrival(createRelayedMessage('relayed'), RELAY_PEER, ['rtc', second]);

        expect(toRepeatedAcks(bundle)).toEqual(expected);
        expect(bundle.durableEffects.map((effect) => effect.payload.kind)).toEqual(expected.map(() => 'send-control'));
    });

    // A frozen recipient that answered `not-subscribed` over RTC delivered nothing, and the WS copy is a duplicate it
    // never delivers either: its own ACK on the arrival carrier ends its hop and confirms nobody.
    it('answers a WS copy of a message its RTC copy found not subscribed with the ACK that confirms nobody, delivering nothing', async () => {
        const msg = createFrozenReceiverMessage('not-subscribed-then-ws');

        const bundle = await computeSecondArrival(msg, NOT_SUBSCRIBED_OVER_RTC_PEER, ['rtc', 'ws']);

        expect(toRepeatedAcks(bundle)).toEqual([{
            rowCarrier: 'ws',
            carrier: 'ws',
            toPeerId: INBOUND_TEST_SENDER_PEER_ID,
            ackedMsgId: 'not-subscribed-then-ws',
            status: 'subtree-complete-not-subscribed'
        }]);
        expect(bundle.durableEffects.map((effect) => effect.payload.kind)).toEqual(['send-control']);
    });

    it('keeps the delivered ACK for a WS copy of a message its RTC copy delivered', async () => {
        const msg = createFrozenReceiverMessage('delivered-then-ws');

        expect(toRepeatedAcks(await computeSecondArrival(msg, FROZEN_LEAF_PEER, ['rtc', 'ws'])).map((ack) => ack.status))
            .toEqual(['delivered']);
    });

    it('answers nothing for a message that asked for no acknowledgement', async () => {
        const msg = createInboundTestMessage({ msgId: 'unacknowledged' });

        expect(toRepeatedAcks(await computeSecondArrival(msg, LEAF_PEER, ['rtc', 'ws']))).toEqual([]);
    });
});

// C1: a frozen recipient that buffers its first copy on a gap delivers it on release, so its row says it delivers and
// a cross-carrier copy confirms it, before the release and after it.
describe('a frozen recipient whose first copy waits on a gap', () => {
    it('answers a WS copy delivered while its RTC copy is buffered behind the missing seq', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenReceiverMessage('buffered-then-ws', 2);

        const buffered = await computeArrival(admissionStore, msg, { peer: FROZEN_LEAF_PEER, carrier: 'rtc' });
        expect(buffered.mutations.map((mutation) => mutation.kind)).toContain('set-buffered');
        expect(await admissionStore.commitBundle(buffered)).toBe('committed');

        const copy = await computeArrival(admissionStore, msg, { peer: FROZEN_LEAF_PEER, carrier: 'ws' });
        expect(toRepeatedAcks(copy).map((ack) => ack.status)).toEqual(['delivered']);
    });

    it('answers a WS copy delivered after its buffered RTC copy was released', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenReceiverMessage('released-then-ws', 2);
        for (const arrival of [msg, createFrozenReceiverMessage('released-predecessor', 1)]) {
            const bundle = await computeArrival(admissionStore, arrival, { peer: FROZEN_LEAF_PEER, carrier: 'rtc' });
            expect(await admissionStore.commitBundle(bundle)).toBe('committed');
        }

        const release = await computeBufferedRelease(admissionStore, msg, FROZEN_LEAF_PEER);
        expect(release.mutations.map((mutation) => mutation.kind)).toContain('set-msg-owner');
        expect(await admissionStore.commitBundle(release)).toBe('committed');

        const copy = await computeArrival(admissionStore, msg, { peer: FROZEN_LEAF_PEER, carrier: 'ws' });
        expect(toRepeatedAcks(copy).map((ack) => ack.status)).toEqual(['delivered']);
    });

    it('still answers a WS copy with the ACK that confirms nobody when its RTC copy found it not subscribed', async () => {
        const msg = createFrozenReceiverMessage('not-subscribed-gap-then-ws', 2);

        const bundle = await computeSecondArrival(msg, NOT_SUBSCRIBED_OVER_RTC_PEER, ['rtc', 'ws']);

        expect(toRepeatedAcks(bundle).map((ack) => ack.status)).toEqual(['subtree-complete-not-subscribed']);
    });
});

describe('a relay answering the retried copy its parent resends', () => {
    it.each<{ shape: string; msg: ALMessage; accepted: readonly ALAckStatus[]; }>([
        {
            shape: 'a recipient of the frozen audience confirms itself again',
            msg: {
                ...createRelayedMessage('frozen-recipient'),
                targets: {
                    mode: 'multicast',
                    groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                    recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID, ...DOWNSTREAM_PEER_IDS],
                    snapshotVersion: 1
                }
            },
            accepted: ['accepted']
        },
        {
            shape: 'a relay forwarding a unicast addressed to another peer confirms nothing',
            msg: createRelayedUnicast('relayed-unicast', DOWNSTREAM_PEER_IDS[0]),
            accepted: []
        }
    ])('$shape', async ({ msg, accepted }) => {
        const bundle = await computeRetriedArrival(msg, toRetriedHopCopy(msg), { peer: RELAY_PEER, carriers: ['rtc', 'rtc'] });

        expect(toRepeatedAcks(bundle).map((ack) => ack.status)).toEqual(accepted);
        expect(bundle.durableEffects.map((effect) => effect.payload.kind)).toContain('forward-message');
    });
});

/** A frozen-audience room message this relay forwards to both downstream peers, itself a recipient too. */
function createFrozenRelayedMessage(msgId: string): ALMessage {
    return {
        ...createRelayedMessage(msgId),
        targets: {
            mode: 'multicast',
            groupRef: ROOM,
            recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID, ...DOWNSTREAM_PEER_IDS],
            snapshotVersion: 1
        }
    };
}

/** Admits a child's control at the relay through the pure control admission, as the control runtime does; returns what it committed. */
async function commitChildControl(
    store: ALInboundAdmissionStore,
    control: Readonly<{ type: 'ack'; payload: ALAckPayload; }> | Readonly<{ type: 'nack'; payload: ALNackPayload; }>
): Promise<ALInboundCommitBundle> {
    const subject = control.type === 'ack'
        ? { msgId: control.payload.ackedMsgId, fromPeerId: control.payload.fromPeerId }
        : { msgId: control.payload.msgId, fromPeerId: control.payload.fromPeerId };
    const surface = await store.readControlDecisionSurface(subject);
    if (surface?.messageOwner === undefined) {
        throw new Error('The relay row must own the child control');
    }
    const read = {
        namespace: store.namespace,
        controlOwners: surface.controlOwners,
        owner: surface.messageOwner,
        pending: surface.pendingAck,
        acks: surface.acks,
        nacks: surface.nacks,
        nowMs: Date.now(),
        // The runtime draws a fresh control id per admission (`control/al-inbound-control-admission.ts`); so does this helper.
        controlMsgId: crypto.randomUUID(),
        traceId: 'trace-child'
    };
    const retention = normalizeALRuntimeStoreRetention();
    const bundle = control.type === 'ack'
        ? toALInboundControlCommitBundle(computeALInboundControlAdmission({ ...read, ack: control.payload }, retention))
        : toALInboundNackCommitBundle(
            computeALInboundNackAdmission({ ...read, nack: { ...control.payload, reason: toRelayedNackReason(control.payload.reason) } }, retention)
        );
    expect(await store.commitBundle(bundle)).toBe('committed');
    return bundle;
}

function toRelayedNackReason(reason: ALNackPayload['reason']): ALRelayedNackReason {
    return isALRelayedNackReason(reason) ? reason : 'before-entry';
}

/** Computes a retried hop copy at the relay, then validates and commits its bundle, as the admission runtime does. */
async function commitRetriedCopy(store: ALInboundAdmissionStore, msg: ALMessage): Promise<ALInboundCommitBundle> {
    const bundle = await computeArrival(store, toRetriedHopCopy(msg), { peer: RELAY_PEER, carrier: 'rtc' });
    expect(validateALInboundCommitBundle(bundle, store.namespace).left).toBeUndefined();
    expect(await store.commitBundle(bundle)).toBe('committed');
    return bundle;
}

function toSentControls(bundle: ALInboundCommitBundle): readonly (ALParsedControlMessage | undefined)[] {
    return bundle.durableEffects.flatMap((effect) => effect.payload.kind === 'send-control' ? [decodeALControlMessage(effect.payload.msg).right] : []);
}

function toSentControlsNaming(bundle: ALInboundCommitBundle, recipientPeerId: string): readonly ALParsedControlMessage[] {
    return toSentControls(bundle).flatMap((control) =>
        (control?.type === 'ack' || control?.type === 'nack') && control.payload.logicalRecipientPeerId === recipientPeerId ? [control] : []
    );
}

describe('a relay re-forwarding what its children signed on a retried copy', () => {
    it('re-forwards the stored ACK and the stored NACK on a retried copy, the NACK with the child\'s own reason', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenRelayedMessage('re-forwarded');
        const [delivering, entering] = DOWNSTREAM_PEER_IDS;
        const first = await computeArrival(admissionStore, msg, { peer: RELAY_PEER, carrier: 'rtc' });
        expect(await admissionStore.commitBundle(first)).toBe('committed');
        const childAck = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
            type: 'ack',
            payload: toTestALAckPayload({
                ackedMsgId: 're-forwarded',
                fromPeerId: delivering,
                toPeerId: INBOUND_TEST_SELF_PEER_ID,
                originPeerId: INBOUND_TEST_SENDER_PEER_ID,
                status: 'delivered',
                observedAtEpochMs: 1_111
            })
        });
        const childNack = {
            type: 'nack',
            payload: toTestALNackPayload({
                msgId: 're-forwarded',
                fromPeerId: entering,
                toPeerId: INBOUND_TEST_SELF_PEER_ID,
                originPeerId: INBOUND_TEST_SENDER_PEER_ID,
                reason: 'before-entry',
                observedAtEpochMs: 2_222
            })
        } as const;
        await commitChildControl(admissionStore, childAck);
        await commitChildControl(admissionStore, childNack);

        const retried = await computeArrival(admissionStore, toRetriedHopCopy(msg), { peer: RELAY_PEER, carrier: 'rtc' });
        const hop = { fromPeerId: INBOUND_TEST_SELF_PEER_ID, toPeerId: INBOUND_TEST_SENDER_PEER_ID };

        expect(toSentControls(retried)).toEqual(expect.arrayContaining([
            { type: 'ack', payload: { ...childAck.payload, ...hop, carrier: 'rtc' } },
            { type: 'nack', payload: { ...childNack.payload, ...hop } }
        ]));
        expect(toSentControls(retried).filter((control) => control?.type === 'nack')).toHaveLength(1);
    });

    it.each(['ack', 'nack'] as const)(
        're-forwards each distinct statement about one recipient once on a retried copy (a forged %s, then the true ACK)',
        async (forgedType) => {
            const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
            const msg = createFrozenRelayedMessage(`distinct-${forgedType}`);
            const [victim, forger] = DOWNSTREAM_PEER_IDS;
            const first = await computeArrival(admissionStore, msg, { peer: RELAY_PEER, carrier: 'rtc' });
            expect(await admissionStore.commitBundle(first)).toBe('committed');
            const named = {
                fromPeerId: forger,
                toPeerId: INBOUND_TEST_SELF_PEER_ID,
                originPeerId: INBOUND_TEST_SENDER_PEER_ID,
                logicalRecipientPeerId: victim
            };
            const forged = await signTestALReceiptControl(
                await createAvailablePublicationCryptoFixture(),
                forgedType === 'ack'
                    ? { type: 'ack', payload: toTestALAckPayload({ ...named, ackedMsgId: msg.id.msgId, status: 'delivered' }) }
                    : { type: 'nack', payload: toTestALNackPayload({ ...named, msgId: msg.id.msgId, reason: 'before-entry' }) }
            );
            const own = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
                type: 'ack',
                payload: toTestALAckPayload({ ...named, fromPeerId: victim, ackedMsgId: msg.id.msgId, status: 'delivered' })
            });
            await commitChildControl(admissionStore, forged);
            await commitChildControl(admissionStore, own);

            const retried = await computeArrival(admissionStore, toRetriedHopCopy(msg), { peer: RELAY_PEER, carrier: 'rtc' });
            const hop = { fromPeerId: INBOUND_TEST_SELF_PEER_ID, toPeerId: INBOUND_TEST_SENDER_PEER_ID };

            const sent = toSentControlsNaming(retried, victim);
            expect(sent).toEqual(expect.arrayContaining([
                forged.type === 'ack'
                    ? { type: 'ack', payload: { ...forged.payload, ...hop, carrier: 'rtc' } }
                    : { type: 'nack', payload: { ...forged.payload, ...hop } },
                { type: 'ack', payload: { ...own.payload, ...hop, carrier: 'rtc' } }
            ]));
            expect(sent).toHaveLength(2);
        }
    );

    it('a flooded history never makes the retried copy\'s bundle exceed the commit bundle\'s cap: the relay still answers and retries', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenRelayedMessage('flooded-cap');
        const [victim, forger] = DOWNSTREAM_PEER_IDS;
        expect(await admissionStore.commitBundle(await computeArrival(admissionStore, msg, { peer: RELAY_PEER, carrier: 'rtc' }))).toBe('committed');
        const named = { toPeerId: INBOUND_TEST_SELF_PEER_ID, originPeerId: INBOUND_TEST_SENDER_PEER_ID, logicalRecipientPeerId: victim };
        const own = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
            type: 'ack',
            payload: toTestALAckPayload({ ...named, ackedMsgId: msg.id.msgId, fromPeerId: victim, status: 'delivered' })
        });
        await commitChildControl(admissionStore, own);
        // 300 distinct forged statements, alternating ACKs and `not-subscribed` NACKs, so both histories hold forgeries.
        for (let index = 1; index <= 300; index++) {
            const proof = toTestSignatureProof(index);
            await commitChildControl(
                admissionStore,
                index % 2 === 0
                    ? {
                        type: 'ack',
                        payload: { ...toTestALAckPayload({ ...named, ackedMsgId: msg.id.msgId, fromPeerId: forger, status: 'delivered' }), proof }
                    }
                    : {
                        type: 'nack',
                        payload: { ...toTestALNackPayload({ ...named, msgId: msg.id.msgId, fromPeerId: forger, reason: 'not-subscribed' }), proof }
                    }
            );
        }

        const retried = await commitRetriedCopy(admissionStore, msg);

        expect(retried.durableEffects.length).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries);
        expect(toSentControlsNaming(retried, INBOUND_TEST_SELF_PEER_ID)).toContainEqual(
            expect.objectContaining({ type: 'ack', payload: expect.objectContaining({ status: 'accepted', toPeerId: INBOUND_TEST_SENDER_PEER_ID }) })
        );
        expect(retried.durableEffects.filter((effect) => effect.payload.kind === 'forward-message')).toHaveLength(1);
        expect(toSentControlsNaming(retried, victim)).toContainEqual({
            type: 'ack',
            payload: { ...own.payload, fromPeerId: INBOUND_TEST_SELF_PEER_ID, toPeerId: INBOUND_TEST_SENDER_PEER_ID, carrier: 'rtc' }
        });
    });

    it('keeps a child\'s own word when the cut falls before it in history order', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenRelayedMessage('own-word-past-cut');
        const [victim, forger] = DOWNSTREAM_PEER_IDS;
        expect(await admissionStore.commitBundle(await computeArrival(admissionStore, msg, { peer: RELAY_PEER, carrier: 'rtc' }))).toBe('committed');
        const named = {
            ackedMsgId: msg.id.msgId,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: INBOUND_TEST_SENDER_PEER_ID,
            logicalRecipientPeerId: victim
        };
        const hop = { fromPeerId: INBOUND_TEST_SELF_PEER_ID, toPeerId: INBOUND_TEST_SENDER_PEER_ID };
        const toReforwarded = (control: Readonly<{ payload: ALAckPayload; }>) => ({ type: 'ack', payload: { ...control.payload, ...hop, carrier: 'rtc' } });
        // The relay's own effects are its `accepted` ACK and its retried forward, so 254 re-forwards fit: 254 forged ACKs fill
        // that budget in history order, and the recipient's own ACK is the 255th entry of the 256-entry history.
        const reforwardBudget = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 2;
        const forgeries = Array.from({ length: reforwardBudget }, (_, index) => ({
            type: 'ack' as const,
            payload: { ...toTestALAckPayload({ ...named, fromPeerId: forger, status: 'delivered' }), proof: toTestSignatureProof(index + 1) }
        }));
        for (const forgery of forgeries) {
            await commitChildControl(admissionStore, forgery);
        }
        const own = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
            type: 'ack',
            payload: toTestALAckPayload({ ...named, fromPeerId: victim, status: 'delivered' })
        });
        await commitChildControl(admissionStore, own);

        const retried = await commitRetriedCopy(admissionStore, msg);

        expect(retried.durableEffects.length).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries);
        expect(toSentControlsNaming(retried, victim)).toEqual([...forgeries.slice(0, reforwardBudget - 1), own].map(toReforwarded));
    });

    it('Limit: a child that floods distinct forged statements about a recipient evicts its true control from the history, so a retried copy no longer re-forwards it; its first forward had already gone up', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const msg = createFrozenRelayedMessage('flooded');
        const [victim, forger] = DOWNSTREAM_PEER_IDS;
        const first = await computeArrival(admissionStore, msg, { peer: RELAY_PEER, carrier: 'rtc' });
        expect(await admissionStore.commitBundle(first)).toBe('committed');
        const named = {
            ackedMsgId: msg.id.msgId,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: INBOUND_TEST_SENDER_PEER_ID,
            logicalRecipientPeerId: victim
        };
        const own = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
            type: 'ack',
            payload: toTestALAckPayload({ ...named, fromPeerId: victim, status: 'delivered' })
        });
        const toForgery = (index: number) => ({
            type: 'ack' as const,
            payload: { ...toTestALAckPayload({ ...named, fromPeerId: forger, status: 'delivered' }), proof: toTestSignatureProof(index) }
        });
        const hop = { fromPeerId: INBOUND_TEST_SELF_PEER_ID, toPeerId: INBOUND_TEST_SENDER_PEER_ID };
        const toReforwarded = (control: Readonly<{ payload: ALAckPayload; }>) => ({
            type: 'ack',
            payload: { ...control.payload, ...hop, carrier: 'rtc' }
        });
        const limit = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
        // The relay's own effects of a retried copy are its `accepted` ACK and its retried forward to the owed child, so 254
        // stored controls fit beside them in one bundle.
        const reforwardBudget = limit - 2;
        const forgeries = Array.from({ length: limit }, (_, index) => toForgery(index + 1));

        const ownBundle = await commitChildControl(admissionStore, own);
        expect(toSentControls(ownBundle)).toContainEqual(toReforwarded(own));
        for (const forgery of forgeries.slice(0, limit - 1)) {
            await commitChildControl(admissionStore, forgery);
        }
        const beforeEviction = await commitRetriedCopy(admissionStore, msg);
        expect(toSentControlsNaming(beforeEviction, victim)).toEqual(
            [own, ...forgeries.slice(0, reforwardBudget - 1)].map(toReforwarded)
        );

        await commitChildControl(admissionStore, forgeries[limit - 1]!);
        const afterEviction = await commitRetriedCopy(admissionStore, msg);
        expect(toSentControlsNaming(afterEviction, victim)).toEqual(forgeries.slice(0, reforwardBudget).map(toReforwarded));
    });
});
