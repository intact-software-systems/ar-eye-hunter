import type { OrderedSendCellSend } from '../ordered-send-cell-observations.ts';
import {
    computeOrderedSendAnswerFigures,
    type OrderedSendAnswerFigures
} from './compute-ordered-send-answer-figures.ts';
import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';

/**
 * How the sends left their publishers and what came of their offers. Every count is over every send, and a send is
 * counted by its first offer and what came of that offer, whatever its publisher offered again.
 */
export interface OrderedSendSendFigures extends OrderedSendAnswerFigures {
    readonly attempted: number;
    /** Every send, from its due time to its offer at the entry. */
    readonly latenessMs: OrderedSendDelaySummary;
    /**
     * Every send the entry answered, from its offer to the answer. A send whose offer threw or was still pending when
     * observation ended has no answer: it is in `byAcceptance.threw` or `byAcceptance.unanswered`, and not here.
     */
    readonly offerToAnswerMs: OrderedSendDelaySummary;
}

export function computeOrderedSendSendFigures(sends: readonly OrderedSendCellSend[]): OrderedSendSendFigures {
    return {
        attempted: sends.length,
        ...computeOrderedSendAnswerFigures(sends),
        latenessMs: computeOrderedSendDelaySummary(sends.map((send) => send.sentAtMs - send.dueAtMs)),
        offerToAnswerMs: computeOrderedSendDelaySummary(
            sends.flatMap((send) =>
                send.acceptance === 'threw' || send.acceptance === 'unanswered'
                    ? []
                    : [send.answeredAtMs - send.sentAtMs]
            )
        )
    };
}
