import type { ALOutboundTrackPositionRow } from './decode-al-outbound-track-position-row.ts';
import {
    toALOutboundUnknownAudienceSeq,
    type ALOutboundRoomSentFloorRow
} from './sequencing/al-outbound-room-sent-floor.ts';

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
    readonly roomFloor: ALOutboundRoomSentFloorRow | undefined;
}

/**
 * Each recipient's prior on the track: the later of its own last sent sequence and the last one another carrier's
 * receipt named it in, `0` for none. Any recipient may hold a room-wide sent sequence no receipt has named the
 * audience of, so each reads no lower than the highest one.
 */
export function toALOutboundSentPositionPriors(
    input: ToALOutboundSentPositionPriorsInput
): Readonly<Record<string, number>> {
    const unknownAudienceSeq = toALOutboundUnknownAudienceSeq(input.roomFloor);
    return Object.fromEntries(
        input.recipientPeerIds.map((recipientPeerId, index) => [
            recipientPeerId,
            Math.max(input.positions[index]?.seq ?? 0, input.sharedPositions[index]?.seq ?? 0, unknownAudienceSeq)
        ])
    );
}
