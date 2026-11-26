import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { computeALSeqRangePage } from '@shared/al-contracts/al-seq-range.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    toALOutboundRepairGapAttemptIdentity,
    toALOutboundRepairHintEffectId
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';

/** One send as its publisher's stand-in holds it, the way the product's client holds a message it sent. */
export interface OrderedSendSentMessage {
    readonly msgId: string;
    /** The track the product keys the send's place on, `toALOrderingTrackKey` of its envelope; undefined on none. */
    readonly trackKey: string | undefined;
    readonly seq: number;
    /** The repairs the product's client plans for the send; 0 when it plans none. */
    readonly maxRepairs: number;
    /** The repairs already spent on the send. */
    readonly repairAttempts: number;
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
}

export interface OrderedSendRepairReoffer {
    readonly msgId: string;
    /** The product's name of the attempt: a re-offer is made once under it. */
    readonly attemptIdentity: string;
    /** Which repair of the send this is, from 1. */
    readonly attempt: number;
}

export interface OrderedSendRepairReoffers {
    /** In the order to offer them. */
    readonly reoffers: readonly OrderedSendRepairReoffer[];
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

/**
 * What one execution of a repair hint re-offers, decided as the product's WS client decides it
 * (`ALOutboundRepairRetransmission.retransmitFromRepairHint`), with the product's own page, limits and attempt names:
 * - a hint that names ranges of a track serves the first `AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages` (32) of its
 *   missing sequences, ascending, each the send the publisher offered at that place of that track, and leaves the
 *   rest of its ranges as one follow-up hint;
 * - a hint that names no range, or no track, serves the send the control named;
 * - a re-offer is made once under its attempt identity, which for a sequence names the requester, the track, the
 *   sequence and the request's number: the same gap reported again re-offers nothing, and its renewal, one number
 *   higher, re-offers again;
 * - a send has `maxRepairs` repairs to spend
 *   (`computeALOutboundRepairAttemptCharge`: `attempts >= maxAttempts` is exhausted), and one planned without repair
 *   is never re-offered.
 *
 * The product ends a message whose budget a request finds spent; here that send is only re-offered no more.
 */
export function computeOrderedSendRepairReoffers(read: OrderedSendRepairHintRead): OrderedSendRepairReoffers {
    const { candidates, followUpHint } = toRepairCandidates(read);
    return {
        reoffers: candidates.flatMap(({ sent, attemptIdentity }) =>
            sent === undefined || read.servedAttemptIdentities.has(attemptIdentity) ||
                sent.repairAttempts >= sent.maxRepairs
                ? []
                : [{ msgId: sent.msgId, attemptIdentity, attempt: sent.repairAttempts + 1 }]
        ),
        followUpHint
    };
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
