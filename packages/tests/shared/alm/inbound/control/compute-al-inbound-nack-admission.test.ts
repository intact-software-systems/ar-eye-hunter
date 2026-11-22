import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    parseALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';
import {
    computeALInboundNackAdmission,
    computeALInboundUnreceiptedGapNackAdmission,
    toALInboundNackCommitBundle,
    type ALInboundNackAdmissionCandidate,
    type ALInboundUnreceiptedGapNackAdmissionRead
} from '@shared/alm/inbound/control/compute-al-inbound-nack-admission.ts';
import {
    validateALInboundNackAdmission,
    validateALInboundUnreceiptedGapNackAdmission
} from '@shared/alm/inbound/control/validate-al-inbound-nack-admission.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';

import { toTestALAckPayload, toTestALNackPayload, toTestSignatureProof } from '../../../../al-control-test-payloads.ts';

const NOW_MS = 1_800_000_000_000;
/** The child's own time, which the relay forwards unchanged. */
const CHILD_OBSERVED_AT_MS = NOW_MS - 7;
const RETENTION = normalizeALRuntimeStoreRetention();

/** A relay waiting on its child `child` for the frozen recipients `child` and `leaf`, toward its parent `parent`. */
const ROW: ALPendingAckSnapshot = {
    toPeerId: 'parent',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child'],
    ackedFromPeerIds: [],
    upwardAudiencePeerIds: ['child', 'leaf'],
    outsideAudiencePeerIds: [],
    expireAtTimestamp: NOW_MS + 60_000,
    carrier: 'rtc'
};

const GAP_ORDERING = {
    orderingKey: 'feed:origin:1',
    expectedSeq: 2,
    missingRanges: [{ from: 2, to: 3 }]
} as const;

interface NackArrival {
    readonly reason: ALRelayedNackReason;
    readonly fromPeerId?: string;
    readonly logicalRecipientPeerId?: string;
    readonly originPeerId?: string;
    readonly ordering?: Partial<Pick<ALNackPayload, 'orderingKey' | 'expectedSeq' | 'missingRanges'>>;
    readonly proof?: SignatureProof | null;
}

function toChildNack(arrival: NackArrival): ALNackPayload & Readonly<{ reason: ALRelayedNackReason; }> {
    return {
        msgId: 'subject',
        fromPeerId: arrival.fromPeerId ?? 'child',
        toPeerId: 'relay',
        logicalRecipientPeerId: arrival.logicalRecipientPeerId ?? 'leaf',
        originPeerId: arrival.originPeerId ?? 'origin',
        reason: arrival.reason,
        observedAtEpochMs: CHILD_OBSERVED_AT_MS,
        proof: arrival.proof ?? null,
        ...(arrival.ordering ?? (arrival.reason === 'gap' ? GAP_ORDERING : {})),
        ...(arrival.reason === 'gap' ? { gapRequestNumber: 1 } : {})
    };
}

function computeArrival(
    arrival: NackArrival,
    row: ALPendingAckSnapshot = ROW,
    acks: readonly ALAckPayload[] = [],
    nacks: readonly ALNackPayload[] = []
): ALInboundNackAdmissionCandidate {
    return computeALInboundNackAdmission({
        namespace: 'relay',
        nack: toChildNack(arrival),
        controlOwners: { ambiguous: false, values: [{ peerId: 'child', senderId: 'origin' }] },
        owner: {
            msgId: 'subject',
            senderId: 'origin',
            source: { kind: 'rtc-peer', peerId: 'parent' },
            supersedenceKey: null,
            deliveredLocally: false
        },
        pending: row,
        acks,
        nacks,
        nowMs: NOW_MS,
        controlMsgId: 'forwarded',
        traceId: 'trace-relayed-nack'
    }, RETENTION);
}

function toUpwardControls(candidate: ALInboundNackAdmissionCandidate) {
    return candidate.upwardEffects.map((effect) => effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined);
}

function toConfirmation(logicalRecipientPeerId: string, proof: SignatureProof | null = null): ALAckPayload {
    const confirmation = toTestALAckPayload({
        ackedMsgId: 'subject',
        fromPeerId: 'child',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: NOW_MS
    });
    return { ...confirmation, proof };
}

