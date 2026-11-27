import type { ALNackReason, ALReceiptPayload, ALRepairReason } from '@shared/al-contracts/al-control.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

/**
 * One ordered, receipted room send as its publisher first offered it at the server's entry. A send is in the list
 * once, with its first offer and that offer's answer, however often its publisher offered it again: every later
 * offer is in `resends`.
 */
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
 * What came of one offer at `acceptIncomingMessage`, read at `answeredAtMs` as soon as it was known: the kind the
 * entry accepted the offer as; `rejected` for a rejection; `threw` for an offer whose call threw, with the error's
 * name and its message, cut at 240 characters with anything URL-shaped removed; or `unanswered` for an offer still
 * pending when observation ended. An offer that threw says nothing of what the server did with the frame: it may
 * have admitted the send before it threw. An instance answers a recipient's ACK `control` once it has counted the ACK
 * in the receipt record the instances share, whichever instance admitted the send. Its `handled` flag says whether
 * the instance's own outbound owner took the control, is false for a recipient's ACK, and is not kept.
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
    | {
        readonly acceptance: 'threw';
        readonly answeredAtMs: number;
        readonly errorName: string;
        readonly errorMessage: string;
    }
    | { readonly acceptance: 'unanswered'; readonly answeredAtMs: null; };

export type OrderedSendCellSend = OrderedSendCellOffer & OrderedSendCellAnswer;

/**
 * One later offer of a send by its publisher: the frame of its first offer again, to the same entry of the same
 * instance. Only a run whose shape states the sender recovery `client-stand-in` makes one, for one of two causes:
 * `repair`, the server asked for the send by a gap NACK or a repair request its publisher read; `first-hop`, the
 * publisher read no receipt of the send, of any phase, within its first-hop wait. `sentAtMs` is read immediately
 * before the offer, and is never before the control frame or the end of the wait that caused it.
 */
export interface OrderedSendCellResendOffer {
    /** The send offered again; `sends` holds its first offer. */
    readonly msgId: string;
    readonly cause: 'repair' | 'first-hop';
    /** Which offer of the send for this cause it is, from 1: a repair has at most 4, a first-hop resend at most 3. */
    readonly attempt: number;
    readonly sentAtMs: number;
}

export type OrderedSendCellResend = OrderedSendCellResendOffer & OrderedSendCellAnswer;

/**
 * One ACK a recipient offered the instance its socket is on, for its first read of a copy. `sentAtMs` is read
 * immediately before the offer, one ACK offset after the read.
 */
export interface OrderedSendCellAckOffer {
    /** The send whose copy is acknowledged. */
    readonly msgId: string;
    readonly recipientPeerId: string;
    readonly sentAtMs: number;
}

export type OrderedSendCellAck = OrderedSendCellAckOffer & OrderedSendCellAnswer;

