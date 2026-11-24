import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { GroupRole } from '@shared/api/group-types.ts';
import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { observeRoomDirectorLoss } from '@shared/api/room-directors/room-director-succession-presence.ts';
import { readRoomDirectorSuccession, type RoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';

/** The server rechecks the epoch, active session, reconnect window and deputy reservation at commit. */
export function townHostCommand(
    metadata: ApiJsonObject, player: { readonly principalId: string; readonly sessionId: string; readonly role: GroupRole },
    compareDeadline: RallarFacade['compareDeadline']
): RoomDirectorSuccession.Command | undefined {
    if (player.role === 'spectator') return undefined;
    const director = readRallarGroupDirectorAppointment(metadata);
    const expectedDirectorEpoch = director?.epoch ?? 0;
    if (!director) {
        if (player.role !== 'owner' && player.role !== 'admin') return undefined;
        return { operation: 'appoint', expectedDirectorEpoch, targetPrincipalId: player.principalId, targetSessionId: player.sessionId };
    }
    const succession = readRoomDirectorSuccession(metadata);
    if (!succession) return undefined;
    const end = succession.directorLeaseExpiresAtEpochMs;
    const loss = succession.loss ?? (end !== null && compareDeadline(end) === 'at-or-after'
        ? readRoomDirectorSuccession(observeRoomDirectorLoss(metadata, end))?.loss : undefined);
    if (!loss || compareDeadline(loss.reconnectUntilEpochMs) !== 'at-or-after') return undefined;
    if (!loss.declined && succession.deputyPrincipalId && compareDeadline(loss.deputyUntilEpochMs) !== 'at-or-after') {
        if (succession.deputyPrincipalId !== player.principalId || compareDeadline(loss.deputyUntilEpochMs) !== 'before') return undefined;
        return { operation: 'claim-deputy', expectedDirectorEpoch };
    }
    return { operation: 'claim-player', expectedDirectorEpoch };
}
