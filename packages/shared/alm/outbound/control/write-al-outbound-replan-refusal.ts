import { RetryableConflictError } from '../../../resilience/try-with-policy.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundSettlementEmitter, ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import { toALOutboundEndReceiptBundle } from './to-al-outbound-end-receipt-bundle.ts';

export interface WriteALOutboundReplanRefusalInput<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly settlements: ALOutboundSettlementEmitter;
    /** The stored message's sender, whose version fences the commit. */
    readonly senderId: string;
    readonly refusal: ALOutboundSettlementFact;
}

/**
 * A re-plan refused for good ends the message's receipt in the commit whose success states the refusal: one end and
 * one settlement, so no later retry restates it and a late ACK finds no row. A conflict states nothing and retries.
 */
export async function writeALOutboundReplanRefusal<TPrepared>(
    input: WriteALOutboundReplanRefusalInput<TPrepared>
): Promise<void> {
    const { admissionStore, senderId, refusal } = input;
    const { clientRecord } = await admissionStore.readReceiptAdmission({
        originPeerId: senderId,
        msgId: refusal.msgId
    });
    const status = await admissionStore.commitBundle(
        toALOutboundEndReceiptBundle(senderId, refusal.msgId, clientRecord?.version)
    );
    if (status === 'conflict') {
        throw new RetryableConflictError('Outbound re-plan refusal commit conflict');
    }
    if (status === 'committed') {
        input.settlements(refusal);
    }
}
