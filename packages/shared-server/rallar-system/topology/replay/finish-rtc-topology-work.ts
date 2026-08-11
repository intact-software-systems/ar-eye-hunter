import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql, PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import {
  ResourceInboxRepository,
} from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
import {
  RuntimeStateWriteConflictError,
} from '../../../runtime-state/optimistic-runtime-state-write.ts';

export async function finishRtcTopologyWork(
  database: PSqlSql,
  entry: ResourceEntry,
): Promise<void> {
  await runInTransaction(database, async (transaction) => {
    await finishRtcTopologyReservation(transaction, entry);
  });
}

export async function finishRtcTopologyReservation(
  transaction: PSqlTransactionSql,
  entry: ResourceEntry,
): Promise<void> {
  const finished = await new ResourceInboxRepository(transaction).finishReserved(
    entry.key,
    entry.dequeueAudit.attempts,
    EntityStatus.COMPLETED,
    new Date(),
  );
  if (!finished) {
    throw new RuntimeStateWriteConflictError();
  }
}
