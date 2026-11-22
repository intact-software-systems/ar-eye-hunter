import { Temporal } from '@js-temporal/polyfill';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { ResourceInboxHandlerFinalizedSuccess } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { writeResourceInboxRetainedReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export interface RoomLobbyDeadlineIdentity {
    readonly roomRef: GroupRef;
    readonly activationId: string;
    readonly groupCreatedAtEpochMs: number;
    readonly dueAtEpochMs: number;
}

export type RoomLobbyDeadline = RoomLobbyDeadlineIdentity & (
    { readonly kind: 'seat'; readonly generation: number } | { readonly kind: 'room' }
);

export function decodeRoomLobbyDeadline(value: unknown): RoomLobbyDeadline {
    const row = requireRecord(value, 'Room lobby deadline');
    const keys = ['kind', 'roomRef', 'activationId', 'groupCreatedAtEpochMs', 'dueAtEpochMs'];
    requireExactKeys(row, row.kind === 'seat' ? [...keys, 'generation'] : keys, 'Room lobby deadline');
    const ref = requireRecord(row.roomRef, 'Room lobby deadline room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Room lobby deadline room');
    const roomRef = assertValidRallarGroupRef(ref);
    requireString(row.activationId, 'Lobby activation');
    requireEpoch(row.groupCreatedAtEpochMs, 'Room creation time');
    requireEpoch(row.dueAtEpochMs, 'Lobby window deadline');
    const identity = {
        roomRef, activationId: row.activationId,
        groupCreatedAtEpochMs: row.groupCreatedAtEpochMs,
        dueAtEpochMs: row.dueAtEpochMs
    };
    if (row.kind === 'room') return { ...identity, kind: 'room' };
    if (row.kind !== 'seat') throw new TypeError('Unexpected lobby deadline kind');
    requirePositiveInteger(row.generation, 'Lobby window generation');
    return { ...identity, kind: 'seat', generation: Number(row.generation) };
}

export function roomLobbyDeadlineRoute(deadline: RoomLobbyDeadline) {
    return toAppQueueKey({
        topicId: 'room-lobby.deadline',
        resourceId: computeSha256CanonicalJson(deadline),
        contextId: groupStateGroupStorageKey(deadline.roomRef)
    });
}

export function installRoomLobbyDeadline(input: {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly database: PSqlSql;
    readonly retentionMs: number;
    readonly nowEpochMs: () => number;
    readonly enqueue: (command: RoomLobbyDeadline, traceId: string) => Promise<void>;
}): void {
    input.outboxQueueReader.onOutboxMessageDo(AppOutboxType.ROOM_LOBBY_DEADLINE, {
        onMessage: async (message, entry) => {
            const deadline = decodeRoomLobbyDeadline(JSON.parse(message.payload.resource));
            const route = roomLobbyDeadlineRoute(deadline);
            if (!jsonEquals(message.route, route) || message.id.msgId !== route.resourceId ||
                message.payload.typeId !== AppOutboxType.ROOM_LOBBY_DEADLINE || message.targets !== undefined ||
                message.constraints?.expiresAtMs !== NEVER_EXPIRE_AT_TIMESTAMP) {
                throw new TypeError('Lobby deadline envelope differs from its window');
            }
            if (input.nowEpochMs() < deadline.dueAtEpochMs) throw new Error('Lobby window is still open');
            await input.enqueue(deadline, message.id.traceId);
            // A crash between admission and finishing the wake repeats the same durable AppInbox command.
            const completedAt = input.nowEpochMs();
            const expiresAt = completedAt + input.retentionMs;
            const finished = await writeResourceInboxRetainedReservationFinish(input.database, {
                key: entry.key, expectedAttempts: entry.dequeueAudit.attempts, status: EntityStatus.COMPLETED,
                completedAt: new Date(completedAt), expiresAt: new Date(expiresAt)
            });
            if (!finished) throw new Error('Lobby deadline reservation has changed');
            return new ResourceInboxHandlerFinalizedSuccess({
                ...entry, status: EntityStatus.COMPLETED,
                audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAt) },
                dequeueAudit: { ...entry.dequeueAudit, endTs: Temporal.Instant.fromEpochMilliseconds(completedAt), nextTs: undefined }
            });
        }
    }, ['room-lobby.deadline']);
}
