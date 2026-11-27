import type { RoomSendCellObservations } from '../room-send-cell-observations.ts';
import { computeRoomSendAckFigures, type RoomSendAckFigures } from './compute-room-send-ack-figures.ts';
import {
    computeRoomSendControlFigures,
    type RoomSendControlFigures
} from './compute-room-send-control-figures.ts';
import {
    computeRoomSendDeliveryFigures,
    type RoomSendDeliveryFigures
} from './compute-room-send-delivery-figures.ts';
import {
    computeRoomSendReceiptFigures,
    type RoomSendReceiptFigures
} from './compute-room-send-receipt-figures.ts';
import {
    computeRoomSendRecipientDelayFigures,
    type RoomSendRecipientDelayFigures
} from './compute-room-send-recipient-delay-figures.ts';
import {
    computeRoomSendResendFigures,
    type RoomSendResendFigures
} from './compute-room-send-resend-figures.ts';
import {
    computeRoomSendSendFigures,
    type RoomSendSendFigures
} from './compute-room-send-send-figures.ts';
import {
    computeRoomSendStandInFigures,
    type RoomSendStandInFigures
} from './compute-room-send-stand-in-figures.ts';
import { computeRoomSendTrackFigures, type RoomSendTrackFigures } from './compute-room-send-track-figures.ts';
import {
    computeRoomSendUnmatchedFigures,
    type RoomSendUnmatchedFigures
} from './compute-room-send-unmatched-figures.ts';
import { toObservedRoomSends } from './to-observed-room-sends.ts';

/**
 * Every figure of one run of the cell. A send is the first in the list to carry its msgId, and what the cell recorded
 * beside the sends it knows is counted in `unmatched`, never dropped. Every group but `tracks` holds for a run
 * whatever the ordering of its sends; `tracks` states its figures for sends that name an ordering key alone.
 */
export interface RoomSendReport {
    readonly sends: RoomSendSendFigures;
    readonly delivery: RoomSendDeliveryFigures;
    readonly recipientDelays: RoomSendRecipientDelayFigures;
    readonly receipts: RoomSendReceiptFigures;
    readonly controls: RoomSendControlFigures;
    readonly tracks: RoomSendTrackFigures;
    readonly resends: RoomSendResendFigures;
    readonly acks: RoomSendAckFigures;
    readonly standIn: RoomSendStandInFigures;
    readonly unmatched: RoomSendUnmatchedFigures;
}

export function computeRoomSendReport(observations: RoomSendCellObservations): RoomSendReport {
    const observedSends = toObservedRoomSends(observations);
    return {
        sends: computeRoomSendSendFigures(observedSends.map(({ send }) => send)),
        delivery: computeRoomSendDeliveryFigures(observedSends),
        recipientDelays: computeRoomSendRecipientDelayFigures(observedSends),
        receipts: computeRoomSendReceiptFigures(observedSends),
        controls: computeRoomSendControlFigures(observedSends),
        tracks: computeRoomSendTrackFigures(observations.ordering, observedSends),
        resends: computeRoomSendResendFigures(observedSends),
        acks: computeRoomSendAckFigures(observedSends),
        standIn: computeRoomSendStandInFigures(observedSends),
        unmatched: computeRoomSendUnmatchedFigures(observations)
    };
}
