/** Why a receiver answers a relayed copy as not yet in sync while the layout that names its relay is only planned. */
export const RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON =
    'Awaiting the promotion of the planned layout that names the relay';

/**
 * Whether a receiver's drop reason asks for a room snapshot refresh. A room-authority denial writes the code at the
 * head of the reason and the denial after it; a server-side denial writes the bare code. A copy awaiting the
 * promotion of a planned layout lacks the layout, not the room snapshot, so no refresh can help it.
 */
export function isRtcRoomSnapshotRefreshReason(reason: string): boolean {
    return reason === 'not-yet-in-sync' ||
        (reason.startsWith('not-yet-in-sync: ') &&
            reason !== `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`);
}
