import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { writeRuntimeStateGuardedBatch } from '../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import type { FriendsMutationComputed } from './friends-mutation-contracts.ts';

export async function writeFriendsMutation(transaction: PSqlSql, computed: FriendsMutationComputed): Promise<void> {
    if (computed.storage === null) {
        return;
    }
    const result = await writeRuntimeStateGuardedBatch(transaction, computed.storage);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
}
