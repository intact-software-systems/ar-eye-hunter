import { readRoomSchedule } from '@shared/api/group-deadlines/room-clock.ts';
import type { Group } from '@shared/api/group-types.ts';
import {
    reconcileRoomLobbyRegistrationBoundary,
    setRoomLobbyRegistrationBoundary
} from '@shared/api/room-lobbies/room-lobby-registration-boundary.ts';
import {
    readRoomLobbyRegistration,
    ROOM_LOBBY_REGISTRATION_METADATA_KEY,
    roomLobbyRegistrationDefinition
} from '@shared/api/room-lobbies/room-lobby-registration.ts';
import { changeRoomLobby, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';

interface GroupRegistrationUpdateInput {
    readonly group: Group;
    readonly lobby: RoomLobby | undefined;
    readonly change: RoomLobby.Mutation | undefined;
    readonly clockName: string | undefined;
    readonly nowEpochMs: number;
}

interface GroupRegistrationWrite {
    readonly group: Group;
    readonly lobby: RoomLobby;
}

interface GroupRegistrationRefusal {
    readonly rejectionCode: 'room-lobby-registration-revision-conflict' | 'group-mutation-rejected';
    readonly message: string;
}

/** Project the same registration decision into the group snapshot and the guarded private lobby write. */
export function computeGroupRegistrationUpdate(
    { group, lobby, change, clockName, nowEpochMs }: GroupRegistrationUpdateInput
): GroupRegistrationWrite | GroupRegistrationRefusal | null {
    let updated: RoomLobby.Change;
    if (change?.operation === 'set-registration-cutoff' || change?.operation === 'set-registration-boundary') {
        if (!lobby) {
            return { rejectionCode: 'group-mutation-rejected', message: 'Registration requires a managed room.' };
        }
        if (change.operation === 'set-registration-cutoff') {
            updated = changeRoomLobby(lobby, {
                kind: 'set-registration-cutoff',
                expectedRevision: change.expectedRevision,
                atEpochMs: change.atEpochMs
            }, nowEpochMs);
        }
        else {
            updated = setRoomLobbyRegistrationBoundary({
                lobby, command: change, schedule: readRoomSchedule(group.metadata, change.program), nowEpochMs
            });
        }
    }
    else {
        if (clockName === undefined) return null;
        const binding = readRoomLobbyRegistration(group.metadata)?.boundary;
        if (binding?.program !== clockName) return null;
        if (!lobby) throw new TypeError('Bound registration requires its private lobby.');
        updated = reconcileRoomLobbyRegistrationBoundary(lobby, readRoomSchedule(group.metadata, clockName), nowEpochMs);
    }
    if (updated.rejection === 'revision-conflict') {
        return { rejectionCode: 'room-lobby-registration-revision-conflict', message: 'The registration or program revision has changed.' };
    }
    if (updated.rejection !== null) {
        const message = updated.rejection === 'invalid-boundary'
            ? 'Registration requires one matching program phase.'
            : 'Registration has closed.';
        return { rejectionCode: 'group-mutation-rejected', message };
    }
    if (updated.lobby === lobby) return null;
    const definition = roomLobbyRegistrationDefinition(updated.lobby.registration);
    const metadata = { ...group.metadata, [ROOM_LOBBY_REGISTRATION_METADATA_KEY]: definition };
    return { group: { ...group, metadata }, lobby: updated.lobby };
}
