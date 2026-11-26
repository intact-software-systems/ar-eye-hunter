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

/**
 * What one run of the cell recorded. Every instant is an unrounded `performance.now()` reading of one clock.
 * `arrivals`, `handOffs` and `receipts` are each in the order observed, appended as it happened, and the report takes
 * "first" and "before" from that order, never from comparing instants.
 */
export interface OrderedSendCellObservations {
    readonly sends: readonly OrderedSendCellSend[];
    readonly arrivals: readonly OrderedSendCellArrival[];
    readonly handOffs: readonly OrderedSendCellHandOff[];
    readonly receipts: readonly OrderedSendCellReceipt[];
    /** The instant the run stopped observing: nothing that happened later is in any list. */
    readonly observationEndedAtMs: number;
}
