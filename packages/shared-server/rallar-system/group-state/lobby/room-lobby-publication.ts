import { projectRoomLobbySeat, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication, type ViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import { roomLobbyDeadlineRoute, type RoomLobbyDeadline } from './room-lobby-deadline.ts';

interface RoomLobbyPublicationInput extends Pick<RoomLobbyDeadline, 'roomRef' | 'groupCreatedAtEpochMs'> {
    readonly before: Pick<RoomLobby, 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly after: Pick<RoomLobby, 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly createdAtEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
    readonly retentionMs: number;
}

/** Only a changed private seat wakes its account; several seats can share a single durable window. */
export function computeRoomLobbyPublication(input: RoomLobbyPublicationInput): ViewInvalidationPublication {
    const { before, after, roomRef, groupCreatedAtEpochMs } = input;
    const oldSeats = new Map(before?.seats.map(seat => [seat.principalId, seat]));
    const newSeats = new Map(after?.seats.map(seat => [seat.principalId, seat]));
    const accounts = new Set([...oldSeats.keys(), ...newSeats.keys()]);
    const { applicationId, workspaceId } = roomRef;
    const notices = computeViewInvalidationPublication({
        resource: 'room-lobby',
        scope: { applicationId, workspaceId },
        principalIds: [...accounts].filter(id => !jsonEquals(
            projectRoomLobbySeat(roomRef, oldSeats.get(id)), projectRoomLobbySeat(roomRef, newSeats.get(id))
        )),
        changeId: computeSha256CanonicalJson({ roomRef, groupCreatedAtEpochMs, before: before && [before.activationId, before.revision], after: after && [after.activationId, after.revision] }),
        createdAtEpochMs: input.createdAtEpochMs,
        retentionMs: input.retentionMs,
        serviceId: input.serviceId,
        traceId: input.traceId
    });
    const previous = before?.activationId === after?.activationId ? lobbyWindows(before) : new Map();
    const deadlines: RoomLobbyDeadline[] = [];
    if (after && after.expiresAtEpochMs !== null &&
        (after.activationId !== before?.activationId || after.expiresAtEpochMs !== before.expiresAtEpochMs)) {
        deadlines.push({ kind: 'room', generation: after.revision, roomRef, groupCreatedAtEpochMs, activationId: after.activationId, dueAtEpochMs: after.expiresAtEpochMs });
    }
    const outbox = [...notices.outbox];
    for (const [key, window] of lobbyWindows(after)) {
        if (!after || previous.has(key)) continue;
        deadlines.push({ kind: 'seat', roomRef, groupCreatedAtEpochMs, activationId: after.activationId, ...window });
    }
    for (const deadline of deadlines) {
        outbox.push(computeAppOutboxSignal({
            ...roomLobbyDeadlineRoute(deadline),
            typeId: AppOutboxType.ROOM_LOBBY_DEADLINE,
            resource: JSON.stringify(deadline),
            createdAtEpochMs: input.createdAtEpochMs,
            dueAtEpochMs: deadline.dueAtEpochMs,
            expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
            serviceId: input.serviceId,
            traceId: input.traceId
        }));
    }
    return { outbox, provenance: notices.provenance };
}

function lobbyWindows(lobby: RoomLobbyPublicationInput['after']): Map<string, RoomLobby.ReturnWindow> {
    const windows = new Map<string, RoomLobby.ReturnWindow>();
    for (const seat of lobby?.seats ?? []) {
        for (const window of [seat.admissionWindow, seat.returnWindow]) {
            if (window) windows.set(JSON.stringify([window.generation, window.dueAtEpochMs]), window);
        }
    }
    return windows;
}
