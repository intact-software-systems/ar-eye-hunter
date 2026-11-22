import { lobbyWindows } from '@shared/api/room-lobbies/room-lobby-windows.ts';
import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication, type ViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import { groupLobbyDeadlineRoute, type GroupLobbyDeadline } from './group-lobby-deadline.ts';

import { projectGroupLobbyCommitments } from './project-group-lobby-commitments.ts';

interface GroupLobbyPublicationInput extends Pick<GroupLobbyDeadline, 'roomRef' | 'groupCreatedAtEpochMs'> {
    readonly before: Pick<RoomLobby, 'capacityClaims' | 'waiters' | 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly after: Pick<RoomLobby, 'capacityClaims' | 'waiters' | 'seats' | 'revision' | 'activationId' | 'expiresAtEpochMs'> | null;
    readonly createdAtEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
    readonly retentionMs: number;
}

/** Only a changed private seat wakes its account; several seats can share a single durable window. */
export function computeGroupLobbyPublication(input: GroupLobbyPublicationInput): ViewInvalidationPublication {
    const { before, after, roomRef, groupCreatedAtEpochMs } = input;
    const oldSeats = projectGroupLobbyCommitments(roomRef, before);
    const newSeats = projectGroupLobbyCommitments(roomRef, after);
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
    const deadlines: GroupLobbyDeadline[] = [];
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
            ...groupLobbyDeadlineRoute(deadline),
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
