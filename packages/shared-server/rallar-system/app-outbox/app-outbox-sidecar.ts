import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';

/** A `runtime_state_store` row an app outbox row's producer writes beside it, in the same statement. */
export interface AppOutboxSidecarRow {
    readonly namespace: string;
    readonly key: string;
    /** The stored value, encoded by the producer's compute. */
    readonly value: string;
    readonly expiresAt: string;
}

/**
 * Insert-only: a live row already under the key is left as it is and returns nothing, which its caller reports;
 * an expired one is written over, one revision past it.
 */
export function toAppOutboxSidecarInsert(rows: readonly AppOutboxSidecarRow[]): PSqlFragment {
    const values = rows.map(({ namespace, key, value, expiresAt }) => ({ namespace, key, value, expiresAt }));
    return PSqlFragment.of`
        insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        select indexed.namespace, indexed.key, indexed.value, indexed."expiresAt"::timestamptz, now(), 0
        from jsonb_to_recordset(${values}::jsonb) as indexed(namespace text, key text, value text, "expiresAt" text)
        on conflict (store_namespace, store_key) do update
            set store_value = excluded.store_value,
                expire_at_ts = excluded.expire_at_ts,
                updated_ts = now(),
                revision = runtime_state_store.revision + 1
            where runtime_state_store.expire_at_ts <= now()
        returning store_namespace, store_key`;
}
