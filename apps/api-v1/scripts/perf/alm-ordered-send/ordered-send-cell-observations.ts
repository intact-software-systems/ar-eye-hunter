import type { ALNackReason, ALReceiptPayload, ALRepairReason } from '@shared/al-contracts/al-control.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

/** One ordered, receipted room send as its publisher offered it at the server's entry. */
export interface OrderedSendCellOffer {
    /**
     * Unique among the sends of one run: everything else the run records names its send by it. The report takes a
     * msgId for the first send in the list to carry it and counts a later one in `unmatched`, where a run of the
     * cell leaves 0.
     */
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
 * A session's socket read a copy; every read is recorded, at whichever session. A read at a session the send did not
 * expect, its own publisher or a session outside its audience, is no copy of any expected recipient: the report
 * counts it in `unmatched.arrivalsAtUnexpectedRecipient` and in no delivery or delay figure. On `main` the copy of a
 * send on a topic the router has no definition of is a live notice, never a row of the WS outbox: the instance that
 * hands the send to its router publishes one `ws-live-notice` NOTIFY that carries the message, writes the copies of
 * its own sessions once the publish returned, and each other instance writes its sessions' copies as the NOTIFY
 * reaches it.
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
 * A session's socket read a NACK or a repair request: the server's word to the sender of the message `msgId` names,
 * with the reason it gave. Of a gap in a track the server tells the sender twice, by a `gap` NACK and by a
 * `missing-seq` repair request, and both name the message whose arrival showed the gap, never one that is missing.
 * A session of the cell answers neither and sends nothing again.
 */
export type OrderedSendCellControl =
    | { readonly type: 'nack'; readonly msgId: string; readonly reason: ALNackReason; readonly atMs: number; }
    | { readonly type: 'repair'; readonly msgId: string; readonly reason: ALRepairReason; readonly atMs: number; };

/**
 * A session's socket read a control frame that is no receipt, no NACK and no repair request: an ACK, or a control
 * whose payload does not decode. The server has no reason to write either to a session of the cell.
 */
export interface OrderedSendCellUnclassifiedControl {
    /** The payload type the frame's envelope names. */
    readonly typeId: string;
    readonly atMs: number;
}

/**
 * What one run of the cell recorded. Every instant is an unrounded `performance.now()` reading of one clock. Every
 * list but `sends` is in the order observed, appended as it happened, and the report takes "first" and "before" from
 * that order, never from comparing instants. Every frame a session's socket read is in exactly one of `arrivals`,
 * `receipts`, `controls` and `unclassifiedControls`. What the entry answered a recipient's ACK is in no list.
 */
export interface OrderedSendCellObservations {
    readonly sends: readonly OrderedSendCellSend[];
    readonly arrivals: readonly OrderedSendCellArrival[];
    readonly handOffs: readonly OrderedSendCellHandOff[];
    readonly receipts: readonly OrderedSendCellReceipt[];
    readonly controls: readonly OrderedSendCellControl[];
    readonly unclassifiedControls: readonly OrderedSendCellUnclassifiedControl[];
    /** The instant the run stopped observing: nothing that happened later is in any list. */
    readonly observationEndedAtMs: number;
}
