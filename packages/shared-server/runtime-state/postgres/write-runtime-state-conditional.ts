import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RuntimeStateConditionalWrite } from '../compute-runtime-state-conditional-write.ts';
import type { RuntimeStateConditionalWriteResult } from '../runtime-state-repository.ts';
import { decodeRuntimeStateRevision } from './runtime-state-row-codec.ts';

/** Shared by prepared domain writes and repository methods; SQL alone decides absence, expiry, and exact revision. */
export async function writeRuntimeStateConditional(
    sql: PSqlSql,
    input: RuntimeStateConditionalWrite
): Promise<RuntimeStateConditionalWriteResult> {
    const rows = input.operation === 'insert'
        ? await sql<Array<{ revision: number | string; }>>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${input.namespace}, ${input.key}, ${input.value}, ${input.expireAtIsoTimestamp}, now(), 0)
            on conflict (store_namespace, store_key) do update
                set store_value = excluded.store_value,
                    expire_at_ts = excluded.expire_at_ts,
                    updated_ts = now(),
                    revision = runtime_state_store.revision + 1
                where runtime_state_store.expire_at_ts <= now()
            returning revision
        `
        : await sql<Array<{ revision: number | string; }>>`
            update runtime_state_store
            set store_value = ${input.value},
                expire_at_ts = ${input.expireAtIsoTimestamp},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${input.namespace}
              and store_key = ${input.key}
              and revision = ${input.expectedRevision}
            returning revision
        `;
    return rows[0]
        ? { status: 'applied', revision: decodeRuntimeStateRevision(rows[0].revision) }
        : { status: 'conflict' };
}
