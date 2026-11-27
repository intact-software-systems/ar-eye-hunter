import type { RoomSendOrdering } from '../room-send-ordering.ts';
import {
    computeRoomSendBeforeFirstControlFigures,
    type RoomSendBeforeFirstControlFigures
} from './compute-room-send-before-first-control-figures.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';
import { toRoomSendCopiesInOfferOrder, type RoomSendOfferedCopy } from './to-room-send-copies-in-offer-order.ts';

/**
 * The figures that need a track: a publisher's sends on the room's ordering key, each at its seq. They are stated
 * for a run whose sends name that key, and are `not-applicable` for a run of unordered sends, never zeros: an
 * unordered send has no predecessor to wait for, and a control about one says nothing of its publisher's other
 * sends. A copy written out of the order offered and a copy never written are counted for every send, by the
 * delivery figures.
 */
export type RoomSendTrackFigures =
    | {
        readonly kind: 'ordering-key';
        /**
         * Copies written to a socket that was never written a lower seq of the same publisher its session expected.
         * It is the order on the wire: a client holds such a copy back until its predecessor comes.
         */
        readonly copiesReadPastAnUnreadPredecessor: number;
        readonly beforeFirstControl: RoomSendBeforeFirstControlFigures;
    }
    | { readonly kind: 'not-applicable'; };

export function computeRoomSendTrackFigures(
    ordering: RoomSendOrdering,
    observedSends: readonly ObservedRoomSend[]
): RoomSendTrackFigures {
    switch (ordering) {
        case 'unordered':
            return { kind: 'not-applicable' };
        case 'ordering-key':
            return {
                kind: 'ordering-key',
                copiesReadPastAnUnreadPredecessor: toRoomSendCopiesInOfferOrder(observedSends)
                    .reduce((total, track) => total + computeReadsPastAnUnreadCopy(track), 0),
                beforeFirstControl: computeRoomSendBeforeFirstControlFigures(observedSends)
            };
    }
}

/** Of one recipient's copies of one track, in ascending seq: those read above the lowest seq never read. */
function computeReadsPastAnUnreadCopy(track: readonly RoomSendOfferedCopy[]): number {
    const lowestUnread = track.findIndex((copy) => copy.firstReadPosition === undefined);
    return lowestUnread === -1
        ? 0
        : track.slice(lowestUnread).filter((copy) => copy.firstReadPosition !== undefined).length;
}
