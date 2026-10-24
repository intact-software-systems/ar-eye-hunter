import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarRecentRooms } from './rallar-recent-rooms.ts';

const HISTORY_LIMIT = 10;
const INVALID_HISTORY = 'Saved recent rooms are invalid. They have been left unchanged.';

export function computeRecentRoomHistory(
    history: RallarRecentRooms.History,
    edit: RallarRecentRooms.Edit
): RallarRecentRooms.History {
    if (edit.kind === 'forget') {
        return { rooms: history.rooms.filter((visit) => !isSameGroupRef(visit.roomRef, edit.roomRef)) };
    }
    const rooms = history.rooms.filter((previous) => !isSameGroupRef(previous.roomRef, edit.visit.roomRef));
    return {
        rooms: [edit.visit, ...rooms]
            .sort((a, b) => b.visitedAtEpochMs - a.visitedAtEpochMs)
            .slice(0, HISTORY_LIMIT)
    };
}

export function decodeRecentRoomHistory(value: unknown, scope: StateScope): Either<string, RallarRecentRooms.History> {
    if (value === undefined) {
        return Either.ofRight({ rooms: [] });
    }
    if (
        !value || typeof value !== 'object' || Object.keys(value).length !== 1 ||
        !('rooms' in value) || !Array.isArray(value.rooms) || value.rooms.length > HISTORY_LIMIT
    ) {
        return Either.ofLeft(INVALID_HISTORY);
    }
    const rooms: RallarRecentRooms.Visit[] = [];
    for (const candidate of value.rooms) {
        const visit = decodeRecentRoomVisit(candidate, scope).right;
        if (
            !visit || rooms.some((previous) => isSameGroupRef(previous.roomRef, visit.roomRef))
        ) {
            return Either.ofLeft(INVALID_HISTORY);
        }
        rooms.push(visit);
    }
    return Either.ofRight({ rooms: rooms.sort((a, b) => b.visitedAtEpochMs - a.visitedAtEpochMs) });
}

function decodeRecentRoomVisit(value: unknown, scope: StateScope): Either<string, RallarRecentRooms.Visit> {
    if (
        !value || typeof value !== 'object' || Object.keys(value).length !== 2 ||
        !('roomRef' in value) || !('visitedAtEpochMs' in value) ||
        typeof value.visitedAtEpochMs !== 'number' || !Number.isSafeInteger(value.visitedAtEpochMs) ||
        value.visitedAtEpochMs < 0
    ) {
        return Either.ofLeft(INVALID_HISTORY);
    }
    const ref = value.roomRef;
    if (
        !ref || typeof ref !== 'object' || Object.keys(ref).length !== 3 ||
        !('applicationId' in ref) || ref.applicationId !== scope.applicationId ||
        !('workspaceId' in ref) || ref.workspaceId !== scope.workspaceId ||
        !('groupId' in ref) || typeof ref.groupId !== 'string' || !validateRallarGroupRef(ref).ok
    ) {
        return Either.ofLeft(INVALID_HISTORY);
    }
    const roomRef: GroupRef = { applicationId: ref.applicationId, workspaceId: ref.workspaceId, groupId: ref.groupId };
    return Either.ofRight({ roomRef, visitedAtEpochMs: value.visitedAtEpochMs });
}
