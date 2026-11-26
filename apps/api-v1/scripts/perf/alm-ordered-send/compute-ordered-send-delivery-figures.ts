import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';
import {
    computeOrderedSendTrackOrderFigures,
    type OrderedSendTrackOrderFigures
} from './compute-ordered-send-track-order-figures.ts';
import type { ObservedOrderedSend, ObservedOrderedSendCopy } from './to-observed-ordered-sends.ts';

/**
 * What became of each send on its way to the application and to its recipients. A copy is one expected recipient's
 * share of a send, and every count here is over every send, whatever the entry answered it.
 */
export interface OrderedSendDeliveryFigures extends OrderedSendTrackOrderFigures {
    /** Sends an instance handed to its application subscriber at least once. */
    readonly handedToApplication: number;
    /** Sends handed to an application subscriber more than once, by one instance or by several. */
    readonly handedMoreThanOnce: number;
    /** Sends that application subscribers of more than one instance were handed. */
    readonly handedByMoreThanOneInstance: number;
    /** The most hand-offs any one send had; null when no send was handed to the application. */
    readonly largestHandOffMultiplicity: number | null;
    /** Every send handed to the application, from its offer at the entry to its first hand-off. */
    readonly offerToFirstHandOffMs: OrderedSendDelaySummary;
    /** Sends with at least one expected recipient, every one of which read its copy. */
    readonly deliveredToEveryRecipient: number;
    /** Sends at least one expected recipient read a copy of. */
    readonly deliveredToAnyRecipient: number;
    /** One for each expected recipient of each send. */
    readonly copiesExpected: number;
    /** Expected copies their recipient read at least once. */
    readonly copiesRead: number;
    /** Expected copies their recipient read more than once. */
    readonly copiesReadMoreThanOnce: number;
}

export function computeOrderedSendDeliveryFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendDeliveryFigures {
    const handOffCounts = observedSends.map((observed) => observed.handOffs.length).filter((count) => count > 0);
    const copies = observedSends.flatMap((observed) => observed.copies);
    return {
        handedToApplication: handOffCounts.length,
        handedMoreThanOnce: handOffCounts.filter((count) => count > 1).length,
        handedByMoreThanOneInstance: observedSends
            .filter(({ handOffs }) => new Set(handOffs.map((handOff) => handOff.instanceIndex)).size > 1).length,
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
