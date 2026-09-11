import type { ALAckPayload, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import type { ALAdmissionReadContext } from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';

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
 * The two acknowledgement rows one message owns, read back under the store's own keys and decoder.
 * The runtime reads them as part of a decision surface and never on their own, so a pin that wants
 * only them reads the backend rather than asking the store for a port nothing in production calls.
 */
export async function readInboundTestAcknowledgements(
    input: ReadInboundTestAcknowledgementsInput
): Promise<InboundTestAcknowledgements> {
    const { backend, namespace, msgId, senderId } = input;
    const slot = `${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
    const pendingAck = (await backend.read(
        `${namespace}:control:pending:${slot}`,
        (value) => decodeALAdmissionControlValue(value, msgId, 'pending')
    ))?.value;
    const acks = (await backend.read(
        `${namespace}:control:acks:${slot}`,
        (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
    ))?.values ?? [];
    return { pendingAck, acks };
}
