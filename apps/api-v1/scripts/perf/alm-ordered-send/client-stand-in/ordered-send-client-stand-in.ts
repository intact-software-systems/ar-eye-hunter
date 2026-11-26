import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPeerRepairControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { mayALOutboundControlEndSend } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import type { OrderedSendScheduledSend } from '../compute-ordered-send-schedule.ts';
import type {
    OrderedSendCellDeclinedRepair,
    OrderedSendCellReceipt,
    OrderedSendCellResendOffer,
    OrderedSendCellSendEnd
} from '../ordered-send-cell-observations.ts';
import { ORDERED_SEND_WS_CLIENT_QOS_PROVIDER } from '../to-ordered-send-message.ts';
import type { OrderedSendSocketRead } from '../to-ordered-send-socket-read.ts';
import {
    computeOrderedSendRepairReoffers,
    isOrderedSendExpired,
    resolveOrderedSendRepairDeclineReason,
    type OrderedSendRepairReoffer,
    type OrderedSendSentMessage
} from './compute-ordered-send-repair-reoffers.ts';
import {
    computeOrderedSendFirstHopTurn,
    createOrderedSendFirstHopWait,
    type OrderedSendFirstHopWait
} from './ordered-send-first-hop-wait.ts';
import { toOrderedSendRepairHint } from './to-ordered-send-repair-hint.ts';

export namespace OrderedSendClientStandIn {
    /** The first offer of a send by its publisher. */
    export interface FirstOffer {
        readonly send: OrderedSendScheduledSend;
        /** The envelope offered: the product's WS client plans the send's first-hop wait and its repairs from it. */
        readonly message: ALMessage;
        /** The JSON of the frame offered. A later offer of the send is this frame again, as it is from a client. */
        readonly frame: string;
        /** The instant the frame was offered at, on the clock every later instant given here is on. */
        readonly offeredAtMs: number;
    }

    /** One offer a publisher owes of a send it offered before. */
    export interface Reoffer {
        readonly send: OrderedSendScheduledSend;
        readonly frame: string;
        readonly cause: OrderedSendCellResendOffer['cause'];
        /** Which offer of the send for this cause it is, from 1. */
        readonly attempt: number;
    }

    /** The part of a repair request one execution left, which the publisher serves in a later one. */
    export interface RepairFollowUp {
        readonly publisherPeerId: string;
        /** The send the request named. */
        readonly namedMsgId: string;
        readonly hint: ALOutboundRepairHint;
    }

    export interface RepairAnswer {
        /** In the order to offer them. */
        readonly reoffers: readonly Reoffer[];
        readonly followUp: RepairFollowUp | undefined;
    }
}

const NO_REPAIR_ANSWER: OrderedSendClientStandIn.RepairAnswer = { reoffers: [], followUp: undefined };

/**
 * What the product's WS client does for a send beyond writing its frame once, for the publishers of a run: it stands
 * where a browser's `WsQueueBoxClientService` would, and decides with the product's own functions and limits.
 *
 * - Repair. A gap NACK or a repair request its publisher's socket read raises the product's repair hint
 *   (`toOrderedSendRepairHint`), and the hint is served as `computeOrderedSendRepairReoffers` states: the missing
 *   sequences of the track that the publisher has offered, 32 to an execution, once for each request number, with the
 *   repairs the product plans for the send (`repairTracking.maxAttempts`: 4 for this envelope). The run offers what
 *   an execution decided a turn of its event loop later, and asks then whether each send may still be offered
 *   (`confirmRepairReoffer`): one that ended or expired in that turn is declined.
 * - First hop. A send holds the wait the product plans for it (`firstHopTracking`: a 2 s timeout and 3 retries for
 *   this envelope) from its first offer, and is offered again at each deadline (`computeOrderedSendFirstHopTurn`). A
 *   receipt of the send its publisher read, in any phase, ends the wait, and so does a NACK that may end the send
 *   (`mayALOutboundControlEndSend`).
 * - The end of a send. A send ends, once, as `OrderedSendCellSendEnd` states: when its first-hop retries are spent
 *   with no receipt read, about 8 s after its offer; on a `complete` or a `timed-out` receipt its publisher read; on
 *   a NACK that may end the send, the own hop's `not-yet-in-sync` apart, which ends the wait alone; when a repair
 *   request finds its repairs spent; and when its lifetime is over. An ended or expired send is offered again for no
 *   cause, and a request that names an expired send raises no hint. Each end and each repair declined for one is
 *   recorded with its instant.
 *
 * Both limits come from `toWsQueueBoxClientDispatchPlan` over the send's own message, with the QoS provider the
 * message was planned with (`ORDERED_SEND_WS_CLIENT_QOS_PROVIDER`).
 *
 * Where it is coarser than the product. The product marks a message ended on a NACK only when the NACK is a relay's
 * refusal of the whole send or removes an open receipt (`toALOutboundControlMessageEnd`): an `expired` or a `stale`
 * NACK read before any receipt ends the wait and leaves the message to its lifetime, and here it ends the send. The
 * product takes a receipt for terminal when it is `timed-out` or confirms every recipient
 * (`isALOutboundTerminalReceipt`); here the phase the server states, `complete`, stands for the second. The product
 * holds one repair budget for each requester of a message; here a send has one, its server being the one requester.
 * `expired` is recorded for bookkeeping at the first poll past a send's lifetime: the product writes no end then.
 *
 * What it does not model: the client's outbound commits, their conflicts and its engine's timing, so a re-offer
 * leaves as soon as the run asks for it and an end takes effect at once; the client's `ack-timeout` schedule once the
 * server has answered; what a browser does after `resync-required` or `receipt-exhausted`, since a publisher here
 * goes on offering the next send of the same track; and the client's control validation beyond what
 * `toOrderedSendRepairHint` keeps. It holds everything in memory.
 */
