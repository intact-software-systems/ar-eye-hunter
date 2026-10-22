import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    toResourceInboxEntryInsert,
    toResourceInboxEntryInsertRow,
    type ResourceInboxEntryInsertValues
} from './resource-inbox-entry-insert-values.ts';
import type { ResourceInboxRow } from './resource-inbox-row-codec.ts';

export async function writeResourceInboxEntryIfAbsentOrExpired(
    sql: PSqlSql,
    values: ResourceInboxEntryInsertValues
): Promise<ResourceInboxRow[]> {
    return await writeResourceInboxEntriesIfAbsentOrExpired(sql, [values]);
}

/**
 * Every row in one statement and in the given order, each written where its key holds no row or an expired one;
 * a key whose row is still live keeps it and is missing from the answer.
 */
export async function writeResourceInboxEntriesIfAbsentOrExpired(
    sql: PSqlSql,
    values: readonly ResourceInboxEntryInsertValues[]
): Promise<ResourceInboxRow[]> {
    const statement = PSqlFragment.of`${toResourceInboxEntryInsert(values.map(toResourceInboxEntryInsertRow))}
        on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
            do update set ri_resource = excluded.ri_resource,
                          ri_type_id = excluded.ri_type_id,
                          ri_status = excluded.ri_status,
                          system_date = excluded.system_date,
                          created_by = excluded.created_by,
                          created_ts = excluded.created_ts,
                          expire_ts = excluded.expire_ts,
                          start_ts = excluded.start_ts,
                          end_ts = excluded.end_ts,
                          next_ts = excluded.next_ts,
                          ri_attempts = excluded.ri_attempts
        where resource_inbox.expire_ts <= (now() at time zone 'UTC')
        returning *
    `;
    return await sql<ResourceInboxRow[]>(...statement.toStatement());
}
