import { installDurableDeadline, type DurableDeadlineDelivery } from '../../app-outbox/install-durable-deadline.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export interface GroupLobbyDeadline {
    readonly kind: 'seat' | 'room' | 'registration';
    readonly generation: number;
    readonly roomRef: GroupRef;
    readonly activationId: string;
    readonly groupCreatedAtEpochMs: number;
    readonly dueAtEpochMs: number;
}

export function decodeGroupLobbyDeadline(value: unknown): GroupLobbyDeadline {
    const row = requireRecord(value, 'Room lobby deadline');
    requireExactKeys(row, ['kind', 'generation', 'roomRef', 'activationId', 'groupCreatedAtEpochMs', 'dueAtEpochMs'], 'Room lobby deadline');
    const ref = requireRecord(row.roomRef, 'Room lobby deadline room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Room lobby deadline room');
    const roomRef = assertValidRallarGroupRef(ref);
    requireString(row.activationId, 'Lobby activation');
    requireEpoch(row.groupCreatedAtEpochMs, 'Room creation time');
    requireEpoch(row.dueAtEpochMs, 'Lobby window deadline');
    if (row.kind === 'seat' || row.kind === 'registration') requirePositiveInteger(row.generation, 'Lobby deadline generation');
    else if (row.kind !== 'room') throw new TypeError('Unexpected lobby deadline kind');
    requireEpoch(row.generation, 'Lobby deadline generation');
    return {
        kind: row.kind, generation: row.generation, roomRef, activationId: row.activationId,
        groupCreatedAtEpochMs: row.groupCreatedAtEpochMs,
        dueAtEpochMs: row.dueAtEpochMs
    };

}

export function groupLobbyDeadlineRoute(deadline: GroupLobbyDeadline) {
    return toAppQueueKey({
        topicId: 'room-lobby.deadline',
        resourceId: computeSha256CanonicalJson(deadline),
        contextId: groupStateGroupStorageKey(deadline.roomRef)
    });
}

export function installGroupLobbyDeadline(input: DurableDeadlineDelivery<GroupLobbyDeadline>): void {
    installDurableDeadline({
        ...input, topicId: 'room-lobby.deadline', typeId: AppOutboxType.ROOM_LOBBY_DEADLINE,
        decode: decodeGroupLobbyDeadline, route: groupLobbyDeadlineRoute
    });
}