export class OrderedSendClientStandIn {
    private readonly serverPeerId: string;
    private readonly offerByMsgId = new Map<string, OrderedSendClientStandIn.FirstOffer>();
    private readonly sentMessagesByPublisher = new Map<string, OrderedSendSentMessage[]>();
    private readonly firstHopWaitByMsgId = new Map<string, OrderedSendFirstHopWait>();
    private readonly servedAttemptIdentities = new Set<string>();
    private readonly sendEnds: OrderedSendCellSendEnd[] = [];
    private readonly declinedRepairs: OrderedSendCellDeclinedRepair[] = [];

    /** `serverPeerId` is the peer id the run's instances answer as: the client's own hop. */
    constructor(serverPeerId: string) {
        this.serverPeerId = serverPeerId;
    }

    recordFirstOffer(offer: OrderedSendClientStandIn.FirstOffer): void {
        const { send, message } = offer;
        const plan = this.planAsWsClient(message);
        const sentMessages = this.sentMessagesByPublisher.get(send.publisherPeerId) ?? [];
        this.sentMessagesByPublisher.set(send.publisherPeerId, sentMessages);
        this.offerByMsgId.set(send.msgId, offer);
        // The planner states the deadline of every message it plans; one without a deadline would hold no wait.
        const expiresAtEpochMs = plan.msg.constraints?.expiresAtMs;
        const expiresAtMs = expiresAtEpochMs === undefined
            ? undefined
            : offer.offeredAtMs + expiresAtEpochMs - message.id.ts;
        sentMessages.push({
            msgId: send.msgId,
            trackKey: toALOrderingTrackKey(message),
            seq: send.seq,
            maxRepairs: plan.repairTracking?.enabled && plan.repairTracking.algo !== 'none'
                ? plan.repairTracking.maxAttempts
                : undefined,
            repairAttempts: 0,
            expiresAtMs,
            ended: false
        });
        if (plan.firstHopTracking !== undefined && expiresAtMs !== undefined) {
            this.firstHopWaitByMsgId.set(
                send.msgId,
                createOrderedSendFirstHopWait({
                    msgId: send.msgId,
                    tracking: plan.firstHopTracking,
                    offeredAtMs: offer.offeredAtMs,
                    messageExpiresAtMs: expiresAtMs
                })
            );
        }
    }

    /**
     * Takes one frame a session's socket read, at the instant the read carries. A receipt of a send of the reader's
     * ends that send's first-hop wait, and a terminal one the send; a NACK that may end the send ends the wait, and
     * the send unless it is `not-yet-in-sync`; a gap NACK or a repair request is answered with the re-offers its
     * reader owes now.
     */
    acceptSocketRead(readerPeerId: string, read: OrderedSendSocketRead): OrderedSendClientStandIn.RepairAnswer {
        switch (read.kind) {
            case 'receipt':
                this.acceptReceipt(readerPeerId, read.receipt);
                return NO_REPAIR_ANSWER;
            case 'control':
                if (mayALOutboundControlEndSend(read.request) && this.isSendOf(readerPeerId, read.control.msgId)) {
                    this.firstHopWaitByMsgId.delete(read.control.msgId);
                    if (read.control.reason !== 'not-yet-in-sync') {
                        this.endSend(read.control.msgId, 'terminal-nack', read.control.atMs);
                    }
                }
                return this.answerRepairRequest(readerPeerId, read.request, read.control.atMs);
            case 'arrival':
            case 'unclassified-control':
                return NO_REPAIR_ANSWER;
        }
    }

