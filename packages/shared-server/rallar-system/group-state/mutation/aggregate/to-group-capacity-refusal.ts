import type { Group } from '@shared/api/group-types.ts';
import { readRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import { countGroupPlayers, isGroupSpectator, readGroupSpectatorCapacity } from '@shared/api/group-spectating.ts';
import { countGroupSessionOccupiedSeats } from '../../schedule/group-session-reservations.ts';
import type { GroupMutationRead } from '../group-mutation-contracts.ts';
import { toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

/** Capacity changes preserve occupied players, outstanding reservations and spectators. */
export function toGroupCapacityRefusal(next: Group, read: GroupMutationRead, nowEpochMs: number): string | null {
    const lobby = readRoomLobbyPolicy(next.metadata);
    if (lobby && (next.kind !== 'room' || next.maxMembers === null || next.maxMembers < 1)) return 'A lobby requires finite room capacity.';
    const schedule = readGroupSessionSchedule(next.metadata);
    if (schedule !== null && (next.kind !== 'room' || next.maxMembers === null || next.maxMembers > 64)) {
        return 'Scheduled rooms require a player capacity of 1 to 64.';
    }
    const snapshot = toPolicySnapshot(read, next, nowEpochMs);
    const occupiedSeats = lobby ? 0 : schedule === null
        ? countGroupPlayers(snapshot)
        : countGroupSessionOccupiedSeats({
            schedule,
            reservations: requireSessionReservations(read),
            activePlayerPrincipalIds: snapshot.members.filter((member) =>
                member.status === 'active' && !isGroupSpectator(member)
            )
                .map((member) => member.principalId),
            nowEpochMs
        });
    if (next.maxMembers !== null && next.maxMembers < occupiedSeats) {
        return 'Group maxMembers cannot be lower than the occupied and reserved player seats.';
    }
    if (readGroupSpectatorCapacity(next.metadata) < (read.activeMembers ?? []).filter(isGroupSpectator).length) {
        return 'Spectator capacity cannot be lower than the spectator count.';
    }
    return null;
}

function requireSessionReservations(read: GroupMutationRead) {
    if (read.sessionReservations === null) {
        throw new TypeError('Scheduled room capacity requires reservation state');
    }
    return read.sessionReservations.value;
}
