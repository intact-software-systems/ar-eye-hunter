import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { ResourceInboxEntryInsertValues } from './resource-inbox-entry-insert-values.ts';
import type { ResourceInboxRow } from './resource-inbox-row-codec.ts';

/** One row of the multi-row insert, named as the statement's recordset columns. */
interface ResourceInboxEntryInsertRow {
    readonly resourceId: string;
    readonly topicId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: string;
    readonly contextId: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

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
    return await sql<ResourceInboxRow[]>`
        insert into resource_inbox (
            ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts,
            start_ts, end_ts, next_ts, ri_attempts
        )
        select inserted."resourceId", inserted."topicId", inserted.resource, inserted."typeId", inserted.status,
               inserted."contextId", inserted."systemDate"::date, inserted."createdBy",
               inserted."createdAt"::timestamp(6), inserted."expiresAt"::timestamp(6),
               inserted."startedAt"::timestamp(6), inserted."finishedAt"::timestamp(6),
               inserted."nextAt"::timestamp(6), inserted.attempts
        from jsonb_to_recordset(${values.map(toInsertRow)}::jsonb)
            as inserted("resourceId" text, "topicId" text, resource text, "typeId" text, status text,
                        "contextId" text, "systemDate" text, "createdBy" text, "createdAt" text, "expiresAt" text,
                        "startedAt" text, "finishedAt" text, "nextAt" text, attempts bigint)
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

function toInsertRow(values: ResourceInboxEntryInsertValues): ResourceInboxEntryInsertRow {
    const { entry } = values;
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        contextId: entry.key.contextId,
        systemDate: values.systemDate,
        createdBy: entry.audit.createdBy,
        createdAt: values.createdTimestamp,
        expiresAt: values.expiryTimestamp,
        startedAt: values.startTimestamp,
        finishedAt: values.endTimestamp,
        nextAt: values.nextTimestamp,
        attempts: values.attempts
    };
}