    /**
     * One more execution of a repair request at `nowMs`: the next 32 of the sequences an earlier one left. A send it
     * asks for that has ended or expired is recorded as declined, and one whose repairs it finds spent is ended.
     */
    serveRepairFollowUp(
        followUp: OrderedSendClientStandIn.RepairFollowUp,
        nowMs: number
    ): OrderedSendClientStandIn.RepairAnswer {
        const repair = computeOrderedSendRepairReoffers({
            hint: followUp.hint,
            namedMsgId: followUp.namedMsgId,
            sentMessages: this.sentMessagesByPublisher.get(followUp.publisherPeerId) ?? [],
            servedAttemptIdentities: this.servedAttemptIdentities,
            nowMs
        });
        repair.declined.forEach((decline) => this.declinedRepairs.push({ ...decline, atMs: nowMs }));
        repair.budgetSpentMsgIds.forEach((msgId) => this.endSend(msgId, 'repair-budget-spent', nowMs));
        return {
            reoffers: repair.reoffers.flatMap((reoffer) => this.spendRepair(reoffer)),
            followUp: repair.followUpHint === undefined ? undefined : { ...followUp, hint: repair.followUpHint }
        };
    }

    /**
     * Whether a repair re-offer decided earlier is still owed at `nowMs`, the instant it is to leave at. The run
     * offers it a turn of its event loop after the request was served; a send whose lifetime ended, or that ended,
     * in that turn is not offered, and its repair is recorded as declined at `nowMs` with the reason a request served
     * then would give. The repair stays spent. A send its publisher never offered is not offered either.
     */
    confirmRepairReoffer(reoffer: OrderedSendClientStandIn.Reoffer, nowMs: number): boolean {
        const { msgId } = reoffer.send;
        const sent = this.getSentMessagesOf(msgId).find((held) => held.msgId === msgId);
        const declineReason = sent === undefined ? undefined : resolveOrderedSendRepairDeclineReason(sent, nowMs);
        if (declineReason !== undefined) {
            this.declinedRepairs.push({ msgId, reason: declineReason, atMs: nowMs });
        }
        return sent !== undefined && declineReason === undefined;
    }

    /**
     * The first-hop resends due at `nowMs`, each spent by this call: the next of a send is due a timeout later. A
     * wait that finds its retries spent ends its send as `first-hop-exhausted`.
     */
    takeFirstHopResendsDue(nowMs: number): readonly OrderedSendClientStandIn.Reoffer[] {
        const reoffers: OrderedSendClientStandIn.Reoffer[] = [];
        for (const [msgId, wait] of this.firstHopWaitByMsgId) {
            const turn = computeOrderedSendFirstHopTurn(wait, nowMs);
            switch (turn.kind) {
                case 'exhausted':
                    this.endSend(msgId, 'first-hop-exhausted', nowMs);
                    break;
                case 'expired':
                    this.endSend(msgId, 'expired', nowMs);
                    break;
                case 'waiting':
                    this.firstHopWaitByMsgId.set(msgId, turn.wait);
                    break;
                case 'resend':
                    this.firstHopWaitByMsgId.set(msgId, turn.wait);
                    reoffers.push(...this.toFirstHopReoffer(msgId, turn.wait.snapshot.attempts));
                    break;
            }
        }
        return reoffers;
    }

    /** Ends as `expired` every send whose lifetime is over at `nowMs` and that nothing ended before. */
    endExpiredSends(nowMs: number): void {
        for (const sentMessages of this.sentMessagesByPublisher.values()) {
            sentMessages
                .filter((sent) => !sent.ended && isOrderedSendExpired(sent, nowMs))
                .forEach((sent) => this.endSend(sent.msgId, 'expired', nowMs));
        }
    }

