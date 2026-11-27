import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { computeALSeqRangePage } from '@shared/al-contracts/al-seq-range.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    toALOutboundRepairGapAttemptIdentity,
    toALOutboundRepairHintEffectId
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';

import type { OrderedSendCellDeclinedRepair } from '../ordered-send-cell-observations.ts';

/** One send as its publisher's stand-in holds it, the way the product's client holds a message it sent. */
export interface OrderedSendSentMessage {
    readonly msgId: string;
    /** The track the product keys the send's place on, `toALOrderingTrackKey` of its envelope; undefined on none. */
    readonly trackKey: string | undefined;
    readonly seq: number;
    /** The repairs the product's client plans for the send; undefined when it plans no repair of it. */
    readonly maxRepairs: number | undefined;
    /** The repairs already spent on the send. */
    readonly repairAttempts: number;
    /** When the send's lifetime ends, on the clock of the instant a request is served at; undefined when it has no end. */
    readonly expiresAtMs: number | undefined;
    /** Whether its publisher has ended the send. */
    readonly ended: boolean;
}

/** A repair hint a publisher is to serve, and what the publisher holds as it serves it. */
export interface OrderedSendRepairHintRead {
    /** The hint as the product's client builds it from the server's control, or the follow-up of one. */
    readonly hint: ALOutboundRepairHint;
    /** The send the control named: the one whose arrival showed the gap, never a missing one. */
    readonly namedMsgId: string;
    /** Every send the publisher has offered. */
    readonly sentMessages: readonly OrderedSendSentMessage[];
    /** The attempt identities of every re-offer the publisher made before. */
    readonly servedAttemptIdentities: ReadonlySet<string>;
    /** The instant this execution of the hint is served at. */
    readonly nowMs: number;
}

export interface OrderedSendRepairReoffer {
    readonly msgId: string;
    /** The product's name of the attempt: a re-offer is made once under it. */
    readonly attemptIdentity: string;
    /** Which repair of the send this is, from 1. */
    readonly attempt: number;
}

/** A send the hint asked for that its publisher does not offer again, and why. */
export interface OrderedSendRepairDecline {
    readonly msgId: string;
    readonly reason: Extract<OrderedSendCellDeclinedRepair['reason'], 'send-ended' | 'send-expired'>;
}

export interface OrderedSendRepairReoffers {
    /** In the order to offer them. */
    readonly reoffers: readonly OrderedSendRepairReoffer[];
    /** The sends the hint asked for that had ended or expired, in the order asked. */
    readonly declined: readonly OrderedSendRepairDecline[];
    /** The sends the hint asked for whose repairs it found spent: their publisher ends each. */
    readonly budgetSpentMsgIds: readonly string[];
    /** The hint of the ranges this execution left, which a later one serves; undefined when it left none. */
    readonly followUpHint: ALOutboundRepairHint | undefined;
}

/** A send one execution of a hint may re-offer; `sent` is undefined when its publisher offered no such send. */
interface OrderedSendRepairCandidate {
    readonly sent: OrderedSendSentMessage | undefined;
    readonly attemptIdentity: string;
}

interface OrderedSendRepairCandidates {
    readonly candidates: readonly OrderedSendRepairCandidate[];
    readonly followUpHint: ALOutboundRepairHint | undefined;
}

/** What the publisher does about one send a hint asked for. */
type OrderedSendRepairDecision =
    | { readonly kind: 'reoffer'; readonly reoffer: OrderedSendRepairReoffer; }
    | { readonly kind: 'declined'; readonly decline: OrderedSendRepairDecline; }
    | { readonly kind: 'budget-spent'; readonly msgId: string; }
    | { readonly kind: 'nothing'; };

