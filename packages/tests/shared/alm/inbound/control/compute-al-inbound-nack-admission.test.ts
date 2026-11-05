import { describe, expect, it } from 'vitest';

import {
    parseALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';
import {
    computeALInboundNackAdmission,
    toALInboundNackCommitBundle,
    type ALInboundNackAdmissionCandidate
} from '@shared/alm/inbound/control/compute-al-inbound-nack-admission.ts';
import { validateALInboundNackAdmission } from '@shared/alm/inbound/control/validate-al-inbound-nack-admission.ts';

const NOW_MS = 1_800_000_000_000;

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
    readonly ordering?: Partial<Pick<ALNackPayload, 'orderingKey' | 'expectedSeq' | 'missingRanges'>>;
}

function computeArrival(
    arrival: NackArrival,
    row: ALPendingAckSnapshot = ROW,
    acks: readonly ALAckPayload[] = []
): ALInboundNackAdmissionCandidate {
    return computeALInboundNackAdmission({
        namespace: 'relay',
        nack: {
            msgId: 'subject',
            fromPeerId: arrival.fromPeerId ?? 'child',
            toPeerId: 'relay',
            logicalRecipientPeerId: arrival.logicalRecipientPeerId ?? 'leaf',
            reason: arrival.reason,
            observedAtEpochMs: NOW_MS,
            ...(arrival.ordering ?? (arrival.reason === 'gap' ? GAP_ORDERING : {}))
        },
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
        nowMs: NOW_MS,
        controlMsgId: 'relayed',
        traceId: 'trace-relayed-nack'
    }, normalizeALRuntimeStoreRetention());
}

function toUpwardControls(candidate: ALInboundNackAdmissionCandidate) {
    return candidate.upwardEffects.map((effect) => effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined);
}

function toConfirmation(logicalRecipientPeerId: string): ALAckPayload {
    return {
        ackedMsgId: 'subject',
        fromPeerId: 'child',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'rtc',
        status: 'forwarded',
        observedAtEpochMs: NOW_MS
    };
}

describe('a child\'s gap NACK at a relay (S4ii-R3)', () => {
    it('re-originates one gap NACK toward the parent with the ordering hints, writing no row', () => {
        const candidate = computeArrival({ reason: 'gap' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toBeUndefined();
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: {
                msgId: 'subject',
                fromPeerId: 'relay',
                toPeerId: 'parent',
                logicalRecipientPeerId: 'leaf',
                reason: 'gap',
                observedAtEpochMs: NOW_MS,
                ...GAP_ORDERING
            }
        }]);
    });

    it('refuses a gap NACK from a child the row does not wait on', () => {
        expect(validateALInboundNackAdmission(computeArrival({ reason: 'gap', fromPeerId: 'stranger' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK sender has no pending obligation' }]);
    });

    it('refuses a gap NACK for a recipient whose confirmation the relay already relayed', () => {
        const candidate = computeArrival({ reason: 'gap' }, ROW, [toConfirmation('leaf')]);

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient whose confirmation was already relayed'
        }]);
    });

    it('refuses a gap NACK for a recipient the relay recorded outside the audience', () => {
        const candidate = computeArrival({ reason: 'gap' }, { ...ROW, outsideAudiencePeerIds: ['leaf'] });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient already relayed outside the audience'
        }]);
    });

    it.each(
        [
            ['its missing ranges', { orderingKey: GAP_ORDERING.orderingKey, expectedSeq: GAP_ORDERING.expectedSeq }],
            ['its ordering key', { expectedSeq: GAP_ORDERING.expectedSeq, missingRanges: GAP_ORDERING.missingRanges }]
        ] as const
    )('refuses a gap NACK without %s as malformed, relaying nothing', (_missing, ordering) => {
        const candidate = computeArrival({ reason: 'gap', ordering });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'malformed',
            message: 'Inbound gap NACK carries no ordering hints to relay'
        }]);
        expect(candidate.upwardEffects).toEqual([]);
    });

    it('records a not-subscribed recipient outside and relays its NACK without ordering hints, as before', () => {
        const candidate = computeArrival({ reason: 'not-subscribed' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toEqual({ kind: 'pending', value: { ...ROW, outsideAudiencePeerIds: ['leaf'] } });
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: {
                msgId: 'subject',
                fromPeerId: 'relay',
                toPeerId: 'parent',
                logicalRecipientPeerId: 'leaf',
                reason: 'not-subscribed',
                observedAtEpochMs: NOW_MS
            }
        }]);
    });
});
