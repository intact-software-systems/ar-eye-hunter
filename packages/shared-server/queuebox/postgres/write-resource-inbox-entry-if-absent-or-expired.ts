import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { ResourceInboxEntryInsertValues } from './resource-inbox-entry-insert-values.ts';
import type { ResourceInboxRow } from './resource-inbox-row-codec.ts';

export async function writeResourceInboxEntryIfAbsentOrExpired(
    sql: PSqlSql,
    values: ResourceInboxEntryInsertValues
): Promise<ResourceInboxRow[]> {
    const { entry } = values;
    return await sql<ResourceInboxRow[]>`
        insert into resource_inbox (
            ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts,
            start_ts, end_ts, next_ts, ri_attempts
        ) values (
            ${entry.key.resourceId}, ${entry.key.topicId}, ${entry.resource}, ${entry.typeId}, ${entry.status},
            ${entry.key.contextId}, ${values.systemDate}, ${entry.audit.createdBy},
            ${values.createdTimestamp}, ${values.expiryTimestamp},
            ${values.startTimestamp}, ${values.endTimestamp}, ${values.nextTimestamp}, ${values.attempts}
        )
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
}
