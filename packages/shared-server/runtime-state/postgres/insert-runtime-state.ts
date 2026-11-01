import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../optimistic-runtime-state-write.ts';

export interface RuntimeStateInsert {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
}

/** Requires physical absence, including expired rows; the caller owns the transaction and retry. */
export async function insertRuntimeState(transaction: PSqlSql, input: RuntimeStateInsert): Promise<void> {
    const rows = await transaction<Array<{ revision: number | string; }>>`
        insert into runtime_state_store (store_namespace, store_key, store_value,
                                         expire_at_ts, updated_ts, revision)
        values (${input.namespace}, ${input.key}, ${input.value},
                ${input.expireAtIsoTimestamp}, now(), 0)
        on conflict (store_namespace, store_key) do nothing
        returning revision
    `;
    if (rows.length === 0) {
        throw new RuntimeStateWriteConflictError();
    }
}
