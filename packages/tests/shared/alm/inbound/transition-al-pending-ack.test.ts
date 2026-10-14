import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    type ALAckPayload,
    type ALAckStatus,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    computeALInboundAdmission,
    computeALInboundBufferedRelease
} from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundPlanner
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundUpwardAcks } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundPlanningObservations
} from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import {
    acceptALPendingAckPayload,
    trackALPendingAckSnapshot,
    type ALPendingAckTransition
} from '@shared/alm/inbound/transition-al-pending-ack.ts';

import { INBOUND_TEST_EFFECT_PREPARATION } from '../inbound-runtime-test-fixture.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const DIRECTOR_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: 'relay' };
const DIRECTOR_CHILD_PEER_IDS = ['leaf-a', 'leaf-b'];
/** The director plans as a member of the room whose overlay leads on to its two children. */
const planAsDirector: ALInboundPlanner = (msg, _source, observations) =>
    planALMessageHandling(msg, {
        ...observations,
        selfPeerId: 'director',
        fromPeerId: 'relay',
        connectedPeerIds: ['relay', ...DIRECTOR_CHILD_PEER_IDS],
        groupMemberPeerIds: ['origin', 'relay', 'director', ...DIRECTOR_CHILD_PEER_IDS],
        overlayNeighborPeerIds: DIRECTOR_CHILD_PEER_IDS
    });

interface SentAck {
    readonly toPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status: ALAckStatus;
}

const RELAY_ROW: ALPendingAckSnapshot = {
    toPeerId: 'origin',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child-relay', 'leaf'],
    ackedFromPeerIds: [],
    carrier: 'rtc'
};

describe('inbound pending ACK transition', () => {
    it('relays an ACK a child relay passes on without completing that hop', () => {
        const transition = acceptALPendingAckPayload({
            current: RELAY_ROW,
            acks: [],
            ack: toChildAck('child-relay', 'grandchild', 'forwarded')
        });

        expect(transition.relayedRecipientPeerIds).toEqual(['grandchild']);
        expect(transition.pending?.ackedFromPeerIds).toEqual([]);
        expect(transition.completed).toBeUndefined();
    });

    it('completes once every child hop sent its own completion ACK, and only once', () => {
        const afterRelay = acceptALPendingAckPayload({
            current: { ...RELAY_ROW, ackedFromPeerIds: ['leaf'] },
            acks: [],
            ack: toChildAck('child-relay', 'child-relay', 'subtree-complete')
        });
        const late = acceptALPendingAckPayload({
            current: afterRelay.pending,
            acks: [],
            ack: toChildAck('child-relay', 'grandchild', 'forwarded')
        });

        expect(afterRelay.completed).toMatchObject({ msgId: 'message', toPeerId: 'origin', status: 'subtree-complete' });
        // A child ACK that overtook its own subtree still reaches the origin, but completes nothing again.
        expect(late.relayedRecipientPeerIds).toEqual(['grandchild']);
        expect(late.completed).toBeUndefined();
    });

    it('waits for its own local delivery before completing', () => {
        const transition = trackALPendingAckSnapshot({
            msgId: 'message',
            current: undefined,
            toPeerId: 'origin',
            expectedFromPeerIds: [],
            localReady: false,
            expireAtTimestamp: undefined,
            carrier: 'rtc',
            upwardAudiencePeerIds: undefined
        });

        expect(transition.pending).toMatchObject({ localReady: false, expectedFromPeerIds: [] });
        expect(transition.completed).toBeUndefined();
    });
});

describe('a logical recipient that relays a group-leader send', () => {
    it('confirms itself at once beside the row that waits on its children', async () => {
        const bundle = await computeDirectorAdmission();

        expect(toSentAcks(bundle)).toEqual([{ toPeerId: 'relay', logicalRecipientPeerId: 'director', status: 'accepted' }]);
        expect(readPendingRow(bundle)).toMatchObject({
            toPeerId: 'relay',
            localReady: true,
            expectedFromPeerIds: DIRECTOR_CHILD_PEER_IDS,
            ackedFromPeerIds: []
        });
    });

    it('still ends its own hop with its terminal ACK once every child completed', async () => {
        const bundle = await computeDirectorAdmission();

        const completed = acceptChildCompletions(readPendingRow(bundle), DIRECTOR_CHILD_PEER_IDS);

        expect(toALInboundUpwardAcks(completed).at(-1)).toEqual({ logicalRecipient: { kind: 'self' }, status: 'subtree-complete' });
        expect(completed.completed).toMatchObject({ toPeerId: 'relay', status: 'subtree-complete' });
    });

    it('confirms itself once the predecessor an ordering gap waited on releases its buffered copy', async () => {
        const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
        const waiting = await computeDirectorArrival(admissionStore, createLeaderSend(2));
        expect(toSentAcks(waiting)).toEqual([]);
        expect(await admissionStore.commitBundle(waiting)).toBe('committed');
        expect(await admissionStore.commitBundle(await computeDirectorArrival(admissionStore, createLeaderSend(1))))
            .toBe('committed');

        const release = await computeDirectorRelease(admissionStore, readBufferedSnapshot(waiting));

        expect(toSentAcks(release)).toEqual([{ toPeerId: 'relay', logicalRecipientPeerId: 'director', status: 'accepted' }]);
        expect(release.localDelivery).toBeDefined();
    });

    it('relays no ACK of a child outside the frozen audience upward, only its own terminal ACK', async () => {
        const bundle = await computeDirectorAdmission();
        let current = readPendingRow(bundle);
        const upward = [];

        for (const childPeerId of DIRECTOR_CHILD_PEER_IDS) {
            const transition = acceptALPendingAckPayload({
                current,
                acks: [],
                ack: { ...toChildAck(childPeerId, childPeerId, 'subtree-complete'), toPeerId: 'director' }
            });
            upward.push(...toALInboundUpwardAcks(transition));
            current = transition.pending!;
        }

        expect(upward).toEqual([{ logicalRecipient: { kind: 'self' }, status: 'subtree-complete' }]);
    });
});

