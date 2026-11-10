import type { ALAckPayload, ALNackPayload } from '@shared/al-contracts/al-control.ts';

export type TestALAckFields =
    & Pick<ALAckPayload, 'ackedMsgId' | 'fromPeerId' | 'toPeerId'>
    & Partial<ALAckPayload>;

/**
 * Defaults: originPeerId = toPeerId, logicalRecipientPeerId = fromPeerId, carrier 'rtc', status 'delivered',
 * observedAtEpochMs 1, proof null.
 */
export function toTestALAckPayload(fields: TestALAckFields): ALAckPayload {
    return {
        originPeerId: fields.toPeerId,
        logicalRecipientPeerId: fields.fromPeerId,
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: 1,
        proof: null,
        ...fields
    };
}

export type TestALNackFields =
    & Pick<ALNackPayload, 'msgId' | 'fromPeerId' | 'toPeerId' | 'reason'>
    & Partial<ALNackPayload>;

/** Defaults: logicalRecipientPeerId = fromPeerId, originPeerId = toPeerId, observedAtEpochMs 1, proof null. */
export function toTestALNackPayload(fields: TestALNackFields): ALNackPayload {
    return {
        logicalRecipientPeerId: fields.fromPeerId,
        originPeerId: fields.toPeerId,
        observedAtEpochMs: 1,
        proof: null,
        ...fields
    };
}
