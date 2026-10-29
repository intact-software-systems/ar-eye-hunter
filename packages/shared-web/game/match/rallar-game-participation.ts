import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import type { GroupRef, GroupRole } from '@shared/api/group-types.ts';

export interface RallarGameParticipationTarget {
    readonly roomRef?: GroupRef;
    readonly roomId?: string;
}

/** Reads the scoped, currently active session from the browser room projection. */
export function readRallarGameSessionRole(
    state: RallarRoomState,
    sessionId: string | undefined,
    target: RallarGameParticipationTarget
): GroupRole | undefined {
    const roomRef = target.roomRef ??
        (target.roomId === undefined || target.roomId === state.currentRoomId ? state.currentRoomRef : undefined);
    const snapshot = roomRef && state.currentRoomRef && isSameGroupRef(roomRef, state.currentRoomRef)
        ? state.currentRoom
        : roomRef
        ? state.rooms.find((room) => isSameGroupRef(room.roomRef, roomRef))?.snapshot
        : undefined;
    return readActiveGroupSessionRole(snapshot, sessionId, Date.now());
}
