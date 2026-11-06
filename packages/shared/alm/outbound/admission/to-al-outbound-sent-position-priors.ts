import type {
    ALOutboundRoomSentPositionRow,
    ALOutboundTrackPositionRow
} from './decode-al-outbound-track-position-row.ts';

export interface ToALOutboundSentPositionPriorsInput {
    readonly recipientPeerIds: readonly string[];
    /** Each recipient's sent-position row, in `recipientPeerIds` order; undefined for one never sent the track. */
    readonly positions: readonly (ALOutboundTrackPositionRow | undefined)[];
    /**
     * Each recipient's row in the namespace the session's pairs share, in `recipientPeerIds` order: the last sequence
     * another carrier's receipt named it among those sent; undefined for one no receipt named.
     */
    readonly sharedPositions: readonly (ALOutboundTrackPositionRow | undefined)[];
    /** The track's room-wide sent position; undefined where no carrier of the session sent the room unrecorded. */
    readonly roomPosition: ALOutboundRoomSentPositionRow | undefined;
}

/**
 * Each recipient's prior on the track: the later of its own last sent sequence and the last one another carrier's
 * receipt named it in, `0` for none. While no receipt has named who the room-wide sent position reached, any recipient
 * may hold it, so each reads no lower than it.
 */
export function toALOutboundSentPositionPriors(
    input: ToALOutboundSentPositionPriorsInput
): Readonly<Record<string, number>> {
    const room = input.roomPosition;
    const unresolvedRoomSeq = room !== undefined && room.seq > room.resolvedSeq ? room.seq : 0;
    return Object.fromEntries(
        input.recipientPeerIds.map((recipientPeerId, index) => [
            recipientPeerId,
            Math.max(input.positions[index]?.seq ?? 0, input.sharedPositions[index]?.seq ?? 0, unresolvedRoomSeq)
        ])
    );
}
