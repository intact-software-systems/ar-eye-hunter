import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundPlanner
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

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

interface RepeatedAck {
    /** The runtime that claims the `send-control` row. */
    readonly rowCarrier: ALDeliveryCarrier;
    /** The carrier the ACK names for itself. */
    readonly carrier: ALDeliveryCarrier;
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
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

    it('answers nothing for a message that asked for no acknowledgement', async () => {
        const msg = createInboundTestMessage({ msgId: 'unacknowledged' });

        expect(toRepeatedAcks(await computeSecondArrival(msg, LEAF_PEER, ['rtc', 'ws']))).toEqual([]);
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
