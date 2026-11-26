import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';

import { computeOrderedSendCountByKey } from './compute-ordered-send-count-by-key.ts';
import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';
import type { OrderedSendCellSend } from './ordered-send-cell-observations.ts';

/**
 * How the sends left their publishers and how the entry answered them. Every count is over every send, and a send is
 * counted by its first offer and that offer's answer, whatever its publisher offered again.
 */
export interface OrderedSendSendFigures {
    readonly attempted: number;
    readonly byAcceptance: Readonly<Record<OrderedSendCellSend['acceptance'], number>>;
    /** The `rejected` sends, by the code of their rejection. */
    readonly rejectedByCode: Readonly<Record<ALMessageRejection['code'], number>>;
    /** The `not-admitted` sends, by the reason the entry gave; a reason no send was refused for has no key. */
    readonly notAdmittedByReason: Readonly<Record<string, number>>;
    /** Every send, from its due time to its offer at the entry. */
    readonly latenessMs: OrderedSendDelaySummary;
    /** Every answered send, from its offer to the entry's answer; the others are `byAcceptance.unanswered`. */
    readonly offerToAnswerMs: OrderedSendDelaySummary;
}

/** Every answer an offer can have, each at 0: an answer added to the contract has no key here, and fails to compile. */
export const NO_ORDERED_SEND_OFFERS_BY_ACCEPTANCE: OrderedSendSendFigures['byAcceptance'] = {
    admitted: 0,
    duplicate: 0,
    'resync-required': 0,
    disposed: 0,
    'pending-admission': 0,
    'not-admitted': 0,
    control: 0,
    rejected: 0,
    unanswered: 0
};

const NO_SENDS_BY_REJECTION_CODE: OrderedSendSendFigures['rejectedByCode'] = {
    malformed: 0,
    oversized: 0,
    unauthorized: 0,
    unsupported: 0
};

export function computeOrderedSendSendFigures(sends: readonly OrderedSendCellSend[]): OrderedSendSendFigures {
    return {
        attempted: sends.length,
        byAcceptance: computeOrderedSendCountByKey(
            sends.map((send) => send.acceptance),
            NO_ORDERED_SEND_OFFERS_BY_ACCEPTANCE
        ),
        rejectedByCode: computeOrderedSendCountByKey(
            sends.flatMap((send) => send.acceptance === 'rejected' ? [send.rejectionCode] : []),
            NO_SENDS_BY_REJECTION_CODE
        ),
        notAdmittedByReason: computeOrderedSendCountByKey(
            sends.flatMap((send) => send.acceptance === 'not-admitted' ? [send.notAdmittedReason] : []),
            {}
        ),
        latenessMs: computeOrderedSendDelaySummary(sends.map((send) => send.sentAtMs - send.dueAtMs)),
        offerToAnswerMs: computeOrderedSendDelaySummary(
            sends.flatMap((send) => send.answeredAtMs === null ? [] : [send.answeredAtMs - send.sentAtMs])
        )
    };
}
