import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';

/** Every expected peer of a receipt row in exactly one class; together they are its expected peers. */
export interface ALOutboundReceiptClasses {
    readonly confirmedPeerIds: readonly string[];
    /** Neither acked nor outside the audience: the peers the receipt still owes, and so the ones a retry targets. */
    readonly unconfirmedPeerIds: readonly string[];
    /** Answered they are outside the audience and never confirmed: a confirmation outranks a later outside answer. */
    readonly outsideAudiencePeerIds: readonly string[];
}

export function toALOutboundReceiptClasses(
    receipt: Pick<ALOutboundPendingAckSnapshot, 'expectedPeerIds' | 'ackedPeerIds' | 'outsideAudiencePeerIds'>
): ALOutboundReceiptClasses {
    const isAcked = (peerId: string) => receipt.ackedPeerIds.includes(peerId);
    const isOutside = (peerId: string) => receipt.outsideAudiencePeerIds.includes(peerId);
    return {
        confirmedPeerIds: receipt.expectedPeerIds.filter(isAcked),
        unconfirmedPeerIds: receipt.expectedPeerIds.filter((peerId) => !isAcked(peerId) && !isOutside(peerId)),
        outsideAudiencePeerIds: receipt.expectedPeerIds.filter((peerId) => !isAcked(peerId) && isOutside(peerId))
    };
}