/**
 * What one execution of a repair hint re-offers, decided as the product's WS client decides it
 * (`ALOutboundRepairRetransmission.retransmitFromRepairHint`), with the product's own page, limits and attempt names:
 * - a hint that names ranges of a track serves the first `AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages` (32) of its
 *   missing sequences, ascending, each the send the publisher offered at that place of that track, and leaves the
 *   rest of its ranges as one follow-up hint;
 * - a hint that names no range, or no track, serves the send the control named;
 * - a send the client plans no repair of is passed over (`repairByMsgId` returns before any dispatch);
 * - a send whose lifetime is over is not re-offered, and neither is one that has ended, in that order
 *   (`toEarlyDispatchResult` answers a repair dispatch `expired`, then `skipped` as `message-ended`);
 * - a re-offer is made once under its attempt identity, which for a sequence names the requester, the track, the
 *   sequence and the request's number: the same gap reported again re-offers nothing, and its renewal, one number
 *   higher, re-offers again;
 * - a send has `maxRepairs` repairs to spend. A new attempt that finds them spent re-offers nothing and its commit
 *   ends the message (`computeALOutboundRepairAttemptCharge`: `attempts >= maxAttempts` is exhausted;
 *   `toRepairExhaustedResult`).
 */
export function computeOrderedSendRepairReoffers(read: OrderedSendRepairHintRead): OrderedSendRepairReoffers {
    const { candidates, followUpHint } = toRepairCandidates(read);
    const decisions = candidates.map((candidate) => computeRepairDecision(candidate, read));
    return {
        reoffers: decisions.flatMap((decision) => decision.kind === 'reoffer' ? [decision.reoffer] : []),
        declined: decisions.flatMap((decision) => decision.kind === 'declined' ? [decision.decline] : []),
        budgetSpentMsgIds: decisions.flatMap((decision) => decision.kind === 'budget-spent' ? [decision.msgId] : []),
        followUpHint
    };
}

/** A send's lifetime is over from the instant it states: the product reads `expiresAtMs <= nowMs` as expired. */
export function isOrderedSendExpired(sent: OrderedSendSentMessage, nowMs: number): boolean {
    return sent.expiresAtMs !== undefined && sent.expiresAtMs <= nowMs;
}

/**
 * Why a publisher does not offer a send again for a repair at `nowMs`, or undefined when it may: the send's lifetime
 * is over, or the send has ended, read in that order as the product reads them.
 */
export function resolveOrderedSendRepairDeclineReason(
    sent: OrderedSendSentMessage,
    nowMs: number
): OrderedSendRepairDecline['reason'] | undefined {
    if (isOrderedSendExpired(sent, nowMs)) {
        return 'send-expired';
    }
    return sent.ended ? 'send-ended' : undefined;
}

function computeRepairDecision(
    candidate: OrderedSendRepairCandidate,
    read: OrderedSendRepairHintRead
): OrderedSendRepairDecision {
    const { sent, attemptIdentity } = candidate;
    if (sent === undefined || sent.maxRepairs === undefined) {
        return { kind: 'nothing' };
    }
    const declineReason = resolveOrderedSendRepairDeclineReason(sent, read.nowMs);
    if (declineReason !== undefined) {
        return { kind: 'declined', decline: { msgId: sent.msgId, reason: declineReason } };
    }
    if (read.servedAttemptIdentities.has(attemptIdentity)) {
        return { kind: 'nothing' };
    }
    return sent.repairAttempts >= sent.maxRepairs
        ? { kind: 'budget-spent', msgId: sent.msgId }
        : { kind: 'reoffer', reoffer: { msgId: sent.msgId, attemptIdentity, attempt: sent.repairAttempts + 1 } };
}

function toRepairCandidates(read: OrderedSendRepairHintRead): OrderedSendRepairCandidates {
    const { hint, namedMsgId, sentMessages } = read;
    const trackKey = hint.orderingTrackKey;
    if (trackKey === undefined || hint.missingRanges.length === 0) {
        return {
            candidates: [{
                sent: sentMessages.find((sent) => sent.msgId === namedMsgId),
                attemptIdentity: toALOutboundRepairHintEffectId(namedMsgId, hint)
            }],
            followUpHint: undefined
        };
    }
    const { page, remaining } = computeALSeqRangePage(
        hint.missingRanges,
        AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages
    );
    return {
        candidates: page.map((seq) => ({
            sent: sentMessages.find((sent) => sent.trackKey === trackKey && sent.seq === seq),
            attemptIdentity: toALOutboundRepairGapAttemptIdentity(hint, trackKey, seq)
        })),
        followUpHint: remaining.length === 0 ? undefined : { ...hint, missingRanges: remaining }
    };
}