/** The director's first admission of a leader send frozen to it, arriving from its parent with two children below. */
async function computeDirectorAdmission(): Promise<ALInboundCommitBundle> {
    const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
    return await computeDirectorArrival(admissionStore, createLeaderSend());
}

async function computeDirectorArrival(admissionStore: ALInboundAdmissionStore, msg: ALMessage): Promise<ALInboundCommitBundle> {
    const nowMs = Date.now();
    const read = await admissionStore.readIncomingMessage({
        msg,
        source: DIRECTOR_SOURCE,
        nowMs,
        prePlan: planAsDirector(msg, DIRECTOR_SOURCE, { nowMs })
    });
    return computeALInboundAdmission({
        read,
        plan: planAsDirector(msg, DIRECTOR_SOURCE, computeALInboundPlanningObservations(read)),
        facts: readALInboundEffectFacts(nowMs, { ...INBOUND_TEST_EFFECT_PREPARATION, selfPeerId: 'director' }),
        canForward: true,
        recordedParentPresent: true
    });
}

/** The director's release of the copy an ordering gap buffered, planned as the ordered delivery worker plans it. */
async function computeDirectorRelease(
    admissionStore: ALInboundAdmissionStore,
    buffered: Readonly<{ trackKey: string; seq: number; }>
): Promise<ReturnType<typeof computeALInboundBufferedRelease>> {
    const nowMs = Date.now();
    const read = await admissionStore.readBufferedRelease({ ...buffered, nowMs });
    if (read === undefined) {
        throw new Error('The buffered copy must wait for its release');
    }
    return computeALInboundBufferedRelease({
        read,
        plan: planAsDirector(read.snapshot.msg, read.source, computeALInboundBufferedReleasePlanningObservations(read)),
        facts: readALInboundEffectFacts(nowMs, { ...INBOUND_TEST_EFFECT_PREPARATION, selfPeerId: 'director' })
    });
}

function createLeaderSend(seq?: number): ALMessage {
    const message = newALMulticastMessage(
        'origin',
        { topicId: 'room.director', resourceId: `shot-${seq ?? 'unordered'}`, contextId: ROOM.groupId },
        ROOM,
        'room.director.intent.v1',
        {},
        { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 60_000, ...(seq === undefined ? {} : { seq }) }
    );
    return { ...message, targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['director'], snapshotVersion: 1 } };
}

function toSentAcks(bundle: ALInboundCommitBundle): readonly SentAck[] {
    return bundle.durableEffects.flatMap((effect): SentAck[] => {
        const control = effect.payload.kind === 'send-control' ? decodeALControlMessage(effect.payload.msg).right : undefined;
        return control?.type === 'ack'
            ? [{
                toPeerId: control.payload.toPeerId,
                logicalRecipientPeerId: control.payload.logicalRecipientPeerId,
                status: control.payload.status
            }]
            : [];
    });
}

function readBufferedSnapshot(bundle: ALInboundCommitBundle): Readonly<{ trackKey: string; seq: number; }> {
    const buffered = bundle.mutations.find((mutation) => mutation.kind === 'set-buffered');
    if (buffered?.kind !== 'set-buffered') {
        throw new Error('The admission buffered no copy');
    }
    return buffered.snapshot;
}

function readPendingRow(bundle: ALInboundCommitBundle): ALPendingAckSnapshot {
    const row = bundle.mutations.find((mutation) => mutation.kind === 'set-control-pending');
    if (row?.kind !== 'set-control-pending' || row.value.kind !== 'pending') {
        throw new Error('The admission wrote no pending ACK row');
    }
    return row.value.value;
}

/** Each child ends its own empty subtree: none of them is in the audience. */
function acceptChildCompletions(pending: ALPendingAckSnapshot, childPeerIds: readonly string[]): ALPendingAckTransition {
    let transition: ALPendingAckTransition = { pending, completed: undefined, relayedRecipientPeerIds: [] };
    for (const childPeerId of childPeerIds) {
        transition = acceptALPendingAckPayload({
            current: transition.pending,
            acks: [],
            ack: { ...toChildAck(childPeerId, childPeerId, 'subtree-complete'), toPeerId: 'director' }
        });
    }
    return transition;
}

function toChildAck(fromPeerId: string, logicalRecipientPeerId: string, status: ALAckStatus): ALAckPayload {
    return {
        ackedMsgId: 'message',
        fromPeerId,
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'rtc',
        status,
        observedAtEpochMs: 1
    };
}
