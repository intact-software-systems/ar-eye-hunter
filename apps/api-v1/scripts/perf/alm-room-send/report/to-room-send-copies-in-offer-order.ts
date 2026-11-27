import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/** One expected copy among its recipient's copies of one publisher's sends. */
export interface RoomSendOfferedCopy {
    /** Its send's number among its publisher's offers: a higher seq was offered later. */
    readonly seq: number;
    /** The place in `arrivals` of the copy's first read; undefined when its recipient never read it. */
    readonly firstReadPosition: number | undefined;
}

/**
 * One list for each recipient and publisher: the copies that recipient was expected to read of that publisher's
 * sends, in the order the publisher offered them. A figure that says one read came "before" another takes it from the
 * places of the first writes in `arrivals`, never from a comparison of instants.
 */
export function toRoomSendCopiesInOfferOrder(
    observedSends: readonly ObservedRoomSend[]
): readonly (readonly RoomSendOfferedCopy[])[] {
    const copiesByRecipientAndPublisher = Map.groupBy(
        observedSends.flatMap(({ send, copies }) => copies.map((copy) => ({ send, copy }))),
        ({ send, copy }) => JSON.stringify([copy.recipientPeerId, send.publisherPeerId])
    );
    return [...copiesByRecipientAndPublisher.values()].map((copiesOfOnePublisher) =>
        copiesOfOnePublisher
            .map(({ send, copy }): RoomSendOfferedCopy => ({
                seq: send.seq,
                firstReadPosition: copy.reads.at(0)?.arrivalPosition
            }))
            .toSorted((left, right) => left.seq - right.seq)
    );
}
