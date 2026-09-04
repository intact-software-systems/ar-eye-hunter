import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type {
    RuntimeStateGuardedBatchResult,
    RuntimeStateGuardedBatchWrite
} from '../guarded-batch/runtime-state-guarded-batch.ts';
import {
    decodeComputedRuntimeStateGuardedBatchRows,
    type RuntimeStateGuardedBatchDatabaseRow
} from './decode-runtime-state-guarded-batch-rows.ts';

export async function writeRuntimeStateGuardedBatch(
    sql: PSqlSql,
    computed: RuntimeStateGuardedBatchWrite
): Promise<RuntimeStateGuardedBatchResult> {
    const batch = computed;
    const rows = await sql<RuntimeStateGuardedBatchDatabaseRow[]>`
        with guard_input as (
            select descriptor ->> 'operation' as operation,
                   descriptor ->> 'namespace' as store_namespace,
                   descriptor ->> 'key' as store_key,
                   descriptor ->> 'value' as store_value,
                   (descriptor ->> 'expireAtTimestamp')::timestamptz as expire_at_ts,
                   (descriptor ->> 'expectedRevision')::bigint as expected_revision
            from (select ${computed.guardSqlDescriptor}::jsonb as descriptor) guard_json
        ),
        effect_input as (
            select descriptor ->> 'effectId' as effect_id,
                   descriptor ->> 'operation' as operation,
                   descriptor ->> 'namespace' as store_namespace,
                   descriptor ->> 'key' as store_key,
                   descriptor ->> 'value' as store_value,
                   (descriptor ->> 'expireAtTimestamp')::timestamptz as expire_at_ts,
                   (descriptor ->> 'expectedRevision')::bigint as expected_revision
            from jsonb_array_elements(${computed.effectSqlDescriptors}::jsonb) descriptor
        ),
        guard_insert as (
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            select store_namespace,
                   store_key,
                   store_value,
                   expire_at_ts,
                   now(),
                   0
            from guard_input
            where operation = 'insert'
            on conflict (store_namespace, store_key) do nothing
            returning 'insert'::text as operation,
                      store_namespace,
                      store_key,
                      revision
        ),
        guard_update as (
            update runtime_state_store target
            set store_value = descriptor.store_value,
                expire_at_ts = descriptor.expire_at_ts,
                updated_ts = now(),
                revision = target.revision + 1
            from guard_input descriptor
            where descriptor.operation = 'update'
              and target.store_namespace = descriptor.store_namespace
              and target.store_key = descriptor.store_key
              and target.revision = descriptor.expected_revision
            returning 'update'::text as operation,
                      target.store_namespace,
                      target.store_key,
                      target.revision
        ),
        guard_delete as (
            delete from runtime_state_store target
            using guard_input descriptor
            where descriptor.operation = 'delete'
              and target.store_namespace = descriptor.store_namespace
              and target.store_key = descriptor.store_key
              and target.revision = descriptor.expected_revision
            returning 'delete'::text as operation,
                      target.store_namespace,
                      target.store_key,
                      target.revision
        ),
        authority as (
            select operation, store_namespace, store_key, revision
            from guard_insert
            union all
            select operation, store_namespace, store_key, revision
            from guard_update
            union all
            select operation, store_namespace, store_key, revision
            from guard_delete
        ),
        effect_insert as (
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            select descriptor.store_namespace,
                   descriptor.store_key,
                   descriptor.store_value,
                   descriptor.expire_at_ts,
                   now(),
                   0
            from effect_input descriptor
            cross join authority
            where descriptor.operation = 'insert'
            on conflict (store_namespace, store_key) do nothing
            returning store_namespace, store_key, revision
        ),
        effect_update as (
            update runtime_state_store target
            set store_value = descriptor.store_value,
                expire_at_ts = descriptor.expire_at_ts,
                updated_ts = now(),
                revision = target.revision + 1
            from effect_input descriptor
            cross join authority
            where descriptor.operation = 'update'
              and target.store_namespace = descriptor.store_namespace
              and target.store_key = descriptor.store_key
              and target.revision = descriptor.expected_revision
            returning target.store_namespace,
                      target.store_key,
                      target.revision
        ),
        effect_delete as (
            delete from runtime_state_store target
            using effect_input descriptor, authority
            where descriptor.operation = 'delete'
              and target.store_namespace = descriptor.store_namespace
              and target.store_key = descriptor.store_key
              and target.revision = descriptor.expected_revision
            returning target.store_namespace,
                      target.store_key,
                      target.revision
        ),
        effect_put as (
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            select descriptor.store_namespace,
                   descriptor.store_key,
                   descriptor.store_value,
                   descriptor.expire_at_ts,
                   now(),
                   0
            from effect_input descriptor
            cross join authority
            where descriptor.operation = 'put'
            on conflict (store_namespace, store_key)
                do update set store_value = excluded.store_value,
                              expire_at_ts = excluded.expire_at_ts,
                              updated_ts = now(),
                              revision = runtime_state_store.revision + 1
            returning store_namespace, store_key, revision
        ),
        effect_insert_result as (
            select descriptor.effect_id,
                   descriptor.operation,
                   mutation.store_namespace,
                   mutation.store_key,
                   mutation.revision
            from effect_insert mutation
            join effect_input descriptor
              on descriptor.store_namespace = mutation.store_namespace
             and descriptor.store_key = mutation.store_key
             and descriptor.operation = 'insert'
        ),
        effect_update_result as (
            select descriptor.effect_id,
                   descriptor.operation,
                   mutation.store_namespace,
                   mutation.store_key,
                   mutation.revision
            from effect_update mutation
            join effect_input descriptor
              on descriptor.store_namespace = mutation.store_namespace
             and descriptor.store_key = mutation.store_key
             and descriptor.operation = 'update'
        ),
        effect_delete_result as (
            select descriptor.effect_id,
                   descriptor.operation,
                   mutation.store_namespace,
                   mutation.store_key,
                   mutation.revision
            from effect_delete mutation
            join effect_input descriptor
              on descriptor.store_namespace = mutation.store_namespace
             and descriptor.store_key = mutation.store_key
             and descriptor.operation = 'delete'
        ),
        effect_put_result as (
            select descriptor.effect_id,
                   descriptor.operation,
                   mutation.store_namespace,
                   mutation.store_key,
                   mutation.revision
            from effect_put mutation
            join effect_input descriptor
              on descriptor.store_namespace = mutation.store_namespace
             and descriptor.store_key = mutation.store_key
             and descriptor.operation = 'put'
        )
        select 'guard'::text as result_kind,
               null::text as effect_id,
               operation,
               store_namespace,
               store_key,
               revision
        from authority
        union all
        select 'effect'::text as result_kind,
               effect_id,
               operation,
               store_namespace,
               store_key,
               revision
        from effect_insert_result
        union all
        select 'effect'::text as result_kind,
               effect_id,
               operation,
               store_namespace,
               store_key,
               revision
        from effect_update_result
        union all
        select 'effect'::text as result_kind,
               effect_id,
               operation,
               store_namespace,
               store_key,
               revision
        from effect_delete_result
        union all
        select 'effect'::text as result_kind,
               effect_id,
               operation,
               store_namespace,
               store_key,
               revision
        from effect_put_result
    `;

    return decodeComputedRuntimeStateGuardedBatchRows(batch, rows);
}
