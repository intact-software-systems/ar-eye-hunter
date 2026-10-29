import { validateRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarRoomEntry } from './rallar-room-entry.ts';

export function decodeRoomEntryDestination(
    value: unknown
): Either<RallarRoomEntry.Failure, RallarRoomEntry.Destination> {
    if (
        !value || typeof value !== 'object' || !('roomRef' in value) || !('joinCode' in value) ||
        !('participation' in value)
    ) {
        return Either.ofLeft(invalidDestination());
    }
    const roomRef = value.roomRef;
    if (
        !roomRef || typeof roomRef !== 'object' ||
        !('applicationId' in roomRef) || typeof roomRef.applicationId !== 'string' ||
        !('workspaceId' in roomRef) || typeof roomRef.workspaceId !== 'string' ||
        !('groupId' in roomRef) || typeof roomRef.groupId !== 'string' ||
        !validateRallarGroupRef(roomRef).ok ||
        (value.participation !== 'player' && value.participation !== 'spectator' &&
            value.participation !== 'preserve') ||
        (value.joinCode !== null && (typeof value.joinCode !== 'string' || value.joinCode.trim().length === 0))
    ) {
        return Either.ofLeft(invalidDestination());
    }
    return Either.ofRight({
        roomRef: { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId, groupId: roomRef.groupId },
        joinCode: value.joinCode,
        participation: value.participation
    });
}

export function invalidDestination(message = 'The room link or reference is invalid.'): RallarRoomEntry.Failure {
    return { kind: 'invalid-destination', message, admittedRoom: null };
}

export function decodeScopedDestination(
    value: unknown,
    scope: StateScope
): Either<RallarRoomEntry.Failure, RallarRoomEntry.Destination> {
    return decodeRoomEntryDestination(value).flatMap<RallarRoomEntry.Failure, RallarRoomEntry.Destination>(
        Either.ofLeft,
        (destination) =>
            destination.roomRef.applicationId === scope.applicationId &&
                destination.roomRef.workspaceId === scope.workspaceId
                ? Either.ofRight(destination)
                : Either.ofLeft(invalidDestination('This room belongs to a different application or workspace.'))
    );
}
