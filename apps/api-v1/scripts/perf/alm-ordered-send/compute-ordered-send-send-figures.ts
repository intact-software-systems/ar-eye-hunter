import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';

import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';
import type { OrderedSendCellSend } from './ordered-send-cell-observations.ts';

/** How the sends left their publishers and how the entry answered them. Every count is over every send. */
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

const NO_SENDS_BY_ACCEPTANCE: OrderedSendSendFigures['byAcceptance'] = {
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
        byAcceptance: computeCountByKey(sends.map((send) => send.acceptance), NO_SENDS_BY_ACCEPTANCE),
        rejectedByCode: computeCountByKey(
            sends.flatMap((send) => send.acceptance === 'rejected' ? [send.rejectionCode] : []),
            NO_SENDS_BY_REJECTION_CODE
        ),
        notAdmittedByReason: computeCountByKey(
            sends.flatMap((send) => send.acceptance === 'not-admitted' ? [send.notAdmittedReason] : []),
            {}
        ),
        latenessMs: computeOrderedSendDelaySummary(sends.map((send) => send.sentAtMs - send.dueAtMs)),
        offerToAnswerMs: computeOrderedSendDelaySummary(
            sends.flatMap((send) => send.answeredAtMs === null ? [] : [send.answeredAtMs - send.sentAtMs])
        )
    };
}

function computeCountByKey<Key extends string>(
    keys: readonly Key[],
    countOfNoKeys: Readonly<Record<Key, number>>
): Readonly<Record<Key, number>> {
    return keys.reduce<Readonly<Record<Key, number>>>(
        (counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }),
        countOfNoKeys
    );
}
