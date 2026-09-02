import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { decodeRuntimeStateRevision } from '../../../../runtime-state/postgres/runtime-state-row-codec.ts';
import type { RtcTopologyOutboxWriter } from '../../mutation/rtc-topology-outbox-writer.ts';
import type {
    GroupTopologyConfigMutationComputed,
    TopologyConfigRuntimeWrite
} from './group-topology-config-mutation-contracts.ts';

type WritableTopologyConfigMutation = Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim'; }>;

export interface WriteTopologyConfigMutationInput {
    readonly transaction: PSqlSql;
    readonly computed: WritableTopologyConfigMutation;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export async function writeTopologyConfigMutation(
    input: WriteTopologyConfigMutationInput
): Promise<GroupTopologyConfigMutationReceipt> {
    for (const write of input.computed.runtimeWrites) {
        await executeTopologyConfigRuntimeWrite(input.transaction, write);
    }
    if (input.computed.outcome === 'write') {
        await input.outboxWriter.write(input.transaction, input.computed.outboxWrite);
    }
    return input.computed.receipt;
}

async function executeTopologyConfigRuntimeWrite(
    transaction: PSqlSql,
    write: TopologyConfigRuntimeWrite
): Promise<void> {
    switch (write.operation) {
        case 'insert':
            requireExpectedRevision(write, await insertRuntimeState(transaction, write));
            return;
        case 'update':
            requireExpectedRevision(write, await updateRuntimeState(transaction, write));
            return;
        case 'delete':
            if (!await deleteRuntimeState(transaction, write)) {
                throw new RuntimeStateWriteConflictError();
            }
    }
}

async function insertRuntimeState(
    transaction: PSqlSql,
    write: Extract<TopologyConfigRuntimeWrite, { operation: 'insert'; }>
): Promise<number | null> {
    const rows = await transaction<readonly { revision: number | string; }[]>`
        insert into runtime_state_store (store_namespace,
                                         store_key,
                                         store_value,
                                         expire_at_ts,
                                         updated_ts,
                                         revision)
        values (${write.namespace},
                ${write.key},
                ${write.value},
                ${write.expireAtIsoTimestamp},
                now(),
                0)
        on conflict (store_namespace, store_key) do nothing
        returning revision
    `;
    return rows[0] ? decodeRuntimeStateRevision(rows[0].revision) : null;
}

async function updateRuntimeState(
    transaction: PSqlSql,
    write: Extract<TopologyConfigRuntimeWrite, { operation: 'update'; }>
): Promise<number | null> {
    const rows = await transaction<readonly { revision: number | string; }[]>`
        update runtime_state_store
        set store_value = ${write.value},
            expire_at_ts = ${write.expireAtIsoTimestamp},
            updated_ts = now(),
            revision = revision + 1
        where store_namespace = ${write.namespace}
          and store_key = ${write.key}
          and revision = ${write.expectedRevision}
        returning revision
    `;
    return rows[0] ? decodeRuntimeStateRevision(rows[0].revision) : null;
}

async function deleteRuntimeState(
    transaction: PSqlSql,
    write: Extract<TopologyConfigRuntimeWrite, { operation: 'delete'; }>
): Promise<boolean> {
    const rows = await transaction<readonly { revision: number | string; }[]>`
        delete from runtime_state_store
        where store_namespace = ${write.namespace}
          and store_key = ${write.key}
          and revision = ${write.expectedRevision}
        returning revision
    `;
    return rows.length === 1;
}

function requireExpectedRevision(
    write: Extract<TopologyConfigRuntimeWrite, { operation: 'insert' | 'update'; }>,
    revision: number | null
): void {
    if (revision !== write.expectedResultRevision) {
        throw new RuntimeStateWriteConflictError();
    }
}