describe('a child\'s gap NACK at a relay (S4ii-R3)', () => {
    it('forwards the child\'s gap NACK toward the parent with its ordering hints and its own time, writing no row', () => {
        const candidate = computeArrival({ reason: 'gap' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toBeUndefined();
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: { ...toChildNack({ reason: 'gap' }), fromPeerId: 'relay', toPeerId: 'parent' }
        }]);
    });

    it('refuses a NACK that names another origin', () => {
        expect(validateALInboundNackAdmission(computeArrival({ reason: 'gap', originPeerId: 'other' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names another origin than the message it answers' }]);
    });

    it('refuses a gap NACK from a child the row does not wait on', () => {
        expect(validateALInboundNackAdmission(computeArrival({ reason: 'gap', fromPeerId: 'stranger' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK sender has no pending obligation' }]);
    });

    it('refuses a gap NACK for a recipient whose confirmation the relay already forwarded', () => {
        const candidate = computeArrival({ reason: 'gap' }, ROW, [toConfirmation('leaf')]);

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient whose confirmation was already forwarded'
        }]);
    });

    it('forwards a gap NACK for a recipient the row lists outside when no stored control recorded it', () => {
        const candidate = computeArrival({ reason: 'gap' }, { ...ROW, outsideAudiencePeerIds: ['leaf'] });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: { ...toChildNack({ reason: 'gap' }), fromPeerId: 'relay', toPeerId: 'parent' }
        }]);
    });

    it.each(
        [
            ['its missing ranges', { orderingKey: GAP_ORDERING.orderingKey, expectedSeq: GAP_ORDERING.expectedSeq }],
            ['its ordering key', { expectedSeq: GAP_ORDERING.expectedSeq, missingRanges: GAP_ORDERING.missingRanges }],
            ['its expected sequence', { orderingKey: GAP_ORDERING.orderingKey, missingRanges: GAP_ORDERING.missingRanges }]
        ] as const
    )('refuses a gap NACK without %s as malformed', (_missing, ordering) => {
        const candidate = computeArrival({ reason: 'gap', ordering });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'malformed',
            message: 'Inbound gap NACK carries no ordering hints to forward'
        }]);
    });

    it('records a not-subscribed recipient outside and forwards the child\'s NACK without ordering hints', () => {
        const candidate = computeArrival({ reason: 'not-subscribed' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toEqual({ kind: 'pending', value: { ...ROW, outsideAudiencePeerIds: ['leaf'] } });
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: { ...toChildNack({ reason: 'not-subscribed' }), fromPeerId: 'relay', toPeerId: 'parent' }
        }]);
    });

    it('stores an outside-audience NACK in the nacks history, bounded by collectionEntries, and writes no row for a gap NACK', () => {
        const limit = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
        const stored = Array.from({ length: limit }, (_, index) =>
            toTestALNackPayload({
                msgId: 'subject',
                fromPeerId: 'child',
                toPeerId: 'relay',
                originPeerId: 'origin',
                logicalRecipientPeerId: `earlier-${index}`,
                reason: 'not-subscribed'
            }));
        const outside = computeArrival({ reason: 'before-entry' }, ROW, [], stored);
        const gap = computeArrival({ reason: 'gap' }, ROW, [], stored);

        const nacksRow = toALInboundNackCommitBundle(outside).mutations.find((mutation) => mutation.kind === 'set-control-nacks');
        expect(nacksRow).toEqual({
            kind: 'set-control-nacks',
            msgId: 'subject',
            senderId: 'origin',
            value: { kind: 'nacks', values: [...stored.slice(1), toChildNack({ reason: 'before-entry' })] },
            expireAtTimestamp: NOW_MS + RETENTION.controlHistoryTtlMs
        });
        expect(toALInboundNackCommitBundle(gap).mutations).toEqual([]);
    });

    it('refuses a NACK only against a same statement: a second statement about a recipient recorded outside is forwarded', () => {
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: ['leaf'] },
            [],
            [stored]
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
    });

    it('records a recipient outside once when a second distinct statement names it', () => {
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: ['leaf'] },
            [],
            [stored]
        );

        expect(candidate.pending?.value.outsideAudiencePeerIds).toEqual(['leaf']);
        expect(candidate.nacks?.values).toHaveLength(2);
        expect(toUpwardControls(candidate).filter((control) => control?.type === 'nack')).toHaveLength(1);
    });

    it('refuses a NACK after a confirmation only when the confirmation is the same statement', () => {
        const unsigned = computeArrival({ reason: 'not-subscribed' }, ROW, [toConfirmation('leaf')]);
        const confirmed = [toConfirmation('leaf', toTestSignatureProof(1))];
        // One proof cannot sign an ACK and a NACK, so a NACK under the confirmation's proof is another statement.
        const sharedProof = computeArrival({ reason: 'not-subscribed', proof: toTestSignatureProof(1) }, ROW, confirmed);
        const distinct = computeArrival({ reason: 'not-subscribed', proof: toTestSignatureProof(2) }, ROW, confirmed);

        expect(validateALInboundNackAdmission(unsigned)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient whose confirmation was already forwarded'
        }]);
        expect(validateALInboundNackAdmission(sharedProof)).toEqual([]);
        expect(validateALInboundNackAdmission(distinct)).toEqual([]);
    });

    it('admits a distinct statement about a recipient already recorded outside when the outside list is full', () => {
        const full = ['leaf', ...Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1 }, (_, index) => `outside-${index}`)];
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: full },
            [],
            [stored]
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
    });

    it('refuses a NACK for a new recipient when the outside list is full', () => {
        const full = Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries }, (_, index) => `outside-${index}`);
        const candidate = computeArrival({ reason: 'not-subscribed' }, { ...ROW, outsideAudiencePeerIds: full });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK candidate exceeds persistence limits'
        }]);
    });
});

