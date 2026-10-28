import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALDeliveryReceiptExhaustion } from '../../delivery/al-delivery-failure.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

export interface ToALOutboundReceiptExhaustedFactInput {
    readonly receipt: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'>;
    readonly exhaustion: ALDeliveryReceiptExhaustion;
    readonly detail: string;
    /** The trace of the request whose commit ended the receipt. */
    readonly traceId: string;
}

/** A receipt that ended unconfirmed, in its row's own peer terms: next hops, or logical recipients under `receiver`. */
export function toALOutboundReceiptExhaustedFact(
    input: ToALOutboundReceiptExhaustedFactInput
): ALOutboundSettlementFact {
    const { receipt, exhaustion, detail } = input;
    return {
        kind: 'receipt-exhausted',
        msgId: receipt.msgId,
        traceId: input.traceId,
        mode: receipt.mode,
        confirmedPeerIds: receipt.expectedPeerIds.filter((peerId) => receipt.ackedPeerIds.includes(peerId)),
        unconfirmedPeerIds: receipt.expectedPeerIds.filter((peerId) => !receipt.ackedPeerIds.includes(peerId)),
        ...exhaustion,
        detail
    };
}
