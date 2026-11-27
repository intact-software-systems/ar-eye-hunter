import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';
import {
    computeOrderedSendTrackOrderFigures,
    type OrderedSendTrackOrderFigures
} from './compute-ordered-send-track-order-figures.ts';
import type { ObservedOrderedSend, ObservedOrderedSendCopy } from './to-observed-ordered-sends.ts';

/**
 * What became of each send on its way to the application and to its recipients' sockets. A copy is one expected
 * recipient's share of a send, and every count here is over every send, whatever the entry answered it. A copy is
 * "read" when the server wrote it to its recipient's socket: a frame on the wire, before the de-duplication and the
 * ordered hold-back a client applies, which a session of the cell has not. So no figure here says what an
 * application saw: a copy written twice is one a client takes once, and a copy written ahead of its track is one a
 * client holds back.
 */
export interface OrderedSendDeliveryFigures extends OrderedSendTrackOrderFigures {
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
    readonly offerToFirstHandOffMs: OrderedSendDelaySummary;
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
}

export function computeOrderedSendDeliveryFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendDeliveryFigures {
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
        offerToFirstHandOffMs: computeOrderedSendDelaySummary(
            observedSends.flatMap(({ send, handOffs }) => handOffs.slice(0, 1).map(({ atMs }) => atMs - send.sentAtMs))
        ),
        deliveredToEveryRecipient: observedSends
            .filter((observed) => observed.copies.length > 0 && observed.copies.every(isRead)).length,
        deliveredToAnyRecipient: observedSends.filter((observed) => observed.copies.some(isRead)).length,
        copiesExpected: copies.length,
        copiesRead: copies.filter(isRead).length,
        copiesReadMoreThanOnce: copies.filter((copy) => copy.reads.length > 1).length,
        ...computeOrderedSendTrackOrderFigures(observedSends)
    };
}

function isRead(copy: ObservedOrderedSendCopy): boolean {
    return copy.reads.length > 0;
}
