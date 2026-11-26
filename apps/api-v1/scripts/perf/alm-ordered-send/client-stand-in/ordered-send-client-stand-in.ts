import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPeerRepairControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { mayALOutboundControlEndSend } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import type { OrderedSendScheduledSend } from '../compute-ordered-send-schedule.ts';
import type { OrderedSendCellResendOffer } from '../ordered-send-cell-observations.ts';
import { ORDERED_SEND_WS_CLIENT_QOS_PROVIDER } from '../to-ordered-send-message.ts';
import type { OrderedSendSocketRead } from '../to-ordered-send-socket-read.ts';
import {
    computeOrderedSendRepairReoffers,
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
 *   repairs the product plans for the send (`repairTracking.maxAttempts`: 4 for this envelope).
 * - First hop. A send holds the wait the product plans for it (`firstHopTracking`: a 2 s timeout and 3 retries for
 *   this envelope) from its first offer, and is offered again at each deadline (`computeOrderedSendFirstHopTurn`). A
 *   receipt of the send its publisher read, in any phase, ends the wait, and so does a NACK that may end the send
 *   (`mayALOutboundControlEndSend`).
 *
 * Both limits come from `toWsQueueBoxClientDispatchPlan` over the send's own message, with the QoS provider the
 * message was planned with (`ORDERED_SEND_WS_CLIENT_QOS_PROVIDER`).
 *
 * What it does not model: the client's outbound commits, their conflicts and its engine's timing, so a re-offer
 * leaves as soon as the run asks for it; the client's `ack-timeout` schedule once the server has answered; the end
 * of a message whose first-hop retries or repairs are spent, which here is only offered no more; and the client's
 * control validation beyond what `toOrderedSendRepairHint` keeps. It holds everything in memory.
 */
export class OrderedSendClientStandIn {
    private readonly serverPeerId: string;
    private readonly offerByMsgId = new Map<string, OrderedSendClientStandIn.FirstOffer>();
    private readonly sentMessagesByPublisher = new Map<string, OrderedSendSentMessage[]>();
    private readonly firstHopWaitByMsgId = new Map<string, OrderedSendFirstHopWait>();
    private readonly servedAttemptIdentities = new Set<string>();

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
        sentMessages.push({
            msgId: send.msgId,
            trackKey: toALOrderingTrackKey(message),
            seq: send.seq,
            maxRepairs: plan.repairTracking?.enabled && plan.repairTracking.algo !== 'none'
                ? plan.repairTracking.maxAttempts
                : 0,
            repairAttempts: 0
        });
        // The planner states the deadline of every message it plans; one without a deadline would hold no wait.
        const expiresAtEpochMs = plan.msg.constraints?.expiresAtMs;
        if (plan.firstHopTracking !== undefined && expiresAtEpochMs !== undefined) {
            this.firstHopWaitByMsgId.set(
                send.msgId,
                createOrderedSendFirstHopWait({
                    msgId: send.msgId,
                    tracking: plan.firstHopTracking,
                    offeredAtMs: offer.offeredAtMs,
                    messageExpiresAtMs: offer.offeredAtMs + expiresAtEpochMs - message.id.ts
                })
            );
        }
    }

    /**
     * Takes one frame a session's socket read: a receipt or an ending NACK of a send of the reader's ends that send's
     * first-hop wait, and a gap NACK or a repair request is answered with the re-offers its reader owes now.
     */
    acceptSocketRead(readerPeerId: string, read: OrderedSendSocketRead): OrderedSendClientStandIn.RepairAnswer {
        switch (read.kind) {
            case 'receipt':
                this.endFirstHopWait(readerPeerId, read.receipt.msgId);
                return NO_REPAIR_ANSWER;
            case 'control':
                if (mayALOutboundControlEndSend(read.request)) {
                    this.endFirstHopWait(readerPeerId, read.control.msgId);
                }
                return this.answerRepairRequest(readerPeerId, read.request);
            case 'arrival':
            case 'unclassified-control':
                return NO_REPAIR_ANSWER;
        }
    }

    /** One more execution of a repair request: the next 32 of the sequences an earlier one left. */
    serveRepairFollowUp(followUp: OrderedSendClientStandIn.RepairFollowUp): OrderedSendClientStandIn.RepairAnswer {
        const sentMessages = this.sentMessagesByPublisher.get(followUp.publisherPeerId) ?? [];
        const repair = computeOrderedSendRepairReoffers({
            hint: followUp.hint,
            namedMsgId: followUp.namedMsgId,
            sentMessages,
            servedAttemptIdentities: this.servedAttemptIdentities
        });
        return {
            reoffers: repair.reoffers.flatMap((reoffer) => this.spendRepair(sentMessages, reoffer)),
            followUp: repair.followUpHint === undefined ? undefined : { ...followUp, hint: repair.followUpHint }
        };
    }

    /** The first-hop resends due at `nowMs`, each spent by this call: the next of a send is due a timeout later. */
    takeFirstHopResendsDue(nowMs: number): readonly OrderedSendClientStandIn.Reoffer[] {
        const reoffers: OrderedSendClientStandIn.Reoffer[] = [];
        for (const [msgId, wait] of this.firstHopWaitByMsgId) {
            const turn = computeOrderedSendFirstHopTurn(wait, nowMs);
            const offer = this.offerByMsgId.get(msgId);
            if (turn.kind === 'ended' || offer === undefined) {
                this.firstHopWaitByMsgId.delete(msgId);
                continue;
            }
            this.firstHopWaitByMsgId.set(msgId, turn.wait);
            if (turn.kind === 'resend') {
                reoffers.push({
                    send: offer.send,
                    frame: offer.frame,
                    cause: 'first-hop',
                    attempt: turn.wait.snapshot.attempts
                });
            }
        }
        return reoffers;
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

    private endFirstHopWait(readerPeerId: string, msgId: string): void {
        if (this.offerByMsgId.get(msgId)?.send.publisherPeerId === readerPeerId) {
            this.firstHopWaitByMsgId.delete(msgId);
        }
    }

    private answerRepairRequest(
        readerPeerId: string,
        control: ALPeerRepairControlMessage
    ): OrderedSendClientStandIn.RepairAnswer {
        const hint = toOrderedSendRepairHint({
            control,
            readerPeerId,
            sentMessages: this.sentMessagesByPublisher.get(readerPeerId) ?? []
        });
        return hint === undefined
            ? NO_REPAIR_ANSWER
            : this.serveRepairFollowUp({ publisherPeerId: readerPeerId, namedMsgId: control.payload.msgId, hint });
    }

    /** Marks the attempt served and the repair spent, and returns the offer it owes. */
    private spendRepair(
        sentMessages: OrderedSendSentMessage[],
        reoffer: OrderedSendRepairReoffer
    ): readonly OrderedSendClientStandIn.Reoffer[] {
        const sentIndex = sentMessages.findIndex((sent) => sent.msgId === reoffer.msgId);
        const offer = this.offerByMsgId.get(reoffer.msgId);
        if (sentIndex === -1 || offer === undefined) {
            return [];
        }
        this.servedAttemptIdentities.add(reoffer.attemptIdentity);
        sentMessages[sentIndex] = { ...sentMessages[sentIndex], repairAttempts: reoffer.attempt };
        return [{ send: offer.send, frame: offer.frame, cause: 'repair', attempt: reoffer.attempt }];
    }
}
