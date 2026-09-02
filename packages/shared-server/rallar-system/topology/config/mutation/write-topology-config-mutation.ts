import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository
} from '../../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalRepositoryLike,
    RuntimeStateConditionalWriteResult
} from '../../../../runtime-state/runtime-state-repository.ts';
import { writeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import type {
    GroupTopologyConfigMutationComputed,
    TopologyConfigRuntimeWrite
} from './group-topology-config-mutation-contracts.ts';

type WritableTopologyConfigMutation = Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim'; }>;

export interface WriteTopologyConfigMutationInput {
    readonly transaction: PSqlSql;
    readonly computed: WritableTopologyConfigMutation;
}

export async function writeTopologyConfigMutation(
    input: WriteTopologyConfigMutationInput
): Promise<GroupTopologyConfigMutationReceipt> {
    const computed = input.computed;
    const runtime = createTransactionBoundPSqlRuntimeStateRepository(input.transaction);
    for (const write of computed.runtimeWrites) {
        requireAcceptedTopologyConfigWrite(
            write,
            await executeTopologyConfigRuntimeWrite(runtime, write)
        );
    }
    if (computed.outcome === 'write') {
        await writeAppOutboxInsert(input.transaction, computed.outboxWrite);
    }
    return computed.receipt;
}

async function executeTopologyConfigRuntimeWrite(
    repository: RuntimeStateConditionalRepositoryLike,
    write: TopologyConfigRuntimeWrite
): Promise<RuntimeStateConditionalWriteResult | RuntimeStateConditionalDeleteResult> {
    switch (write.operation) {
        case 'insert':
            return await repository.insertIfAbsent(
                write.namespace,
                write.key,
                write.value,
                write.expireAtIsoTimestamp
            );
        case 'update':
            return await repository.upsertIfRevision(
                write.namespace,
                write.key,
                write.value,
                write.expireAtIsoTimestamp,
                write.expectedRevision
            );
        case 'delete':
            return await repository.deleteIfRevision(
                write.namespace,
                write.key,
                write.expectedRevision
            );
    }
}

function requireAcceptedTopologyConfigWrite(
    write: TopologyConfigRuntimeWrite,
    result: RuntimeStateConditionalWriteResult | RuntimeStateConditionalDeleteResult
): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (write.operation === 'delete') {
        return;
    }
    if (!('revision' in result) || result.revision !== write.expectedResultRevision) {
        throw new RuntimeStateWriteConflictError();
    }
}
