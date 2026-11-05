import type { ALOutboundTrackPositionRow } from './decode-al-outbound-track-position-row.ts';

export interface ToALOutboundSentPositionPriorsInput {
    readonly recipientPeerIds: readonly string[];
    /** Each recipient's sent-position row, in `recipientPeerIds` order; undefined for one never sent the track. */
    readonly positions: readonly (ALOutboundTrackPositionRow | undefined)[];
    /** The track's room-wide sent position; undefined where no carrier of the session sent the room unrecorded. */
    readonly roomPosition: ALOutboundTrackPositionRow | undefined;
}

/**
 * Each recipient's prior on the track: its own last sent sequence, `0` for none, read no lower than the room-wide sent
 * position, a sequence another carrier of the session sent to an audience only the server knows.
 */
export function toALOutboundSentPositionPriors(
    input: ToALOutboundSentPositionPriorsInput
): Readonly<Record<string, number>> {
    const roomSeq = input.roomPosition?.seq ?? 0;
    return Object.fromEntries(
        input.recipientPeerIds.map((recipientPeerId, index) => [
            recipientPeerId,
            Math.max(input.positions[index]?.seq ?? 0, roomSeq)
        ])
    );
}
