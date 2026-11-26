import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

/** One ordered, receipted room send as its publisher offered it at the server's entry. */
export interface OrderedSendCellOffer {
    readonly msgId: string;
    readonly publisherPeerId: string;
    /** The send's place on its publisher's track: a higher seq was offered later. */
    readonly seq: number;
    /** The instant the schedule placed the send at, never recomputed from the timer that fired it. */
    readonly dueAtMs: number;
    /**
     * Read immediately before the send was offered to `acceptIncomingMessage`. A reading before `dueAtMs`, from a
     * timer that fired early, is no lateness: the report counts it apart.
     */
    readonly sentAtMs: number;
    /** The send's fixed audience: the other sessions of the room, never the publisher, never empty. */
    readonly expectedRecipientPeerIds: readonly string[];
}

/**
 * What `acceptIncomingMessage` answered, read at `answeredAtMs` as soon as it resolved: the kind it accepted the send
 * as, `rejected` for a rejection, or `unanswered` for a send still pending when the drain ended.
 */
export type OrderedSendCellAnswer =
    | {
        readonly acceptance: Exclude<ALInboundMessageRuntime.Acceptance['kind'], 'not-admitted'>;
        readonly answeredAtMs: number;
    }
    | { readonly acceptance: 'not-admitted'; readonly answeredAtMs: number; readonly notAdmittedReason: string; }
    | {
        readonly acceptance: 'rejected';
        readonly answeredAtMs: number;
        readonly rejectionCode: ALMessageRejection['code'];
    }
    | { readonly acceptance: 'unanswered'; readonly answeredAtMs: null; };

export type OrderedSendCellSend = OrderedSendCellOffer & OrderedSendCellAnswer;

/**
 * A session's socket read a copy; every read is recorded, at whichever session. On `main` the copy of a send on a
 * topic the router has no definition of is a live notice, never a row of the WS outbox: the instance that hands the
 * send to its router publishes one `ws-live-notice` NOTIFY that carries the message, writes the copies of its own
 * sessions once the publish returned, and each other instance writes its sessions' copies as the NOTIFY reaches it.
 */
export interface OrderedSendCellArrival {
    readonly msgId: string;
    readonly recipientPeerId: string;
    readonly atMs: number;
}

/**
 * A server instance handed the message to its application: the cell's observer on the service's
 * `onAnyInboxMessageDo`, registered ahead of the topic router's own, was called, so the instant is read before the
 * router publishes anything.
 */
export interface OrderedSendCellHandOff {
    readonly msgId: string;
    readonly instanceIndex: number;
    readonly atMs: number;
}

/**
 * A session's socket read a receipt of a send. On `main` a receipt is a row the instance that admitted the send
 * writes to the shared WS outbox. The instance whose worker takes the row writes it to the origin's socket when that
 * socket is its own; otherwise it announces the row's key by a `ws-channel` NOTIFY for the origin's instance to
 * write, and announces it again until the row expires, so the origin may read one receipt more than once. A
 * recipient's ACK reaches the instance that counts it directly, or by a `ws-relayed-ack` NOTIFY from the instance
 * its socket is on.
 */
export interface OrderedSendCellReceipt {
    readonly msgId: string;
    readonly phase: ALReceiptPayload['phase'];
    readonly atMs: number;
}

/**
 * What one run of the cell recorded. Every instant is an unrounded `performance.now()` reading of one clock.
 * `arrivals`, `handOffs` and `receipts` are each in the order observed, appended as it happened, and the report takes
 * "first" and "before" from that order, never from comparing instants. A NACK or a repair request the server wrote
 * to a publisher's socket is in no list, and neither is what the entry answered a recipient's ACK.
 */
export interface OrderedSendCellObservations {
    readonly sends: readonly OrderedSendCellSend[];
    readonly arrivals: readonly OrderedSendCellArrival[];
    readonly handOffs: readonly OrderedSendCellHandOff[];
    readonly receipts: readonly OrderedSendCellReceipt[];
    /** The instant the run stopped observing: nothing that happened later is in any list. */
    readonly observationEndedAtMs: number;
}
