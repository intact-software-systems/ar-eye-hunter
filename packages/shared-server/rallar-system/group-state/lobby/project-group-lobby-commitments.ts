import type { GroupRef } from '@shared/api/group-types.ts';
import { projectRoomLobbySeat, type RoomLobby, type RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';

/** The same account projection decides which private rows change and who receives a notification. */
export function projectGroupLobbyCommitments(
    roomRef: GroupRef, lobby: Pick<RoomLobby, 'seats' | 'waiters'> | null
): ReadonlyMap<string, RoomLobbyAccountView['seat']> {
    const views = new Map<string, RoomLobbyAccountView['seat']>();
    if (lobby) {
        for (const seat of lobby.seats) views.set(seat.principalId, projectRoomLobbySeat(roomRef, seat));
        for (const waiter of lobby.waiters) views.set(waiter.principalId, projectRoomLobbySeat(roomRef, undefined, true));
    }
    return views;
}
