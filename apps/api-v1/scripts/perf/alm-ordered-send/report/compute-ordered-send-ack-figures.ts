import {
    computeOrderedSendAnswerFigures,
    type OrderedSendAnswerFigures
} from './compute-ordered-send-answer-figures.ts';
import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * What came of the ACKs the recipients offered, over the ACKs of a send the cell knows; one of an unknown send is in
 * `unmatched`. An instance answers an ACK `control` whether it counted the ACK for a receipt it holds or relayed it
 * to the other instances; the answer does not say which. An ACK the entry rejected, or whose offer threw, was not
 * counted towards its send's receipt.
 */
export interface OrderedSendAckFigures extends OrderedSendAnswerFigures {
    readonly offered: number;
}

export function computeOrderedSendAckFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendAckFigures {
    const acks = observedSends.flatMap((observed) => observed.acks);
    return { offered: acks.length, ...computeOrderedSendAnswerFigures(acks) };
}
