import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * How each recipient's reads followed each publisher's track. Both counts are over the expected copies their
 * recipient read, and "before" is the order of the first reads in `arrivals`, never a comparison of instants.
 */
export interface OrderedSendTrackOrderFigures {
    /** Copies first read before the first read of a lower seq that the same recipient read of the same publisher. */
    readonly copiesReadOutOfTrackOrder: number;
    /** Copies read while the same recipient never read a lower seq it was expected to read of the same publisher. */
    readonly copiesReadPastAnUnreadPredecessor: number;
}

interface OrderedSendTrackCopy {
    readonly recipientTrack: string;
    readonly seq: number;
    /** The place in `arrivals` of the copy's first read; undefined when its recipient never read it. */
    readonly firstReadPosition: number | undefined;
}

export function computeOrderedSendTrackOrderFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendTrackOrderFigures {
    const recipientTracks = toRecipientTracks(observedSends);
    return {
        copiesReadOutOfTrackOrder: recipientTracks
            .reduce((total, track) => total + computeReadsBeforeALowerSeq(track), 0),
        copiesReadPastAnUnreadPredecessor: recipientTracks
            .reduce((total, track) => total + computeReadsPastAnUnreadCopy(track), 0)
    };
}

/** One list for each recipient and publisher: the copies that recipient was expected to read, in ascending seq. */
function toRecipientTracks(
    observedSends: readonly ObservedOrderedSend[]
): readonly (readonly OrderedSendTrackCopy[])[] {
    const trackCopies = observedSends.flatMap(({ send, copies }) =>
        copies.map((copy): OrderedSendTrackCopy => ({
            recipientTrack: JSON.stringify([copy.recipientPeerId, send.publisherPeerId]),
            seq: send.seq,
            firstReadPosition: copy.reads.at(0)?.arrivalPosition
        }))
    );
    return [...Map.groupBy(trackCopies, (copy) => copy.recipientTrack).values()]
        .map((track) => track.toSorted((left, right) => left.seq - right.seq));
}

function computeReadsBeforeALowerSeq(track: readonly OrderedSendTrackCopy[]): number {
    let latestLowerSeqReadPosition = -1;
    let readsBeforeALowerSeq = 0;
    for (const { firstReadPosition } of track) {
        if (firstReadPosition === undefined) {
            continue;
        }
        if (firstReadPosition < latestLowerSeqReadPosition) {
            readsBeforeALowerSeq += 1;
        }
        latestLowerSeqReadPosition = Math.max(latestLowerSeqReadPosition, firstReadPosition);
    }
    return readsBeforeALowerSeq;
}

function computeReadsPastAnUnreadCopy(track: readonly OrderedSendTrackCopy[]): number {
    const lowestUnread = track.findIndex((copy) => copy.firstReadPosition === undefined);
    return lowestUnread === -1
        ? 0
        : track.slice(lowestUnread).filter((copy) => copy.firstReadPosition !== undefined).length;
}
