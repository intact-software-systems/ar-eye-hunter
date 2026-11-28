import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { RuntimeStateGuardedBatchDelete } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';

/**
 * The disconnect's conditional delete of the holder record it read, inside the disconnect's own transaction. A record
 * that changed or went since the read is a conflict, which rolls the attempt back for a fresh read.
 */
export async function writeWsConnectionHolderReleased(
    transaction: PSqlSql,
    release: RuntimeStateGuardedBatchDelete
): Promise<void> {
    requireConditionalWrite(
        await createTransactionBoundPSqlRuntimeStateRepository(transaction).deleteIfRevision(
            release.namespace,
            release.key,
            release.expectedRevision
        )
    );
}
