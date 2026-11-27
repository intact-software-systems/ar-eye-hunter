import { computeRoomSendDeliveryFigures } from './compute-room-send-delivery-figures.ts';
import {
    computeRoomSendRecipientDelayFigures,
    type RoomSendExpectedCopyDelayFigures
} from './compute-room-send-recipient-delay-figures.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * The server by itself: the delivery of the sends each track offered before the server first asked the track's
 * publisher for anything. A track is one publisher's sends on the room's ordering key, so the view is of a run whose
 * sends name that key: `computeRoomSendTrackFigures` states it for no other. A send is in the view when its first
 * offer was read before the instant its publisher read the first NACK or repair request that names a send of the
 * track; a track that drew no such control has every send in it. The two instants are readings of one clock, compared
 * as such: a send and a control are in different lists, so their order is in neither.
 *
 * It is what to compare between a run under the sender recovery `none` and one under `client-stand-in`, and between
 * delays: up to its first control a track has had nothing but the server working for it, so no publisher's answer
 * can have changed when its sends were offered. It is not untouched by recovery altogether: a send in the view may
 * still be written to its recipients only after, and because of, a re-offer its publisher made later.
 */
export interface RoomSendBeforeFirstControlFigures {
    /** Tracks whose publisher read at least one NACK or repair request that names a send of the track. */
    readonly tracksWithAControl: number;
    /** The sends in the view. */
    readonly sends: number;
    /** One for each expected recipient of each send in the view. */
    readonly copiesExpected: number;
    /** Of those, the copies the server wrote to their recipient's socket at least once. */
    readonly copiesRead: number;
    /** From each send's due time to the first write of each of those copies, a copy never written ranking last. */
    readonly dueToFirstReadOverExpectedCopiesMs: RoomSendExpectedCopyDelayFigures;
}

export function computeRoomSendBeforeFirstControlFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendBeforeFirstControlFigures {
    const firstControlAtMsByTrack = toFirstControlAtMsByTrack(observedSends);
    const sendsBeforeFirstControl = observedSends.filter(({ send }) => {
        const firstControlAtMs = firstControlAtMsByTrack.get(send.publisherPeerId);
        return firstControlAtMs === undefined || send.sentAtMs < firstControlAtMs;
    });
    const delivery = computeRoomSendDeliveryFigures(sendsBeforeFirstControl);
    return {
        tracksWithAControl: firstControlAtMsByTrack.size,
        sends: sendsBeforeFirstControl.length,
        copiesExpected: delivery.copiesExpected,
        copiesRead: delivery.copiesRead,
        dueToFirstReadOverExpectedCopiesMs: computeRoomSendRecipientDelayFigures(sendsBeforeFirstControl)
            .dueToFirstReadOverExpectedCopiesMs
    };
}

/** For each publisher at least one control names a send of: the instant the earliest of those controls was read. */
function toFirstControlAtMsByTrack(observedSends: readonly ObservedRoomSend[]): ReadonlyMap<string, number> {
    const firstControlAtMsByTrack = new Map<string, number>();
    for (const { send, controls } of observedSends) {
        for (const control of controls) {
            const firstControlAtMs = firstControlAtMsByTrack.get(send.publisherPeerId);
            if (firstControlAtMs === undefined || control.atMs < firstControlAtMs) {
                firstControlAtMsByTrack.set(send.publisherPeerId, control.atMs);
            }
        }
    }
    return firstControlAtMsByTrack;
}