    /** Every send ended so far, in the order they ended. */
    getSendEnds(): readonly OrderedSendCellSendEnd[] {
        return this.sendEnds;
    }

    /** Every repair declined so far, in the order they were declined. */
    getDeclinedRepairs(): readonly OrderedSendCellDeclinedRepair[] {
        return this.declinedRepairs;
    }

    private planAsWsClient(message: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        return toWsQueueBoxClientDispatchPlan(message, {
            sessionId: message.id.senderId,
            serverPeerId: this.serverPeerId,
            socketOpen: true,
            nowMs: message.id.ts,
            backpressured: false,
            qosProvider: ORDERED_SEND_WS_CLIENT_QOS_PROVIDER
        });
    }

    private isSendOf(publisherPeerId: string, msgId: string): boolean {
        return this.offerByMsgId.get(msgId)?.send.publisherPeerId === publisherPeerId;
    }

    private acceptReceipt(readerPeerId: string, receipt: OrderedSendCellReceipt): void {
        if (!this.isSendOf(readerPeerId, receipt.msgId)) {
            return;
        }
        this.firstHopWaitByMsgId.delete(receipt.msgId);
        if (receipt.phase === 'complete' || receipt.phase === 'timed-out') {
            this.endSend(receipt.msgId, 'terminal-receipt', receipt.atMs);
        }
    }

    /** Ends a send that has not ended: its wait is dropped with it, and nothing is ever offered of it again. */
    private endSend(msgId: string, cause: OrderedSendCellSendEnd['cause'], atMs: number): void {
        const sentMessages = this.getSentMessagesOf(msgId);
        const sentIndex = sentMessages.findIndex((sent) => sent.msgId === msgId);
        if (sentIndex === -1 || sentMessages[sentIndex].ended) {
            return;
        }
        sentMessages[sentIndex] = { ...sentMessages[sentIndex], ended: true };
        this.firstHopWaitByMsgId.delete(msgId);
        this.sendEnds.push({ msgId, cause, atMs });
    }

    private answerRepairRequest(
        readerPeerId: string,
        control: ALPeerRepairControlMessage,
        nowMs: number
    ): OrderedSendClientStandIn.RepairAnswer {
        const raised = toOrderedSendRepairHint({
            control,
            readerPeerId,
            sentMessages: this.sentMessagesByPublisher.get(readerPeerId) ?? [],
            nowMs
        });
        const namedMsgId = control.payload.msgId;
        switch (raised.kind) {
            case 'none':
                return NO_REPAIR_ANSWER;
            case 'named-send-expired':
                this.declinedRepairs.push({ msgId: namedMsgId, reason: 'named-send-expired', atMs: nowMs });
                return NO_REPAIR_ANSWER;
            case 'raised':
                return this.serveRepairFollowUp(
                    { publisherPeerId: readerPeerId, namedMsgId, hint: raised.hint },
                    nowMs
                );
        }
    }

    private toFirstHopReoffer(msgId: string, attempt: number): readonly OrderedSendClientStandIn.Reoffer[] {
        const offer = this.offerByMsgId.get(msgId);
        return offer === undefined ? [] : [{ send: offer.send, frame: offer.frame, cause: 'first-hop', attempt }];
    }

    /** Marks the attempt served and the repair spent, and returns the offer it owes. */
    private spendRepair(reoffer: OrderedSendRepairReoffer): readonly OrderedSendClientStandIn.Reoffer[] {
        const sentMessages = this.getSentMessagesOf(reoffer.msgId);
        const sentIndex = sentMessages.findIndex((sent) => sent.msgId === reoffer.msgId);
        const offer = this.offerByMsgId.get(reoffer.msgId);
        if (sentIndex === -1 || offer === undefined) {
            return [];
        }
        this.servedAttemptIdentities.add(reoffer.attemptIdentity);
        sentMessages[sentIndex] = { ...sentMessages[sentIndex], repairAttempts: reoffer.attempt };
        return [{ send: offer.send, frame: offer.frame, cause: 'repair', attempt: reoffer.attempt }];
    }

    /** The sends of the publisher that offered `msgId`, as held; none when nobody offered it. */
    private getSentMessagesOf(msgId: string): OrderedSendSentMessage[] {
        const publisherPeerId = this.offerByMsgId.get(msgId)?.send.publisherPeerId;
        return (publisherPeerId === undefined ? undefined : this.sentMessagesByPublisher.get(publisherPeerId)) ?? [];
    }
}
