import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundPlanner
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { toRtcPublicationHandlingPlan } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    INBOUND_TEST_EFFECT_PREPARATION,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID
} from '../inbound-runtime-test-fixture.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const DOWNSTREAM_PEER_IDS = ['downstream-1', 'downstream-2'];
const RTC_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };

interface ReceivingPeer {
    readonly planner: ALInboundPlanner;
    readonly canForward: boolean;
}

/** The policy's plan of a peer the publication admission found frozen into the audience but not subscribed. */
function toNotSubscribedPeer(connected: readonly string[]): ReceivingPeer {
    return {
        planner: (msg, _source, observations) =>
            toRtcPublicationHandlingPlan(
                planALMessageHandling(msg, {
                    ...observations,
                    selfPeerId: INBOUND_TEST_SELF_PEER_ID,
                    fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
                    connectedPeerIds: [INBOUND_TEST_SENDER_PEER_ID, ...connected],
                    groupMemberPeerIds: [INBOUND_TEST_SELF_PEER_ID, INBOUND_TEST_SENDER_PEER_ID, ...connected],
                    overlayNeighborPeerIds: connected
                }),
                Either.ofRight({ delivery: 'forward-not-subscribed' }),
                INBOUND_TEST_SENDER_PEER_ID
            ),
        canForward: connected.length > 0
    };
}

const NOT_SUBSCRIBED_LEAF = toNotSubscribedPeer([]);
const NOT_SUBSCRIBED_RELAY = toNotSubscribedPeer(DOWNSTREAM_PEER_IDS);

/** A receipted room multicast whose frozen audience names this peer and the peers below it. */
function createFrozenReceiptedMessage(msgId: string): ALMessage {
    const message = newALMulticastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'room.feed', resourceId: msgId, contextId: 'room' },
        ROOM,
        'room.feed.v1',
        { text: msgId },
        { reliability: 'at-least-once', ack: 'receiver', ttlMs: 60_000 }
    );
    return {
        ...message,
        id: { ...message.id, msgId },
        targets: {
            mode: 'multicast',
            groupRef: ROOM,
            recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID, ...DOWNSTREAM_PEER_IDS],
            snapshotVersion: 1
        }
    };
}

async function computeArrival(
    store: ALInboundAdmissionStore,
    msg: ALMessage,
    peer: ReceivingPeer
): Promise<ALInboundCommitBundle> {
    const nowMs = Date.now();
    const read = await store.readIncomingMessage({ msg, source: RTC_SOURCE, nowMs, prePlan: peer.planner(msg, RTC_SOURCE, { nowMs }) });
    return computeALInboundAdmission({
        read,
        plan: peer.planner(msg, RTC_SOURCE, computeALInboundPlanningObservations(read)),
        facts: readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION),
        canForward: peer.canForward,
        recordedParentPresent: true
    });
}

async function computeArrivals(msg: ALMessage, peer: ReceivingPeer): Promise<readonly ALInboundCommitBundle[]> {
    const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
    const first = await computeArrival(admissionStore, msg, peer);
    expect(await admissionStore.commitBundle(first)).toBe('committed');
    const retried: ALMessage = { ...msg, forwarding: { nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] } };
    return [first, await computeArrival(admissionStore, retried, peer)];
}

function toControls(bundle: ALInboundCommitBundle): readonly ALPeerControlMessage[] {
    return bundle.durableEffects.flatMap((effect) => {
        const control = effect.payload.kind === 'send-control' ? decodeALControlMessage(effect.payload.msg).right : undefined;
        return control === undefined || control.type === 'receipt' ? [] : [control];
    });
}

const SELF_NOT_SUBSCRIBED = {
    type: 'nack',
    payload: expect.objectContaining({
        fromPeerId: INBOUND_TEST_SELF_PEER_ID,
        toPeerId: INBOUND_TEST_SENDER_PEER_ID,
        logicalRecipientPeerId: INBOUND_TEST_SELF_PEER_ID,
        reason: 'not-subscribed'
    })
};

describe('a frozen recipient that is not subscribed', () => {
    it('answers its hop not-subscribed for itself as a leaf, delivering nothing and sending no ACK', async () => {
        const [first] = await computeArrivals(createFrozenReceiptedMessage('leaf'), NOT_SUBSCRIBED_LEAF);

        expect(toControls(first!)).toEqual([SELF_NOT_SUBSCRIBED]);
        expect(first!.durableEffects.map((effect) => effect.payload.kind)).toEqual(['send-control']);
    });

    it('answers not-subscribed as a relay and forwards, keeping a row that never readies, so it never ACKs for itself', async () => {
        const [first] = await computeArrivals(createFrozenReceiptedMessage('relay'), NOT_SUBSCRIBED_RELAY);
        const row = first!.mutations.find((mutation) => mutation.kind === 'set-control-pending');

        expect(toControls(first!)).toEqual([SELF_NOT_SUBSCRIBED]);
        expect(first!.durableEffects.map((effect) => effect.payload.kind)).toEqual(['send-control', 'forward-message']);
        expect(row?.kind === 'set-control-pending' && row.value.value).toMatchObject({
            localReady: false,
            expectedFromPeerIds: DOWNSTREAM_PEER_IDS,
            outsideAudiencePeerIds: []
        });
    });

    it.each([['leaf', NOT_SUBSCRIBED_LEAF], ['relay', NOT_SUBSCRIBED_RELAY]] as const)(
        'answers a retried copy as a %s not-subscribed again, never with an ACK naming itself',
        async (_shape, peer) => {
            const [, retried] = await computeArrivals(createFrozenReceiptedMessage('retried'), peer);

            expect(toControls(retried!)).toEqual([SELF_NOT_SUBSCRIBED]);
        }
    );
});
