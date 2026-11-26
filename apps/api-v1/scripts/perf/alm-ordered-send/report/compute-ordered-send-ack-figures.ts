import {
    computeOrderedSendAnswerFigures,
    type OrderedSendAnswerFigures
} from './compute-ordered-send-answer-figures.ts';
import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * What came of the ACKs the recipients offered, over the ACKs of a send the cell knows; one of an unknown send is in
 * `unmatched`. An instance answers an ACK `control`: handled when it holds the send and counted the ACK itself, not
 * handled when it relayed the ACK to the other instances. An ACK the entry rejected, or whose offer threw, was not
 * counted towards its send's receipt.
 */
export interface OrderedSendAckFigures extends OrderedSendAnswerFigures {
    readonly offered: number;
}

export function computeOrderedSendAckFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendAckFigures {
    const acks = observedSends.flatMap((observed) => observed.acks);
    return { offered: acks.length, ...computeOrderedSendAnswerFigures(acks) };
}
