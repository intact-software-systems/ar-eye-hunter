import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RuntimeStateGuardedBatchWrite } from '../guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../optimistic-runtime-state-write.ts';
import { insertRuntimeState, type RuntimeStateInsert } from './insert-runtime-state.ts';
import { writeRuntimeStateGuardedBatch } from './write-runtime-state-guarded-batch.ts';

export interface RuntimeStateConditionalBatch {
    readonly creation: RuntimeStateInsert | null;
    readonly batch: RuntimeStateGuardedBatchWrite;
    readonly inserts: readonly RuntimeStateInsert[];
}

/** Strict absence for new rows, exact CAS for observed rows; the caller owns transaction and redelivery. */
export async function writeRuntimeStateConditionalBatch(
    transaction: PSqlSql,
    computed: RuntimeStateConditionalBatch
): Promise<void> {
    if (computed.creation !== null) {
        await insertRuntimeState(transaction, computed.creation);
    }
    const result = await writeRuntimeStateGuardedBatch(transaction, computed.batch);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
    for (const insert of computed.inserts) {
        await insertRuntimeState(transaction, insert);
    }
}
