import type { ALAckPayload, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import type { ALAdmissionReadContext } from '@shared/alm/al-admission-backend.ts';
import { readStoredAcknowledgements } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';

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
 * The two acknowledgement rows one message owns, read back through the store's own row reader.
 * The runtime reads them as part of a decision surface and never on their own, so a pin that wants
 * only them reads the backend rather than asking the store for a port nothing in production calls.
 */
export async function readInboundTestAcknowledgements(
    input: ReadInboundTestAcknowledgementsInput
): Promise<InboundTestAcknowledgements> {
    const { backend, namespace, msgId, senderId } = input;
    return await readStoredAcknowledgements({ database: backend, namespace, msgId, senderId });
}
