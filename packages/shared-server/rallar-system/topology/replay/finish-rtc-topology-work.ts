import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '../../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';

export async function finishRtcTopologyWork(
    database: PSqlSql,
    entry: ResourceEntry
): Promise<void> {
    await runInPSqlTransaction(database, async (transaction) => {
        await finishRtcTopologyReservation(transaction, entry);
    });
}

export async function finishRtcTopologyReservation(
    transaction: PSqlSql,
    entry: ResourceEntry
): Promise<void> {
    const finished = await createPSqlResourceInboxRepository(
        transaction
    ).finalization.finishReserved(
        entry.key,
        entry.dequeueAudit.attempts,
        EntityStatus.COMPLETED,
        new Date()
    );
    if (!finished) {
        throw new RuntimeStateWriteConflictError();
    }
}
