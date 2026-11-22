import type { ViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type { Group } from '@shared/api/group-types.ts';
import { changeRoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '../../../rallar-server/rallar-server-app-inbox.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { computeRuntimeStateObservations, type RuntimeStateObservations } from '../../../runtime-state/observation/runtime-state-observation.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateObservationsCurrent } from '../../../runtime-state/postgres/read-runtime-state-observations-current.ts';
import { writeRuntimeStateConditionalBatch, type RuntimeStateConditionalBatch } from '../../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import { writeAppOutboxInserts } from '../../app-outbox/app-outbox-insert.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import { GROUPS_NAMESPACE } from '../persistence/group-state-runtime-namespaces.ts';
import { decodeGroupLobbyDeadline, installGroupLobbyDeadline, groupLobbyDeadlineRoute, type GroupLobbyDeadline } from './group-lobby-deadline.ts';
import { computeGroupLobbyPublication } from './compute-group-lobby-publication.ts';
import { computeGroupLobbyEffects, readGroupLobbyCommitments, type GroupLobbyRead } from './group-lobby-storage.ts';

export namespace GroupLobbyExpiry {
    export interface Dependencies {
        readonly database: PSqlSql;
        readonly appInbox: RallarServerAppInbox;
        readonly groups: GroupStateRepository;
        readonly nowEpochMs: () => number;
        readonly serviceId: string;
        readonly retentionMs: number;
    }
}

interface ExpiryRead {
    readonly group: RuntimeStateEntryValue<Group> | null;
    readonly state: Pick<GroupLobbyRead, 'accounts' | 'lobby'>;
    readonly command: GroupLobbyDeadline;
    readonly nowEpochMs: number;
    readonly traceId: string;
    readonly serviceId: string;
    readonly retentionMs: number;
}

/** The delayed delivery and all replaying workers share a single AppInbox command for this window. */
export class GroupLobbyExpiry {
    readonly expire: RallarServerAppInbox.Operation<GroupLobbyDeadline, GroupLobbyDeadline>;
    private readonly dependencies: GroupLobbyExpiry.Dependencies;

    constructor(dependencies: GroupLobbyExpiry.Dependencies) {
        this.dependencies = dependencies;
        this.expire = dependencies.appInbox.register({
            type: 'app:rallar-room-lobby:expire',
            decodeEnvelope: ({ data }) => decodeGroupLobbyDeadline(data),
            encodeEnvelope: command => ({ data: decodeJsonWireValue(command, 'Lobby deadline') }),
            toBinding: command => {
                const { contextId, resourceId } = groupLobbyDeadlineRoute(command);
                return { contextId, resourceId };
            },
            toLogicalCommand: command => decodeJsonWireValue(command, 'Lobby expiry'),
            materialize: command => command,
            encodeResult: result => decodeJsonWireValue(result, 'Lobby expiry result'),
            decodeResult: (value, command) => {
                const result = decodeGroupLobbyDeadline(value);
                if (!jsonEquals(result, command)) throw new TypeError('Lobby expiry result differs from its command');
                return result;
            },
            handle: (command, context) => this.releaseDueSeats(command, context)
        });
    }

    listen(outboxQueueReader: OutboxQueueReader): void {
        installGroupLobbyDeadline({
            outboxQueueReader, database: this.dependencies.database, retentionMs: this.dependencies.retentionMs, nowEpochMs: this.dependencies.nowEpochMs,
            enqueue: async (command, traceId) => {
                const result = await this.expire.enqueue({ command, traceId });
                if (result.left) throw new Error(result.left.message);
            }
        });
    }

    private async releaseDueSeats(command: GroupLobbyDeadline, context: AppInboxMessageContext<GroupLobbyDeadline>): Promise<GroupLobbyDeadline> {
        const { groups, serviceId, retentionMs } = this.dependencies;
        const nowEpochMs = this.dependencies.nowEpochMs();
        if (nowEpochMs < command.dueAtEpochMs) throw new Error('Lobby deadline is not due');
        const [group, state] = await Promise.all([
            groups.findGroupEntry(command.roomRef), readGroupLobbyCommitments({ repository: groups, roomRef: command.roomRef, principalIds: [], mode: 'expired' })
        ]);
        const read = { group: group ?? null, state, command, nowEpochMs, traceId: context.message.id.traceId, serviceId, retentionMs };
        const computed = computeExpiry(read);
        const issue = validateComputedProjection(computeExpiry(read), computed, 'Lobby expiry')[0];
        if (issue) throw issue.cause;
        return this.dependencies.appInbox.commit(context, command, async transaction => {
            if (!computed) return;
            await writeRuntimeStateConditionalBatch(transaction, computed.storage);
            if (!(await readRuntimeStateObservationsCurrent(transaction, computed.group))) throw new RuntimeStateWriteConflictError();
            await writeAppOutboxInserts(transaction, computed.outbox);
        });
    }
}

interface LobbyExpiryWrite {
    readonly storage: RuntimeStateConditionalBatch;
    readonly group: RuntimeStateObservations;
    readonly outbox: ViewInvalidationPublication['outbox'];
}

function computeExpiry(read: ExpiryRead): LobbyExpiryWrite | null {
    const { command, group, state, nowEpochMs } = read;
    const before = state.lobby?.value;
    if (!before || before.activationId !== command.activationId || group && group.value.created.atEpochMs !== command.groupCreatedAtEpochMs) return null;
    if (command.kind === 'room' && before.expiresAtEpochMs !== command.dueAtEpochMs) return null;
    if (command.kind === 'seat' && (group?.value.status !== 'active' || before.expiresAtEpochMs !== null && before.expiresAtEpochMs <= nowEpochMs)) return null;
    const lobby = command.kind === 'room' ? null : changeRoomLobby(before, {
        kind: 'expire', generation: command.generation, dueAtEpochMs: command.dueAtEpochMs
    }, nowEpochMs).lobby;
    if (before === lobby) return null;
    const [first, ...effects] = computeGroupLobbyEffects({
        read: state,
        after: lobby,
        roomRef: command.roomRef,
        mode: command.kind === 'room' ? 'expired' : 'active'
    });
    if (!state.lobby || !first || (first.operation !== 'update-exact' && first.operation !== 'delete')) {
        throw new TypeError('Lobby expiry requires the observed lobby predecessor');
    }
    const publication = computeGroupLobbyPublication({
        roomRef: command.roomRef, groupCreatedAtEpochMs: command.groupCreatedAtEpochMs,
        before, after: lobby, createdAtEpochMs: nowEpochMs, retentionMs: read.retentionMs, serviceId: read.serviceId, traceId: read.traceId
    });
    const { effectId: _effectId, ...predecessor } = first;
    // A raw TTL can evict the group. Fence the exact activation when expiring its durable lobby.
    const guard = predecessor.operation === 'delete' ? {
        ...predecessor, operation: 'update-exact' as const, expectedValue: state.lobby.entry.value,
        value: state.lobby.entry.value, expireAtTimestamp: 0
    } : predecessor;
    return {
        storage: { creation: null, inserts: [], batch: computeRuntimeStateGuardedBatchWrite({ guard, effects: [...effects, ...publication.provenance] }) },
        group: computeRuntimeStateObservations(group ? [{ namespace: GROUPS_NAMESPACE, key: group.entry.key, entry: group.entry }] : []),
        outbox: publication.outbox
    };
}
