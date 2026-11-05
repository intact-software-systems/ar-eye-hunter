import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateObservationsCurrent } from '../../runtime-state/postgres/read-runtime-state-observations-current.ts';
import { writeRuntimeStateGuardedBatch } from '../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import { writeAppOutboxInserts } from '../app-outbox/app-outbox-insert.ts';
import type { FriendsMutationComputed } from './friends-mutation-contracts.ts';

/** Changed profiles commit only while the observed session, unchanged profiles and visibility audience still hold. */
export async function writeFriendsMutation(transaction: PSqlSql, computed: FriendsMutationComputed): Promise<void> {
    if (computed.storage !== null) {
        const result = await writeRuntimeStateGuardedBatch(transaction, computed.storage);
        if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
            throw new RuntimeStateWriteConflictError();
        }
    }
    if (!(await readRuntimeStateObservationsCurrent(transaction, computed.observations))) {
        throw new RuntimeStateWriteConflictError();
    }
    await writeAppOutboxInserts(transaction, computed.outbox);
}
