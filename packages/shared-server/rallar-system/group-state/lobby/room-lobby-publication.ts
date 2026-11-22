import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication, type ViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import { roomLobbyDeadlineRoute, type RoomLobbyDeadline } from './room-lobby-deadline.ts';

import { projectRoomLobbyCommitments } from './project-room-lobby-commitments.ts';

interface RoomLobbyPublicationInput extends Pick<RoomLobbyDeadline, 'roomRef' | 'groupCreatedAtEpochMs'> {
    readonly before: Pick<RoomLobby, 'capacityClaims' | 'waiters' | 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly after: Pick<RoomLobby, 'capacityClaims' | 'waiters' | 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly createdAtEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
    readonly retentionMs: number;
}

/** Only a changed private seat wakes its account; several seats can share a single durable window. */
export function computeRoomLobbyPublication(input: RoomLobbyPublicationInput): ViewInvalidationPublication {
    const { before, after, roomRef, groupCreatedAtEpochMs } = input;
    const oldSeats = projectRoomLobbyCommitments(roomRef, before);
    const newSeats = projectRoomLobbyCommitments(roomRef, after);
    const accounts = new Set([...oldSeats.keys(), ...newSeats.keys()]);
    const { applicationId, workspaceId } = roomRef;
    const notices = computeViewInvalidationPublication({
        resource: 'room-lobby',
        scope: { applicationId, workspaceId },
        principalIds: [...accounts].filter(id => !jsonEquals(oldSeats.get(id), newSeats.get(id))),
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
    if (!lobby) return windows;
    if (lobby.capacityClaims) {
        const { generation, dueAtEpochMs } = lobby.capacityClaims;
        windows.set(JSON.stringify([generation, dueAtEpochMs]), { generation, dueAtEpochMs });
    }
    for (const waiter of lobby.waiters) {
        if (waiter.eligibleUntilEpochMs !== null) {
            const window = { generation: waiter.generation, dueAtEpochMs: waiter.eligibleUntilEpochMs };
            windows.set(JSON.stringify([window.generation, window.dueAtEpochMs]), window);
        }
    }
    for (const seat of lobby.seats) {
        for (const window of [seat.admissionWindow, seat.returnWindow, seat.offerWindow]) {
            if (window) windows.set(JSON.stringify([window.generation, window.dueAtEpochMs]), window);
        }
    }
    return windows;
}
