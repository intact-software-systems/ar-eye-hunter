import {
    computeRoomSendAnswerFigures,
    type RoomSendAnswerFigures
} from './compute-room-send-answer-figures.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * What came of the ACKs the recipients offered, over the ACKs of a send the cell knows; one of an unknown send is in
 * `unmatched`. An instance answers an ACK `control` once it has counted the ACK in the receipt record the instances
 * share, whichever instance admitted the send. An ACK the entry rejected, or whose offer threw, was not counted
 * towards its send's receipt.
 */
export interface RoomSendAckFigures extends RoomSendAnswerFigures {
    readonly offered: number;
}

export function computeRoomSendAckFigures(observedSends: readonly ObservedRoomSend[]): RoomSendAckFigures {
    const acks = observedSends.flatMap((observed) => observed.acks);
    return { offered: acks.length, ...computeRoomSendAnswerFigures(acks) };
}
