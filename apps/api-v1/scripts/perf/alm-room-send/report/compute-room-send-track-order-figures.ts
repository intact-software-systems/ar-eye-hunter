import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * How the copies the server wrote to each recipient's socket followed each publisher's track. Both counts are over
 * the expected copies written to their recipient's socket, and "before" is the order of the first writes in
 * `arrivals`, never a comparison of instants. They are the order on the wire: a client holds back a copy that is
 * ahead of its track, so its application may still see in order what was written out of it.
 */
export interface RoomSendTrackOrderFigures {
    /** Copies first written to a socket before the first write, to the same socket, of a lower seq of the same publisher. */
    readonly copiesReadOutOfTrackOrder: number;
    /** Copies written to a socket that was never written a lower seq of the same publisher its session expected. */
    readonly copiesReadPastAnUnreadPredecessor: number;
}

interface RoomSendTrackCopy {
    readonly recipientTrack: string;
    readonly seq: number;
    /** The place in `arrivals` of the copy's first read; undefined when its recipient never read it. */
    readonly firstReadPosition: number | undefined;
}

export function computeRoomSendTrackOrderFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendTrackOrderFigures {
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
    observedSends: readonly ObservedRoomSend[]
): readonly (readonly RoomSendTrackCopy[])[] {
    const trackCopies = observedSends.flatMap(({ send, copies }) =>
        copies.map((copy): RoomSendTrackCopy => ({
            recipientTrack: JSON.stringify([copy.recipientPeerId, send.publisherPeerId]),
            seq: send.seq,
            firstReadPosition: copy.reads.at(0)?.arrivalPosition
        }))
    );
    return [...Map.groupBy(trackCopies, (copy) => copy.recipientTrack).values()]
        .map((track) => track.toSorted((left, right) => left.seq - right.seq));
}

function computeReadsBeforeALowerSeq(track: readonly RoomSendTrackCopy[]): number {
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

function computeReadsPastAnUnreadCopy(track: readonly RoomSendTrackCopy[]): number {
    const lowestUnread = track.findIndex((copy) => copy.firstReadPosition === undefined);
    return lowestUnread === -1
        ? 0
        : track.slice(lowestUnread).filter((copy) => copy.firstReadPosition !== undefined).length;
}
