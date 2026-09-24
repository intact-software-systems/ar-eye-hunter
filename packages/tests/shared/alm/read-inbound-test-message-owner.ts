import type { ALAdmissionReadContext } from '@shared/alm/al-admission-backend.ts';
import type { ALInboundMessageOwner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { readALInboundMessageOwner } from '@shared/alm/inbound/al-inbound-source-validation.ts';

export interface ReadInboundTestMessageOwnerInput {
    readonly backend: ALAdmissionReadContext;
    readonly namespace: string;
    readonly msgId: string;
    readonly senderId: string;
}

/**
 * The provenance row one admitted message owns, read back through the store's own row reader.
 * The store reads it only as part of a decision surface, so a pin that wants the retained ingress
 * source on its own reads the backend instead of asking for a port no production path calls.
 */
export async function readInboundTestMessageOwner(
    input: ReadInboundTestMessageOwnerInput
): Promise<ALInboundMessageOwner | undefined> {
    const { backend, namespace, msgId, senderId } = input;
    return await readALInboundMessageOwner({ database: backend, namespace, msgId, senderId });
}
