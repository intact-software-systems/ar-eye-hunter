import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';

/** A kept WS client send its replay admitted, as the admission that starts its receipt; none without a room audience. */
export function toWsQueueBoxServerReplayedAdmittedMessage(
    replayed: ALInboundMessageRuntime.ReplayedAdmission
): WsQueueBoxServerReceiptAggregation.AdmittedMessage | undefined {
    const { source, snapshotVersion } = replayed;
    if (source.kind !== 'ws-client' || source.groupRecipientPeerIds === undefined || snapshotVersion === undefined) {
        return undefined;
    }
    return {
        message: replayed.msg,
        originPeerId: source.peerId,
        roomAudience: { recipientPeerIds: source.groupRecipientPeerIds, snapshotVersion },
        acceptance: { kind: 'admitted' }
    };
}
