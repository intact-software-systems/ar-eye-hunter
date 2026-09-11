import type { ALAckPayload, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import type { ALAdmissionReadContext } from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
import {
    toALInboundControlAcksKey,
    toALInboundControlPendingKey
} from '@shared/alm/inbound/al-inbound-admission-store.ts';

export interface InboundTestAcknowledgements {
    readonly pendingAck: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
}

export interface ReadInboundTestAcknowledgementsInput {
    readonly backend: ALAdmissionReadContext;
    readonly namespace: string;
    readonly msgId: string;
    readonly senderId: string;
}

/**
 * The two acknowledgement rows one message owns, read back under the store's own key builders and decoder.
 * The runtime reads them as part of a decision surface and never on their own, so a pin that wants
 * only them reads the backend rather than asking the store for a port nothing in production calls.
 */
export async function readInboundTestAcknowledgements(
    input: ReadInboundTestAcknowledgementsInput
): Promise<InboundTestAcknowledgements> {
    const { backend, namespace, msgId, senderId } = input;
    const pendingAck = (await backend.read(
        toALInboundControlPendingKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'pending')
    ))?.value;
    const acks = (await backend.read(
        toALInboundControlAcksKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
    ))?.values ?? [];
    return { pendingAck, acks };
}
