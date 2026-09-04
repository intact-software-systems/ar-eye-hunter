import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../../postgres/run-in-p-sql-transaction.ts';
import {
    writeResourceInboxReservationFinish,
    type ResourceInboxReservationFinish
} from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';

export async function writeRtcTopologyWorkCompletion(
    database: PSqlSql,
    computed: ResourceInboxReservationFinish
): Promise<void> {
    await runInPSqlTransaction(database, async (transaction) => {
        await finishRtcTopologyReservation(transaction, computed);
    });
}

export function computeRtcTopologyReservationFinish(
    entry: ResourceEntry,
    completedAt: Date
): ResourceInboxReservationFinish {
    return {
        key: { ...entry.key },
        expectedAttempts: entry.dequeueAudit.attempts,
        status: EntityStatus.COMPLETED,
        completedAt
    };
}

export async function finishRtcTopologyReservation(
    transaction: PSqlSql,
    computed: ResourceInboxReservationFinish
): Promise<void> {
    const finished = await writeResourceInboxReservationFinish(transaction, computed);
    if (!finished) {
        throw new RuntimeStateWriteConflictError();
    }
}
