import type { ALAckPayload } from '../../../al-contracts/al-control.ts';
import { isWsQueueBoxServerNotSentAck } from './to-ws-queue-box-server-counted-ack.ts';
import type { WsQueueBoxServerOwnPendingReceipt } from './to-ws-queue-box-server-own-receipt-opening.ts';

/** An ACK the record counted no head for, and what proves it. */
export interface WsQueueBoxServerHeadAbsentAck {
    readonly ack: ALAckPayload;
    readonly serverPeerId: string;
    /** The server's pending receipt row of the ACK's message; read only for an ACK of a server publication. */
    readonly own: WsQueueBoxServerOwnPendingReceipt | undefined;
    /** Whether the opening `own` gives would open: the record's opening rules and the receipt control's codec. */
    readonly ownOpeningOpens: boolean;
}

export type WsQueueBoxServerHeadAbsentAckRoute = 'count-ahead' | 'rejected' | 'outbound-owner';

/**
 * Where an ACK that finds no head goes. The ingress hook proved a receiver's ACK for another origin against that
 * origin's admission, and the server's own `not-sent` of another origin's send needs no proof: both are counted
 * ahead. Every ACK of the server's own publication is proven by the server's pending row, when that row would open a
 * head: counted ahead when the row expects its recipient, refused when not. A session's ACK whose row would not open,
 * or that finds no row, goes to the server's outbound owner, which counts it as it counts a `hop` ACK; the server's
 * own `not-sent` writes nothing then, since no head could ever read it.
 */
export function resolveWsQueueBoxServerHeadAbsentAck(
    input: WsQueueBoxServerHeadAbsentAck
): WsQueueBoxServerHeadAbsentAckRoute {
    const { ack, serverPeerId, own, ownOpeningOpens } = input;
    if (ack.originPeerId !== serverPeerId) {
        return 'count-ahead';
    }
    const opens = own !== undefined && ownOpeningOpens;
    if (!opens && !isWsQueueBoxServerNotSentAck(ack, serverPeerId)) {
        return 'outbound-owner';
    }
    return opens && own.pending.expectedPeerIds.includes(ack.logicalRecipientPeerId) ? 'count-ahead' : 'rejected';
}