describe('a child\'s gap NACK at a relay that keeps no row for a message asking for no receipt (6c)', () => {
    const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } as const;

    /** The message `origin` sent with no receipt on the track `feed` at seq 3, frozen to `targets`' audience. */
    function toUnreceiptedMessage(targets: ALMessage['targets']): ALMessage {
        const message = newALMulticastMessage({
            createdAtEpochMs: NOW_MS,
            senderId: 'origin',
            route: { topicId: 'room.feed', resourceId: 'subject', contextId: ROOM.groupId },
            groupRef: ROOM,
            typeId: 'room.feed.v1',
            resource: {},
            options: { ttlMs: 60_000, reliability: 'at-least-once', ack: 'none' }
        });
        return { ...message, id: { ...message.id, msgId: 'subject' }, targets, ordering: { orderingKey: 'feed', epoch: 1, seq: 3 } };
    }

    const FROZEN = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['child', 'leaf'], snapshotVersion: 1 } as const;

    function readUnreceipted(
        arrival: NackArrival,
        targets: ALMessage['targets'] = FROZEN
    ): ALInboundUnreceiptedGapNackAdmissionRead {
        const msg = toUnreceiptedMessage(targets);
        const nack = toChildNack({ ...arrival, ordering: arrival.ordering ?? { ...GAP_ORDERING, orderingKey: toALOrderingTrackKey(msg) } });
        return {
            namespace: 'relay',
            nack: { ...nack, reason: 'gap' },
            msg,
            owner: { msgId: 'subject', senderId: 'origin', source: { kind: 'rtc-peer', peerId: 'parent' }, supersedenceKey: null, deliveredLocally: false },
            parentPeerId: 'parent',
            childPeerIds: ['child'],
            nowMs: NOW_MS,
            controlMsgId: 'forwarded',
            traceId: 'trace-relayed-nack'
        };
    }

    it('forwards the child\'s own gap NACK toward the parent, writing no row', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' });
        const candidate = computeALInboundUnreceiptedGapNackAdmission(read, RETENTION);

        expect(validateALInboundUnreceiptedGapNackAdmission(read)).toEqual([]);
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: { ...read.nack, fromPeerId: 'relay', toPeerId: 'parent' } }]);
    });

    it('forwards a child\'s gap NACK for a recipient of the frozen audience below it', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'leaf' }))).toEqual([]);
    });

    it('refuses a gap NACK naming a recipient outside the frozen audience', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'stranger' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names no recipient of the frozen audience' }]);
    });

    it('refuses a gap NACK from the peer the message arrived from', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', fromPeerId: 'parent', logicalRecipientPeerId: 'leaf' })))
            .toEqual([
                { code: 'unauthorized', message: 'Inbound NACK comes from the peer the message arrived from' },
                { code: 'unauthorized', message: 'Inbound NACK comes from no child this relay forwards the message to' }
            ]);
    });

    it.each(
        [
            ['a frozen audience', FROZEN],
            ['no frozen audience', { mode: 'broadcast', scope: 'room', groupRef: ROOM } as const]
        ] as const
    )('refuses, under %s, the own gap NACK of a peer this relay forwards the message to no copy of', (_name, targets) => {
        const read = readUnreceipted({ reason: 'gap', fromPeerId: 'leaf', logicalRecipientPeerId: 'leaf' }, targets);

        expect(validateALInboundUnreceiptedGapNackAdmission(read))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK comes from no child this relay forwards the message to' }]);
    });

    it('forwards only a child\'s own word for a message that froze no audience', () => {
        const broadcast = { mode: 'broadcast', scope: 'room', groupRef: ROOM } as const;

        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' }, broadcast))).toEqual([]);
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'leaf' }, broadcast)))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK speaks for another recipient of a message that froze no audience' }]);
    });

    it('refuses a gap NACK naming another track than the message\'s', () => {
        expect(
            validateALInboundUnreceiptedGapNackAdmission(
                readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child', ordering: { ...GAP_ORDERING, orderingKey: 'other:origin:1' } })
            )
        )
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names a track the message is not on' }]);
    });

    it('refuses a gap NACK without its ordering hints as malformed', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' });

        expect(validateALInboundUnreceiptedGapNackAdmission({ ...read, nack: { ...read.nack, expectedSeq: undefined } }))
            .toEqual([{ code: 'malformed', message: 'Inbound gap NACK carries no ordering hints to forward' }]);
    });
});