/**
 * The server wrote a copy of a send to a session's socket: one frame on the wire, recorded each time one is written,
 * at whichever session. An arrival is a wire copy, taken before the de-duplication and the ordered hold-back of a
 * client, which a session of the cell has not: a client drops a copy it has taken before and holds back one that is
 * ahead of its track, and here both are arrivals. So an arrival is no delivery to an application, and where a figure
 * of the report says a copy was "read", it was read off the socket the server wrote it to.
 *
 * An arrival at a session the send did not expect, its own publisher or a session outside its audience, is no copy
 * of any expected recipient: the report counts it in `unmatched.arrivalsAtUnexpectedRecipient` and in no delivery or
 * delay figure. The copy of a send on a topic the router has no definition of is a live notice, never a row of the
 * WS outbox: the instance that
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
 * A session's socket read a receipt of a send. Every instance counts the recipients' ACKs in one receipt record on
 * PostgreSQL, the instance a recipient's socket is on counting that recipient's. The `admitted` receipt is written
 * to the origin's socket by the instance that admitted the send, which is the origin's own, and is a row of the
 * shared WS outbox only when no socket there took it. The terminal receipt is a row of the shared WS outbox, written
 * by whichever instance ended the receipt in the record. The instance whose worker takes a row writes it to the
 * origin's socket when that socket is its own; otherwise it announces the row's key by a `ws-channel` NOTIFY for the
 * origin's instance to write, and announces it again until the row expires, so the origin may read one receipt more
 * than once.
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
 * Under the sender recovery `none` a session of the cell answers neither and sends nothing again; under
 * `client-stand-in` its publisher answers both as `OrderedSendClientStandIn` states: each send it offers again is in
 * `resends`, and each it declines to, for a send that has ended or expired, is in `declinedRepairs`.
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
 * A publisher's stand-in ended a send, as the product's WS client ends a message: from then on it offers the send
 * again for no cause. `cause` says what ended it:
 * - `first-hop-exhausted`: its first-hop resends are spent and its publisher has read no receipt of it;
 * - `terminal-receipt`: its publisher read a `complete` or a `timed-out` receipt of it;
 * - `terminal-nack`: its publisher read a NACK that refuses it for good;
 * - `repair-budget-spent`: a repair request asked for it again and found its repairs spent;
 * - `expired`: its lifetime ended before anything else ended it.
 * A send has at most one end. Only a run under the sender recovery `client-stand-in` records any.
 */
export interface OrderedSendCellSendEnd {
    readonly msgId: string;
    readonly cause: 'first-hop-exhausted' | 'terminal-receipt' | 'terminal-nack' | 'repair-budget-spent' | 'expired';
    /** The instant of the frame, the deadline's poll or the request that ended it. */
    readonly atMs: number;
}

/**
 * A publisher's stand-in did not offer a send again that a repair request asked for, because the product's WS client
 * would not have: `send-ended`, the send `msgId` was asked for and had ended; `send-expired`, it was asked for and its
 * lifetime was over; `named-send-expired`, the request named `msgId`, whose lifetime was over, so the request raised
 * no repair hint at all and nothing it asked for was looked at. The first two are one for each send and execution of
 * a request, the third one for each request. A re-offer leaves a turn of the event loop after its request was served:
 * a send that ended or expired in that turn is declined then, under the same two reasons, at the instant it would
 * have left.
 */
export interface OrderedSendCellDeclinedRepair {
    readonly msgId: string;
    readonly reason: 'send-ended' | 'send-expired' | 'named-send-expired';
    readonly atMs: number;
}

/**
 * What one run of the cell recorded. Every instant is an unrounded `performance.now()` reading of one clock. Every
 * list but `sends`, `resends` and `acks` is in the order observed, appended as it happened, and the report takes "first" and
 * "before" from that order, never from comparing instants. `sends`, `resends` and `acks` are each in the order
 * offered. Every frame a session's socket read is in exactly one of `arrivals`, `receipts`, `controls` and
 * `unclassifiedControls`. Every offer the run made at the entry, of a send, of a send again and of an ACK, is in
 * exactly one of `sends`, `resends` and `acks`, with what came of it.
 */
export interface OrderedSendCellObservations {
    readonly sends: readonly OrderedSendCellSend[];
    /** Empty in a run under the sender recovery `none`. */
    readonly resends: readonly OrderedSendCellResend[];
    readonly acks: readonly OrderedSendCellAck[];
    readonly arrivals: readonly OrderedSendCellArrival[];
    readonly handOffs: readonly OrderedSendCellHandOff[];
    readonly receipts: readonly OrderedSendCellReceipt[];
    readonly controls: readonly OrderedSendCellControl[];
    readonly unclassifiedControls: readonly OrderedSendCellUnclassifiedControl[];
    /** Empty in a run under the sender recovery `none`. */
    readonly sendEnds: readonly OrderedSendCellSendEnd[];
    /** Empty in a run under the sender recovery `none`. */
    readonly declinedRepairs: readonly OrderedSendCellDeclinedRepair[];
    /** The instant the run stopped observing: nothing that happened later is in any list. */
    readonly observationEndedAtMs: number;
}
