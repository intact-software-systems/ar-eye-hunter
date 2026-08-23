import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { advanceGroupStateAuthorityFence } from '../../../group-state/persistence/group-aggregate-repository.ts';
import { writeRtcTopologyOutbox } from '../../mutation/rtc-topology-outbox-entry.ts';
import { GroupTopologyConfigRepository } from '../persistence/group-topology-config-repository.ts';
import type * as mutationContracts from './group-topology-config-mutation-contracts.ts';

type WritableTopologyConfigMutation = Extract<
    mutationContracts.GroupTopologyConfigMutationComputed,
    { outcome: 'write' | 'claim'; }
>;

export async function writeTopologyConfigMutation(
    transaction: PSqlSql,
    computed: WritableTopologyConfigMutation
): Promise<mutationContracts.GroupTopologyConfigMutationReceipt> {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const repository = new GroupTopologyConfigRepository(runtime);
    await writeTopologyConfigAuthorityFence(runtime, computed);

    if (computed.outcome === 'write') {
        await writeTopologyConfigState(repository, computed);
    }
    if (computed.idempotency) {
        requireAcceptedTopologyConfigWrite(await repository.insertMutationRecord(computed.idempotency));
    }
    if (computed.outcome === 'write') {
        await writeRtcTopologyOutbox(transaction, computed.outbox);
    }
    return computed.receipt;
}

async function writeTopologyConfigAuthorityFence(
    runtime: PSqlRuntimeStateRepository,
    computed: WritableTopologyConfigMutation
): Promise<void> {
    const authorityFence = await advanceGroupStateAuthorityFence(runtime, computed.groupAuthorityGuard);
    if (
        authorityFence.status === 'conflict' ||
        authorityFence.revision !== computed.groupAuthorityGuard.entry.revision + 1
    ) {
        throw new RuntimeStateWriteConflictError();
    }
}

async function writeTopologyConfigState(
    repository: GroupTopologyConfigRepository,
    computed: Extract<WritableTopologyConfigMutation, { outcome: 'write'; }>
): Promise<void> {
    requireAcceptedTopologyConfigWrite(await writeTopologyConfigTarget(repository, computed));
    requireAcceptedTopologyConfigWrite(
        await repository.commitInvariantGeneration(
            computed.invariantGenerationGuard.value,
            computed.invariantGenerationGuard.expectedRevision
        )
    );
    requireAcceptedTopologyConfigWrite(
        await repository.commitGeneration(
            computed.generationGuard.value,
            computed.generationGuard.expectedRevision
        )
    );
}

async function writeTopologyConfigTarget(
    repository: GroupTopologyConfigRepository,
    computed: Extract<WritableTopologyConfigMutation, { outcome: 'write'; }>
): Promise<Readonly<{ status: 'accepted' | 'conflict'; }>> {
    const guard = computed.guard;
    if (guard.operation === 'delete') {
        return guard.target === 'config'
            ? await repository.deleteConfig(computed.receipt.groupRef, guard.expectedRevision)
            : await repository.deleteOverride(computed.receipt.groupRef, guard.expectedRevision);
    }
    return guard.target === 'config'
        ? await repository.commitConfig(guard.value, guard.expectedRevision)
        : await repository.commitOverride(guard.value, guard.expectedRevision);
}

function requireAcceptedTopologyConfigWrite(
    result: Readonly<{ status: 'accepted' | 'conflict'; }>
): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}
