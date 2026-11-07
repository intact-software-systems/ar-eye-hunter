import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { toALOutboundTrackIndexEnd } from '@shared/alm/outbound/lane/write-al-outbound-track-index-end.ts';

const ADMITTED: ALDeliveryAdmissionVerdict = { kind: 'admitted', durable: true, queuedAttempts: 1 };
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const POLICY: ALOutboundCapturedPolicy = {
    persist: true,
    ackTracking: null,
    retryTracking: null,
    repairTracking: null,
    supersedenceTracking: null,
    admittedAudience: ['b']
};

function trackedMessage(seq: number): ALMessage {
    const message = newALBroadcastMessage('a', newALRoute('room.round.event', ROOM.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, { groupRef: ROOM });
    return { ...message, ordering: { orderingKey: 'game-1', epoch: 1, seq } };
}

/** A dequeue's commit with the verdict, writing the row's sent admission with these positions and policy. */
function committed(
    verdict: ALDeliveryAdmissionVerdict,
    sent?: Readonly<{ sentPositions: Readonly<Record<string, number>> | null; policy: ALOutboundCapturedPolicy; }>
): ALOutboundComputedDto<string> {
    const msg = trackedMessage(2);
    const mutations = sent === undefined ? [] : [{
        kind: 'set-sent-message' as const,
        reference: {
            key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msg.id.msgId },
            typeId: 'AL_OUTBOUND_MESSAGE',
            scope: 'scope',
            msgId: msg.id.msgId,
            senderId: 'a',
            identity: msg.id.msgId,
            expiresAtMs: 1
        },
        policy: sent.policy,
        sentPositions: sent.sentPositions,
        creationExpiry: 'creation-expiry',
        snapshot: { msgId: msg.id.msgId, msg, outboxKey: msg.route, supersedenceKey: null }
    }];
    return { msg, verdict, entries: [], trackedReceiptAlgo: 'none', bundle: { senderId: 'a', mutations, durableEffects: [] } };
}

describe('the index row a dequeued row\'s end clears', () => {
    const msg = trackedMessage(2);
    const end = { trackKey: 'game-1:a:1', seq: 2, msgId: msg.id.msgId };

    it('clears the sequence of a row superseded at its read or failed for good', () => {
        expect(toALOutboundTrackIndexEnd(msg, 'superseded')).toEqual(end);
        expect(toALOutboundTrackIndexEnd(msg, 'failed')).toEqual(end);
    });

    it('clears the sequence of a row its commit refused or found superseded', () => {
        expect(toALOutboundTrackIndexEnd(msg, committed({ kind: 'refused', reason: 'congested', detail: 'busy' }))).toEqual(end);
        expect(toALOutboundTrackIndexEnd(msg, committed({ kind: 'superseded', detail: 'replaced' }))).toEqual(end);
    });

    it('clears the sequence of a row committed with no positions under a policy that records them', () => {
        expect(toALOutboundTrackIndexEnd(msg, committed(ADMITTED, { sentPositions: null, policy: POLICY }))).toEqual(end);
    });

    it('keeps the sequence of a row that recorded, one admitted to no audience, an expired one and one that dispatched nothing', () => {
        const { admittedAudience: _admittedAudience, ...audienceFree } = POLICY;

        expect(toALOutboundTrackIndexEnd(msg, committed(ADMITTED, { sentPositions: { b: 1 }, policy: POLICY }))).toBeUndefined();
        expect(toALOutboundTrackIndexEnd(msg, committed(ADMITTED, { sentPositions: null, policy: audienceFree }))).toBeUndefined();
        expect(toALOutboundTrackIndexEnd(msg, committed({ kind: 'expired', detail: 'Message expired or is too stale' }))).toBeUndefined();
        expect(toALOutboundTrackIndexEnd(msg, undefined)).toBeUndefined();
    });

    it('clears nothing for an untracked row or a row with no message', () => {
        expect(toALOutboundTrackIndexEnd({ ...msg, ordering: undefined }, 'failed')).toBeUndefined();
        expect(toALOutboundTrackIndexEnd(undefined, 'failed')).toBeUndefined();
    });
});
