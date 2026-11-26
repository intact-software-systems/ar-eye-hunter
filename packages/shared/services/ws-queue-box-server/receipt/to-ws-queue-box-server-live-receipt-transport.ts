import type { WsQueueBoxServerLiveDelivery } from '../ws-queue-box-server-live-delivery.ts';
import {
    toImmutableWsQueueBoxServerReceipt,
    type WsQueueBoxServerReceiptTransportObservation
} from '../ws-queue-box-server-receipt-observation.ts';
import type { WsQueueBoxServerIssuedReceipt } from './to-ws-queue-box-server-receipt-control.ts';

/**
 * The `receipt-transport` observation of one connection a live receipt was written to: `transport: 'recipient'`,
 * `publisherCall: 'absent'`, `originIsHere: true`, the native call the socket stated, `outcome` `sent` for a written
 * connection and `failed` for one whose write threw, and frozen copies of the receipt's arrays.
 */
export function toWsQueueBoxServerLiveReceiptTransport(
    issued: WsQueueBoxServerIssuedReceipt,
    write: WsQueueBoxServerLiveDelivery.ConnectionWrite,
    serverPeerId: string
): WsQueueBoxServerReceiptTransportObservation {
    return Object.freeze({
        kind: 'receipt-transport',
        serverPeerId,
        receiptControlMsgId: issued.controlId,
        traceId: issued.opening.traceId,
        receipt: toImmutableWsQueueBoxServerReceipt(issued.receipt),
        transport: 'recipient',
        nativeCall: write.nativeCall,
        connectionId: write.connectionId,
        publisherCall: 'absent',
        originIsHere: true,
        outcome: write.written ? 'sent' : 'failed',
        submissionAttempted: write.nativeCall !== 'not-called',
        retryAfterMs: undefined
    });
}
