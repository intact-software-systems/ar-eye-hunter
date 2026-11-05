import { describe, expect, it } from 'vitest';

import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundEffectPayload, type ALOutboundPreparedRead } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { toALOutboundControlRepairHint } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import { toALOutboundEffectId, toALOutboundRepairHintEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';

const GAP: ALNackPayload = {
    msgId: 'subject',
    fromPeerId: 'relay',
    toPeerId: 'origin',
    logicalRecipientPeerId: 'leaf',
    reason: 'gap',
    observedAtEpochMs: 1,
    orderingKey: 'feed:origin:1',
    expectedSeq: 2,
    missingRanges: [{ from: 2, to: 2 }]
};

/** A hint carries no prepared copy, so its decoder reads none. */
const NO_PREPARED: ALOutboundPreparedRead<never> = {
    decodePrepared: () => {
        throw new Error('A repair hint carries no prepared copy.');
    },
    message: undefined
};

function toPersistedHint(request: ALOutboundRepairHint) {
    return decodeALOutboundEffectPayload(
        JSON.parse(JSON.stringify({ kind: 'repair-hint', msgId: 'subject', request })),
        'repair-hint-effect',
        NO_PREPARED
    );
}

describe('the repair hint a gap NACK raises (S4ii-R3)', () => {
    it('names the recipient a relay asks the repair for beside the relay that asks', () => {
        expect(toALOutboundControlRepairHint({ type: 'nack', payload: GAP })).toEqual({
            trigger: 'nack',
            requestedByPeerId: 'relay',
            logicalRecipientPeerId: 'leaf',
            orderingTrackKey: 'feed:origin:1',
            missingRanges: [{ from: 2, to: 2 }],
            failedPeerIds: []
        });
    });

    it('names no other recipient when the recipient asks for itself, so its NACK and repair request stay one hint', () => {
        const own = toALOutboundControlRepairHint({ type: 'nack', payload: { ...GAP, fromPeerId: 'leaf' } });

        expect(own).not.toHaveProperty('logicalRecipientPeerId');
        expect(own).toEqual(toALOutboundControlRepairHint({
            type: 'repair',
            payload: {
                msgId: 'subject',
                fromPeerId: 'leaf',
                toPeerId: 'origin',
                reason: 'missing-seq',
                observedAtEpochMs: 1,
                orderingKey: 'feed:origin:1',
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }]
            }
        }));
    });

    it('names each recipient\'s hint apart, and a recipient\'s own hint as before', () => {
        const forLeaf = toALOutboundControlRepairHint({ type: 'nack', payload: GAP });
        const forOther = toALOutboundControlRepairHint({ type: 'nack', payload: { ...GAP, logicalRecipientPeerId: 'other' } });
        const own = toALOutboundControlRepairHint({ type: 'nack', payload: { ...GAP, fromPeerId: 'leaf' } });

        expect(toALOutboundRepairHintEffectId('subject', forLeaf)).not.toBe(toALOutboundRepairHintEffectId('subject', forOther));
        expect(toALOutboundRepairHintEffectId('subject', own))
            .toBe(toALOutboundEffectId(['repair-hint', 'subject', 'leaf', 'feed:origin:1', '2-2']));
    });

    it('does not read a relay\'s terminal NACK for another recipient as one it relays', () => {
        const expired = toALOutboundControlRepairHint({ type: 'nack', payload: { ...GAP, reason: 'expired' } });

        expect(expired).not.toHaveProperty('logicalRecipientPeerId');
    });

    it('round-trips the recipient through the persisted hint', () => {
        const request: ALOutboundRepairHint = {
            trigger: 'nack',
            requestedByPeerId: 'relay',
            logicalRecipientPeerId: 'leaf',
            orderingTrackKey: 'feed:origin:1',
            missingRanges: [{ from: 2, to: 2 }],
            failedPeerIds: []
        };

        expect(toPersistedHint(request)).toEqual({ kind: 'repair-hint', msgId: 'subject', request });
    });

    it('decodes a persisted hint without a recipient as one whose requester is the recipient', () => {
        const request = toALOutboundControlRepairHint({ type: 'nack', payload: { ...GAP, fromPeerId: 'leaf' } });

        const decoded = toPersistedHint(request);

        expect(decoded).toEqual({ kind: 'repair-hint', msgId: 'subject', request });
        expect(decoded.kind === 'repair-hint' && decoded.request).not.toHaveProperty('logicalRecipientPeerId');
    });
});
