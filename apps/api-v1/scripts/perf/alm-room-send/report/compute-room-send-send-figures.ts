import type { RoomSendCellSend } from '../room-send-cell-observations.ts';
import {
    computeRoomSendAnswerFigures,
    type RoomSendAnswerFigures
} from './compute-room-send-answer-figures.ts';
import { computeRoomSendDelaySummary, type RoomSendDelaySummary } from './compute-room-send-delay-summary.ts';

/**
 * How the sends left their publishers and what came of their offers. Every count is over every send, and a send is
 * counted by its first offer and what came of that offer, whatever its publisher offered again.
 */
export interface RoomSendSendFigures extends RoomSendAnswerFigures {
    readonly attempted: number;
    /** Every send, from its due time to its offer at the entry. */
    readonly latenessMs: RoomSendDelaySummary;
    /**
     * Every send the entry answered, from its offer to the answer. A send whose offer threw or was still pending when
     * observation ended has no answer: it is in `byAcceptance.threw` or `byAcceptance.unanswered`, and not here.
     */
    readonly offerToAnswerMs: RoomSendDelaySummary;
}

export function computeRoomSendSendFigures(sends: readonly RoomSendCellSend[]): RoomSendSendFigures {
    return {
        attempted: sends.length,
        ...computeRoomSendAnswerFigures(sends),
        latenessMs: computeRoomSendDelaySummary(sends.map((send) => send.sentAtMs - send.dueAtMs)),
        offerToAnswerMs: computeRoomSendDelaySummary(
            sends.flatMap((send) =>
                send.acceptance === 'threw' || send.acceptance === 'unanswered'
                    ? []
                    : [send.answeredAtMs - send.sentAtMs]
            )
        )
    };
}
