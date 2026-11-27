import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import { computeRoomSendDelaySummary, type RoomSendDelaySummary } from './compute-room-send-delay-summary.ts';
import type { ObservedRoomSend, ObservedRoomSendCopy } from './to-observed-room-sends.ts';
import { toRoomSendCopiesInOfferOrder, type RoomSendOfferedCopy } from './to-room-send-copies-in-offer-order.ts';

/**
 * What became of each send on its way to the application and to its recipients' sockets. A copy is one expected
 * recipient's share of a send, and every count here is over every send, whatever the entry answered it. A copy is
 * "read" when the server wrote it to its recipient's socket: a frame on the wire, before the de-duplication and the
 * ordered hold-back a client applies, which a session of the cell has not. So no figure here says what an
 * application saw: a copy written twice is one a client takes once, and a copy written ahead of its track is one a
 * client holds back. Every figure here holds for a send whether or not it names an ordering key; the figures that
 * need a track are `RoomSendTrackFigures`.
 */
export interface RoomSendDeliveryFigures {
    /** Sends an instance handed to its application subscriber at least once. */
    readonly handedToApplication: number;
    /** Sends handed to an application subscriber more than once, by one instance or by several. */
    readonly handedMoreThanOnce: number;
    /** Sends that application subscribers of more than one instance were handed. */
    readonly handedByMoreThanOneInstance: number;
    /**
     * Sends whose first offer the entry answered `pending-admission`, retaining them for a replay to admit, that an
     * instance handed to its application at least once: a replay admitted them, or a later offer did.
     */
    readonly pendingAdmissionHandedToApplication: number;
    /** Sends answered `pending-admission` that no instance handed to its application while observation lasted. */
    readonly pendingAdmissionNeverHanded: number;
    /** The most hand-offs any one send had; null when no send was handed to the application. */
    readonly largestHandOffMultiplicity: number | null;
    /** Every send handed to the application, from its offer at the entry to its first hand-off. */
    readonly offerToFirstHandOffMs: RoomSendDelaySummary;
    /** Sends with at least one expected recipient, to every one of whose sockets the server wrote its copy. */
    readonly deliveredToEveryRecipient: number;
    /** Sends the server wrote a copy of to the socket of at least one expected recipient. */
    readonly deliveredToAnyRecipient: number;
    /** One for each expected recipient of each send. */
    readonly copiesExpected: number;
    /** Expected copies the server wrote to their recipient's socket at least once. */
    readonly copiesRead: number;
    /** Expected copies the server wrote to their recipient's socket more than once; a client drops the repeat. */
    readonly copiesReadMoreThanOnce: number;
    /**
     * Copies first written to a socket before the first write, to the same socket, of a send the same publisher
     * offered earlier; a copy never written is behind nothing. It is the order on the wire. Of sends on a track a
     * client holds such a copy back, so its application may still see in order what was written out of it; of sends
     * that name no ordering key nothing puts the order back.
     */
    readonly copiesReadOutOfOfferOrder: number;
}

export function computeRoomSendDeliveryFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendDeliveryFigures {
    const handOffCounts = observedSends.map((observed) => observed.handOffs.length).filter((count) => count > 0);
    const pendingAdmissions = observedSends.filter(({ send }) => send.acceptance === 'pending-admission');
    const pendingAdmissionsHanded = pendingAdmissions.filter(({ handOffs }) => handOffs.length > 0).length;
    const copies = observedSends.flatMap((observed) => observed.copies);
    return {
        handedToApplication: handOffCounts.length,
        handedMoreThanOnce: handOffCounts.filter((count) => count > 1).length,
        handedByMoreThanOneInstance: observedSends
            .filter(({ handOffs }) => new Set(handOffs.map((handOff) => handOff.instanceIndex)).size > 1).length,
        pendingAdmissionHandedToApplication: pendingAdmissionsHanded,
        pendingAdmissionNeverHanded: pendingAdmissions.length - pendingAdmissionsHanded,
        largestHandOffMultiplicity: computeNumberExtrema(handOffCounts)?.max ?? null,
        offerToFirstHandOffMs: computeRoomSendDelaySummary(
            observedSends.flatMap(({ send, handOffs }) => handOffs.slice(0, 1).map(({ atMs }) => atMs - send.sentAtMs))
        ),
        deliveredToEveryRecipient: observedSends
            .filter((observed) => observed.copies.length > 0 && observed.copies.every(isRead)).length,
        deliveredToAnyRecipient: observedSends.filter((observed) => observed.copies.some(isRead)).length,
        copiesExpected: copies.length,
        copiesRead: copies.filter(isRead).length,
        copiesReadMoreThanOnce: copies.filter((copy) => copy.reads.length > 1).length,
        copiesReadOutOfOfferOrder: toRoomSendCopiesInOfferOrder(observedSends)
            .reduce((total, copiesInOfferOrder) => total + computeReadsBeforeAnEarlierOffer(copiesInOfferOrder), 0)
    };
}

/** Of one recipient's copies of one publisher: those first read before the first read of one offered earlier. */
function computeReadsBeforeAnEarlierOffer(copiesInOfferOrder: readonly RoomSendOfferedCopy[]): number {
    let latestReadPositionOfAnEarlierOffer = -1;
    let readsBeforeAnEarlierOffer = 0;
    for (const { firstReadPosition } of copiesInOfferOrder) {
        if (firstReadPosition === undefined) {
            continue;
        }
        if (firstReadPosition < latestReadPositionOfAnEarlierOffer) {
            readsBeforeAnEarlierOffer += 1;
        }
        latestReadPositionOfAnEarlierOffer = Math.max(latestReadPositionOfAnEarlierOffer, firstReadPosition);
    }
    return readsBeforeAnEarlierOffer;
}

function isRead(copy: ObservedRoomSendCopy): boolean {
    return copy.reads.length > 0;
}
