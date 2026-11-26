import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

/** One ordered, receipted room send a publisher offered at the server's entry. */
export interface OrderedSendCellSend {
    readonly msgId: string;
    readonly publisherPeerId: string;
    /** The send's place on its publisher's track. */
    readonly seq: number;
    readonly dueAtMs: number;
    readonly sentAtMs: number;
    readonly answeredAtMs: number;
    /** The entry's answer: the kind it accepted the send as, or `rejected` for a rejection. */
    readonly acceptance: 'rejected' | ALInboundMessageRuntime.Acceptance['kind'];
    readonly expectedRecipientPeerIds: readonly string[];
}

/** A recipient's socket read a copy. */
export interface OrderedSendCellArrival {
    readonly msgId: string;
    readonly recipientPeerId: string;
    readonly atMs: number;
}

/** A server instance handed the message to its application subscriber. */
export interface OrderedSendCellHandOff {
    readonly msgId: string;
    readonly instanceIndex: number;
    readonly atMs: number;
}

/** The publisher's socket read a receipt for its send. */
export interface OrderedSendCellReceipt {
    readonly msgId: string;
    readonly phase: ALReceiptPayload['phase'];
    readonly atMs: number;
}

/** What one run of the cell recorded. Every instant is a millisecond reading of one monotonic clock. */
export interface OrderedSendCellObservations {
    readonly sends: readonly OrderedSendCellSend[];
    readonly arrivals: readonly OrderedSendCellArrival[];
    readonly handOffs: readonly OrderedSendCellHandOff[];
    readonly receipts: readonly OrderedSendCellReceipt[];
}
