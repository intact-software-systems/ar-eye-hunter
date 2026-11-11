import { describe, expect, it } from 'vitest';

import {
    parseALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';
import {
    computeALInboundNackAdmission,
    toALInboundNackCommitBundle,
    type ALInboundNackAdmissionCandidate
} from '@shared/alm/inbound/control/compute-al-inbound-nack-admission.ts';
import { validateALInboundNackAdmission } from '@shared/alm/inbound/control/validate-al-inbound-nack-admission.ts';
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
        ...(arrival.ordering ?? (arrival.reason === 'gap' ? GAP_ORDERING : {}))
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

    it('refuses a gap NACK for a recipient the relay recorded outside the audience', () => {
        const candidate = computeArrival({ reason: 'gap' }, { ...ROW, outsideAudiencePeerIds: ['leaf'] });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient already forwarded outside the audience'
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
