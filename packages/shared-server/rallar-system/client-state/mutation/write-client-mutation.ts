import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { ClientStateEventCollisionError } from '../../state-events/client-state-event-store.ts';
import type { ClientStateEventCollisionRow } from '../../state-events/postgres/client-state-event-row-codec.ts';
import type { ClientMutationReceipt } from '../persistence/client-state-persistence-contracts.ts';
import type {
    ClientMutationComputedWrite,
    ClientMutationPersistence,
    ClientRuntimePersistenceOperation
} from './client-mutation-contracts.ts';

export async function writeClientMutation(
    transaction: PSqlSql,
    computed: ClientMutationComputedWrite
): Promise<ClientMutationReceipt> {
    for (const operation of computed.persistence.runtimeWrites) {
        await writeRuntimeState(transaction, operation);
    }
    if (computed.persistence.eventWrite) {
        await writeClientEvent(transaction, computed.persistence.eventWrite);
    }
    if (computed.outcome === 'write') {
        const outbox = new PSqlResourceInboxEntryRepository(transaction);
        for (const entry of computed.outboxEntries) {
            await outbox.writeIfAbsentOrMatch(entry);
        }
    }
    return computed.receipt;
}

async function writeRuntimeState(
    transaction: PSqlSql,
    operation: ClientRuntimePersistenceOperation
): Promise<void> {
    if (operation.kind === 'insert') {
        const rows = await transaction<Array<{ revision: number | string; }>>`
            insert into runtime_state_store (store_namespace, store_key, store_value,
                                             expire_at_ts, updated_ts, revision)
            values (${operation.namespace}, ${operation.key}, ${operation.value},
                    ${operation.expireAtIsoTimestamp}, now(), 0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `;
        requireApplied(rows);
        return;
    }
    const rows = await transaction<Array<{ revision: number | string; }>>`
        update runtime_state_store
        set store_value = ${operation.value},
            expire_at_ts = ${operation.expireAtIsoTimestamp},
            updated_ts = now(),
            revision = revision + 1
        where store_namespace = ${operation.namespace}
          and store_key = ${operation.key}
          and revision = ${operation.expectedRevision}
        returning revision
    `;
    requireApplied(rows);
}

async function writeClientEvent(
    transaction: PSqlSql,
    eventWrite: NonNullable<ClientMutationPersistence['eventWrite']>
): Promise<void> {
    const event = eventWrite.event;
    const inserted = await transaction<{ event_id: string; }[]>`
        insert into client_state_events (application_id,
                                         workspace_key,
                                         principal_id,
                                         event_id,
                                         event_type,
                                         snapshot_version,
                                         occurred_at_epoch_ms,
                                         client_instance_id,
                                         session_id,
                                         event_json)
        values (${event.applicationId},
                ${eventWrite.workspaceKey},
                ${event.principalId},
                ${event.eventId},
                ${event.eventType},
                ${event.snapshotVersion},
                ${event.occurredAtEpochMs},
                ${event.clientInstanceId ?? null},
                ${event.sessionId ?? null},
                ${eventWrite.eventJson})
        on conflict (application_id, workspace_key, principal_id, event_id)
            do nothing
        returning event_id
    `;
    if (inserted.length === 1) {
        return;
    }
    const [existing] = await transaction<ClientStateEventCollisionRow[]>`
        select application_id, workspace_key, principal_id, event_id,
               event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${event.applicationId}
          and workspace_key = ${eventWrite.workspaceKey}
          and principal_id = ${event.principalId}
          and event_id = ${event.eventId}
    `;
    if (!existing || !isExactClientEvent(existing, eventWrite)) {
        throw new ClientStateEventCollisionError(event);
    }
}

function isExactClientEvent(
    row: ClientStateEventCollisionRow,
    eventWrite: NonNullable<ClientMutationPersistence['eventWrite']>
): boolean {
    const event = eventWrite.event;
    return row.application_id === event.applicationId &&
        row.workspace_key === eventWrite.workspaceKey &&
        row.principal_id === event.principalId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.client_instance_id === event.clientInstanceId &&
        row.session_id === event.sessionId &&
        row.event_json === eventWrite.eventJson;
}

function requireApplied(rows: readonly Readonly<{ revision: number | string; }>[]): void {
    if (rows.length === 0) {
        throw new RuntimeStateWriteConflictError();
    }
}
