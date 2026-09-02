import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeAppOutboxInsertOrMatch } from '../../../app-outbox/app-outbox-insert.ts';
import { writeGroupLifecyclePolicy } from '../../persistence/group-lifecycle-policy-repository.ts';
import { createTransactionBoundGroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupMutationComputedWrite, GroupMutationReceipt } from '../group-mutation-contracts.ts';

export async function writeGroupMutation(
    transaction: PSqlSql,
    computed: GroupMutationComputedWrite
): Promise<GroupMutationReceipt> {
    const runtime = createTransactionBoundPSqlRuntimeStateRepository(transaction);
    const repository = createTransactionBoundGroupStateRepository(transaction);
    const result = await runtime.executeGuardedBatch(computed.guardedBatch);
    if (result.guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    for (const effect of result.effects) {
        if (effect.status !== 'applied') {
            throw new RuntimeStateWriteConflictError();
        }
    }
    if (computed.lifecyclePolicyWrite !== null) {
        await writeGroupLifecyclePolicy(transaction, computed.lifecyclePolicyWrite);
    }
    await repository.appendEvent(computed.eventWrite);
    for (const outboxWrite of computed.outboxWrites) {
        await writeAppOutboxInsertOrMatch(transaction, outboxWrite);
    }
    return computed.receipt;
}
