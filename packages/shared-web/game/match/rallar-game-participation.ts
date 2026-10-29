import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import type { GroupRef, GroupRole, GroupSnapshot } from '@shared/api/group-types.ts';

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
    return readActiveGroupSessionRole(readScopedSnapshot(state, target), sessionId, Date.now());
}

/** Only a currently admitted session may supply a game sender generation. */
export function readRallarGameSessionGeneration(
    state: RallarRoomState,
    sessionId: string,
    target: RallarGameParticipationTarget
): string | undefined {
    const snapshot = readScopedSnapshot(state, target);
    return readActiveGroupSessionRole(snapshot, sessionId, Date.now()) === undefined
        ? undefined
        : snapshot?.activeSessions.find((session) => session.sessionId === sessionId)?.generationId;
}

function readScopedSnapshot(state: RallarRoomState, target: RallarGameParticipationTarget): GroupSnapshot | undefined {
    const roomRef = target.roomRef ??
        (target.roomId === undefined || target.roomId === state.currentRoomId ? state.currentRoomRef : undefined);
    return roomRef && state.currentRoomRef && isSameGroupRef(roomRef, state.currentRoomRef)
        ? state.currentRoom
        : roomRef
        ? state.rooms.find((room) => isSameGroupRef(room.roomRef, roomRef))?.snapshot
        : undefined;
}
