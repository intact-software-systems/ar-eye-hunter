import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { RuntimeStateGuardedBatch } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { executeComputedRuntimeStateGuardedBatch } from '../../../../runtime-state/postgres/execute-runtime-state-guarded-batch.ts';
import { GroupStateEventCollisionError } from '../../../state-events/group-state-event-store.ts';
import type { GroupStateEventCollisionRow } from '../../../state-events/postgres/group-state-event-row-codec.ts';
import type {
    GroupMutationComputedWrite,
    GroupMutationPersistence,
    GroupMutationReceipt
} from '../group-mutation-contracts.ts';

export async function writeGroupMutation(
    transaction: PSqlSql,
    computed: GroupMutationComputedWrite
): Promise<GroupMutationReceipt> {
    await executeGuardedGroupMutationBatch(transaction, computed.persistence.guardedBatch);
    if (computed.persistence.lifecyclePolicyWrite) {
        await writeLifecyclePolicy(transaction, computed.persistence.lifecyclePolicyWrite);
    }
    await writeGroupEvent(transaction, computed.persistence.eventWrite);
    const outbox = new PSqlResourceInboxEntryRepository(transaction);
    for (const entry of computed.outboxEntries) {
        await outbox.writeIfAbsentOrMatch(entry);
    }
    return computed.receipt;
}

async function executeGuardedGroupMutationBatch(
    transaction: PSqlSql,
    batch: RuntimeStateGuardedBatch
): Promise<void> {
    const result = await executeComputedRuntimeStateGuardedBatch(transaction, batch);
    if (result.guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    for (const effect of result.effects) {
        if (effect.status !== 'applied') {
            throw new RuntimeStateWriteConflictError();
        }
    }
}

async function writeLifecyclePolicy(
    transaction: PSqlSql,
    policy: NonNullable<GroupMutationPersistence['lifecyclePolicyWrite']>
): Promise<void> {
    await transaction`
        insert into runtime_state_store (store_namespace, store_key, store_value,
                                         expire_at_ts, updated_ts, revision)
        values (${policy.namespace}, ${policy.key}, ${policy.value},
                ${policy.expireAtIsoTimestamp}, now(), 0)
        on conflict (store_namespace, store_key)
            do update set store_value = excluded.store_value,
                          expire_at_ts = excluded.expire_at_ts,
                          updated_ts = now(),
                          revision = runtime_state_store.revision + 1
    `;
}

async function writeGroupEvent(
    transaction: PSqlSql,
    eventWrite: GroupMutationPersistence['eventWrite']
): Promise<void> {
    const event = eventWrite.event;
    const inserted = await transaction<{ event_id: string; }[]>`
        insert into group_state_events (application_id,
                                        workspace_key,
                                        group_id,
                                        event_id,
                                        event_type,
                                        snapshot_version,
                                        occurred_at_epoch_ms,
                                        event_json)
        values (${event.applicationId},
                ${eventWrite.workspaceKey},
                ${event.groupId},
                ${event.eventId},
                ${event.eventType},
                ${event.snapshotVersion},
                ${event.occurredAtEpochMs},
                ${eventWrite.eventJson})
        on conflict (application_id, workspace_key, group_id, event_id)
            do nothing
        returning event_id
    `;
    if (inserted.length === 1) {
        return;
    }
    const [existing] = await transaction<GroupStateEventCollisionRow[]>`
        select application_id, workspace_key, group_id, event_id,
               event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${event.applicationId}
          and workspace_key = ${eventWrite.workspaceKey}
          and group_id = ${event.groupId}
          and event_id = ${event.eventId}
    `;
    if (!existing || !isExactGroupEvent(existing, eventWrite)) {
        throw new GroupStateEventCollisionError(event);
    }
}

function isExactGroupEvent(
    row: GroupStateEventCollisionRow,
    eventWrite: GroupMutationPersistence['eventWrite']
): boolean {
    const event = eventWrite.event;
    return row.application_id === event.applicationId &&
        row.workspace_key === eventWrite.workspaceKey &&
        row.group_id === event.groupId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.event_json === eventWrite.eventJson;
}
