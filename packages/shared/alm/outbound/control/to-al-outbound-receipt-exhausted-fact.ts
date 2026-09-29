import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALDeliveryReceiptExhaustion } from '../../delivery/al-delivery-failure.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

/** A receipt that ended unconfirmed, in its row's own peer terms: next hops, or logical recipients under `receiver`. */
export function toALOutboundReceiptExhaustedFact(
    receipt: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'>,
    exhaustion: ALDeliveryReceiptExhaustion,
    detail: string
): ALOutboundSettlementFact {
    return {
        kind: 'receipt-exhausted',
        msgId: receipt.msgId,
        mode: receipt.mode,
        confirmedPeerIds: receipt.expectedPeerIds.filter((peerId) => receipt.ackedPeerIds.includes(peerId)),
        unconfirmedPeerIds: receipt.expectedPeerIds.filter((peerId) => !receipt.ackedPeerIds.includes(peerId)),
        ...exhaustion,
        detail
    };
}
