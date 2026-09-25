import { validateALInboundAdmissionMutation } from '@shared/alm/inbound/admission/validate-al-inbound-admission-mutation.ts';
import {
    type ALInboundAdmissionMutation,
    type ALInboundAdmissionObservations,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { AcksControlValue } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { describe, expect, it } from 'vitest';

const MSG_ID = 'msg-invalid-control-value';
const SENDER_ID = 'sender-1';

function toBundle(): ALInboundCommitBundle {
    const observations: ALInboundAdmissionObservations = {
        msgId: MSG_ID,
        senderId: SENDER_ID,
        messageOwner: undefined,
        dedup: undefined,
        ordering: undefined,
        buffered: undefined,
        deliveryProgress: undefined,
        supersedence: {},
        pendingAck: undefined,
        acks: [],
        controlOwners: undefined
    };
    return {
        admissionExpiresAtMs: null,
        senderId: SENDER_ID,
        observations,
        mutations: [],
        durableEffects: []
    };
}

/**
 * The narrowest shape the two corruption cases below need: a stored ACK entry with its `carrier`
 * loosened to an optional plain string, so a literal that omits it or carries an unrecognised value
 * still type-checks as a fixture, while a real `AcksControlValue` cannot hold either.
 */
interface StoredAckEntryFixture {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly originPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status: string;
    readonly observedAtEpochMs: number;
    readonly carrier?: string;
}

interface AcksControlValueFixture {
    readonly kind: 'acks';
    readonly values: readonly StoredAckEntryFixture[];
}

function toAcksMutation(value: AcksControlValueFixture): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-acks',
        msgId: MSG_ID,
        senderId: SENDER_ID,
        value: value as AcksControlValue,
        expireAtTimestamp: 1_000
    };
}

describe('validateALInboundAdmissionMutation invalid control value', () => {
    it('reports the typed issue, not a throw, for an acks entry with no carrier', () => {
        const mutation = toAcksMutation({
            kind: 'acks',
            values: [
                {
                    ackedMsgId: MSG_ID,
                    originPeerId: SENDER_ID,
                    logicalRecipientPeerId: 'peer-a',
                    fromPeerId: 'peer-a',
                    toPeerId: 'peer-b',
                    status: 'accepted',
                    observedAtEpochMs: 1
                }
            ]
        });

        const issues = validateALInboundAdmissionMutation(mutation, toBundle());

        expect(issues).toEqual(['Inbound admission candidate has an invalid control value']);
    });

    it('reports the typed issue, not a throw, for an acks entry with an unknown carrier', () => {
        const mutation = toAcksMutation({
            kind: 'acks',
            values: [
                {
                    ackedMsgId: MSG_ID,
                    originPeerId: SENDER_ID,
                    logicalRecipientPeerId: 'peer-a',
                    fromPeerId: 'peer-a',
                    toPeerId: 'peer-b',
                    status: 'accepted',
                    observedAtEpochMs: 1,
                    carrier: 'carrier-pigeon'
                }
            ]
        });

        const issues = validateALInboundAdmissionMutation(mutation, toBundle());

        expect(issues).toEqual(['Inbound admission candidate has an invalid control value']);
    });
});
