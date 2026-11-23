import type { ALAckPayload } from '../../../al-contracts/al-control.ts';
import { isWsQueueBoxServerNotSentAck } from './to-ws-queue-box-server-counted-ack.ts';
import type { WsQueueBoxServerOwnPendingReceipt } from './to-ws-queue-box-server-own-receipt-opening.ts';

/** An ACK the record counted no head for, and what proves it. */
export interface WsQueueBoxServerHeadAbsentAck {
    readonly ack: ALAckPayload;
    readonly serverPeerId: string;
    /** The server's pending receipt row of the ACK's message; read only for a session's ACK of a server publication. */
    readonly own: WsQueueBoxServerOwnPendingReceipt | undefined;
    /** Whether the opening `own` gives would open: the record's opening rules and the receipt control's codec. */
    readonly ownOpeningOpens: boolean;
}

export type WsQueueBoxServerHeadAbsentAckRoute = 'count-ahead' | 'rejected' | 'outbound-owner';

/**
 * Where an ACK that finds no head goes. The ingress hook proved a receiver's ACK for another origin against that
 * origin's admission, and the server's own `not-sent` needs no proof: both are counted ahead. A session's ACK of the
 * server's own publication is proven by the server's pending row, when that row would open a head: counted ahead when
 * the row expects its recipient, refused when not. A row that would not open, or no row, leaves the ACK to the
 * server's outbound owner, which counts it as it counts a `hop` ACK.
 */
export function resolveWsQueueBoxServerHeadAbsentAck(
    input: WsQueueBoxServerHeadAbsentAck
): WsQueueBoxServerHeadAbsentAckRoute {
    const { ack, serverPeerId, own, ownOpeningOpens } = input;
    if (!isWsQueueBoxServerOwnSessionAck(ack, serverPeerId)) {
        return 'count-ahead';
    }
    if (own === undefined || !ownOpeningOpens) {
        return 'outbound-owner';
    }
    return own.pending.expectedPeerIds.includes(ack.logicalRecipientPeerId) ? 'count-ahead' : 'rejected';
}

/** A session's ACK of a publication of the server's own: the one ACK whose proof is the server's pending row. */
export function isWsQueueBoxServerOwnSessionAck(ack: ALAckPayload, serverPeerId: string): boolean {
    return ack.originPeerId === serverPeerId && !isWsQueueBoxServerNotSentAck(ack, serverPeerId);
}
